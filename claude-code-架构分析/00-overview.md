# Claude Code 架构分析总览

> 目标：为**从零复刻一个同类 agentic 编码工具**提供一份可直接施工的架构说明书。
> 本文是索引与总纲；每个功能模块的细节在各自的子文档中。

---

## 0. 先说清楚：我们分析的是什么

`F:\ts\claude-code` 是公开仓库 `anthropics/claude-code`。它**不是引擎源码**——CLI 本体是闭源发布的二进制。这个仓库实际交付的是三类「外壳」资产：

| 资产 | 路径 | 为什么它对复刻最有价值 |
|---|---|---|
| **引擎的完整公开契约** | `mods/types/claude-code.d.ts`（13,186 行，507 KB） | 全仓库唯一的「引擎 API 事实源」：`$`（`EngineInterface`）、全部事件名、hook 链语义、设置类型。复刻的接口设计可直接对标它。 |
| **四个内建 mod 的完整源码** | `mods/{diff,telemetry,agents-md,sec-default}/`（共 ~1,290 文件） | 真实、可编译、带测试的生产级插件实现。这是「引擎如何被使用」的活教材。 |
| **十三份官方插件 + 示例 + CI** | `plugins/`、`examples/`、`.github/`、`scripts/` | 展示扩展面（命令/代理/技能/hook/MCP）、企业部署（gateway/MDM/sandbox）、CI 硬化范式。 |

**因此本套文档的分析口径是：**「引擎对外暴露了什么契约 + 四个内建 mod 如何真实使用它 + 官方插件与示例展示了哪些用法」。引擎内部的调度器、API 客户端、上下文压缩算法等**不可见**部分，只能从类型契约的 JSDoc 与行为测试反推——所有这类推断都在子文档的「存疑与待确认」中显式标注，**不冒充事实**。

### 分析过程中发现的「文档—实现漂移」（复刻时以代码/类型为准）

这些是本仓库文档与实际代码不一致的地方，恰恰是复刻时最容易踩空之处：

1. **插件数量**：`plugins/README.md` 与 marketplace 声称 15 个，实际 **13** 个。
2. **`plugins/plugin-dev/` 无清单**：它被列进 marketplace，却没有 `.claude-plugin/plugin.json`。
3. **classic hook 事件数**：官方 hook 开发文档与校验脚本只认 **9** 个事件；引擎类型契约 `HookInput` 联合定义了 **33** 个。
4. **`plugins/code-review/agents/*.md` 不存在**：README 宣称的「5 个并行 Sonnet 代理」实为**命令内联编排**（`plugins/code-review/commands/code-review.md`）。
5. **`security-guidance` 的安全模式**：文档说 9 个，代码 `patterns.py` 实为 **25** 个。
6. **`SKILL.md` 的 `allowed-tools` 字段**：作者指南写了，但仓库内**无任何**实际用例，引擎类型中亦不可证实。

> 通用教训：**运行时类型定义（`.d.ts`）才是单一事实源**；README 与技能文档是「意图描述」，会滞后。复刻产品时应把校验器（validator）内置，让漂移在 CI 中失败。

---

## 1. 文档索引

| # | 文档 | 覆盖模块 | 一句话 |
|---|---|---|---|
| — | **[本文 00-overview.md](00-overview.md)** | 总纲 | 模块地图、跨模块设计原则、复刻路线图 |
| 01 | [01-engine-and-hooks.md](01-engine-and-hooks.md) | **引擎内核与 hook 链** | `$` 接口、`on(event, handler)`、39+ 事件目录、`next(e)` 中间件语义、`engine.create` 折叠、名词 DI、tier 权威序、测试套件 |
| 02 | [02-plugin-system.md](02-plugin-system.md) | **插件系统** | `plugin.json` 最小清单、五类约定目录（commands/agents/skills/hooks/MCP）、marketplace、自动发现、`${CLAUDE_PLUGIN_ROOT}`、validator |
| 03 | [03-mod-diff.md](03-mod-diff.md) | **内建 mod：`diff`** | `/diff` 分屏、git 后端抽象与探针、文件分类、性能闸、不可变 PaneModel + JSX 视图、一概念一文件夹 |
| 04 | [04-mod-telemetry.md](04-mod-telemetry.md) | **内建 mod：`telemetry`** | 名词 DI 提供者、tier 门禁、零自由文本行协议、批量/重试/丢弃、隐私 fail-closed、退出开关每批重读 |
| 05 | [05-mod-agents-md.md](05-mod-agents-md.md) | **内建 mod：`agents-md`** | `AGENTS.md` 作为项目指令文件、五层优先级、惰性嵌套加载与去重、字节级框架复刻、单一枚举选项 |
| 06 | [06-security-permissions.md](06-security-permissions.md) | **安全、权限与托管** | `sec-default` 零策略守门器、`TIERS` 权威序、deny 规则重放、设置优先级、权限模式、沙箱、MDM（macOS/Windows） |
| 07 | [07-hooks-system.md](07-hooks-system.md) | **classic hooks 系统** | JSON 配置、33 事件全集、stdin/stdout 命令契约、exit 0/1/2 与结构化 JSON 双阻断、matcher、hookify DSL |
| 08 | [08-agents-and-skills.md](08-agents-and-skills.md) | **子代理 / 技能 / 命令 / SDK** | frontmatter 三套 schema、`description` 即路由、工具与模型分层、上下文隔离、渐进式披露、`$ARGUMENTS` 插值 |
| 09 | [09-ci-and-automation.md](09-ci-and-automation.md) | **CI 与仓库自动化** | `claude-code-action`、三件套安全硬化 + 校验器、issue 生命周期状态机、最小权限 `permissions:` |
| 10 | [10-enterprise-and-surface.md](10-enterprise-and-surface.md) | **企业分发与产品面** | LLM gateway（Bedrock/Vertex）、`gateway.yaml`、terraform 双轨、devcontainer 防火墙沙箱、CHANGELOG 作为产品面 |

