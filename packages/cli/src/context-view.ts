import type { Message, ToolSpec } from '@deepcode/contract/model-provider';
import { estimateTokens, messageChars } from '@deepcode/core/loop';
import { toolSpecChars, toolsChars } from '@deepcode/core/tool-list';
import type { CompactConfig } from './settings';
import type { PromptPiece } from './system-prompt';

/**
 * `/context` 的账本（P7 §3.1）。纯函数：不碰引擎、不碰渲染、不碰磁盘。
 *
 * 复刻对象把这件事做成了一等数据（`SessionContextBreakdown`：逐类一行，含 free space
 * 与 compaction buffer），理由是"三次事故全部源于账本算错"。对我们更直接的理由是：
 * **阈值那个数我们自己都标着"猜的"**（`settings.ts:63`），那就更该让它出现在屏幕上。
 *
 * ⚠️ 三条口径，都不许含糊（设计 §3.1）：
 *
 * 1. **不报"还剩多少"**。我们没有模型注册表，不知道模型窗口是多少；"有效窗口 = 模型窗口
 *    − 输出预留 − buffer"这条式子我们连第一项都没有。凭模型名猜一个窗口就是编数字，
 *    所以这里只报我们真的知道的：阈值，以及它的出身。那句声明是**输出的一部分**，
 *    不是注释 —— 它是这个命令诚实与否的分界线（`test/context-view.test.ts` 钉着它）。
 * 2. **估就是估**。系统提示与消息都走 `estimateTokens(chars)`（`core/loop.ts:227`，
 *    按 4 字符 1 token 粗估，中英混排会失真）。只有端点报了 usage 的那一行不标"（估）"，
 *    也**单独列**，不混进构成里。
 * 3. **账要对得上**：逐节之和 = 系统提示那一行，**逐工具之和 = 工具清单那一行**,
 *    系统提示 + 工具清单 + 消息 = 合计。对不上说明有东西没被算进去 —— 那是账本算错，
 *    不是显示问题。
 *
 * ⚠️ 工具清单是 P9 补进来的（设计 §3.2）。在它之前这条规矩**自己就违反自己**：
 * 每次请求都带着工具清单，而合计只算了两样 —— 实测那一轮真实发出去约 448 token，
 * 账本报 11，其中 97.5% 是漏掉的工具。合计算错的方向最坏：`合计` 与 `上次实测`
 * 摆在一起看，正是用户判断"离阈值还有多远"的唯一依据。
 */
export type ContextReportInput = {
  /** 最近一次建出来的系统提示的分节明细。还没建过时 `undefined`。 */
  readonly pieces: readonly PromptPiece[] | undefined;
  /**
   * 最近一次请求里**真的带出去**的那份工具清单（`runTurn` 的 `onTools` 报出来的）。
   * 还没发过请求时 `undefined` —— 那时它不进合计，那一行也照实说。
   */
  readonly tools: readonly ToolSpec[] | undefined;
  readonly messages: readonly Message[];
  readonly compact: CompactConfig;
  /** 最近一次实测用量（`Compactor.usage()`）。端点没报过就是 `undefined`。 */
  readonly lastUsage?: { readonly inputTokens: number; readonly estimated: boolean } | undefined;
};

/** 千分位用**手写**的，不走 `toLocaleString`：那个跟着机器语言变，测试里就是一条流沙。 */
function num(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function contextReport(input: ContextReportInput): readonly string[] {
  const lines: string[] = ['上下文账本（除「上次实测」外都是估的）：'];

  if (input.pieces === undefined) {
    // 一次性模式（`deepcode "…"`）没有 REPL，也就没有这一轮之前的那次重算。
    lines.push('  系统提示　这一轮还没算过（`/context` 在 REPL 里用）。');
  } else {
    const each = input.pieces.map((piece) => `${piece.name} ${num(estimateTokens(piece.text.length))}`);
    const systemTokens = estimateTokens(
      input.pieces.reduce((total, piece) => total + piece.text.length, 0),
    );
    lines.push(`  系统提示　${num(systemTokens)} token —— ${each.join(' · ')}`);
  }

  const tools = input.tools;
  if (tools === undefined) {
    lines.push('  工具清单　这一轮还没发过请求。');
  } else {
    // 形状与系统提示那一行一样：总数 = 逐工具之和（取整余数带来的 1 token 级出入同源）。
    const each = tools.map((spec) => `${spec.name} ${num(estimateTokens(toolSpecChars(spec)))}`);
    lines.push(
      `  工具清单　${tools.length} 个 · ${num(estimateTokens(toolsChars(tools)))} token` +
        (each.length === 0 ? '' : ` —— ${each.join(' · ')}`),
    );
  }

  const sessionTokens = estimateTokens(messageChars(input.messages));
  lines.push(`  会话消息　${num(sessionTokens)} token（${input.messages.length} 条）`);

  const piecesChars =
    input.pieces === undefined
      ? 0
      : input.pieces.reduce((total, piece) => total + piece.text.length, 0);
  // 三样都算：请求里就是这三样（系统提示 / 工具 / 消息）。工具那一份是 `runTurn` 报出来的
  // **真的发出去的那一份**，不是这里现算的 —— 否则这个数又变成一个与真实请求无关的猜测。
  const totalChars = piecesChars + (tools === undefined ? 0 : toolsChars(tools)) + messageChars(input.messages);
  lines.push(`  合计　　　${num(estimateTokens(totalChars))} token`);

  lines.push(
    `  阈值　　　${num(input.compact.atTokens)} token · 自动压缩 ${input.compact.auto ? '开' : '关'}` +
      ` · 保留最近 ${input.compact.keepTurns} 轮`,
  );

  const usage = input.lastUsage;
  lines.push(
    usage === undefined
      ? '  上次实测　还没发过请求。'
      : `  上次实测　${num(usage.inputTokens)} token${usage.estimated ? '（估的 —— 端点没报用量）' : '（端点报的）'}`,
  );

  // 这一句是**输出的一部分**，不是免责声明：不写清楚，读的人就会以为"合计"离满还远或
  // 已经超了 —— 那正好是复刻对象三次事故的形状（在真实窗口一半处就压缩）。
  lines.push('不报「还剩多少」：没有模型注册表，模型窗口是多少我们不知道 —— 编一个数比不报更坏。');
  return lines;
}
