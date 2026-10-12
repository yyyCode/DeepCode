# 06 安全与权限：`sec-default`、设置/权限模型、沙箱与托管部署

> 范围：本仓库（`anthropics/claude-code` 公开仓库）中可读到的安全面：内置 mod `sec-default`、`settings`/`permissions` 模型、沙箱、以及托管（企业/MDM）部署。仓库不含引擎（engine）源码；`mods/` 与 `types/` 中的声明（`.d.ts`）是引擎行为的**契约（contract）**，本文以契约 + 示例 + mod 源码为依据。凡属推断或仓库中查无实据的，一律记入文末「存疑与待确认」。

---

## 定位

`sec-default` 是 Claude Code **内置的四个 mod 之一**，也是其中唯一的「安全默认」。另一个关键事实：它**不制定任何策略**，只维护组织既有控制面（classic hooks、prompt 内容、managed settings、工具策略、deny 规则）不被「个人安装的插件」触及。

`mods/README.md:10` 对它的定位：

```
| [`sec-default`](sec-default) | Keeps an organization's classic hooks, prompt content, managed settings, tool policy and deny rules out of reach of the plugins a person installs; adds no policy of its own. | Outermost, on a machine with managed settings or for a Team or Enterprise organization, unless managed `prependPlugins` says otherwise |
```

它保护的对象分为四组（`mods/sec-default/README.md:6-10`）：

1. 组织的 **classic hooks**（即 settings 里的 `hooks`，传统 shell/command hook）；
2. **prompt 内容**（managed `CLAUDE.md`、rules、policy skills、system prompt 的 section 列表、attribution 文本）；
3. **managed settings**（`$.settings.read` 所读的一切）；
4. **工具策略与 deny 规则**（MCP allowlist、工具的登记/列举、`tool.check` 的 deny 规则）。

它同时属于本轮文档集要讲的**权限系统**：设置的分层（precedence）、permission mode、工具 allow/ask/deny 规则、沙箱、托管部署——`sec-default` 是这些机制在「插件链」上的**守护者（gatekeeper）**。

它在本仓库里的可达文件：`mods/sec-default/hooks/register.ts`（模块入口）、`hooks/policy/`（读 managed settings 做判定）、`hooks/held-verdict/`（deny 规则持有逻辑）、`hooks/past-users/`（主体溯源）、`hooks/plugin.register` 拒绝逻辑等；它自己的「名词契约」体现在 `.claude-plugin/plugin.json` 与 `hooks/hooks.json`（注意：本 mod **没有** `types/index.d.ts`，因为它不新增 `$` 名词）。

---

## 职责与边界

### 它做什么

`register.ts` 的头部注释把它的行为压缩为「三个动作，别无其他」（`mods/sec-default/hooks/register.ts:10-19`）：

```
 * Three moves: continue past the user tier (`next.to(e, "append")`), refuse
 * a user-tier caller or module by name, or pass. Provenance is the event's
 * pinned `provider` or `tier`; policy is `$.settings.read`; fail closed.
```

- **越过 user tier 继续**（`next.to(e, "append")`）：让「组织侧」的 hook/主体从 `append` 层往里跑，**跳过个人插件所在的 `user` 层**。
- **按名拒绝** user tier 的调用者或模块（`{ deny }` / `{ refuse }`）。
- **放行**（`next(e)`）——一切不触及受保护面的东西原样通过。

### 它的边界（明确不做的）

- **不新增策略**：`mods/sec-default/README.md:10-11`「adds no policy of its own. Everything else passes through untouched.」。它不会替组织决定「哪些 Bash 命令该 deny」——那是 managed settings 里 `permissions` 的事。
- **不改写任何输入输出**：它的三个动作里没有「改写」。所有「改写」类事件它要么整条链放过（`next(e)`），要么跳过 user 层（`next.to`）。
- **不负责权限模式本身**：`PermissionMode` 的语义、`auto` 分类器、对话框、headless host 都在引擎侧（见 `types/claude-code.d.ts:6074-6076`）；`sec-default` 只在 `tool.check` 事件上「持有 deny 规则」，不改模式。
- **不负责沙箱**：沙箱是引擎在执行 Bash 时的隔离层（见下文「沙箱模型」），`sec-default` 不碰它。
- **未就位即失效**：`mods/sec-default/README.md:180-186` 明确——它只是「一个普通插件文件夹」，其唯一重要的动作 `next.to` 在非 managed tier 中会被引擎拒绝；用 `--plugin-dir` 加载它只会得到一个「只能 pass」的插件。也就是说，**它的权力来自「被 CLI 安置在 `prepend` 层」这一事实**，而非来自它自己的代码。

### 分层的边界（tier 模型）

链共 **5 层**，由外到内（`types/claude-code.d.ts:9739-9743`）：

```
const TIERS: readonly ["prepend", "user", "append", "builtin", "core"];
```

- 顺序即权限：**越靠外权限越大**（`types/claude-code.d.ts:9740`「earlier is outer is more authority」）。
- `prepend` / `append`：管理员列出的 **managed 插件**。
- `user`：**个人安装的一切**（市场安装、`--plugin-dir`、个人 mods 文件夹）。
- `builtin`：随二进制打包的内置插件。
- `core`：引擎最内层。

`next.to(e, tier)` 能指向的 `TargetTier` 被收窄为 `Exclude<Tier, 'prepend' | 'user'>`（`types/claude-code.d.ts:9642`），即只能 `append` / `builtin` / `core`。注释（`types/claude-code.d.ts:5238-5242`）说明了原因：

```
 * A managed hook's: prepend may name append, builtin or core, append core;
 * it never skips a tier with more authority, so no user hook skips the org's.
```

**这是安全设计的根**：只有 managed hook 能「跳过某一层」，而 `next.to` **永远不可能跳过权限更高的层**。因此一个 `user` 层插件无法绕过 `prepend` 层的组织插件；反过来，`prepend` 层的 `sec-default` 可以跳过 `user` 层。

### 溯源（provenance）的边界

`sec-default` 判定「是不是个人的东西」时，读的是引擎**钉死（pinned）**的字段，而非主体/模块自述：

- 事件主体：`e.provider`，类型 `Origin`（`types/claude-code.d.ts:5909-5928`）。注释（`types/claude-code.d.ts:5907-5910`）：「Set by the host from where the call came from and where that plugin was seated; nothing a plugin writes.」
- 调用者：`next.origin`（`types/claude-code.d.ts:5281`）。
- 模块：`plugin.register` 的 `e.tier` / `e.provenance`（`types/claude-code.d.ts:6203-6230`）。

`mods/sec-default/README.md:36` 对 `plugin.register` 的边界说得很直白：「The decision reads the tier the CLI pins on the module and nothing the module says of itself」——一个自称是组织插件的个人插件，仍处于 `user` 层，仍会被拒。

---

## 关键抽象与接口

### 契约面（引擎提供的抽象）

