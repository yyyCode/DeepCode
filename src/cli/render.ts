import type { UiSink } from '../core/nouns/ui';

/**
 * MVP 的渲染就是往 stdout 写文本 —— 不走 ui.render 事件。
 * 架构文档里的 ui.render 返回的是纯数据树 + 逐 surface 元素表，那是为了跨
 * terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。见设计文档 §10 偏差 1。
 */
export type Renderer = UiSink & { delta(text: string): void; newline(): void };

export function createRenderer(): Renderer {
  const interactive = Boolean(process.stdout.isTTY);
  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),
    ask: async () => 'n',
    delta: (text) => process.stdout.write(text),
    newline: () => {
      if (interactive) process.stdout.write('\n');
    },
  };
}
