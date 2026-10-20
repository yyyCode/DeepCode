import type { EngineInterface } from './engine';
import type { Next } from './next';
import type { Tier } from './tier';
import type { TurnReason } from './turn';

// ─────────────────────────────────────────────────────────────
// 第一族：已实现链的事件（P4d 之后 22 个）
// ─────────────────────────────────────────────────────────────

export type EventArgs = {
  'engine.create': { readonly plugins: readonly string[] };
  'plugin.register': {
    readonly name: string;
    readonly tier: Tier;
    readonly uses: readonly string[];
  };
  'session.start': { readonly sessionId: string; readonly cwd: string; readonly root: string };
  'session.end': { readonly reason: 'exit' | 'interrupt' | 'error' };
  'prompt.submit': { readonly text: string };
  /**
   * 系统提示的一个**节**。P4d 从声明-only 转正。
   *
   * 每个 hook 的形状是 `const inner = await next(e); return {sections: [...inner.sections, mine]}`，
   * 于是**内层在前**；而同一 tier 内"先注册的在外层"，所以同一 tier 内的节序是注册顺序的**倒序**。
   * 跨 tier 则按 tier 序。今天只有一个贡献者（`builtins/instructions.ts`），这条规则写下来是给下一个看的。
   */
  'prompt.section': Record<string, never>;
  'turn.start': { readonly index: number };
  'turn.step': { readonly delta: string };
  /**
   * 模型不再要工具、本 turn 准备收手的那一刻。P4d 新增，是 classic `Stop` 的着陆点。
   *
   * ⚠️ **缝，不是闸**：链尾无人应答 = 照常收手。返回非空 `block` = 不让收手，
   * 那段文本作为**一条新的 user 消息**推进去，本 turn 接着转。
   *
   * `lastMessage` 是模型这一轮说过的最后一段文本（可能为空串）。没有它，"不让收手"
   * 就没有触发条件 —— 一条 Stop 规则只能无条件地拦，那是绊脚石不是规则。
   */
  'turn.stop': { readonly stopHookActive: boolean; readonly lastMessage: string };
  'turn.complete': {
    /**
     * **产品语义**的收场理由，七选一（定义与"两层停止原因"的理由见 `contract/turn.ts`）。
     *
     * ⚠️ P8 之前这里是 `string`，端点的步级串直接透传上来 —— 后果是消费方只能靠黑名单
     * 猜"这一轮算不算做完了"，而 `max_tokens` 正好不在任何人的黑名单里。
     */
    readonly stopReason: TurnReason;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /**
     * `true` = 上面两个数是**字符 ÷ 4 估的**，不是端点报的。
     * 省略 = 端点报的真数。（`outputTokens: 0` 配上这个标记是常态：估得出输入，估不出输出。）
     */
    readonly usageEstimated?: boolean;
  };
  'tool.call': { readonly tool: string; readonly input: unknown; readonly toolUseId: string };
  /**
   * 工具调用的准入检查。**P3 加了一个字段**：`toolUseId`。
   *
   * classic 钩子的 stdin 里有 `tool_use_id`，而 loop 手里本来就有 `use.id` ——
   * 多传一个字段比"桥接层自己去猜 / 去额外配一次对"便宜得多。
   * 这是**契约变宽**，不是新事件：声明的条数与实现的条数都不变。
   */
  'tool.check': { readonly tool: string; readonly input: unknown; readonly toolUseId: string };
  /**
   * 人在确认提示上答了 `y`（放行这一次）或 `a`（放行**本次会话的这一类**）。
   *
   * **纯通知，而且只报"同意"**：内核只是把"人说了什么"原样报出来 —— 它不认识规则，
   * 也一行安全逻辑都没有（README「安全」一节的「引擎零安全逻辑」）。把这句话翻成一条
   * 规则、记住、并在下次判定里用上，是规则层（`builtins/permissions`）的事。
   * 拒绝**不走这条**：那一次调用根本没跑，报告它属于 `tool.result` 那种假账
   * （见下面 `tool.result` 那句"只在工具真的跑了之后派"）。
   *
   * 为什么要有这个事件、而不是让规则层自己去接内核对人的提问：**顺序**。
   * 只有当整条 `tool.check` 链（含 `sec-default` 的托管策略、classic 钩子）都把判定
   * 落定之后，"要不要问人"才是确定的 —— 复刻对象把这条写得很清楚：`tool.check`
   * "fires … **before the mode settles an ask**"。让链上某一层自己弹问题，托管策略
   * 判死的调用会先问一遍人、再告诉他不算 —— 问了一个不该问的问题。
   */
  'tool.consent': {
    readonly tool: string;
    readonly input: unknown;
    readonly toolUseId: string;
    /** `once` = 只放行这一次；`always` = 本次会话这一类都放行（进程内，不落盘）。 */
    readonly granted: 'once' | 'always';
  };
  /**
   * 一次工具调用**跑完之后**。P4d 新增，是 classic `PostToolUse` 的着陆点。
   *
   * ⚠️ **这是缝，不是闸**：链尾无人应答 = 什么都不加（默认实现在 coreImpls 里）。
   * 它唯一的用处是钩子能往对话里补一段 —— 在这儿 deny 表达不出来（工具已经跑完了），
   * 所以别把它"统一"成 `tool.check` 那条 fail-closed 的形状。
   *
   * 只在工具**真的跑了**之后派：白名单外、权限 deny、用户拒了 `ask`、`tool.call` 返回 deny
   * —— 这四种情况下工具没执行过，给它们派一个"工具结果"事件是假账。
   */
  'tool.result': {
    readonly tool: string;
    readonly input: unknown;
    readonly toolUseId: string;
    /** `false` = 工具自己报了错（沿用 `content.startsWith('ERROR:')` 这条既有约定）。 */
    readonly ok: boolean;
    /** 模型将看到的那段正文（并进 context **之前**的原样）。 */
    readonly output: string;
  };
  'tool.describe': { readonly tool: string };
  'command.run': { readonly name: string; readonly args: readonly string[] };
  /**
   * 一条命令描述自己。**与 `tool.describe` 同形**，补上 `command.run` 缺的那一半
   * （`tool.call` 有 `tool.describe` 作伴，`command.run` 一直没有）。
   *
   * 消费方是 `/help`（调用点见 `packages/cli/src/commands.ts`）。⚠️ 它住在 `cli/` 而不是
   * `builtins/` 里 —— 插件拿不到 `dispatch`（`$` 是名词的集合，见 contract/engine.ts:59-64），
   * 所以够不着这个事件的插件得由 CLI 把 dispatcher 注入进去。这是本片对设计 §0.9 的
   * 一处偏差，理由与代价记在那份设计的 §9。
   */
  'command.describe': { readonly name: string };
  /** 摊开当前**生效**的连接配置（`/config` 与 `deepcode config list` 的底座）。 */
  'config.describe': Record<string, never>;
  'config.set': { readonly key: string; readonly value: string };

  // ── P4a 转正的三个（原先在 UnimplementedEvent 那族里）──

  /**
   * 把"这个会话能派什么、能加载什么"报给拼 system prompt 的那一处。
   *
   * 名字偏窄：它顺带报了技能清单。消费者是**同一个**，拆成 `skill.offer` 就是
   * 多一个第 40 个事件、多派一次、拼两份 —— 而事件目录是这个架构里最不该随手
   * 加东西的地方（见本文件顶部那段）。记为已知偏差。
   */
  'agent.offer': Record<string, never>;
  /**
   * 即将启动一个子代理。**纯通知**，不带改写能力。
   *
   * `depth` 是 P10 加的（契约变宽）：这是第几层，1 = 会话直接派的。
   * 它由内核给出 —— 深度上限现在是内核的事，走哪条路径都是同一个数，
   * 而"所有路径共用同一个数"这句话需要一个可观测的出口，否则只能读代码去验（P10 设计 §3.5）。
   */
  'agent.spawn': {
    readonly name: string;
    readonly task: string;
    readonly model?: string;
    readonly depth: number;
  };
  /**
   * 技能正文展开成文本的那一刻。
   *
   * ⚠️ **这是缝，不是闸**：链尾无人应答 = **原文通过**（默认实现在 coreImpls 里）。
   * 别把它"统一"成 fail-closed —— 在缝上 deny 会让一个没被任何插件碰过的技能
   * 彻底不可用。详细理由见设计 §10.3。
   */
  'skill.prompt': { readonly name: string; readonly text: string };

  // ── P4b 转正的一个 ──

  /**
   * 发生过一次上下文压缩。**纯通知**，与 `session.start` 同一族 —— 结果类型是空对象。
   *
   * 它**不返回压缩后的 messages**：压缩是 CLI 自己的事，把结果做成可变的东西会让它变成一个
   * **权威**事件，而权威事件是要 fail-closed 的 —— 那正好与"摘要失败就干脆不压、宁可上下文
   * 继续涨"的方向相反（设计 §3.4/§3.6）。
   *
   * 派发时机是**压缩之前**：`tokensBefore` 这个名字只有在改之前派才说得通，
   * 而 `PreCompact` 该看到的本来就该是压缩前的状态。
   */
  'session.compact': { readonly trigger: 'manual' | 'auto'; readonly tokensBefore: number };
};

