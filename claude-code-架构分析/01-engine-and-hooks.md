# Claude Code 引擎内核与 Hook / 事件扩展模型

> 本文是一组「复刻一个类似产品」架构文档中的**奠基篇**。目标是把 Claude Code 引擎的**内核职责**、
> **事件目录**、**中间件式 `next(e)` 组合模型**、**tier 座位（seating）规则**、
> **「名词（noun）」依赖注入模型**以及**一个 mod / plugin 的注册与拆卸**讲清楚。
>
> **证据边界**：本仓库 `anthropics/claude-code` **不是引擎源码**。它发布的是引擎的**公开契约**
> （`mods/types/claude-code.d.ts`，13,186 行 / ~507 KB，由 `/plugin-types` 依据 Claude Code `2.1.277`
> 生成）、4 个内置 mod 的源码、15 个官方 plugin、示例与工作流。因此本文所有结论都来自**类型声明与
> JSDoc**、以及这些 mod 的**真实注册代码**；凡无法从源码核实的，统一列入「存疑与待确认」。

---

## 定位

- 目标读者：要**从零复刻**一套「CLI 形 agent 工具 + 可插拔 hook 系统」的工程师。
- 本文聚焦**引擎内核**与**它对外的扩展面**：
  - 引擎在运行期构建出的全局接口对象 `$`（类型为 `EngineInterface`）；
  - 引擎在自己每个**调用点（call site）**上抛出的事件（event）；
  - 由多个 plugin 的 hook 组成、按 **tier** 排列的一条**中间件链**；
  - 一个 plugin 的 hook 如何**改写 / 拒绝 / 直接应答 / 委托下层**；
  - 一个 plugin 如何**向 `$` 增加自己的「名词」**（依赖注入），以及如何被**准入 / 重载 / 卸载**。
- 契约的规范性描述见 `mods/types/claude-code.d.ts:1-91`（文件头注释即「引擎为你提供了什么」的清单）。
  它由 `claude plugin validate <dir>` 与 `/plugin-types` 两个命令共同支撑：前者按引擎读取方式静态校验
  plugin，后者写出类型声明。

---

## 职责与边界

### 引擎（core）负责什么

1. **构建 `$`**：在加载期通过一次 `engine.create` 折叠（fold）把「内核接口 + 各 plugin 名词」组装成
   `EngineInterface`（`mods/types/claude-code.d.ts:3204-3233`、`3674`、`3685`）。
2. **抛出事件**：引擎在工具调用、模型轮次、UI 绘制、提示词组装、会话生命周期等调用点，
   以一次 `$` 调用（`$.<noun>.<event>(input)`）**抛出**对应事件（`mods/types/claude-code.d.ts:3856-3917`）。
3. **运行 hook 链**：把同一事件的各 plugin hook（按 tier 由外到内）串成一条 middleware 链，
   内核作为**最内层（innermost）的一环**（`mods/types/claude-code.d.ts:9726-9743`）。
4. **隔离故障**：某个 hook 抛错 / 超预算 / 返回形状错误时，**跳过该 hook**，让下层与内核照常运行，
   并按名字上报该失败（`mods/types/claude-code.d.ts:3238-3242`）。
5. **渲染 UI**：跨 `terminal` / `desktop` / `mobile` / `vscode` 多 surface 绘制；渲染以**自定义 JSX
   runtime** 完成（`mods/tsconfig.json:12-14`）。
6. **权限与模型循环**：`tool.check` 决策、`turn.*` 模型轮次、子 agent（subagent/teammate）循环。

### 不属于引擎 / 不在本仓库

- **引擎实现本身**：本仓库没有引擎的 `.ts` 源码，只有契约（`.d.ts`）与内置 mod 源码。
- `mods/`：4 个内置 mod（`diff`、`telemetry`、`agents-md`、`sec-default`）的**源码**，
  以「function hooks」形式编写，构建进二进制（`mods/README.md:1-6`）。
- `plugins/`：15 个官方 plugin，多为**传统「classic hooks」**（`hooks.json` 里配置 shell 命令），
  外加 commands / agents / skills。
- `examples/`、`scripts/`、`.github/`：示例、脚本与 CI。本文不展开。

> 关键区分：`mods/*/hooks/hooks.json` 用的是 **function hooks 清单**（`{"modules": ["./register.ts"]}`），
> `plugins/*/hooks/hooks.json` 用的是**传统命令 hook 清单**（`{"hooks": {"PostToolUse": [...]}}`）。
> 二者同名不同义，复刻时不要混淆。见 `mods/diff/hooks/hooks.json:1-4` 与
> `plugins/security-guidance/hooks/hooks.json:1-71`。

---

## 关键抽象与接口

### 1. `$`：`EngineInterface`（引擎接口对象）

```ts
export interface EngineInterface extends CoreEngineInterface {}
// mods/types/claude-code.d.ts:3674
```

- 形状是**扁平的 `<noun>.<event>`**（如 `$.telemetry.log(...)`、`$.tool.call(...)`），
  **不携带 `on`**——因为注册发生在 `$` 存在之前（`mods/types/claude-code.d.ts:3663-3669`）。
- 它是 `interface`，刻意支持**声明合并（declaration merging）**，让 plugin 以「就像 jQuery 插件给
  `$.fn` 加类型」的方式声明自己的名词（同上）。
