import type { Interface } from 'node:readline';
import type { UiSink } from '../core/nouns/ui';
import { createPalette, type Palette } from './ansi';

export type PromptSinkOptions = {
  /**
   * 当前 turn 的 signal 工厂。确认提示**必须**能被它叫醒 ——
   * 见 ask 里的三条收场路径。
   */
  signalOf: () => AbortSignal;
  /** 只给测试用：默认按 `process.stdin.isTTY` 判断。 */
  interactive?: boolean;
  /** 提示语着色用。默认关（不传就是纯文本，测试里的断言才逐字节稳）。 */
  palette?: Palette;
  /**
   * 提示落笔**之前**调一次。main.ts 用它停掉 spinner ——
   * 否则"思考中"那半行小圆圈会粘在 `> ` 提示符前面。
   */
  beforeAsk?: () => void;
};

/**
 * 复用调用方那**一个** readline 实例，绝不自己再建第二个。
 *
 * 同一个 process.stdin 上挂两个 Interface，两边都会收到用户敲的每一行
 * （已实测：两次 question 同时挂起时，一行输入被两个回调各收一份）。
 * 而 TTY 下两个 Interface 还会各自进入 raw 模式、各自挂 keypress 监听，
 * 于是每个按键被处理两遍、终端里回声重叠。
 *
 * 所以 rl 由 main.ts 建一次，REPL 与确认提示共用。
 */
export function createPromptSink(
  rl: Interface,
  options: PromptSinkOptions,
): UiSink & { close(): void } {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  const palette = options.palette ?? createPalette(false);

  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),

    ask: (question) => {
      // 非交互环境没人能确认 —— 默认拒绝，不放行。
      if (!interactive) return Promise.resolve('n');

      // 确认提示落笔前先让调用方停 spinner（见 beforeAsk 的注释）。放在交互判定**之后**：
      // 非交互下这里根本不会画提示符，反倒往里插一个换行会污染管道输出。
      options.beforeAsk?.();

      return new Promise<string>((resolve) => {
        const signal = options.signalOf();
        let settled = false;

        // 三条路都必须能收场，而且方向只能是"拒绝"：
        // - 用户答了 → 用他的答案；
        // - Ctrl-D / 流被关掉 → 'n'（读不到答案 = 没同意）；
        // - Ctrl-C 掐断了本 turn → 'n'。
        // 少了后两条，`rl.question` 的回调就永远不来，这个 await 把整个会话挂死 ——
        // 连 repl 里的 turns.end() 都跑不到，busy 永远停在 true。
        // （实测：close() 不会调用尚在挂起的 question 回调。）
        const settle = (answer: string): void => {
          if (settled) return;
          settled = true;
          rl.off('close', onClose);
          signal.removeEventListener('abort', onAbort);
          resolve(answer);
        };
        const onClose = (): void => settle('n');
        const onAbort = (): void => settle('n');

        rl.once('close', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
        // 已经 abort 过的 signal 不会补发事件，得自己查一次。
        if (signal.aborted) {
          settle('n');
          return;
        }

        // 问什么由内核说（`执行 Edit? (y/N) `），长什么样由界面说 —— 这个 `⏸` 是
        // 界面加的，内核那行文案一个字没动（P6 设计 §3.1 的「等」那一态）。
        rl.question(palette.bold(`⏸ ${question}`), (answer) => settle(answer));
      });
    },

    close: () => rl.close(),
  };
}