export type EventResult = {
  'engine.create': Partial<EngineInterface>;
  'plugin.register': { readonly allow: true } | { readonly refuse: string };
  'session.start': Record<string, never>;
  'session.end': Record<string, never>;
  /**
   * `context` 是 P4d 加的：钩子能在这一行进模型**之前**补一段。
   * 它是**契约变宽**，不是新事件 —— 与 P3 给 `tool.check` 加 `toolUseId` 同形。
   *
   * `handled` 在一次性模式（`deepcode "..."`）里没有意义（那里没有可以"继续"的交互循环），
   * CLI 只采纳 `context` —— 见设计 §8 偏差 9。
   */
  'prompt.submit': { readonly handled?: boolean; readonly context?: string };
  /**
   * 各个贡献者报上来的节。链尾兜底是**空清单** —— 能力方向的 fail-closed：
   * 没有就是没有，不给一段假文本（与 `agent.offer` 那条同一条）。
   */
  'prompt.section': { readonly sections: readonly PromptSection[] };
  'turn.start': Record<string, never>;
  'turn.step': Record<string, never>;
  /** 不让收手时给模型的那些话。链尾无人应答 = 照常收手（缝）。 */
  'turn.stop': { readonly block?: string };
  'turn.complete': Record<string, never>;
  'tool.call': { readonly value: unknown } | { readonly deny: string };
  'tool.check': { readonly decision: 'allow' | 'ask' | 'deny'; readonly rule?: string };
  /** 纯通知：内核不等人答复（链尾兜底 `{}`，见 `NOTIFICATION_EVENTS`）。 */
  'tool.consent': Record<string, never>;
  /** 钩子想补进那条工具结果的话。链尾无人应答 = 什么都不加（缝）。 */
  'tool.result': { readonly context?: string };
  'tool.describe': { readonly description: string; readonly inputSchema: unknown } | { readonly hidden: true };
  'command.run': { readonly handled?: boolean };
  /**
   * 一条命令的自我描述。
   *
   * `hidden: true` 与 `tool.describe` 那条含义一样：**主动不出现在清单里**，
   * 而不是"没注册描述"—— 后者是故障，消费方要 warn 并退回裸名字。
   */
  'command.describe':
    | { readonly description: string; readonly usage?: string }
    | { readonly hidden: true };
  /**
   * 生效配置的清单。
   *
   * 链尾兜底是**空清单**（不是抛）：这是能力方向的 fail-closed —— 没有就是没有，
   * 不给一份看着像真的的假清单。与 `agent.offer` 那条同一条。
   */
  'config.describe': { readonly entries: readonly ConfigEntry[] };
  /**
   * 改一个配置项。与 `tool.check` 同形：**拒绝方向**的 fail-closed，
   * 链尾无人应答 = `ok: false`，不能让一条命令因为没人应答就静默成功。
   */
  'config.set':
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly error: string };
  'agent.offer': {
    // `tools` 是**我们多加的**（参考实现的 offer 只有 name + description）：
    // 白名单是承重的东西，让用户与模型都看得见比藏起来好。
    readonly agents: readonly {
      readonly name: string;
      readonly description: string;
      readonly tools?: readonly string[];
    }[];
    readonly skills: readonly { readonly name: string; readonly description: string }[];
  };
  'agent.spawn': Record<string, never>;
  'skill.prompt': { readonly text: string };
  'session.compact': Record<string, never>;
};

