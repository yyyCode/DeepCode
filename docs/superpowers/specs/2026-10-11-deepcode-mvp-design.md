# DeepCode —— 最小可用 MVP 设计

> 状态：已评审 · 2026-10-11
> 依据：`claude-code-架构分析/` 全套 11 篇架构文档
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
| `turn.step` | 流式事件（`StreamHook`，async generator） | 流 |
| `turn.complete` | `{ usage, stopReason }` | `{}` |
| `tool.call` | `{ tool, input, toolUseId }` | `{ value }` \| `{ deny, reason }` |
| `tool.check` | `{ tool, input }` | `{ decision: 'allow' \| 'ask' \| 'deny', rule? }` |
| `tool.describe` | `{ tool }` | `{ description, inputSchema }` |
| `command.run` | `{ name, args }` | `{}` |

### 3.3 只声明、未实现的 27 个事件

`ui.render` / `ui.press` / `ui.input` / `ui.select` / `ui.message` / `ui.scroll` / `ui.focus` / `ui.resolve`、
`agent.offer` / `agent.spawn`、
`prompt.fill` / `prompt.suggest` / `prompt.edit` / `prompt.section` / `prompt.context` / `prompt.compose` / `prompt.attachment`、
`command.describe`、`config.set` / `config.describe`、`skill.prompt`、`attribution.text`、
`session.receive` / `session.compact` / `session.attach` / `session.detach` / `session.measure`、
全部 `classic.*`。

core 落到这些事件时抛 `NotImplementedError`，由 dispatch 捕获降级，**同一事件名只警告一次**。

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

> **`settings` 故意不做。** MVP 的配置只来自 CLI flag 与环境变量，不读任何设置文件。
> 这是刻意的：**没有 `settings.read`，就不存在"个人插件能不能放宽组织策略"这个问题**。
> 它在 P2 出现，且出现时会带着一整套来源优先级一起出现。

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
| `Read` | `$.fs` | 输出带行号；超长文件分段 |
| `Write` | `$.fs` | 先读后写校验（避免覆盖未读过的新文件） |
| `Edit` | `$.fs` | 精确字符串替换，要求 `old_string` 唯一 |
| `Bash` | `$.process` | 超时 + 输出截断上限；`AbortSignal` 贯穿以支持 Ctrl-C |
| `Glob` | `$.fs` | 路径模式匹配 |
| `Grep` | `$.fs` | 正则内容搜索，输出 `路径:行号: 内容` |

**六个工具都必须依赖 `$` 名词而非直接 `fs` / `child_process`**。这既是可测性的前提（测试里 mock `$.fs`），也是 P2 权限过滤与沙箱的前提（内核可以在最内层拦截 `process.run`）。

---

## 5. 错误处理

### 5.1 六类失败，每条都有明确去向

| 失败类别 | 处理 |
|---|---|
| hook 抛错 / 超时 | 隔离跳过，下层照跑，按插件名警告一次（`HOOK_BUDGET`） |
| 工具执行失败（Bash 非零退出、文件不存在） | **不抛**。包装成 `tool_result{ is_error: true }` 回灌模型——工具失败是给模型的信息，不是崩溃 |
| provider 网络错 / 限流 | 退避重试 1 次；再失败则结束本 turn 并保留会话，不退出进程 |
| 事件未实现 | `NotImplementedError`，dispatch 捕获降级；同一事件名只警告一次 |
| 用户 Ctrl-C | `AbortSignal` 贯穿 `next.signal`，同时掐断 provider 流与 Bash 子进程 |
| 契约漂移 | 编译期抓（单一契约文件 + lint 边界） |

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
| **C4** | M4 收尾 | `pnpm lint` + 全量测试一次跑完 |

### 6.3 明确不做

- ❌ 覆盖率门槛
- ❌ 每个工具一个测试文件
- ❌ 每个事件一个测试用例
- ❌ 性能基准测试
- ❌ 契约事件名快照测试（改为：事件目录本身就写在一个文件里，肉眼可见，不需要快照锁）
- ❌ CI 流水线（MVP 阶段本地跑通即可，CI 推到 P1）

### 6.4 测试 harness（`test/harness.ts`，C1 时才需要）

只做两件事，不做通用框架：

- `createHarness({ coreImpls, engine, signal })` —— 返回 `{ on, dispatch, registry, warnings }`。`on` 的签名是 `on(tier, plugin, pattern[, matcher], hook)`，所以测试要模拟某个插件时，可以精确指定它的座位与身份。`warnings` 收故障隔离的告警，让"抛错的 hook 被跳过并上报一次"这件事可断言。
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
│   └── cli/          main.ts · repl.ts · render.ts · prompt.ts
├── test/             harness.ts · dispatch.test.ts · tools.test.ts · e2e.test.ts
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

