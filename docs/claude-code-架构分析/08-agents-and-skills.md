# 08 · 子代理（Subagents）、Agent Skills 与 Slash Commands：代理组合面

> 分析对象：`anthropics/claude-code` 公开仓库中的官方插件与 Agent SDK 开发套件。
> 本文只描述**仓库内可观察到的作者契约**（frontmatter 字段、目录约定、命令展开规则），
> 以及 `mods/types/claude-code.d.ts` 中引擎对外暴露的代理 / 技能运行时接口。
> 所有行号均为仓库相对路径 + 行号；引用 frontmatter 一律原文照录。
>
> 重要前提：本仓库是**产品分发仓**而非引擎源码。插件目录里的 `agents/*.md`、
> `skills/*/SKILL.md`、`commands/*.md` 是引擎在运行时加载的**数据文件**，
> 而不是引擎实现本身。因此对"引擎如何执行"的判断，只能来自这些文件所描述/暴露的契约，
> 以及 `mods/types/claude-code.d.ts` 的类型签名，不能视为引擎内部实现细节的权威来源。

---

## 定位

这三样东西共同构成 Claude Code 的**代理组合面（agent-composition surface）**：让用户在不改引擎源码的前提下，定义"新的人格 / 新的能力 / 新的入口"。

| 构件 | 载体 | 本质 | 触发方 |
|---|---|---|---|
| **Subagent**（子代理） | `agents/*.md` | 一个带独立系统提示词、独立上下文窗口、独立工具集与模型的**自治子进程** | 模型通过 `Agent`/`Task` 工具委派，或插件用 `$.agent.spawn` 主动拉起 |
| **Agent Skill**（技能） | `skills/<name>/SKILL.md` | 一份**按需注入上下文**的程序性知识包（渐进式披露） | 模型在描述命中时自动加载，或被预加载进子代理 |
| **Slash Command**（斜杠命令） | `commands/*.md` | 一段**确定性展开**的提示词模板，由用户键入触发 | 用户输入 `/name`；部分命令也可被 Skill 工具程序化调用 |

官方对该三者的自我定位（`plugins/README.md:7`）：

> "Claude Code plugins are extensions that enhance Claude Code with custom slash commands, specialized agents, hooks, and MCP servers."

三者的角色分工在作者指南中被一句话点破（`plugins/plugin-dev/skills/agent-development/SKILL.md:14`）：

> "**Agents are FOR autonomous work, commands are FOR user-initiated actions**"

而 Skill 的定位是"把通用代理变成领域专家"的入门指南（`plugins/plugin-dev/skills/skill-development/SKILL.md:13-16`）：

> "Skills are modular, self-contained packages that extend Claude's capabilities ... Think of them as 'onboarding guides' ... they transform Claude from a general-purpose agent into a specialized agent equipped with procedural knowledge that no model can fully possess."

SDK 侧则是另一条线：`plugins/agent-sdk-dev/` 教用户用 `@anthropic-ai/claude-agent-sdk`（TS）或 `claude-agent-sdk`（Python）**在代码里构建自己的 agent**——这是"把 Claude Code 的代理循环嵌入宿主程序"的对外接口，与上面的文件级扩展点互补。

---

## 职责与边界

### 2.1 三者的职责边界

| 维度 | Subagent | Skill | Slash Command |
|---|---|---|---|
| 上下文 | **独立上下文窗口**（隔离），只回传最终答复 | 注入**当前**上下文（渐进式、按需） | 在当前会话内展开为提示词文本 |
| 用户可见性 | 在 `/agents` 列表、UI 中以 `color` 标识 | 在 skills 列表出现，元数据常驻 | 在 `/help` 与斜杠菜单出现 |
| 是否自动触发 | 是（`description` 驱动委派） | 是（`description` 命中即加载） | 否（用户键入为主；可被 Skill 工具调用） |
| 是否可被程序调用 | 是（`Agent` 工具 / `$.agent.spawn`） | 是（Skill 工具 / `skill.prompt`） | 部分（`disable-model-invocation` 可关闭） |
| 典型用途 | 并行审查、探索、验证、生成 | 领域知识、工作流、脚本资产 | 用户显式发起的确定性动作 |

### 2.2 边界规则（来自官方作者契约）

- **命令 = 用户主动，代理 = 自治**（`agent-development/SKILL.md:14`）。因此"审查我刚写的代码"这类**应由代理主动触发**的场景，不该做成命令；"发布到生产环境"这类**需要人类判断**的场景，应做成命令并考虑 `disable-model-invocation`（`command-development/references/frontmatter-reference.md:283-307`）。
- **子代理默认不读取无关上下文**：`code-review` 的 opus bug 代理被明确要求"Focus only on the diff itself without reading extra context"（`plugins/code-review/commands/code-review.md:36`）；引擎层面也有 `omitClaudeMd` 字段让子代理完全不携带 CLAUDE.md（`mods/types/claude-code.d.ts:427-431`）。
- **子代理模型 / 权限受父级约束**：`permissionMode` 由父级继承且为"pinned"不可被 hook 改写（`claude-code.d.ts:282-286`）；`model` 解析顺序为 call → agent 自带 → 父级（`claude-code.d.ts:260-272`）。
- **Skill 是知识而非动作**：SKILL.md 正文用**祈使句**（imperative）写，描述用**第三人称**（`skill-development/SKILL.md:362-413`）；这与子代理正文用第二人称（"You are..."，`agent-development/SKILL.md:164,200`）刻意相反。
- **命令是模板不是代理**：命令体内可以**内联执行 bash 并注入结果**（`!`cmd``），但命令本身不拥有独立上下文（`command-development/SKILL.md:316-326`）。

### 2.3 一个被文档高估、实现缺失的边界

`plugins/README.md:17` 与 `.claude-plugin/marketplace.json`（`code-review` 条目）都宣称 code-review 插件含"**5 parallel Sonnet agents** for CLAUDE.md compliance, bug detection, historical context, PR history, and code comments"。

