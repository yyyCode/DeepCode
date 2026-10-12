# 13 · 工具系统：来源、注册、选择与权限提示

> 范围：本仓库中可读到的「工具」这一模块的完整面：工具怎么被定义与存储、本地与远程（MCP）两种来源怎么接进来、模型与系统各按什么规则挑选工具、哪些调用会问人而哪些不问、以及工具多到塞不下时怎么办。
> 论证口径同全套文档：**`mods/types/claude-code.d.ts` 的类型契约是单一事实源**；其次是 `CHANGELOG.md`（418 个版本段，**无日期**）给出的行为演进；再次是 `mods/`、`plugins/`、`examples/` 的实际用法；引擎内部（只读识别、沙箱放行、auto 分类器、prompt 里 tool 定义怎么拼）**不可见**，凡属推断或查无实据的一律进文末「存疑与待确认」。
> 本文与相邻篇的分工：工具调用的**控制流位置**（`tool.call` → `tool.check` → core，两条结果通道）见 [12]；工具策略的**组织面**（`sec-default` 守门器、settings 优先级、沙箱、MDM）见 [06]；子代理/技能的**工具限制语义**见 [08]。本文只讲工具本身。

---

## 定位

### 一句话

**工具没有磁盘注册表。** 一个工具在本系统里是「模型的一次可选动作」——一个**名字**、一句**描述**、一份 **JSON schema**，加一个**宿主钉死的提供者**；它的定义在**运行时**由声明产生，它的能力在**进程内**由 core 或一台 MCP 服务器提供。

### 「工具」在这里的三层含义

| 层 | 形态 | 存在何处 |
|---|---|---|
| **内置工具** | 编进二进制；定义以 TS 接口形式写进契约 | `BuiltinToolInputs` / `BuiltinToolResults`（`claude-code.d.ts:12378-13170`） |
| **MCP 工具** | 一台本地子进程或远程服务声明的工具 | 服务器侧，「配置」落在 `.mcp.json`、settings、CLI flag、agent frontmatter |
| **插件注册的工具** | 插件在运行时用 `$.tool.register` 声明、用自己的 `tool.call` hook 应答 | 进程内，无落盘（`claude-code.d.ts:2609`） |

注意第三种工具**借用 MCP 的命名空间**：`$.tool.register` 的文档说清「模型从下一个 prompt 起可以调用的名字是 `mcp__<plugin>__<name>`」（`:2594-2605`）。也就是说不存在「插件工具」这个独立前缀。

### 一个工具的定义面有多薄

契约里**唯一**一份完整的工具定义类型是 `ToolSpec`（`:10158-10174`），只有三个字段：

```ts
export type ToolSpec = {
    name: string;                              // 字母/数字/_/-，≤64
    description: string;                       // 给模型读的
    inputSchema?: Record<string, unknown>;     // JSON schema，默认 { type: "object" }
};
```

**没有** read-only 标志、没有并发安全标志、没有 enabled/alias/prompt 文本。`$.tool.list()` 返回的 `ToolInfo`（`:10081-10095`）更薄——只有 `name`、`description`、一个布尔 `mcp`，**连 schema 都不给**。

读一条工具的结果（`ToolCallResult`）里**确实**带 per-call 的只读标记（见下文 F 节），但它不在公开契约里。这个「定义面极薄」是需要刻意维持的设计，不是遗漏。

### 仓库里真的没有工具清单文件

`plugins/**` 下只有 `.claude-plugin/plugin.json`、`agents/`、`commands/`、`hooks/`、`skills/`——**没有 `tools/` 目录，`plugin.json` 与 `marketplace.json` 也没有 `tools` 键**。内置工具的 TS 定义由 `/plugin-types` 从各工具自身的 JSON schema 生成（`:766`、`:786-792`、`:12375`），是**投影**而非本源。

### 也不是什么

| 常见做法 | 本系统 |
|---|---|
| 工具登记在 manifest / 目录里，启动时扫描 | ❌ 无落盘注册表；内置在二进制，插件在运行期 `$.tool.register` |
| 工具有分类/分组原语（`category`、`group`） | ❌ 契约里没有任何分组类型；靠名字寻址 |
| 用名字前缀判断来源可信度（`mcp__` ⇒ 外部） | ❌ 契约明说「Key trust on `source`, not on the name or the tool-name prefix」（`:4965`） |
| 工具带「只读」标志，只读即自动放行 | ⚠️ 只读是**按调用**由引擎判的，且**未在契约中声明**（`mods/diff/hooks/tools/may-have-written.ts:8-22`） |
| 工具太多就砍掉一批 | ❌ 不砍，**藏起来**（`ToolSearch` / `isDeferred`），按需取回 |

---

## 职责与边界

### 引擎负责

- 维护会话的工具列表（内置 + MCP + 插件注册），并按**模型看到的顺序**列出（`$.tool.list()` 文档 `:2562-2564`）。
- 在**首次**把某个工具的 schema 渲染给模型时抛一次 `tool.describe`，接受改写（描述文本、`isDeferred` 位置）。
- 命名空间与命名合法性（`mcp__${string}__${string}`）、名字长度上限。
- 每次调用的权限判定（`tool.check`，见 [12]/[06]）、执行（core）、批次并发与收口（`PostToolBatch`，`:6344-6349`）。
- MCP 的连接、列举、动态更新接入、超时与输出上限。

### 引擎不负责

- **不提供工具分类原语**：没有 `category`/`group` 类型。现实中的「分组」是**插件自己写的名字常量**——`mods/diff` 就有三个：`EDITING_TOOLS = ['Edit','Write','NotebookEdit']`、`SHELL_TOOLS = ['Bash','PowerShell']`、`TODO_TOOL = 'TodoWrite'`（`mods/diff/hooks/tools/{editing-tools,shell-tools,todo-tool}.ts:4-5`）。
- **不设工具数量上限**：`plugin-validator` 只校验 `allowed-tools` 是不是数组（`plugins/plugin-dev/agents/plugin-validator.md:82`），**没有任何「工具太多」的检查**。数量问题靠延迟加载解决，不靠拒绝。
- **不定义工具行为**：内置工具行为在二进制里，MCP 工具行为在服务器侧。
- **不维护任务清单类工具**：`TodoWrite` 一线在新模型上被刻意弃用（见 [12]「职责与边界」），`mods/diff` 仍按旧名引用它（`todo-tool.ts:4`）——这是插件与引擎演进不同步的样本。

