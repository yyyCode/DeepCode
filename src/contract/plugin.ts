import type { EngineInterface } from './engine';
import type { Args, EventName, Result } from './events';
import type { Next } from './next';

/** hook 的运行时形状：`($, e, next) => Result`。 */
export type EventHook = ($: EngineInterface, e: any, next: Next<any, any>) => any;

export type EventHookFor<N extends EventName> = (
  $: EngineInterface,
  e: Args<N>,
  next: Next<Args<N>, Result<N>>,
) => Result<N> | Promise<Result<N>>;

export type On = {
  <N extends EventName>(pattern: N, hook: EventHookFor<N>): void;
  <N extends EventName>(pattern: string, matcher: Record<string, unknown>, hook: EventHookFor<N>): void;
  (pattern: string, hook: EventHook): void;
};

/**
 * 内建工具与未来的第三方插件走完全相同的接口。
 *
 * `uses` 是声明的依赖面（事件名与名词名），MVP 只记录不校验 —— P3 的准入闸门才用它。
 */
export type Plugin = {
  readonly name: string;
  readonly uses: readonly string[];
  register(on: On): void;
};