- `CoreEngineInterface`（`mods/types/claude-code.d.ts:2016`）的内核顶层名词（namespace）为：

  | 名词 | 作用（摘要） |
  | --- | --- |
  | `plugin` | 本 plugin 的 `name` / `root` |
  | `ui` | notice / invalidate / blit / resolve / log / ask / toast / status / open / close … |
  | `model` | complete / classify / fork（模型调用） |
  | `audio` | play / speak |
  | `mcp` | call |
  | `session` | start / receive / compact / attach / detach / measure / end / cwd / root / id / model / messages / repo / turns / usage / version / surfaces / authorize |
  | `turn` | start / step（流式）/ complete / abort |
  | `prompt` | submit / fill / suggest / edit / section / context / compose / attachment / read |
  | `tool` | call / check / describe / register / list |
  | `command` | run / describe / register / list |
  | `config` | set / describe / list |
  | `agent` | offer / spawn / list / register |
  | `fs` | read / write / list / exists / stat / ancestors |
  | `store` | get / set / delete / keys |
  | `clock` | now / sleep / after / every |
  | `http` | fetch |
  | `process` | run |
  | `settings` | read |
  | `env` | get / set |

  （均为 `CoreEngineInterface` 的一级成员；`$` 的**完整类型面**由插件名词如 `$.telemetry` 合并进来。）

- **插件名词（plugin noun）**：在 `engine.create` 折叠里加入 `$` 的新名词，
  例如 `telemetry` opt-in 了 `$.telemetry`（`mods/telemetry/types/index.d.ts:123-131`）。
  `$` 是**冻结（frozen）**的，每次 hook 调用拿到的是**同一个对象**（`mods/types/claude-code.d.ts:3949-3950`）。

### 2. `register`：hooks 模块入口

```ts
export type Register = (on: On, options: PluginOptions) => unknown;
// mods/types/claude-code.d.ts:7420
export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;
// mods/types/claude-code.d.ts:6193
```

- 每个 hooks 模块导出 `register(on, options)`；`options` 在本次激活期内固定，**一变就重载 plugin 并
  重新调用 `register`**，hook 通过闭包持有它（`mods/types/claude-code.d.ts:7409-7420`）。
- 真实入口：`mods/diff/hooks/register.ts:41`（`export function register(on: On) { ... }`）、
  `mods/agents-md/hooks/register.ts:40`（`register(on: On, options: PluginOptions)`）。

### 3. `on`：注册一个 hook

```ts
export type On = {
  <P extends Pattern>(pattern: P, hook: NoInfer<HookFor<P>>): Registration<HookFor<P>>;
  <P extends Pattern, const M extends Matcher<Args<MatchedNames<P>>>>(
    pattern: P, matcher: M, hook: NoInfer<MatchedHook<P, M>>): Registration<MatchedHook<P, M>>;
};
// mods/types/claude-code.d.ts:5446-5449
```

- `pattern` 可以是：**事件名**、**命名空间 glob**（`classic.*`、`telemetry.*`）、
  **全选 `*`**、或**取反 `!tool.*`**（`mods/types/claude-code.d.ts:5436-5441`、`6051`、`5149`）。
- 第二个重载允许传一个 **matcher**（如 `{ tool: "Bash" }`、`{ command: "diff" }`、`{ tier: "user" }`），
  让同一个 handler 只对匹配的输入生效，并把 `e` 收窄（`mods/types/claude-code.d.ts:4895`）。
- 「同一 plugin 的多次注册按注册顺序嵌套，**先注册者在最外层**；重复注册抛错」
  （`mods/types/claude-code.d.ts:5440-5441`）。
- 返回 `Registration`，它只有一个 `.catch`（`mods/types/claude-code.d.ts:7430-7439`）。

### 4. Hook 形状：`($, e, next)`

```ts
export type Events = {
  [E in keyof EventOf]: E extends StreamingEventName
    ? StreamHook<E>
    : ($: E extends 'engine.create' ? NoEngineInterface : EngineInterface,
       e: Frozen<Args<E>>, next: Next<E>) => EventResult<E> | Promise<EventResult<E>>;
};
// mods/types/claude-code.d.ts:3956-3958
```

- 三个参数：`$`（引擎接口）、`e`（事件参数，**深冻结**）、`next`（链的其余部分）。
- `e` 是 `Frozen<Args<E>>`：`e.command = "ls"` 会**编译报错**；改写必须**拷贝**并经 `next` 传下去
  （`mods/types/claude-code.d.ts:3968-3978`）。
- 唯二的**流式事件**是 `turn.step`，其 hook 是 **async generator**（`StreamHook`），
  类型常量 `StreamingEventName = 'turn.step'`（`mods/types/claude-code.d.ts:9476`、`9500`）。
- 每个事件的 hook 类型并非逐事件定义，而是**一个映射类型**：这样引擎调用时无需 cast，
  且避免「泛型 `E` 导致 handler 变成联合类型」的问题（`mods/types/claude-code.d.ts:3941-3948`）。

### 5. `next`：中间件续体