### 边界上的一个空洞

「工具定义如何被拼进发给模型的 prompt」在契约里**看不到**，只有一个接缝 `tool.describe`。所以「描述怎么排序、怎么标点、deferral 标记怎么表达」属于引擎内部，复刻时需自己拍板。

---

## 关键抽象与接口

### A. 定义面：三种视角，一个工具

| 视角 | 类型 | 字段 | 出处 |
|---|---|---|---|
| **声明**（注册者说） | `ToolSpec` | `name`、`description`、`inputSchema?` | `:10158-10174` |
| **列举**（调用者看） | `ToolInfo` | `name`、`description`、`mcp: boolean` | `:10081-10095` |
| **渲染**（模型读） | `ToolDescribeInput` / `ToolDescribeResult` | `tool`、`description`、`isDeferred?`、`provider: Origin` | `:9983-10022` |

**`ToolInfo.mcp: boolean` 是唯一一个「来源」类字段，而且只区分是不是 MCP**；真正的来源身份在 `tool.describe` 的 `provider: Origin` 上（`:10002-10008`）。这个分工是有意的：列举要便宜（每次 `/help` 式操作都要），溯源要准（安全判定要用）。

### B. 命名与命名空间

```ts
// claude-code.d.ts:5028
export type McpToolName = `mcp__${string}__${string}`;
```

- 内置工具：裸名（`Bash`、`Read`）。
- 配置的 MCP server 的工具：`mcp__<server>__<tool>`（`:5026`）。
- 插件注册的工具（无 server）：`mcp__<plugin>__<name>`（`:10161`、`:2604-2605`）。
- 插件**自带的** MCP server：`mcp__plugin_<plugin-name>_<server-name>__<tool-name>`（`plugins/plugin-dev/skills/mcp-integration/SKILL.md:194`）。

**推论（复刻时最容易做错的一条）：** 名字前缀**不足以**判断信任。「是不是 MCP」「是谁提供的」必须读 `provider`/`source`。契约在 `McpServerProvenance` 上把这句话写死了：

> 「`source` is where its definition came from - `sdk`(…only the host can register one, so a configured server of the same name never reads `sdk`)… Key trust on `source`, not on the name or the tool-name prefix.」（`:4965`）

### C. 来源与溯源：两个宿主钉死的字段

```ts
// claude-code.d.ts:5912
export type Origin = { readonly plugin: string; readonly tier: Tier };

// claude-code.d.ts:4967-4973
type McpServerProvenance = {
    name: string;      // 服务器配置键；是「未受信文本」，显示前要转义
    source: string;    // sdk | plugin | user | project | local | dynamic
                       // | managed | enterprise | claudeai | agent
                       // 「开放集合；未知值一律当作无法识别的已配置来源，绝不当作 sdk」
};
```

- `Origin` 出现在 `tool.describe` 的输入上，**pinned（改写被拒）**（`:10000-10003`）。
- 内置工具读作 `{ plugin: "engine", tier: "core" }`；组织策略配置的 MCP server 读作 `mcp:<server>` 且落在 `prepend`，否则落 `user`（`:10002-10007`）——这直接决定了 [06] 里 `sec-default` 的溯源判定。
- `McpServerProvenance` 被**带到工具事件上**：`PreToolUse`（`:6481`）、`PostToolUse`/`PostToolUseFailure`、`PermissionRequest`（`:6097`）、`PermissionDenied`（`:6070`）。也就是说 hook 在**每一次工具调用**上都能拿到「这来自哪台 server、哪个作用域」。

### D. 生命周期四动词

| 动作 | 形态 | 语义（引文档原文） |
|---|---|---|
| `$.tool.register(spec)` | op（可被 hook 拒） | 「Declares a tool the model can call **from the next prompt on**…a name registered again is **replaced**…Rejects until the session binds, at `session.start`」（`:2594-2600`） |
| `$.tool.list()` | op | 「the tools the model can call **now**, built-in and MCP alike, **in the order the model sees them**」（`:2562-2564`） |
| `tool.describe` | **事件**（每工具一次） | 「Fires once per tool, **when the engine first renders the tool's schema in a session**」（`:3456-3458`） |
| `$.tool.call(input)` | op（= 引擎为模型的工具调用跑的那条链） | 「It runs through every hook…the permission check and its dialog, then the tool. Rejects when no tool has that name or the call is aborted.」（`:2570-2576`） |
| `$.tool.check(input)` | op | 「Asks the engine's permission decision **now**…**nothing runs, no dialog opens, no PreToolUse hook or classifier is asked**」（`:2582-2588`） |

两个约定值得单独记：

1. **注册是「下一个 prompt 起」生效**，不是立刻——因为工具列表进的是 prompt，改列表等于改下一次请求。
2. **`tool.describe` 的答案是会话级缓存的**：「Cached for the session until `$.ui.invalidate("tool.describe")`: an **unstable answer spends the model's prompt cache**」（`:3460-3461`）。所以「描述每次都不一样」是有代价的——它会让 prompt cache 失效。这条把工具系统与 [11] 的 prompt cache 第一约束直接接上了。
3. `tool.describe` 是**可失效事件**之一（`InvalidatableEventName`，`:4666`）。

### E. 选择与过滤：四层收窄，且「在列表里 ≠ 能跑」

| 层 | 机制 | 语义 | 出处 |
|---|---|---|---|
| **子代理** | `AgentSpec.tools` | **白名单**：「a call to any other is **refused**」；**省略 = 继承父级全部工具**（最宽松） | `:369-373` |
| **子代理** | `AgentSpec.disallowedTools` | 白名单之上的**二次扣减** | `:374-377` |
| **技能** | skill frontmatter `allowed-tools` | 契约确实有：Skill 工具结果的 `allowedTools?: string[]`（「Tools allowed by this skill」） | `:13049-13050` |
| **设置/CLI** | `permissions.allow/ask/deny`、`--tools`、`--disallowedTools`、`--restricted` | 规则见 [06]；`--restricted`/`CLAUDE_CODE_RESTRICTED=1` 是**最强的一把**：去掉所有「跑命令或代码」的内置工具与 `WebFetch`，并拒绝 `bypassPermissions`、忽略 user/project/local 设置（`CHANGELOG.md:2812`） | `examples/settings/*.json`、`CHANGELOG.md:8661,7526,2812` |

