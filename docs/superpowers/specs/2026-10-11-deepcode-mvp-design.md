# DeepCode —— 最小可用 MVP 设计

> 状态：已评审 · 2026-10-11
> 依据：`docs/claude-code-架构分析/` 全套 11 篇架构文档
> 本文是 **MVP（第 0 期）** 的施工说明书，并给出后续 **P1–P5** 的模块 × 阶段完善计划。

---

## 0. 决策摘要

| 项 | 决策 | 理由 |
|---|---|---|
| 产品形态 | 终端 CLI 形 agentic 编码工具 | 与架构文档同形态 |
| MVP 定位 | **端到端可用优先** | 第 2 周就能用它改自己的代码 |
| 技术栈 | TypeScript + Node.js | 契约同构：类型即契约、声明合并、名词 DI 折叠三大承重墙可直接照搬 |
| 包结构 | **单包 + 严格目录边界 + lint 强制** | 避免 TS project references 在 Windows/ESM 下的摩擦；P2 再拆 workspaces |
| 模型接入 | `ModelProvider` 抽象 + 先落 **Anthropic 官方适配器** | tool_use / 流式语义与文档 1:1 对齐 |
| 必含能力 | 事件链内核 + 六个核心工具 | 用户确认 |
| 安全底线 | `tool.check` 上的最小 y/N 确认 | 不读设置文件；P2 换实现，内核不改 |
| 契约策略 | **方案 A：契约全量冻结，实现按需裁剪** | 39 个事件全部在类型里；只实现 12 个，其余 27 个只声明 |

---

## 1. 设计原则（从 11 篇文档提炼的承重墙）

以下七条是本文档所有取舍的依据，也是评审时判断"某个设计是否跑偏"的口径：

1. **先定事件目录，再定 API**。事件表与每个事件的 `Args`/`Result` 映射必须一次冻结，否则后期返工代价极大。
2. **`next(e)` 是 Koa 式续体，不是事件发射器**。不调 `next` = 结束链并应答；调 `next({...e, field})` = 带改写下行。签名一次设计到位。
3. **tier 是一等公民**。固定顺序 + 越外越权威 + `next.to` 只能向下跳，三条规则在不牺牲可组合性的前提下表达"组织策略压过个人插件"。
4. **内建工具是插件，不是内核**。内核只认识 `tool.call` 事件与一个工具名字符串，不认识 `Read` 或 `Bash`。这条保证 MVP 的架构在 P3 引入第三方插件时无需重构。
5. **可选依赖必须静默降级**。遥测、外部后端等"有则更好"的能力缺失时主流程照常。
6. **失败方向一律指向更安全（fail-closed）**。每条"读配置 / 判定"路径都必须写明失败时怎么办。
7. **契约唯一声明，禁止复制**。所有调用方编译到同一份类型；实现漂移在编译期被抓。

---

## 2. 分层与依赖方向

```
┌──────────────────────────────────────────────────────────┐
│ cli/            REPL 循环 · 流式打印 · 最小确认 y/N        │  surface
├──────────────────────────────────────────────────────────┤
│ builtins/       工具注册表(6) · 确认器 · 转录              │  builtin tier 插件
├──────────────────────────────────────────────────────────┤
│ core/           agent loop · dispatch 链 · TIERS 座位 ·    │  引擎内核
│                 engine.create 折叠 · next 协议 · 故障隔离  │
├──────────────────────────────────────────────────────────┤
│ providers/      AnthropicAdapter（实现 contract 的接口）   │
├──────────────────────────────────────────────────────────┤
│ contract/       Args<N> / Result<N> / EventName / Tier /   │  唯一事实源
│                 Next / ModelProvider / EngineInterface     │  零 import
│                 —— 插件接口也在这一层，否则 core 得依赖     │
│                    providers，依赖方向就反了               │
└──────────────────────────────────────────────────────────┘
```

### 2.1 依赖规则

用一个约 30 行的脚本 `scripts/check-boundaries.mjs` 静态扫描 `src/**/*.ts` 的 import 语句来强制，违反即 `pnpm lint` 失败：

> 不用 ESLint 的 `import/no-restricted-paths` 规则：flat config 下该插件的支持不稳定，而我们要的只是"某个目录不许 import"，一个读文件+正则的脚本更简单也更可靠（见 §10 偏差 6）。

| 包 | 允许依赖 | 说明 |
|---|---|---|
| `contract/` | **无** | 它是纯类型，不 import 任何东西——这是"契约唯一声明"的物理保障 |
| `core/` | `contract/` | **内核不认识任何具体工具** |
| `builtins/` | `contract/` | 通过 `on(event, matcher, hook)` 注册，与未来第三方插件走完全相同的接口 |
| `providers/` | `contract/` | provider 不知道工具是什么 |
| `cli/` | `core/` + `contract/` + `providers/` | 唯一允许组装的地方：构造具体 Provider 并注入 core |

**`ModelProvider` 的接口声明在 `contract/model-provider.ts`，不在 `providers/`。** 这样 `core/` 只需要依赖 `contract/` 就能拿到 `model` 名词所依赖的类型；`providers/anthropic.ts` 是它的一个实现。若把接口放进 `providers/`，`core/` 就不得不依赖 `providers/`，依赖方向立刻破掉。

### 2.2 关于包边界（暂不拆 workspaces）

MVP 用**单包 + 目录边界 + lint 规则**，不拆 npm workspaces。理由：TS project references 在 Windows + ESM 下的配置摩擦会吃掉 MVP 的时间预算，而"一份契约禁止复制"在单包里靠 lint 规则同样能强制。

**P3 引入 mod 加载器时再拆成 workspaces**——那时契约的物理分离才真正产生价值（第三方插件需要按路径导入同一份契约）。**这个拆分本身是 P3 的一项明确交付物**，不是"以后再说"。

---

## 3. 契约：全量冻结的事件目录

> 文件：`src/contract/events.ts`、`engine.ts`、`next.ts`、`tier.ts`

### 3.1 `TIERS` 与座位

```ts
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const;
export type Tier = (typeof TIERS)[number];
export type TargetTier = Exclude<Tier, 'prepend' | 'user'>;  // next.to 的合法目标

/** 越靠外权威越高 */
export function isOuterThan(a: Tier, b: Tier): boolean;
```

MVP 实际只有 `builtin`（内建插件）与 `core`（内核）两层落座，`prepend` / `user` / `append` 留空。**但五个常量与全部比较函数必须一次到位**——否则 P2 的 `sec-default` 守门器会推倒重来。

### 3.2 MVP 实现的 12 个事件