```ts
export type Next<N extends EventName = EventName, E = Args<N>, O = NextResult<N>, ...> = {
  <T extends string>(e: E & ToolNamed<T>): Promise<NextResultFor<N, O, T>>;
  (e: E): Promise<O>;
  readonly to: { <T extends string>(e: E & ToolNamed<T>, tier: TargetTier): Promise<...>; (e: E, tier: TargetTier): Promise<O> };
  readonly signal: AbortSignal;
  readonly is: <M extends PatternOver<N>>(pattern: M, e: unknown) => e is Frozen<S[...]>;
  readonly event: N;
  readonly origin: Origin;
  readonly trace: readonly TraceEntry<N, E, O>[];
  readonly budget: NextBudget;
};
// mods/types/claude-code.d.ts:5230-5302
```

语义（逐条对应 JSDoc，`mods/types/claude-code.d.ts:5210-5302`）：

- **`next(e)`**：运行**下层 hooks（含内核）**；每次调用都会再次运行下层；内核在最底，
  在它之下再调用 `next` 会 **reject**。**无参调用会 reject 并报出 hook 名**。
- **不调用 `next` 就返回 = 结束这条链**（应答或中止）；**什么都不返回 = 失败**。
- **`next.to(e, tier)`**：跳到某个 tier，**跳过介于本 hook 自己 tier 与目标 tier 之间的一切链接**。
  仅**受管 hook**（managed，即 `prepend` / `append`）可用；且**永远不会跳过权限更高的 tier**，
  所以 user hook 跳不过组织的 hook（`mods/types/claude-code.d.ts:5237-5248`、`9638-9642`）。
- **`next.signal`**：本 dispatch 所属调用被放弃（用户中断、上层先结算、本 hook 超预算）时的 `AbortSignal`，
  hook 启动的计时器 / 请求应在它上面停止（`mods/types/claude-code.d.ts:5249-5256`）。
- **`next.is(pattern, e)`**：`e` 的类型谓词，用于 glob hook 收窄（`mods/types/claude-code.d.ts:5257-5264`）。
- **`next.event`**：本次 dispatch 的事件名（值）。
- **`next.origin`**：谁抛出了这次 dispatch——调用方 plugin 名与它所在 tier（`Origin`，
  `mods/types/claude-code.d.ts:5912-5923`、`5270-5281`）。**由宿主从调用来源与座位设定，plugin 写不了**。
- **`next.trace`**：本 hook 最近一次 `next()` 之下结算的条目（`TraceEntry[]`，就近的在前，引擎最后）；
  `next` 未调用前为空（`mods/types/claude-code.d.ts:5282-5290`）。
- **`next.budget`**：实时读取的时间预算 `{ ms, remainingMs }`（`mods/types/claude-code.d.ts:5292-5301`、`5315-5325`）。

**`.catch` 处理器**（`Registration.catch`，`mods/types/claude-code.d.ts:7430-7438`）收到 `next` 上的
额外字段 `error` / `called`（`Caught`，`mods/types/claude-code.d.ts:893-904`）：

- `next.error` 是 `HookFailure`：`{ kind: 'throw' | 'timeout', message?, budget }`（`mods/types/claude-code.d.ts:4264-4276`）。
- `next.called`：失败 hook 此前是否调用过 `next()` / `next.to()`；`called` 时 `.catch` 里的 `next(e)`
  **重放**上次结果、不再运行下层（`mods/types/claude-code.d.ts:885-904`）。

### 6. Tier（座位）与权威顺序

```ts
const TIERS: readonly ["prepend", "user", "append", "builtin", "core"];
// mods/types/claude-code.d.ts:9743
export type Tier = (typeof TIERS)[number];                 // 9733
export type TargetTier = Exclude<Tier, 'prepend' | 'user'>; // 9642
```

- **五个 tier，由外到内**：`prepend` > `user` > `append` > `builtin` > `core`；
  **越靠外权威越高**；同事件 hook 只按此顺序嵌套（`mods/types/claude-code.d.ts:9726-9743`）。
- 含义：`prepend` / `append` 是**管理员列出的受管 plugin**（组织策略），`user` 是个人安装的一切，
  `builtin` 是内置进二进制的 plugin，`core` 是引擎最内层的一环（`mods/types/claude-code.d.ts:9726-9732`）。
- **`next.to` 只能往下跳到 `append` / `builtin` / `core`**——因此 `prepend` 与 `user` 不做跳转目标。

### 7. 事件目录（event catalog）

```ts
export type EventOf = CoreEventOf & NounEventOf;              // 3933
type CoreEventOf = EngineEventOf & ClassicEventOf & OpEventOf; // 3047
export type EventName = keyof EventOf;                         // 3923
export type EventResult<N> = ResultOf[N];                      // 3939
export type ResultOf = EngineResultOf & ClassicResultOf & {
  [N in OpEventName]: OpEventResult<N>;
} & { [N in NounEventName]: NounEventResult<N> };              // 8468-8472
```

事件分**四大家族**：

**(a) `EngineEventOf` —— 引擎在自己的调用点上抛出的事件（39 个）**
定义见 `mods/types/claude-code.d.ts:3243-3661`，结果 `EngineResultOf` 见 `3692-3854`：

