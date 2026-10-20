import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { Message, ModelProvider } from '@deepcode/contract/model-provider';
import type { DispatchFn } from '@deepcode/core/dispatch';
import { estimateTokens, messageChars } from '@deepcode/core/loop';
import type { CompactConfig } from './settings';
import type { Persister } from './transcript';

/**
 * 摘要那一轮的指令。
 *
 * 要求里**明确写了"不要复述过程"**：摘要只要能接手的东西（目标、改过的文件、结论、未决问题），
 * 逐轮复述等于把原文换个说法搬回来，压缩率会掉到接近零。
 */
export const SUMMARIZE_PROMPT = `请把上面这段编码会话压缩成一份摘要，供后续对话接手使用。要求：
1. 用户的目标是什么、做到哪一步了。
2. 已经改过哪些文件（写全路径）。
3. 已经确认的结论，以及还没解决的问题。
4. **不要复述过程**，不要逐轮复述。只写结论与状态。
用中文，条目式，尽量短。`;

/**
 * 找压缩的切点：从尾部数第 `keepTurns` 条 `role === 'user'` 消息的下标。
 * 一轮 = 一条 user 消息**及其之后**的一切（assistant 回复、工具结果都算这一轮里的）。
 *
 * 返回 `undefined` = 没有可压的：历史不够 `keepTurns` 轮，或者切点正好落在第 0 条
 * （那两种情况压了都等于没压）。
 */
export function splitAt(messages: readonly Message[], keepTurns: number): number | undefined {
  if (keepTurns <= 0) return undefined;

  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== 'user') continue;
    seen += 1;
    if (seen === keepTurns) return index === 0 ? undefined : index;
  }
  return undefined;
}

export type CompactorDeps = {
  /** REPL 正在用的**那个**数组引用 —— 压缩必须就地改，换一个新的等于没改。 */
  readonly messages: Message[];
  readonly provider: ModelProvider;
  readonly dispatch: DispatchFn;
  readonly persist: Persister;
  readonly config: CompactConfig;
  /** 出声（渲染器的 notice）。压缩改的是用户手里的上下文，**必须**看得见。 */
  readonly warn: (line: string) => void;
  readonly signal: () => AbortSignal;
};

export type Compactor = {
  /** 记下这一轮报上来的用量。`estimated` 为真时，提醒里要说明这个数是估的。 */
  note(usage: { readonly inputTokens: number; readonly estimated: boolean }): void;
  /** 每轮收尾调一次：跨过阈值就出声（`auto: true` 时顺手压）。 */
  afterTurn(): Promise<void>;
  /**
   * `/compact` 与自动压缩共用的入口。返回是否真的压了。
   *
   * `instructions` 是用户给的额外要求（`/compact 保住 API 设计`）—— 拼进摘要那一轮的
   * 提示。复刻对象管这个字段叫"最被低估的扩展点"（`11-memory-and-context.md:261`）。
   */
  run(trigger: 'manual' | 'auto', instructions?: string): Promise<boolean>;
  /** 最近一次实测用量（`/context` 的"上次实测"读它）。还没发过请求时 `undefined`。 */
  usage(): { readonly inputTokens: number; readonly estimated: boolean } | undefined;
};

/**
 * 压缩器。
 *
 * ⚠️ **它的失败方向与 fail-closed 相反，这是有意的。** 摘要是**变换缝**（与 P4a 的
 * `skill.prompt` 同类），不是闸：压不成就不压、出声、原文一条不动。宁可上下文继续涨到
 * 真的报错，也不静默丢掉用户已经做过的事 —— 别把它"统一"成 fail-closed（设计 §3.4）。
 */
