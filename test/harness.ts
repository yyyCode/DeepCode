import { EventEmitter } from 'node:events';
import type { Interface } from 'node:readline';
import { Registry } from '@deepcode/core/registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from '@deepcode/core/dispatch';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { EventHook, On, Plugin } from '@deepcode/contract/plugin';
import type { Tier } from '@deepcode/contract/tier';
import type { ModDeps } from '@deepcode/contract/mod';
import { DEFAULT_TELEMETRY } from '@deepcode/contract/telemetry';
import { builtinMods, loadMods } from '@deepcode/cli/mods';
import type { PaneModel } from '../mods/diff/pane';
import type { StreamEvent, StreamRequest } from '@deepcode/contract/model-provider';
import type { ModelProvider } from '@deepcode/contract/engine';

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

/**
 * 假的 readline：行**由测试自己推**（`pushLine`），而不是从一块真的 stdin 上来。
 *
 * 只实现 REPL（经 `cli/input.ts` 的行队列）与确认提示用得着的那几个方法。
 * 真的 `createInterface` 要一块 stdin 管道，那会把"验 REPL 的语义"变成"验终端"——
 * 而终端那部分已经由 `createPromptSink` 自己那几条测试管着。
 *
 * ⚠️ 先 `pushLine` 再起 `startRepl` 是**故意的**：真正的管道就是这个形状
 * （输入在 REPL 开始读之前就到了），而那段空窗正是 P6d 修掉的那个洞。
 */
export function fakeReadline(): {
  readonly rl: Interface;
  /** 模拟管道上来了一行。 */
  pushLine(line: string): void;
  /** 模拟 Ctrl-D / 流关掉。 */
  pushEof(): void;
  /** 依次画过的提示符（`\u001b` 之外的字面串）。 */
  readonly prompts: string[];
} {
  const prompts: string[] = [];
  let current = '';

  class FakeInterface extends EventEmitter {
    setPrompt(prompt: string): void {
      current = prompt;
    }
    getPrompt(): string {
      return current;
    }
    prompt(): void {
      prompts.push(current);
    }
    close(): void {
      this.emit('close');
    }
    question(_query: string, callback: (answer: string) => void): void {
      stdio.push(callback);
    }
  }

  /** `question` 的挂起回调。测试要答确认提示时从这儿取。 */
  const stdio: ((answer: string) => void)[] = [];
  const rl = new FakeInterface() as unknown as Interface;

  return {
    rl,
    prompts,
    pushLine: (line) => {
      // 与 readline 一样：有 `question` 挂着时那一行归它，否则发 `line` 事件。
      const waiting = stdio.shift();
      if (waiting !== undefined) waiting(line);
      else rl.emit('line', line);
    },
    pushEof: () => {
      rl.emit('close');
    },
  };
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