| 命名空间 | 事件 |
| --- | --- |
| `tool` | `tool.call`、`tool.check`、`tool.describe` |
| `ui` | `ui.render`、`ui.resolve`、`ui.press`、`ui.input`、`ui.select`、`ui.message`、`ui.scroll`、`ui.focus` |
| `agent` | `agent.offer`、`agent.spawn` |
| `prompt` | `prompt.submit`、`prompt.fill`、`prompt.suggest`、`prompt.edit`、`prompt.section`、`prompt.context`、`prompt.compose`、`prompt.attachment` |
| `command` | `command.run`、`command.describe` |
| `config` | `config.set`、`config.describe` |
| `skill` | `skill.prompt` |
| `attribution` | `attribution.text` |
| `session` | `session.start`、`session.receive`、`session.compact`、`session.attach`、`session.detach`、`session.measure`、`session.end` |
| `plugin` | `plugin.register` |
| `turn` | `turn.start`、`turn.step`（流式）、`turn.complete` |
| `engine` | `engine.create`（折叠，构建 `$`） |

**(b) `OpEventOf` —— 「对 `$` 的调用」也是事件（~59 个）**
`mods/types/claude-code.d.ts:5508-5807`。每个 `$.<noun>.<method>(...)` 都是一次 dispatch，
**可按名字或 `on("*")` 挂钩**；上层 hook 可以传递、改写、`{ deny }` 拒绝或 `{ value }` 应答；
**内核对它就是宿主的实现**；调用它的那个 hook 自身被跳过，`next.origin` 指向调用者
（`mods/types/claude-code.d.ts:5500-5507`）。包含 `model.*`、`audio.*`、`mcp.call`、`session.*`、
`turn.abort`、`prompt.read`、`tool.list/register`、`command.list/register`、`config.list`、
`agent.list/register`、`ui.*`、`fs.*`、`store.*`、`clock.*`、`http.fetch`、`process.run`、
`settings.read`、`env.get/set`。

**(c) `ClassicEventOf` —— 传统「settings hooks」事件**
`mods/types/claude-code.d.ts:941-966`。名字形式为 `` `classic.${ClassicHookEvent}` ``，
其中 `ClassicHookEvent = HookInput['hook_event_name']`，即 Agent SDK 的 `<Event>HookInput` 名。
共 ~34 个：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`PreCompact`、
`PostCompact`、`UserPromptSubmit`、`UserPromptExpansion`、`SessionStart`、`SessionEnd`、`Stop`、
`StopFailure`、`SubagentStart`、`SubagentStop`、`Notification`、`PermissionRequest`、`PermissionDenied`、
`PreModelSwitch`、`PostModelSwitch`、`ConfigChange`、`CwdChanged`、`DirectoryAdded`、`FileChanged`、
`InstructionsLoaded`、`MessageDisplay`、`Elicitation`、`ElicitationResult`、`TaskCreated`、`TaskCompleted`、
`TeammateIdle`、`WorktreeCreate`、`WorktreeRemove`、`Setup` 等。
其链是 **[受管 settings hooks, …hooks 模块, 其余 settings hooks 作为 core]**，
所以受管阻断在所有模块之上就结束了这条链（`mods/types/claude-code.d.ts:946-953`）。
`classic.PreToolUse` 形状特殊：`e` 就是 `ToolCallEnvelope`。

**(d) `NounEventOf` —— 插件名词的方法即事件**
`mods/types/claude-code.d.ts:5400-5433`。一个 plugin 在 `EngineInterface` 上声明名词后，
它每个「`<noun>.<method>`」函数成员自动成为事件（结果 `{ value }` 或 `{ deny }`）。
例：`telemetry.log`、`telemetry.mark`。

### 8. `engine.create`：构建 `$` 的折叠

```ts
export type EngineCreateInput = { plugins: readonly string[] };   // 3212-3222
export type EngineCreateResult = Partial<EngineInterface> & { readonly [noun: string]: unknown }; // 3231-3233
export type EngineInterfaceBuilt = EngineInterface & { readonly [noun: string]: unknown }; // 3685-3687
export type NoEngineInterface = { readonly [noun: string]: never }; // 5365-5367
```

- **一次加载一次**，`core` 在最内层；`plugins` 按**列表顺序、最外层在前**（受管 plugin 在前，
  于是组织 plugin 的「withhold」优先）（`mods/types/claude-code.d.ts:3204-3222`）。
- hook 以 **post-order** 书写：`const built = await next(e)` 即「目前构建到此的 `$`」，
  `return { ...built, voice: { say } }` 加上本 plugin 的名词（`mods/types/claude-code.d.ts:3204-3211`）。
- 一个 step **可以 ADD 名词、可以 WITHHOLD 名词**（漏掉它，或 `return` 而不调 `next`）；
  **不可以 REPLACE 另一个 step 已加的名词**——否则该 step 失败并点出两个 plugin 名；
  **失败的 step 会卸载其 plugin，`$` 重建**（`mods/types/claude-code.d.ts:3652-3660`）。
- 真实示例：telemetry mod 在自身 `engine.create` 里以 `await next(e)` 取到下层 `$`（`beneath`），
  再用它构造发送器并 `return { telemetry, ...beneath }`（`mods/telemetry/hooks/register.ts:53-368`）。

### 9. 名词契约（noun contract）与依赖注入

- 提供名词的 plugin **拥有该名词的类型**，集中在 `types/index.d.ts`：**无 import 的声明文件**，
  导出构成该名词的类型，并在 `claude-code` 上 `declare module` 该名词
  （`mods/README.md:84-92`；`mods/telemetry/types/index.d.ts:1-12, 123-131`）。