但实际目录 `plugins/code-review/` **只有** `.claude-plugin/plugin.json`、`README.md`、`commands/code-review.md` 三个文件，**没有 `agents/` 目录**（见 `关键文件索引` 与 `存疑` 段）。这 5 路并行是通过**命令提示词内联**描述的（`code-review.md:14-55`），由模型在运行时用通用代理（`haiku`/`sonnet`/`opus` 别名）临时拉起，而非注册为具名子代理文件。这是本仓库中"文档承诺 vs. 实际产物"最明显的一处偏差。

---

## 关键抽象与接口

### 3.1 Subagent frontmatter schema（观察值 + 引擎类型）

仓库内 15 个代理文件实际出现的字段全集很小（`name` / `description` / `tools` / `model` / `color`）。官方作者指南给出的**必填/选填**结论：

> `plugins/plugin-dev/skills/agent-development/SKILL.md:349-358`

| Field | Required | Format | Example |
|-------|----------|--------|---------|
| `name` | Yes | lowercase-hyphens | `code-reviewer` |
| `description` | Yes | Text + examples | `Use when... <example>...` |
| `model` | Yes | inherit/sonnet/opus/haiku | inherit |
| `color` | Yes | Color name | blue |
| `tools` | No | Array of tool names | `["Read", "Grep"]` |

但**引擎侧**（mods 类型）暴露的 `AgentSpec` 才是完整 schema，并在注释中声称它就是"agent 文件或 `--agents` 条目可携带的全部字段"：

> `mods/types/claude-code.d.ts:347-437`

| 字段 | 类型 | 语义（原文要点） | 行号 |
|---|---|---|---|
| `name` | `string` | 短名（字母/数字/`_`/`-`，≤64）；完整类型为 `<plugin>:<name>` | 354-359 |
| `description` | `string` | "When to delegate to this agent"——模型代理列表里读到的行 | 360-364 |
| `prompt` | `string` | 系统提示词整体，"replaces the session's" | 365-368 |
| `tools?` | `readonly string[]` | 允许的工具白名单；**省略 = 继承父级全部工具** | 369-373 |
| `disallowedTools?` | `readonly string[]` | 在 `tools` 允许范围内再扣掉的工具黑名单 | 374-377 |
| `model?` | `string` | 别名（`haiku`/`sonnet`/`opus`）、完整 id 或 `inherit`；省略 = 会话的子代理默认 | 378-382 |
| `effort?` | `string \| number` | effort 级别或整数预算 | 383-387 |
| `permissionMode?` | `string` | 权限模式，省略 = 继承父级 | 388-394 |
| `mcpServers?` | `readonly (string \| Record)[]` | 该 agent 运行时额外连接的 MCP | 395-399 |
| `hooks?` | `Record<string, unknown>` | 运行期强制的 hooks | 400-404 |
| `maxTurns?` | `number` | 最大回合数 | 405-408 |
| `skills?` | `readonly string[]` | **首回合前预加载进上下文的技能名** | 409-412 |
| `initialPrompt?` | `string` | 首条用户消息；其中的 `{{intent}}` 由 spawn 的 prompt 填充 | 413-417 |
| `memory?` | `'user'\|'project'\|'local'` | 跨运行持久记忆及其作用域 | 418-422 |
| `background?` | `true` | 让该 agent 的每次 spawn 都在后台运行 | 423-426 |
| `omitClaudeMd?` | `true` | 该 agent 上下文**不携带任何 CLAUDE.md 块** | 427-431 |
| `isolation?` | `'worktree'\|'remote'` | 在独立 git worktree 或云端会话中运行 | 432-436 |

> 注：文件级 frontmatter 中 `prompt` 的载体是 **markdown 正文**（body），`AgentSpec.prompt` 是同一语义的程序化形式。

原文照录一个完整的代理 frontmatter（`plugins/pr-review-toolkit/agents/code-reviewer.md:1-5`，description 因含 `<example>` 示例而极长，此处缩略）：

```yaml
---
name: code-reviewer
description: Use this agent when you need to review code for adherence to project guidelines, style guides, and best practices. This agent should be used proactively after writing or modifying code... \n\nExamples:\n<example>\nContext: ...\nuser: "..."\nassistant: "I'll use the Task tool to launch the code-reviewer agent..."\n<commentary>\n...</commentary>\n</example>...
model: opus
color: green
---
```

再照录一个带工具限制、tools 用逗号字符串形式的（`plugins/feature-dev/agents/code-explorer.md:1-6`）：

```yaml
---
name: code-explorer
description: Deeply analyzes existing codebase features by tracing execution paths, mapping architecture layers, understanding patterns and abstractions...
tools: Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch, KillShell, BashOutput
model: sonnet
color: yellow
---
```

以及 tools 用 JSON 数组形式的（`plugins/hookify/agents/conversation-analyzer.md:1-6`）：

```yaml
---
name: conversation-analyzer
description: Use this agent when analyzing conversation transcripts to find behaviors worth preventing with hooks. Examples: <example>...
model: inherit
color: yellow
tools: ["Read", "Grep"]
---
```

**结论：`tools` 接受两种写法**——逗号分隔的裸字符串，或 JSON 字符串数组；二者等价（`agent-development/SKILL.md:148-160`，`command-development/references/frontmatter-reference.md:60-88` 对命令的 `allowed-tools` 亦然）。

#### 字段观察统计（15 个代理文件）

| 字段 | 出现次数 | 取值分布 |
|---|---|---|
| `name` | 15/15 | 全部 kebab-case |
| `description` | 15/15 | 全部含 `<example>` 触发示例（部分内联 `\n`） |
| `model` | 15/15 | `sonnet`×5（feature-dev 3 + agent-sdk-dev 2）、`opus`×2（pr-review-toolkit 的 code-reviewer / code-simplifier）、`inherit`×8 |
| `color` | 14/15 | green×3, yellow×4, cyan×2, red×1, magenta×1, pink×1；**唯一的例外是 `pr-review-toolkit/agents/code-simplifier.md`（无 color）** |
| `tools` | 8/15 | feature-dev 3 个用逗号串；plugin-dev/hookify 5 个用 JSON 数组 |

对应关系（文件:行）见 `关键文件索引`。

### 3.2 "description 即路由"——委派模式

子代理的委派**完全由 `description` 驱动**。作者指南反复强调这是"the most critical field"（`agent-development/SKILL.md:84`），并要求写成：