| 事件 | `Args` 要点 | `Result` |
|---|---|---|
| `engine.create` | `{ plugins: readonly string[] }` | `Partial<EngineInterface>` |
| `plugin.register` | `{ name, tier, uses }` | `{ allow: true }` \| `{ refuse: string }` |
| `session.start` | `{ sessionId, cwd, root }` | `{}` |
| `session.end` | `{ reason }` | `{}` |
| `prompt.submit` | `{ text }` | `{ handled?: boolean }` |
| `turn.start` | `{ index }` | `{}` |
| `turn.step` | `{ delta }` | `{}`（MVP 里就是普通 dispatch；`STREAMING_EVENTS` 已声明但还没有消费者，P1 才真正流式化） |
| `turn.complete` | `{ stopReason, inputTokens, outputTokens }` | `{}` |
| `tool.call` | `{ tool, input, toolUseId }` | `{ value }` \| `{ deny }` |
| `tool.check` | `{ tool, input }` | `{ decision: 'allow' \| 'ask' \| 'deny', rule? }` |
| `tool.describe` | `{ tool }` | `{ description, inputSchema }` |
| `command.run` | `{ name, args }` | `{ handled?: boolean }` |

### 3.3 只声明、未实现的 27 个事件

`ui.render` / `ui.press` / `ui.input` / `ui.select` / `ui.message` / `ui.scroll` / `ui.focus` / `ui.resolve`、
`agent.offer` / `agent.spawn`、
`prompt.fill` / `prompt.suggest` / `prompt.edit` / `prompt.section` / `prompt.context` / `prompt.compose` / `prompt.attachment`、
`command.describe`、`config.set` / `config.describe`、`skill.prompt`、`attribution.text`、
`session.receive` / `session.compact` / `session.attach` / `session.detach` / `session.measure`、
全部 `classic.*`。

core 落到这些事件时抛 `NotImplementedError`，由 dispatch 捕获降级，**同一事件名只警告一次**。

要注意 §3.2 里的五个生命周期事件（`session.start` / `session.end` / `turn.start` / `turn.step` / `turn.complete`）**由链尾给出 no-op 答复**（返回 `{}`），而不是靠"没人应答"混过去。清单声明在 `contract/events.ts` 的 `NOTIFICATION_EVENTS`，兜底实现在 `core/dispatch.ts` 的链尾 —— 两边合起来表达"这几条没人听才是常态"。这不是装饰：`dispatch` 在既无 hook、又无内核实现时会抛 `NotImplementedError`，而 loop 的第一行就是 `turn.start`、CLI 的第一行就是 `session.start` —— 少了这条兜底，产品和"一开口就崩"之间只隔一次 dispatch。它同时也是上面这条保证成立的前提：`NotImplementedError` 只用来指这 27 个真未实现的事件。

兜底之所以写在链尾、而不是列进 `createEngine` 的 `coreImpls`：那份清单先后漏过两次（初版内核忘了，E2E 的测试桩也忘了），两次的表现都是产品/测试一开口就崩而 `typecheck` 全绿。链尾只有一处，没有第二个地方可以漏。

五个通知事件里**只有 `turn.step` 需要一个真正的应答者**：`cli/stream.ts` 把每个增量写进渲染器。别的四条"没人听"就是字面意思上的没人听；`turn.step` 没人听，等于模型说的话一个字都到不了用户眼前 —— 而事件链、文件内容、`typecheck` 全都正常。所以这条 hook 由 `cli/plugins.ts` 显式装载，并有端到端测试钉住那份清单。

### 3.4 `next` 协议（全签名实现）

```ts
// next.ts 不认识事件名，只认识"参数类型 E / 结果类型 R"。
// 这样 events.ts 可以 import next.ts，反过来不成立 —— 避免循环。
export type Next<E, R> = {
  (e: E): Promise<R>;
  readonly to: (e: E, tier: TargetTier) => Promise<R>;
  readonly signal: AbortSignal;
  readonly is: (pattern: string) => boolean;
  readonly event: string;
  readonly origin: Origin;
  readonly trace: readonly TraceEntry[];
  readonly budget: NextBudget;
};

// events.ts 里把它按事件特化，插件作者看到的就是这个：
export type NextFor<N extends EventName> = Next<Args<N>, Result<N>>;

export const HOOK_BUDGET = { ms: 10_000, catchMs: 1_000 } as const;
```

`Next<E, R>` 上刻意**没有** `readonly trace: readonly TraceEntry<N>[]` 那种带事件名的成员——那会迫使 `next.ts` import `events.ts`，而 `events.ts` 已经 import 了 `next.ts`。事件名通过 `next.event: string` 与 `next.is(pattern)` 提供，运行时完全够用。

即使 MVP 只有两层 tier 用不到 `next.to`，**签名也要一次写全**。理由：这套签名是所有安全保证（deny 重放、定向跳过、故障隔离）的落点，改它等于改所有 hook。

MVP 的行为细则：

- `next(e)` 运行下层；内核在最底，内核之下再调 `next` 会 reject。
- 不调 `next` 直接 return = **结束链**并应答。
- 什么都不返回（`undefined`）= **失败**，与抛错同样处理：跳过该 hook、继续下层、按插件名上报一次。
- `e` 深冻结（`DeepReadonly<Args<N>>`），改写只能 `next({ ...e, field })`。
- `next.to` 在 MVP 中**可用但无实义**（目标层为空），保留给 P2。
- `next.trace` 只收集不消费（P2 的 deny 重放才开始读它）。
- `next.budget` 以 `HOOK_BUDGET.ms` 为初值实时递减。

### 3.5 `$` 上的名词

| 状态 | 名词 |
|---|---|
| **MVP 实现** | `session`、`tool`、`command`、`model`、`fs`、`process`、`store`、`clock`、`ui`（仅 `log`/`notice`/`ask`）、`logger` |
| **声明但抛** | `audio`、`mcp`、`agent`、`config`、`http`、`env`、`settings` |

`turn` 与 `prompt` 在 MVP 里是**事件**（`turn.start` / `prompt.submit`），不是名词——它们没有需要被 hook 改写的内部状态。等到 P1 引入上下文压缩与多轮编排时再决定要不要提升为名词。