export function createCompactor(deps: CompactorDeps): Compactor {
  let last: { inputTokens: number; estimated: boolean } | undefined;
  /** 跨过阈值只出声一次。掉回阈值以下时复位 —— 下次再跨过还要出声。 */
  let warned = false;

  // ── 断电器（P7 §3.5）──
  // 复刻对象的三重断电器里有两条对我们成立：连续失败 N 次即停、连续压 N 次之后上下文
  // 立刻又满就判定抖动（`11-memory-and-context.md:281`，其 CHANGELOG `2.1.76` / `2.1.89`）。
  // 我们改这两条之前是**没有**断路器的：`auto: true` 时每轮都可能再压一次，失败只是
  // `warn` 一句，一句一句刷下去 —— 那正是要修的形状。
  //
  // ⚠️ **这个 3 是照抄来的数，不是我们测出来的**（设计 §5 偏差 3）。
  const MAX_STRIKES = 3;
  /** 连续摘要失败次数。 */
  let failures = 0;
  /** 连续压缩成功、期间没有一轮落在阈值之下的次数 —— 到 `MAX_STRIKES` 就是抖动。 */
  let rounds = 0;
  /** 非 `undefined` = 自动压缩已停手，值是理由（说一次，不再刷屏）。 */
  let stopped: string | undefined;

  /**
   * 记一次失败。连续到上限就停手，并把"停手 + 怎么恢复"接在原因后面一起说出来 ——
   * 报错要**可操作**，只说"压缩没做成"等于让用户自己猜。
   */
  const fail = (reason: string): false => {
    failures += 1;
    // 失败之后**放开 `warned`**，让下一轮还能再试一次 —— 试到断电器为止。
    // 不放开的话"连续失败 3 次"这条闸永远走不到第 2 次：`warned` 会一直关着，
    // 一次跨阈值只压一次，计数器到不了上限，闸就成了一段死代码。
    // （"没有可压缩的历史"那条路**不走这里**，所以它仍然只出声一次，不刷屏。）
    warned = false;
    if (failures >= MAX_STRIKES) {
      stopped = `自动压缩连续失败 ${failures} 次（${reason}）`;
      deps.warn(
        `${stopped}，已停手：不会再自动压。\n` +
          '手动输入 /compact 可以再试一次，或把设置里的 compact.auto 关掉。',
      );
    } else {
      deps.warn(reason);
    }
    return false;
  };

  const compactor: Compactor = {
    note(usage) {
      last = usage;
    },

    usage() {
      return last;
    },

    async afterTurn() {
      if (last === undefined) return;

      if (last.inputTokens < deps.config.atTokens) {
        // 掉回阈值之下：一切都过去了。两个计数归零（"压缩真的奏效了"），
        // 停手也解除 —— 下一次再撞上阈值时，自动压缩该有权利再试。
        warned = false;
        failures = 0;
        rounds = 0;
        stopped = undefined;
        return;
      }
      // 已经停手：不自动压、也不再出声（理由说过了，每轮重复一遍就是刷屏）。
      if (stopped !== undefined) return;
      if (warned) return;
      warned = true;

      if (deps.config.auto) {
        await compactor.run('auto');
        return;
      }
      const how = last.estimated ? '（估）' : '';
      deps.warn(
        `上下文已到约 ${last.inputTokens} token${how}，阈值 ${deps.config.atTokens}。` +
          `输入 /compact 压缩，或把设置里的 compact.auto 打开。`,
      );
    },

    async run(trigger, instructions) {
      if (trigger === 'manual') {
        // 手敲的那一下是**用户的判断**，不是我们的重试：清计数、解停手，给他一次机会。
        failures = 0;
        rounds = 0;
        stopped = undefined;
      } else if (stopped !== undefined) {
        return false; // 已停手（理由早说过了）。
      }

      // 抖动判定放在**这一次 API 调用之前**：连压 3 次仍满，说明再压一次也只是烧钱。
      if (trigger === 'auto' && rounds >= MAX_STRIKES) {
        stopped = `连续压缩 ${rounds} 次之后上下文仍然超过阈值 ${deps.config.atTokens}`;
        deps.warn(
          `${stopped}，已停手：再压也只是反复烧钱。\n` +
            '可以把设置里的 compact.atTokens 调大、把 compact.auto 关掉，或用 /clear 换个新话题。',
        );
        return false;
      }

      const tokensBefore = last?.inputTokens ?? estimateTokens(messageChars(deps.messages));
      const cut = splitAt(deps.messages, deps.config.keepTurns);
      if (cut === undefined) {
        deps.warn('没有可压缩的历史：上下文里还没有超过保留轮数的旧消息。');
        return false;
      }

      const head = deps.messages.slice(0, cut);
      const tail = deps.messages.slice(cut);

      let text: string;
      try {
        text = (await summarize(deps, head, instructions)).trim();
      } catch (error) {
        return fail(
          `压缩没做成，上下文一条没动：摘要调用失败（${error instanceof Error ? error.message : String(error)}）。`,
        );
      }
      if (text === '') {
        return fail('压缩没做成，上下文一条没动：摘要那一轮没有返回任何文本。');
      }

      const summary: Message = {
        role: 'user',
        content: `以下是更早的 ${head.length} 条消息的摘要（原文已从上下文里移除）：\n\n${text}`,
      };
      const next: Message[] = [summary, ...tail];

      // 压缩之后**反而更长**：摘要比原文还长，短会话上真会发生。
      // 漏了这一条就是把上下文越"压"越大 —— 设计里点名"这一条最容易漏"。
      if (messageChars(next) >= messageChars(deps.messages)) {
        return fail('压缩没做成，上下文一条没动：摘要没有比原文短。');
      }

      // 通知派在**改之前**：`tokensBefore` 这个名字只有在改之前派才说得通。
      await deps.dispatch('session.compact', { trigger, tokensBefore }, CORE_ORIGIN);

      // 就地改：REPL 与 `/clear` 手里是**同一个数组引用**，换一个新的等于没改（见 cli/commands.ts）。
      deps.messages.length = 0;
      deps.messages.push(...next);
      // ⚠️ 数组变短了，落盘游标必须跟着重置 —— 漏了这一句会**静默损坏**转录（设计 §3.5）。
      deps.persist.reseed(deps.messages.length);

      // 这一轮成了：失败计数归零，抖动计数 +1（下一轮还满就说明压得不够狠）。
      failures = 0;
      rounds += 1;
      warned = false;
      deps.warn(
        `已压缩：${head.length} 条旧消息压成 1 条摘要，保留了最近 ${deps.config.keepTurns} 轮的原文。`,
      );
      return true;
    },
  };

  return compactor;
}