| 抽象 | 位置 | 要点 |
| --- | --- | --- |
| `Tier` / `TIERS` | `types/claude-code.d.ts:9733,9743` | 五层，外→内 `prepend,user,append,builtin,core` |
| `TargetTier` | `types/claude-code.d.ts:9642` | `next.to` 可达层：`append|builtin|core` |
| `Origin` | `types/claude-code.d.ts:5912` | `{ readonly plugin; readonly tier }`，宿主钉死 |
| `Next`（含 `to`/`origin`/`trace`/`budget`/`signal`/`is`） | `types/claude-code.d.ts:5230-5311` | hooks 的续延对象 |
| `TraceEntry` | `types/claude-code.d.ts:10220` | 链路每个 link 的 `plugin`/`tier`/`returned`/`outcome` 等，引擎钉 `tier` |
| `Settings` | `types/claude-code.d.ts:9289` | `Readonly<Record<string, unknown>>`，按 settings.json 的键 |
| `SettingsReadArgs` | `types/claude-code.d.ts:9294` | `{ source?: SettingsSource }`，读单一来源或合并 |
| `SettingsSource` | `types/claude-code.d.ts:9311` | `'user'|'project'|'local'|'flag'|'policy'`，**低优先级在前** |
| `PermissionMode` | `types/claude-code.d.ts:6076` | `default|acceptEdits|bypassPermissions|plan|dontAsk|auto` |
| `PermissionBehavior` | `types/claude-code.d.ts:6062` | `'allow'|'deny'|'ask'` |
| `ToolCheckDecision` | `types/claude-code.d.ts:9915` | `'allow'|'ask'|'deny'` |
| `ToolCheckResult` | `types/claude-code.d.ts:9952` | `{ decision; reason?; rule? }`，`rule` 是「写出原文的 settings 规则」 |
| `ToolInfo` | `types/claude-code.d.ts:10081` | 含 `provider: Origin`，声明工具归属 |
| `PluginRegisterInput`/`Result` | `types/claude-code.d.ts:6203,6236` | `tier`/`provenance`/`uses`；返回 `{ allow:true }` 或 `{ refuse }` |
| `ValueOrDeny<T>` | `types/claude-code.d.ts:11298` | `{ value } | { deny }`，`$.tool.list` 等 op 的返回 |

`Settings` 只是 `Readonly<Record<string, unknown>>`：引擎**不把 settings 键硬编码进类型**，键集合由文档/json-schema 定义（`types/claude-code.d.ts:9282-9288` 指向 `https://code.claude.com/docs/en/settings` 与 `json.schemastore.org/claude-code-settings.json`）。这意味着**「settings 键」本身是产品契约中可扩展、可演进的面**。

`settings.read` 既是 **op**（`$.settings.read(args?)`，`types/claude-code.d.ts:2999-3002`），也是**事件**（`'settings.read'`，Args=`SettingsReadArgs` @ `5786`，Result=`Settings` @ `5891`）——hook 可以在链上改写「别人读到的 settings」。`sec-default` 因此专门钩住它并 `next.to(e,'append')`。

### `sec-default` 自己的接口

- **选项路径**：`OWN_OPTIONS_PATH = ['pluginConfigs', 'cc-plugin-sec-default@builtin', 'options']`（`mods/sec-default/hooks/policy/own-option/own-options-path/own-options-path.ts:5-9`）。注意 key 是 **`cc-plugin-sec-default@builtin`**，README 强调「only this spelling of the id is read」（`mods/sec-default/README.md:40-41`）。
- **两个选项**（均只在 **managed** 源生效）：
  - `allowManagedModsOnly`（`is-managed-mods-only.ts:15-19`）：**缺省或非 `false` 即锁定**（`value !== undefined && value !== false`）。`"true"`/`1` 这类误写仍锁。若该值被 schema 拒绝（`null`、对象），CLI 会忽略整个 `pluginConfigs` 键（`README.md:71-76`）。
  - `allowModsToOverrideDenyRules`（`deny-rules-hold.ts:15-16`）：**只有字面量 `true`** 才放开（`!== true` 即持有 deny 规则）。
- **溯源常量**：
  - `USER_REACHABLE_TIERS = ['user','builtin','core']`（`hooks/past-users/user-reachable-tiers/user-reachable-tiers.ts:7-11`）。
  - `TIERS_HOLDING_USERS = ['user','prepend']`（`hooks/held-verdict/verdicts/ranking/tiers-holding-users/tiers-holding-users.ts:9-13`）。
  - `LENIENCY = { deny:0, ask:1, allow:2 }`（`hooks/held-verdict/verdicts/ranking/leniency/leniency.ts`）。
- **拒绝文案**：`TOOL_REGISTER_REFUSAL = 'allowedMcpServers (managed): plugins outside policy may not add tools'`（`hooks/tool-register-refusal/tool-register-refusal.ts:5-6`）；`managedModsOnlyRefusal(name)`（`hooks/managed-mods-only-refusal/managed-mods-only-refusal.ts:8-10`）；`UNCHECKED_DENY`（`hooks/held-verdict/verdicts/unchecked-deny.ts:7-12`）。
- **策略读取**：`SOURCE = { source: 'policy' }`（`hooks/policy/source.ts:4`），并以 `createPolicyMemo(500)` 记忆化（`hooks/policy/policy-memo-ms.ts:7`），一次读服务 500ms 内的一串调用。
- **`hooks/hooks.json`**：`{ "modules": ["./register.ts"] }`（`mods/sec-default/hooks/hooks.json`）。

### 它监听的事件（共 15 个）

`README.md` 的「The rows」表（`mods/sec-default/README.md:23-37`）+ `register.ts` 逐一列出：

```
classic.* · prompt.section · prompt.context · prompt.compose · skill.prompt
attribution.text · settings.read · tool.describe · command.describe
agent.offer · agent.spawn · tool.register · tool.list · tool.check · plugin.register
```

### 沙箱模型的契约（settings 面）

沙箱不在 `sec-default` 里，而在 **managed settings 的 `sandbox` 块**，作用于 **Bash 工具**（`examples/settings/README.md:27`：「The `sandbox` property only applies to the `Bash` tool」）。已证实的键（取自 `examples/settings/settings-hipaa.json:65-128` 与 `settings-bash-sandbox.json`）：

- `sandbox.enabled`
- `sandbox.failIfUnavailable`（可用性失败时启动即退出）
- `sandbox.autoAllowBashIfSandboxed`（默认 `true`，见 `README-hipaa.md:113`）
- `sandbox.allowUnsandboxedCommands`
- `sandbox.excludedCommands`
- `sandbox.enableWeakerNestedSandbox`
- `sandbox.enableWeakerNetworkIsolation`
- `sandbox.filesystem.allowManagedReadPathsOnly`
- `sandbox.filesystem.denyWrite`
- `sandbox.filesystem.allowWrite`（在 `README-hipaa.md:138` 提到会跨作用域合并）
- `sandbox.network.allowManagedDomainsOnly`
- `sandbox.network.allowedDomains`
- `sandbox.network.allowUnixSockets` / `allowAllUnixSockets` / `allowLocalBinding`
- `sandbox.network.httpProxyPort` / `socksProxyPort`
- `sandbox.credentials.files[]`（`{ path, mode }`）与 `sandbox.credentials.envVars[]`（`{ name, mode }`）

Bash/PowerShell 工具输入含 `dangerouslyDisableSandbox` 逃生阀（`types/claude-code.d.ts:12409-12410,12476-12477,12715-12716`）。

