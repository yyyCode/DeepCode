import { Registry } from '../src/core/registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from '../src/core/dispatch';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';
import type { Tier } from '../src/contract/tier';
import type { StreamEvent } from '../src/contract/model-provider';
import type { ModelProvider } from '../src/contract/engine';

export type HarnessOptions = {
  coreImpls?: CoreImpls;
  engine?: Partial<EngineInterface>;
  signal?: AbortSignal;
};

const NOOP_ENGINE = {} as EngineInterface;
/** 每次调用都新建的话 next.signal 每次都是不同的对象，钉不住也说不通。 */
const DEFAULT_SIGNAL = new AbortController().signal;

export function createHarness(options: HarnessOptions = {}) {
  const registry = new Registry();
  const warnings: string[] = [];
  /** 调试轨迹（`DEEPCODE_DEBUG` 那条线）。桩里一直开着，断言全靠它。 */
  const debugLines: string[] = [];

  const dispatcher = createDispatcher({
    registry,
    engine: () => (options.engine ?? NOOP_ENGINE) as EngineInterface,
    coreImpls: options.coreImpls ?? {},
    logger: { warn: (line) => warnings.push(line), debug: (line) => debugLines.push(line) },
    signal: () => options.signal ?? DEFAULT_SIGNAL,
  });

  function on(tier: Tier, plugin: string, pattern: string, hook: EventHook): void;
  function on(
    tier: Tier,
    plugin: string,
    pattern: string,
    matcher: Record<string, unknown>,
    hook: EventHook,
  ): void;
  function on(
    tier: Tier,
    plugin: string,
    pattern: string,
    third: Record<string, unknown> | EventHook,
    fourth?: EventHook,
  ): void {
    const hook = (fourth ?? third) as EventHook;
    const matcher = fourth ? (third as Record<string, unknown>) : undefined;
    registry.register({ plugin, tier, pattern, matcher, hook });
  }

  return { on, dispatch: dispatcher.dispatch, registry, warnings, debugLines };
}

/** 脚本化的模型响应：E2E 用它驱动 loop，不花 token、可确定性重放。 */
export function scriptedProvider(script: readonly (readonly StreamEvent[])[]): ModelProvider {
  let turn = 0;
  return {
    name: 'scripted',
    async *stream() {
      const events = script[turn++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };
}
