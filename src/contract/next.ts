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
