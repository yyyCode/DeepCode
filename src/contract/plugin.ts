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
  /** 精确事件名：`pattern: N` 让 N 从字面量推断出来，hook 的 `e` 才有精确类型。 */
  <N extends EventName>(pattern: N, hook: EventHookFor<N>): void;
  /**
   * 精确事件名 + matcher。
   *
   * `pattern` 必须写 `N` 而不是 `string`：写成 `string` 时 N 在参数表里没有推断位置，
   * 会退化成整个 `EventName` 联合，`e` 随之变成 12 个事件的并集 —— 于是 `e.input`
   * 在并集上并不存在，六个内建工具全部编译不过。
   */
  <N extends EventName>(pattern: N, matcher: Record<string, unknown>, hook: EventHookFor<N>): void;
  /** 通配 / 否定模式（`tool.*`、`!x`）走这条：模式静态定不了事件，hook 退回宽类型。 */
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