**关键区别：这四层都是「能不能跑」，不是「在不在列表里」。** `--disallowedTools` 的工具**仍在 schema 里但永远不运行**（仓库自己的 workflow 就这么用：`claude-issue-triage.yml:50-53` 注释写着 "Tools in `--disallowedTools` never run"）。复刻时要分清「收窄可见列表」（省上下文）与「收窄可执行集合」（安全）——本系统两者是分开的机制，前者靠 `isDeferred`，后者靠规则。

### F. 权限提示：哪些问、哪些不问

判定发生在链上（时序见 [12]），产出三值 `ToolCheckDecision = 'allow' | 'ask' | 'deny'`（`:9915`）。「哪些不用问」由**四个彼此独立的来源**共同决定：

| 来源 | 不问的情形 | 证据强度 |
|---|---|---|
| **模式** | `acceptEdits` 自动接受文件编辑；`bypassPermissions` 跳过全部检查；`plan` 根本不执行；`dontAsk` 不问但「**not pre-approved 就拒**」 | 契约原文 `:6073-6076` |
| **规则** | `permissions.allow` 命中，或 deny/ask 未命中；规则形如 `Bash(git push:*)`、`Read(~/.ssh/**)`，`ruleContent` 承接括号内部分 | 契约 `:6100-6103`；示例 `examples/settings/settings-hipaa.json:17-48` |
| **PreToolUse hook** | 返回 `{ allow: true }`——文档原话就是「**Lets the call run without a permission prompt**」 | 契约 `:6448-6453` |
| **引擎内部** | 只读命令自动放行；沙箱内的命令自动放行 | **仅 CHANGELOG 有行为证据**，契约里无类型 |

模式语义逐字如下（`:6074`）：

```
'default'          - Standard behavior, prompts for dangerous operations.
'acceptEdits'      - Auto-accept file edit operations.
'bypassPermissions'- Bypass all permission checks (requires allowDangerouslySkipPermissions).
'plan'             - Planning mode, no actual tool execution.
'dontAsk'          - Don't prompt for permissions, deny if not pre-approved.
'auto'             - Use a model classifier to approve/deny permission prompts.
```

注意 `ask` 不是模式而是**决策**；`ask` 落到谁手里由模式决定：对话框、`auto` 的模型分类器、或无终端时的 host（`ToolCheckDecision` 文档 `:9910-9913`）。

判定结果的形状（`:9952-9969`）——`reason?` 与 `rule?` 是**为可重放**而存在的：

```ts
type ToolCheckResult = {
    decision: ToolCheckDecision;
    reason?: string;   // 给 hook / 给模型的拒绝文本 / 给对话框展示
    rule?: string;     // 「The settings rule that decided, as written (`Bash(git push:*)`)」
                       // 「Absent for a mode or a tool's own check.」
};
```

**「只读」是按调用判的，且默认算写。** 这是全篇最实用、也最容易被忽略的一处。`mods/diff` 的刷新手闸把这条写得很清楚（`may-have-written.ts:3-22`）：

> 「…unless the engine says the tool held the **call** read-only (`ls`, `git status`); never a deny.
> `isReadOnly` is read through a type that **may lack it, ahead of the declarations that name it**; absent, the call **counts as a write**.」

即：只读性是**每次调用**的属性（`ls` 与 `rm -rf` 同属 Bash），由引擎做命令分析后给出，**公开契约里没有这个字段**，而消费者应当**默认「算写」**。这与 CHANGELOG 里成规模的行为修正一致：只读自动放行名单被反复收紧（`rg`/`git grep` 的通配展开问题 `CHANGELOG.md:472`、`pyright` 移出只读 `:539`、`ps` 改为询问 `:544`），复合命令的前缀规则持续修补（`cd src && npm test` 必须按子命令保存规则 `:6455,:6880`；多处前缀绕过被当安全缺陷修掉 `:3651,:5915,:7403`）。

**审批本身被建模成一次人类发言。** `ToolCallReserved.consent` 是「the person's own words for the press that raised the call（`The user pressed "1: Yes" on ...`）：the run's context carries it as a **human turn**, which the permission path reads as **the user's request**」（`:9812-9819`）。所以「用户点了允许」不是布尔，而是一段可被链上任何参与者读到的人类输入。

`classic.PermissionRequest` 是「问人」这条路径的结构化出口（`:6082-6098`）：允许可以带 `updatedInput`（改写参数）与 `updatedPermissions`（**顺带把规则写进设置**，目的地 `userSettings|projectSettings|localSettings|session|cliArg`，`:6105-6134`）——这就是产品里「不再询问 / 总是允许」按钮的实现面。

### G. 工具太多怎么办：`ToolSearch` 与延迟加载

这是本题最完整、也最可量化的一段。

```ts
// claude-code.d.ts:9971-9977
export type ToolDeferral = boolean;
// true  = 藏在 ToolSearch 后面（模型点名要时才载入 schema）
// false = 在 prompt 的列表里

// claude-code.d.ts:9994-10000（ToolDescribeInput.isDeferred 文档）
// 「Present, and true, when the engine lists the tool behind ToolSearch…
//   By the engine's rule an MCP server's tool, or one that asks to be,
//   unless a rule keeps it in front.」
```

机制三件套：

1. **默认规则**：MCP 服务器提供的工具，或自己要求被延迟的工具，默认进后面；规则可以把某个工具「保持在前面」。
2. **阈值可配**：`CHANGELOG.md:7412`（`2.1.7`）——「**When MCP tool descriptions exceed 10% of the context window, they are automatically deferred** and discovered via the `MCPSearch` tool instead of being loaded upfront… Users can disable this by adding `MCPSearch` to `disallowedTools`.」；`CHANGELOG.md:7388`（`2.1.9`）加了 `auto:N`（N = 上下文窗口百分比，0-100）来调这个触发线。
3. **两条把工具放进后面的路**：按 server（`alwaysLoad: false` 把该 server 的全部工具延迟，`CHANGELOG.md:794`，`2.1.287`）与按工具（`$.tool.register` 的 `isDeferred: false` 让 mod **退出**延迟、从一开始就在列表里，`CHANGELOG.md:240`，`2.1.293`）。

模型侧的取回入口是 `ToolSearch` 工具（`:12554-12559`）：

```ts
ToolSearch: {
  // 文档原文：Query to find deferred tools. Use `select:<tool_name>` for
  // direct selection, or keywords to search.
  query: string;
  max_results: number;   // default: 5
}
```

