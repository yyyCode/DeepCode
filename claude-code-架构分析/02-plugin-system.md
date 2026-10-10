# 02 · Claude Code 插件系统

> 本文分析 `anthropics/claude-code` 公开仓库中呈现的 **Claude Code 插件系统**：打包（packaging）、发现（discovery）、安装（installation）、落座/加载（seating/loading），以及四类扩展点（commands、agents、skills、hooks）外加 MCP servers 与 mod。
> 所有结论尽量以仓库内的真实路径 + 行号佐证；字段一律保留英文，用反引号包裹。
> 注意：本仓库是 Claude Code 的**客户端/文档仓库**，不是引擎源码；插件系统的运行时行为只能从随附的 13 个官方插件、marketplace 索引、`plugin-dev` 工具包与 `mods/` 的说明中反推。

---

## 定位

插件系统是 Claude Code 的**扩展/二次开发层**：它让用户与团队在不修改 CLI 本体的前提下，向会话注入自定义能力，并可在项目、团队、marketplace 之间分发。

- 官方定性："Claude Code plugins are extensions that enhance Claude Code with custom slash commands, specialized agents, hooks, and MCP servers. Plugins can be shared across projects and teams"（`plugins/README.md:5-9`）。
- 插件是"配置 + 文件约定"的产物，而非编译进二进制的代码：一个插件就是一棵约定目录树，加一个 `.claude-plugin/plugin.json` 清单（`plugins/README.md:47-61`）。
- 扩展的维度被明确限定为：`commands/`（slash 命令）、`agents/`（子代理）、`skills/`（Agent Skills）、`hooks/`（事件钩子）、`.mcp.json`（外部工具）（`plugins/plugin-dev/skills/plugin-structure/SKILL.md:24-37`）。
- 与之并列但更强的一层是 **mod**：行为写在 hooks module（TypeScript 函数）里，能 hook 引擎自身事件（`mods/README.md:1-6`）。mod 是"随 Claude Code 内置发布"的插件，属于内核团队面向引擎的事件级扩展；普通插件面向的是命令/代理/技能层面的扩展。

一句话：插件系统 = **清单（manifest）+ 约定目录 + 自动发现（auto-discovery）+ 便携路径变量（`${CLAUDE_PLUGIN_ROOT}`）**。

---

## 职责与边界

### 插件系统负责
1. **打包约定**：定义插件的目录布局、文件命名、清单 schema（`plugin-structure/SKILL.md:20-119`）。
2. **发现与加载**：从约定目录自动发现组件，安装/启用时注册（`plugin-structure/SKILL.md:339-355`）。
3. **命名空间隔离**：命令与代理自动加 `plugin:<name>:<namespace>` 前缀，避免跨插件冲突（`command-development/SKILL.md:574-598`、`agent-development/SKILL.md:301-306`）。
4. **便携性**：以 `${CLAUDE_PLUGIN_ROOT}` 等环境变量解析插件内资源路径，保证跨平台/跨安装方式可移植（`plugin-structure/SKILL.md:256-301`、`hook-development/SKILL.md:322-338`）。
5. **分发**：通过 marketplace 索引（`.claude-plugin/marketplace.json`）列出可安装插件，`/plugin` 命令安装（`plugins/README.md:29-45`）。
6. **配置与状态**：以 `.claude/<plugin-name>.local.md` 存放每项目配置与状态（`plugin-settings/SKILL.md:20-40`）。

### 插件系统不负责 / 边界
- **不发明字段**：可用的清单字段、frontmatter 字段由引擎定义；仓库只是"使用者 + 记录者"（`manifest-reference.md:11-331`）。
- **不能热更新钩子**：hooks 在会话启动时加载，改 `hooks/hooks.json` 需重启（`hook-development/SKILL.md:572-597`、`plugin-settings/SKILL.md:367-383`）。
- **命令/代理/技能是"提示词注入"而非可执行代码**：命令正文是给模型看的指令（`command-development/SKILL.md:30-52`），技能是知识包，代理是带 system prompt 的子进程；真正执行任意逻辑要靠 hooks 脚本或 MCP server。
- **本仓库不含引擎**：运行时的发现时序、权限裁决、tier 落座等，只能从文档与 mod 描述推断（见"存疑"）。