> **`settings` 故意不做。** 这是刻意的：**没有 `settings.read`，就不存在"个人插件能不能放宽组织策略"这个问题**。
> 它在 P2 出现，且出现时会带着一整套来源优先级一起出现。
>
> 与它分开的是 **`cli/config.ts`：启动配置，不是设置**。它只读四个字段
> （`apiKey` / `model` / `baseUrl` / `debug`），只被 `cli/main.ts` 用来组装 provider 与 logger，
> **不经事件、不进 `$`**，任何 hook 都读不到它，所以"插件放宽策略"这条路依然不存在。
> 加它的理由很朴素：不然每次开新终端都得先 `export ANTHROPIC_API_KEY`。
> 优先级 **环境变量 > 项目级 `<root>/.deepcode/config.json` > 用户级 `<home>/.deepcode/config.json`**，
> 逐字段合并。坏输入不许静默失效 —— 见 §6.2。

### 3.6 契约的运行时校验

**MVP 不做。** 事件目录的 39 个事件全部写在 `contract/events.ts` 一个文件里，删了或改名了肉眼就能看见；为它单独加一份快照测试是 §6.3 明确排除的开销。

契约这一层的真实保障来自**编译器**而不是测试：消费方 import 同一份契约文件（永不复制），`Args`/`Result` 对不上、事件名拼错、hook 签名写偏，`pnpm typecheck` 全部报错。文档第 12 条共性原则"把安全约定变成会失败的检查"在 MVP 阶段的落点是这条编译期检查，外加 §5.2 那条 fail-closed 的运行时分支。

---

## 4. 运行时设计

### 4.1 一次 dispatch（中间件链）

```
调用方 raise 事件 N
 → 按 TIERS 从外到内取出该事件的所有 hook（内核实现永远在最内层）
 → e 深冻结；改写只能 next({ ...e, field })
 → 每个 hook 可：
     · return next(e)         继续（可带改写下行）
     · 不调 next 直接 return  结束链 / 直接应答
     · return { deny }        拒绝
     · 抛错 / 超预算           被跳过，下层照跑，按插件名写进 trace 并警告一次
```

**重入规则**：hook 通过 `$` 发起调用时，这次新 dispatch **跳过发起它的那个 hook**，但运行其余全部 hook（含同插件其它 hook）。这是避免自递归的关键，也是 `next.origin` 存在的原因。

### 4.2 一个 turn（agent loop）

```
REPL 读一行
 ├─ 以 / 开头 → command.run（dispatch）
 └─ 否则     → prompt.submit（dispatch；core 实现返回 { handled: false }，
                            所以 MVP 它是"什么都不做但真实存在"的钩子点，
                            P1 的斜杠命令展开、prompt.fill、附件都挂在它上面）
                ├─ 组装 system prompt（工具清单来自 tool.describe 事件，不硬编码）
                ├─ turn.start
                ├─ provider.stream(messages, tools)
                │   ├─ text delta      → turn.step（流式）→ cli 打印
                │   └─ tool_use block  → tool.check → tool.call → 结果回灌 messages → 再 stream
                └─ turn.complete
```

**`tool.check` 由 agent loop 在调用工具前抛出**（不是由 `tool.call` 的 core 实现抛出——链的语义决定了 hook 先于 core 实现运行，若由 core 实现抛出，工具已经执行完了）。

顺序是：loop 读到一个 `tool_use` block → 抛 `tool.check` → `builtins/confirm.ts` 挂在它上面（打印预览并返回 `{ decision: 'ask' }`）→ loop 经 `$.ui.ask` 问用户 → 通过后 loop 抛 `tool.call` 执行工具。

**确认逻辑是插件，不是内核**——P2 把 `confirm.ts` 整个换成权限引擎，内核一行不改。

### 4.3 六个核心工具

| 工具 | 依赖的名词 | 关键设计 |
|---|---|---|
| `Read` | `$.fs` | 输出带行号；超长文件分段；行尾 `\r` 在展示时去掉（CRLF 仓库里模型照着抄就不会带上它） |
| `Write` | `$.fs` | 先读后写校验（避免覆盖未读过的新文件）。**只有 `Read` 能打上"读过"标记** —— `Edit` 内部虽然也读了文件，但模型一个字都没见到，给它打标记等于给整体覆盖开后门 |
| `Edit` | `$.fs` | 精确字符串替换，要求 `old_string` 唯一；**行尾容忍**（模型给 LF、文件是 CRLF 时要能匹配上，命中 CRLF 变体时替换内容也转 CRLF），两个 hook 共用同一个定位函数 |
| `Bash` | `$.process` | 超时 + 输出截断上限；`AbortSignal` 贯穿以支持 Ctrl-C；**非零退出的输出必须以 `ERROR:` 开头**（见 §5.1，`is_error` 全靠这个前缀） |
| `Glob` | `$.fs` | 路径模式匹配 |
| `Grep` | `$.fs` | 正则内容搜索，输出 `路径:行号: 内容` |

**遍历时只按白/黑名单跳目录，不按点号一刀切。** `Glob` / `Grep` 曾经跳过所有 `.` 开头的条目（只给 `.claude` 开了个口子），于是 `.env`、`.github/**`、`.eslintrc` 全都搜不到，而返回的还是"没有匹配" —— 模型拿到假阴性，会当成"这仓库里没有"。要排除的重目录（`node_modules`、`.git`、`dist`…）走 `SKIP_DIRS`，其余一律搜。同理，任何形式的静默裁剪（大小上限、结果上限）都必须**在输出里说出来**，不能让模型以为搜索空间是完整的。

**六个工具都必须依赖 `$` 名词而非直接 `fs` / `child_process`**。这既是可测性的前提（测试里 mock `$.fs`），也是 P2 权限过滤与沙箱的前提（内核可以在最内层拦截 `process.run`）。

---

## 5. 错误处理

### 5.1 六类失败，每条都有明确去向

| 失败类别 | 处理 |
|---|---|
| hook 抛错 / 超时 | 隔离跳过，下层照跑，按插件名警告一次（`HOOK_BUDGET`） |
| 工具执行失败（Bash 非零退出、文件不存在） | **不抛**。包装成 `tool_result{ is_error: true }` 回灌模型——工具失败是给模型的信息，不是崩溃 |
| provider 网络错 / 限流 / SSE 流中的 `error` 帧 | 退避重试 1 次；再失败则结束本 turn 并保留会话，不退出进程 |
| 事件未实现 | `NotImplementedError`，dispatch 捕获降级；同一事件名只警告一次 |
| 用户 Ctrl-C | `AbortSignal` 贯穿 `next.signal`，同时掐断 provider 流与 Bash 子进程 |
| 契约漂移 | 编译期抓（单一契约文件 + lint 边界） |

**"工具失败"必须是失败，不能只是"输出末尾提了一句"。** 上表第二行依赖一个具体的前缀约定：loop 用 `content.startsWith('ERROR:')` 决定 `tool_result` 的 `is_error`，所以工具**必须**把失败写在开头。`Bash` 曾经把退出码作为末行 `[退出码 N]`，前缀判定不成立 —— 一次 `exit 3` 回给模型的是 `is_error: false` 的"成功"，模型很可能据此回一句"测试都过了"。系统提示里那句"工具失败会以 ERROR: 开头"是这份约定的另一半，两边要一起改。

