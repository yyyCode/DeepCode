/**
 * 活动区的帧与时钟。**这里不碰终端** —— 画在哪里、画几行是 `render.ts` 的事。
 *
 * 原先这是 `spinner.ts`：一个自己往 stderr 写字的"单行 spinner"（P1 的产物）。
 * P6a 把活动区变成多行、可重画的一块之后，"算帧序"与"写终端"必须分开：
 * 定时器只回答"该重画了"，画什么、抹几行归活动区管。
 *
 * 分开还买到一件更实在的东西：**它变得可测**。注入一个假钟，屏上的每一帧
 * 都能逐字节断言，而不用让测试真的等 90 毫秒 —— 原先的 spinner 只能靠
 * "非 TTY 下什么都不写"这一条来测。
 */

/** 帧序列：braille 点阵，等宽，`\r` 重画时不会抖动。 */
export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const INTERVAL_MS = 90;

export type Cancel = () => void;

/** `(要重复做的事, 间隔毫秒) → 取消函数`。测试注入假实现，生产用 `startTicker`。 */
export type Ticker = (fn: () => void, ms: number) => Cancel;

export const startTicker: Ticker = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // unref：转着的活动区不该成为"进程退不掉"的理由。
  // （原先在 spinner 里就是这条，搬过来一字未改 —— 一次真实事故的产物。）
  timer.unref();
  return () => clearInterval(timer);
};
