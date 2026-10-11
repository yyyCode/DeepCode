import type { Palette } from './ansi';
import type { FileChange } from './changes';
import { displayPath } from './diff-render';

/**
 * 会话的账本。**一份，两个消费者**：每轮摘要与退出摘要都从这儿读。
 *
 * 为什么非要做成一份：P5c 那段教训是现成的（见 `cli/plugins.ts` 顶部）——
 * "两条口径各写一遍"的后果是其中一条悄悄没了。token 数尤其经不起两本账，
 * `turn.complete` 里 `usageEstimated` 那条口径（端点数是我们估的）必须一路带到
 * 退出摘要上去，否则退出时那个数看着像真的。
 */
export type Tally = {
  /** 这个会话里工具一共跑了几次（`tool.call` 的次数，含子代理里的）。 */
  toolCalls: number;
  /** 输入 + 输出累计。 */
  tokens: number;
  /** 任意一轮的用量是**估**的，这个标就立起来。 */
  estimated: boolean;
  sessionStartedAt: number;

  // ── 每一轮现算的那几个 ──
  turnStartedAt: number;
  turnToolCalls: number;
  /** 本轮开始那一刻 `changes.size()`。改了几个文件 = 结束时的 size 减去它。 */
  turnChanges: number;
};

export function createTally(now: () => number = Date.now): Tally {
  const at = now();
  return {
    toolCalls: 0,
    tokens: 0,
    estimated: false,
    sessionStartedAt: at,
    turnStartedAt: at,
    turnToolCalls: 0,
    turnChanges: 0,
  };
}

/** `1234` → `1.2k`。终端上那个数只用来给个量级。 */
export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** `8400` → `8.4s`；过一分钟给 `2m12s`。 */
export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/**
 * 退出时那一屏：干了多少、改了哪些、转录在哪儿。
 *
 * 与每轮摘要**同一本账**（`Tally`）、**同一张改动表**（`cli/changes.ts`，也就是
 * `/diff` 读的那份）—— 三处各算一份的话，屏幕上那行迟早与 `/diff` 对不上。
 *
 * `estimated` 是"这把**有过**估的轮次"：只要有一轮是估的，总数就标上 `（估）`。
 * 这是**往严的那一侧**偏（可能把已经报真数的那几轮也一起标了），
 * 而反方向是"拿估的数冒充端点报的数" —— 那个不行。
 */
export function exitLines(
  tally: Tally,
  changed: readonly FileChange[],
  palette: Palette,
  options: { readonly root: string; readonly transcriptPath?: string; readonly now?: () => number },
): readonly string[] {
  const now = options.now ?? ((): number => Date.now());
  const at = `  ${palette.dim('⎿')}  `;
  const parts = [`本次会话 ${tally.toolCalls} 次工具调用`];
  if (changed.length > 0) parts.push(`改 ${changed.length} 个文件`);
  parts.push(`${formatTokens(tally.tokens)} tokens${tally.estimated ? '（估）' : ''}`);
  parts.push(formatElapsed(tally.sessionStartedAt === 0 ? 0 : now() - tally.sessionStartedAt));

  const lines = [`${at}${palette.dim(parts.join(' · '))}`];
  if (changed.length > 0) {
    const names = changed.map((change) => displayPath(change.path, options.root));
    lines.push(`${' '.repeat(at.length)}${palette.dim(`改了：${names.join('、')}`)}`);
  }
  if (options.transcriptPath !== undefined) {
    lines.push(
      `${' '.repeat(at.length)}${palette.dim(`转录：${options.transcriptPath}（--resume 可以接上）`)}`,
    );
  }
  return lines;
}