> "Use this agent when [conditions]. Examples: <example>Context:...user:...assistant:...<commentary>...</commentary></example>..."

引擎侧对应字段是 `AgentOfferInput.description`——注释明确它是"该定义在模型代理列表中的那一行文本（`whenToUse`）"（`claude-code.d.ts:190-193`）。也就是说：**模型看到的不是文件，而是一行由 `description` 渲染出来的 whenToUse 文本**，再由模型自主决定是否委派。

`AgentOfferInput` 还携带 `agent`（类型名）、`source`（`built-in`/`plugin`/settings）、`provider`（插件 + 层级）（`claude-code.d.ts:184-204`）。这解释了为何**同名代理不会互相覆盖**：`agent.offer` hook 可以按 `provider` 区分内置 `Explore` 与用户自定义的 `Explore`（`claude-code.d.ts:194-198`）。

一个可直接复用的"路由资产"是本仓库中**高质量 description** 的三种范式：

1. **触发 + 反例**（什么时候不用）：`skill-reviewer` 的描述明确"Use this agent when the user has created or modified a skill and needs quality review..."（`plugin-dev/agents/skill-reviewer.md:3`）。
2. **主动式（proactive）触发**：`pr-review-toolkit/agents/code-reviewer.md:3` 写"should be used proactively after writing or modifying code, especially before committing"。
3. **消费方式提示**：`pr-review-toolkit/agents/code-reviewer.md:3` 还告诉调用方"the agent needs to know which files to focus on ... In most cases this will recently completed work which is unstaged in git (can be retrieved by doing a git diff)"——即把"入参约定"写进 description。

### 3.3 工具限制语义（least privilege）

三条规则（`claude-code.d.ts:369-377` + `agent-development/SKILL.md:142-160`）：

1. **省略 `tools` ⇒ 继承父级全部工具**（最宽松）。
2. **给出 `tools` ⇒ 白名单**：调用任何未列出工具被拒（"a call to any other is refused"）。
3. **`disallowedTools` 是白名单之上的二次扣减**。

官方给出的常用工具集（`agent-development/SKILL.md:156-160`）：

- 只读分析：`["Read", "Grep", "Glob"]`
- 代码生成：`["Read", "Write", "Grep"]`
- 测试：`["Read", "Bash", "Grep"]`
- 全权：省略或 `["*"]`

仓库内的实际取舍：`feature-dev` 三个代理是**只读探索型**，因此 tools 只含 `Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch, KillShell, BashOutput`——注意**没有 `Write`/`Edit`/`Bash`**（`feature-dev/agents/code-explorer.md:4`）。反之 `plugin-dev/agents/agent-creator.md:34` 只给 `["Write","Read"]`（因为它要**写 agent 文件**），`plugin-validator.md:36` 给 `["Read","Grep","Glob","Bash"]`（要跑 `jq` 校验 JSON）。

**命令**侧对应的 `allowed-tools` 还支持**命令级过滤器**与 **MCP 工具通配**：

- `Bash(git checkout --branch:*), Bash(git add:*), ...`（`.claude/commands/commit-push-pr.md:2`）——只放行特定 git 子命令前缀。
- `mcp__github_inline_comment__create_inline_comment`（`plugins/code-review/commands/code-review.md:2`）——直接点名某个 MCP 工具。
- `mcp__plugin_asana_asana__*`（`plugins/plugin-dev/skills/mcp-integration/SKILL.md:218`）——MCP 工具通配。

### 3.4 模型选择与覆盖语义

- **代理文件级**：`model: inherit | sonnet | opus | haiku`（full id 亦可），推荐默认 `inherit`（`agent-development/SKILL.md:115-125`）。
- **运行时解析顺序**：`Agent` 工具 call 的 `model` 参数 → agent 定义自带 `model` → 父级模型（`claude-code.d.ts:260-272`）。
  > "undefined lets the agent's own model, then the parent's, decide."
- **fork 强制继承**：`fork` 子代理忽略 `model`，始终继承父级上下文与模型（`claude-code.d.ts:295-299`）。
- **`parentModel` 是 pinned 事实**，hook 不能改；要改只有设置 `model`（`claude-code.d.ts:268-272`）。

成本分层的实用范式（本仓库）：

- **轻量筛查用 `haiku`**：code-review 第一步"检查 PR 是否已关闭/草稿/已被评论"派 haiku（`code-review.md:14-24`）。
- **默认审查用 `sonnet`**：CLAUDE.md 合规、变更摘要（`code-review.md:24-32`；`feature-dev` 三个 agent 均 sonnet）。
- **高强度推理用 `opus`**：bug / 逻辑 / 类型设计 / 简化（`code-review.md:35-55`；`pr-review-toolkit/agents/code-reviewer.md:4`、`code-simplifier.md:35` 均 opus）。

### 3.5 Agent Skills frontmatter schema

仓库内 10 个 `SKILL.md` **实际出现**的字段仅 4 个：`name`、`description`（必填）、`version`、`license`。

作者契约（`skill-development/SKILL.md:25-40,164-170`）：

| Field | Required | 说明 | 行号 |
|---|---|---|---|
| `name` | 是 | 展示名（如 `Agent Development`），非目录名 | 33-34 |
| `description` | 是 | **第三人称 + 具体触发短语**，决定何时加载 | 33-34,162-170 |
| `version` | 否 | 语义化版本，如 `0.1.0` | 168 |
| `license` | 否 | 许可证说明，如 `Complete terms in LICENSE.txt` | 前端设计 skill 实际使用 |

`skill-reviewer` 代理补充了两个点（`plugins/plugin-dev/agents/skill-reviewer.md:22-23`）：

> "Required fields: `name`, `description` / Optional fields: `version`, `when_to_use` (**note: deprecated, use description only**)"

即 `when_to_use` 是历史字段，已被 `description` 取代。**注意**：`allowed-tools` 在**本仓库任何 `SKILL.md` 的 frontmatter 中都未出现**（`plugin-dev/skills/*/SKILL.md` 里出现的 `allowed-tools` 全部是正文示例，讨论的是*命令*或 MCP 工具）；平台是否支持 skill 级 `allowed-tools` 无法从本仓库证实——列入 `存疑`。

原文照录（`plugins/frontend-design/skills/frontend-design/SKILL.md:1-5`）：

