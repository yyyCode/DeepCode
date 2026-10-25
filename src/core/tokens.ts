import type { Message } from '../contract/model-provider';

/**
 * 一段文本的 token 数**粗估**。参数是**字符数**不是文本 —— 两处调用方手里本来就是长度。
 *
 * ⚠️ 它是估计，不是测量：中英混排会失真（中文一个字约 1–2 个 token，不是 0.25 个）。
 * 之所以留着它，是因为"什么都不报"比"报一个标出来的估计"更坏 —— 前者让消费端
 * 以为上下文是空的。
 *
 * P11 起它从 `core/loop.ts` 搬到这里：`loop` 与 `context-shaping` 都要用它，
 * 留在 loop 里会让上下文模块反过来 import loop（循环依赖）。
 * `core/loop.ts` 仍然原样再导出，既有 import 一处都不用改。
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 一个消息数组的**字符数**。工具结果与工具入参都算进去 —— 它们也是要占窗口的东西。 */
export function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      total += message.content.length;
    } else if (message.role === 'tool') {
      for (const result of message.results) total += result.content.length;
    } else {
      for (const block of message.content) {
        total +=
          block.type === 'text' ? block.text.length : JSON.stringify(block.input ?? {}).length;
      }
    }
  }
  return total;
}