**推荐阅读顺序（按复刻施工顺序）：**
`01`（先懂事件链）→ `02`+`07`（扩展面与用户自动化）→ `06`（安全骨架，必须早做）→ `08`（代理组合面）→ `03/04/05`（三个真实 mod 的实现范式）→ `09`+`10`（分发与运营）。

---

## 2. 整体架构地图

```
┌──────────────────────────────────────────────────────────────────────┐
│ 用户表面 Surfaces                                [10][09]            │
│ 终端 CLI · IDE 扩展(VSCode/JetBrains) · GitHub @claude · Agent SDK   │
├──────────────────────────────────────────────────────────────────────┤
│ 代理组合面 Agent-composition                     [08]                │
│ Subagents(agents/*.md) · Skills(SKILL.md) · Slash Commands(commands)│
├──────────────────────────────────────────────────────────────────────┤
│ 扩展层 Extensions                                [02]                │
│ plugin.json + 5 类约定目录 + marketplace + ${CLAUDE_PLUGIN_ROOT}     │
│   ├── classic hooks（JSON → 外部命令/提示）      [07]                │
│   └── mods（进程内 function-hooks，TypeScript）  [03][04][05][06]    │
├──────────────────────────────────────────────────────────────────────┤
│ 引擎内核 Engine core                             [01]                │
│ $ (EngineInterface) · on(event, $,e,next) · 事件目录 · tier 链        │
│ engine.create 折叠 → 构建 $ → 名词依赖注入（noun DI）                 │
├──────────────────────────────────────────────────────────────────────┤
│ 策略与配置 Policy                                 [06]                │
│ settings 优先级(user<project<local<flag<policy>) · permissions       │
│ · sandbox · managed settings / MDM                                   │
├──────────────────────────────────────────────────────────────────────┤
│ 分发与运营 Distribution                          [09][10]             │
│ CI headless · egress firewall · LLM gateway · devcontainer           │
└──────────────────────────────────────────────────────────────────────┘
```

**一句话架构**：引擎在每个调用点抛出一个事件，所有插件（含内建 mod）把自己的 hook 注册成中间件，按固定的**权威层级（tier）** 串成一条链；一个 hook 可以**应答 / 改写 / 拒绝 / 委托下层**。引擎自己站在链的**最内层**——因此**几乎每个 API 调用本身也是一个可被观察、改写、拒绝的事件**。这是整套产品最核心的一个设计决策。

---

## 3. 跨模块共性设计原则（复刻时的「承重墙」）

以下 12 条在多个子文档中反复出现，是这套架构真正的「内功」。

