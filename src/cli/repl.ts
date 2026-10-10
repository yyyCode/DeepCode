import type { Interface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import type { EngineInterface } from '../contract/engine';
import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { runTurn } from '../core/loop';
import type { Renderer } from './render';

export type ReplDeps = {
  $: EngineInterface;
  dispatch: DispatchFn;
  render: Renderer;
  /** 与确认提示共用的那一个 readline 实例。不要在别处再 createInterface。 */
  rl: Interface;
  systemPrompt: string;
  signal: AbortSignal;
};

/** 交互式 REPL。退出方式：/exit、Ctrl-D、Ctrl-C。 */
export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = deps.rl;
  const messages: Message[] = [];
  let turnIndex = 0;

  /** 问一行；stdin 关闭（Ctrl-D）时返回 null。 */
  const askLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      // close 监听必须在拿到答案后摘掉。rl.once 每调用一次就挂一个新监听，
      // 而 rl 是整个会话共用的 —— 不摘的话监听器一路累积，
      // 十几轮之后就开始刷 MaxListenersExceededWarning。
      const onClose = () => resolve(null);
      rl.once('close', onClose);
      rl.question('\n> ', (answer) => {
        rl.off('close', onClose);
        resolve(answer);
      });
    });

  for (;;) {
    const line = await askLine();
    if (line === null) break;

    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith('/')) {
      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      const result = await deps.dispatch('command.run', { name: name ?? '', args }, CORE_ORIGIN);
      if (result.handled) {
        if (name === 'exit') break;
        continue;
      }
      deps.render.notice(`未知命令：/${name}`);
      continue;
    }

    // prompt.submit 是留给 P1 的钩子点（斜杠展开、prompt.fill、附件）。
    // core 返回 { handled: false }，所以 MVP 里它什么都不做 —— 但它真的被抛出来了，
    // 而不是躺在 contract 里没人碰。
    const submitted = await deps.dispatch('prompt.submit', { text: trimmed }, CORE_ORIGIN);
    if (submitted.handled) continue;

    messages.push({ role: 'user', content: trimmed });

    await runTurn(
      {
        $: deps.$,
        provider: { name: 'repl', stream: (req) => deps.$.model.stream(req) },
        signal: deps.signal,
        dispatch: deps.dispatch,
        systemPrompt: deps.systemPrompt,
        turnIndex: turnIndex++,
      },
      messages,
    );

    deps.render.newline();
  }

  rl.close();
}