```yaml
---
name: frontend-design
description: Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.
license: Complete terms in LICENSE.txt
---
```

以及 `version` 型（`plugins/plugin-dev/skills/skill-development/SKILL.md:1-5`）：

```yaml
---
name: Skill Development
description: This skill should be used when the user wants to "create a skill", "add a skill to plugin", "write a new skill", "improve skill description", "organize skill content", or needs guidance on skill structure, progressive disclosure, or skill development best practices for Claude Code plugins.
version: 0.1.0
---
```

**description 的写法规范**（`skill-development/SKILL.md:172-182`）：

- 好：`This skill should be used when the user asks to "create a hook", "add a PreToolUse hook", ...`
- 坏：`Use this skill when working with hooks.`（人称错、含糊）/ `Load when user needs hook help.`（非第三人称）/ `Provides hook guidance.`（无触发短语）

### 3.6 渐进式披露（Progressive Disclosure）模型

官方定义的三级加载（`skill-development/SKILL.md:77-85`）：

> 1. **Metadata (name + description)** — Always in context (~100 words)
> 2. **SKILL.md body** — When skill triggers (<5k words)
> 3. **Bundled resources** — As needed by Claude (Unlimited*)
>
> *Unlimited because scripts can be executed without reading into context window.

目录结构（`skill-development/SKILL.md:29-40`）：

```
skill-name/
├── SKILL.md (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation intended to be loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts, etc.)
```

三级资源各自的判定标准（`skill-development/SKILL.md:320-360`）：

| 层 | 内容 | 预算 |
|---|---|---|
| SKILL.md 正文 | 核心概念、必要流程、快速参考表、指向 references 的指针 | 1,500–2,000 词（硬上限 <3,000，`<5k` 为触发加载上限），`agent-development` 实际 1,438 词、`hook-development` 1,651 词 |
| `references/` | 详细模式、API 文档、迁移指南、边界情形 | 单文件 2,000–5,000+ 词；>10k 词应给 grep 模式 |
| `examples/` | 可直接复制运行的工作示例 | — |
| `scripts/` | 校验、测试、解析、自动化脚本 | 可**不读入上下文**直接执行（无限预算的来源） |

**引擎侧**的可观测证据：`ContextSkills` / `ContextSkill` 类型显示，列表有 **token 预算**，并非所有技能都被注入（`claude-code.d.ts:1936-1979`）：

- `ContextSkill = { name, source, pluginName?, tokens }`——列表按名字、来源、提供插件、估算 token 记账。
- `ContextSkills = { totalSkills, includedSkills, tokens, skillFrontmatter: ContextSkill[] }`——`includedSkills` 是"在 token 预算内被纳入列表的数量"。
- `source` 取值：`userSettings` | `plugin` | `built-in` | `mcp` | `syncedSkills`（`claude-code.d.ts:1945-1946`）。

`skill.prompt` hook 则允许在**技能被展开为提示词的那一刻**改写其文本（`claude-code.d.ts:9352-9375`）：

> "Typed as `/name`, called through the Skill tool, or preloaded into a subagent: the same event at each."

这印证了一个关键事实：**斜杠命令与技能在引擎里走的是同一条 Skill 工具通道**——`ContextSlashCommands` 的注释是"The slash commands **the Skill tool's prompt lists**, counted"（`claude-code.d.ts:1982-1996`）。

### 3.7 Slash Command frontmatter schema

官方完整参考见 `plugins/plugin-dev/skills/command-development/references/frontmatter-reference.md`。汇总（观察 + 文档）：

| Field | Required | Default | 语义 | 行号（frontmatter-reference） |
|---|---|---|---|---|
| `description` | 否 | 命令首行 | `/help` 展示，建议 ≤60 字符 | 24-58 |
| `allowed-tools` | 否 | 继承会话权限 | 工具白名单，支持 `Bash(git:*)` 过滤器 | 60-128 |
| `model` | 否 | 继承会话 | `sonnet`/`opus`/`haiku` | 130-194 |
| `argument-hint` | 否 | 无 | 参数提示/自动补全，如 `[pr-number] [priority]` | 196-268 |
| `disable-model-invocation` | 否 | `false` | 禁止 Skill 工具程序化调用，仅用户可键入 | 270-322 |
| `hide-from-slash-command-tool` | 否 | — | 仓库观察值，语义类似"对命令工具隐藏" | ralph-wiggum 实际使用 |

仓库实际使用情况（全部 18 个命令）：

- `description`：18/18
- `allowed-tools`：13/18
- `argument-hint`：6/18
- `model`：**0/18**（文档支持但本仓库未用）
- `disable-model-invocation`：**0/18**（文档支持但本仓库未用）
- `hide-from-slash-command-tool`：2/18（`ralph-wiggum` 的 `ralph-loop.md:5`、`cancel-ralph.md:4`）

原文照录一个最完整的（`plugins/ralph-wiggum/commands/ralph-loop.md:1-6`）：

```yaml
---
description: "Start Ralph Wiggum loop in current session"
argument-hint: "PROMPT [--max-iterations N] [--completion-promise TEXT]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh:*)"]
hide-from-slash-command-tool: "true"
---
```

以及仓库自用命令（`.claude/commands/triage-issue.md:1-4`）：

```yaml
---
allowed-tools: Bash(./scripts/gh.sh:*),Bash(./scripts/edit-issue-labels.sh:*)
description: Triage GitHub issues by analyzing and applying labels
---
```

### 3.8 命令 / 技能中的插值机制（可直接复刻）

来自 `command-development/SKILL.md:195-326` 与 `plugin-features-reference.md`：

| 语法 | 语义 | 例 |
|---|---|---|
| `$ARGUMENTS` | **全部参数**合并为单个字符串 | `Fix issue #$ARGUMENTS ...` → `/fix-issue 123` 得 `Fix issue #123 ...`（`SKILL.md:197-220`） |
| `$1`, `$2`, `$3` | **位置参数** | `Review PR #$1 with priority $2` → `Review PR #123 with priority high`（`SKILL.md:222-245`） |
| `@path` | **文件引用**：预先读入该文件内容 | `Review @$1`；`Compare @src/old.js with @src/new.js`（`SKILL.md:265-314`） |
| `` !`cmd` `` | **内联执行 bash** 并把 stdout 注入提示词 | `Current changes: !`git diff --name-only``（`SKILL.md:316-326`） |
| ` ```! ` 围栏 | 多行 bash 块（仓库观察到的变体） | `` ```! ` + 换行 + `"${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" $ARGUMENTS`（`ralph-loop.md:12-14`） |
| `${CLAUDE_PLUGIN_ROOT}` | 插件根目录绝对路径环境变量 | `!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh``（`plugin-features-reference.md:97`） |