- 契约是**唯一声明**：插件自己的 hook 从该目录 `import type`，而 `engine.create` 返回的值会被
  `EngineInterface['telemetry']` 检查，**实现无法与调用者所见漂移**（`mods/README.md:93-97`）。
- 调用他方名词的 mod **读取同一份文件、绝不复制**：`mods/tsconfig.json:16` 的
  `"include"` 含 `*/types/**/*.d.ts`，于是 `diff` 里的 `$.telemetry.log(...)` 就是对
  telemetry 契约的编译（`mods/README.md:98-101`；`mods/diff/hooks/register.ts:687-688`）。
- 测试里调用他方名词时，需**自备 provider**（以 `engine.create` 加该名词的内联 plugin），
  否则 `$` 构建会**拒绝该 hook 并点出无人提供的名词**（`mods/README.md:102-107`）。

### 10. UI 渲染：自定义 JSX runtime + 逐 surface 元素表

- `mods/tsconfig.json:12-14`：`"jsx": "react"`、`"jsxFactory": "h"`、`"jsxFragmentFactory": "Fragment"`。
  `h` / `Fragment` 是模块环境里的**全局**（`mods/types/claude-code.d.ts:14-24`）。
- 元素构造器**不是全局**，而是从「该 surface 的表」取：`const { Box, Text } = $.ui.resolve(e)`
  （`mods/types/claude-code.d.ts:22-23`、`2092-2096`）。各 surface 的表见 `Elements`（`3105-3172`）：
  都含 `Box`/`Text`/`Button`/`Link`/`Code`/`Markdown`；远端 surface 有 `Svg`；
  `mobile` 无 `Input`/`Select`；`terminal`/`desktop` 有 `Client`；`terminal` 另有 `Raster`/`Image`。
- render hook 返回**纯数据树** `RenderElement`（`StyledElement<'Box'|'Text'>` 或 `Button` 等），
  属性是 Ink 的 `Box`/`Text` 属性的**白名单子集**；含非法属性则整棵树校验失败、改画引擎自带组件
  （`mods/types/claude-code.d.ts:7461-7469`）。

### 11. 测试工具链：`claude-code/testing`

`mods/types/claude-code.d.ts:11453` 起。要点（与 `mods/README.md:22-82` 对应）：

- `test(name, async ($, on) => { ... })`：`$` 是**引擎自己的 `$`**，所有调用都像引擎调用点那样发出，
  跑过**每个已加载 plugin**；测试用 `on` 注册的 hook **位于所有 plugin 之下**，其下再没有别人——
  **它们不回答的调用会抛错并点出事件名**（`mods/types/claude-code.d.ts:12317-12337`）。
- `tier('builtin')`：声明被测 plugin 加载所在的 tier（不写默认 `user`）（`mods/types/claude-code.d.ts:12359-12365`；示例 `mods/README.md:42`）。
- `describe` / `expect` / `mock`；`mock.clock(on)` / `mock.env(on, vars)` / `mock.store(on, entries)`
  按「名词」在测试内存里为下层作答（`mods/types/claude-code.d.ts:11898-11991`；`mods/README.md:71-79`）。
- `Plugin` / `PluginTier` / 内联 plugin（`mods/types/claude-code.d.ts:12277-12293`）。
- `$.ui.mount({ plugin, surface, ... })` 在指定 surface 上画出组件并以 key 驱动（press/input/key/…），
  一根测试体可跨多个 surface 覆盖同一 mod（`mods/types/claude-code.d.ts:31-55`、`11586-11633`）。

---

## 数据流 / 时序

### A. 加载期：构建 `$`

```
加载器读 plugin.json + hooks/hooks.json（modules 列表）
        │
        ▼
（逐个 hooks 模块）plugin.register 事件 ── 准入闸门 ──► core 应答 { allow: true } 或 { refuse: reason }
        │                                                     （结果 6203-6246）
        ▼  被准许的模块 join
engine.create 折叠（core 最内层；plugin 按列表顺序、最外层在前）
        │   post-order: 每个 step `await next(e)` 拿到内层已建 `$`，再 spread + 加/扣自己的名词
        ▼
最终返回 = 完整 `$`（EngineInterface），此后所有 hook 的 `$` 都是这一个冻结对象
```

### B. 运行期：一次事件 dispatch（中间件链）

```
调用点（引擎或某 plugin 的 `$` 调用）raise 事件 N，携带只读 e，且 origin = 调用者
        │
        ▼
prepend 外层 hook ──► user … ──► append … ──► builtin … ──► core（内核实现）
   每个 hook 可任选：
     · return next(e)                  继续（可 `next({ ...e, field })` 改写下行）
     · 不调 next 直接 return { ... }   结束链 / 直接应答
     · return { deny }                 拒绝
     · next.to(e, tier)                跳到较低权威 tier（仅受管 hook）
     · 抛错 / 超预算                   被跳过，下层照跑，按名字上报
        │
        ▼
最外层的返回值（或最先「直接应答」者的值）即 `next(e)` 最终解析结果
```

**重入（recursion）规则**：hook 通过 `$` 发起一次调用时，
**这次新 dispatch 会跳过「发起它的那个 hook」**，但仍会运行其余 hook（包括同 plugin 的其它 hook）
（`mods/types/claude-code.d.ts:3953-3954`、`3858-3862`）。这避免了自递归，也是
`next.origin` 存在的原因。

**会话生命周期主序**（节选自各事件 JSDoc）：

