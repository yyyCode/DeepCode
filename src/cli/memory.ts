import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsNoun, ModelNoun } from '../contract/engine';
import {
  DEFAULT_MEMORY,
  MAX_RECALL_BODY_CHARS,
  MAX_RECALL_TOTAL_CHARS,
  MAX_SCAN_FILES,
  type MemoryConfig,
  type MemoryHeader,
  type MemoryStats,
} from '../contract/memory';
import type { Plugin } from '../contract/plugin';
import {
  buildMemoryManifest,
  memorySelectorPrompt,
  parseMemoryHeader,
  parseSelectorReply,
  renderMemoryFile,
  renderMemoryIndex,
  renderMemoryPrompt,
  sanitizeMemoryText,
  selectMemories,
  validateMemoryInput,
  validateMemoryName,
  type IndexCap,
  type MemoryDraft,
  type RecalledMemory,
} from '../core/memory';
import { projectSlug } from './transcript';

/**
 * 记忆系统的 CLI 侧（P12）：扫描、召回、读写、索引重建、插件。
 *
 * 与 `cli/context-window.ts` 同一种分工：规则在 `core/memory.ts`（纯函数），
 * 这里碰磁盘与模型。**失败方向一律 fail-open**：记忆坏了就让这一轮没有记忆，
 * 不让一个正在跑的 turn 挂掉。
 */

const HEADER_LINES = 30;
const MODEL_TIMEOUT_MS = 8_000;

export function memoryDir(home: string, root: string): string {
  return join(home, '.deepcode', 'projects', projectSlug(root), 'memory');
}

export type ScanResult = {
  readonly headers: readonly MemoryHeader[];
  readonly broken: number;
};

export type RecallResult = {
  readonly headers: readonly MemoryHeader[];
  readonly broken: number;
  readonly recalled: readonly RecalledMemory[];
  readonly mode: 'keyword' | 'model' | 'none';
};

export type SaveResult = {
  readonly path: string;
  readonly updated: boolean;
  readonly index?: IndexCap;
  /** 索引更新失败时的原因（记忆本身已经写成了）。 */
  readonly indexError?: string;
};

export type MemoryStore = {
  readonly dir: string;
  scan(fs: FsNoun): Promise<ScanResult>;
  recall(
    fs: FsNoun,
    model: ModelNoun,
    query: string,
    now: number,
    warn: (line: string) => void,
  ): Promise<RecallResult>;
  save(fs: FsNoun, draft: MemoryDraft, now: number): Promise<SaveResult>;
  read(fs: FsNoun, name: string): Promise<string>;
  forget(fs: FsNoun, name: string): Promise<SaveResult>;
};