1. **先定事件目录，再定 API**（[01]）。先冻结 `<noun>.<verb>` 事件表与每个事件的 `Args`/`Result` 映射，再写链。否则后期返工。
2. **`next(e)` 是 Koa 式续体，不是事件发射器**（[01]）。不调 `next` = 结束链并应答；调 `next(e)` = 带改写下行。配套 `next.to(tier)`（只能向权限更低方向跳）、`next.signal`（中止）、`next.trace`（可观测）、`next.budget`（限时）、`.catch` 兜底。
3. **tier 是一等公民**（[01][06]）。固定顺序 `prepend > user > append > builtin > core`，「越外越权威」+「只能向下跳」。组织策略压过个人插件，靠的就是这三条规则，而**不牺牲可组合性**。
4. **名词 DI = 折叠 + 声明合并 + withhold**（[01][04]）。加载期一次 `engine.create` 折叠构建 `$`；名词类型由提供者用一份**无 import 的 `.d.ts`** 对外声明；`withhold` 是安全能力（组织可让某名词对个人插件不可见）。
5. **一份契约，禁止复制**（[01][04]）。用 tsconfig `include` 覆盖各 mod 的 `*/types/**/*.d.ts`；调用方按路径导入同一份契约。实现漂移在**编译期**被抓住。
6. **可选依赖必须静默降级**（[03][04][05]）。`safely()` / fire-and-forget 模式：遥测、外部后端等「有则更好」的能力缺失时，主流程照常。
7. **安全默认 = 零策略守门器**（[06]）。`sec-default` 只做三个动作（`next.to("append")` / 按名拒绝 / 放行），绝不改写、绝不新增策略。策略放 managed settings。**职责极小 → 可形式化验证 → 与策略演进解耦。**
8. **失败方向一律指向更安全（fail-closed）**（[04][06]）。读策略失败 = 策略存在；门禁抛错 = 拒绝；无来源 = 拒绝。每条「读配置 / 判定」路径都必须写明「失败时怎么办」。
9. **协议做小做稳，DSL 做成插件**（[07]）。classic hook 契约小到「十行代码可实现」；`hookify` 的规则 DSL 是建立在它**之上**的一层插件。底层稳定，体验层独立演进。
10. **配置随会话加载、数据每次重读**（[07]）。这是「改配置无需重启即时生效」这一产品特性的实现基础；代价是 hook 间并行无序、互不可见，需要协作就**落盘状态文件**。
11. **`description` 即路由 API**（[08]）。代理/技能的触发完全靠自然语言描述（无结构化触发字段）。灵活但概率性——产品层必须给出可诊断工具（「为什么这个代理没触发」）与质量校验。
12. **把安全约定变成会失败的检查**（[06][09]）。根 `CLAUDE.md` 的三件套（防火墙 runner + allow list + `--permission-mode auto`）由 `.github/scripts/check_workflow_hardening.py` 强制，豁免必须登记在表里。**纪律自动化 > 单点配置。**

---

## 4. 复刻路线图（建议施工顺序）

按依赖关系，分五期。每期都标注对应子文档。

### 第 1 期 · 骨架：事件链与 `$`
先实现「引擎调用点 → 事件 → 中间件链 → 应答」的最小闭环。
- 定义 `$`（`EngineInterface`）与 20~40 个核心事件 + 其 `Args`/`Result` 类型（[01]）。
- 实现 `on(event, handler)` 注册与 `next(e)` 链语义、`TIERS` 权威序、`next.to` 只能向下跳（[01]）。
- 实现 `engine.create` 折叠与名词 DI（[01][04]）。
- 同时建好测试套件：`tier()` + `mock` + 「引擎的 `$` + 下层 `on`」harness（[01]）。
> 验收：能写一个只依赖 `next(e)` 的最小 mod，且测试可覆盖真实链语义。

### 第 2 期 · 安全与策略（**不要延后**）
安全是一等架构，不是插件。
- 实现 settings 来源优先级 `user<project<local<flag<policy>` 与权限模式（[06]）。
- 实现 `permissions` allow/ask/deny 规则模型；deny 结果必须**携带规则名**且决策可**重放**（[06]）。
- 实现 `sec-default` 式最外层守门器：`$$.settings.read({source:'policy'})` + fail-closed（[06]）。
- 实现沙箱与工具权限的**分离**设计，并如实标注覆盖范围（沙箱仅作用于 Bash）（[06]）。
> 验收：个人插件无法放宽组织策略；每个判定路径都有明确的失败行为。

### 第 3 期 · 扩展面
- 插件包：`.claude-plugin/plugin.json` 最小清单（仅 `name` 必填）+ 五类约定目录自动发现 + `${CLAUDE_PLUGIN_ROOT}` 三处一致展开（[02]）。
- classic hooks：stdin/stdout JSON 契约、exit 0/1/2 与结构化 JSON 双阻断、matcher、按事件的输出白名单（[07]）。
- 代理/技能/命令三套 frontmatter + `$ARGUMENTS` 插值 + 工具与模型分层 + 上下文隔离（[08]）。
- 内置 `validate` 子命令（对照 `claude plugin validate`）（[02]）。
> 验收：`01` 期的事件链能被一个不改引擎的插件扩展出新的用户能力。