---

## 数据流 / 时序

### 链路顺序（一次 dispatch 的物理顺序）

一次事件 dispatch 从外往里穿过五层：`prepend` → `user` → `append` → `builtin` → `core`（`types/claude-code.d.ts:9743`）。`sec-default` 被安置在 `prepend` 的**最外位**。

`mods/README.md:10` 与 `mods/sec-default/README.md:178-186`（「Where it is seated」）给出安置规则：

> The CLI seats it first in the prepend tier wherever hooks modules load on a machine with managed settings or for a Team or Enterprise organization, unless managed settings define `prependPlugins`…

关键推论：**只要机器有 managed settings，或属于 Team/Enterprise 组织**，它就在最外层；否则不加载，规则不生效（fail-open，因为没有它）。若 managed settings 定义了 `prependPlugins`，则该列表**就是整个 `prepend` 层**，组织必须显式在其中列出 `sec-default@builtin`，否则它不生效（`README.md:182-186`）。

### 各事件的判定数据流

**（1）纯「越层」类** —— 无判定，直接跳过 `user` 层到 `append`：

```ts
on('classic.*', ($, e, next) => next.to(e, 'append'))

on('prompt.section', ($, e, next) => next.to(e, 'append'))
on('prompt.context', ($, e, next) => next.to(e, 'append'))
on('prompt.compose', ($, e, next) => next.to(e, 'append'))
on('skill.prompt', ($, e, next) => next.to(e, 'append'))
on('attribution.text', ($, e, next) => next.to(e, 'append'))

on('settings.read', ($, e, next) => next.to(e, 'append'))
```

（`mods/sec-default/hooks/register.ts:24-32`）

含义：组织的 settings hooks 先于一切模块运行、其答案即为最终答案（`types/claude-code.d.ts:947-949`：「The chain is [managed settings hooks, ...hooks modules, the other settings hooks as core]」）；managed `CLAUDE.md`/rules/skill prompt/attribution 原样抵达模型；个人插件不得改写任何人读到的 settings 快照。

**（2）主体溯源类**（`tool.describe` / `command.describe` / `agent.offer` / `agent.spawn`）：

```ts
export function pastUsers<E extends Provided.Provided, R>(e, next) {
  const isUsers = USER_REACHABLE_TIERS.includes(e.provider?.tier)
  return isUsers ? next(e) : next.to(e, 'append')
}
```

（`hooks/past-users/past-users.ts:16-23`）

- 主体 provider 属 `user`/`builtin`/`core` → 全链放行（个人可改自己的、内置的、引擎的东西）。
- 否则（`prepend`/`append` 的组织主体，或 `provider` 缺失）→ 跳过 `user` 层（**fail closed**：缺证据视为组织所有）。
- 契约依据：`tool.describe` 的 `ToolDescribeInput.provider`（`types/claude-code.d.ts:10008`），`agent.offer` 的 `provider`（`:203`），且「A configured MCP server's tool is `mcp:<server>`, in `prepend` when the policy settings source configures the server, else `user`」（`:10006-10007`）。

**（3）`tool.register`（MCP allowlist 门）**：

```ts
on('tool.register', async ($, e, next) => {
  const isOrgs = next.origin.tier === 'prepend' || next.origin.tier === 'append'
  if (isOrgs) return next.to(e, 'append')
  const isRefused =
    next.origin.tier === 'user' &&
    (await Policy.decidedByPolicy(readPolicy(() => $.settings.read(Policy.SOURCE)), Policy.hasMcpAllowlist))
  return isRefused ? { deny: TOOL_REGISTER_REFUSAL } : next(e)
})
```

（`register.ts:39-55`）

`hasMcpAllowlist` = `Array.isArray(policy.allowedMcpServers)`（`has-mcp-allowlist.ts:10-11`）——**只要是数组就成立，空数组也算**（`README.md:29`「set at all, empty included」）。即：组织一旦设定 `allowedMcpServers`，`user` 层插件就不能添加工具；`builtin`/`core` 不受限。

**（4）`tool.list`（组织工具还原为组织的列举）**：

```ts
on('tool.list', async ($, e, next) =>
  Policy.managedToolsRestored(
    await readPolicy(() => $.settings.read(Policy.SOURCE)).catch(() => undefined),
    await next.to(e, 'append'),   // real
    await next(e),                // seen
  ),
)
```

（`register.ts:57-65`）

`managedToolsRestored`（`policy/managed-tools-restored/managed-tools-restored.ts:17-33`）：组织 MCP server 的工具按 `append` 起跑的 `real` 列举；其余工具按全链的 `seen` 列举。**fail closed**：`policy === undefined`（读失败）或任一列举 `{ deny }`，则整体采用 `real`（组织的列举原样）。`isOrgTool` 用 `mcp__<server>__` 前缀匹配，server 名来自 `allowedMcpServers`（带 `serverName` 的条目）∪ `managedMcpServers` 的键（`policy/managed-tools-restored/is-org-tool/...`）。

**（5）`tool.check`（deny 规则持有）** —— 全 mod 最复杂的一段（`register.ts:67-104`）：

```ts
on('tool.check', async ($, e, next) => {
  const answer = await next(e)
  const mods = HeldVerdict.loosenedByUsers(next.trace)
  const shouldRecheck =
    answer.decision !== 'deny' &&
    mods.length > 0 &&
    (await Policy.decidedByPolicy(readPolicy(() => $.settings.read(Policy.SOURCE)), Policy.denyRulesHold))
  if (!shouldRecheck) return answer
  const held = await next.to(e, 'append')
  if (!HeldVerdict.isRuleDeny(held)) return answer
  for (const mod of mods.filter(name => !told.has(name))) {
    told.add(mod)
    $.ui.log(HeldVerdict.heldNotice(mod, e.tool, held.rule))
  }
  return held
})
```

时序：

1. 先原样跑一遍链（`next(e)`）。
2. 若答案是 deny，或没有任何「可能持有个人插件」的 link 把交给它的判定**放宽**了（`loosenedByUsers` 为空），直接返回——个人没放宽任何东西，只监听不改变东西的插件不会引发第二次运行。
3. 否则（有放宽且策略要求 deny 规则持有）**再跑一遍但跳过 user 层**（`next.to(e,'append')`）。这一遍不经过个人插件，所以规则的判定与 `rule` 名不可能被改写/抹除。
4. 若第二遍得到一个 **命名了规则的 deny**（`isRuleDeny`：`decision==='deny' && rule!==undefined`，`held-verdict/verdicts/is-rule-deny.ts:15-18`），则用它替换第一遍答案，并对每个放宽者回报一次 `heldNotice`。
5. 若第二遍不是 rule-deny，则第一遍答案有效（例如 `ask` 被个人插件改成 `allow`、背后无 deny 规则——「that is what such a plugin is for」，`README.md:143`）。