1. `session.start`：每个已加载 plugin 在首个 prompt 前各触发一次（之后仅在「全新加载」时再次触发，
   如 enable / worker 重生 / reload；**`/clear` 不触发**）。首个 `session.start` 是 **awaited** 的，
   所以此处 `$.tool.register` 能在第 1 轮就被列出（`mods/types/claude-code.d.ts:3540-3551`）。
2. `prompt.submit` → `turn.start` → `turn.step`（流式，可多次）→ `turn.complete`。
3. 过程中 `tool.call` → `tool.check`（权限判定）→ 工具执行；`ui.render` 按输入值、
   每次绘制各触发一次；`prompt.section/context/compose/attachment` 组装系统提示。
4. `session.compact`（压缩）、`session.attach/detach/measure`（多端 surface 名册与用量）。
5. `session.end`：会话结束（退出、`/clear`、resume、logout、信号、`-p` 跑完），
   `next(e)` 运行引擎为 plugin 准备的收尾步骤（`mods/types/claude-code.d.ts:3605-3616`）。

**重载与拆卸**：

- **选项变化** → 重载该 plugin、重跑 `register(on, options)`（`mods/types/claude-code.d.ts:7409-7415`）。
- **刷新**：若某模块 hook 了 `engine.create` 或 `plugin.register`，则**全部模块**重载，否则只重载变化者
  （`mods/types/claude-code.d.ts:3542-3546`）。
- **失败卸载**：`engine.create` step 失败 → 卸载其 plugin、`$` 重建（`mods/types/claude-code.d.ts:3657-3658`）。
- **准入拒绝**：`plugin.register` 返回 `{ refuse }` → 该模块**什么都不加入**（无 hook、无名词、无工具/命令），
  但它的顶层代码已在封闭环境里跑过一次（`mods/types/claude-code.d.ts:3617-3627`；
  `mods/sec-default/README.md:69-71`）。
- **卸载动作**：`ui.close` 的 `origin.kind === 'unload'` 表示某个 pane 因「其 plugin 卸载或绘制抛错」
  而被丢弃（`mods/types/claude-code.d.ts:5954-5967`）。

---

## 扩展点

复刻该产品时，需要照搬的**可扩展面**：

1. **hook 注册（`on`）**：按事件名 / glob / `*` / 取反注册；可选 matcher 收窄。
   一个 plugin 的多次注册按顺序嵌套，**先注册者最外层**（`mods/types/claude-code.d.ts:5436-5449`）。
2. **命名名词 / DI（`engine.create`）**：向 `$` 加名词，或对下层名词 **withhold**；
   名词类型由提供者以 `types/index.d.ts` + 声明合并对外发布（`mods/README.md:84-101`）。
3. **准入闸门（`plugin.register`）**：在模块 join 之前，按宿主钉定的 `tier` 与扫描出的 `uses`，
   由已准入者 + 二进制自身裁决（`mods/types/claude-code.d.ts:6196-6230`）。
4. **tier 座位（seating）**：内置 `sec-default` 的**唯一「真正起作用」的动作 `next.to`**
   只在受管 tier 下才被接受（`mods/sec-default/README.md:178-188`）；
   受管设置里的 `prependPlugins` 决定 `prepend` 这一层的**整份名单与位置**
   （`mods/README.md:10`；`mods/sec-default/README.md:83-84, 181-186`）。
5. **.catch 兜底**：为单个注册挂 `catch`，获得 `next.error` / `next.called` 与一段 grace 预算
   （`mods/types/claude-code.d.ts:7422-7438`；真实用法 `mods/sec-default/hooks/register.ts:95-114`）。
6. **UI render hook + 逐 surface 元素表**：`ui.render` / `$.ui.resolve(e)`，
   以及 `Button`/`Input`/`Select`/`Client` 等交互回抛为 `ui.press`/`ui.input`/`ui.select`/`ui.message`
   （`mods/types/claude-code.d.ts:3265-3342`）。
7. **classic hooks**：通过 `classic.*` 兼容传统 settings hooks 事件。
8. **测试工具链**：`claude-code/testing` 的 `tier` / `mock` / `test($, on)`（见上）。

真实 mod 的注册面可直接作为模板：

- `mods/diff/hooks/register.ts:41-1035`：一个「全功能」插件——`session.start` 绑定宿主、
  `ui.render` 画 Pane、`command.run` 实现 `/diff`、`tool.call` 监听编辑/命令、
  `prompt.submit` 把 hunk 挂到下一条 prompt。
- `mods/telemetry/hooks/register.ts:23-369`：名词提供者——`telemetry.*` 网关、
  `engine.create` 加名词、`session.end` flush。
- `mods/agents-md/hooks/register.ts:40-256`：按 `options.instructionFiles` 分支注册不同 hook，
  演示 `PluginOptions` 驱动行为。
- `mods/sec-default/hooks/register.ts:20-115`：受管外侧座位——`next.to(e, 'append')`、
  按 `next.origin.tier` 拒绝 user 层、用 `next.trace` 保住组织 deny 规则。

---

## 设计决策与权衡

1. **中间件组合（Koa 风格）而非事件发射器（emitter）**。
   `next(e)` 让 hook 能在下层结果之上包装、改写、短路；代价是**排序是核心语义**，
   必须引入 tier、trace、budget、signal 一整套治理设施（`mods/types/claude-code.d.ts:5210-5302`）。
   权衡：换来「组织策略压过个人插件」这类**可证明的顺序保证**。

