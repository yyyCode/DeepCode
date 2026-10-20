import type { UiSink } from '@deepcode/core/nouns/ui';
import { colorEnabled, createPalette, type Palette } from './ansi';
import { createMarkdownStream } from './markdown';
import { formatDuration } from './result-view';
import { FRAMES, INTERVAL_MS, startTicker, type Cancel, type Ticker } from './ticker';
import { activityWidth, fitTo } from './width';

/**
 * 渲染分两条路，**这条区分是这一层的地基**：
 *
 * - **永久行**（`print` / `notice` / `settle`）写进转录，随终端滚动历史走；
 * - **活动区**（`activity` / `thinking`）是**借来的一块**，只活在一次动作期间，
 *   可以被随时抹掉重画。动作一结束就 `settle` 成永久行。
 *
 * 今天（P6a 之前）只有一行 spinner，所以"先抹掉再写"这件事散在每个调用点里
 * 各判一遍（本文件三处、`prompt.ts` 一处、`main.ts` 漏了一处）。多行之后那套
 * 判断必错，所以收成一块由渲染器自己管的区域。
 *
 * **非 TTY 下这三件事全是 no-op**：管道、重定向、CI 里输出与 P6a 之前**逐字节相同**。
 * 这是既有纪律的延续（spinner 当年就是"非 TTY 一个字节都不产出"），也是这一片
 * 唯一能让一千多个既有断言继续站着的原因。
 *
 * 为什么不用 `ui.render` 的数据树：它存在的意义是**多个消费者**（terminal /
 * desktop / mobile），而我们仍然只有一个。见 P6 设计 §2.3 —— 那笔账继续持有，
 * 但它的实质要求（渲染是所有人能挂上去的一条路）由"界面元素都是既有事件的观察者"
 * 兑现，见 `cli/activity.ts`。
 */

export type ActivityTick = {
  /** 这一帧的小圆圈。 */
  readonly frame: string;
  /** 活动区从挂上到现在过了多久。 */
  readonly elapsedMs: number;
};

/**
 * 活动区的内容。传**函数** = 每帧重新调它（于是能动、能显示耗时）；
 * 传**数组** = 静态的一屏，画一次就完。传空数组 = 抹掉。
 */
export type ActivitySource = readonly string[] | ((tick: ActivityTick) => readonly string[]);

export type Renderer = UiSink & {
  delta(text: string): void;
  newline(): void;
  /** 挂上一行"思考中"并让它转起来。模型第一个增量（或一次新提问）到来前显示。 */
  thinking(label?: string): void;
  /** 重画活动区（见 `ActivitySource`）。非 TTY 下 no-op。 */
  activity(source: ActivitySource): void;
  /** 把活动区兑现成**永久行**：先抹掉临时的那几行，再把给定的行写进转录。 */
  settle(lines: readonly string[]): void;
};

export type RendererOptions = {
  readonly stream?: NodeJS.WriteStream;
  /**
   * 活动面开关。默认 `stream.isTTY && TERM !== 'dumb'`。
   * 关掉时 `activity` / `settle` / `thinking` 全是 no-op —— 这是测试与管道共用的那一支。
   */
  readonly live?: boolean;
  /** 帧定时器。测试注入一个手动版，屏上的每一帧就能逐字节断言。 */
  readonly ticker?: Ticker;
  readonly now?: () => number;
  readonly frames?: readonly string[];
  readonly intervalMs?: number;
  /**
   * 内容面（P6b）着色用。**默认按 `stream` 自己判** —— 关掉色时
   * `createPalette(false)` 逐字节等于纯文本，markdown 的结构（框线、缩进、折行）
   * 照旧在，只是不上色。
   */
  readonly palette?: Palette;
};

/**
 * 所有活着的活动区。退出前统一抹一遍。
 *
 * 挂**一次**进程监听而不是每个渲染器挂一个：测试里会造出很多个渲染器，
 * 每个挂一个 `process.once('exit')` 会在第 11 个开始刷 MaxListenersExceededWarning —
 * 而那正是原先 `repl.ts` 里已经栽过的那个坑。
 */
const erasers = new Set<() => void>();
let hooked = false;

function hookExit(erase: () => void): () => void {
  erasers.add(erase);
  if (!hooked) {
    hooked = true;
    // 进程死在活动区转着的时候，退出前把它抹掉。否则终端里留下半行小圆圈，
    // 用户的下一条命令会在同一行接着写。
    process.once('exit', () => {
      for (const fn of erasers) fn();
    });
  }
  return () => erasers.delete(erase);
}

