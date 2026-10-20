import type { TargetTier, Tier } from './tier';

/** 抛出这次 dispatch 的插件。由宿主设定，插件写不了。 */
export type Origin = {
  readonly plugin: string;
  readonly tier: Tier;
};

export const CORE_ORIGIN: Origin = { plugin: 'core', tier: 'core' };

export type TraceEntry = {
  readonly plugin: string;
  readonly tier: Tier;
  readonly outcome: 'answered' | 'passed' | 'failed';
  readonly detail?: string;
};

export type HookFailure = { readonly kind: 'throw' | 'timeout'; readonly message?: string };

export type NextBudget = { readonly ms: number; readonly remainingMs: number };

/** 单个 hook 的时间预算。 */
export const HOOK_BUDGET = { ms: 10_000, catchMs: 1_000 } as const;

/**
 * 这些事件的 hook **不上时间预算**：它们的时长由被调用的东西自己说了算。
 *
 * `tool.call` 是唯一一个，而它必须在这儿，否则工具从源头就是坏的：Bash 自己的默认超时
 * 是 120 秒（builtins/tools/bash.ts:3），子代理以分钟计 —— 10 秒的预算在这儿不叫"防故障"，
 * 叫"把一个正常的慢工具变成一个假的 unknown tool"：超时之后 dispatch 把它当 hook 失败跳过，
 * 链一路落到 coreImpl 的 `unknown tool: ${tool}` 回给模型，而那个工具**还在后台继续跑**。
 *
 * 工具的时长归工具自己管（`Bash` 有 `timeout_ms`，文件操作本来就有界），
 * 预算这条线留着管那些"本该立刻回答却卡住了"的 hook。
 */
export const UNBUDGETED_EVENTS: readonly string[] = ['tool.call'];

/**
 * Koa 式续体，不是事件发射器。
 *
 * - `next(e)`           运行下层 hook，带改写下行（每次调用都会重新运行下层）
 * - `next.to(e, tier)`  跳到指定 tier，跳过中间层
 * - 不调用 next 直接 return = 结束这条链并应答
 * - 什么都不返回 = 失败（被当作 hook 出错，跳过并上报）
 */
export type Next<E, R> = {
  (e: E): Promise<R>;
  readonly to: (e: E, tier: TargetTier) => Promise<R>;
  readonly signal: AbortSignal;
  readonly event: string;
  readonly origin: Origin;
  readonly trace: readonly TraceEntry[];
  readonly budget: NextBudget;
  /** 本事件的名字是否匹配某个 pattern（支持 `*` 与 `noun.*`）。 */
  readonly is: (pattern: string) => boolean;
};
