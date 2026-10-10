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

  // 下游把管道关了（`deepcode "..." | head -1`）时，往 stdout 写会**异步**抛 EPIPE。
  // 异步错误绕过 hook 的 try/catch（dispatch 那里只接得住同步抛出的错），
  // 会直接把整个进程带走。这不是崩溃，是"对面不要了"：闭嘴继续跑完，
  // 别把已经做出来的事也丢掉。
  let stdoutGone = false;
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      stdoutGone = true;
      return;
    }
    throw error;
  });

  const write = (text: string): void => {
    // 空增量必须原样放过：它写不出任何字节，却会把 atLineStart 翻成 false，
    // 于是下一次 print 平白多吐一个换行。
    if (text === '' || stdoutGone) return;
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
  };

  const endLine = (): void => {
    if (atLineStart || stdoutGone) return;
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