位置参数与剩余参数可混用：`Deploy $1 to $2 environment with options: $3`（`SKILL.md:247-263`）。文件引用的静态形式也支持：`Review @package.json and @tsconfig.json for consistency`（`SKILL.md:303-314`）。

**注意**：`$ARGUMENTS` 是"整体字符串"，`$1`/`$2` 才按空格切分；当参数是可选多词时（如 `argument-hint: "PROMPT [--max-iterations N] ..."`）应整体用 `$ARGUMENTS`（`ralph-loop.md:13`）。另外 `argument-hint` 必须与实际位置参数**顺序一致**，否则校验会失败（`frontmatter-reference.md:231-236,451-453`）。

### 3.9 Agent SDK 开发套件（`plugins/agent-sdk-dev/`）

`/new-sdk-app` 命令是一个**交互式脚手架 + 验证**工作流，含两套语言的**分叉最佳实践**：

- **TS**：`npm init -y`，`package.json` 必须 `"type": "module"`（ESM），配 `tsconfig.json`，并生成 `typecheck` 脚本；收尾必须 `npx tsc --noEmit` 通过（`commands/new-sdk-app.md:68,117-122`）。
- **Python**：`requirements.txt` 或 `poetry init`，安装 `claude-agent-sdk`，可选配置；收尾做导入与语法校验（`new-sdk-app.md:69-72,123-126`）。
- **共同**：安装前**用 WebSearch/WebFetch 核对最新版本**（`npm install @anthropic-ai/claude-agent-sdk@latest` / `pip install claude-agent-sdk`），生成 `.env.example` 且把 `.env` 加进 `.gitignore`（`new-sdk-app.md:74-100`）。
- **验证阶段**按语言分派到 `agent-sdk-verifier-ts`（`model: sonnet`）或 `agent-sdk-verifier-py`（`model: sonnet`）——两个 verifier 代理的 `description` 都写明"should be invoked after an ... app has been created or modified"（`agents/agent-sdk-verifier-ts.md:2-4`）。
- verifier 输出约定为 `PASS / PASS WITH WARNINGS / FAIL` + 分级问题 + 通过项 + 带 SDK 文档引用的建议（`agent-sdk-dev/README.md:75-81`）。

这套套件本身就是"**用代理验证代理产物**"的闭环示范；`security-guidance` 插件则在 hooks 里**直接 import `claude_agent_sdk`**（`hooks/llm.py:287`、`hooks/ensure_agent_sdk.py:2-5,131`），是 SDK 被引擎自身生态消费的实证。

---

## 数据流 / 时序

### 4.1 子代理委派时序（模型发起）

```
用户/命令提示词
      │  (模型读到代理列表：每行 = AgentOfferInput.description/whenToUse)
      ▼
模型决定委派 → 发起 Agent/Task 工具调用
      │  AgentSpawnInput { prompt, description, subagentType, model?, ... }
      ▼
agent.offer  事件（列给模型时 / 按名派发时同一事件）
      │  可返回 { isOffered:false } 把该类型对模型隐藏
      ▼
agent.spawn  事件（引擎决定即将启动子代理，模型尚未解析）
      │  hook 可改写 prompt/description/subagentType/model/background/cwd
      │  pinned 不可改：tool_use_id/name/fork/parentModel/permissionMode/parentAgentId/provider
      ▼
解析 model：call.model → agent.model → parent.model(inherit)
      ▼
子代理在**独立上下文窗口**中运行其循环
      │  其内部的 tool.call 事件携带 agentId = 该 loop 的 id
      ▼
子代理最终答复 = 它自己的 turn.complete（携带该 agentId）
      ▼
父级（或发起 hook）拿到结果；AgentInfo 可经 $.agent.list() 枚举
```

证据：`claude-code.d.ts:176-345`（offer / spawn / result 全链）与 `3351-3362`、`3739-3743`（事件名与类型映射）。

### 4.2 code-review 命令的四阶段扇出（仓库内最完整的编排范例）

`plugins/code-review/commands/code-review.md:12-77` 描述了一条**顺序 + 并行混合**的多代理流水线：

1. `haiku` 代理：预检（PR 是否关闭/草稿/无需审查/已评论）→ 任一为真则**停**（`:14-20`）。
2. `haiku` 代理：列出相关的 CLAUDE.md **路径**（不含内容）（`:24-26`）。
3. `sonnet` 代理：读 PR 并返回变更摘要（`:28`）。
4. **并行 4 路**：2 个 `sonnet` 做 CLAUDE.md 合规、2 个 `opus` 做 bug 检测（一个只看 diff、一个看被引入代码）——并强调"only HIGH SIGNAL issues"（`:30-53`）。
5. 对第 4 步每个问题，再**并行**派验证代理（bug 用 opus、CLAUDE.md 用 sonnet）确认（`:55`）。
6. 过滤掉未通过验证的问题（`:57`）。
7. 可选 `--comment` 才回写 GitHub；否则只打印（`:59-77`）。

这套"**先广撒网、再验证、只留高信号**"的置信度过滤，是子代理编排中可直接复用的降误报模式，与 `pr-review-toolkit` 代理内部的 0-100 置信度打分（只报 ≥80）互为呼应（`pr-review-toolkit/agents/code-reviewer.md:5` 之后的正文）。

### 4.3 Skill 触发 / 斜杠命令展开时序