**provider 的失败不止 HTTP 状态码。** SSE 流里还有 `event: error` 帧（`overloaded_error` / `rate_limit_error` 等）。它必须抛出去走上面那条重试路径 —— 静默略过的话，一次过载会变成一个"成功的空 turn"：没有文本、没有工具、`stopReason` 还是 `end_turn`，用户的问题凭空消失且不留痕迹。这条路径只有真 API 会走到，脚本化 provider 永远测不出来，所以 `test/provider.test.ts` 用假 `fetch` 直接喂 SSE 帧。

**Ctrl-C 是"掐断这一次"，不是"废掉这个会话"。** `AbortSignal` 一旦 abort 就回不去，所以 `CoreNounsDeps.signal` 收的是**工厂** `() => AbortSignal` 而不是 signal 本身，`cli/turns.ts` 每个 turn 现取一个：第一次 Ctrl-C 掐断当前 turn（provider 流与 Bash 子进程一起断），进程保留、下一个 turn 拿全新 signal；空闲时按 = 退出，同一个 turn 里连按两次 = 强制退出（130）。构造时就把 signal 定死的话，一次中断之后再无 turn 能跑，而 loop 还在提示"会话保留，可以继续输入" —— 那是句假话。

### 5.2 fail-closed 的唯一落点

`tool.check` 若走到链尾无人应答，结果是 **`deny`，不是 `allow`**。

这是 MVP 里唯一一条 fail-closed，但它是 P2 全部安全性质的种子——**方向一旦定成 fail-open，后面补不回来**。

### 5.3 最小确认的交互

```
$ Edit src/utils.ts
   -  const d = new Date(s);
   +  const d = parseWithTimeZone(s);
执行? (y/N) _
```

- `Write` / `Edit` 打印 diff 后询问；`Bash` 打印命令后询问；`Read` / `Glob` / `Grep` 只读，不询问。
- 非 TTY（管道 / CI）环境下 `$.ui.ask` 直接返回 `'n'` —— 也就是说**非交互环境不能写文件、不能跑命令**。MVP 不提供 `--yes` 绕过口子；要有意为之的自动化，留到 P2 的权限规则。
- Ctrl-C 视为拒绝，不是崩溃。

---

## 6. 验证策略：按检查点批量验证

**总原则：以快速开发为主，不做逐任务验证、不追求覆盖率。** 验证按检查点批量做，一个检查点覆盖一批任务；能合并的验证一律合并。

### 6.1 两级验证

| 级别 | 时机 | 内容 | 成本 |
|---|---|---|---|
| **任务级** | 每完成一个任务 | 只要求 `pnpm typecheck` 通过 | 秒级，零额外工作 |
| **检查点级** | 每个里程碑收尾，**一次跑完** | 见 §6.2 | 一次性集中投入 |

**MVP 不设打包步骤**：开发期直接用 `tsx` 跑 `src/cli/main.ts`，`pnpm typecheck` 即 `tsc --noEmit`。产出 dist 与 npm 发包是 P1 的事，现在做只是拖慢开发。

任务级之所以能只靠编译，是因为**类型即契约**：往 `contract/` 加 import、hook 签名写错、事件名拼错，全都编译不过。编译是第一道也是最便宜的一道网。

### 6.2 四个检查点

| 检查点 | 覆盖的里程碑 | 批量验证内容 |
|---|---|---|
| **C1** | M1 契约 + 内核 | 跑**一组链语义测试**（一个大文件，一次覆盖：tier 嵌套顺序 / `next({...e})` 改写下行但不改自己的 `e` / 不调 `next` 即结束链 / 抛错被隔离且按名上报 / `tool.check` 无人应答 = deny）。**这是 MVP 唯一一处必须早做的测试**——链语义是看不见的，编译器抓不到它 |
| **C2** | M2 工具 + loop | 六个工具的测试**合并成一份文件**；外加一个 mock provider 的 E2E（脚本化 `tool_use` 序列 → 断言 transcript，不花 token）。工具测试与 E2E 一起跑 |
| **C3** | M3 cli 可用 | **手动跑一遍**真实场景，不写自动化。把 §8 的验收场景跑通即可 |
| **C4** | M4 收尾 | `pnpm lint` + 全量测试一次跑完；并把边界脚本**故意弄坏一次**确认它真会失败（只贴一份通过的日志不算数） |

**测试数量的账**（收尾时实际是 73 个，分布在 7 个文件）：契约与链语义 19、配置 18、工具 12、CLI 10（含参数与真跑 bin 的集成）、安全回归 7、SSE 解析 5、E2E 2。C2 那条"六个工具合并成一份文件"守住了；`provider.test.ts` 与 `safety.test.ts` 是收尾阶段补的 —— 前者的 SSE 解析器原本一个测试都没有，而它恰恰是唯一只有真 API 才走得到的代码；后者钉的是两轮独立评审查出的缺陷，每条都做过反向验证（把修复改回去，测试必须失败）。

**配置文件的坏输入必须吵**。`config.test.ts` 里那 8 条钉的是同一件事：配置读取只有"生效"和"大声报错"两种结局，**没有"安静地用默认值"**。JSON 语法错、顶层不是对象、字段类型不对 —— 抛，并带上路径；字段名拼错（`modle`）—— 点名，不静默忽略。静默失效是这类代码最坏的失败模式：用户以为配置生效了，实际一直在跑默认值，而且没有任何地方会告诉他。这和之前修掉的"Grep 静默跳过点文件"是同一类缺陷。

### 6.3 明确不做

- ❌ 覆盖率门槛
- ❌ 每个工具一个测试文件
- ❌ 每个事件一个测试用例
- ❌ 性能基准测试
- ❌ 契约事件名快照测试（改为：事件目录本身就写在一个文件里，肉眼可见，不需要快照锁）
- ❌ CI 流水线（MVP 阶段本地跑通即可，CI 推到 P1）

### 6.4 测试 harness（`test/harness.ts`，C1 时才需要）

只做两件事，不做通用框架：