### 本仓库的实际盘点（重要更正）
- 任务描述称"15 个官方插件"，实测 `plugins/` 下为 **13 个**目录（`plugins/` 列表），marketplace 也恰好列出 13 条（`.claude-plugin/marketplace.json:10-149`）。
- **`plugins/plugin-dev/` 没有 `.claude-plugin/plugin.json` 清单**（`find plugins/plugin-dev -name plugin.json` 为空；`.claude-plugin/` 目录不存在），却出现在 marketplace 中（`.claude-plugin/marketplace.json:105-115`）。这与"清单必需"的约定相矛盾，是仓库内的一个真实不一致（见"存疑"）。

---

## 关键抽象与接口

### 1. 插件清单 `.claude-plugin/plugin.json`

真实路径为 `plugins/<name>/.claude-plugin/plugin.json`（`plugin-structure/SKILL.md:26-27,48-49`）。**必填只有 `name`**（`plugin-structure/SKILL.md:50-56`）。

仓库内 13 个插件清单中实际出现的字段（穷举）：
`name`、`description`、`version`、`author`（对象 `{name,email}`）、`homepage`（仅 `security-guidance` 用）。

真实样例（`plugins/security-guidance/.claude-plugin/plugin.json`，全仓库字段最全的一份）：

```json
{
  "name": "security-guidance",
  "version": "2.0.0",
  "description": "Security review for Claude-generated code. Pattern-based warnings on edits, LLM-powered diff review on Stop, and an agentic commit reviewer that catches injection, XSS, SSRF, hardcoded secrets, and 25+ other vulnerability classes.",
  "author": {
    "name": "David Dworken",
    "email": "dworken@anthropic.com"
  },
  "homepage": "https://github.com/anthropics/claude-code/tree/main/plugins/security-guidance"
}
```

最简样例（`plugins/agent-sdk-dev/.claude-plugin/plugin.json`）只含 `name/description/version/author` 四段。

文档（`plugin-structure/references/manifest-reference.md`）声明的**完整字段集**（真实插件未必全用到）：

| 字段 | 类型 | 说明 | 出处 |
|------|------|------|------|
| `name` | string（必填） | kebab-case；正则 `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` | `manifest-reference.md:15-40` |
| `version` | string | semver，缺省 `"0.1.0"` | `manifest-reference.md:42-63` |
| `description` | string | 建议 50–200 字符 | `manifest-reference.md:65-84` |
| `author` | object \| string | `{name,email,url}`，也支持 `"Name <email> (url)"` | `manifest-reference.md:87-114` |
| `homepage` | string(url) | 文档/主页 | `manifest-reference.md:115-132` |
| `repository` | string \| object | `{type,url,directory}` | `manifest-reference.md:133-163` |
| `license` | string(SPDX) | 如 `MIT` | `manifest-reference.md:164-188` |
| `keywords` | string[] | 检索/分类 | `manifest-reference.md:189-208` |
| `commands` | string \| string[] | 追加命令目录，默认 `["./commands"]` | `manifest-reference.md:209-243` |
| `agents` | string \| string[] | 追加代理目录，默认 `["./agents"]` | `manifest-reference.md:244-258` |
| `hooks` | string \| object | 钩子文件路径或内联，默认 `"./hooks/hooks.json"` | `manifest-reference.md:259-297` |
| `mcpServers` | string \| object | MCP 配置路径或内联，默认 `./.mcp.json` | `manifest-reference.md:298-331` |

路径规则（`manifest-reference.md:332-372`）：必须相对、必须以 `./` 开头、禁止 `..`、仅用正斜杠；自定义路径**追加**而非替换默认目录（`plugin-structure/SKILL.md:100`、`manifest-reference.md:368-371`）。

### 2. Marketplace/索引 `.claude-plugin/marketplace.json`

顶层字段：`$schema`、`name`、`version`、`description`、`owner{name,email}`、`plugins[]`（`.claude-plugin/marketplace.json:1-10`）。

`plugins[]` 条目字段：`name`、`description`、`source`（相对路径字符串，如 `"./plugins/code-review"`）、`category`，以及可选的 `version`、`author{name,email}`（`.claude-plugin/marketplace.json:11-27`）。极简条目只有 `name/description/source/category`（如 `agent-sdk-dev`，`:11-16`）。