/**
 * 摘要那一轮是**旁路**调用：不走 `runTurn`（它会往 `messages` 里追加，而我们要的只是
 * 一次读），而且 `tools: []` —— 摘要那一轮绝不能让模型去调工具。
 *
 * `instructions` 是用户 `/compact <说明>` 给的那段额外要求（P7 §3.3）。**没有它就逐字节
 * 等于 P7 之前的那一份提示** —— 这一条由 `test/compact.test.ts` 钉着，防的是"顺手把摘要
 * 提示词也改了"（改提示词是另一件事，该单独讨论，不该混在一个参数里溜进来）。
 */
async function summarize(
  deps: CompactorDeps,
  head: readonly Message[],
  instructions?: string,
): Promise<string> {
  const extra = instructions?.trim() ?? '';
  const ask =
    extra === '' ? SUMMARIZE_PROMPT : `${SUMMARIZE_PROMPT}\n\n用户额外要求（优先满足）：\n${extra}`;

  let text = '';
  for await (const event of deps.provider.stream({
    system: '你负责把一段编码会话的上下文压缩成一份能接手用的摘要。',
    messages: [...head, { role: 'user', content: ask }],
    tools: [],
    signal: deps.signal(),
  })) {
    if (event.type === 'text') text += event.text;
  }
  return text;
}
