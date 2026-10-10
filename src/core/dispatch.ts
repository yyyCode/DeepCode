import type { Args, EventName, Result } from '../contract/events';
import { isNotificationEvent } from '../contract/events';
import type { EngineInterface } from '../contract/engine';
import { HOOK_BUDGET, type Origin, type TraceEntry } from '../contract/next';
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
  logger: { warn(line: string): void };
  signal: AbortSignal;
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

  const dispatch: DispatchFn = async (event, args, origin, skipPlugin) => {
    const hooks = deps.registry
      .hooksFor(event, args as Record<string, unknown>)
      .filter((r) => r.plugin !== skipPlugin);

    const trace: TraceEntry[] = [];

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
        const returned = await withBudget(
          Promise.resolve(reg.hook(deps.engine(), deepFreeze(e), next)),
          HOOK_BUDGET.ms,
        );
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

      /** 只向下跳：跳过那些比目标 tier 更靠外的层。 */
      next.to = (next_e: unknown, target: TargetTier) => {
        let i = index + 1;
        while (i < hooks.length && tierIndex(hooks[i]!.tier) < tierIndex(target)) i++;
        return descend(i, next_e);
      };

      next.signal = deps.signal;
      next.event = event;
      next.origin = self;
      next.trace = trace;
      next.budget = {
        ms: HOOK_BUDGET.ms,
        remainingMs: Math.max(0, HOOK_BUDGET.ms - (Date.now() - startedAt)),
      };
      next.is = (pattern: string) => matchesPattern(pattern, event);
      return next;
    }

    return runAt(0, args, origin);
  };

  return { dispatch };
}
