import type { Args, EventName, Result } from '../contract/events';
import { isNotificationEvent, isStreamingEvent } from '../contract/events';
import type { EngineInterface } from '../contract/engine';
import { HOOK_BUDGET, UNBUDGETED_EVENTS, type Origin, type TraceEntry } from '../contract/next';
import { tierIndex, type TargetTier } from '../contract/tier';
import { NotImplementedError, withBudget } from './errors';
import { matchesPattern, type Registry } from './registry';

/**
 * 事件的内核实现 —— 链的最内层。没有实现的事件在这里抛 NotImplementedError。
 *
 * 通知事件（`NOTIFICATION_EVENTS`）不必列进来：链尾对它们兜底返回 `{}`。
 * 漏掉它们曾经两次让产品与测试一开口就崩，所以这条兜底写在链尾、不靠调用方自觉。
 */
export type CoreImpls = Partial<Record<EventName, (e: any) => any>>;

export type DispatcherDeps = {
  registry: Registry;
  /** 延迟取 $：$ 要到 engine.create 折叠完成之后才存在。 */
  engine: () => EngineInterface;
  coreImpls: CoreImpls;
  /**
   * debug 可选：只有真实名词（`createLoggerNoun`）提供，测试桩通常只给 warn。
   * 链语义是看不见的 —— 这正是 `DEEPCODE_DEBUG=1` 唯一的用处：
   * 把"这次调用被谁应答、又被谁跳过"打出来。
   */
  logger: { warn(line: string): void; debug?(line: string): void };
  /**
   * hook 的时间预算（毫秒）。**只为测试存在**：把 10 秒缩成几十毫秒，
   * 才验得了"超时会把这个 hook 摘掉、让下层应答"这条线。生产不传。
   */
  hookBudgetMs?: number;
  /** 工厂而非 signal 本身 —— 理由见 CoreNounsDeps.signal。每次 dispatch 现取。 */
  signal: () => AbortSignal;
};

export type DispatchFn = <N extends EventName>(
  event: N,
  args: Args<N>,
  origin: Origin,
  /** 重入保护：hook 通过 $ 发起调用时，跳过发起它的那个插件自己。 */
  skipPlugin?: string,
) => Promise<Result<N>>;