### 第 4 期 · 首批内建功能（照抄三个真实 mod 范式）
- `diff` 类：分屏 UI + 后端抽象 + 性能闸 + 不可变模型 + 一概念一文件夹（[03]）。
- `telemetry` 类：名词提供者 + 零自由文本行协议 + 批量发送 + 隐私开关每批重读（[04]）。
- `agents-md` 类：分层指令文件 + 惰性嵌套加载 + 交给宿主渲染（[05]）。
> 验收：三个 mod 全部通过各自测试套件；可选依赖缺失时主流程无损。

### 第 5 期 · 分发与运营
- 安装面：推荐一个渠道、兜底多个、明确弃用旧渠道（[10]）。
- 企业：LLM gateway 收口点（`upstreams[]` + `auth:{}` + 服务端盖章审计 + `public_url` 一级契约）（[10]）。
- 沙箱 devcontainer：iptables 默认 DROP + ipset 白名单 + 启动自检（[10]）。
- CI 集成 + 安全硬化校验器（[09]）。
- 变更日志作为**机器可发布的产物**（分类动词 + 原子发布源）（[10]）。

---

## 5. 跨文档的关键存疑（复刻前需自行拍板的地方）

这些是仓库**看不到**、需要复刻者自己做决策的点，汇总自各子文档的「存疑与待确认」：

| 主题 | 无法从本仓库确认的内容 | 出处 |
|---|---|---|
| 引擎内部 | 事件调度器、API 客户端、上下文压缩、worker/批处理实现；契约标注为早期访问、版本间可变 | [01] |
| 座位算法 | `prependPlugins` 合并、CLI 侧 mod 落座算法只在 `README` 描述，无实现 | [01][06] |
| 加载机制 | manifest → `.ts` 模块的发现与加载机制无正式定义 | [01][02] |
| 遥测出口 | `INGEST_URL` 硬编码；`collector` 目的地处理器在仓库外；无独立 redaction 模块（隐私全靠协议） | [04] |
| 指令文件 | 引擎 `claudeMd` 的确切框架字符串仅由测试锁定，不在 `.d.ts` 契约中 | [05] |
| 沙箱/权限 | 沙箱、auto 模式、服务端托管设置的内部实现仅在散文文档中 | [06] |
| classic hooks | `timeout` 上限/默认值、`SessionStart.source` 各分支、hook 权限继承语义无权威文档 | [07] |
| 代理字段 | `effort`/`memory`/`isolation` 等 `AgentSpec` 字段在文件级无用例佐证键名 | [08] |
| gateway | 权威配置参考与 `claude gateway` 实现都在仓库外；仅 ECS-Fargate / Cloud Run 有实现 | [10] |
| 客户端 MDM 推送 | `examples/` 中**不存在**客户端侧 MDM push 产物，脚本显式推迟到 walkthrough | [10] |

---

## 6. 如何使用这套文档

- **做架构决策时**：读 `01` 的「关键抽象与接口」与「设计决策与权衡」——事件链与 tier 是全局承重墙。
- **写代码前**：每个子文档末尾的「对复刻产品的启示」是一份**可直接执行的设计清单**，逐条对应到你的模块。
- **对齐接口时**：以 `mods/types/claude-code.d.ts` 为蓝本定义你自己的类型契约，并复刻「一份契约、禁止复制」的 tsconfig 约束。
- **做安全评审时**：以 `06` 的 10 条启示为 checklist；尤其第 1、3、4 条（来源钉死、fail-closed、deny 可重放）是其他一切安全保证的前提。
- **验证时**：对照各文档「关键文件索引」中的路径回查原始实现，不轻信本套文档的转述。

---

## 附录：仓库资产速查

| 路径 | 内容 |
|---|---|
| `mods/types/claude-code.d.ts` | 引擎全量类型契约（13,186 行）——**最重要的一份文件** |
| `mods/{diff,telemetry,agents-md,sec-default}/` | 四个内建 mod 的完整源码 + 测试 |
| `mods/README.md` | mod/hook 模型、noun 契约、测试套件说明 |
| `plugins/`（13 个） | 官方插件：命令/代理/技能/hook/MCP 各类范例 |
| `.claude-plugin/marketplace.json` | 插件 marketplace 索引 schema |
| `examples/{settings,mdm,hooks,gateway}/` | 设置、托管部署、hook 示例、企业 gateway |
| `.github/{workflows,scripts}` + `CLAUDE.md` | CI 集成与安全硬化 |
| `scripts/` | issue 生命周期自动化（Bun 脚本） |
| `CHANGELOG.md` + `feed.xml` | 产品面演进记录（418 个版本段落） |