| 模块 | **MVP** | **P1 会话与体验** | **P2 安全与策略** | **P3 扩展面** | **P4 组合面** | **P5 内建与分发** |
|---|---|---|---|---|---|---|
| `contract` | 39 事件全量冻结 | 补 `ui.*` 实现类型 | `settings`/`permissions` 类型 | `classic.*` 33 事件 | `AgentSpec` 全字段 | — |
| **引擎内核** | 12 事件、2 层实落、`next` 全签名 | 座位算法完整版 | `next.to` 生效 + deny 重放 | `plugin.register` 准入闸门 | — | — |
| **provider** | Anthropic 适配器 | OpenAI 兼容适配器 | gateway / `base_url` 收口 | — | — | — |
| **工具** | 6 个核心工具 | +TodoWrite/WebFetch/WebSearch | 按权限过滤工具可见性 | MCP 桥接 | Task 工具（派子代理） | — |
| **权限安全** | 最小确认 y/N | — | 5 层来源 + allow/ask/deny（含 `Bash(git push:*)` 带参匹配）+ `sec-default` 守门器 + deny 带规则名且可重放 | — | 沙箱（**仅 Bash**） | MDM 托管推送 |
| **指令文件** | — | CLAUDE.md 两层 | — | — | AGENTS.md 惰性嵌套 + 双层去重 | 五层优先级 + 托管下发 |
| **扩展面** | — | — | — | 拆 workspaces + `plugin.json` + 五类约定目录 + `${CLAUDE_PLUGIN_ROOT}` + `validate` 子命令 | marketplace | 第三方插件生态 |
| **hooks** | — | — | — | classic hooks（stdin/stdout JSON · exit 0/1/2 · matcher · 按事件输出白名单） | hookify DSL | — |
| **组合面** | — | 斜杠命令完备 | — | — | 子代理 + 技能 + `description` 路由 + 渐进式披露 + 模型分层 + 上下文隔离 | Agent SDK |
| **会话** | 内存 transcript | 落盘 + `--resume` | — | — | 上下文压缩 | — |
| **UI** | 纯文本流 | cli 层自用 Ink 组件（spinner / diff / 确认框，**不走事件**） | — | `ui.render` 数据树 + `$.ui.resolve` 逐 surface 元素表（**渲染首次暴露为事件给插件**） | 多 surface | 桌面 / IDE 扩展 |
| **内建 mod** | — | `/diff` 雏形 | — | — | telemetry 零自由文本行协议 | diff 分屏 + agents-md 范式 |
| **CI 分发** | lint + test | — | — | 校验器进 CI | 硬化三件套 | 安装面 + gateway + CHANGELOG 产品面 |

### 9.3 各阶段出口标准

**与 MVP 同一口径**：出口标准按阶段批量验收，一个阶段一次，不拆到任务级、不写逐任务测试（见 §6.1）。

| 阶段 | 出口标准（可验证） |
|---|---|
| **MVP** | 见 §8 |
| **P1** | 重启后 `deepcode --resume` 能接着上次会话；TUI 下 `/diff` 能看到本会话的改动；OpenAI 兼容 provider 用配置切换可用 |
| **P2** | 个人插件无法放宽组织策略（`next.to` 只能向下跳，有测试证明）；每个判定路径都有明确的失败行为；deny 结果携带规则名且决策可重放 |
| **P3** | 一个**不改引擎**的插件能扩展出新的用户能力；`deepcode plugin validate <dir>` 能拦住坏清单；classic hook 的 exit 2 能真正阻断工具调用 |
| **P4** | 一个 `agents/*.md` 子代理能被 `description` 正确路由，且工具白名单生效（未列出的工具调用被拒） |
| **P5** | 三个内建 mod 全部通过各自测试套件，可选依赖缺失时主流程无损；CI 里 workflow 硬化校验器能在漏配 firewall runner 时让流水线失败 |

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

1. **渲染不走 `ui.render`**。MVP 的 cli 层直接往 stdout 写流式文本。文档的 `ui.render` 返回纯数据树 + 逐 surface 元素表，是为了跨 terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。P3 补上。
2. **单包不拆 workspaces**。见 §2.2。
3. **`settings` 名词不实现**。见 §3.5。
4. **工具清单硬编码在 `builtins/`，不走插件发现**。MVP 的 `builtins/` 是"用插件接口写的内建代码"，注册路径是硬编码调用，不是目录扫描。P3 才引入 `plugin.json` 与自动发现。
5. **`$` 的名词是直接实现，不是事件**。架构文档里 `$.<noun>.<method>()` 本身也是一次 dispatch（`OpEventOf`，59 个），内核是它的最内层实现。MVP 把这层省掉：`$.fs.read()` 直接读文件，不抛事件。代价是 P2 之前**无法在最内层拦截 `process.run`**（沙箱的落点）；收益是少写 59 个事件类型与一层间接。P2 做沙箱与 `settings.read` 保护时必须补上——这是 P2 的一项前期工作，不是可选项。
6. **不用 ESLint**。只保留边界检查脚本与 `tsc --noEmit`，不引入 ESLint 生态。真正的价值来自类型与边界，风格规则留到 P1。
7. **`engine.create` 折叠在 MVP 中是空转的**。`createEngine` 先折叠出 `$`，之后才逐个跑 `plugin.register` 准入。顺序不能反——`plugin.register` 的判定本身要经过链，而链要用 `$`；先注册后建 `$` 就成环了。代价是**没有任何插件能通过 `engine.create` 往 `$` 上加名词**。MVP 的八个插件都不加名词（工具只挂 `tool.call`，确认器只挂 `tool.check`），所以无害。但 P3 引入"插件扩展 `$`"时必须先解决这个先后顺序（可行方向：两趟注册，第一趟只收集 `engine.create` 的 hook，第二趟做准入）。在那之前，往 `engine.create` 上挂 hook 是**静默无效**的。

**存疑（架构文档本身无法确认，需在本项目自行拍板）**：

| 主题 | 待拍板的内容 |
|---|---|
| 座位算法 | 同事件、同 tier 的多个 hook 之间的精确排序（注册顺序 vs 插件名）——文档只给出"同 plugin 先注册者最外层" |
| 预算数值 | `HOOK_BUDGET` 的 `10s / 1s` 取自文档，但不同工具（Bash 可能跑几分钟）需要更长的预算分层 |
| 工具超时 | Bash 的默认超时上限文档未给权威值 |
| 上下文压缩 | 完全不可见，P4 需自行设计触发阈值与压缩策略 |
| worker 批处理 | "共享同一 worker 的相邻 plugin 作为一个批次落座"未在类型契约中声明，MVP 不实现 |

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
