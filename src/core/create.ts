import type { EngineInterface } from '../contract/engine';
import type { Plugin, On } from '../contract/plugin';
import type { Tier } from '../contract/tier';
import { CORE_ORIGIN } from '../contract/next';
import { Registry } from './registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from './dispatch';
import { createCoreNouns, type CoreNounsDeps } from './nouns';

export type CreateEngineDeps = CoreNounsDeps & {
  plugins: readonly Plugin[];
  /**
   * 插件名 → tier。没列到的一律 `builtin`。
   *
   * 座位由**调用方**钉（生产里是 `cliPlugins` 返回的那张表），不做成 `Plugin.tier`：
   * 让插件自述自己的权威，正是这套 tier 机制要防的东西 —— 架构文档的说法是判定读
   * "CLI 钉在模块上的 tier，而不是模块自述的任何东西"。默认 `builtin` 让既有测试
   * 一行都不用改。
   */
  seating?: Readonly<Record<string, Tier>>;
  /** 覆盖 CoreNounsDeps 里同名的工厂，类型一致。 */
  signal: () => AbortSignal;
};

export type BuiltEngine = {
  $: EngineInterface;
  registry: Registry;
  dispatch: DispatchFn;
};

export async function createEngine(deps: CreateEngineDeps): Promise<BuiltEngine> {
  const registry = new Registry();
  let engine: EngineInterface | undefined;

  const coreNouns = createCoreNouns(deps, registry);

  const coreImpls: CoreImpls = {
    // 折叠的最内层：内核名词。插件的 engine.create hook 会在这个结果之上叠加。
    'engine.create': () => coreNouns,

    // 准入闸门。MVP 全部放行 —— 但路径已经存在，P3 只需要换掉这个函数的实现。
    'plugin.register': () => ({ allow: true }) as const,

    // 没有工具应答 = 不知道这个工具，拒绝。
    'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),

    // fail-closed：走到链尾无人应答就是拒绝，不是放行。
    // 这是 MVP 里唯一一条 fail-closed，也是 P2 全部安全性质的种子。
    'tool.check': () => ({ decision: 'deny', rule: 'fail-closed: 没有 hook 应答 tool.check' }) as const,

    'command.run': (e) => ({ handled: false, name: String(e.name) }),

    // prompt.submit 在 MVP 里是个真实存在但什么都不做的钩子点：
    // core 说"我没处理"，于是 REPL 照常把这一行送进 loop。
    // P1 的斜杠命令展开 / prompt.fill / 附件都会挂到这里，届时改的是插件不是内核。
    'prompt.submit': () => ({ handled: false }) as const,

    // 生命周期通知事件（session.*、turn.*）不在这里 —— 它们的兜底实现在
    // dispatch 的链尾，理由见 events.ts 的 NOTIFICATION_EVENTS。

    'tool.describe': (e) => {
      throw new Error(`no description registered for tool: ${String(e.tool)}`);
    },
  };

  const { dispatch } = createDispatcher({
    registry,
    engine: () => {
      if (!engine) throw new Error('$ 尚未构建完成');
      return engine;
    },
    coreImpls,
    logger: coreNouns.logger,
    signal: deps.signal,
  });

  // 折叠：core 在最内层，插件按列表顺序、最外层在前。
  const folded = (await dispatch(
    'engine.create',
    { plugins: deps.plugins.map((p) => p.name) },
    CORE_ORIGIN,
  )) as EngineInterface;
  engine = folded;

  // 准入 + 注册。座位读的是 deps.seating 这张表，不是插件自己说的。
  for (const plugin of deps.plugins) {
    const tier: Tier = deps.seating?.[plugin.name] ?? 'builtin';
    const verdict = await dispatch(
      'plugin.register',
      { name: plugin.name, tier, uses: plugin.uses },
      CORE_ORIGIN,
    );
    if ('refuse' in verdict) {
      coreNouns.logger.warn(`插件 ${plugin.name} 被拒绝加载：${verdict.refuse}`);
      continue;
    }
    plugin.register(makeOn(registry, plugin.name, tier));
  }

  return { $: engine, registry, dispatch };
}

/** 给插件一个绑定了它自己身份与座位的 on。 */
function makeOn(registry: Registry, plugin: string, tier: Tier): On {
  const on = ((pattern: string, second: unknown, third?: unknown) => {
    const hook = (third ?? second) as any;
    const matcher = third ? (second as Record<string, unknown>) : undefined;
    registry.register({ plugin, tier, pattern, matcher, hook });
  }) as On;
  return on;
}
