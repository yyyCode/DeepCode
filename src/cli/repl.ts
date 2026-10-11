import type { Interface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import type { EngineInterface } from '../contract/engine';
import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { withContext } from '../contract/prompt-channel';
import { runTurn } from '../core/loop';
import { planItems, type LineQueue } from './input';
import type { Palette } from './ansi';
import type { Renderer } from './render';
import type { TurnSignals } from './turns';

export type ReplDeps = {
  $: EngineInterface;
  dispatch: DispatchFn;
  render: Renderer;
  /** 与确认提示共用的那一个 readline 实例。不要在别处再 createInterface。 */
  rl: Interface;
  /**
   * 行队列。**由 main.ts 在 rl 建好之后立刻建**（见 cli/input.ts 顶部）——
   * 那段空窗里到达的输入只有它留得住。
   */
  lines: LineQueue;
  /**
   * 提示符着色用（`> ` 加粗，与确认提示的 `⏸` 在视觉上分开）。
   * 省略 = 纯文本。
   */
  palette?: Palette;
  /**
   * 是不是真的有人在敲。**只给测试用**：默认按 `process.stdin.isTTY` 判。
   *
   * 非交互下**不画提示符**：管道里没有回声，`> ` 会与下一条命令的输出挤在同一行
   * （`> ── 工作区改动 · git ── …`）。提示符是给等在那儿的人看的，
   * 而管道那头没有人在等。
   */
  interactive?: boolean;
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
  const palette = deps.palette;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  let turnIndex = 0;

  // 提示符：`> ` 是提问，`… ` 是**续行**（上一行以 `\` 结尾）。两个都从新的一行开始，
  // 于是它们不会粘在模型上一句话的尾巴上。加粗是为了与确认提示的 `⏸` 分清
  // ——那两行都是"在等你敲东西"，糊在一起最容易按错。
  const ask = (more: boolean): void => {
    if (!interactive) return;
    const head = more ? '… ' : '> ';
    rl.setPrompt(`\n${palette === undefined ? head : palette.bold(head)}`);
    rl.prompt();
  };

  /** 跑一个 turn。`text` 已是多行正文（续行拼好的）。 */
  const submit = async (text: string): Promise<void> => {
    // prompt.submit 是留给 P1 的钩子点（斜杠展开、prompt.fill、附件）。
    // core 返回 { handled: false }，所以 MVP 里它什么都不做 —— 但它真的被抛出来了，
    // 而不是躺在 contract 里没人碰。
    const submitted = await deps.dispatch('prompt.submit', { text }, CORE_ORIGIN);
    if (submitted.handled) return;

    // 拼进**用户那条消息**，不是另插一条：两条连续的 user 消息是某些端点会拒的形状，
    // 我们没有理由为了一句补充说明去踩这个坑。代价是转录里也含这段 —— 这是对的，
    // 模型当时看到的就是这个。
    messages.push({ role: 'user', content: withContext(text, submitted.context) });

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
  };

  /** 跑一条 `/命令`。返回值 = 该不该退出 REPL。 */
  const runCommand = async (name: string, args: readonly string[]): Promise<boolean> => {
    const result = await deps.dispatch('command.run', { name, args }, CORE_ORIGIN);
    if (result.handled) return name === 'exit';
    deps.render.notice(`未知命令：/${name}`);
    return false;
  };

  /**
   * 续行攒下的正文。跨批次存在（用户敲完 `\` 会停一下，去抖窗口之外），
   * 所以它不能活在某一批的处理里。
   */
  let pending: string | undefined;

  for (;;) {
    ask(pending !== undefined);
    const batch = await deps.lines.next();
    if (batch === null) {
      // EOF 时把已经攒下的续行交出去 —— 用户敲过的东西不许因为按了 Ctrl-D 就没了。
      if (pending !== undefined) {
        const text = pending;
        pending = undefined;
        await submit(text);
      }
      break;
    }

    for (const item of planItems(batch)) {
      if (item.kind === 'command') {
        // 命令把续行打断：先交出去的那半截仍是一次正常提问。
        if (pending !== undefined) {
          const text = pending;
          pending = undefined;
          await submit(text);
        }
        if (await runCommand(item.name, item.args)) {
          rl.close();
          return;
        }
        continue;
      }

      const text = pending === undefined ? item.text : `${pending}\n${item.text}`;
      if (item.more) {
        pending = text;
        continue;
      }
      pending = undefined;
      await submit(text);
    }
  }

  rl.close();
}