### 3. 四类扩展点 + MCP

| 扩展点 | 位置 | 载体 | 关键 frontmatter/JSON 字段 |
|--------|------|------|---------------------------|
| commands | `commands/**/*.md` | Markdown+frontmatter | `description`、`allowed-tools`、`model`、`argument-hint`、`disable-model-invocation` |
| agents | `agents/**/*.md` | Markdown+frontmatter（正文=system prompt） | `name`、`description`（含 `<example>`）、`model`、`color`、`tools` |
| skills | `skills/<name>/SKILL.md` | Markdown+frontmatter | `name`、`description`、`version`、`license` |
| hooks | `hooks/hooks.json` 或清单内联 | JSON | `hooks.<event>[].matcher` + `.hooks[]`（`type`、`command`/`prompt`、`timeout`） |
| MCP servers | `.mcp.json` 或清单内联 | JSON | `command`+`args`+`env`（stdio）／`type`+`url`（sse/http/ws） |

---

## 数据流 / 时序

### A. 组件发现与加载（安装→启用→会话）
自动发现顺序（`plugin-structure/SKILL.md:339-355`）：

```
plugin.json 读取 → 扫描 commands/*.md → 扫描 agents/*.md
                → 扫描 skills/*/SKILL.md → 加载 hooks/hooks.json（或清单内联）
                → 加载 .mcp.json（或清单内联）
```
- 时机：**安装时**注册组件；**启用时**可用；**下一次会话**生效，无需重启即可捕获改动（`plugin-structure/SKILL.md:350-353`）。但 hooks 例外：改动需重启（`hook-development/SKILL.md:572-589`）。
- 解析顺序：先默认目录，再清单自定义路径，二者合并、不覆盖，重名报错（`manifest-reference.md:352-372`）。

### B. 命令调用时序
用户输入 `/plugin-name:command` → 命令 Markdown 正文作为指令注入模型；其中 `$1/$2/$ARGUMENTS` 展开为参数、`@path` 触发读文件、`` !`cmd` `` 先执行 bash 并把输出并入上下文（`command-development/SKILL.md:196-263,316-326`）。命令可调用代理（Task 工具）、触发技能（`command-development/SKILL.md:647-715`）。

### C. 钩子事件时序
`hooks/hooks.json` 以插件包装格式 `{"description":..., "hooks":{...}}` 声明（`hook-development/SKILL.md:62-100`）；用户设置 `.claude/settings.json` 则用无包装的直接格式（`hook-development/SKILL.md:102-119`）。支持事件：PreToolUse、PostToolUse、Stop、SubagentStop、SessionStart、SessionEnd、UserPromptSubmit、PreCompact、Notification（`hook-development/SKILL.md:121-277`）。

