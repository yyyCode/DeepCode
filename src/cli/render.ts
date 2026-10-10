import type { UiSink } from '../core/nouns/ui';
import type { Palette } from './ansi';
import { createSpinner, type Spinner } from './spinner';

/**
 * MVP 的渲染就是往 stdout 写文本 —— 不走 ui.render 事件。
 * 架构文档里的 ui.render 返回的是纯数据树 + 逐 surface 元素表，那是为了跨
 * terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。见设计文档 §10 偏差 1。
 */
export type Renderer = UiSink & {
  delta(text: string): void;
  newline(): void;
  /** 开始转"思考中"的 spinner。模型第一个增量（或一次新提问）到来前显示。 */
  thinking(label?: string): void;
};

export type RendererOptions = {
  /**
   * 预留：目前渲染器自己的行不做着色 —— `/diff` 与确认提示的着色由各自的调用点
   * 拿着同一份 palette 完成（见 cli/commands.ts、cli/prompt.ts）。留在这里是为了
   * 让"整个 CLI 只有一份 palette"这件事在装配处一眼可见，而不是散落在各处现建。
   */
  readonly palette?: Palette;
  readonly spinner?: Spinner;
  readonly stream?: NodeJS.WriteStream;
};

export function createRenderer(options: RendererOptions = {}): Renderer {
  // 模型文本是**增量**来的（delta 不带换行），别的东西都是按行写的。
  // 记着自己在不在行首，工具预览、通知、提示符才不会接到半句话后面去。
  let atLineStart = true;

  const spinner = options.spinner ?? createSpinner();
  const stream = options.stream ?? process.stdout;

  // 下游把管道关了（`deepcode "..." | head -1`）时，往 stdout 写会**异步**抛 EPIPE。
  // 异步错误绕过 hook 的 try/catch（dispatch 那里只接得住同步抛出的错），
  // 会直接把整个进程带走。这不是崩溃，是"对面不要了"：闭嘴继续跑完，
  // 别把已经做出来的事也丢掉。
  let stdoutGone = false;
  stream.on('error', (error: NodeJS.ErrnoException) => {
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
    stream.write(text);
    atLineStart = text.endsWith('\n');
  };

  const endLine = (): void => {
    if (atLineStart || stdoutGone) return;
    stream.write('\n');
    atLineStart = true;
  };

  return {
    print: (line) => {
      // 写任何一行之前先把 spinner 抹掉，否则那半行小圆圈会跟在模型的话后面。
      spinner.stop();
      endLine();
      write(`${line}\n`);
    },
    notice: (line) => {
      // 同上：stderr 与 stdout 在终端里是同一块屏幕，先停 spinner 再补那半行。
      spinner.stop();
      endLine();
      process.stderr.write(`${line}\n`);
    },
    ask: async () => 'n',
    delta: (text) => {
      // 空增量：原样放过，而且**不**碰 spinner —— 它什么都没显示，模型还在想，
      // 此刻把 spinner 停掉纯属自断，"思考中"会早早消失。
      // （停机判断因此落在 stop() 之前。计划里那句"判断放在 stop() 之后"若照字面写，
      //   空增量会把还在转的 spinner 抹掉，与它自己给的理由正好相反。）
      if (text === '') return;
      spinner.stop();
      write(text);
    },
    newline: () => {
      spinner.stop();
      endLine();
    },
    // 默认标签用省略号而不是三个点：终端里 `…` 是一个字符宽，spinner 每帧重画时不会抖。
    thinking: (label = '思考中…') => spinner.start(label),
  };
}