它的结果里带**池子有多大**这个计数器，以及 MCP 的动态状态（`:13082-13091`）：

```ts
{ matches, query, total_deferred_tools: number,
  pending_mcp_servers?: string[],
  failed_mcp_servers?: { name: string; errorCode?: string; error?: string }[] }
```

**延迟的工具不占上下文窗口。** `/context` 的账本把这件事显式建模（`:1824-1857`）：

```ts
export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';
// 「a `deferred` row's [tokens] do not count toward the total」
// 「`deferred` tool schemas loaded on demand and outside the window」
```

单个 MCP 工具的账目也按「在不在窗口里」分开记（`ContextMcpTool`，`:1895-1913`）：`tokens` 是 schema 的估算 token，`isLoaded` 是「这张 schema 现在是否在窗口内：**总是**，除非工具 schema 按需加载且这个还没被搜到」。

**唯一的分组粒度是名字匹配。** 没有 `category`/`group` 原语，但名字空间让**通配匹配**成了事实上的分组手段：权限规则里可写 `mcp__server__*`（`CHANGELOG.md:7668`）、子代理 `disallowedTools` 里可写 `mcp__server`/`mcp__server__*`/`mcp__*`（`CHANGELOG.md:4403`）、hook matcher 可用正则（`mcp__.*__delete.*`，见 [02]）。复刻时若确实需要「一组工具」的语义，做法是**约定命名前缀**，而不是加一个分类字段。

---

## 数据流 / 时序

### 一个工具从声明到模型看见

```
声明                                  列举                   渲染（一次/会话）
┌──────────────┐   ┌──────────┐    ┌──────────┐        ┌───────────────┐
│ 内置（二进制）│   │          │    │$.tool.list│        │ tool.describe │
│ MCP server   ├──▶│ 会话工具池├───▶│ →ToolInfo│───────▶│ ┌───────────┐ │
│ $.tool.register│  │          │    │  (name,  │        │ │description│ │
└──────────────┘   └──────────┘    │  desc,   │        │ │isDeferred │ │
       ▲                            │  mcp)    │        │ │provider   │ │
       │                            └──────────┘        │ └─────┬─────┘ │
  tool.register 事件                                    └───────┼───────┘
  （可被策略拒绝，见 [06]）                                       ▼
                                    缓存到会话结束（或 $.ui.invalidate("tool.describe")）
                                                              │
                                       ┌──────────────────────┴─────────────────────┐
                                       ▼                                            ▼
                               isDeferred=true                              isDeferred=false
                          藏在 ToolSearch 后（不占窗口）              在 prompt 的工具列表里
```

### MCP：本地与远程是同一条路

```
配置来源                              连接                            使用
┌────────────────────────┐      ┌──────────────────┐      ┌────────────────────┐
│ .mcp.json（推荐）       │      │ 懒连接：cached    │      │ 工具以 mcp__s__t   │
│ plugin.json 内联        │      │ server 首次使用   │      │ 出现在池里          │
│ settings.mcpServers    ├─────▶│ 才拨号，不阻塞启动│─────▶│ 调用：$.mcp.call    │
│ --mcp-config / dynamic │      │ stdio|sse|http|ws │      │   (server,tool,args)│
│ agent frontmatter      │      │ 超时：MCP_TIMEOUT │      │ 或 tool.call hook   │
│   mcpServers           │      │  MCP_TOOL_TIMEOUT │      │ 的 mcp__s__t 分支   │
└────────────────────────┘      └──────────────────┘      └────────────────────┘
                                          ▲                          ▲
                            list_changed 通知（服务器侧动态增删）      │
                            资源/提示：@-mention、mcp_prompt 展开 ─────┘
```

要点：

- 传输类型**不在契约里**，只在插件作者文档中：`stdio`（本地子进程，`command`/`args`/`env`）、`sse`（托管/OAuth）、`http`（REST/token，`headers`）、`ws`（`plugins/plugin-dev/skills/mcp-integration/SKILL.md:481`）。
- **懒是有意的**：`--input-format stream-json` 下第一轮不再等最多 2s 的连接（`CHANGELOG.md:1885`）；`MCP_CONNECTION_NONBLOCKING=true` 直接跳过等待（`:6113`）。
- **动态更新走标准通知**：`list_changed` 让服务器不重连就改工具/提示/资源（`CHANGELOG.md:7518`）。
- 插件侧调用是**位置参数**且「**无权限提示**」：`$.mcp.call(server, tool, args)`，文档注明「A `cached` server is dialed on first use」（`:2319-2324`）。这与模型触发的 `tool.call` 走完整权限链形成对照——**插件自己发起的调用不算模型的调用**。
- MCP server 也可以**反向要人输入**：`ElicitationHookInput.mcp_server_name` / `mode: 'form'|'url'` / `requested_schema`，回答是 `accept|decline|cancel`（`:3182-3195`）。

### 一次工具调用的权限判定时序

见 [12] 的「工具派发」一节；工具侧的补充是**事件上多了来源**：`PreToolUse`/`PermissionRequest`/`PermissionDenied`/`PostToolUse*` 都带 `mcp_server?: McpServerProvenance`（`:6070,6097,6481` 等），所以一个 hook 可以说「凡是来自 `source: 'project'` 的 MCP 工具的写操作都要问」——而**不必**解析名字。`CHANGELOG.md:398` 还补了 `agentId`：「so a hook can tell a subagent's permission check from the main session's」。

### 延迟加载的时序

```
会话开始
   │
   ├─ 列举工具池（内置 + 已连接 MCP + 插件注册）
   │
   ├─ 估算 MCP 工具描述总量 ── 超过阈值（默认 10% 窗口，auto:N 可调）
   │        │
   │        ├─ 是 ──▶ 这些工具进「后面」：schema 不载入窗口
   │        │          （除非 alwaysLoad:true / isDeferred:false / 规则保住）
   │        └─ 否 ──▶ 全部进 prompt 的工具列表
   │
   ├─ 模型需要某个被藏起来的工具
   │        └─▶ 调 ToolSearch({ query: "select:<tool>" | 关键词, max_results })
   │                 └─▶ schema 载入窗口，该调用生效（total_deferred_tools 告知池子大小）
   │
   └─ prompt cache：工具列表在两次请求间保持「字节稳定」才有缓存命中
            └─ 因此中途连上的 server 的工具以「延迟定义」加入，而不是改写列表
               （CHANGELOG.md:2277,2342）
```

