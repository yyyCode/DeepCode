import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_CONTEXT_LAYERS,
  type ContextLayerConfig,
  type ContextWindow,
  type LayerStats,
  type ProjectionRequest,
  type RequestProjection,
} from '../contract/context-window';
import type { FsNoun } from '../contract/engine';
import type { Message, ModelProvider } from '../contract/model-provider';
import {
  collapseOld,
  externalizeLargeResults,
  microCompact,
  requestTokens,
  snipOld,
  turnCut,
} from '../core/context-shaping';
import { messageChars } from '../core/tokens';
import type { CompactConfig } from './settings';
import { projectSlug } from './transcript';

/**
 * 第 4 层摘要那一轮的指令。与第 5 层（`cli/compact.ts` 的 `SUMMARIZE_PROMPT`）刻意分开：
 * 这一段压的是**更早的一段**，最近几轮原文还在；要求可以更短，也不必重复「保留最近 N 轮」。
 */
export const COLLAPSE_PROMPT = `请把上面这段较早的编码会话压缩成一份接手续用的摘要。只写四件事：
1. 用户的目标是什么、做到哪一步了。
2. 已经改过哪些文件（写全路径）。
3. 已经确认的结论。
4. 还没解决的问题。
不要复述过程，不要逐轮复述。尽量短。`;

export type ContextWindowDeps = {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly fs: FsNoun;
  readonly provider: ModelProvider;
  readonly config: CompactConfig;
  /** 出声（渲染器的 notice）。外置/折叠失败要说，不静默。 */
  readonly warn: (line: string) => void;
};

/** 会话累计的外置数。`/context` 显示它，不另算一本账。 */
type Totals = {
  externalized: number;
  externalizedChars: number;
  collapsedSegments: number;
  collapsedMessages: number;
};

/**
 * 五层压缩的 CLI 侧（P11）：第 1 层的落盘 + 第 2–4 层的读时投影。
 *
 * 第 5 层不在这里 —— 它是 `cli/compact.ts`。**两者的配合方式是隐式的**：
 * 第 2–4 层把请求压小之后，`turn.complete` 报回来的 `input_tokens` 就小了，
 * `Compactor.afterTurn` 自然不再触发。不需要显式传 `tokensFreed`。
 */