2. **输入冻结 + 拷贝改写**。`e` 深冻结（`Frozen`，`3968-3978`），改写只能是
   `next({ ...e, field })`。权衡：安全（hook 不能偷偷改事实）与可追溯（trace 记录每步），
   代价是不能就地修改、需频繁浅拷贝。

3. **内核即最内层链接（core innermost）**。每个 `$` 操作本身就是一个事件，内核是它的「实现」。
   权衡：任何上层都能观察/改写/拒绝**几乎一切**（含 `fs.read`、`settings.read`），
   极强可组合性；但要求内核实现严格按事件模型重构自身。

4. **tier 权威序 + `next.to` 定向跳过**。越靠外权威越高，`next.to` 只能向下跳。
   权衡：用一个简单常量 `TIERS` 表达复杂的组织/个人权限关系；代价是 `next.to`
   被限制为「仅受管 hook 可用」，非受管插件无法绕过上层。

5. **故障隔离而非传播**。hook 抛错 / 超时 / 返回错形状 → 跳过它、下层照跑、按名上报
   （`mods/types/claude-code.d.ts:3238-3242`）。配合 `HookBudget`（`ms: 10_000`、
   `catchMs: 1_000`、`lingerMs: 5_000`，`4228-4254`）。权衡：一个坏插件**不会**拖垮会话，
   但「静默降级」需靠 `.catch` 与 trace 才能被察觉。

6. **类型即契约 + 声明合并**。整个引擎扩展面是**单个 `.d.ts`**，名词以
   `declare module 'claude-code' { interface EngineInterface { ... } }` 合并，
   类比 jQuery 的 `$.fn`（`mods/types/claude-code.d.ts:3663-3672`）。
   权衡：调用方零成本获得完整类型；代价是**早期访问**、版本间可能变化（`mods/types/claude-code.d.ts:3-5`）。

7. **自定义 JSX runtime 与 surface 解耦**。`h` / `Fragment` + `$.ui.resolve(e)` 的**逐 surface 元素表**，
   让同一棵数据树在不同前端渲染，而不是把 Ink/React 泄漏给插件（`mods/types/claude-code.d.ts:14-24, 3097-3172`）。

8. **测试环境与运行环境同构**。测试跑在「无 fs / 网络 / process」的同构环境里，`$` 是引擎自己的，
   下层用 `mock` 按名词作答（`mods/types/claude-code.d.ts:25-40`）。

---

## 对复刻产品的启示

1. **先定事件目录，再定 API**。事件分四族（引擎调用点 / classic settings hooks / 对 `$` 的调用 / 插件名词），
   每族都在 `EventOf` 里有一份「输入 `Args` + 结果 `Result`」的映射。
   复刻时先把 `<noun>.<verb>` 目录与 `Args`/`Result` 定死，再实现链，可避免后期返工。

2. **`next(e)` 协议必须一次设计到位**。至少包含：调用下层、带改写下行、不调即结束、
   `next.to(tier)` 定向跳过、`next.signal` 中止、`next.trace` 可观测、`next.budget` 限时、
   `.catch` 兜底与重放。这些都是**复刻难点**，也是权限/安全保证的落点。

3. **把 tier 当作一等公民**。用固定常量顺序 + 「越外越权威」+ 「只能向下跳」三条规则，
   就能在**不牺牲可组合性**的前提下表达组织策略压过个人插件；再配一个
   最外侧的 `sec-default` 式守卫（`next.to` + 按 tier 拒绝 + fail-closed）即可。

4. **名词 DI 用「折叠 + 声明合并 + withhold」**。加载期一次 `engine.create` 折叠构建 `$`，
   名词类型由提供者用一份无 import 的 `.d.ts` 对外声明；`withhold` 是安全能力
   （组织可以让某个名词对个人插件不可见）。复刻时把「构建 `$`」当作**唯一**的注入点。

5. **复用一份契约，禁止复制**。用 tsconfig `include` 覆盖各 mod 的 `*/types/**/*.d.ts`，
   让所有调用者编译到同一份契约——这样「实现漂移」在编译期就被抓到（`mods/README.md:93-101`）。

6. **故障隔离 + 预算 + 中止**三件套内建。否则第三个插件就会拖垮整个会话。

7. **测试即文档**：提供 `tier()` / `mock` / 「引擎自己的 `$` + 下层 `on`」的测试 harness，
   让每个 mod 的测试直接覆盖真实的链语义。

8. **发布清单与类型分开**：`plugin.json` 声明 `types`，`hooks/hooks.json` 的 `modules` 声明要加载的
   `register.ts` 入口；运行时只加载这些 `modules`（`mods/telemetry/.claude-plugin/plugin.json:8`、
   `mods/telemetry/hooks/hooks.json:3-5`）。

---

## 关键文件索引