```
会话启动
  ├─ 扫描 skills/ 与 commands/（plugin.json 的 commands/agents 字段可加路径）
  ├─ 技能元数据(name+description) 常驻上下文（受 ContextSkills token 预算约束）
  └─ 斜杠命令进入 Skill 工具提示词列表（ContextSlashCommands）
        │
用户键入 /name  ──→ 命令模板做确定性插值：
        │            $ARGUMENTS / $1..$n / @file / !`bash`
        ▼
   展开后的提示词进入当前上下文（无独立上下文）
        │
模型在任务中命中某技能 description ──→ Skill 工具加载
        ▼
skill.prompt 事件（可改写文本）→ 注入 SKILL.md 正文
        ▼
正文中的 "Additional Resources" 指针 → 按需读 references/ / examples/ / 执行 scripts/
```

证据：`skill-development/SKILL.md:77-85,269-277`（自动发现与三级加载）、`claude-code.d.ts:1936-1996`（token 预算与 Skill 工具列表）、`9352-9375`（`skill.prompt`）。

---

## 扩展点

| 扩展点 | 机制 | 关键文件 / 类型 |
|---|---|---|
| **新增子代理** | 在 `agents/` 放 `*.md`，全部自动发现；命名空间 `<plugin>:<name>` | `agent-development/SKILL.md:287-306`；`claude-code.d.ts:354-359` |
| **运行时注册代理** | 插件调 `$.agent.register(spec)`，从下一回合起对 `Agent` 工具可派发 | `claude-code.d.ts:2703-2728` |
| **程序化拉起子代理** | `$.agent.spawn({prompt, subagentType, model?, name?, cwd?})`，后台运行，返回 `{model, agentId}` | `claude-code.d.ts:2685-2702,323-345` |
| **枚举子代理** | `$.agent.list() → AgentInfo[]`（含 `spawnedBy`、`parentId`、`status`、`name`） | `claude-code.d.ts:117-154,2702` |
| **隐藏/拦截代理** | `agent.offer` hook 返回 `{isOffered:false}` 对模型隐藏；`agent.spawn` hook 可改写或 `{deny}` 拒绝 | `claude-code.d.ts:206-212,3351-3362` |
| **新增技能** | `skills/<name>/SKILL.md` + 可选 `references/ examples/ scripts/`；自动发现 | `skill-development/SKILL.md:251-292` |
| **预加载技能进子代理** | agent 定义里 `skills?: string[]`（首回合前注入） | `claude-code.d.ts:409-412` |
| **改写技能文本** | `skill.prompt` hook 返回 `{text}` | `claude-code.d.ts:9352-9375` |
| **新增命令** | `commands/*.md`（支持子目录命名空间）；plugin.json `commands` 字段可加路径 | `plugin-structure/references/manifest-reference.md:211-242` |
| **命令内联 bash / 文件注入** | `` !`cmd` `` / `@path` / `${CLAUDE_PLUGIN_ROOT}` | `command-development/SKILL.md:265-326` |
| **私有命令** | `hide-from-slash-command-tool: "true"`（对命令工具隐藏）、`disable-model-invocation: true`（禁止程序调用） | `ralph-loop.md:5`；`frontmatter-reference.md:270-322` |
| **代理隔离** | agent 定义 `isolation: worktree\|remote`、`omitClaudeMd: true`、`memory: user\|project\|local` | `claude-code.d.ts:418-436` |
| **插件清单** | `.claude-plugin/plugin.json`：`name`(必填)、`version`、`description`、`author`、`homepage`、`repository`、`license`、`keywords`、`commands`、`agents`、`hooks`、`mcpServers` | `manifest-reference.md:11-330` |
| **市场分发** | `.claude-plugin/marketplace.json` 的 `plugins[]`（含 `source`、`category`） | `.claude-plugin/marketplace.json` |

---

## 设计决策与权衡

### 6.1 frontmatter 一律 YAML、字段极简

三类文件都是"YAML frontmatter + Markdown 正文"，且**必填字段极少**（agent: name/description/model/color；skill: name/description；command: 全选填）。这是刻意的低门槛设计：命令可以**完全无 frontmatter**就工作（`frontmatter-reference.md:20`）。权衡：灵活，但把大量行为约束转移到了**自然语言描述**里（description 成为事实上的路由配置）。

### 6.2 用 `description` 做路由而非显式声明

不引入 `triggers:` / `match:` 之类结构化字段，而是让模型读一段自然语言 + `<example>` 来决定委派。好处是**零语法负担、语义灵活**；代价是**可预测性差**——`pr-review-toolkit/README.md:265-281` 专门用一节"Agent Not Triggering / Analyzing Wrong Files"来教用户怎么"提高命中率"，等于官方承认路由是概率性的。这是复刻产品必须正视的权衡：要么接受软路由，要么补一个结构化触发字段。

### 6.3 渐进式披露 vs. 上下文预算

把"知识"分成 metadata / body / resources 三级，是为了**在 token 预算内塞下尽可能多的技能**。引擎侧用 `ContextSkills.includedSkills` 明示"不是所有技能都能进列表"（`claude-code.d.ts:1962-1978`）。权衡：SKILL.md 越薄，触发后覆盖度越低（需要更多次读 references）；官方给出的折中是 body 1,500–2,000 词、references 单文件 2,000–5,000+ 词（`skill-development/SKILL.md:329,340`）。

### 6.4 子代理上下文隔离

子代理拥有独立上下文窗口、独立 `permissionMode` 继承、可选 `omitClaudeMd`/`isolation`。好处是**防止探索型任务污染主线上下文**、可并行、可给不同模型。代价是**信息需显式传递**：`feature-dev` 因此规定"让代理返回 5-10 个关键文件路径，父级再亲自读这些文件"（`feature-dev/commands/feature-dev.md:41-52`）——因为子代理的中间推理不会自动回流。

### 6.5 模型分层以控成本

仓库统一采用 haiku（预检/列举）→ sonnet（常规审查/探索）→ opus（bug/逻辑/类型/简化）的分层。这是把"模型能力"当作可配置资源、按任务价值分配的工程化选择。

### 6.6 命令与 Skill 共用一条工具通道

`ContextSlashCommands` 注释表明斜杠命令由 **Skill 工具**的提示词列出（`claude-code.d.ts:1982`），`skill.prompt` 事件对"`/name`、Skill 工具调用、子代理预加载"三种方式**一视同仁**（`claude-code.d.ts:9355-9356`）。好处是统一了扩展点；代价是命名空间与可见性控制需要用 `hide-from-slash-command-tool` / `disable-model-invocation` 这类"补丁式"字段来微调。