放宽的判定（`loosenedByUsers`，`held-verdict/verdicts/loosened-by-users.ts:16-24`）：过滤 `next.trace` 中 `tier ∈ TIERS_HOLDING_USERS`（`user`，以及 `sec-default` 之下的 `prepend`——因引擎把共享 worker 的相邻插件作为一批、按首成员 tier 记名）且 `isLooser(link.returned, handedTo(trace, at))` 的 link。`isLooser`（`.../ranking/is-looser.ts:15-20`）用 `LENIENCY` 比较：比自己收到的更宽松则算放宽；**从不调用 `next` 的 link 以「对 deny 而言」度量**（即视为放宽到 limit）。

`.catch` 失败处理（`register.ts:95-104`）：

```ts
}).catch(async ($, e, next) => {
  const last = await next(e).catch(() => undefined)
  const shouldVouch = await Policy.decidedByPolicy(
    readPolicy(() => $.settings.read(Policy.SOURCE)),
    Policy.denyRulesHold,
  )
  return shouldVouch ? HeldVerdict.caughtAnswer(last, next.trace) : last
})
```

`caughtAnswer`（`held-verdict/caught-answer.ts:16-25`）：若 `last` 是 deny，或无人放宽（`loosenedByUsers(trace).length===0`），则 `last` 有效；否则返回 `UNCHECKED_DENY`（deny 并说明「规则未能被检查，所以拒绝」）。**fail closed**。

**（6）`plugin.register`（mods 白名单门）**：

```ts
on('plugin.register', { tier: 'user' }, async ($, e, next) =>
  Policy.isManagedModsOnly(await $.settings.read(Policy.SOURCE))
    ? { refuse: managedModsOnlyRefusal(e.name) }
    : next(e),
).catch(($, e, next) => {
  $.ui.log(admissionFailure(e.name, next.error), { to: 'debug' })
  return next.called ? next(e) : { refuse: managedModsOnlyRefusal(e.name) }
})
```

（`register.ts:106-114`）

要点：
- 用 `{ tier: 'user' }` 匹配器：**只有 user 层模块会被问到**；`prepend`/`append`/`builtin` 一律不问（`README.md:36`）。
- 判定用 `isManagedModsOnly`：managed settings 里 `allowManagedModsOnly` **存在且非 `false`** 即拒。注意它直接 `await $.settings.read(Policy.SOURCE)`，**未经 memo，也未经 `decidedByPolicy` 包裹**，因此读失败会走 `.catch`。
- `.catch`：记录 debug 日志；若 hook 从未成功调用 `next`（`next.called` 为假）则拒绝——**fail closed**。
- 被拒含义：模块的 hook/tool/command 一律不加入；但它的顶层代码在封闭求值环境里已跑过一次（`README.md:63-66`）。

### 设置优先级（precedence）

`SettingsSource` 注释（`types/claude-code.d.ts:9302-9311`）给出**由低到高**的顺序：

```
user  < project < local < flag < policy
```

即：

| 来源 | 文件/位置 | 优先级 |
| --- | --- | --- |
| `user` | `~/.claude/settings.json` | 最低 |
| `project` | `.claude/settings.json` | ↑ |
| `local` | `.claude/settings.local.json` | ↑ |
| `flag` | `--settings` 与 SDK inline settings | ↑ |
| `policy` | **managed settings，所有 managed 层合并** | **最高** |

（`types/claude-code.d.ts:9294-9311`）`sec-default` 的所有判定都只读 `source: 'policy'`（`SOURCE`），所以个人/项目/local/flag 里的同名键**永远不参与**它的安全判定（`README.md:69-71`「Only managed settings are read」）。

`examples/mdm/README.md:24` 从部署角度确认：「Settings deployed this way sit at the top of the precedence order and cannot be overridden by users」。

### 工具调用时序（权限决策的挂点）

`tool.check` 的契约（`types/claude-code.d.ts:3249-3264`）给出模型一次工具调用的决策序列：

```
Fires when the engine decides whether a tool call may run, after the
`tool.call` and PreToolUse hooks and before the mode settles an ask.
`next(e)` resolves to the engine's verdict (rules, mode, the tool's own
check, PreToolUse's decision); return any `{ decision }`.
```

即：`tool.call`（可改写） → `classic.PreToolUse` → `tool.check`（规则 + mode + 工具自检 + PreToolUse 判定） → 若为 `ask` 则由 mode 决定者裁决（对话框 / auto 分类器 / headless host，`ToolCheckDecision` 注释 @ `9910-9913`）。`tool.check` 的输入 `{ tool, input, tool_use_id? }` 是**钉死的身份**，hook 只决定「这次调用」，不能改调用（改写属 `tool.call`，`types/claude-code.d.ts:9918-9932`）——`sec-default` 的 deny 持有因此建立在「同一问、同一答」之上。

---

## 扩展点

### 1. `sec-default` 的两个 managed 选项（`pluginConfigs`）

```json
{
  "pluginConfigs": {
    "cc-plugin-sec-default@builtin": {
      "options": { "allowManagedModsOnly": true }
    }
  }
}
```

（`README.md:44-50`）与

```json
{
  "pluginConfigs": {
    "cc-plugin-sec-default@builtin": {
      "options": { "allowModsToOverrideDenyRules": true }
    }
  }
}
```

（`README.md:164-171`）

这是管理员对「安全默认」本身的两个开关，且**只认 managed 源**、只认字面量语义（见前）。这是产品设计中「安全默认可被组织收放」的机制。

### 2. `prependPlugins`（安置点 / 座位扩展）

undefined 时 CLI 自动把 `sec-default` 置于 `prepend` 首位；定义后由组织自己在列表中安排位置，例如：

```json
"prependPlugins": ["acme-guard@acme-tools", "sec-default@builtin"]
```

（`README.md:184-185`）注意：**若列表中不含 `sec-default@builtin`，其保护即不生效**——这是组织自定义座位时的风险点。

### 3. Managed settings 的策略键（组织控制面）

从示例中可枚举到的、**只在 enterprise/managed 才生效**的键：

`examples/settings/README.md:5`：

> certain properties only take effect if specified in enterprise settings (e.g. `strictKnownMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`).

`examples/settings/settings-hipaa.json` 与 `README-hipaa.md:75` 的键清单：

| 键 | 作用（据示例） |
| --- | --- |
| `allowManagedHooksOnly` | hooks 只来自 managed settings；`/goal` 不可用（`README-hipaa.md:94`） |
| `allowedHttpHookUrls` | HTTP hook URL allowlist；**跨作用域合并**（`README-hipaa.md:138`） |
| `allowManagedMcpServersOnly` / `allowedMcpServers` / `deniedMcpServers` | MCP server 控制；`deniedMcpServers` 命名内置 `claude-in-chrome`/`computer-use`/`ide`（`settings-hipaa.json:9-13`） |
| `allowManagedPermissionRulesOnly` | 隐藏 prompt 里「总是允许」选项，忽略开发者 settings 的 allow/ask/deny（`README-hipaa.md:91`） |
| `strictKnownMarketplaces` | 市场 allowlist（空即全禁） |
| `strictPluginOnlyCustomization` | 只允许插件的自定义；阻止用户/项目 skill、command、agent（含会自declare `permissionMode` 的 subagent，`README-hipaa.md:112`） |
| `disableSideloadFlags` | 关闭 side-load（Claude Desktop 不再传它的插件） |
| `forceLoginMethod` / `forceLoginOrgUUID` / `allowedProviders` | 登录/组织/provider 锁定 |
| `forceRemoteSettingsRefresh` | 拿不到新鲜 server-managed settings 就启动即退出 |
| `disableRemoteControl` / `enableArtifact` / `syncClaudeAiSkills` / `syncClaudeAiPlugins` / `crossSessionInbound` / `skillOverrides` | 关闭远程控制、artifact、claude.ai 同步、跨会话入站消息等 |
| `autoMode`（`environment`/`soft_deny`/`hard_deny`/`classifyAllShell`） | 钉住 auto 模式的内置规则（`"$defaults"`） |
| `cleanupPeriodDays` | 本地会话数据保留期 |
| `env` | 注入环境变量（OTel、代理等；终端里 managed `env` 覆盖 shell） |