export type MemoryDeps = {
  readonly home: string;
  readonly root: string;
  readonly config: MemoryConfig;
  readonly warn: (line: string) => void;
  /** 测试注入；生产里是 node:fs/promises 的 mkdir / unlink。 */
  readonly ensureDir?: (dir: string) => Promise<void>;
  readonly removeFile?: (path: string) => Promise<void>;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMemoryStore(deps: MemoryDeps): MemoryStore {
  const dir = memoryDir(deps.home, deps.root);
  const indexPath = join(dir, 'MEMORY.md');
  const ensureDir = deps.ensureDir ?? ((path: string) => mkdir(path, { recursive: true }));
  const removeFile = deps.removeFile ?? ((path: string) => unlink(path));

  const scan = async (fs: FsNoun): Promise<ScanResult> => {
    let names: readonly string[];
    try {
      names = await fs.list(dir);
    } catch (error) {
      if (isEnoent(error)) return { headers: [], broken: 0 };
      throw error;
    }

    const candidates = names.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
    // 先按文件 mtime 取最新的 200 个，再读 —— 记忆目录被手工塞了几千个文件时，
    // 也不至于每个用户提问都把整目录读一遍。
    const staated = await Promise.all(
      candidates.map(async (file) => {
        try {
          const stat = await fs.stat(join(dir, file));
          return stat.isDirectory ? undefined : { file, mtimeMs: stat.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    const newest = staated
      .filter((item): item is { file: string; mtimeMs: number } => item !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SCAN_FILES);

    let broken = 0;
    const headers: MemoryHeader[] = [];
    for (const item of newest) {
      let text: string;
      try {
        text = await fs.read(join(dir, item.file));
      } catch {
        broken += 1;
        continue;
      }
      // 只喂前 30 行：frontmatter 在文件开头，正文再长也不该被读进来。
      const head = text.split('\n').slice(0, HEADER_LINES).join('\n');
      const parsed = parseMemoryHeader(item.file, head, item.mtimeMs);
      if (parsed.header === undefined) {
        broken += 1;
        continue;
      }
      headers.push(parsed.header);
    }

    headers.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    return { headers, broken };
  };

  const regenerateIndex = async (fs: FsNoun): Promise<IndexCap> => {
    const result = await scan(fs);
    const index = renderMemoryIndex(result.headers);
    await fs.write(indexPath, `${index.text}\n`);
    return index;
  };

  const recall = async (
    fs: FsNoun,
    model: ModelNoun,
    query: string,
    now: number,
    warn: (line: string) => void,
  ): Promise<RecallResult> => {
    let scanned: ScanResult;
    try {
      scanned = await scan(fs);
    } catch (error) {
      warn(`记忆扫描失败（${errorText(error)}）—— 这一轮没有记忆，对话照常。`);
      return { headers: [], broken: 0, recalled: [], mode: 'none' };
    }

    let picked: readonly MemoryHeader[] = [];
    let mode: RecallResult['mode'] = 'none';

    if (deps.config.recallModel !== undefined && scanned.headers.length > 0) {
      try {
        let text = '';
        for await (const event of model.stream({
          system: '你是一个记忆选择器。只返回 JSON 字符串数组，不要解释。',
          messages: [
            {
              role: 'user',
              content: `${memorySelectorPrompt(buildMemoryManifest(scanned.headers), deps.config.maxRecall)}\n\n用户问题：${query}`,
            },
          ],
          tools: [],
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
          model: deps.config.recallModel,
        })) {
          if (event.type === 'text') text += event.text;
        }
        const parsed = parseSelectorReply(text, scanned.headers, deps.config.maxRecall);
        if (parsed === undefined) {
          warn('记忆选择器没有给出可解析的名单 —— 这一次回落到关键词召回。');
          picked = selectMemories(scanned.headers, query, deps.config.maxRecall);
          mode = picked.length > 0 ? 'keyword' : 'none';
        } else {
          picked = parsed;
          mode = 'model';
        }
      } catch (error) {
        warn(`记忆选择器调用失败（${errorText(error)}）—— 这一次回落到关键词召回。`);
        picked = selectMemories(scanned.headers, query, deps.config.maxRecall);
        mode = picked.length > 0 ? 'keyword' : 'none';
      }
    } else if (scanned.headers.length > 0) {
      picked = selectMemories(scanned.headers, query, deps.config.maxRecall);
      mode = picked.length > 0 ? 'keyword' : 'none';
    }

    const recalled: RecalledMemory[] = [];
    for (const header of picked) {
      try {
        recalled.push({ header, body: await fs.read(join(dir, header.file)) });
      } catch (error) {
        if (!isEnoent(error)) {
          warn(`记忆 ${header.file} 读不了（${errorText(error)}）—— 跳过这一条。`);
        }
      }
    }

    return { headers: scanned.headers, broken: scanned.broken, recalled, mode };
  };

  return {
    dir,

    scan,

    recall,

    async save(fs, draft, now) {
      await ensureDir(dir);
      const path = join(dir, `${draft.name}.md`);
      const updated = await fs.exists(path);
      await fs.write(path, renderMemoryFile(draft, now));

      try {
        const index = await regenerateIndex(fs);
        return { path, updated, index };
      } catch (error) {
        // 记忆文件已经写成 —— 索引没更新是降级，不是失败。
        return { path, updated, indexError: errorText(error) };
      }
    },

    async read(fs, name) {
      const problem = validateMemoryName(name);
      if (problem !== undefined) throw new Error(problem);
      const path = join(dir, `${name}.md`);
      if (!(await fs.exists(path))) throw new Error(`没有叫 ${name} 的记忆（找的是 ${path}）`);
      return fs.read(path);
    },

    async forget(fs, name) {
      const problem = validateMemoryName(name);
      if (problem !== undefined) throw new Error(problem);
      const path = join(dir, `${name}.md`);
      if (!(await fs.exists(path))) throw new Error(`没有叫 ${name} 的记忆（找的是 ${path}）`);
      await removeFile(path);

      try {
        const index = await regenerateIndex(fs);
        return { path, updated: false, index };
      } catch (error) {
        return { path, updated: false, indexError: errorText(error) };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 工具描述：模型认识记忆系统的唯一入口
// ─────────────────────────────────────────────────────────────

const MEMORY_TOOL_DESCRIPTION = `跨会话记忆。一条记忆存成一个文件，索引每轮自动进系统提示；正文只在被召回时注入。

四种类型（封闭集合，不能自造）：
- user：用户是谁、擅长什么、知识水平（例：写了十年 Go，第一次做前端）。
- feedback：用户说过「不要做什么」「继续保持什么」。**正文必须同时写 **Why:** 与 **How to apply:** **：Why 让模型判断规则在边缘情况下适不适用，How 让规则落得了地。
- project：正在发生什么、截止时间、重要决策。**相对日期必须转成绝对日期**（「周四前」→「2026-03-05 前」）。
- reference：去哪找什么（Linear 项目、Grafana 看板、Slack 频道）。不需要写外部系统的内容，只写入口。

不要存（能从当前代码推导出来的一律不存）：
1. 代码模式、项目架构、文件结构 —— grep / git / AGENTS.md 能拿到。
2. Git 历史与最近改动 —— git log / git blame 才是权威。
3. 调试方案与修复方法 —— 修复在代码里，commit 消息记着上下文。
4. AGENTS.md 已经写了的内容 —— 不重复。
5. 临时任务状态与当前对话上下文 —— 不需要跨会话。

动作：
- save：写一条（同名覆盖）。name 是文件名（字母/数字/点/下划线/连字符，不带 .md）。
- read：按 name 读全文。
- forget：按 name 删除。

只记真正跨会话有用的东西。记忆是摘要，不是文档：单条正文超过 20000 字符会被拒绝。`;

const MEMORY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['save', 'read', 'forget'], description: '要做什么' },
    name: { type: 'string', description: '记忆名（也是文件名，不带 .md）' },
    type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
    description: { type: 'string', description: '一句话摘要（一行，召回时用它匹配）' },
    content: { type: 'string', description: '记忆正文；feedback 必须含 **Why:** 与 **How to apply:**' },
  },
  required: ['action', 'name'],
};

export type MemoryPlugin = Plugin & {
  readonly dir: string;
  /** `/context` 读它。还没扫过时 `undefined`。 */
  readonly stats: () => MemoryStats | undefined;
};

function statsOf(
  enabled: boolean,
  result: RecallResult,
  index: IndexCap,
): MemoryStats {
  const recalledChars = Math.min(
    MAX_RECALL_TOTAL_CHARS,
    result.recalled.reduce(
      (total, item) => total + Math.min(item.body.length, MAX_RECALL_BODY_CHARS),
      0,
    ),
  );
  return {
    enabled,
    count: result.headers.length,
    broken: result.broken,
    indexLines: index.lines,
    indexChars: index.text.length,
    indexTruncated: index.truncated,
    recalled: result.recalled.map((item) => item.header.name),
    recalledChars,
    recallMode: result.mode,
  };
}

/**
 * 记忆插件：`prompt.submit` 记下问题（配了小模型就开始召回），`prompt.section`
 * 把索引与召回正文拼进系统提示，同时注册 `Memory` 工具与 `/memory`。
 */
export function createMemoryPlugin(deps: MemoryDeps): MemoryPlugin {
  const store = createMemoryStore(deps);
  const config: MemoryConfig = { ...DEFAULT_MEMORY, ...deps.config };

  let lastQuery: string | undefined;
  let pending: Promise<RecallResult> | undefined;
  let lastStats: MemoryStats | undefined;
  const warned = new Set<string>();
  const warnOnce = (line: string): void => {
    if (warned.has(line)) return;
    warned.add(line);
    deps.warn(line);
  };

  const emptyRecall = (): RecallResult => ({
    headers: [],
    broken: 0,
    recalled: [],
    mode: 'none',
  });

  const makeSection = (result: RecallResult, now: number): { name: string; text: string } | undefined => {
    if (result.headers.length === 0) {
      lastStats = statsOf(config.enabled, result, renderMemoryIndex([]));
      return undefined;
    }
    const index = renderMemoryIndex(result.headers);
    lastStats = statsOf(config.enabled, result, index);
    const text = renderMemoryPrompt({
      indexText: index.text,
      total: result.headers.length,
      broken: result.broken,
      recalled: result.recalled,
      now,
      recallMode: result.mode,
    });
    return { name: 'memory', text };
  };

  const plugin: Plugin = {
    name: 'memory',
    uses: [
      'prompt.submit',
      'prompt.section',
      'tool.call',
      'tool.describe',
      'command.run',
      'command.describe',
      'fs',
      'model',
      'clock',
      'ui',
    ],

    register(on) {
      if (!config.enabled) return;

      on('prompt.submit', ($, e, next) => {
        lastQuery = e.text;
        // 小模型召回在提交这一刻就开始；`prompt.section` 去等它。关键词召回不需要
        // 预取（纯字符串），所以只有配了 recallModel 才启动这个 promise。
        if (config.recallModel !== undefined) {
          pending = store
            .recall($.fs, $.model, e.text, $.clock.now(), warnOnce)
            .catch((error: unknown) => {
              warnOnce(`记忆召回失败（${errorText(error)}）—— 这一次没有召回。`);
              return emptyRecall();
            });
        }
        return next(e);
      });

      on('prompt.section', async ($, e, next) => {
        // 别人的节要原样带出去：这一条是链，不是唯一贡献者（契约见 events.ts）。
        const inner = await next(e);
        try {
          const result = await (pending ??
            store.recall($.fs, $.model, lastQuery ?? '', $.clock.now(), warnOnce));
          pending = undefined;
          const section = makeSection(result, $.clock.now());
          if (section === undefined) return inner;
          if (result.broken > 0) {
            warnOnce(`记忆扫描跳过了 ${result.broken} 个坏文件（frontmatter 读不懂或类型不认识）。`);
          }
          return { sections: [...inner.sections, section] };
        } catch (error) {
          warnOnce(`记忆注入失败（${errorText(error)}）—— 这一轮没有记忆，对话照常。`);
          return inner;
        }
      });

      // ── Memory 工具 ──────────────────────────────────────────────
      on('tool.describe', { tool: 'Memory' }, () => ({
        description: MEMORY_TOOL_DESCRIPTION,
        inputSchema: MEMORY_TOOL_SCHEMA,
      }));

      on('tool.call', { tool: 'Memory' }, async ($, e) => {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const action = typeof input.action === 'string' ? input.action : '';

        if (action === 'save') {
          const validated = validateMemoryInput(input);
          if (!validated.ok) return { value: `ERROR: ${validated.error}` };
          try {
            const result = await store.save($.fs, validated.value, $.clock.now());
            let text =
              `已${result.updated ? '更新' : '写入'}记忆 ${validated.value.name}` +
              `（${validated.value.type}）：${result.path}`;
            if (result.indexError !== undefined) {
              text += `\n\n⚠️ 记忆写成了，但索引没更新：${result.indexError}`;
            } else if (result.index?.truncated === true) {
              text +=
                '\n\n⚠️ 索引超过 200 行 / 25KB，下一次注入会截断。' +
                '请合并或删除旧记忆（Memory action=forget）。';
            }
            return { value: text };
          } catch (error) {
            return { value: `ERROR: 写入记忆失败：${errorText(error)}` };
          }
        }

        if (action === 'read' || action === 'forget') {
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const problem = validateMemoryName(name);
          if (problem !== undefined) return { value: `ERROR: ${problem}` };

          try {
            if (action === 'read') {
              const raw = await store.read($.fs, name);
              return {
                value: `记忆 ${name}（${join(store.dir, `${name}.md`)}）：\n\n${sanitizeMemoryText(raw)}`,
              };
            }
            const result = await store.forget($.fs, name);
            let text = `已删除记忆 ${name}：${result.path}`;
            if (result.indexError !== undefined) text += `\n\n⚠️ 索引没更新：${result.indexError}`;
            return { value: text };
          } catch (error) {
            return { value: `ERROR: ${errorText(error)}` };
          }
        }

        return { value: 'ERROR: action 必须是 save / read / forget 之一' };
      });

      // ── /memory ──────────────────────────────────────────────────
      on('command.run', { name: 'memory' }, async ($, e) => {
        const name = e.args[0];
        try {
          if (name !== undefined && name !== '') {
            const raw = await store.read($.fs, name);
            for (const line of raw.split('\n')) $.ui.log(line);
            return { handled: true };
          }

          const scanned = await store.scan($.fs);
          if (scanned.headers.length === 0) {
            $.ui.log(`这个项目还没有记忆（目录：${store.dir}）。`);
            return { handled: true };
          }
          const now = $.clock.now();
          $.ui.log(
            `记忆目录：${store.dir}（${scanned.headers.length} 条` +
              `${scanned.broken > 0 ? `，${scanned.broken} 个坏文件已跳过` : ''}）`,
          );
          for (const header of scanned.headers) {
            const days = Math.floor((now - header.modified) / (24 * 60 * 60 * 1000));
            $.ui.log(
              `[${header.type}] ${header.name} — ${header.description}` +
                `（${days <= 0 ? '今天' : `${days} 天前`}）`,
            );
          }
          return { handled: true };
        } catch (error) {
          $.ui.log(`读记忆失败：${errorText(error)}`);
          return { handled: true };
        }
      });

      on('command.describe', { name: 'memory' }, () => ({
        description: '列出这个项目记住的东西；/memory <name> 打印正文',
        usage: '/memory [name]',
      }));
    },
  };

  return Object.assign(plugin, {
    dir: store.dir,
    stats: (): MemoryStats | undefined => lastStats,
  });
}
