// src/contract/turn.ts

/**
 * 一轮**为什么收场** —— 产品语义，闭环枚举。
 *
 * ⚠️ 它与端点的**步级** `stop_reason` 是**两层**（P8 设计 §3.1）：
 * - 步级是供应商的（`end_turn` / `max_tokens` / `refusal` / …，即 `StreamEvent` 里
 *   `done.stopReason` 那个串），只在内核决定"还发不发下一步"时用；
 * - 这一层是给产品侧看的：退出码、子代理判定、转录、将来的人。
 *
 * 混成一层已经出过一个**真 bug**：子代理那边拿端点的串做**黑名单**判断"它干完了没有"，
 * 而 `max_tokens` 不在那个名单里 —— 于是被砍掉一半的子代理把半截结论当成完整答复交回
 * 父级，父级拿着它继续干活，谁都不知道它没写完。
 *
 * 所以这里是**白名单**：只有 `NORMAL_TURN_REASONS` 里的算"做完了"。新加一种收场方式时
 * 它**默认**是"没做完"，要放行得专门去改那个列表 —— 这正是我们买的东西。
 *
 * 零 import：`events.ts` / `agent.ts` 都要引它，而两者已经互相牵得够紧了。
 */
export type TurnReason =
  /** 模型自己收手了 —— 端点的 `end_turn`、以及一切我们没建模的步级值都归这儿。 */
  | 'answer'
  /** 撞上单轮往返上限（`MAX_HOPS` / 子代理的 `maxTurns`）。 */
  | 'max_hops'
  /** 被输出长度上限截断，续写次数也用完了。 */
  | 'truncated'
  /** 重提示过一次之后，模型仍然什么都没产出。 */
  | 'empty'
  /** 模型拒答（端点报的）。 */
  | 'refusal'
  /** 这一轮失败（provider 报错）。 */
  | 'error'
  /** 用户中断（Ctrl-C）。 */
  | 'interrupted';

/**
 * 正常收场：这一轮把话说完了、把事做完了。**其余一律算"没做完"**。
 *
 * 消费方照这一条判，别自己列黑名单：子代理（`cli/subagents.ts`）与一次性模式的退出码
 * （`cli/main.ts`）都读它。
 */
export const NORMAL_TURN_REASONS: readonly TurnReason[] = ['answer'];

export function isNormalTurn(reason: string): boolean {
  return (NORMAL_TURN_REASONS as readonly string[]).includes(reason);
}