### 4. `permissions` 块（规则语法与模式）

`permissions.allow` / `ask` / `deny` 是字符串规则数组；`permissions.disableBypassPermissionsMode: "disable"` 关闭 bypass 模式（`examples/settings/settings-strict.json:2-11`）：

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "ask": ["Bash"],
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

规则语法（`settings-hipaa.json:17-48`）形如 `ToolName`、`Read(~/.ssh/**)`、`Edit(~/.npmrc)`、`Bash(git push:*)`。契约侧对应：

- `PermissionBehavior = 'allow' | 'deny' | 'ask'`（`types/claude-code.d.ts:6062`）。
- `ToolCheckResult.rule`：「The settings rule that decided, as written (`Bash(git push:*)`)」（`types/claude-code.d.ts:9963-9968`）——deny 规则可携带其原文，这正是 `sec-default` 能「按规则名持有」的基础。
- `PermissionRuleValue = { toolName; ruleContent? }` 与 `PermissionUpdate`（`addRules`/`replaceRules`/`removeRules`/`setMode`/`addDirectories`/`removeDirectories`，目的地 `userSettings|projectSettings|localSettings|session|cliArg`）（`types/claude-code.d.ts:6100-6134`，`addDirectories` 在 `6125-6127`）。`addDirectories` 即「追加目录」的引擎内表达，对应 settings 侧的额外目录能力。

### 5. Mods / 插件扩展面（hooks）

`sec-default` 保护的是 **classic hooks**（settings `hooks` 键），它**不挡 function hooks 的注册面本身**——个人可以装 mod，只要不触及受保护面。具体可用于扩展的示例见 `examples/hooks/bash_command_validator_example.py`：一个 **`PreToolUse` guard**，读 stdin JSON，按正则规则校验 Bash 命令，`sys.exit(2)` 阻断并让 stderr 触达模型：

```python
_VALIDATION_RULES = [
    (r"^grep\b(?!.*\|)", "Use 'rg' (ripgrep) instead of 'grep' ..."),
    (r"^find\s+\S+\s+-name\b", "Use 'rg --files | rg pattern' ..."),
]
...
    issues = _validate_command(command)
    if issues:
        for message in issues:
            print(f"• {message}", file=sys.stderr)
        # Exit code 2 blocks tool call and shows stderr to Claude
        sys.exit(2)
```

（`examples/hooks/bash_command_validator_example.py:36-79`；其 settings 挂载示例在同文件 `13-27` 的 docstring：`{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type":"command","command":"python3 ..."}]}]}}`）

`classic.PreToolUse` 在契约中的结果形状（`types/claude-code.d.ts:6448-6490`）为 `{ allow: true }` / `{ ask: string }` / `{ deny: string }` 或空（交给常规权限流），并可带 `updatedInput`（改写参数，按工具 schema 校验）与 `additionalContext`。

### 6. MDM / 企业部署面

`examples/mdm/` 提供四平台模板，全部编码同一个最小示例 `permissions.disableBypassPermissionsMode`（`examples/mdm/README.md:5`）：

| 文件 | 平台/渠道 | 落地位置 |
| --- | --- | --- |
| `examples/mdm/managed-settings.json` | 任意 | 系统配置目录 |
| `examples/mdm/macos/com.anthropic.claudecode.plist` | Jamf / Iru (Kandji) Custom Settings | preference domain **`com.anthropic.claudecode`** |
| `examples/mdm/macos/com.anthropic.claudecode.mobileconfig` | 完整 profile | `com.apple.ManagedClient.preferences`，`Forced` → `mcx_preference_settings` |
| `examples/mdm/windows/Set-ClaudeCodePolicy.ps1` | Intune Platform scripts | 写 `C:\Program Files\ClaudeCode\managed-settings.json` |
| `examples/mdm/windows/ClaudeCode.admx` + `en-US/ClaudeCode.adml` | Group Policy / Intune Import ADMX | 写 **`HKLM\SOFTWARE\Policies\ClaudeCode\Settings`**（REG_SZ，单行 JSON） |

Windows ADMX 的落地键与元素（`examples/mdm/windows/ClaudeCode.admx:15-26`）：`class="Machine"`、`key="SOFTWARE\Policies\ClaudeCode"`、`<text id="SettingsJson" valueName="Settings" maxLength="1000000" />`。ADML 的 `ManagedSettings_Explain`（`en-US/ClaudeCode.adml:12-21`）说明：完整 settings 以单行 JSON 存于 `HKLM\SOFTWARE\Policies\ClaudeCode\Settings`，**最高优先级，用户不可覆盖**。

README 的校验点（`examples/mdm/README.md:22-24`）：替换 `PayloadUUID`/`PayloadOrganization`；用 `/status` 的 **Setting sources** 确认来源（macOS 显示 `Enterprise managed settings (plist)`，Windows 显示 `Enterprise managed settings (HKLM)`）；部署后位于优先级顶端、不可被用户覆盖。

**HIPAA 全量示例**（`examples/settings/settings-hipaa.json` + `managed-mcp-hipaa.json`）展示了生产级策略：`sandbox` + 网络 allowlist + 凭据保护（`credentials.files`/`envVars` deny）+ `permissions.deny` 覆盖 `~/.ssh`、`~/.aws`、`~/.npmrc`、`~/.git-credentials`、`~/.claude.json` 等 + 30 天本地保留。关闭 MCP：`managed-mcp-hipaa.json` 部署为 `managed-mcp.json`，内容为 `{ "mcpServers": {} }`（`README-hipaa.md:20`）。

### 7. CI 硬化面（本仓库自身的安全约定）

根 `CLAUDE.md` 规定：调用 Claude 的 workflow job 有三重保护——**egress-firewall runner**（`runs-on: ubuntu-24.04-firewall`）、**网络 allow list**（`.github/egress-firewall.yaml`，须 `mode: enforce`）、**`--permission-mode auto`**（每条运行 Claude Code action 的 step 必须带）。`claude.yml:48` 为例：

```
claude_args: "--model claude-sonnet-4-6 --permission-mode auto"
```

`claude.yml:45-47` 说明 action 对 `@claude` mention 会设 `acceptEdits`，而 workflow 的 `claude_args` 里后出现的 `auto` 覆盖之。`--disallowedTools` 永不运行的工具有例（`claude-dedupe-issues.yml:48`）。

`.github/egress-firewall.yaml` 头部规则（`:1-3`）：「Add a host only when a workflow step needs it, name it in full (no `'*'`)」。校验脚本 `.github/scripts/check_workflow_hardening.py` 强制的规则：

