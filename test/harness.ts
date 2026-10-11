import { Registry } from '../src/core/registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from '../src/core/dispatch';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook, On, Plugin } from '../src/contract/plugin';
import type { Tier } from '../src/contract/tier';
import type { ModDeps } from '../src/contract/mod';
import { DEFAULT_TELEMETRY } from '../src/contract/telemetry';
import { builtinMods, loadMods } from '../src/cli/mods';
import type { PaneModel } from '../mods/diff/pane';
import type { StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { ModelProvider } from '../src/contract/engine';

export type HarnessOptions = {
  coreImpls?: CoreImpls;
  engine?: Partial<EngineInterface>;
  signal?: AbortSignal;
  /** 缩小 hook 时间预算，供 test/hook-budget.test.ts 用。 */
  hookBudgetMs?: number;
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
    ...(options.hookBudgetMs === undefined ? {} : { hookBudgetMs: options.hookBudgetMs }),
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

/**
 * 把一个插件按指定 tier 装进 harness。
 *
 * harness 的 `on` 要求 tier 显式给（这是它能测任意座位的前提），而插件拿到的是
 *「绑好身份」的 on —— 这里做一次适配。座位仍由调用方钉，与生产里 `cliPlugins`
 * 返回的那张 seating 表同一个道理：插件自己说了不算。
 */
export function seat(h: ReturnType<typeof createHarness>, plugin: Plugin, tier: Tier): void {
  const on = ((pattern: string, second: unknown, third?: unknown) => {
    const hook = (third ?? second) as EventHook;
    const matcher = third !== undefined ? (second as Record<string, unknown>) : undefined;
    if (matcher !== undefined) h.on(tier, plugin.name, pattern, matcher, hook);
    else h.on(tier, plugin.name, pattern, hook);
  }) as On;
  plugin.register(on);
}

/**
 * 会记下每次请求里模型看到的工具清单、以及这一趟用的 model 的 provider。
 *
 *「按权限过滤工具可见性」与"模型分层"都只能从这里验 —— 两者都是**模型眼里的东西**，
 * 别处看不见。同一个 provider 的两本账，不额外再造一个。
 */
export function recordingProvider(): {
  provider: ModelProvider;
  lastTools(): string[];
  lastModel(): string | undefined;
} {
  let tools: string[] = [];
  let model: string | undefined;
  return {
    lastTools: () => tools,
    lastModel: () => model,
    provider: {
      name: 'recording',
      async *stream(req: StreamRequest) {
        tools = req.tools.map((t) => t.name);
        model = req.model;
        yield { type: 'done', stopReason: 'end_turn' } as const;
      },
    },
  };
}

/**
 * 真装上内建 mod —— 测试里要与 `main.ts` 走同一条装配路径时用它。
 *
 * P5a 之后 `cliPlugins` 的 `mods` 是必填的，而"用空数组糊过去"会让一条本该钉住
 * "内建 mod 真的在清单里"的测试变成摆设。所以给它一个真装的入口。
 */
export async function modPlugins(over: Partial<ModDeps> = {}): Promise<readonly Plugin[]> {
  const deps: ModDeps = {
    root: process.cwd(),
    home: '/home/u',
    sessionId: 's1',
    warn: () => {},
    telemetry: DEFAULT_TELEMETRY,
    policyRules: [],
    // 默认没有托管下发 —— 要测那一条的用 `over` 传（P5b）。
    managedInstructions: [],
    ...over,
  };
  return (await loadMods(deps, deterministicMods())).plugins;
}

/** 测试里的渲染器：不许色，逐行拼。理由见 `deterministicMods`。 */
const testRenderer = (model: PaneModel): readonly string[] => [
  `── ${model.headline} · ${model.backend} ──  ${model.files} 个文件`,
];

/**
 * 真清单，**但把 `diff` 的探针钉成永远为真**。
 *
 * ⚠️ 这不是图省事，是不让测试结果取决于**跑测试的那台机器有没有 git**：
 * 一个在开发机上绿、在干净的 CI 容器里红（或反过来）的测试，比没有这个测试更坏 ——
 * 它会训练人忽略红色。真探针的行为由 `mods/diff/test/backend.test.ts` 注入假的 `run`
 * 去测，那里才问得准。
 */
export function deterministicMods(): ReturnType<typeof builtinMods> {
  return builtinMods(testRenderer).map((mod) =>
    mod.name === 'diff'
      ? { ...mod, optionalDeps: [{ name: 'git', probe: () => true }] }
      : mod,
  );
}