- `mods/types/claude-code.d.ts` —— **权威契约**（本文所有接口与事件定义）：
  - 文件头自述：`1-91`
  - `CoreEngineInterface`（`$` 内核名词）：`2016-3035`
  - `EngineEventOf`（39 个引擎事件）：`3243-3661`；`EngineResultOf`：`3692-3854`
  - `EngineInterface` / `EngineInterfaceBuilt` / `NoEngineInterface`：`3663-3687`、`5361-5367`
  - `EventCalls`（`$` 调用签名）：`3856-3917`
  - `EventOf` / `EventName` / `ResultOf` / `Events`：`3919-3958`、`8464-8472`
  - `HookBudget` / `HookFailure` / `Caught` / `CatchHandler`：`4228-4276`、`875-904`
  - `On`：`5446-5449`；`Hook`：`4215`；`HookFor`：`4286`
  - `Next` / `NextResult` / `NextBudget`：`5210-5350`
  - `Origin`：`5904-5923`；`Tier` / `TIERS` / `TargetTier`：`9638-9743`
  - `PluginOptions` / `PluginRegisterInput` / `Register` / `Registration`：`6193`、`6196-6246`、`7409-7439`
  - `ClassicEventOf` / `ClassicEventName`：`937-958`
  - `OpEventOf` / `OpValueOf`：`5498-5807`、`5813`
  - `EngineCreateInput` / `EngineCreateResult`：`3204-3233`
  - `claude-code/testing` 模块：`11453-12373`
- `mods/README.md` —— hook 模型、`register(on, options)`、tier、名词契约、测试工具链（全文）
- `mods/tsconfig.json` —— JSX `jsx: "react"` / `jsxFactory: "h"`、`include` 覆盖 `*/types/**/*.d.ts`
- `mods/diff/hooks/register.ts`（`41`）· `mods/diff/hooks/index.ts` · `mods/diff/hooks/hooks.json` · `mods/diff/.claude-plugin/plugin.json`
- `mods/telemetry/hooks/register.ts`（`23`）· `mods/telemetry/types/index.d.ts`（`123-131` 声明 `$.telemetry`）· `mods/telemetry/hooks/hooks.json`
- `mods/agents-md/hooks/register.ts`（`40`，`PluginOptions` 驱动）· `mods/agents-md/hooks/hooks.json`
- `mods/sec-default/hooks/register.ts`（`20`）· `mods/sec-default/README.md`（座位/权威序）· `mods/sec-default/hooks/hooks.json`
- `plugins/security-guidance/hooks/hooks.json`（传统命令 hook 清单，对比用）· `plugins/security-guidance/.claude-plugin/plugin.json`
- `examples/settings/`（HIPAA / strict / lax / sandbox 等受管设置示例，理解 `prependPlugins`、`pluginConfigs` 语境）

---

## 存疑与待确认

1. **引擎实现不可见**。本仓库无引擎源码；所有行为均为 `.d.ts` 的 JSDoc 陈述，**未在源码层面验证**。
   文档中「链的顺序」「预算数值」「重放语义」等，均以此为准。
2. **契约本身是早期访问**。文件头标注「EARLY ACCESS: this surface may change between releases」，
   且由 Claude Code `2.1.277` 生成（`mods/types/claude-code.d.ts:1-4`）；版本间可能不兼容。
3. **事件清单的穷尽性**由**正则抓取**得出（本文对 `EngineEventOf` / `OpEventOf` / `classic` 的枚举）。
   若某事件名含非 `[a-z.]` 字符（已排除大写与 `-` 的已知情况）或经别名生成，可能遗漏。
   `LateOverload`（`classic.PreToolUse`、`turn.abort`、无参事件）在 `OrderedOverloads` 中被特殊处理
   （`mods/types/claude-code.d.ts:4732`、`5902`），提示还存在**顺序上的特例**。
4. **「同事件 hook 嵌套顺序」的精确算法**。文档给出「按 tier + 同 plugin 先注册者最外层」，
   但 **worker 批处理**等细节不在 `.d.ts` 里：`mods/sec-default/README.md:124-126` 提到
   「共享同一 worker 的相邻 plugin 会被引擎作为**一个批次**、挂在首个成员的 tier 下」——
   这一 worker/批次模型**未在类型契约中声明**，复刻时需另行设计。
5. **`prependPlugins` / `pluginConfigs` 的完整 schema** 未在 `.d.ts` 中给出；
   目前只能从 `mods/sec-default/README.md:160-176, 180-188` 与 `examples/settings/` 反推。
6. **manifest 与模块发现**：`hooks/hooks.json` 的 `modules` 如何被宿主扫描、为何 `.ts`/`.tsx` 等后缀
   才被加载（后缀白名单见 `mods/types/claude-code.d.ts:18-20`），以及 `plugin.json` 的 `types`
   如何被 `/plugin-types` 消费，缺少正式 schema 文档。
7. **`$.ui.mount` 等属于测试专用**；生产环境中 `ui.render`/`ui.press` 等通过 surface 前端的实际
   驱动路径（终端按键、桌面点击、`ui_press`/`ui_client_press` 控制协议消息）在 `.d.ts` 中仅零散提及
   （如 `mods/types/claude-code.d.ts:3139-3171` 的 surface 限制注释），需结合未公开的实现确认。
8. **`engine.create` 的「跨 reload 重建」边界**：文档称「一次加载/重载、每次 plugin 一次、
   先于该 plugin 任何其它 hook」，但 reload 时「完整重建还是增量重建」的精确规则，
   仅能从 `EngineCreateInput.plugins` 的注释（`mods/types/claude-code.d.ts:3212-3222`）与
   `session.start` 的注释（`3542-3546`）间接推断，尚无源码佐证。