- job 调用 Claude 就必须在防火墙 runner（`check_workflow_hardening.py:243-253`），除非登记在 `EXEMPT_FROM_FIREWALL_RUNNER`；
- 每个运行 Claude Code action 的 step 必须 `--permission-mode auto`（`:140-152`）——且必须**恰好是 `auto`**；
- 模型须 ≥ `claude-opus-4-6`，否则 auto 模式会退回默认模式（`AUTO_MODE_MIN_VERSION = (4, 6)` @ `:22`；`predates_auto_mode` @ `:200-209`）；
- 不得出现 `--dangerously-skip-permissions`（`:125-129`）；
- settings 不得设权限模式：任何 `defaultMode` 出现即报错（`:174-175,260-265`）；
- `EXEMPT_FROM_AUTO_MODE` 里的 job 必须**完全不设**权限模式（`:134-139`）；
- allow list 必须存在、非空、`mode: enforce`、且条目不得含 `*`（`:277-309`）。

---

## 设计决策与权衡

**D1. 安全默认「最外层 + 不制定策略」——把「守门」与「决策」分离。**
`sec-default` 只做三个动作（越层/拒绝/放行），策略全在 managed settings。收益：安全默认的行为极小、可审计、不随组织策略变化而变化；组织的实际策略（deny 规则、allowlist、沙箱）在产品其他部分集中定义。代价：安全默认的「有效性」完全依赖 CLI 把它安置在 `prepend`——一旦组织自定义 `prependPlugins` 却漏列它，保护即静默消失（`README.md:182-186`）。

**D2. 用「钉死的 provenance」而非自述字段做信任判定。**
`e.provider` / `next.origin` / `plugin.register` 的 `e.tier` 都由宿主设置，插件写不进去（`types/claude-code.d.ts:5907-5910`、`6205-6209`）。收益：改名/伪造无法提权（`README.md:61-62`）。代价：API 需保证这些字段永不被 hook 与 `next.to` 污染（`next.to` 保持 origin，见 `:5281` 注释）。

**D3. fail closed 贯穿所有读策略的路径。**
`decidedByPolicy`（读失败/判定抛错 → `true` = 保护，`decided-by-policy.ts:12-16`）、`createPolicyMemo` 连拒绝也缓存（`create-policy-memo.ts:3-6`）、`managedToolsRestored` 缺策略即用组织列举、`caughtAnswer` 放宽即 `UNCHECKED_DENY`、`plugin.register` 的 `.catch` 在未 `next` 时拒绝。收益：策略不可读 ≈ 策略存在。代价：一次 managed 读的**瞬时故障**会短暂锁死；`POLICY_MEMO_MS=500` 把这种影响限制在一个窗口内，同时以「设置变更最多 500ms 才被看到」换低读放大。

**D4. deny 规则用「第二遍穿行」持有，而非直接读规则表。**
`tool.check` 的 `next.to(e,'append')` 重跑（`register.ts:67-94`）让「同一问」在跳过 user 层后再评一次规则，且只认**命名了规则的 deny**（`isRuleDeny`）。收益：无论 deny 规则来自哪个 settings 文件、无论个人插件如何把 allow/ask 塞进来，只要「去 user 层后」得到规则 deny 就持有；`ask→allow`（无规则背后）则不受影响，尊重个人插件的本意。代价：hook 本身承载复杂度（leniency 排序、batch tier 标签、两遍被组织 prepend 插件都会跑两次——`README.md:139-141` 承认「a prepended one that loosens … its hooks run twice」）；并且**钩住 `tool.check` 本身有成本**：引擎只在有插件钩它时才 raise 该事件，所以 `sec-default` 就位后**每一次工具调用都会跑 `tool.check` 链**（`README.md:99-102`）。

**D5. 宽松度排序（`LENIENCY`）而非「是否等于 allow」。**
`deny:0 < ask:1 < allow:2`，且「从不调用 `next` 的 link 按对 deny 度量」（`is-looser.ts`）。收益：能识别 `deny→ask` 这类「部分放宽」，也能识别「直接吞掉链、凭空返回 allow」这种最危险形态。代价：批处理（共享 worker 的相邻插件）会被记为**批首成员的 tier**，所以组织的一个 `prepend` 插件可能代表一个含个人插件的批次（`tiers-holding-users.ts:1-7`）——只能靠「是否放宽」保守筛查，真正归属留给第二遍穿行去判定，**不做猜测**（`loosened-by-users.ts:10-11`「whether a person's plugin did the loosening is settled by the run past the user tier, never here」）。

**D6. `allowManagedModsOnly`「缺省即锁」但 `allowModsToOverrideDenyRules`「缺省即守」。**
前者缺省即开（`value !== undefined && value !== false`），后者只有字面 `true` 才放开。这不是笔误，而是「两个开关的默认方向都指向更安全」：限制个人 mod 默认开、放开 deny 规则默认关。代价：语义不对称、需文档强调（`README.md:69-76,88-91`）。

**D7. 沙箱只作用于 Bash，且是独立层。**
`examples/settings/README.md:27` 明确沙箱不覆盖 Read/Write/WebSearch/WebFetch/MCP 与内部命令。收益：隔离与工具权限解耦，各自可解释。代价：HIPAA 文档反复提醒需要**同时**配置 `permissions.deny`（拦 Claude 自己的读/写）、`sandbox.filesystem.denyWrite`（拦沙箱内命令的写）与 `sandbox.credentials`（拦凭据外泄），三者语义不同（`README-hipaa.md:46-47` 强调 `denyWrite` 不管 Claude 自己的编辑）。且 `allowedHttpHookUrls`、`sandbox.excludedCommands`、`sandbox.filesystem.allowWrite` **跨作用域合并**，managed 值只能当默认值（`README-hipaa.md:138-141`）。

**D8. `settings.read` 也是一条可被 hook 的链，安全默认必须把它也锁住。**
因为 `settings.read` 是事件（`types/claude-code.d.ts:5786,5891`），个人插件本可改写「别人读到的设置快照」——包括 `sec-default` 自己的策略读。于是 `sec-default` 对 `settings.read` 也 `next.to(e,'append')`（`register.ts:32`），确保任何人（含它自己）读到的是「组织的 tiers 所构成的」设置。

**D9. 与经典 settings hooks 共存而非取代。**
classic hooks 自成一条链「[managed settings hooks, ...hooks modules, the other settings hooks as core]」（`types/claude-code.d.ts:947-949`）。`sec-default` 对 `classic.*` 只做越层，让 managed hooks 先跑、其 deny 即结果。收益：不破坏既有的 shell hook 生态。代价：`allowManagedHooksOnly`/`disableAllHooks`/`--bare` 治理的是**settings hooks 与已安装插件，不含内置**（`mods/agents-md/README.md:75-77`），边界需说清。

**D10. 企业控制面「声明式键 + MDM 落地」而非「API 调用」。**
策略以 settings 键表达，经文件、macOS plist、Windows 注册表、Intune/GPO 分发，统一落在最高优先级。收益：与既有 IT 治理工具链（Jamf/Iru/Intune/GPO）无缝。代价：键很多、语义各异（allow list 合并与否、`"$defaults"` 钉法等），且部分键只在 enterprise/managed 才生效（`examples/settings/README.md:5`），有误配风险。