/**
 * 一条生效配置。
 *
 * ⚠️ **就地定义一份，不从 `packages/cli/src/config.ts` import** —— `contract/` 是叶子，
 * 一个 import 都不许有（那条边界由 `pnpm lint` 强制）。`cli/config.ts` 里也有一份同形的，
 * 两份不会悄悄走岔：`config-command` 那条 hook 的返回类型就是 `readonly ConfigEntry[]`，
 * `cli` 那份少一个字段会当场 typecheck 红。
 */
/** 系统提示里的一段。`name` 只给人看（调试、将来的排序），拼接不用它。 */
export type PromptSection = { readonly name: string; readonly text: string };

export type ConfigEntry = {
  readonly key: string;
  readonly value: string;
  readonly source: 'env' | 'user' | 'project' | 'default';
  readonly writable: boolean;
};

// ─────────────────────────────────────────────────────────────
// 第二族：只声明、未实现的事件
//
// core 落到它们时抛 NotImplementedError。现在就冻结，是因为事件目录
// 是这套架构里最容易返工的部分 —— 见设计文档 §3.3。
// ─────────────────────────────────────────────────────────────

/**
 * 渲染树：纯数据，不为任何 surface 选边（设计 §7.2）。
 *
 * `ui.render` 本身**仍然不实现** —— 落到它照样抛 NotImplementedError。这里只是把形状钉住，
 * 而且是**暂定**的：P3 真接上时该改就改，别为了"契约不改"将就一个想当然的数据树。
 */
