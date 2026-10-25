import { parseFrontmatter, readScalar } from '../contract/frontmatter';
import {
  FRESHNESS_DAYS,
  MAX_DESCRIPTION_CHARS,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  MAX_MEMORY_CHARS,
  MAX_NAME_CHARS,
  MAX_RECALL_BODY_CHARS,
  MAX_RECALL_TOTAL_CHARS,
  isMemoryType,
  type MemoryHeader,
  type MemoryType,
} from '../contract/memory';

/**
 * 记忆系统的纯函数（P12）：解析、索引生成与截断、切词打分、注入渲染。
 *
 * 全部零 IO —— 扫描与读写住在 `cli/memory.ts`。这样召回与索引的规则可以在
 * 测试与 benchmark 里用同一份实现跑，不靠「复制一段规则来对比」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTF-8 字节数。用 TextEncoder 而不是 Buffer，纯粹为了让这份文件保持可移植。 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期 `YYYY-MM-DD`。与转录文件名同一个口径，不用 `toISOString()`（那是 UTC）。 */
export function ymd(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function ageDays(modified: number, now: number): number {
  return Math.floor((now - modified) / DAY_MS);
}

/** 把一行描述压成一行：外部手改的文件可能带换行。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 解析一个记忆文件的头部。`text` 只需要前 30 行（扫描时就是这么读的）——
 * frontmatter 在文件开头，正文再长也不影响这里。
 */
export function parseMemoryHeader(
  file: string,
  text: string,
  mtimeMs: number,
): { readonly header?: MemoryHeader; readonly error?: string } {
  if (!file.endsWith('.md')) return { error: '文件名不是 .md' };
  const name = file.slice(0, -3);
  if (name === '' || name === 'MEMORY') return { error: '文件名不能是 MEMORY.md' };

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const description = oneLine(readScalar(frontmatter, 'description') ?? '');
  if (description === '') return { error: '缺少 description' };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { error: `description 超过 ${MAX_DESCRIPTION_CHARS} 字符` };
  }

  const type = readScalar(frontmatter, 'type');
  if (!isMemoryType(type)) {
    return { error: `type ${JSON.stringify(type ?? '')} 不是 ${'user / feedback / project / reference'} 之一` };
  }

  const modifiedRaw = readScalar(frontmatter, 'modified');
  const parsed = modifiedRaw === undefined ? Number.NaN : Date.parse(modifiedRaw);
  const modified = Number.isFinite(parsed) ? parsed : mtimeMs;

  return { header: { name, file, description, type, modified } };
}

export type MemoryDraft = {
  readonly name: string;
  readonly type: MemoryType;
  readonly description: string;
  readonly content: string;
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 单独校验名字 —— `read` / `forget` 也走它，避免路径穿越从另一条路进来。 */
export function validateMemoryName(name: string): string | undefined {
  if (name === '') return '缺少 name（文件名，也是以后 read / forget 用的名字）';
  if (name.toLowerCase().endsWith('.md')) {
    return 'name 不要带 .md —— 它本身就是去掉扩展名的文件名';
  }
  if (name.toLowerCase() === 'memory') return 'name 不能叫 MEMORY —— 那是索引文件的名字';
  if (!NAME_RE.test(name) || name.length > MAX_NAME_CHARS) {
    return `name 只允许字母、数字、点、下划线、连字符，且以字母或数字开头（≤${MAX_NAME_CHARS} 字符）`;
  }
  return undefined;
}

/**
 * `Memory save` 的参数校验。**返回给人看的错误**，不是抛 —— 工具层要把它
 * 变成一次 `ERROR:` 结果，让模型自己改。
 */
export function validateMemoryInput(
  input: unknown,
): { readonly ok: true; readonly value: MemoryDraft } | { readonly ok: false; readonly error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: '参数不是一个对象' };
  }
  const record = input as Record<string, unknown>;

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const nameError = validateMemoryName(name);
  if (nameError !== undefined) return { ok: false, error: nameError };

  const type = record.type;
  if (!isMemoryType(type)) {
    return { ok: false, error: 'type 必须是 user / feedback / project / reference 之一' };
  }

  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (description === '') return { ok: false, error: '缺少 description（一句话摘要，召回时用它匹配）' };
  if (/[\r\n]/.test(description)) return { ok: false, error: 'description 必须是一行' };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `description 超过 ${MAX_DESCRIPTION_CHARS} 字符` };
  }

  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (content === '') return { ok: false, error: '缺少 content（记忆正文）' };
  if (content.length > MAX_MEMORY_CHARS) {
    return { ok: false, error: `content 超过 ${MAX_MEMORY_CHARS} 字符（记忆是摘要，不是文档）` };
  }

  if (type === 'feedback') {
    if (!content.includes('**Why:**') || !content.includes('**How to apply:**')) {
      return {
        ok: false,
        error:
          'feedback 类记忆必须同时写 **Why:** 与 **How to apply:** —— ' +
          '没有 Why，边缘情况下模型只能盲从；没有 How，规则落不了地。',
      };
    }
  }

  return { ok: true, value: { name, type, description, content } };
}