---

## 对复刻产品的启示

1. **先做「分层 hook 链 + 钉死的来源」，再做安全默认。** `TIERS` 五层 + `Origin`（宿主写、插件读）+ `next.to` 只能往权限更低的方向跳（`TargetTier` 排除 `prepend`/`user`），是整套安全模型的承重墙。复刻时若没有「不可伪造的来源」与「不可向上跳层」，任何安全默认都会被绕过。

2. **把「安全默认」做成零策略的守门器，与「策略」分离。** 学 `sec-default`：三个动作、绝不改写、不新增策略。策略放 managed settings；守门器只保证「组织的控制面不被个人插件触及」。这让安全默认的行为面极小、可形式化验证，也让策略演进不必改守门器。

3. **默认方向一律指向更安全（fail closed）。** 读策略失败=策略存在；可读性故障用短 TTL 记忆化限制影响；模块未被问过就拒绝；`tool.check` 出错时对「被放宽的」判 deny。复刻时务必为每个「读配置 / 判定」路径写出「失败时怎么办」，并默认保护。

4. **deny 规则必须可重放、可携带规则名。** `sec-default` 之所以能「持有 deny」而不直接读规则表，是因为 `tool.check` 的输入身份被钉死、且 deny 会带回 `rule` 原文（`ToolCheckResult.rule`）。复刻时：让决策事件可被「跳过某层」重放，且 deny 结果携带规则标识——否则无法区分「规则 deny」与「工具自检 deny」。

5. **明确定义「谁的上限不能被谁放宽」，并保守处理批处理。** 引擎把共享 worker 的相邻插件记为一批、按批首 tier 记名。复刻时要么避免此优化，要么像 `sec-default` 一样：先保守筛查「谁放宽了」，再用一次干净重放**确认**，绝不在初筛阶段断定归属。

6. **设置优先级要显式建模，且安全判定只读最高层。** 复刻时给出 `user<project<local<flag<policy` 这样的有序来源枚举，并让安全相关读取只走 `policy`（managed）。同时把 `settings.read` 本身也纳入 hook 链并保护——否则「读到的设置」可被下层插件篡改。

7. **托管部署按操作系统提供一等落地。** 文件（系统配置目录 + `C:\Program Files\...\managed-settings.json`）、macOS preference plist（`com.anthropic.claudecode`）、Windows 注册表（`HKLM\SOFTWARE\Policies\...`，单行 JSON）+ ADMX/ADML + Intune 脚本。给管理员一个 `/status` 式的「设置来源」自检点。

8. **沙箱与工具权限分开设计，并如实说明覆盖范围。** 明确「沙箱只作用于 Bash」；同时管理 `permissions.deny`（Claude 自己的工具）、`filesystem.denyWrite`（沙箱内命令）、`credentials`（凭据）三套语义；对「跨作用域合并」的键（如 `allowWrite`、`excludedCommands`、`allowedHttpHookUrls`）标注为「默认值，可被开发者加宽」。

9. **给安全默认提供可审计的输出。** `sec-default` 用 `$.ui.log`（debug 日志）与一次性的 `heldNotice` 告诉个人「你的插件试图掀翻一条 deny 规则」。复刻时保留「链上发生了什么」的可观测信号，且对敏感动作在 `-p`（无终端）下仍写 debug 日志。

10. **把 CI 自身当受管环境。** 根 `CLAUDE.md` 的三重保护（防火墙 runner + allow list + `--permission-mode auto`）与 `check_workflow_hardening.py` 的强制校验，是可复用的模板：**用脚本把安全约定变成会失败的检查**，并把豁免登记在表（`EXEMPT_FROM_AUTO_MODE`）里、要求「豁免者一律不设模式」。

---

## 关键文件索引

**mod 源码（`sec-default`）**

- `mods/sec-default/README.md:1-190` — 权威行为说明（rows 表、两个选项、deny 持有、座位）。
- `mods/sec-default/.claude-plugin/plugin.json` — 名称 `sec-default`，版本 `0.1.0`。
- `mods/sec-default/hooks/hooks.json` — `{ "modules": ["./register.ts"] }`。
- `mods/sec-default/hooks/register.ts:20-120` — 全部 15 个 hook 的注册与实现（三动作）。
- `mods/sec-default/hooks/policy/source.ts:4` — `SOURCE = { source: 'policy' }`。
- `mods/sec-default/hooks/policy/create-policy-memo/create-policy-memo.ts` — 记忆化（TTL，含拒绝）。
- `mods/sec-default/hooks/policy/policy-memo-ms.ts:7` — `POLICY_MEMO_MS = 500`。
- `mods/sec-default/hooks/policy/decided-by-policy.ts:12-16` — fail-closed 判定的通用包装。
- `mods/sec-default/hooks/policy/own-option/own-options-path/own-options-path.ts:5-9` — `pluginConfigs['cc-plugin-sec-default@builtin'].options`。
- `mods/sec-default/hooks/policy/is-managed-mods-only.ts:15-19`、`deny-rules-hold.ts:15-16`、`has-mcp-allowlist.ts:10-11`。
- `mods/sec-default/hooks/policy/managed-tools-restored/`（`managed-tools-restored.ts`、`is-org-tool/…`）— `tool.list` 合并。
- `mods/sec-default/hooks/past-users/past-users.ts`、`…/user-reachable-tiers/user-reachable-tiers.ts` — 主体溯源。
- `mods/sec-default/hooks/held-verdict/verdicts/loosened-by-users.ts`、`is-rule-deny.ts`、`ranking/leniency/leniency.ts`、`ranking/is-looser.ts`、`ranking/handed-to.ts`、`ranking/tiers-holding-users/…`、`unchecked-deny.ts`、`held-notice.ts`、`caught-answer.ts` — deny 持有全套。
- `mods/sec-default/hooks/tool-register-refusal/tool-register-refusal.ts`、`…/managed-mods-only-refusal/…`、`…/admission-failure/…`。
- `mods/sec-default/tests/register.test.ts:1-830` — 行为证据（座位 `tier('prepend')`；allowlist/deny/`allowManagedModsOnly` 场景）。

**契约（类型声明）**

- `mods/types/claude-code.d.ts:6062`（`PermissionBehavior`）、`:6074-6076`（`PermissionMode`）、`:6100-6134`（permission rule/update 形状）。
- `mods/types/claude-code.d.ts:9282-9311`（`Settings`/`SettingsReadArgs`/`SettingsSource`，优先级顺序）。
- `mods/types/claude-code.d.ts:9642`（`TargetTier`）、`:9726-9743`（`Tier`/`TIERS`）。
- `mods/types/claude-code.d.ts:5905-5928`（`Origin`）。
- `mods/types/claude-code.d.ts:5230-5311`（`Next`）。
- `mods/types/claude-code.d.ts:9909-9972`（`ToolCheckDecision`/`Input`/`Result`，`rule`）。
- `mods/types/claude-code.d.ts:6203-6245`（`PluginRegisterInput`/`Result`）。
- `mods/types/claude-code.d.ts:9995-10015,10081`（`ToolDescribeInput.provider`、`ToolInfo`）。
- `mods/types/claude-code.d.ts:6445-6490`（`PreToolUseDecision`/`Result`）。
- `mods/types/claude-code.d.ts:11298`（`ValueOrDeny`）、`:10220`（`TraceEntry`）。
- `mods/types/claude-code.d.ts:3245-3264`（`tool.call`/`tool.check` 顺序语义）。
- `mods/types/claude-code.d.ts:12409-12477,12715-12716`（Bash/PowerShell `dangerouslyDisableSandbox`）。