export type RenderNode = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly RenderNode[];
};

/** P3 才实现的一族。形状暂定，理由见 RenderNode。 */
export type UiEventArgs = {
  'ui.render': { readonly tree: RenderNode; readonly surface?: string };
  'ui.press': { readonly key: string; readonly ctrl?: boolean };
  'ui.input': { readonly value: string };
  'ui.select': { readonly items: readonly string[]; readonly index?: number };
  'ui.message': { readonly text: string; readonly level?: 'info' | 'warn' | 'error' };
  'ui.scroll': { readonly delta: number };
  'ui.focus': { readonly target: string };
  'ui.resolve': { readonly element: string };
};

export type UiEventResult = {
  'ui.render': Record<string, never>;
  'ui.press': { readonly handled?: boolean };
  'ui.input': { readonly handled?: boolean };
  'ui.select': { readonly index?: number };
  'ui.message': Record<string, never>;
  'ui.scroll': Record<string, never>;
  'ui.focus': Record<string, never>;
  'ui.resolve': unknown;
};

export type UiEventName = keyof UiEventArgs;

/** 除 `ui.*` 之外的声明-only 事件：`ui.*` 已有精确类型，见 UiEventArgs。 */
export type UnimplementedEvent =
  | 'prompt.fill'
  | 'prompt.suggest'
  | 'prompt.edit'
  | 'prompt.context'
  | 'prompt.compose'
  | 'prompt.attachment'
  | 'attribution.text'
  | 'session.receive'
  | 'session.attach'
  | 'session.detach'
  | 'session.measure';