- 钩子输入：stdin JSON，含 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name` 及事件专属字段（`hook-development/SKILL.md:300-320`）。
- 钩子输出：`{"continue","suppressOutput","systemMessage"}`；PreToolUse 可给 `hookSpecificOutput.permissionDecision`（`allow|deny|ask`）与 `updatedInput`；Stop 用 `{"decision":"approve|block","reason":...}`（`hook-development/SKILL.md:144-209,278-292`）。
- 退出码：0(=stdout 入 transcript)、2(=stderr 回喂模型)、其它=非阻断错误（`hook-development/SKILL.md:294-299`）。
- 并发：同一事件的多个匹配钩子**并行**执行、顺序不确定、彼此看不到对方输出（`hook-development/SKILL.md:495-518`）。

真实复杂样例：`plugins/security-guidance/hooks/hooks.json` 在 `PostToolUse` 上按 `matcher: "Bash"` + `if: "Bash(git commit:*)"` 区分，并用 `asyncRewake`/`rewakeMessage`/`rewakeSummary` 做后台安全复审回喂；`Stop` 上另有异步 LLM diff 复审（`plugins/security-guidance/hooks/hooks.json:35-70`）。hookify 用 Python 钩子在四个事件上做可配置校验（`plugins/hookify/hooks/hooks.json`）。

### D. 技能渐进式披露时序
三级加载：`name+description` 恒在上下文（~100 词）→ 触发时加载 `SKILL.md` 正文（<5k 词）→ 按需加载 `references/`、执行 `scripts/`（`skill-development/SKILL.md:77-85`）。插件内无需打包成 zip，随插件一起分发（`skill-development/SKILL.md:278-280`）。

### E. MCP 生命周期
插件启用时启动/连接：stdio 由 Claude Code 派生并管理子进程、经 stdin/stdout 通信；sse/http/ws 建立远程连接，OAuth 首次使用时浏览器授权（`mcp-integration/SKILL.md:224-254`）。工具名自动前缀 `mcp__plugin_<plugin>_<server>__<tool>`（`mcp-integration/SKILL.md:190-201`）。

### F. 配置/状态读写时序（settings pattern）
`.claude/<plugin-name>.local.md` = YAML frontmatter（结构配置）+ Markdown 正文（可回喂提示词）。钩子/命令先用 quick-exit 判存在与 `enabled`，再用 `sed/grep/awk` 解析（`plugin-settings/SKILL.md:60-95,175-198`）。改动需重启 Claude Code（`plugin-settings/SKILL.md:367-383`）。

---

## 扩展点

### 1. Commands（slash 命令）
- 文件：`commands/*.md`；子目录成为命名空间，`/help` 展示为 `(plugin:plugin-name:utils)`（`command-development/SKILL.md:574-598`、`command-development/references/plugin-features-reference.md:31-50`）。
- Frontmatter（全部可选，`frontmatter-reference.md:20`）：`description`、`allowed-tools`、`model`、`argument-hint`、`disable-model-invocation`。真实样例：

```yaml
# plugins/commit-commands/commands/commit.md
---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
description: Create a git commit
---
```
```yaml
# plugins/code-review/commands/code-review.md
---
allowed-tools: Bash(gh issue view:*), ..., mcp__github_inline_comment__create_inline_comment
description: Code review a pull request
---
```
- **文档外字段（真实存在）**：`plugins/ralph-wiggum/commands/ralph-loop.md` 用了 `hide-from-slash-command-tool: "true"`，而 `plugin-dev` 文档只记录 `disable-model-invocation`（`frontmatter-reference.md:270-323`）。这是仓库中未文档化的字段（见"存疑"）。
- `allowed-tools` 支持过滤器 `Bash(git:*)` 及 MCP 工具名（上一行 code-review 例）。

### 2. Agents（子代理）
- 文件：`agents/*.md`，正文即 system prompt（`agent-development/SKILL.md:162-196`）。
- Frontmatter：`name`（必填，3–50 字符，小写+连字符）、`description`（必填，须含 2–4 个 `<example>` 触发样例）、`model`（`inherit|sonnet|opus|haiku`）、`color`（`blue|cyan|green|yellow|magenta|red`）、`tools`（可选数组）（`agent-development/SKILL.md:60-160,349-357`）。
- 命名空间：`agent-name` 或 `plugin:subdir:agent-name`（`agent-development/SKILL.md:301-306`）。
- 真实样例（`plugins/plugin-dev/agents/plugin-validator.md`）：`name: plugin-validator`、长 `description` 带 3 个 `<example>`+`<commentary>`、`model: inherit`、`color: yellow`、`tools: ["Read","Grep","Glob","Bash"]`。另可见 `tools: Glob, Grep, LS, Read, ...` 的逗号串写法（`plugins/feature-dev/agents/code-explorer.md`）。

### 3. Skills（Agent Skills）
- 文件：`skills/<skill-name>/SKILL.md`（每个技能独立子目录）（`skill-development/SKILL.md:29-40`）。
- Frontmatter 必填 `name`、`description`；`description` 用第三人称 + 具体触发短语（`skill-development/SKILL.md:44,162-182`）。真实技能还出现 `version`（`plugins/frontend-design` 无 version 但有 `license`）——样例：

```yaml
# plugins/frontend-design/skills/frontend-design/SKILL.md
---
name: frontend-design
description: Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. ...
license: Complete terms in LICENSE.txt
---
```
```yaml
# plugins/plugin-dev/skills/hook-development/SKILL.md
---
name: Hook Development
description: This skill should be used when the user asks to "create a hook", "add a PreToolUse/PostToolUse/Stop hook", ...
version: 0.1.0
---
```
- 正文写作要求：祈使/不定式（imperative/infinitive），target 1500–2000 词，细节移入 `references/`（`skill-development/SKILL.md:160,190-210,362-413`）。
- 捆绑资源：`scripts/`（可执行、可不入上下文）、`references/`（按需入上下文）、`assets/`（用于产出而非入上下文）（`skill-development/SKILL.md:46-76`）。

### 4. Hooks（事件钩子）
- 文件：`hooks/hooks.json`（插件包装格式）或 `plugin.json` 内联（`hook-development/SKILL.md:62-100`；`plugin-structure/SKILL.md:200-231`）。
- 两种钩子：`prompt`（LLM 判定，推荐，支持 Stop/SubagentStop/UserPromptSubmit/PreToolUse）与 `command`（确定性脚本）（`hook-development/SKILL.md:22-58`）。
- 匹配器：精确、`A|B`、`*`、正则（如 `mcp__.*__delete.*`），大小写敏感（`hook-development/SKILL.md:385-425`）。
- 环境变量：`$CLAUDE_PROJECT_DIR`、`$CLAUDE_PLUGIN_ROOT`、`$CLAUDE_ENV_FILE`（仅 SessionStart 持久化）、`$CLAUDE_CODE_REMOTE`（`hook-development/SKILL.md:322-338`）。
- 默认超时：command 60s、prompt 30s（`hook-development/SKILL.md:483-491`）。

### 5. MCP servers
- 两种放置：独立 `.mcp.json`（推荐）或 `plugin.json` 内联 `mcpServers`（`mcp-integration/SKILL.md:19-63`）。
- 四种 server 类型：`stdio`（本地子进程）、`sse`（托管/OAuth）、`http`（REST/token）、`ws`（实时）（`mcp-integration/SKILL.md:65-165`）。
- 环境变量展开：`${CLAUDE_PLUGIN_ROOT}` 与用户环境变量均可（`mcp-integration/SKILL.md:167-188`）。
- 注意：**仓库内没有任何插件实际附带 `.mcp.json`**（`find plugins -name .mcp.json` 为空）；但 `code-review` 命令的 `allowed-tools` 引用了 MCP 工具 `mcp__github_inline_comment__create_inline_comment`，说明 MCP 可由外部来源提供（见"存疑"）。

### 6. 插件配置（settings pattern，非独立目录）
`.claude/<plugin-name>.local.md`，YAML frontmatter + Markdown 正文；须加入 `.gitignore`（`.claude/*.local.md`）；改动需重启；提供默认值、校验、防路径穿越（`plugin-settings/SKILL.md:20-40,313-423`）。真实使用者：`ralph-wiggum`（`.claude/ralph-loop.local.md`）、`multi-agent-swarm`（`plugin-settings/SKILL.md:424-471`）。

### 7. Mod（内核级扩展，与普通插件并列）
mod = 行为写在 hooks module 的插件（`mods/README.md:3-6`）。与普通插件的差异：

| 维度 | 普通插件 | mod |
|------|----------|-----|
| 行为载体 | 提示词/脚本/命令 | `register(on, options)` 的 TS hooks module（`mods/README.md:15-21`） |
| hooks.json | `{"hooks":{...}}` | `{"modules":["./register.ts"]}`（`mods/telemetry/hooks/hooks.json:1-5`） |
| 清单额外字段 | 无 | `userConfig`（`mods/agents-md/.claude-plugin/plugin.json:8-27`）、`types`（`mods/telemetry/.claude-plugin/plugin.json:7-8`） |
| 能力 | 命令/代理/技能/MCP | hook 引擎自身 `$` 命名空间事件（`$.fs`、`$.telemetry`、`$.ui`…）（`mods/diff/hooks/hooks.json`、`mods/README.md:84-112`） |
| 落座（tier） | 用户/项目插件 | 有 seating，如 `sec-default` 落最外层（`mods/README.md:8-13`） |
| 分发 | marketplace | 不列 marketplace，随二进制内置（`mods/README.md:114-117`） |

mod 的 hooks module 契约：`export const register: Register = (on, options) => {...}`，钩子函数形如 `($, e, next)`；类型从 `'claude-code'` 导入（`mods/types/claude-code.d.ts:35-75`）。约定 `userConfig` 提供选项 schema（`mods/agents-md/.claude-plugin/plugin.json:8-27`），`types` 指向该 mod 对 `$` 新增名词的类型契约（`mods/telemetry/types/index.d.ts:1-13`）。工具链：`claude plugin test <dir>`、`claude --plugin-dir <dir>`、`/plugin-types`、`claude plugin validate <dir>`（`mods/README.md:20,24-27`、`mods/types/claude-code.d.ts:9-10`）。mod 处于 early access，仅在启用 function hooks 的环境加载（`mods/README.md:114-117`）。

---

## 设计决策与权衡

1. **约定优于配置（convention over configuration）**
   默认靠目录自动发现，`plugin.json` 保持极简；自定义路径仅在必要时声明，且是"追加"不是"替换"（`plugin-structure/SKILL.md:365-368`、`manifest-reference.md:368-371`）。
   - 权衡：上手成本极低；代价是灵活性/显式性弱，重名冲突只能靠命名空间缓解。

2. **清单位置强约束 `.claude-plugin/plugin.json`，组件目录必须在插件根**
   组件不得嵌套进 `.claude-plugin/`（`plugin-structure/SKILL.md:39-44`）。
   - 权衡：发现逻辑简单、可预测；代价是布局不自由，且清单缺失（如 `plugin-dev`）会被误当普通目录而非报错。

3. **`${CLAUDE_PLUGIN_ROOT}` 便携路径**
   禁止硬编码绝对路径、禁止相对工作目录、禁止 `~`；清单内路径必须 `./` 开头（`plugin-structure/SKILL.md:256-301`、`manifest-reference.md:332-350`）。
   - 权衡：跨 OS/跨安装方式可移植；代价是文档中反复强调、易被违反。

4. **命令/技能用 Markdown + frontmatter，而非代码**
   命令正文是"给模型的指令"（`command-development/SKILL.md:30-52`），技能是渐进披露的知识包（`skill-development/SKILL.md:13-16,77-85`）。
   - 权衡：人类可读、可版本化、可用自然语言写复杂逻辑；代价是确定性弱、可靠性依赖模型，真正的强制约束要下沉到 hooks。

5. **hooks 双格式（插件包装 vs 设置直连）**
   插件用 `{"description","hooks":{...}}`，用户设置用无包装（`hook-development/SKILL.md:62-119`）。
   - 权衡：插件需要 `description` 元数据与命名空间包装；代价是两套形状易混淆（文档专门用"Important"提示）。

6. **prompt-based hooks 优先**
   推荐对复杂逻辑用 LLM 判定，command hooks 用于确定性/性能敏感场景（`hook-development/SKILL.md:22-58,712`）。
   - 权衡：上下文感知、免脚本；代价是引入延迟与不确定性、每事件多钩子并行且互不可见（`hook-development/SKILL.md:495-518`）。

7. **配置外置为 `.local.md` 且不入 git**
   per-project 状态用 `.claude/<plugin>.local.md`，`.gitignore` 掉 `.claude/*.local.md`（`plugin-settings/SKILL.md:20-40,327-334`）。
   - 权衡：复用 frontmatter 解析、正文可回喂模型；代价是需重启、解析靠脆弱的 sed/grep、有注入/路径穿越风险（文档给防护示例，`plugin-settings/SKILL.md:385-415`）。

8. **mod 与插件分层**
   普通插件受限于命令/代理/技能/MCP；要动引擎自身行为则必须写 mod，走类型契约 + tier 落座（`mods/README.md:1-6,84-112`）。
   - 权衡：安全边界清晰（用户插件无法越权改内核策略，`sec-default` 负责外圈防护）；代价是 mod 生态封闭、API 不稳定（early access）、需理解 `$` 名词契约。

---

## 对复刻产品的启示

1. **清单最小化 + 约定目录**：只需 `name` 必填即可工作；把复杂度藏进"扫描约定目录"的发现器。复刻时应先把 `commands/agents/skills/hooks/.mcp.json` 五个标准位置做扎实。
2. **便携路径变量是刚需**：`${CLAUDE_PLUGIN_ROOT}`（及 `$CLAUDE_PROJECT_DIR`、`$CLAUDE_ENV_FILE`）要在清单解析、脚本执行、MCP 参数三处一致展开（`hook-development/SKILL.md:322-338`）。
3. **两套 hooks 形状 + 明确文档**：插件包装 vs 设置直连，且要支持 `command`/`prompt` 两类、matcher 语法、`permissionDecision` 与 `decision` 两种输出契约（`hook-development/SKILL.md:144-209`）。
4. **namespace 自动加前缀**（`plugin:<name>:<ns>`），把冲突治理内置到发现器（`command-development/SKILL.md:574-598`）。
5. **manifest 之外要有 validator**：`plugin-dev` 提供了可复刻的校验清单与工具（`plugin-validator.md:39-181`、`plugin-structure/SKILL.md:448-472`）。复刻产品应内置 `validate` 子命令（对照 `claude plugin validate`，`mods/types/claude-code.d.ts:9-10`）。
6. **配置外置、可重启生效、可校验、防穿越**：直接照搬 `.local.md` 模式与 quick-exit/默认值/路径校验范式（`plugin-settings/SKILL.md:313-423`）。
7. **渐进式披露**：技能的三级加载（元数据→正文→资源）是控制上下文成本的核心模式，值得作为一等抽象（`skill-development/SKILL.md:77-85`）。
8. **分层扩展**：普通插件与"内核级 mod"分家；用 tier/落座与 types 契约隔离权限与类型，避免用户扩展越权（`mods/README.md:8-13,84-112`）。
9. **marketplace 索引格式要简单**：`name/description/source/category(+version,author)` 足够（`.claude-plugin/marketplace.json:10-27`）。
10. **仓库内已验证的打包范式可直接参考**：只放命令的插件（`commit-commands`）、只放技能的插件（`frontend-design`、`claude-opus-4-5-migration`）、只放钩子的插件（`explanatory-output-style`、`learning-output-style`、`security-guidance`）、混合插件（`plugin-dev`、`hookify`、`pr-review-toolkit`、`feature-dev`、`agent-sdk-dev`、`code-review`、`ralph-wiggum`）。

---

## 关键文件索引

清单与索引
- `plugins/README.md` — 插件总览、结构约定、安装说明（`:1-78`）
- `.claude-plugin/marketplace.json` — marketplace/索引 schema 与 13 条插件条目
- `plugins/<name>/.claude-plugin/plugin.json` — 13 份清单（真实路径含 `.claude-plugin/` 一级）
- `plugins/security-guidance/.claude-plugin/plugin.json` — 字段最全的真实清单（含 `homepage`）

plugin-dev 工具包（插件契约最丰富的描述）
- `plugins/plugin-dev/README.md` — 7 个技能、8 阶段工作流、3 个代理概览
- `plugins/plugin-dev/commands/create-plugin.md` — 8 阶段 create-plugin 工作流（含命令 frontmatter `:1-5`）
- `plugins/plugin-dev/skills/plugin-structure/SKILL.md` — 目录结构、清单、自动发现
- `plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md` — `plugin.json` 全字段参考
- `plugins/plugin-dev/skills/plugin-structure/references/component-patterns.md`、`examples/{minimal,standard,advanced}-plugin.md` — 布局范式
- `plugins/plugin-dev/skills/command-development/SKILL.md` + `references/frontmatter-reference.md` + `references/marketplace-considerations.md` — 命令契约与分发
- `plugins/plugin-dev/skills/agent-development/SKILL.md` — 代理 frontmatter 与 system prompt 设计
- `plugins/plugin-dev/skills/skill-development/SKILL.md` — 技能结构与渐进披露
- `plugins/plugin-dev/skills/hook-development/SKILL.md` + `references/{patterns,advanced,migration}.md` — 钩子事件与 API
- `plugins/plugin-dev/skills/mcp-integration/SKILL.md` + `examples/{stdio,sse,http}-server.json` — MCP 集成
- `plugins/plugin-dev/skills/plugin-settings/SKILL.md` — `.local.md` 配置模式
- `plugins/plugin-dev/agents/{plugin-validator,agent-creator,skill-reviewer}.md` — 校验/生成/评审代理

扩展点真实样例
- Commands: `plugins/commit-commands/commands/commit.md`、`plugins/code-review/commands/code-review.md`、`plugins/feature-dev/commands/feature-dev.md`、`plugins/ralph-wiggum/commands/ralph-loop.md`（`hide-from-slash-command-tool`）
- Agents: `plugins/plugin-dev/agents/plugin-validator.md`、`plugins/feature-dev/agents/code-explorer.md`、`plugins/hookify/agents/conversation-analyzer.md`
- Skills: `plugins/frontend-design/skills/frontend-design/SKILL.md`、`plugins/claude-opus-4-5-migration/skills/claude-opus-4-5-migration/SKILL.md`、`plugins/hookify/skills/writing-rules/SKILL.md`
- Hooks: `plugins/explanatory-output-style/hooks/hooks.json`、`plugins/hookify/hooks/hooks.json`、`plugins/ralph-wiggum/hooks/hooks.json`、`plugins/security-guidance/hooks/hooks.json`

mod（内核级扩展）
- `mods/README.md` — mod 定义、测试、名词契约
- `mods/{agents-md,diff,sec-default,telemetry}/.claude-plugin/plugin.json` — 含 `userConfig`/`types`
- `mods/{agents-md,diff,sec-default,telemetry}/hooks/hooks.json` — `modules` 字段
- `mods/types/claude-code.d.ts` — hooks module 的 TS 契约（`Register`/`On`/`EngineInterface`）
- `mods/telemetry/types/index.d.ts` — 名词类型契约范例
- `mods/diff/hooks/register.ts` — 真实 `register(on)` 实现

---

## 存疑与待确认

1. **插件数量**：任务称"15 个官方插件"，仓库实测为 **13 个**目录、marketplace **13 条**（`plugins/`、`.claude-plugin/marketplace.json:10-149`）。差额原因不明，可能把 `mods/` 的 4 个或已下架的插件计入。
2. **`plugin-dev` 缺清单**：`plugins/plugin-dev/` 无 `.claude-plugin/plugin.json`，却列在 marketplace（`.claude-plugin/marketplace.json:105-115`）。无法从仓库判断引擎是否容错、或以何种默认 `name` 注册它。
3. **未文档化字段**：`hide-from-slash-command-tool: "true"`（`plugins/ralph-wiggum/commands/ralph-loop.md`）在 `plugin-dev` 命令文档中无记载（只有 `disable-model-invocation`）。其语义（与 `disable-model-invocation` 是否同义/别名）需引擎确认。
4. **MCP 工具来源**：`plugins/code-review/commands/code-review.md` 引用 `mcp__github_inline_comment__create_inline_comment`，但仓库无对应 `.mcp.json`；该 MCP server 由何处提供（内置？marketplace 另一插件？）未在仓库中说明。
5. **`mcpServers`/`hooks` 内联写法的实际验证**：文档提供内联样例，但仓库内**所有**插件都用独立 `hooks/hooks.json`，无一使用清单内联 `hooks`/`mcpServers`/自定义 `commands`/`agents` 路径字段；这些字段的运行时行为只能据文档（`manifest-reference.md:209-331`）推断。
6. **运行时细节不可得**：发现/加载/权限裁决/tier 落座/`plugin.json` 校验失败时的行为，本仓库无引擎源码；结论来自 `plugin-dev` 文档与 `mods/*` 描述，属"记录方视角"，可能与真实引擎有出入。
7. **marketplace `source` 的其他形态**：本仓库 `source` 全为相对路径字符串；`plugin-dev/README.md` 提到 `@claude-code-marketplace`、`security-guidance/README.md` 提到 `@claude-plugins-official` 等 marketplace 名，暗示 `source` 还可能支持 git/对象形态，但本仓库未给出 schema。
8. **`author` 的字符串/数组形态**：文档称 `author` 支持字符串简写（`manifest-reference.md:102-107`），但仓库内 13 份清单全部为对象形态，未实测字符串形态。
9. **技能 frontmatter 的 `license` 字段**：仅 `frontend-design` 与 skill-creator 原文出现（`plugins/frontend-design/skills/frontend-design/SKILL.md:4`），`plugin-dev` 技能文档未把 `license` 列入标准字段，其是否为引擎识别字段存疑。