- `createHarness({ coreImpls, engine, signal })` —— 返回 `{ on, dispatch, registry, warnings, debugLines }`。`on` 的签名是 `on(tier, plugin, pattern[, matcher], hook)`，所以测试要模拟某个插件时，可以精确指定它的座位与身份。`warnings` 收故障隔离的告警，让"抛错的 hook 被跳过并上报一次"这件事可断言；`debugLines` 收 `DEEPCODE_DEBUG` 那条调试轨迹（桩里一直开着），用于断言"这个事件被谁应答、谁被跳过了"。
- `scriptedProvider(script)` —— 脚本化模型响应（一串 `StreamEvent[]`，每个元素是一个 hop）。供 C2 的 E2E 用，不花 token、可确定性重放。

真实名词（`fs` / `process` / `store`）直接在 harness 里实例化使用，只有 `session` 需要桩（指向 temp 目录）。

---

## 7. 目录结构

```
DeepCode/
├── package.json  tsconfig.json  vitest.config.ts  README.md
├── bin/deepcode.mjs                可执行入口（转调 tsx）
├── scripts/check-boundaries.mjs    依赖边界检查
├── src/
│   ├── contract/     tier.ts · next.ts · model-provider.ts · plugin.ts
│   │                 engine.ts · events.ts · index.ts        ← 零 import
│   ├── core/
│   │   ├── dispatch.ts    链组装与执行（next 实现、故障隔离）
│   │   ├── registry.ts    hook 注册表、pattern/matcher 匹配
│   │   ├── create.ts      engine.create 折叠 + 插件准入
│   │   ├── loop.ts        agent loop
│   │   ├── errors.ts
│   │   └── nouns/         session · tool · command · model · fs · process
│   │                      store · clock · ui · logger
│   ├── providers/    anthropic.ts（实现 contract/model-provider）
│   ├── builtins/     tools/{read,write,edit,bash,glob,grep}.ts + tools/index.ts
│   │                 confirm.ts · commands.ts
│   └── cli/          main.ts · repl.ts · render.ts · prompt.ts · stream.ts · plugins.ts · turns.ts
│                     config.ts（两层配置文件的读取与合并）· args.ts（--help / --version）
├── test/             harness.ts · dispatch.test.ts · tools.test.ts · e2e.test.ts
│                     provider.test.ts（SSE 解析）· cli.test.ts（文本出口）· safety.test.ts（回归）
│                     config.test.ts（配置合并与坏输入）
└── docs/superpowers/{specs,plans}/
```

**工具链**：包管理器 **pnpm**（Node ≥ 20，ESM）。测试用 `vitest`，开发期运行用 `tsx`，类型检查用 `tsc --noEmit`，边界检查用 `scripts/check-boundaries.mjs`。二进制名 `deepcode`。**MVP 不引入 ESLint，也不设打包步骤**（见 §10 偏差 3、6）。

**目录组织借鉴 diff mod 的"一概念一文件夹"**：`$` 下每个名词一个文件；`builtins/tools/` 每个工具一个文件。文件内通常只有一个函数或一个类型，并附"为什么这么写"的注释。只有 `contract/index.ts` 与 `builtins/tools/index.ts` 两个 barrel —— 前者是契约的唯一出口，后者是"哪些工具属于 MVP"这一句话的落点。

---

## 8. MVP 验收标准

**一次性验收，不逐条卡。** 跑一次 `deepcode "给 utils.ts 里的 parseDate 加上时区处理"`，在一次会话里看完所有结果：

1. **闭环跑通**：读文件 → 改文件（弹 y/N）→ 跑测试命令 → 报告结果。
2. **顺手验三件事**（同一次会话里就能看到，不额外造场景）：Ctrl-C 能中断正在跑的 Bash；非 TTY 环境下写入被拒；`tool.check` 无人应答时结果是 deny。
3. **`pnpm test` + `pnpm lint` 一次跑完全绿**（依赖边界规则此时生效：往 `contract/` 里加 import 会红）。

---

## 9. 后续阶段计划

### 9.1 阶段间的三条硬约束

阶段顺序不是随意的：

1. **P2 必须在 P3 之前**。没有 `settings.read` 的来源优先级，`plugin.register` 准入闸门没有判定依据；没有"deny 携带规则名"，任何插件都能放宽策略。
2. **P3 必须在 P4 之前**。子代理 / 技能 / 命令本质上是"用约定目录承载插件组件"，扩展面没落地就没地方挂。
3. **P1 的 transcript 落盘必须在 P3 之前**。classic hooks 的 stdin 契约里 `transcript_path` 是一等字段，没有它 hook 拿不到上下文。

### 9.2 模块 × 阶段矩阵

