import type { Interface } from 'node:readline';
import type { UiSink } from '../core/nouns/ui';

export type PromptSinkOptions = {
  /**
   * 当前 turn 的 signal 工厂。确认提示**必须**能被它叫醒 ——
   * 见 ask 里的三条收场路径。
   */
  signalOf: () => AbortSignal;
  /** 只给测试用：默认按 `process.stdin.isTTY` 判断。 */
  interactive?: boolean;
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

  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),

    ask: (question) => {
      // 非交互环境没人能确认 —— 默认拒绝，不放行。
      if (!interactive) return Promise.resolve('n');

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

        rl.question(question, (answer) => settle(answer));
      });
    },

    close: () => rl.close(),
  };
}
