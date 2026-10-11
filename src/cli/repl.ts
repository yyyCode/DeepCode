import type { Interface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import type { EngineInterface } from '../contract/engine';
import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { runTurn } from '../core/loop';
import type { Renderer } from './render';
import type { TurnSignals } from './turns';

export type ReplDeps = {
  $: EngineInterface;
  dispatch: DispatchFn;
  render: Renderer;
  /** 与确认提示共用的那一个 readline 实例。不要在别处再 createInterface。 */
  rl: Interface;
  systemPrompt: string;
  /** 每个 turn 现取一个 signal，中断才会只掐断这一次。见 createTurnSignals。 */
  turns: TurnSignals;
  /**
   * 会话消息。由 main.ts 建、REPL 与 `/clear`（经 cli/commands.ts）共用**同一个数组引用** ——
   * `--resume` 接上时这里已经装着历史。REPL 不再自己建一份。
   */
  messages: Message[];
  /** 每个 turn 结束后把整个消息数组交给落盘器（它自己算增量）。 */
  persist: (messages: readonly Message[]) => Promise<void>;
  /** 每一轮的用量（`turn.complete` 的同一条数据）。压缩的阈值判定吃它。 */
  onUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimated: boolean;
  }) => void;
  /** 每个 turn 收尾时调一次（落盘之后）。跨过压缩阈值时的提醒与自动压缩都在这儿。 */
  afterTurn?: () => Promise<void>;
};

/** 交互式 REPL。退出方式：/exit、Ctrl-D、Ctrl-C。 */
export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = deps.rl;
  const messages = deps.messages;
  let turnIndex = 0;

  /** 问一行；stdin 关闭（Ctrl-D）时返回 null。 */
  const askLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      // close 监听必须在拿到答案后摘掉。rl.once 每调用一次就挂一个新监听，
      // 而 rl 是整个会话共用的 —— 不摘的话监听器一路累积，
      // 十几轮之后就开始刷 MaxListenersExceededWarning。
      const onClose = () => resolve(null);
      rl.once('close', onClose);
      try {
        rl.question('\n> ', (answer) => {
          rl.off('close', onClose);
          resolve(answer);
        });
      } catch {
        // rl 已经关了（比如在确认提示上按了 Ctrl-D，或流被外部关掉）：当作 EOF 收场。
        // 不接住的话异常会一路冒到 main 的 catch，报一句"启动失败"退出 ——
        // 而 'close' 也不会再补发，这个 promise 就会永远挂着。
        rl.off('close', onClose);
        resolve(null);
      }
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

    const signal = deps.turns.begin();
    try {
      // 开始转 spinner：模型第一个增量（或本 turn 结束）到来时会被停掉。
      deps.render.thinking();
      await runTurn(
        {
          $: deps.$,
          provider: { name: 'repl', stream: (req) => deps.$.model.stream(req) },
          signal,
          dispatch: deps.dispatch,
          systemPrompt: deps.systemPrompt,
          turnIndex: turnIndex++,
          ...(deps.onUsage === undefined ? {} : { onUsage: deps.onUsage }),
        },
        messages,
      );
    } finally {
      // 失败也要归零：留着 busy=true 会让下一次 Ctrl-C 变成"掐一个已经结束的 turn"。
      deps.turns.end();
      // 每个 turn 收尾都补一个换行、并把新增消息落盘 —— 放在 finally 里，
      // 出错/被中断的那一轮也照样收尾。newline 只在这里调一次，别在外面再来一遍。
      deps.render.newline();
      await deps.persist(messages);
      // 落盘之后再判压缩：压完要 `reseed` 游标，而游标是落盘器自己的状态。
      await deps.afterTurn?.();
    }
  }

  rl.close();
}