| 模块 | **MVP** | **P1 会话与体验**（已完成） | **P2 安全与策略**（已完成） | **P3 扩展面**（已完成） | **P4 组合面**（已完成） | **P5 内建与分发**（已完成） | **P6 界面与交互**（已完成） | **P7 记忆与上下文**（已完成） | **P8 执行循环的收场**（已完成） | **P9 工具清单**（已完成）| **P10 子代理的边界**（已完成） |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `contract` | 39 事件全量冻结 | 补 `ui.*` 实现类型 | `settings`/`permissions` 类型 | `classic.*` 33 事件 **已完成**（只桥 3 个，见 P3 设计 §11 偏差 4） | `AgentSpec` 全字段 | — | — | — | `TurnReason` 七字面量（零 import）；`turn.complete.stopReason` 与 `AgentSpawnResult.stopReason` 从 `string` **收紧** **已完成** | `ToolNoun` 加 `origin(name)`（**契约变更**；`list()` 仍只是注册面）**已完成** | `AgentSpawnRequest` 声明化（`tools` → `allow`/`deny`）、`AgentSpawnResult` 从平坦结构改成**判别式联合**（`{ ok: false, reason }`）、`agent.spawn` 加必填 `depth`（**契约变宽**）**已完成** |
| **引擎内核** | 12 事件、2 层实落、`next` 全签名 | 座位算法完整版 | `next.to` 生效 + deny 重放 | `plugin.register` 准入闸门 **已完成** | — | — | — | — | 两层停止原因（步级 → 轮级的**唯一一处**翻译）、截断续写（≤ 3 次）、空步重提示、炸在中途保住半句 **已完成** | `core/tool-list.ts` —— 工具清单的**唯一算法**，模型 / `/help` / `/context` 三个消费者共用它；私有 `describeTools` 整段删掉 **已完成** | `core/nouns/agent.ts` 自己算面（面栈 + 名字栈）与**深度上限** —— 所有路径（`Task` / 插件直派）共用同一个数 **已完成** |
| **provider** | Anthropic 适配器 | OpenAI 兼容适配器 | gateway / `base_url` 收口 | — | — | — | — | — | — | — | — |
| **工具** | 6 个核心工具 | +TodoWrite/WebFetch/WebSearch | 按权限过滤工具可见性 **已完成**（只对整工具 deny 生效，见 P2 设计 §5.2） | MCP 桥接 | Task 工具（派子代理） | — | — | — | — | `/tools`（逐个工具：来源 + 描述，截 80 字符并当场说明模型拿到的是完整的）；`/help` 的工具那一行收敛到同一份 **已完成** | — |
| **权限安全** | 最小确认 y/N | — | 5 层来源 + allow/ask/deny（含 `Bash(git push:*)` 带参匹配）+ `sec-default` 守门器 + deny 带规则名（**不做重放**，见 P2 设计 §11 偏差 1）**已完成** | — | 沙箱（**仅 Bash**） | MDM 托管推送 | — | — | — | — | — |
| **指令文件** | — | CLAUDE.md 两层 | — | — | AGENTS.md 惰性嵌套 + 双层去重 | 五层优先级 + 托管下发 | — | 每轮重算 + 压缩边界上重装 **已完成** | — | — | — |
| **扩展面** | — | — | — | 拆 workspaces + `plugin.json` + 五类约定目录 + `${CLAUDE_PLUGIN_ROOT}` + `validate` 子命令 **部分完成**（`plugin.json` / 约定目录的发现与校验 / `${CLAUDE_PLUGIN_ROOT}` / `plugin list`·`validate` 都做了；**workspaces 没拆**，见 P3 设计 §11 偏差 3） | marketplace | 第三方插件生态 | — | — | — | — | — |
| **hooks** | — | — | — | classic hooks（stdin/stdout JSON · exit 0/1/2 · matcher · 按事件输出白名单） **部分完成**（前三项做了；`type:"prompt"` 与正则 matcher 不支持，输出只收阻断类字段 —— 没有 `additionalContext`/`updatedInput` 的着陆点，见 §11 偏差 2、4） | hookify DSL | — | — | — | — | — | — |
| **组合面** | — | 斜杠命令完备 | — | — | 子代理 + 技能 + `description` 路由 + 渐进式披露 + 模型分层 + 上下文隔离 | Agent SDK | — | — | 子代理按**白名单**判"没做完"（被截断的半截答复不再当完整结果交回父级）**已完成** | — | 子代理的工具面从"会话的全部"改成"**父级那一轮**的面"（`allow` 只能求交、`deny` 再减一道）；`resolveTools` 与插件里的 `MAX_DEPTH` 整段删掉 **已完成** |
| **会话** | 内存 transcript | 落盘 + `--resume` | — | — | 上下文压缩 | — | — | `/context` 账本 + 两道断电器 + `/compact <说明>`（含 `/clear` 游标修复）**已完成** | — | `/context` 账本把**工具清单**算进合计（新增一行「工具清单」，口径 = 系统提示 + 工具 + 消息）**已完成** | — |
| **UI** | 纯文本流 | cli 层自用 Ink 组件（spinner / diff / 确认框，**不走事件**） | — | `ui.render` 数据树 + `$.ui.resolve` 逐 surface 元素表（**渲染首次暴露为事件给插件**） | 多 surface | 桌面 / IDE 扩展 | 活动面 / 内容面 / 改动面 / 输入面 **已完成**（行内增强，UI 是**既有事件的观察者**；`ui.render` 数据树**仍未做**，理由见 P6 设计 §2.3） | — | 一次性模式退出码按白名单（除 `answer` 外一律非零，中断 130）**已完成** | — | "派子代理 X"改由 `agent.spawn` 事件驱动（内核只对真要开跑的那次派它）；"回来了"那条带上第几层 **已完成** |
| **内建 mod** | — | `/diff` 雏形 | — | — | telemetry 零自由文本行协议 | diff 分屏 + agents-md 范式 | — | 压缩边界上清去重表（重装那一半）**已完成** | — | — | telemetry 的 `agent.spawn` 记下 `depth`（一次递归在遥测里从此看得见层数）**已完成** |
| **CI 分发** | lint + test | — | — | 校验器进 CI | 硬化三件套 | 安装面 + gateway + CHANGELOG 产品面 | — | — | — | — | — |

> **P3 已完成（2026-10-11）**。实际交付这 5 项，逐条与偏差见 `2026-10-11-deepcode-p3-design.md` §11：
>
> 1. `plugin.json` 的校验器（E1–E14 / W1–W10）与 `deepcode plugin validate` / `plugin list` 两条子命令
> 2. 插件目录的发现与装载（用户级自动 / 项目级要 `plugins.enable`），两段式：发现不执行代码，装载才 `import`
> 3. `plugin.register` 从空壳变成准入闸门（`plugins.deny` 五层并集，第一方豁免）
> 4. classic hooks 的桥：`PreToolUse` / `SessionStart` / `SessionEnd` 三个事件，`hooks.json` → 链上注册
> 5. 第三方插件的能力上限在**结构上**钉死：座位强制 `append`、`allow` 一律剥掉、`uses` 越界整个插件不装
>
> P3 列里**没做**的三项，都在 §11 有理由：MCP 桥接（偏差 1）、`ui.render` 数据树
> （偏差 2，连带 `additionalContext`/`updatedInput` 没有着陆点）、`packages/*` workspaces
> （偏差 3 —— 插件的运行时代码一个 import 都不需要，物理分离要到"要发布"的 P5 才值钱）。
> 另外"校验器进 CI"这一格也没做：仍然没有 CI（见 §9.4 与 README「已知限制」）。

> **P1 已完成（2026-10-11）**。实际交付是这 8 项，详见 `2026-10-11-deepcode-p1-design.md` §1：
>
> 1. 会话落盘（JSONL，用户级）+ `--resume`
> 2. OpenAI 兼容 provider（配置切换）
> 3. `/diff` + 本会话改动记录
> 4. 表现原语：ANSI 调色板与单行 spinner
> 5. 同一轮多个工具结果合并成一条消息
> 6. 模型 id 形状校验 + API 404 翻成人话
> 7. 座位顺序显式化（同 tier 内按插件分组）
> 8. `ui.*` 八个事件的参数/结果类型（**只钉形状，仍不实现**）
>
> 矩阵里 P1 列属于"组合面"的"斜杠命令完备"由第 3 项（`/diff`、`/clear`）落地；
> P1 列里 **TodoWrite / WebFetch / WebSearch** 本轮未做（不在三条出口标准内，理由见 P1 设计 §1）。

### 9.3 各阶段出口标准

**与 MVP 同一口径**：出口标准按阶段批量验收，一个阶段一次，不拆到任务级、不写逐任务测试（见 §6.1）。