**协议层还有一条硬不变量**：全部工具都来自 MCP 的会话会失败，报错文字是「**At least one tool must have `defer_loading=false`**」（`CHANGELOG.md:2038`）——即**至少要有一个前加载的工具**。

---

## 扩展点

| 意图 | 挂载点 | 怎么做 | 依据 |
|---|---|---|---|
| 造一个新工具 | `$.tool.register(ToolSpec)` | 声明 name/description/inputSchema，再用 `tool.call` hook 应答 | `:2594-2609` |
| 改模型看到的工具描述 | `tool.describe` hook | 返回 `{ description }` 或 `{ ...(await next(e)), description }` | `:10011-10022` |
| 把某工具提起/压下 | `tool.describe` hook | 返回 `isDeferred: false`（进列表）/ `true`（藏后面） | `:3461-3467` |
| 让某 server 的工具永不延迟 | MCP 配置 `alwaysLoad: true` | 服务器级 | `CHANGELOG.md:5442` |
| 让某 server 的工具全部延迟 | MCP 配置 `alwaysLoad: false` | 服务器级 | `CHANGELOG.md:794` |
| 逐工具延迟（MCP） | 工具 `_meta['anthropic/alwaysLoad'] = false` | 服务器在声明里带 | `CHANGELOG.md:995` |
| 逐工具前置（插件） | `$.tool.register` 的 `isDeferred: false` | mod 用 | `CHANGELOG.md:240` |
| 调整自动延迟阈值 | `auto:N` | N 是窗口百分比 | `CHANGELOG.md:7388` |
| 彻底关掉工具搜索 | `disallowedTools` 加 `MCPSearch` | 配置层 | `CHANGELOG.md:7412` |
| 给某工具免问 | `permissions.allow` 加 `Bash(git push:*)` 式规则 | 设置层 | `:6100-6103` |
| 强制某工具必问 | `permissions.ask` | 设置层 | `examples/settings/settings-strict.json:2-13` |
| 让某工具永不运行 | `permissions.deny` / `--disallowedTools` | 设置或 CLI | `examples/settings/settings-hipaa.json:17-48` |
| 砍掉所有「跑代码」的工具 | `--restricted` / `CLAUDE_CODE_RESTRICTED=1` | CLI | `CHANGELOG.md:2812` |
| 在调用前改写参数 | `classic.PreToolUse` 返回 `updatedInput` | hook | `:6488-6493` |
| 给调用补上下文 | `classic.PreToolUse` 返回 `additionalContext` | hook | `:6494-6497` |
| 审批时顺便记一条规则 | `classic.PermissionRequest` 返回 `updatedPermissions` | hook | `:6082-6090` |
| 子代理只给一部分工具 | agent frontmatter `tools` + `disallowedTools` | 声明层 | `:369-377` |
| 技能激活时收窄工具 | skill frontmatter `allowed-tools` | 声明层 | `:13049-13050` |
| 插件自己调 MCP 不走权限链 | `$.mcp.call(server, tool, args)` | 插件 API | `:2319` |
| 观察一批工具的执行 | `PostToolBatch`（**每批恰好一次**） | hook | `:6344-6349` |

---

## 设计决策与权衡

**D1. 工具定义只有三个字段，策略一律外置。**
`ToolSpec` 只有 name/description/inputSchema（`:10158-10174`），**没有** read-only、并发安全、enabled 等标志。收益：定义面稳定、可由任意来源（内置/MCP/插件）产生而不需统一 schema 演进；策略（能不能跑）全部落到规则与模式上，与 [06] 的策略模型单一化。代价：「只读」这类**本质属性**只能由引擎在运行时按调用判定，插件拿不到声明式的答案——`mods/diff` 只能读一个**未文档化**的字段并默认「算写」。

**D2. 没有磁盘注册表，工具是运行时的声明。**
`plugin.json`/`marketplace.json` 无 tools 键，内置靠类型投影，插件靠 `$.tool.register`。收益：工具的可用性可以**随会话变化**（MCP 连接、`list_changed`、`session.start` 之后才可注册），并且**注册本身是一个可被策略拒绝的事件**（[06] 的 `tool.register` 门：`allowedMcpServers` 一旦设定，`user` 层插件就不能加工具）。代价：静态分析、安装前审计、`plugin validate` 都看不到工具——验证只能到运行时。

**D3. 信任基于宿主钉死的 `source`，不基于名字前缀。**
`McpServerProvenance.source` 是开放集合且**明确要求把未知值当作不可信**（「never as `sdk`」，`:4970`）。收益：一个自称 `sdk` 的配置服务器无法提权；插件注册的工具尽管叫 `mcp__<plugin>__<name>`，也不会被误认为远程服务器。代价：每个安全判定都要读 provenance 字段，而不能只做字符串前缀匹配；`name` 本身是**未受信文本**，显示前必须转义（`:4965`）。

**D4. 工具太多的解法是「藏」而不是「砍」。**
超过阈值（默认 MCP 描述总量占窗口 10%）的工具被 `ToolSearch` 隐藏，schema 不载入窗口，`/context` 也把它们排除在总额之外（`:1830-1857`）。收益：能力不丢、上下文不爆、模型可按名字精确取回（`select:<tool>`）。代价：多一次「搜索—载入」往返；需要一条协议不变量兜底（至少一个前加载工具）；且引入了新的失败面——参数 schema 在压缩后丢失、按裸名搜索失败等（`CHANGELOG.md:6506,2042`）。

**D5. 延迟加载与 prompt cache 是一对共生约束。**
「不稳定答案会花掉模型的 prompt cache」（`:3460-3461`）；「保持工具列表字节稳定，后来连上的工具以延迟定义加入而不是改写列表」（`CHANGELOG.md:2277,2342`）。收益：工具池的动态性不破坏缓存，成本可控。代价：**列表稳定性成了硬约束**，任何「按时间/按调用顺序排工具」的设计都会毁掉缓存；也让 `describe` 的缓存与失效语义必须精确。