export type AllEventArgs = EventArgs &
  UiEventArgs & { readonly [K in UnimplementedEvent]: Record<string, unknown> };
export type AllEventResult = EventResult &
  UiEventResult & { readonly [K in UnimplementedEvent]: unknown };

export type EventName = keyof AllEventArgs;
export type Args<N extends EventName> = AllEventArgs[N];
export type Result<N extends EventName> = AllEventResult[N];

// ─────────────────────────────────────────────────────────────
// 事件与其参数的形状
// ─────────────────────────────────────────────────────────────

/**
 * 事件参数是深只读的：`e.command = 'ls'` 编译不过。
 * 改写必须拷贝后经 next 传下去：`next({ ...e, tool: 'Grep' })`。
 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** MVP 里只有 turn.step 是流式事件（其 hook 是 async generator）。 */
export const STREAMING_EVENTS = ['turn.step'] as const;
export type StreamingEventName = (typeof STREAMING_EVENTS)[number];

/**
 * 纯通知事件：它们的全部意义是"让插件看得见"，没有任何一条需要内核答复。
 * 所以"链尾没有人应答"对它们来说是正常状态，不是 NotImplementedError。
 *
 * 清单声明在这里（事件目录），默认实现在 dispatch 的链尾，两者合起来才成立。
 * 之所以不写成 createEngine 里的五条 coreImpls：那份清单漏过一次初版，
 * 又漏过一次 E2E 的测试桩，而两次的表现都是产品一开口就崩、typecheck 全绿。
 * 放在链尾意味着任何 dispatcher 都天然满足这条不变量，没有第二个地方可以漏。
 */
export const NOTIFICATION_EVENTS = [
  'session.start',
  'session.end',
  'turn.start',
  'turn.step',
  'turn.complete',
  // P4a：派子代理也是"让插件看得见"这一类 —— 没有任何一条需要内核答复，
  // 链尾 `{}` 兜底正是它该有的语义。将来的 SubagentStart 桥、telemetry 挂这里。
  'agent.spawn',
  // P4b：压缩也是"让插件看得见"这一类 —— 它没有任何一条需要内核答复。
  // 靠链尾兜底而不是在 createEngine 的 coreImpls 里补一条：见本文件上面那段注释
  // （"放在链尾意味着任何 dispatcher 都天然满足这条不变量，没有第二个地方可以漏"）。
  'session.compact',
  // 人当场批了一次 `ask`。同一条道理 —— 内核不需要任何人的答复，
  // 它只是把"人说了什么"报出来；翻成规则并记住的是规则层（`builtins/permissions`）。
  'tool.consent',
] as const;

const NOTIFICATION_SET: ReadonlySet<string> = new Set(NOTIFICATION_EVENTS);

export function isNotificationEvent(event: string): boolean {
  return NOTIFICATION_SET.has(event);
}

const STREAMING_SET: ReadonlySet<string> = new Set(STREAMING_EVENTS);

/**
 * 流式事件在一次 turn 里会被反复 dispatch（模型每吐出几段文本就来一次）。
 * 调试输出必须对它们闭嘴 —— 否则 `DEEPCODE_DEBUG=1` 会把终端刷成一片。
 * 清单同样只有这一处，别在打印的地方再抄一份。
 */
export function isStreamingEvent(event: string): boolean {
  return STREAMING_SET.has(event);
}

export type HookFor<N extends EventName> = (
  $: EngineInterface,
  e: DeepReadonly<Args<N>>,
  next: Next<Args<N>, Result<N>>,
) => Result<N> | Promise<Result<N>>;