| 阶段 | 出口标准（可验证） |
|---|---|
| **MVP** | 见 §8 |
| **P1** | 重启后 `deepcode --resume` 能接着上次会话；TUI 下 `/diff` 能看到本会话的改动；OpenAI 兼容 provider 用配置切换可用 |
| **P2** | 个人插件无法放宽组织策略（`next.to` 只能向下跳，有测试证明）；每个判定路径都有明确的失败行为；deny 结果携带规则名且决策可重放 |
| **P3**（**已完成** 2026-10-11） | 一个**不改引擎**的插件能扩展出新的用户能力（`plugins/todo` 加出 `TodoWrite`，`src/` 里 grep 不到这个名字）；`deepcode plugin validate <dir>` 能拦住坏清单（E1–E14）；classic hook 的 exit 2 能真正阻断工具调用（`plugins/secret-guard`） |
| **P4** | 一个 `agents/*.md` 子代理能被 `description` 正确路由，且工具白名单生效（未列出的工具调用被拒） |
| **P5** | 三个内建 mod 全部通过各自测试套件，可选依赖缺失时主流程无损；CI 里 workflow 硬化校验器能在漏配 firewall runner 时让流水线失败 |
| **P6**（**已完成** 2026-10-11） | 四条（逐条判据见 `2026-10-11-deepcode-p6-design.md` §1）：① 执行过程中终端看得见每个工具的开始 / 结束 / 耗时 / 结果摘要，且同一条命令管道出去逐字节与 P6 之前相同；② 工具结果在终端被截断、回给模型的是完整原文（两条断言同时存在才算）；③ 这一阶段 `src/core/**` 没有行为改动（UI 是插件不是内核）；④ `NO_COLOR` / `TERM=dumb` / 拿不到宽度时全部降级为人话，不留残缺框线 |
| **P7**（**已完成** 2026-10-12） | 四条（逐条判据见 `2026-10-11-deepcode-p7-design.md` §1）：① `/context` 报得出这一轮上下文的构成（系统提示逐节 / 会话消息 / 阈值 / 上次实测），且**明说自己不知道模型窗口** —— 不报"还剩多少"；② `/compact <说明>` 的那段说明真的进了摘要那一轮；③ 压缩边界上被压掉的目录约定**重新附上**；④ 摘要连续失败 3 次、或连压 3 次仍超阈值 → **停手**，报一条可操作的错（不是每轮再试一次并刷屏） |
| **P8**（**已完成** 2026-10-12） | 四条（逐条判据见 `2026-10-12-deepcode-p8-design.md` §1）：① `turn.complete.stopReason` 只可能是七个产品字面量，端点的步级枚举（`end_turn` / `max_tokens` / `pause_turn`）**一个都到不了**；② 模型以 `max_tokens` 停下时循环把它接着往下写（≤ 3 次、每次出声），用尽仍被截断就以 `truncated` 收场并说清"上面那段是半截的"；③ 一次都不许凭空消失 —— 空步不再往对话里塞 `content: []` 的消息，流炸在中途时屏幕上显示过的那半句留在转录里；④ "没做完"在两侧都认得出：子代理把 `truncated` / `refusal` / `empty` 当异常回传，一次性模式下除 `answer` 外一律**非零退出码**（白名单，不是黑名单） |

| **P9**（**已完成** 2026-10-12） | 四条（逐条判据见 `2026-10-12-deepcode-p9-design.md` §1）：① `/context` 的账本把**工具清单**算上 —— 合计 = 系统提示 + 工具 + 消息，对不上就是账本算错（这一条在 P9 之前**自己违反自己**：实测某一轮真实发出去约 448 token，账本报 11）；② 一份清单三个消费者 —— 模型请求里带的那一份、`/help` 列的那一份、`/tools` 列的那一份出自**同一个函数**（`core/tool-list.ts`），不再各算各的；③ 「隐身」（子代理白名单外 / 被权限规则隐藏）与「故障」（插件没注册描述）在用户侧**分得开**，各自带原因，不合并成一句；④ 每个工具的**来源**可见（`$.tool.origin`），第一方插件与第三方插件报的是同一种东西 |
| **P10 子代理的边界**（**已完成** 2026-10-12） | 四条（逐条判据见 `2026-10-12-deepcode-p10-design.md` §1）：① **嵌套不再把面拿回来** —— 父级那一轮的模型可见面是 `{Task, Read}` 时，它派出的子代理（省略 `tools`）拿到的就是 `{Task, Read}`，不是会话全部（设计 §2.1 探针 A 实测：修之前外层 2 个、内层 8 个 = 会话全部）；② **深度上限对所有路径生效** —— 第三方插件直接 `$.agent.spawn` 的递归在第 4 层被**内核**拒，`Task` 与插件直派共用同一个数（探针 B 实测：修之前插件直派抵达 6 层、13 次模型请求，因为保险丝装在 `Task` 那条路径上）；③ **拒绝由内核给出、结果类型能表达它** —— `AgentSpawnResult` 有 `{ ok: false, reason }` 分支，理由带名字链与上限数字，插件把它翻成工具层的一次 `deny`，屏幕表现与之前一字不差；④ **三处口径收敛成一句** —— README / 契约注释 / P4a 设计对「省略 `tools` 继承什么」说的是同一件事（继承**父级那一轮的模型可见面**），P4a 里那句已经为假的断言有了可追的更正 |

### 9.4 明确不做（YAGNI）

以下能力**不在任何阶段的计划内**，除非出现真实需求：

- 多租户 / 团队协作 / 共享会话
- 自建 model gateway 服务端（P5 只做接入，不做实现）
- 移动端 / 桌面客户端（P5 的 UI 只到多 surface 抽象层）
- 遥测的 `collector` 备选目的地
- 插件 marketplace 的托管服务（P4 只做本地索引格式）

---

## 10. 已知偏差与存疑

**刻意的偏差**（与架构文档不一致，且是有意为之）：

