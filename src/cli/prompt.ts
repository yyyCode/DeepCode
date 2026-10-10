import type { Interface } from 'node:readline';
import type { UiSink } from '../core/nouns/ui';

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
export function createPromptSink(rl: Interface): UiSink & { close(): void } {
  const interactive = Boolean(process.stdin.isTTY);

  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),
    ask: (question) => {
      // 非交互环境没人能确认 —— 默认拒绝，不放行。
      if (!interactive) return Promise.resolve('n');
      return new Promise((resolve) => rl.question(question, resolve));
    },
    close: () => rl.close(),
  };
}