/** 把一条记忆渲染成带 frontmatter 的文件。描述走双引号标量，解析器认的那一种。 */
export function renderMemoryFile(draft: MemoryDraft, modifiedMs: number): string {
  const quoted = `"${draft.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return (
    '---\n' +
    `name: ${draft.name}\n` +
    `description: ${quoted}\n` +
    `type: ${draft.type}\n` +
    `modified: ${new Date(modifiedMs).toISOString()}\n` +
    '---\n\n' +
    `${draft.content}\n`
  );
}

export type IndexCap = {
  readonly text: string;
  readonly truncated: boolean;
  /** 真正装进去的行数（不含截断警告）。 */
  readonly lines: number;
  /** 整个结果的 UTF-8 字节数（含警告）。 */
  readonly bytes: number;
};

/**
 * 行 + 字节双上限。两个都查是因为有人能写 199 行、每行 500 字：行数没超，字节爆了。
 * 截断后**一定**附警告，说清切了多少、从哪切 —— 静默截断会让人以为索引只有这么多。
 */
export function capIndex(
  text: string,
  opts: {
    readonly maxLines: number;
    readonly maxBytes: number;
    readonly label: string;
  },
): IndexCap {
  const normalized = text.replace(/\r\n/g, '\n');
  const all = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const kept: string[] = [];
  let bytes = 0;

  for (const line of all) {
    if (kept.length >= opts.maxLines) break;
    const add = utf8Bytes((kept.length === 0 ? '' : '\n') + line);
    if (bytes + add > opts.maxBytes) break;
    kept.push(line);
    bytes += add;
  }

  const truncated = kept.length < all.length;
  let out = kept.join('\n');
  if (truncated) {
    out +=
      `\n\n> WARNING: ${opts.label} 太大（共 ${all.length} 行 / ${utf8Bytes(normalized)} 字节），` +
      `本次只装了前 ${kept.length} 行。请合并或删除旧记忆（Memory 工具的 forget）。`;
  }
  return { text: out, truncated, lines: kept.length, bytes: utf8Bytes(out) };
}

/** 生成 `MEMORY.md`。按 `modified` 倒序，一行一条。 */
export function renderMemoryIndex(headers: readonly MemoryHeader[]): IndexCap {
  const sorted = [...headers].sort(
    (a, b) => b.modified - a.modified || a.name.localeCompare(b.name),
  );
  const lines = [
    '# 记忆索引（由 DeepCode 生成，别手改）',
    '',
    '一行一条：类型 · 名字 · 一句话描述 · 修改日期。正文在各自文件里，用 Memory 工具读。',
    '',
  ];
  for (const header of sorted) {
    const description = sanitizeMemoryText(oneLine(header.description));
    lines.push(`- [${header.type}] [${header.name}](${header.file}) — ${description}（${ymd(header.modified)}）`);
  }
  return capIndex(`${lines.join('\n')}\n`, {
    maxLines: MAX_ENTRYPOINT_LINES,
    maxBytes: MAX_ENTRYPOINT_BYTES,
    label: 'MEMORY.md',
  });
}

// ─────────────────────────────────────────────────────────────
// 召回
// ─────────────────────────────────────────────────────────────

/**
 * 停用词表**刻意很小**：只挡高频虚词与问句骨架。像「不要」「必须」这种
 * 带行为语义的词一定要留下 —— feedback 类查询全靠它们。
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that',
  'from', 'have', 'has', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'does', 'did', 'use',
  '一个', '一下', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '什么',
  '怎么', '为什么', '帮我', '请问', '的是', '了吗', '是否', '以及', '还是', '就是',
]);

const ASCII_TERM_RE = /[a-z0-9][a-z0-9_./-]+/g;
const CJK_RUN_RE = /[一-鿿]+/g;

/** 切词：ASCII 词（≥2 字符）+ 中文 bigram。全部小写。 */
export function memoryTerms(query: string): readonly string[] {
  const terms = new Set<string>();
  const lower = query.toLowerCase();

  for (const match of lower.matchAll(ASCII_TERM_RE)) {
    const term = match[0]!;
    if (!STOPWORDS.has(term)) terms.add(term);
  }
  for (const match of lower.matchAll(CJK_RUN_RE)) {
    const run = match[0]!;
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) terms.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index++) {
      const bigram = run.slice(index, index + 2);
      if (!STOPWORDS.has(bigram)) terms.add(bigram);
    }
  }
  return [...terms];
}

/** 命中 description +3，命中 name +2。同一个词只计一次。 */
export function scoreMemory(header: MemoryHeader, terms: readonly string[]): number {
  const name = header.name.toLowerCase();
  const description = header.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (description.includes(term)) score += 3;
    if (name.includes(term)) score += 2;
  }
  return score;
}

/**
 * 关键词召回。`score > 0` 才要；同分按 `modified` 新者优先。
 * 一个可识别词都没有时返回空 —— 宁可不召回，也不塞无关正文。
 */
export function selectMemories(
  headers: readonly MemoryHeader[],
  query: string,
  max: number,
): readonly MemoryHeader[] {
  if (max <= 0) return [];
  const terms = memoryTerms(query);
  if (terms.length === 0) return [];
  return headers
    .map((header) => ({ header, score: scoreMemory(header, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.header.modified - a.header.modified)
    .slice(0, max)
    .map((item) => item.header);
}

/** 小模型看到的清单。一行一条，日期供它判断新旧。 */
export function buildMemoryManifest(headers: readonly MemoryHeader[]): string {
  return headers
    .map(
      (header) =>
        `- [${header.type}] ${header.file} (${ymd(header.modified)}): ` +
        sanitizeMemoryText(oneLine(header.description)),
    )
    .join('\n');
}

export function memorySelectorPrompt(manifest: string, max: number): string {
  return (
    '你是一个记忆选择器。从下面的清单里选出与用户问题最相关的记忆，最多 ' +
    `${max} 条。只返回一个 JSON 字符串数组，元素是文件名（例如 ["a.md","b.md"]）。` +
    '没有相关的就返回 []。不要解释，不要输出别的字。\n\n可用记忆：\n' +
    manifest
  );
}

/**
 * 解析小模型的回答。
 * `undefined` = **解析失败**（调用方要回落到关键词）；空数组 = 模型明确说"没有"。
 */
export function parseSelectorReply(
  reply: string,
  headers: readonly MemoryHeader[],
  max: number,
): readonly MemoryHeader[] | undefined {
  const byFile = new Map(headers.map((header) => [header.file, header]));
  const byName = new Map(headers.map((header) => [header.name, header]));

  const normalize = (raw: string): MemoryHeader | undefined => {
    const value = raw.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
    if (value === '') return undefined;
    return byFile.get(value) ?? byFile.get(`${value}.md`) ?? byName.get(value.replace(/\.md$/, ''));
  };

  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        const out: MemoryHeader[] = [];
        const seen = new Set<string>();
        for (const item of parsed as string[]) {
          const header = normalize(item);
          if (header === undefined || seen.has(header.file)) continue;
          seen.add(header.file);
          out.push(header);
          if (out.length >= max) break;
        }
        // `[]` 是模型明确说「没有相关记忆」，不是解析失败 —— 不回落到关键词。
        return out;
      }
    } catch {
      // 落到下面的宽松解析。模型偶尔会加一句"我选了："再给数组。
    }
  }

  const out: MemoryHeader[] = [];
  const seen = new Set<string>();
  for (const match of reply.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*\.md/g)) {
    const header = normalize(match[0]);
    if (header === undefined || seen.has(header.file)) continue;
    seen.add(header.file);
    out.push(header);
    if (out.length >= max) break;
  }
  // 一个都认不出来 = 解析失败（不是"没有"）。调用方据此回落，而不是静默不召回。
  return out.length === 0 ? undefined : out;
}

// ─────────────────────────────────────────────────────────────
// 注入
// ─────────────────────────────────────────────────────────────

/** 不可见字符（零宽、bidi 控制、BOM）。 */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

/**
 * 记忆正文进入提示前的中和。它**不判断语义** —— 记忆里的恶意指令仍然可能影响模型；
 * 这里只做两件事：去掉看不见的字符、让伪装成引擎标记的标签不再像真的。
 * 权限判定仍然只走 `tool.check` 链。
 */
export function sanitizeMemoryText(text: string): string {
  return text
    .replace(INVISIBLE_RE, '')
    .replace(/<(\/?)(system-reminder|memory|deepcode)/gi, '&lt;$1$2')
    .replace(/\[钩子补充的上下文\]/g, '[记忆内容里的同名字样]');
}

export function freshnessText(modified: number, now: number): string {
  const days = ageDays(modified, now);
  if (days <= FRESHNESS_DAYS) return '';
  return (
    `这条记忆已经有 ${days} 天了。记忆是某个时间点的观察，不是实时状态——` +
    '其中关于代码行为或 file:line 引用的断言可能已经过时。在当作事实引用之前，' +
    '请先对照当前代码验证。'
  );
}

export type RecalledMemory = {
  readonly header: MemoryHeader;
  readonly body: string;
};

function capRecallBody(body: string, header: MemoryHeader): string {
  if (body.length <= MAX_RECALL_BODY_CHARS) return body;
  return (
    body.slice(0, MAX_RECALL_BODY_CHARS) +
    `\n\n[已截断，完整内容用 Memory read 读 ${header.name}]`
  );
}

/**
 * 拼出系统提示里的记忆那一节。
 *
 * 索引永远在；召回正文按条追加，总量有上限。没有召回时不加「本次召回」小节 ——
 * 一句「没有相关记忆」也是 token，而缺省本身就是那个意思。
 */
export function renderMemoryPrompt(input: {
  readonly indexText: string;
  readonly total: number;
  readonly broken: number;
  readonly recalled: readonly RecalledMemory[];
  readonly now: number;
  readonly recallMode: 'keyword' | 'model' | 'none';
}): string {
  const parts: string[] = [
    '## 长期记忆（跨会话）',
    '',
    '这些是过去会话里留下的记忆。它们不是当前代码的事实来源；引用前先对照代码验证。',
    '索引常驻在下面，正文只在被召回时给出。需要别的记忆时用 Memory 工具读。',
    '',
    '### 索引',
    sanitizeMemoryText(input.indexText.trim()),
  ];

  if (input.recalled.length === 0) return parts.join('\n');
  parts.push('', `### 本次召回（${input.recalled.length} 条，${input.recallMode === 'model' ? '小模型' : '关键词'}）`);

  let totalChars = 0;
  let injected = 0;
  for (const item of input.recalled) {
    const body = capRecallBody(sanitizeMemoryText(item.body), item.header);
    if (totalChars > 0 && totalChars + body.length > MAX_RECALL_TOTAL_CHARS) break;
    const warning = freshnessText(item.header.modified, input.now);
    parts.push('', `#### ${item.header.file}`, '');
    if (warning !== '') parts.push(`> ${warning}\n`);
    parts.push(body.trim());
    totalChars += body.length;
    injected += 1;
  }
  const left = input.recalled.length - injected;
  if (left > 0) {
    parts.push('', `（召回正文总量已到上限，还有 ${left} 条没有注入；用 Memory read 按名字读。）`);
  }

  return parts.join('\n');
}