export function createContextWindow(deps: ContextWindowDeps): ContextWindow {
  const layers: ContextLayerConfig = { ...DEFAULT_CONTEXT_LAYERS, ...deps.config.layers };
  const totals: Totals = {
    externalized: 0,
    externalizedChars: 0,
    collapsedSegments: 0,
    collapsedMessages: 0,
  };
  const summaries = new Map<string, string>();

  let last: LayerStats | undefined;
  let lastRequestAt: number | undefined;
  let writeWarned = false;
  let collapseWarned = false;

  const resultDir = join(
    deps.home,
    '.deepcode',
    'projects',
    projectSlug(deps.cwd),
    'tool-results',
    deps.sessionId,
  );

  const safeName = (toolUseId: string): string => {
    const trimmed = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
    const suffix = createHash('sha1').update(toolUseId).digest('hex').slice(0, 8);
    return `${trimmed === '' ? 'result' : trimmed}-${suffix}`;
  };

  /**
   * 摘要按 head 的内容缓存：同一段历史只付一次 API 钱。
   *
   * `fresh` 用来区分「真的生成了一段」与「命中缓存」—— `/context` 的「折叠 N 段」
   * 数的是前者。同一段历史每次请求都会被投影一次，把重复应用也加成一段就是在编数字。
   */
  const summarize = async (
    head: readonly Message[],
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly fresh: boolean } | undefined> => {
    const key = createHash('sha1').update(JSON.stringify(head)).digest('hex');
    const cached = summaries.get(key);
    if (cached !== undefined) return { text: cached, fresh: false };

    let text = '';
    try {
      for await (const event of deps.provider.stream({
        system: '你负责把一段较早的编码会话压缩成一份能接手用的摘要。',
        messages: [...head, { role: 'user', content: COLLAPSE_PROMPT }],
        tools: [],
        signal,
      })) {
        if (event.type === 'text') text += event.text;
      }
    } catch (error) {
      if (!collapseWarned) {
        collapseWarned = true;
        deps.warn(
          `第 4 层折叠跳过：摘要调用失败（${error instanceof Error ? error.message : String(error)}）——` +
            ' 这一次请求保留完整历史。',
        );
      }
      return undefined;
    }

    const trimmed = text.trim();
    if (trimmed === '') {
      if (!collapseWarned) {
        collapseWarned = true;
        deps.warn('第 4 层折叠跳过：摘要那一轮没有返回任何文本 —— 这一次请求保留完整历史。');
      }
      return undefined;
    }

    summaries.set(key, trimmed);
    return { text: trimmed, fresh: true };
  };

  return {
    async absorbToolResults(results, names) {
      if (results.length === 0) return results;

      const out = await externalizeLargeResults(results, names, layers, async (id, content) => {
        try {
          await mkdir(resultDir, { recursive: true });
          const path = join(resultDir, `${safeName(id)}.txt`);
          await deps.fs.write(path, content);
          return path;
        } catch (error) {
          // fail-open：写不进去就保留完整内容。上下文管理失败不能把 turn 弄挂。
          if (!writeWarned) {
            writeWarned = true;
            deps.warn(
              `大工具结果落盘失败，保留完整内容：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return undefined;
        }
      });

      totals.externalized += out.externalized;
      totals.externalizedChars += out.externalizedChars;
      return out.results;
    },

    async project(messages: readonly Message[], req: ProjectionRequest): Promise<RequestProjection> {
      const at = Math.max(1, deps.config.atTokens);
      const before = requestTokens(req.systemChars, req.toolChars, messages);
      const applied: ('snip' | 'micro' | 'collapse')[] = [];

      let current: readonly Message[] = messages;
      let estimated = before;
      let snippedMessages = 0;
      let clearedResults = 0;
      let collapsedSegments = 0;
      let collapsedMessages = 0;

      const recount = (): void => {
        estimated = requestTokens(req.systemChars, req.toolChars, current);
      };

      // ── 第 2 层：砍掉远古消息 ──
      if (estimated >= at * layers.snipAtRatio) {
        const snip = snipOld(current, layers.snipKeepTurns);
        if (snip.removed > 0) {
          current = snip.messages;
          snippedMessages = snip.removed;
          applied.push('snip');
          recount();
        }
      }

      // ── 第 3 层：清空老工具结果 ──
      // 两个触发条件取或：比例到线，或距上次请求超过 `microIdleMs`（缓存大概率过期）。
      const idle =
        lastRequestAt !== undefined && req.now - lastRequestAt >= layers.microIdleMs;
      if (estimated >= at * layers.microAtRatio || idle) {
        const micro = microCompact(current, layers.microKeepRecent);
        if (micro.cleared > 0) {
          current = micro.messages;
          clearedResults = micro.cleared;
          applied.push('micro');
          recount();
        }
      }

      // ── 第 4 层：读时投影 ──
      if (estimated >= at * layers.collapseAtRatio) {
        const urgent = estimated >= at * layers.collapseUrgentRatio;
        const keep = urgent
          ? layers.collapseUrgentKeepTurns
          : layers.collapseKeepTurns;
        const cut = turnCut(current, keep);
        if (cut !== undefined) {
          const head = current.slice(0, cut);
          const summary = await summarize(head, req.signal);
          if (summary !== undefined) {
            const collapsed = collapseOld(current, keep, summary.text);
            // 投影必须真的更短 —— 摘要比原文长时这一层等于没做（与第 5 层同一条守卫）。
            if (
              collapsed !== undefined &&
              messageChars(collapsed.messages) < messageChars(current)
            ) {
              current = collapsed.messages;
              // 命中缓存只应用、不重复计一段（见 `summarize` 上方）。
              if (summary.fresh) {
                collapsedSegments += 1;
                collapsedMessages += collapsed.removed;
              }
              applied.push('collapse');
              recount();
            }
          }
        }
      }

      lastRequestAt = req.now;
      totals.collapsedSegments += collapsedSegments;
      totals.collapsedMessages += collapsedMessages;

      const stats: LayerStats = {
        externalized: totals.externalized,
        externalizedChars: totals.externalizedChars,
        snippedMessages,
        clearedResults,
        collapsedSegments: totals.collapsedSegments,
        collapsedMessages: totals.collapsedMessages,
        tokensBefore: before,
        tokensAfter: estimated,
      };
      last = stats;
      return { messages: current, stats, applied };
    },

    last: () => last,
  };
}