### 6.7 文档-实现漂移

如 2.3 所述，code-review 的"5 agents"是文档/清单承诺，但产物是**命令内联编排**。这说明官方在"具名代理文件"与"命令里临时拉代理"之间是**混用**的——小团队/一次性编排倾向于不落文件。

---

## 对复刻产品的启示

1. **照抄 frontmatter 最小集，但要预留完整 schema**：以 `name`/`description`（+ 代理的 `model`/`color`、命令的 `allowed-tools`）为必填，其余选填；同时把 `AgentSpec`（`claude-code.d.ts:354-437`）当作"向前兼容的字段全集"设计，避免未来加字段时破坏解析。

2. **把 `description` 当作一等路由 API 来设计**：提供官方 `<example>` 模板与 `skill-reviewer` 式的 description 质量校验（触发短语、第三人称、长度 50–500 字符、正向 + 正向反例）。软路由的误命中最容易成为用户抱怨，需要在产品层给出可诊断工具（如"为什么这个代理没触发"）。

3. **工具限制用"白名单 + 二次黑名单 + 通配/前缀过滤器"三层**：`tools`（白名单，省略=全权）/ `disallowedTools` / `Bash(git:*)`、`mcp__x__*`。省略即全权这个默认值风险较高，复刻时若追求安全应改为默认最小集并允许显式放开。

4. **模型分层是标配能力**：实现 `inherit | haiku | sonnet | opus | <full-id>`，并固化解析顺序 `call → agent → parent`；fork/子代理的继承语义要单独写清（fork 恒继承）。

5. **子代理必须真隔离上下文**，并提供"结构化回传"约定（如返回文件路径列表而非全文），否则并行会退化成上下文爆炸。

6. **渐进式披露要落到预算上**：metadata 常驻、body 触发加载、resources 按需（脚本可执行不读入），并在 UI/诊断里暴露"多少技能进了列表、占多少 token"（对齐 `ContextSkills`）。

7. **插值语法是命令的核心竞争力**：`$ARGUMENTS` / `$1..$n` / `@file` / `` !`bash` `` / `${PLUGIN_ROOT}`。实现时要语义分明（整体 vs. 位置 vs. 文件 vs. 执行），并对 `argument-hint` 与实际位置参数做一致性校验。

8. **同时支持"具名代理文件"和"命令内临时编排"**：本仓库两种模式并存且都被官方采用；复刻产品若只支持其一，会损失一大类用法。

9. **给 Skill/命令统一的工具可见性开关**（`hide-from-slash-command-tool` / `disable-model-invocation`），用于区分"用户可键入"与"模型可程序调用"。

10. **SDK 是第二条护城河**：`/new-sdk-app` 展示的"交互问答 → 拉最新版本 → 生成骨架 → 用代理自验证"闭环，值得照搬到任何"把 agent 循环嵌入宿主程序"的产品里。

---

## 关键文件索引

### 子代理（`agents/*.md`，共 15 个）

| 文件 | frontmatter 关键行 | model / color / tools |
|---|---|---|
| `plugins/agent-sdk-dev/agents/agent-sdk-verifier-py.md` | name:2, description:3, model:4 | `sonnet` |
| `plugins/agent-sdk-dev/agents/agent-sdk-verifier-ts.md` | name:2, description:3, model:4 | `sonnet` |
| `plugins/feature-dev/agents/code-architect.md` | name:2, description:3, tools:4, model:5, color:6 | `sonnet` / green / 只读集 |
| `plugins/feature-dev/agents/code-explorer.md` | name:2, description:3, tools:4, model:5, color:6 | `sonnet` / yellow / 只读集 |
| `plugins/feature-dev/agents/code-reviewer.md` | name:2, description:3, tools:4, model:5, color:6 | `sonnet` / red / 只读集 |
| `plugins/hookify/agents/conversation-analyzer.md` | name:2, description:3, model:4, color:5, tools:6 | `inherit` / yellow / `["Read","Grep"]` |
| `plugins/plugin-dev/agents/agent-creator.md` | name:2, description:3, model:32, color:33, tools:34 | `sonnet` / magenta / `["Write","Read"]` |
| `plugins/plugin-dev/agents/plugin-validator.md` | name:2, description:3, model:34, color:35, tools:36 | `inherit` / yellow / `["Read","Grep","Glob","Bash"]` |
| `plugins/plugin-dev/agents/skill-reviewer.md` | name:2, description:3, model:33, color:34, tools:35 | `inherit` / cyan / `["Read","Grep","Glob"]` |
| `plugins/pr-review-toolkit/agents/code-reviewer.md` | name:2, description:3, model:4, color:5 | `opus` / green |
| `plugins/pr-review-toolkit/agents/code-simplifier.md` | name:2, description:3, model:35 | `opus` / **无 color** |
| `plugins/pr-review-toolkit/agents/comment-analyzer.md` | name:2, description:3, model:4, color:5 | `inherit` / green |
| `plugins/pr-review-toolkit/agents/pr-test-analyzer.md` | name:2, description:3, model:4, color:5 | `inherit` / cyan |
| `plugins/pr-review-toolkit/agents/silent-failure-hunter.md` | name:2, description:3, model:4, color:5 | `inherit` / yellow |
| `plugins/pr-review-toolkit/agents/type-design-analyzer.md` | name:2, description:3, model:4, color:5 | `inherit` / pink |

> 说明：task 提示里"`plugins/code-review/agents/*.md`（5 个并行 Sonnet 代理）"**在本仓库快照中不存在**——该插件只有 `commands/code-review.md`。相关"5 路并行"以提示词形式内联在命令体中（`code-review.md:14-55`），由通用代理 + haiku/sonnet/opus 别名运行时拉起。

### 技能（`SKILL.md`，共 10 个）

| 文件 | frontmatter 字段 |
|---|---|
| `plugins/claude-opus-4-5-migration/skills/claude-opus-4-5-migration/SKILL.md` | name:2, description:3 |
| `plugins/frontend-design/skills/frontend-design/SKILL.md` | name:2, description:3, license:4 |
| `plugins/hookify/skills/writing-rules/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/agent-development/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/command-development/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/hook-development/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/mcp-integration/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/plugin-settings/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/plugin-structure/SKILL.md` | name:2, description:3, version:4 |
| `plugins/plugin-dev/skills/skill-development/SKILL.md` | name:2, description:3, version:4 |

