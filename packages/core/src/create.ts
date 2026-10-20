import type { EngineInterface } from '@deepcode/contract/engine';
import type { Plugin, On } from '@deepcode/contract/plugin';
import type { Tier } from '@deepcode/contract/tier';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { Registry } from './registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from './dispatch';
import { createCoreNouns, type CoreNounsDeps } from './nouns';
import { makeThirdPartyOn } from './third-party';

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
  /**
   * 第三方插件的名字。**名单由调用方给**（生产里是 `cliPlugins` 从 `loadPlugins`
   * 的结果推出来的），不是插件自述的 —— 与座位同一条道理：插件自己说了不算。
   *
   * 列进来的插件：座位强制 `append`、`on` 走 `makeThirdPartyOn`（剥 allow / 查 uses / 拒挂 $）。
   */
  thirdParty?: readonly string[];
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
  let dispatchFn: DispatchFn | undefined;

  const coreNouns = createCoreNouns(deps, registry, {
    // 两个都延迟取：它们要到下面折叠完成之后才存在。`$` 尤其要紧 ——
    // 子代理要在**折叠后的** $ 上跑，引擎自己的 hook 那时才都挂上去了。
    engine: () => {
      if (!engine) throw new Error('$ 尚未构建完成');
      return engine;
    },
    dispatch: () => {
      if (!dispatchFn) throw new Error('dispatch 尚未构建完成');
      return dispatchFn;
    },
  });

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

    // 没人报名册就是空清单。**内核不认识任何 agent/skill 文件** ——
    // 发现是 CLI 侧的事（cli/agents.ts、cli/skills.ts），与"内核没有硬编码的工具表"同一条。
    // 链尾无人应答 = 能力方向的 fail-closed：没有就是没有，不给个假清单。
    'agent.offer': () => ({ agents: [], skills: [] }) as const,

    // ⚠️ 这条**不是** fail-closed —— 它是变换缝的默认值：没人要改，就原文通过。
    // 在这儿 deny 会让一个没被任何插件碰过的技能彻底不可用。
    // 别把它"统一"成上面那条的形状，两者问的不是同一个问题（设计 §10.3）。
    'skill.prompt': (e) => ({ text: String(e.text) }),

    // P4d 的三条，与上面那条**同一条分寸**：缝，不是闸。链尾是"没人要说话"，
    // 所以默认什么都不加。在这儿 fail-closed 的后果各不相同，但都很难看：
    // tool.result 会让每一次工具调用都变成一次"没人应答"的拒绝；
    // turn.stop 会让每一次收手都被拦下（一个自造的、永远转不完的 turn）；
    // prompt.section 会让系统提示凭空多出一段假文本。
    'tool.result': () => ({}) as const,
    'turn.stop': () => ({}) as const,
    // 这条是能力方向的 fail-closed：没有贡献者就是没有 —— 与 agent.offer 同一条。
    'prompt.section': () => ({ sections: [] }) as const,

    'tool.describe': (e) => {
      throw new Error(`no description registered for tool: ${String(e.tool)}`);
    },

    // 与上面那条同形，同一条分寸：**没注册描述是故障，不是"没描述"** ——
    // 消费方（/help）逐条兜底，缺了就退回裸名字并 warn。
    // 有意不返回 `{description: ''}`：那会让"忘了写 describe"这件事彻底静默。
    'command.describe': (e) => {
      throw new Error(`no description registered for command: ${String(e.name)}`);
    },

    // 没人应答 = 空清单。**能力方向的 fail-closed：没有就是没有，不给个假清单**
    // —— 与上面 agent.offer 那条同一条。
    'config.describe': () => ({ entries: [] }) as const,

    // 这一条反过来：**拒绝方向的** fail-closed。一条命令不能因为没人应答就静默成功 ——
    // 与 `tool.check` 链尾那条同形。（config.describe 空清单是"没什么可看"，
    // config.set 静默成功是"改了但你不知道改没改"，两者不该长成一个样子。）
    'config.set': () =>
      ({ ok: false, error: 'fail-closed: 没有 hook 应答 config.set' }) as const,
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
  dispatchFn = dispatch;

  const fold = async (): Promise<EngineInterface> =>
    (await dispatch(
      'engine.create',
      { plugins: deps.plugins.map((p) => p.name) },
      CORE_ORIGIN,
    )) as EngineInterface;

  // 折叠要折**两次**，顺序是有理由的。
  //
  // 第一次（下面这行，注册之前）：只折出内核名词，但 `$` 从此有了 —— 注册期间跑的那些
  // hook（`plugin.register` 由 plugin-guard 应答）也要拿到它。dispatch 是**无条件**
  // 取 `deps.engine()` 的（`core/dispatch.ts` 那行 `reg.hook(deps.engine(), …)`），
  // 那会儿 `$` 还没建出来的话，每一次注册都会走进"hook 失败已跳过"那条路 ——
  // 闸门静默失灵，比它不存在更坏。
  engine = await fold();

  // 第二次在注册**之后**（本函数最后一行）：这时插件的 `engine.create` hook 才在链上，
  // 它们贡献的名词才进得来。`contract/engine.ts` 那段 `declare module` 说"插件可以往
  // `$` 上加名词"，兑现的就是这一折 —— 只有一折的话那句话是假的：hook 永远不会被 dispatch。
  //
  // 两次都用同一张 registry，所以"谁的名词赢"与裁决链的顺序是同一条规则
  // （`{...await next(e), 我这份}` = 靠外的赢 = tier 更权威的赢），不需要第二套说法。

  // 准入 + 注册。座位读的是 deps.seating 这张表，不是插件自己说的。
  const thirdParty = new Set(deps.thirdParty ?? []);
  for (const plugin of deps.plugins) {
    const third = thirdParty.has(plugin.name);
    // 第三方插件的座位是**强制** append，seating 表对它无效 —— 连 CLI 都钉不动它。
    // 理由是推导出来的，不是选的（设计 §4.2）：
    //   - `prepend` / `user` 是策略层与个人规则层的座位，一个掉进目录的东西不该坐在那里；
    //   - `builtin` 及更深够不着 —— `confirm` 就在 `builtin`，它注册了一条不调 next 的
    //     `tool.check`，链到它那儿就结束了，坐在它里面等于永远不被调用。
    // 于是"够得着 + 不占别人座位"的层只剩 `append`。
    const tier: Tier = third ? 'append' : (deps.seating?.[plugin.name] ?? 'builtin');

    const verdict = await dispatch(
      'plugin.register',
      { name: plugin.name, tier, uses: plugin.uses },
      CORE_ORIGIN,
    );
    if ('refuse' in verdict) {
      coreNouns.logger.warn(`插件 ${plugin.name} 被拒绝加载：${verdict.refuse}`);
      continue;
    }

    plugin.register(
      third
        ? makeThirdPartyOn({
            registry,
            plugin: plugin.name,
            tier,
            uses: plugin.uses,
            log: (line) => coreNouns.logger.warn(line),
          })
        : makeOn(registry, plugin.name, tier),
    );
  }

  // 第二次折叠：插件的名词在这里才叠上去（见上面那段注释）。
  engine = await fold();

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