export function createRenderer(options: RendererOptions = {}): Renderer {
  const stream = options.stream ?? process.stdout;
  const live = options.live ?? (Boolean(stream.isTTY) && process.env.TERM !== 'dumb');
  const frames = options.frames ?? FRAMES;
  const now = options.now ?? (() => Date.now());
  const startClock = options.ticker ?? startTicker;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;

  /**
   * 内容面（P6b）：模型流出来的文本按行过一遍 markdown 子集，再折到终端宽度。
   *
   * ⚠️ **只在活动面活着时才建**。非 TTY 下 `delta` 写出去的必须与 P6a 之前
   * 逐字节相同 —— 而 markdown 渲染会改字节（加框线、上色、折行），
   * 管道里那些都是污染。与活动面同一条纪律，同一处开关。
   */
  const markdown = live
    ? createMarkdownStream({
        palette: options.palette ?? createPalette(colorEnabled(stream)),
        width: activityWidth(stream.columns),
      })
    : undefined;

  // 模型文本是**增量**来的（delta 不带换行），别的东西都是按行写的。
  // 记着自己在不在行首，工具预览、通知、提示符才不会接到半句话后面去。
  let atLineStart = true;

  // 活动区此刻占**屏幕**上几行。不是"内容有几行"——折了行就是两行，
  // 所以每一行画出去之前都按宽度截断过（见 width.ts）。
  let liveRows = 0;
  let source: ((tick: ActivityTick) => readonly string[]) | undefined;
  let cancel: Cancel | undefined;
  let frame = 0;
  let startedAt = 0;

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

  /** 控制序列专用：直接写，**不碰** `atLineStart` —— 转义串不是转录的一部分。 */
  const control = (seq: string): void => {
    if (stdoutGone) return;
    stream.write(seq);
  };

  const endLine = (): void => {
    // 先交出 markdown 行缓冲里那半行。**顺序要紧**：模型可能正说到一半
    // （缓冲里攒着"我先看看"，还没有换行），而下面紧接着要落一行永久行 ——
    // 不在这儿交出来的话，那半句话会掉到那行永久行的**后面**去。
    if (markdown !== undefined) write(markdown.flush());
    if (atLineStart || stdoutGone) return;
    stream.write('\n');
    atLineStart = true;
  };

  /** 抹掉活动区，光标停在它第一行的行首。**幂等**。 */
  const erase = (): void => {
    if (liveRows === 0) return;
    control('\r');
    for (let i = 0; i < liveRows; i++) {
      control('\u001b[K');
      if (i < liveRows - 1) control('\u001b[1B');
    }
    if (liveRows > 1) control(`\u001b[${liveRows - 1}A`);
    control('\r');
    liveRows = 0;
  };

  /** 在光标处画一屏，画完把光标挪回第一行行首（`erase` 与下一次 `paint` 都假定它在那儿）。 */
  const paint = (lines: readonly string[]): void => {
    if (lines.length === 0) return;
    control(lines.join('\n'));
    liveRows = lines.length;
    control('\r');
    if (lines.length > 1) control(`\u001b[${lines.length - 1}A`);
  };

  const redraw = (): void => {
    if (source === undefined) return;
    const tick: ActivityTick = {
      frame: frames[frame++ % frames.length]!,
      elapsedMs: now() - startedAt,
    };
    const width = activityWidth(stream.columns);
    erase();
    paint(source(tick).map((line) => fitTo(line, width)));
  };

  const stopClock = (): void => {
    cancel?.();
    cancel = undefined;
    source = undefined;
  };

  if (live) hookExit(erase);

  const setActivity = (next: ActivitySource): void => {
    if (!live) return;
    stopClock();
    if (typeof next !== 'function' && next.length === 0) {
      erase();
      return;
    }
    frame = 0;
    startedAt = now();
    // 活动区必须从一行的行首开始。模型可能刚吐了半句话（还没有换行），
    // 那半句后面接一屏转着的小圆圈是最典型的 TUI 事故 —— 先把那半行收掉。
    endLine();
    source = typeof next === 'function' ? next : () => next;
    redraw();
    // 静态的一屏画一次就完；给的是函数才需要一直重画。
    if (typeof next === 'function') cancel = startClock(redraw, intervalMs);
  };

  return {
    print: (line) => {
      // 写任何一行之前先抹掉活动区，否则那半行小圆圈会跟在模型的话后面。
      stopClock();
      erase();
      endLine();
      write(`${line}\n`);
    },
    notice: (line) => {
      // stdout 与 stderr 在终端里是同一块屏幕，所以照样先抹活动区。
      stopClock();
      erase();
      endLine();
      if (stdoutGone) return;
      process.stderr.write(`${line}\n`);
    },
    ask: async () => 'n',
    delta: (text) => {
      // 空增量：原样放过，而且**不**碰活动区 —— 它什么都没显示，模型还在想，
      // 此刻把活动区抹掉纯属自断，"思考中"会早早消失。
      // （停机判断因此落在清理之前。计划里那句"判断放在 stop 之后"若照字面写，
      //   空增量会把还在转的活动区抹掉，与它自己给的理由正好相反。）
      if (text === '') return;
      stopClock();
      erase();
      // ⚠️ 空增量在上面就被放过了 —— 它连一个 code unit 都没有，**不**该推进
      // markdown 的行缓冲（推了也一样，但"空串也是输入"这个念头是 bug 的温床）。
      write(markdown === undefined ? text : markdown.push(text));
    },
    newline: () => {
      stopClock();
      erase();
      endLine();
    },
    thinking: (label = '思考中…') => {
      // 默认标签用省略号而不是三个点：终端里 `…` 是一个字符宽，每帧重画时不会抖。
      // 耗时只在 ≥1s 时出现 —— 低一秒的动作刷出一串 `0.1s 0.2s` 是噪音，
      // 而且每帧宽度都不同，在终端里就是抖动。
      setActivity((tick) => [`${tick.frame} ${label}${formatDuration(tick.elapsedMs)}`]);
    },
    activity: setActivity,
    settle: (lines) => {
      if (!live) return;
      stopClock();
      erase();
      // 与 endLine 同一个理由：半句话必须先交出来（并把那一行收掉），再落这几行。
      endLine();
      // ⚠️ 这里**不**按宽度截断：永久行归终端自己折，折了不丢信息。
      // 会截断的只有活动区 —— 那里屏幕行数必须与账面严格相等，否则上移几行会算错。
      for (const line of lines) write(`${line}\n`);
    },
  };
}