**D6. 权限是一次链上判定，产出三值 + 可重放的规则原文。**
`tool.check` 在 `tool.call` 与 PreToolUse **之后**、模式裁决 ask **之前**（[12]）；结果带 `rule?`「as written」（`:9964-9968`）。收益：任何一层都能参与而无需知道其他层；deny 能带回规则原文，使 [06] 的「跳过 user 层重放一遍」得以成立；`$.tool.check` 还能**只判定不执行**，让「预演权限」成为可能。代价：三值语义要在「模式 × 规则 × 工具自检 × PreToolUse」四源之间定序，且默认失败方向必须明确。

**D7. 只读按调用判、默认算写。**
同样一个 Bash 工具，`ls` 与 `rm -rf` 的只读性不同，所以判定必须在**调用**粒度上；字段未公开，且消费者应当把「拿不到」当作写（`may-have-written.ts:8-22`）。收益：自动放行能覆盖命令级别而不误伤整类工具，且 fail-safe。代价：判定需要命令分析（拆 `&&`/`|`/通配），这份分析是引擎内部、无法审计，CHANGELOG 里成规模的安全修补（`:472,544,5915,6455`）就是这个代价的账单。

**D8. 「问人」的结构化出口带副作用（写规则）。**
`PermissionRequest` 的 allow 可返回 `updatedPermissions`，目的地含 `userSettings|projectSettings|localSettings|session|cliArg`（`:6082-6134`）——即「总是允许」按钮会**改持久设置**。收益：一次询问换取长期免问，是效率的核心。代价：必须与 [06] 的 `allowManagedPermissionRulesOnly` 交互（组织可隐藏「总是允许」选项），且规则的书写形式（前缀 / 通配）直接影响安全性。

**D9. 不做分类原语，让命名空间承担分组。**
无 `category`/`group` 类型；分组靠前缀通配（`mcp__server__*`）或插件自写的名字常量（`EDITING_TOOLS`/`SHELL_TOOLS`）。收益：契约面小、不鼓励「按类别批量放行」这种粗粒度安全决策。代价：需要「一组工具」语义的地方各自造轮子，且**跨插件无法共享分组定义**。

**D10. 插件的 MCP 调用绕开权限链。**
`$.mcp.call(server, tool, args)` 文档明说首次使用时拨号、**没有权限提示**（`:2319-2324`）。收益：插件把 MCP 当依赖用（例如写一个校验器）不需要每次弹窗，能力可组合。代价：**绕开的是模型调用的那条链**，因此插件必须自己承担「要不要问人」的判断——这是复刻时极易被忽略的一条安全边界。

---

## 对复刻产品的启示

1. **先冻结命名空间，再做工具。** `mcp__<server>__<tool>` 一个格式统吃三种来源（远程 server、插件自带 server 加 `plugin_` 中缀、插件运行时注册的工具）。命名空间定得早，后面的权限规则、hook matcher、日志、UI 分组全都跟着受益。

2. **把工具定义面做薄：`name` + `description` + `inputSchema`，别加策略字段。** 策略（只读性、要不要问、能不能跑）全部走独立的判定通道。定义面一旦混入策略，每新增一种来源就要重新协商 schema。

3. **不要做磁盘注册表。** 内置工具编进二进制、以类型投影对外；插件工具走运行时 `register` API。好处是可用性可随会话变化，而且**注册变成一个可被组织策略拒绝的事件**——这是「MCP allowlist」这类控制面的实现位。

4. **信任判定读宿主钉死的 `source`，永不读名字前缀。** 并且把未知来源一律当作不可信（契约里的 "never as `sdk`" 就是这个意思）。工具名本身是**未受信文本**，进 UI 前要转义。

5. **把「描述」当路由 API 而不是文档。** 描述是模型选工具的唯一依据（与 [08] 的 "`description` 即路由" 同构），所以要短、要可改写、要可缓存。并且为「为什么这个工具没被用」预留可诊断性。

6. **留一个「首次渲染」接缝（对标 `tool.describe`）**，并让它同时支持三种操作：改写描述、决定显不显示（前置/延迟）、被外部失效重建。这个接缝是工具系统唯一优雅的扩展位。

7. **把「工具太多」当成上下文预算问题，而不是列表管理问题。** 做法是**延迟**：超过阈值（用**上下文百分比**而非固定条数）就把 schema 移出窗口，给模型一个按需取回的工具。阈值务必可配。

8. **延迟的 schema 要排除在上下文账外**，并在账本里单列一行（`/context` 的 `deferred` 类）。否则用户永远看不懂「为什么我的工具没占 token」。

9. **把工具列表的字节稳定性当硬约束。** 中途连上的服务器、中途注册的插件，都以「延迟定义」加入，而不是改写列表——这直接决定 prompt cache 命中率（与 [11] 的第一约束一致）。

10. **至少保留一个前加载工具**（对标协议里的「At least one tool must have `defer_loading=false`」）。这是防止「全部工具都延迟导致模型无从下手」的兜底不变量。

11. **权限做成链上的一次三值判定**（allow/ask/deny），而不是执行前的一个开关；决策结果**携带规则原文**以便重放与审计；并提供一个**只判定不执行**的入口（对标 `$.tool.check`）让 plan/diff 类功能可用。

12. **只读判定按调用做，默认 fail-safe 算写。** `ls` 与 `rm -rf` 是同一个工具；拿不到只读证据时按写处理。如果你不想承担命令分析的复杂度，就把「自动放行」退化为「按工具整类放行」，但要在产品上说清这个差异。

13. **把审批建模成一次人类发言。** 「用户点了允许」应当作为一条真实的用户输入进入上下文（对标 `consent`），而不是一个布尔标志——这样链上任何参与者（策略、审计、后续轮次）都能读到「这是他本人要求的」。

14. **分清「收窄可见列表」与「收窄可执行集合」。** 前者省上下文（延迟/过滤列表），后者是安全（deny 规则、`--disallowedTools`、`--restricted`）。一个工具可以**存在于 schema 中但永不运行**——这是有意的，别把两者合成一个机制。

15. **不要给工具做分类原语。** 需要「一组工具」时，用命名空间前缀匹配（`mcp__server__*`）或调用方自己维护的名字常量。分类原语会诱导出「按类别批量放行」这种粗粒度安全决策。

16. **插件自己发起的工具调用要与模型发起的区分开。** 模型调用走完整权限链；插件调用（对标 `$.mcp.call`）通常不走。要么明确这条边界并写进文档，要么给插件调用一条可选的审批通道——但不要让它默认静默。

---

## 关键文件索引

**契约（`mods/types/claude-code.d.ts`）**

