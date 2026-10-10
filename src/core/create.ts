import type { EngineInterface } from '../contract/engine';
import type { Plugin, On } from '../contract/plugin';
import { CORE_ORIGIN } from '../contract/next';
import { Registry } from './registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from './dispatch';
import { createCoreNouns, type CoreNounsDeps } from './nouns';

export type CreateEngineDeps = CoreNounsDeps & {
  plugins: readonly Plugin[];
  signal: AbortSignal;
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

    // 生命周期通知事件：内核"无话可说"才是正常状态 —— 它们存在是为了让插件
    // 能观察（P1 的状态栏、遥测、自动保存都会挂上来）。
    //
    // 这几条 no-op 不是可有可无的装饰。dispatch 在没有 hook、也没有内核实现时
    // 会抛 NotImplementedError，而 loop 的第一行就是 turn.start、CLI 的第一行
    // 就是 session.start：少了它们，产品和启动即崩之间只隔一次 dispatch。
    // 它们同时也是 NotImplementedError 只用来指那 27 个真未实现事件的保证。
    'session.start': () => ({}) as const,
    'session.end': () => ({}) as const,
    'turn.start': () => ({}) as const,
    'turn.step': () => ({}) as const,
    'turn.complete': () => ({}) as const,

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

  // 准入 + 注册
  for (const plugin of deps.plugins) {
    const verdict = await dispatch(
      'plugin.register',
      { name: plugin.name, tier: 'builtin', uses: plugin.uses },
      CORE_ORIGIN,
    );
    if ('refuse' in verdict) {
      coreNouns.logger.warn(`插件 ${plugin.name} 被拒绝加载：${verdict.refuse}`);
      continue;
    }
    plugin.register(makeOn(registry, plugin.name, 'builtin'));
  }

  return { $: engine, registry, dispatch };
}

/** 给插件一个绑定了它自己身份与座位的 on。 */
function makeOn(registry: Registry, plugin: string, tier: 'builtin' | 'user'): On {
  const on = ((pattern: string, second: unknown, third?: unknown) => {
    const hook = (third ?? second) as any;
    const matcher = third ? (second as Record<string, unknown>) : undefined;
    registry.register({ plugin, tier, pattern, matcher, hook });
  }) as On;
  return on;
}