技能支撑资源的组织范例（渐进式披露落地）：

- `plugins/plugin-dev/skills/agent-development/{references/triggering-examples.md, references/system-prompt-design.md, references/agent-creation-system-prompt.md, examples/complete-agent-examples.md, scripts/validate-agent.sh}`
- `plugins/plugin-dev/skills/command-development/references/frontmatter-reference.md`（命令 schema 权威参考）
- `plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md`（plugin.json schema 权威参考）
- `plugins/claude-opus-4-5-migration/skills/claude-opus-4-5-migration/references/{effort.md, prompt-snippets.md}`（references 按需加载的实例）

### 斜杠命令（`commands/*.md`）

仓库自用（`.claude/commands/`）：`commit-push-pr.md`、`dedupe.md`、`triage-issue.md`（均 `allowed-tools` + `description`）。

插件命令（15 个）：`agent-sdk-dev/commands/new-sdk-app.md`、`code-review/commands/code-review.md`、`commit-commands/commands/{commit,commit-push-pr,clean_gone}.md`、`feature-dev/commands/feature-dev.md`、`hookify/commands/{hookify,configure,help,list}.md`、`plugin-dev/commands/create-plugin.md`、`pr-review-toolkit/commands/review-pr.md`、`ralph-wiggum/commands/{ralph-loop,cancel-ralph,help}.md`。

### 引擎接口 / 清单 / 说明

- `mods/types/claude-code.d.ts`：`AgentInfo:117`、`AgentLoop:164`、`AgentOfferInput:184`、`AgentOfferResult:210`、`AgentSpawnArgs:221`、`AgentSpawnInput:231`、`AgentSpawnResult:323`、`AgentSpec:354`、`ContextSkill:1938`、`ContextSkills:1962`、`ContextSlashCommands:1984`、`SkillPromptInput:9358`、`SkillPromptResult:9373`、`agent.spawn/list/register API:2685-2728`。
- `plugins/README.md`（插件总览，含"插件结构"六件套：`.claude-plugin/plugin.json` / `commands/` / `agents/` / `skills/` / `hooks/` / `.mcp.json`）。
- `.claude-plugin/marketplace.json`（市场清单，`plugins[]` 的 `source` 与 `category`）。
- 各插件 `.claude-plugin/plugin.json`（如 `plugins/plugin-dev/...` 与 `plugins/pr-review-toolkit/...` 的 `name/version/description/author`）。
- `README.md`（仓库根，指向 `plugins/README.md` 与官方文档）。
- `CLAUDE.md`（仓库自身的 CI 加固约定，与本文主题弱相关，仅说明 `CLAUDE.md` 是被代理/技能消费的项目上下文来源）。

---

## 存疑与待确认

1. **`plugins/code-review/agents/*.md` 不存在**。task 与 `plugins/README.md:17`、marketplace 描述都声称该插件有"5 parallel Sonnet agents"，但快照目录只有 `plugin.json`/`README.md`/`commands/code-review.md`。究竟是**文档未随实现更新**，还是 agent 文件在别处/历史版本中，无法从本仓库确认。文中所有"code-review 的 5 路并行"均按**命令内联编排**描述。

2. **`SKILL.md` 是否支持 `allowed-tools`**：本仓库 10 个 SKILL.md 的 frontmatter **均无** `allowed-tools`（出现的都是正文示例，谈的是命令/MCP）。作者指南 `skill-development/SKILL.md` 也只列 `name`/`description`/`version`。因此 skill 级工具限制**在本仓库不可证实**。

3. **代理 frontmatter 与 `AgentSpec` 的确切对应**：`AgentSpec` 注释自称"agent 文件可携带的全部字段"（`claude-code.d.ts:347-353`），但仓库内 15 个文件只用了 `name/description/tools/model/color`；`effort`/`permissionMode`/`mcpServers`/`hooks`/`maxTurns`/`skills`/`initialPrompt`/`memory`/`background`/`omitClaudeMd`/`isolation` 等在**文件 frontmatter 中的具体键名**（如 `omitClaudeMd` 是否写作 `omit-claude-md`）无法从文件证据确认。另外 `color` 只存在于文件与作者指南，**不在 `AgentSpec` 类型里**，推测为纯 UI 字段。

4. **`when_to_use` 的现状**：仅由 `skill-reviewer` 代理文本提及且标为 deprecated（`plugin-dev/agents/skill-reviewer.md:22-23`），仓库内无 SKILL.md 使用；其与 `description` 的正式关系未在其他权威文件中复述。

5. **`hide-from-slash-command-tool` 的完整语义**：仅在 `ralph-wiggum` 两个命令中出现，取值为字符串 `"true"`（`ralph-loop.md:5`），与 `disable-model-invocation`（boolean，文档有、仓库无）的关系未说明；两者是否等价/可叠加待确认。

6. **`argument-hint` 重复出现在命令正文示例中的行号**（如 `command-development/SKILL.md:172` 等）属于**文档示例**而非真实命令，检索时易误判，已在上表区分。

7. **Skill 列表的 token 预算具体数值**：`ContextSkills` 只暴露 `tokens`/`includedSkills` 计数，预算阈值未在类型中给出。

8. **`mods/types/claude-code.d.ts` 的权威级别**：它是"mods"（二次开发）类型面，反映引擎对插件暴露的接口，但**不等同于**引擎内部实现；用它解释 frontmatter 语义时应视为"官方对外契约"而非"实现真相"。

9. **`tools` 中出现的工具名**（`LS`、`NotebookRead`、`KillShell`、`BashOutput`、`MultiEdit` 等）是**引擎内置工具名**，其完整清单与语义不在本仓库范围内，仅能确认它们被用作白名单键。

10. **`$ARGUMENTS` 的转义 / 引号规则**：文档给了 `$ARGUMENTS`、`$1..$n`、`@path`、`` !`cmd` `` 的行为示例，但未说明参数含空格/特殊字符时的切分与转义细节，复刻时需自行定义。