- `:2561-2610` — `$.tool` 命名空间：`list` / `call` / `check` / `register` 四个 op 的完整文档。
- `:3456-3469` — `tool.describe` 事件：每工具一次、会话级缓存、`isDeferred` 语义。
- `:369-377` — `AgentSpec.tools` / `disallowedTools`（省略 = 全继承；白名单外的调用被拒）。
- `:399` — `AgentSpec.mcpServers`（服务器名，或内联 `{ name: { command, args } }`）。
- `:2064-2130`（`prompt`）、`:2319-2324` — `$.mcp.call(server, tool, args)`；cached server 首次使用拨号。
- `:3182-3195` — `ElicitationHookInput` / `ElicitationResultHookInput`（MCP 反向要人输入）。
- `:4666` — `InvalidatableEventName`（含 `tool.describe`）。
- `:4965-4973` — `McpServerProvenance`（`name` 未受信；`source` 开放集合；「Key trust on `source`」）。
- `:4982-5028` — `McpToolCallInput` / `McpToolCallInputFallback` / `McpToolInputs`（声明合并）/ `McpToolName`。
- `:5912` — `Origin = { plugin, tier }`。
- `:6062-6134` — `PermissionBehavior` / `PermissionMode` / `PermissionRequestDecision` / `PermissionDeniedHookInput` / `PermissionRuleValue` / `PermissionUpdate` / `PermissionUpdateDestination`。
- `:6344-6355` — `PostToolBatchHookInput`（「PostToolUse fires per-tool…; PostToolBatch fires exactly once with the full batch」）。
- `:6448-6498` — `PreToolUseDecision` / `PreToolUseResult`（`allow` = 免问；`updatedInput`；`additionalContext`）。
- `:9761-9830` — `ToolCallArgs` / `ToolCallEnvelope` / `ToolCallInput` / `ToolCallReserved`（含 `consent`）/ `ToolCallResult`。
- `:9910-9969` — `ToolCheckDecision` / `ToolCheckInput` / `ToolCheckResult`（`rule` 原文）。
- `:9971-10022` — `ToolDeferral` / `ToolDescribeInput` / `ToolDescribeResult`。
- `:10044-10076` — `ToolGroupCall`（UI 侧一批调用的一行）。
- `:10081-10174` — `ToolInfo` / `ToolSpec`。
- `:12554-12559` / `:13082-13091` — `ToolSearch` 的输入与结果（`total_deferred_tools`、`pending_mcp_servers`）。
- `:13044-13056` — Skill 工具结果（`allowedTools`、`readOnly`）。
- `:12378-12596` — `BuiltinToolInputs`（**本构建**的 23 个内置工具及其入参）。
- `:12603-13170` — `BuiltinToolResults`（同名工具的出参；`SendMessage`/`TaskOutput` 为 `unknown`）。

**真实 mod 源码（工具分类与只读判定）**

- `mods/diff/hooks/tools/editing-tools.ts:5` — `EDITING_TOOLS = ['Edit','Write','NotebookEdit']`。
- `mods/diff/hooks/tools/shell-tools.ts:5` — `SHELL_TOOLS = ['Bash','PowerShell']`。
- `mods/diff/hooks/tools/todo-tool.ts:4` — `TODO_TOOL = 'TodoWrite'`（**不在本构建工具表里**的旧名）。
- `mods/diff/hooks/tools/may-have-written.ts:8-22` — 读未文档化的 `isReadOnly`，缺失即「算写」。
- `mods/sec-default/hooks/register.ts:39-65` — `tool.register` 的 MCP allowlist 门与 `tool.list` 的组织还原。

**插件 / 示例**

- `plugins/plugin-dev/skills/mcp-integration/SKILL.md:23-63`（两种放置）、`:65-165`（四种传输）、`:194-218`（`mcp__plugin_<plugin>_<server>__<tool>` 与 `mcp__plugin_asana_asana__*` 通配）、`:481`（传输对照表）。
- `plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md:298-331` — `mcpServers` 可为路径或内联。
- `plugins/code-review/commands/code-review.md:2` — `allowed-tools` 直接点名 MCP 工具。
- `plugins/plugin-dev/agents/plugin-validator.md:82` — 只校验 `allowed-tools` 是数组（**无工具数量检查**）。
- `examples/settings/settings-strict.json:2-13`、`settings-hipaa.json:17-48` — `permissions.allow/ask/deny` 规则语法。
- `examples/hooks/bash_command_validator_example.py:36-79` — PreToolUse 规则的实现形态。
- `.github/workflows/claude-issue-triage.yml:50-53` — `--disallowedTools "WebFetch,WebSearch,Write,Edit,MultiEdit,NotebookEdit"`。

**CHANGELOG 锚点（工具系统，按主题）**

- 延迟加载：`:7412`（`2.1.7`，超 10% 窗口自动延迟，`MCPSearch`）、`:7388`（`2.1.9`，`auto:N`）、`:794`（`2.1.287`，`alwaysLoad:false`）、`:5442`（`alwaysLoad:true`）、`:995`（`_meta['anthropic/alwaysLoad']`）、`:240`（`2.1.293`，mod 的 `isDeferred`）、`:2038`（至少一个前加载工具的协议不变量）、`:198`（`2.1.295`，延迟的 MCP 描述上限 16,384 字符）、`:65`（默认描述上限 2,048→4,096）。
- 缓存稳定：`:2277`、`:2342`（`2.1.267`）、`:1356`（`2.1.281`）、`:6091`（`2.1.90`）、`:6244`（`2.1.84`）。
- 搜索语义：`:2042`（`2.1.271`，裸名 vs `mcp__server__tool`）、`:5693`（`2.1.113`，排序）、`:6506`（`2.1.76`，压缩后丢 schema）、`:132`（`2.1.295`）、`:7300`（`2.1.20`，结果改为一次性通知）。
- 模型门禁：`:160`、`:1885`、`:3525`、`:5535`（Vertex 默认关，`ENABLE_TOOL_SEARCH`）、`:6608`、`:6693`。
- 粒度与开关：`:7526`（`--tools`）、`:8661`（`--disallowedTools`）、`:2812`（`--restricted` / `CLAUDE_CODE_RESTRICTED=1`）、`:7668`（`mcp__server__*` 通配）、`:4403`（子代理 `disallowedTools` 里的 server 级规格）、`:398`（`tool.check` 加 `agentId`）。
- 提示与只读：`:472`（`rg`/`git grep` 通配）、`:539`（`pyright`）、`:544`（`ps`）、`:6455`/`:6880`（复合命令按子命令存规则）、`:5915`/`:3651`/`:7403`（前缀绕过修复）、`:5916`（env 前缀的只读命令）。
- 内置工具演进：`:3777`（Task 的 `mode` 弃用）、`:4383`（移除 `TeamCreate`/`TeamDelete`）、`:2278`/`:3277`（`CLAUDE_CODE_ENABLE_TODO_TOOLS`）。

