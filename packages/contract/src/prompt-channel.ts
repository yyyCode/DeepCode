/**
 * 钩子往对话里带文本的那条通道 —— 三个落点共用这一小块。
 *
 * 落点不同（工具结果 / 用户消息 / 不让收手时的下一轮输入），但"钩子补充的上下文"
 * 只有一个形状、一个标记。分开定义两次，用户翻转录时会看到两句不一样的话。
 *
 * `contract/` 是叶子：这个文件零 import。
 */
export const CONTEXT_MARKER = '[钩子补充的上下文]';

/** 把一段钩子给的上下文并进一段既有文本。空/纯空白 = 原样返回，不留空标记。 */
export function withContext(text: string, context: string | undefined): string {
  const extra = context?.trim() ?? '';
  if (extra === '') return text;
  return `${text}\n\n${CONTEXT_MARKER}\n${extra}`;
}