**示例：settings / 沙箱 / MCP**

- `examples/settings/settings-strict.json`（`permissions.ask/deny`、`allowManagedPermissionRulesOnly`、`allowManagedHooksOnly`、`strictKnownMarketplaces`、沙箱骨架）。
- `examples/settings/settings-lax.json`、`settings-bash-sandbox.json`、`README.md:13-27`（对比表；沙箱仅作用于 Bash）。
- `examples/settings/settings-hipaa.json`（全量生产策略：`permissions.deny`、`sandbox.*`、`credentials`、`env`、`autoMode`）、`managed-mcp-hipaa.json`（`{ "mcpServers": {} }`）。
- `examples/settings/README-hipaa.md`（键语义、部署前编辑、容忍范围、auto mode、核对清单）。
- `examples/hooks/bash_command_validator_example.py`（`PreToolUse` guard 示例）。

**示例：MDM / 企业部署**

- `examples/mdm/README.md`、`managed-settings.json`。
- `examples/mdm/macos/com.anthropic.claudecode.mobileconfig`、`…/com.anthropic.claudecode.plist`。
- `examples/mdm/windows/ClaudeCode.admx`、`windows/en-US/ClaudeCode.adml`、`windows/Set-ClaudeCodePolicy.ps1`。

**CI 硬化（本仓库）**

- `CLAUDE.md:7-32`（三重保护 + 豁免表规则）。
- `.github/egress-firewall.yaml:1-27`（`mode: enforce` + 具名 allow）。
- `.github/scripts/check_workflow_hardening.py:14-31,109-189,231-335`。
- `.github/workflows/claude.yml:20-48`、`claude-dedupe-issues.yml:45-48`、`claude-issue-triage.yml:48-53`、`workflow-hardening.yml:22-24`。

**相邻/参照**

- `mods/README.md:1-70`（四个内置 mod、mod 组成与名词契约）。
- `mods/agents-md/README.md:55-80`（`allowManagedHooksOnly`/`disableAllHooks`/`--bare` 对内置与新装插件的边界）。

---

## 存疑与待确认

1. **seat 算法在 CLI 侧，不在本仓库。** 「有 managed settings 或是 Team/Enterprise 就把 `sec-default` 置于 `prepend` 首位」这一规则只见于 `mods/sec-default/README.md:178-186` 与 `mods/README.md:10`，仓库内没有对应的引擎实现可核。判定「Team/Enterprise」的具体信号、以及 `prependPlugins` 与 `user`/`append` 的完整合并算法未能验证。

2. **`allowManagedModsOnly` 的「误配使 CLI 忽略整个 `pluginConfigs`」**（`README.md:71-76`）属描述性行为，仓库内无 schema 代码可核；其确切报错形态（settings warning 的文案/位置）未确认。

3. **`prependPlugins` 的完整键语义**（是否与 `appendPlugins` 成对、是否支持 `@marketplace` 后缀的严格匹配、未列 `sec-default` 时是否真的完全无保护）在仓库中只有 README 的一段示例（`README.md:83-85,182-186`），无 schema。

4. **`enableAllProjectMcpServers` 与 `additionalDirectories`**：任务清单提及，但**在整个仓库（含 `types/claude-code.d.ts`、示例 settings）中未检索到这两个键**。`types/claude-code.d.ts` 只出现 `PermissionUpdate` 里的 `addDirectories`/`removeDirectories`（`:6121-6128`）。它们是否为不同版本/不同命名（例如 `enableAllProjectMcpServers` 对应 MCP 项目级默认开启、`additionalDirectories` 对应额外可访问目录）无法据此确认——**标记为未证实，复刻时请以官方 settings 文档为准**。

5. **`permissions.defaultMode`**：本仓库只在 CI 校验脚本里作为「禁止出现」的键出现（`check_workflow_hardening.py:174-175,260-265`），未见于示例 settings；其允许取值与优先级未在仓库中定义。同理 `disableAutoMode`（`README-hipaa.md:111` 提到）也无契约可核。

6. **`disableBypassPermissionsMode` 的完整取值域**：示例只用 `"disable"`；是否存在其他值（如 `"allow"`）未证实。`bypassPermissions` 模式需要 `allowDangerouslySkipPermissions`（`types/claude-code.d.ts:6074`），但该开关与 settings 键的对应关系未在仓库中给出。

7. **沙箱的实现细节**（bubblewrap/socat 的调用、代理端口语义、`enableWeakerNestedSandbox`/`enableWeakerNetworkIsolation` 的具体让步、`failIfUnavailable` 在 Windows/WSL1 的行为）来自 HIPAA README 的**文字说明**（`README-hipaa.md:27-29,51-54`），非契约；不同平台的精确退出/报错形态未证实。

8. **auto 模式的分类器实现与 `autoMode` 列表合并规则**（`"$defaults"` 语义、`soft_deny` vs `hard_deny` 的优先级、开发者 list 与 managed list 的合并）只在 `README-hipaa.md:100-115` 有行为描述，无 schema/代码可核。

9. **server-managed settings 的合并规则**：`SettingsSource` 只覆盖 `user/project/local/flag/policy`，`policy` 注释说「every managed tier merged」（`types/claude-code.d.ts:9309-9311`），但**服务器托管设置与本地 managed 文件、MDM plist/注册表的相对优先级**在仓库中仅见于 `README-hipaa.md:129-133` 的指引，未证实。

10. **`tool.list` 的「批处理 tier 记名」对内建/组织混杂批次的影响**：`TIERS_HOLDING_USERS` 含 `prepend` 是为覆盖「`sec-default` 之下的 `prepend` 批次含个人插件」这一情形（`tiers-holding-users.ts:1-7`），但引擎「相邻插件共享 worker 并成批」的确切边界（多少个、如何排序）在仓库中不可见。

11. **`plugin.register` 对 `builtin` 层为何不问**：README 说 `prepend/append/builtin` 从不被问（`README.md:36`），代码用 `{ tier: 'user' }` 匹配器实现；但 `readPolicy` 只在它被调用时才读吗——`plugin.register` 用的是**非 memo** 的 `$.settings.read`（`register.ts:110`），与其余判定用的 memo 读取不一致，是否为有意（每次加载都读最新）未在注释中说明。

12. **`sec-default` 无 `types/index.d.ts`**：按 `mods/README.md:52-66` 的「名词契约」规则，只有新增 `$` 名词的 mod 才需该文件；`sec-default` 不新增名词，故无。其类型仅依赖 `claude-code` 契约——这一点可确认，但若复刻产品要求「每个安全组件都有一份自查契约」，此处是一个需要补的空白。
