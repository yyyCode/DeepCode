import { CORE_ORIGIN } from '../contract/next';
import type { Message, ModelProvider } from '../contract/model-provider';
import type { DispatchFn } from '../core/dispatch';
import { estimateTokens, messageChars } from '../core/loop';
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
  /** `/compact` 与自动压缩共用的入口。返回是否真的压了。 */
  run(trigger: 'manual' | 'auto'): Promise<boolean>;
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

  const compactor: Compactor = {
    note(usage) {
      last = usage;
    },

    async afterTurn() {
      if (last === undefined) return;

      if (last.inputTokens < deps.config.atTokens) {
        warned = false;
        return;
      }
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

    async run(trigger) {
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
        text = (await summarize(deps, head)).trim();
      } catch (error) {
        deps.warn(
          `压缩没做成，上下文一条没动：摘要调用失败（${error instanceof Error ? error.message : String(error)}）。`,
        );
        return false;
      }
      if (text === '') {
        deps.warn('压缩没做成，上下文一条没动：摘要那一轮没有返回任何文本。');
        return false;
      }

      const summary: Message = {
        role: 'user',
        content: `以下是更早的 ${head.length} 条消息的摘要（原文已从上下文里移除）：\n\n${text}`,
      };
      const next: Message[] = [summary, ...tail];

      // 压缩之后**反而更长**：摘要比原文还长，短会话上真会发生。
      // 漏了这一条就是把上下文越"压"越大 —— 设计里点名"这一条最容易漏"。
      if (messageChars(next) >= messageChars(deps.messages)) {
        deps.warn('压缩没做成，上下文一条没动：摘要没有比原文短。');
        return false;
      }

      // 通知派在**改之前**：`tokensBefore` 这个名字只有在改之前派才说得通。
      await deps.dispatch('session.compact', { trigger, tokensBefore }, CORE_ORIGIN);

      // 就地改：REPL 与 `/clear` 手里是**同一个数组引用**，换一个新的等于没改（见 cli/commands.ts）。
      deps.messages.length = 0;
      deps.messages.push(...next);
      // ⚠️ 数组变短了，落盘游标必须跟着重置 —— 漏了这一句会**静默损坏**转录（设计 §3.5）。
      deps.persist.reseed(deps.messages.length);

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
 */
async function summarize(deps: CompactorDeps, head: readonly Message[]): Promise<string> {
  let text = '';
  for await (const event of deps.provider.stream({
    system: '你负责把一段编码会话的上下文压缩成一份能接手用的摘要。',
    messages: [...head, { role: 'user', content: SUMMARIZE_PROMPT }],
    tools: [],
    signal: deps.signal(),
  })) {
    if (event.type === 'text') text += event.text;
  }
  return text;
}
