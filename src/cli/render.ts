import type { UiSink } from '../core/nouns/ui';

/**
 * MVP 的渲染就是往 stdout 写文本 —— 不走 ui.render 事件。
 * 架构文档里的 ui.render 返回的是纯数据树 + 逐 surface 元素表，那是为了跨
 * terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。见设计文档 §10 偏差 1。
 */
export type Renderer = UiSink & { delta(text: string): void; newline(): void };

export function createRenderer(): Renderer {
  // 模型文本是**增量**来的（delta 不带换行），别的东西都是按行写的。
  // 记着自己在不在行首，工具预览、通知、提示符才不会接到半句话后面去。
  let atLineStart = true;

  const write = (text: string): void => {
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
  };

  const endLine = (): void => {
    if (atLineStart) return;
    process.stdout.write('\n');
    atLineStart = true;
  };

  return {
    print: (line) => {
      endLine();
      write(`${line}\n`);
    },
    notice: (line) => {
      // stderr 与 stdout 在终端里是同一块屏幕：先补上那半行，提示才不会被截断。
      endLine();
      process.stderr.write(`${line}\n`);
    },
    ask: async () => 'n',
    delta: (text) => write(text),
    newline: endLine,
  };
}