**【本机观测】本机（Windows）**

- `C:\Users\86178\.claude.json` — 顶层**无** `mcpServers`；MCP 键在**每个项目对象**里：`mcpServers`、`mcpContextUris`、`enabledMcpjsonServers`、`disabledMcpjsonServers`（外加 `allowedTools`、信任标志、`lastCost`/用量）。共 72 个项目条目。
- `C:\Users\86178\.claude\settings.json` — 顶层键 `env, permissions, enabledPlugins, extraKnownMarketplaces, theme, hasCompletedOnboarding, skipDangerousModePermissionPrompt`；**无 MCP 键**。
- `C:\Users\86178\.claude\settings.local.json` — 只有 `permissions`。
- `F:\ts\claude-code` 下递归搜索 `.mcp.json` — **不存在**。
- 结论：本机在**用户作用域**未配置任何 MCP 服务器；项目作用域只有 `.claude.json` 里的空/占位结构。

---

## 存疑与待确认

1. **引擎内部的工具定义拼装不可见。** 「工具 schema 怎么被写进发给模型的请求、`deferred` 在 wire 上怎么表示（契约里出现 `defer_loading` 这个词但无类型）、描述怎么排序」全在引擎里。`tool.describe` 是唯一接缝。

2. **只读判定（命令分析）与沙箱自动放行的实现不可见。** 契约里**没有**任何只读标志；`mods/diff` 读的 `isReadOnly` 是「a type that may lack it, ahead of the declarations that name it」（`may-have-written.ts:8`）。其判定算法、命令拆分规则、安全命令名单都只能从 CHANGELOG 的行为修正反推。

3. **`MCPSearch` 与 `ToolSearch` 的关系。** `2.1.7` 的文案用 `MCPSearch`（且说用 `disallowedTools: ["MCPSearch"]` 关闭），其后版本一律用 `ToolSearch`；契约里只有 `ToolSearch`。是改名还是并存，仓库内无据。

4. **`ToolSearch` 结果的 `matches` 字段形状未确认**（工具入参里出现的上下文含 `matches`，但未逐字核对其元素类型）。

5. **工具名长度上限的确切规则**：`ToolSpec.name` 说 ≤64 字符（`:10160-10162`）；MCP 工具名 >128 字符会被丢弃并报一个具名错误（`CHANGELOG.md:312`）——两套上限不同，且 128 这条不在契约里。

6. **`enableAllProjectMcpServers` 在整个仓库中查无实据。** 仓库内可证实的只有 `.claude.json` 每个项目的 `enabledMcpjsonServers` / `disabledMcpjsonServers`（【本机观测】）。[06] 的存疑第 4 条同样标记了这一点。复刻时请以官方 settings 文档为准。

7. **`MAX_MCP_OUTPUT_TOKENS` 无据**（全仓库零命中）；能证实的只有**描述**长度上限（`:65` / `:198`），输出侧上限未见契约。

8. **MCP 传输类型不在契约里。** `McpServerConfig` / `McpServerStatus` / 传输联合类型在 `claude-code.d.ts` 中**不存在**；四种传输只在插件作者技能文档里以配置示例形式出现（`mcp-integration/SKILL.md:481`）。`sdk` / `ide` 等其它传输变体（`source` 里提到 `sdk`）无文档化的配置形状。

9. **仓库内没有任何插件实际自带 `.mcp.json`。** 唯一的 MCP 用例是一条命令的 `allowed-tools` 点名（`plugins/code-review/commands/code-review.md:2`）。因此「插件分发 MCP server」这条路径**只有文档与 validator 约束，没有活样本**。

10. **工具数量**没有任何上限、告警或 lint。`plugin-validator` 只检查 `allowed-tools` 是不是数组；「工具过多」完全由延迟加载在运行时吸收。

11. **本构建的内置工具表与运行时可用的工具不一致。** `BuiltinToolInputs` 的注释说「The inputs of the built-in tools **this build has**」（`:12375`），且表中**不含** `Glob`、`Grep`、`LS`、`MultiEdit`、`TodoWrite`、`SlashCommand`、`ExitPlanMode`、`AskUserQuestion`、`Monitor`、`KillShell`、`BashOutput`——而其中若干在散文与其他文档里被当作存在（`AskUserQuestion` 只作为渲染组件出现 `:2114`、`Monitor` 出现在 `tool.describe` 示例里 `:3467`）。判断「某个工具到底在不在」必须以**该构建的合并接口**为准。

12. **`consent` 的采集与校验契约未定**：它的文档说被当作 human turn 读，但「谁写入、格式如何校验、无终端时怎么办」在契约里没有对应类型（[12] 的存疑中也列了这一条）。

13. **规则与工具自检的先后**在 `tool.check` 的 `ToolCheckResult.reason` 文档里只说是「from core the rule or check that decided」，两者同时命中时谁胜出未在契约中定序。

---

## 与 `00-overview.md` 漂移清单的关系（本文新增/更正）

- **更正第 6 条**：`00-overview.md` 的漂移第 6 条称 `SKILL.md` 的 `allowed-tools`「引擎类型中亦不可证实」——**该判断有误**。契约里确有该字段：Skill 工具结果 `allowedTools?: string[]`（`claude-code.d.ts:13049-13050`），且 `CHANGELOG.md:158,4813,7529,7621` 记录其行为。准确的说法是：**字段存在且引擎支持，但仓库内没有任何 `SKILL.md` 在自己的 frontmatter 里用它**（命中全在文档正文的示例里）。
- **新增**：本构建的工具表与散文/其他文档提到的工具不一致（见存疑第 11 条）——复刻时以合并接口为准。
- **新增**：`isReadOnly` 被真实 mod 读取但未进入公开契约（`mods/diff/hooks/tools/may-have-written.ts:8`）——这是「实现领先于契约」的少见方向，与第 9 条的「契约领先于实现」正好相反。