1. **渲染不走 `ui.render`**。MVP 的 cli 层直接往 stdout 写流式文本。文档的 `ui.render` 返回纯数据树 + 逐 surface 元素表，是为了跨 terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。**仍未做** —— 见 `2026-10-11-deepcode-p6-design.md` §2.3：数据树的消费者到今天仍然只有一个。P6 兑现的是这条偏差的**实质**（渲染第一次真的对插件可见：界面成了既有事件的观察者），不是它的形式。
2. **单包不拆 workspaces**。见 §2.2。
3. **`settings` 名词不实现**。见 §3.5。
4. **工具清单硬编码在 `builtins/`，不走插件发现**。MVP 的 `builtins/` 是"用插件接口写的内建代码"，注册路径是硬编码调用，不是目录扫描。P3 才引入 `plugin.json` 与自动发现。
5. **`$` 的名词是直接实现，不是事件**。架构文档里 `$.<noun>.<method>()` 本身也是一次 dispatch（`OpEventOf`，59 个），内核是它的最内层实现。MVP 把这层省掉：`$.fs.read()` 直接读文件，不抛事件。代价是 P2 之前**无法在最内层拦截 `process.run`**（沙箱的落点）；收益是少写 59 个事件类型与一层间接。P2 做沙箱与 `settings.read` 保护时必须补上——这是 P2 的一项前期工作，不是可选项。
6. **不用 ESLint**。只保留边界检查脚本与 `tsc --noEmit`，不引入 ESLint 生态。真正的价值来自类型与边界，风格规则留到 P1。
7. **`engine.create` 折叠在 MVP 中是空转的**。`createEngine` 先折叠出 `$`，之后才逐个跑 `plugin.register` 准入。顺序不能反——`plugin.register` 的判定本身要经过链，而链要用 `$`；先注册后建 `$` 就成环了。代价是**没有任何插件能通过 `engine.create` 往 `$` 上加名词**。MVP 的八个插件都不加名词（工具只挂 `tool.call`，确认器只挂 `tool.check`），所以无害。但 P3 引入"插件扩展 `$`"时必须先解决这个先后顺序（可行方向：两趟注册，第一趟只收集 `engine.create` 的 hook，第二趟做准入）。在那之前，往 `engine.create` 上挂 hook 是**静默无效**的。
   **（P3 已部分收口）** 顺序问题**没解决**（两趟注册没做，本轮的两个实物插件都不需要新名词），
   但"静默无效"换成了**有声拒绝**：第三方插件往 `engine.create` 挂 hook 会被当场丢弃并告知，
   而不是挂上去、永远不跑、而插件以为自己扩展了 `$`。详见 `2026-10-11-deepcode-p3-design.md` §4.5
   与 §11 偏差 8 —— 这条是"把已知地雷换成有声拒绝"，不是"拆掉地雷"。

**已知缺陷（两轮收尾评审发现，判为 LOW，留到 P1）**：**（两条均已在 P1 修掉，修法见各条下的"P1 已修"）**

1. **一次 turn 里多个工具调用的结果会拆成多条 user 消息**，而不是合并成一条。`loop.ts` 每个 `tool_use` 推一条 `{role:'tool'}`，provider 各自转成一个 `user` 消息 —— 不会 400（Anthropic 会合并连续的同角色消息），但按官方的并行工具调用建议应当合并成一条。修法是让 `Message` 的 tool 形态支持一组结果。
   **（P1 已修）** 工具结果**合并进中立层**：`Message` 的 tool 形态改成 `{role:'tool', results:[...]}`，
   loop 里所有工具跑完之后推**一条**消息；落地时 Anthropic 转成一条带多个 `tool_result` 的 user 消息，
   OpenAI 按其协议拆成多条 `tool_call_id` 消息。合并只发生在我们自己的中立层，不是为了省 token。
2. **DEEPCODE_MODEL 之外没有模型校验**：模型 id 写错时错误来自 API 的 404，不是启动期就报。默认值已从疑似退役的 `claude-sonnet-4-5` 改为 `claude-sonnet-5-5`。
   **（P1 已修）** 模型 id 走"**启动期查形状 + 请求失败翻译 404**"：`resolveSettings` 只查形状
   （非空、不含空白字符），存在性仍交给端点 —— 两个 provider 非 2xx 时统一经 `providers/http.ts`
   把 404 或响应里的 `model_not_found` 之类翻成一句点名模型 id 的提示。不硬编模型清单。

**存疑（架构文档本身无法确认，需在本项目自行拍板）**：
| 主题 | 待拍板的内容 |
|---|---|
| 座位算法 | 同事件、同 tier 的多个 hook 之间的精确排序（注册顺序 vs 插件名）——文档只给出"同 plugin 先注册者最外层" |
| 预算数值 | `HOOK_BUDGET` 的 `10s / 1s` 取自文档，但不同工具（Bash 可能跑几分钟）需要更长的预算分层 |
| 工具超时 | Bash 的默认超时上限文档未给权威值 |
| 上下文压缩 | 完全不可见，P4 需自行设计触发阈值与压缩策略 |
| worker 批处理 | "共享同一 worker 的相邻 plugin 作为一个批次落座"未在类型契约中声明，MVP 不实现 |

**P2 的已知偏差（2026-10-11，与上面 MVP 那批同格式，逐条见 `2026-10-11-deepcode-p2-design.md` §11）**：

1. **不做 deny 重放。** 重放跑第二遍在启动期冻结的规则下必然得到与第一遍相同的答案，是装样子；改由 `sec-default` 直接把策略裁决拿在手里，比重放更强。
2. **`sec-default` 不读 `$.settings.read`，规则在启动期注入。** 管理员中途换策略在个人 CLI 上不是真实场景，启动期读一次更简单也更好测。
3. **`tool.check` 的规则不由内核求值，而由插件求值。** 为守住"内核里没有硬编码的工具表"这条线；代价是三条 `combine` 分支靠注释与测试维持，而不是靠类型。
4. **不做 `PermissionUpdate`（`/allow` 式写回 settings）。** 没有它，加一条 allow 规则得手改 JSON —— 本轮最大的便利性缺口，如实记下。
5. **`/help` 不反映工具隐藏。** 隐藏只作用于模型可见清单，那才是承重的那一份；被隐藏的工具由 `/permissions` 明确列出。
6. **策略层没有环境变量来源。** 一个环境变量就能改掉权限，等于在规则引擎上开后门；托管策略必须来自文件。

---

## 11. 关键文件索引（实现时对照）

| 本设计的章节 | 对应架构文档 |
|---|---|
| §1 原则 | `00-overview.md` §3；`01-engine-and-hooks.md` 启示 |
| §3 契约 | `01-engine-and-hooks.md` 关键抽象与接口 |
| §4.1 dispatch | `01-engine-and-hooks.md` 数据流 / 时序 B |
| §4.2 agent loop | `01-engine-and-hooks.md` 会话生命周期主序 |
| §5.2 fail-closed | `06-security-permissions.md`；`04-mod-telemetry.md` |
| §6 测试 | `01-engine-and-hooks.md` 测试工具链 |
| §7 目录 | `03-mod-diff.md` 一概念一文件夹 |
| §9.2 矩阵后三列 | `02`/`07`（扩展面与 hooks）、`06`/`10`（安全与分发）、`08`/`09`（组合面与 CI）、`03`/`04`/`05`（三个 mod 范式） |