/** 事件参数深冻结：hook 不能偷偷改事实，改写必须拷贝。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export function createDispatcher(deps: DispatcherDeps): { dispatch: DispatchFn } {
  /** 同一个 (事件, 插件) 只警告一次，避免故障插件刷屏。 */
  const warned = new Set<string>();

  /** 每个 hook 的时间预算。测试可以缩小它；`UNBUDGETED_EVENTS` 里的事件没有闸。 */
  const budgetFor = (event: string): number =>
    UNBUDGETED_EVENTS.includes(event)
      ? Number.POSITIVE_INFINITY
      : (deps.hookBudgetMs ?? HOOK_BUDGET.ms);

  const dispatch: DispatchFn = async (event, args, origin, skipPlugin) => {
    const hooks = deps.registry
      .hooksFor(event, args as Record<string, unknown>)
      .filter((r) => r.plugin !== skipPlugin);

    const trace: TraceEntry[] = [];

    /**
     * 调试轨迹：一行说清这次 dispatch 走到了哪几个 hook、各自什么下场。
     * 流式事件不打（见 isStreamingEvent）—— turn.step 每段文本一次，打出来就是刷屏。
     * 没有这条线，`DEEPCODE_DEBUG` 就只是个什么都不干的开关。
     */
    const traceLine = (startedAt: number, error?: unknown): void => {
      if (!deps.logger.debug || isStreamingEvent(event)) return;
      const chain =
        trace
          .map((t) => `${t.plugin}@${t.tier}${t.outcome === 'failed' ? '(跳过)' : ''}`)
          .join(' → ') || '(没有 hook)';
      const tail =
        error === undefined ? '' : ` ✗ ${error instanceof Error ? error.message : String(error)}`;
      deps.logger.debug(`${event} [${Date.now() - startedAt}ms] ${chain}${tail}`);
    };

    async function runAt(index: number, e: unknown, caller: Origin): Promise<any> {
      if (index >= hooks.length) {
        const impl = deps.coreImpls[event];
        if (impl) return impl(e);
        // 通知事件没有人听才是常态：返回空答复，而不是把"没人应答"当成故障。
        if (isNotificationEvent(event)) return {} as const;
        throw new NotImplementedError(event);
      }

      const reg = hooks[index]!;
      const startedAt = Date.now();
      const self: Origin = { plugin: reg.plugin, tier: reg.tier };
      const next = makeNext(index, e, self, startedAt);

      try {
        const work = Promise.resolve(reg.hook(deps.engine(), deepFreeze(e), next));
        // 长跑事件不上预算。理由见 contract/next.ts 的 UNBUDGETED_EVENTS ——
        // 对 tool.call 来说，超时不是"摘掉一个坏 hook"，是"把一个正常工具判死"。
        const ms = budgetFor(event);
        const returned = Number.isFinite(ms) ? await withBudget(work, ms) : await work;
        if (returned === undefined) {
          throw new Error('hook returned undefined (什么都不返回 = 失败)');
        }
        trace.push({ plugin: reg.plugin, tier: reg.tier, outcome: 'answered' });
        return returned;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        trace.push({ plugin: reg.plugin, tier: reg.tier, outcome: 'failed', detail });

        // 故障隔离：跳过这个 hook，让下层照常运行。
        const key = `${event}#${reg.plugin}`;
        if (!warned.has(key)) {
          warned.add(key);
          deps.logger.warn(`hook ${reg.plugin} on ${event} 失败已跳过：${detail}`);
        }
        return runAt(index + 1, e, caller);
      }
    }

    function makeNext(index: number, e: unknown, self: Origin, startedAt: number) {
      const descend = (from: number, next_e: unknown) => runAt(from, next_e, self);

      const next = ((next_e: unknown) => descend(index + 1, next_e)) as any;

      /**
       * 只向下跳：跳过比目标 tier 更靠外的层。
       *
       * 目标必须**严格比调用者靠内**，否则抛。静默不跳会让一个本意想"跳过组织层"
       * 的插件以为自己跳成功了，而实际裁决仍被组织层持有 —— 行为侥幸是对的，但没人
       * 知道它错。抛出去会被故障隔离接住、跳过该 hook，是安全的方向（出口标准 1：
       * `next.to` 只能向下跳，有测试证明）。
       */
      next.to = (next_e: unknown, target: TargetTier) => {
        if (tierIndex(target) <= tierIndex(self.tier)) {
          throw new Error(
            `next.to(${target}) 只能向下跳：调用者坐在 ${self.tier}，目标不比它更靠内。`,
          );
        }
        let i = index + 1;
        while (i < hooks.length && tierIndex(hooks[i]!.tier) < tierIndex(target)) i++;
        return descend(i, next_e);
      };

      next.signal = deps.signal();
      next.event = event;
      next.origin = self;
      next.trace = trace;
      next.budget = {
        ms: budgetFor(event),
        // 不上预算的事件里它是 Infinity —— 名义值，别拿它做判断（那里本来就没有闸）。
        remainingMs: Math.max(0, budgetFor(event) - (Date.now() - startedAt)),
      };
      next.is = (pattern: string) => matchesPattern(pattern, event);
      return next;
    }

    // 成功与失败都要留痕 —— 失败那条尤其：它是"链尾没人应答"的唯一现场。
    const dispatchStartedAt = Date.now();
    try {
      const result = await runAt(0, args, origin);
      traceLine(dispatchStartedAt);
      return result;
    } catch (error) {
      traceLine(dispatchStartedAt, error);
      throw error;
    }
  };

  return { dispatch };
}
