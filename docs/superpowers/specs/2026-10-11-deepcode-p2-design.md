# DeepCode —— P2 安全内核设计

> 上游：`2026-10-11-deepcode-mvp-design.md`（§9.2 的 P2 列、§9.3 的 P2 出口标准）
> 依据：`claude-code-架构分析/06-security-permissions.md`
> 本文只写 P2 的**决策**与相对前序阶段的**差异**，不重复 P1 已确立的契约。

---

## 0. 决策摘要

六条已拍板（后四条是本次逐条问过后定的）：

1. **范围 = 安全内核**：settings 五层来源 + allow/ask/deny 规则引擎（含带参匹配）+ `sec-default` 守门器 + deny 带规则名 + 按权限过滤工具可见性。
   **不在本轮**：OpEvent 层（59 事件）、provider gateway / `base_url` 收口。
2. **`sec-default` 真做**：它是坐在 `prepend` 的真插件；`policy` 源来自一个真实可配置的托管文件，`DEEPCODE_MANAGED_SETTINGS` 可把它指到别处（测试用）。
3. **不做权限模式**（`acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`）。要放行就在 settings 里写 allow 规则 —— 可见、可审计、可回滚。这与 README 里"谁加自动放行开关谁就是在开倒车"是同一条线。
4. **规则优先级固定 `deny > ask > allow`**，与规则写在哪个数组里、数组内什么顺序都无关。
5. **`sec-default` 持有裁决，不做重放**（理由见 §11 偏差 1）。
6. **权限设置与 `config.json` 完全分开**：`settings.json` 管权限，`config.json` 管连接，两套优先序互不干涉。**策略层里没有环境变量这一层** —— 环境变量能改权限就是一条绕过途径。

---

## 1. 三条出口标准怎么落

文档 §9.3 对 P2 的原文是：

> 个人插件无法放宽组织策略（`next.to` 只能向下跳，有测试证明）；每个判定路径都有明确的失败行为；deny 结果携带规则名且决策可重放

逐条对应：

| 出口标准 | 怎么落 | 怎么验 |
|---|---|---|
| 个人插件无法放宽组织策略 | `next.to` 目标运行时收窄（§2.2）+ `sec-default` 持有策略裁决（§6） | 行为：`user` 层插件返回 `allow`，最终仍是 `deny` 且 `rule` 是策略规则原文。结构：`next.to` 目标不严格靠内即抛错 |
| 每个判定路径都有明确的失败行为 | §7 的失败行为表逐条钉住 | 每条一行测试 |
| deny 携带规则名 | `ToolCheckResult.rule` 填**规则原文**（`Bash(git push:*)`），在规则命中点填 | 断言 `rule` 全等原文 |
| ~~决策可重放~~ | **有意不做**，见 §11 偏差 1 | — |

---

## 2. 座位：`tier` 第一次被真正用起来

### 2.1 布局

```
prepend   sec-default                                    ← 只读 policy 源，持有裁决
user      permissions                                     ← 只读其余四源
builtin   coreTools / confirm / commands / stream / session-*
core      tool.check 兜底（fail-closed，P1 原样）
```

`permissions` 坐 `user` 不是修辞 —— `user` 正是守门器要有权压过的那一层。这样"层"这个抽象第一次有了语义，而不是五个排好序的常量。

### 2.2 座位表由 CLI 钉，不由插件自述

架构文档明确：`plugin.register` 的判定读的是"CLI 钉在模块上的 tier，而不是模块自述的任何东西"。所以座位**不能**做成 `Plugin.tier` —— 那等于让插件自己声明自己的权威，正好是这套机制要防的东西。

落地：`CreateEngineDeps` 加一个可选字段

```ts
/** 插件名 → tier。没列到的一律 builtin。引擎只认这张表，不认插件自述。 */
seating?: Readonly<Record<string, Tier>>;
```

`create.ts` 里 `makeOn(registry, plugin.name, 'builtin')` 改成从表里取；`plugin.register` 事件带的 `tier` 也取同一个值。默认 `builtin` ⇒ **现有测试与 harness 一行都不用改**。

同时堵上一条真实通道：`dispatch.ts:120-124` 的 `next.to` 目前只是"跳过更靠外的层"，遇到向外跳的目标会**静默不跳**。改成运行时收窄 —— 目标 tier 若**不严格比调用者靠内**，直接抛错。理由：静默不跳会让一个本意想"跳过组织层"的插件以为自己跳成功了，而实际裁决仍被组织层持有 —— 行为对，但没人知道它错。抛错会被 dispatch 的故障隔离接住、跳过该 hook，是安全的方向。

### 2.3 `cliPlugins` 的返回值

```ts
export function cliPlugins(deps: CliPluginDeps): {
  plugins: Plugin[];
  seating: Record<string, Tier>;
};
```

一处owns 插件清单与座位，测试在同一个地方钉住两者。P1 的 `cliPlugins` 顺序契约测试（`test/cli.test.ts`）继续有效。

---

## 3. 规则与匹配 —— `src/contract/policy.ts`

### 3.1 为什么放 `contract/`

依赖边界规定 `builtins: ['contract']`，而 `permissions` 与 `sec-default` 两个内建插件都要用规则匹配。`contract/tier.ts` 已经带了 `tierIndex` / `isOuterThan` 这种纯逻辑，是同一条先例。这个文件零依赖、零 IO、纯函数。

### 3.2 形状

```ts
export type Behavior = 'allow' | 'ask' | 'deny';

export type Rule = {
  /** 规则原文，原样保留。deny 要按它"持有"，也按它回报给人。 */
  readonly raw: string;
  readonly tool: string;
  readonly content?: string;
};

export type ParsedRule = Rule | { readonly error: string };

export function parseRule(text: string): ParsedRule;
export function matchesRule(rule: Rule, call: Call): boolean;
export function evaluate(
  rules: readonly Rule[],
  call: Call,
): { readonly decision: Behavior; readonly rule: string } | undefined;

/** deny 最严，allow 最松。数字只用于比较，"谁赢"仍由 evaluate 的固定优先级决定。 */
export const LENIENCY: Record<Behavior, number> = { deny: 0, ask: 1, allow: 2 };
export function isLooser(a: Behavior, b: Behavior): boolean;
/** deny > ask > allow。 */
export function stricter(a: Behavior, b: Behavior): Behavior;
```

`Call = { tool: string; input: unknown }`，与 `tool.check` 的事件参数同形。

`evaluate` 的语义：扫全部规则，各按行为分桶；**bucket 顺序固定 `deny → ask → allow`**，第一个非空的桶里取**第一条**命中的规则，返回 `{ decision, rule: 该条原文 }`。未命中返回 `undefined`。

**为什么固定优先级而不是"先到先得"**：更严的永远赢，与全局 fail-closed 同方向，且好推理 —— 结果与数组顺序无关，重排一下配置不会换行为。

### 3.3 匹配语义（架构文档一处都没写，全部由本文拍板）

| 规则写法 | 含义 |
|---|---|
| `Bash` | 匹配该工具的**所有**调用 |
| `Bash(git push)` | 命令行**恰好等于** `git push` |
| `Bash(git push:*)` | 命令行**以 `git push` 开头**，按空白 token 边界 —— `git push origin main` ✓，`git pushup` ✗ |
| `Read(~/.ssh/**)` | `file_path` 按 glob 匹配：`*` 单段、`**` 跨段 |
| `Edit(...)` / `Write(...)` | 同 `Read`，都匹配 `file_path` |
| 其它工具带括号 | **不支持**：不匹配，且**加载时点名警告一次**（见 §7） |

`:` 必须按 **token 边界**解释，不能当普通通配符：若当通配符，`Bash(git push:*)` 会要求命令里真有一个冒号，而 `git push origin main` 没有 —— 规则永远不命中，安静地失效。

归一在**两侧**都做（规则内容与命令行）：去首尾空白、连续空白折叠成单空格，这样 `git  push` 与 `git push` 是同一件事。路径类规则里的 `~` 展开成 home 后再比对，且**大小写按平台原样比较**（Windows 的文件系统不区分，但我们不替它做归一 —— 猜错的症状是一条防御规则悄悄不命中）。

### 3.4 解析失败

`parseRule` 对五类输入返回 `{ error }`，不抛：

- 空串
- 括号不配对（`Bash(git push` / `Bash(git push))`）
- 工具名为空（`(git push)`）
- 工具名含空白或括号（`git push`、`Ba(sh`）
- 内容为空（`Bash()`）

调用方（§4）负责把 `error` 连同原文报到人面前。**解析失败的规则一条都不生效**，且必须吼。

---

## 4. 来源与优先级 —— `src/cli/settings.ts`

### 4.1 五层

架构文档给出的顺序（低 → 高）：

| 源 | 路径 | 优先级 |
|---|---|---|
| `user` | `<home>/.deepcode/settings.json` | 最低 |
| `project` | `<root>/.deepcode/settings.json` | ↑ |
| `local` | `<root>/.deepcode/settings.local.json` | ↑ |
| `flag` | `--settings=<路径>` | ↑ |
| `policy` | 托管文件，**所有 managed 层合并** | 最高 |

`policy` 的默认路径：Windows 是 `%ProgramFiles%\DeepCode\managed-settings.json`，其它平台 `/etc/deepcode/managed-settings.json`。环境变量 `DEEPCODE_MANAGED_SETTINGS` 可覆盖它 —— 存在这个变量的唯一理由是让测试不必往系统目录写文件。

`--settings` 沿用 `--resume=<id>` 的先例，**只认等号形式**（`--settings=<路径>`）；裸 `--settings` 仍是被拼进提示词的普通文本。相对路径按当前工作目录解析；给的是目录或读不到，按 §7 的"存在但坏掉"处理。

### 4.2 文件形状

就是文档里的那一份，本轮只认 `permissions` 一个顶层键：

```json
{
  "permissions": {
    "allow": ["Read"],
    "ask":   ["Bash"],
    "deny":  ["Bash(git push:*)", "WebSearch"]
  }
}
```

三份数组都可省略。

### 4.3 解析成两个不可变数组

```ts
export type SourceInfo = {
  readonly source: SettingsSource;      // 'user' | 'project' | 'local' | 'flag' | 'policy'
  readonly path: string;
  readonly state: 'missing' | 'ok' | 'broken';
  /** state==='broken' 时的原因；直接给人看。 */
  readonly error?: string;
  readonly counts: { allow: number; ask: number; deny: number };
  readonly problems: readonly string[];  // 逐条规则的问题（含原文）
};

export type ResolvedPolicy = {
  readonly sources: readonly SourceInfo[];
  /** 只来自 policy 源。给 sec-default。 */
  readonly policyRules: readonly Rule[];
  /** 其余四源的并集。给 permissions。 */
  readonly personalRules: readonly Rule[];
};
```

**为什么其余四源可以取并集、不必保留层序**：在固定优先级 `deny > ask > allow` 下，四源之间的先后**不影响结果** —— 任何一条 deny 都赢过任何一条 allow，不论它们来自哪一层。所以"并集"不是图省事的近似，而是这套语义下的准确刻画。真正承重的划分只有一条：**policy 源 vs. 其余全部**。这也正是架构文档说的"安全判定只读 `policy`"（`README.md:69-71`）。

层序仍然保留，但只服务于 `/permissions` 的**可审计输出**（§8），不参与裁决。

### 4.4 与 `config.json` 的关系

完全分开，两套优先序互不干涉：

| 文件 | 管什么 | 优先序 |
|---|---|---|
| `.deepcode/config.json` | 连接（`apiKey` / `model` / `baseUrl` / `provider` / `debug`） | 环境变量 > 项目级 > 用户级 |
| `.deepcode/settings.json` | 权限规则 | `user < project < local < flag < policy` |

后者**刻意没有环境变量这一层**。前者有，是因为"别把 key 写进文件"是真需求；权限不一样 —— 一个环境变量就能改掉权限，等于在规则引擎上开了个后门。托管策略必须来自文件。

---

## 5. `permissions` 插件 —— `src/builtins/permissions.ts`

```ts
export function createPermissionsPlugin(deps: { rules: readonly Rule[] }): Plugin;
```

坐 `user` 层，挂两个事件。

### 5.1 `tool.check`

```
hit = evaluate(rules, e)
hit 未命中            → return next(e)          // 下沉到 confirm，行为与 P1 逐条一致
下游 = await next(e)
下游.decision === 'deny'  → return 下游          // 规则不许把一个更严的判定放宽
hit=allow 且 下游=ask     → return { allow, rule: hit.rule }   // 这是 allow 规则的全部作用
其它                      → return { hit.decision, rule: hit.rule }
```

两条要点：

- **`rule` 一律填规则原文。** 这就是出口标准"deny 携带规则名"的地基，也是 §6 里 `sec-default` 能"按规则名说话"的前提。
- **规则不能放宽一个 deny。** `allow` 规则的效力上限是"把 `ask` 变成 `allow`"；它不能掀翻下面任何一层已经给出的 deny。少了这一条，一条宽泛的 `allow: ["Bash"]` 就能把 `confirm` 的未知工具拒绝也一并抹掉。

### 5.2 `tool.describe` —— 工具可见性

架构文档没有正面描述"按权限过滤工具可见性"（MVP 设计 §9.2 的 P2 工具行是唯一出处）。本文据引擎现有机制给出定义：

**只有"整工具 deny"才隐藏工具。** 即 `deny: ["WebSearch"]` 这种**不带括号**的规则，会让 `WebSearch` 从模型可见的工具清单里消失。参数化 deny（`deny: ["Bash(git push:*)"]`）**绝不隐藏整个工具** —— 为了拦一条命令而把整个 Bash 藏掉是灾难。

机制：`Result<'tool.describe'>` 加一个变体

```ts
'tool.describe': { description: string; inputSchema: unknown } | { hidden: true };
```

插件对被整工具 deny 的每个名字注册 `on('tool.describe', { tool: name }, () => ({ hidden: true }))`。`core/loop.ts` 的 `describeTools` 遇到 `hidden` **安静跳过**（`logger.debug` 一行），而不是现在那句"没有注册描述"的**警告** —— 那两者是完全不同的事，混在一起会让人以为插件坏了。

`sec-default` 用同一机制隐藏**策略**里的整工具 deny（§6）。它坐 `prepend`，所以策略的隐藏先于个人的隐藏生效。

**已知粗糙处**：`/help` 走的是 `$.tool.list()`（注册面直读，不经过 dispatch），因此仍会列出被隐藏的工具。隐藏只作用于**模型可见清单**，那才是承重的那一份；被隐藏的工具由 `/permissions` 明确列出（§8）。

---

## 6. `sec-default` 守门器 —— `src/builtins/sec-default.ts`

```ts
export function createSecDefaultPlugin(deps: { rules: readonly Rule[] }): Plugin;
```

坐 `prepend` 首位，只持有 `policyRules`（不持有个人规则）。文档对它的定位是"不制定任何策略，只维护组织既有控制面不被个人插件触及" —— 所以它读的规则**只来自 policy 源**，个人/项目/local/flag 里的同名规则永远不参与它的判定。

### 6.1 `tool.check` 算法

```
1. v1 = await next(e)                        // 跑完下面整条链
2. p  = evaluate(policyRules, e)
3. p 未命中                              → return v1        // 策略没意见，原样放行
4. !isLooser(p.decision, v1.decision)    → return v1        // 下游不比策略松，不插手
5. 否则                                  → ui.log 一条 heldNotice（点名规则原文）
                                           return { decision: p.decision, rule: p.rule }
6. 自己内部抛错（catch）                  → return { decision: 'deny', rule: UNCHECKED_DENY }
```

第 5 步的 `heldNotice` 是给人看的，形如：

```
[安全] 一条更宽松的判定被拦下：策略里 "Bash(git push:*)" 要求 deny，实际得到 allow。
       以托管策略为准。
```

第 6 步不是装饰。`dispatch.ts:100-111` 的故障隔离会把抛错的 hook **跳过并继续跑下层** —— `sec-default` 一旦自己炸了，它的保护会**无声消失**，而 `confirm` 会照常给出 `ask`。这是一条真实的 fail-open 通道：**守门器必须自己兜底成 deny，不能指望引擎替它兜。**

`UNCHECKED_DENY = 'sec-default: 检查未完成，按拒绝处理'`。

### 6.2 为什么是"持有"而不是文档里的"重放"

架构文档的做法是：先跑一遍，看 `next.trace` 里哪些 link 放宽了；若有，再 `next.to(e,'append')` **跳过 user 层重放一遍**；重放若给出一个命名为规则的 deny，就用它。

我们**持有**裁决而不重放，理由见 §11 偏差 1。要点是：持有比重放**更强** —— 少掉一段可能被插手的推导路。重放是在"引擎按调用者作用域重算裁决"的前提下为了重新推导；而我们直接把策略裁决拿在手里。

---

## 7. 失败行为表：每个判定路径都有明确去向

出口标准二是"每个判定路径都有明确的失败行为"。逐条钉死：

| 情形 | 行为 | 方向 |
|---|---|---|
| 某个规则文件不存在 | 那一层为空，**不报错**（绝大多数机器没有托管文件） | 正常 |
| 规则文件 JSON 语法错 / 顶层不是对象 | **点名警告 + 跳过该文件**，其余层照常 | 安全（少一层规则，但吼了） |
| `permissions` 值类型不对（不是数组 / 元素不是字符串） | 同上，点名到具体路径 | 安全 |
| 单条规则解析失败 | 警告（含原文与原因）+ **该条不生效** | ⚠️ 见下 |
| 其它工具带括号的规则 | 警告一次 + 不匹配 | ⚠️ 见下 |
| **托管策略文件存在但读不了 / 解析失败** | **大声警告 + policy 层为空**，`/permissions` 里标红 | ⚠️ **fail-open** |
| 托管策略文件不存在 | 静默为空 | 正常 |
| `permissions` 插件内部抛错 | dispatch 故障隔离跳过 → 落到 `confirm`，即 P1 行为 | 安全 |
| `sec-default` 内部抛错 | 自身 catch → `{ deny, rule: UNCHECKED_DENY }` | 安全 |
| 无任何规则命中 | 只读放行 / 写问 / 未知拒 —— 与 P1 **逐条一致** | 正常 |
| `tool.check` 走到链尾 | core 的 fail-closed deny（P1 原样） | 安全 |
| 非 TTY 环境要确认 | deny（P1 原样） | 安全 |
| `next.to` 目标不严格靠内 | 抛错 → 该 hook 被跳过 | 安全 |

两处 `⚠️` 需要显式说明：

- **单条规则解析失败 = 该条不生效**，这本身是"不收紧"的方向。所以不能安静 —— 必须在启动时警告、并在 `/permissions` 里逐条列出原文与原因。这是本轮**唯一**"坏了就等于没写"的地方，靠吼来兜。
- **托管策略文件坏了 = 回来时没有守护。** 这是本设计里**唯一一条真正的 fail-open**，且无法消除：策略文件按定义是可选的，不存在时静默是正确行为；存在却读不了时，"拒绝启动"对个人 CLI 是过度反应。折中是**大声警告 + `/permissions` 标红**，并在设计文档里记明。不做 `failIfUnavailable` 式的开关（YAGNI，见 §12）。

---

## 8. 可审计输出：`/permissions`

新增斜杠命令。既服务出口标准的手工验收，也是架构文档"给安全默认提供可审计的输出"的落地。输出四块：

```
权限来源（低 → 高）
  user      C:\Users\你\.deepcode\settings.json        3 条
  project   F:\项目\.deepcode\settings.json            不存在
  local     F:\项目\.deepcode\settings.local.json      1 条
  flag      --settings 未给
  policy    C:\Program Files\DeepCode\managed-settings.json   2 条  ← 托管

生效规则
  deny   Bash(git push:*)                    policy
  deny   WebSearch                           policy
  allow  Read                                user
  ask    Bash                                user

隐藏的工具（整工具 deny）
  WebSearch

有问题、未生效的规则
  Bash(git push*      ← 括号不配对，已忽略
```

没有问题时最后一块不出现。托管文件存在但坏掉时，`policy` 那一行以醒目文字打出原因。

实现住在 `cli/`，与 `createSessionCommands` 同理 —— 它要碰终端着色与设置快照，不是内建工具层的事。

---

## 9. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/contract/policy.ts` | **新增** | 规则类型、`parseRule`、`matchesRule`、`evaluate`、`LENIENCY`/`isLooser`/`stricter`。纯函数，零依赖 |
| `src/contract/events.ts` | 改 | `Result<'tool.describe'>` 加 `{ hidden: true }` 变体 |
| `src/contract/tier.ts` | 不变 | 五层与比较函数 P1 已到位 |
| `src/core/create.ts` | 改 | `seating` 表；`makeOn` 收 `Tier`；`plugin.register` 带座位 tier |
| `src/core/dispatch.ts` | 改 | `next.to` 目标收窄（不严格靠内即抛错） |
| `src/core/loop.ts` | 改 | `describeTools` 安静跳过 `hidden` 的描述 |
| `src/builtins/permissions.ts` | **新增** | 规则插件（`tool.check` + `tool.describe`），坐 `user` |
| `src/builtins/sec-default.ts` | **新增** | 守门器，坐 `prepend` |
| `src/cli/settings.ts` | **新增** | 五源解析 → `ResolvedPolicy` |
| `src/cli/permissions-command.ts` | **新增** | `/permissions` |
| `src/cli/args.ts` | 改 | `--settings=<路径>` |
| `src/cli/plugins.ts` | 改 | 返回 `{ plugins, seating }`，装配两个新插件 |
| `src/cli/main.ts` | 改 | 读设置、接线座位、`/permissions` 注入 |
| `README.md` | 改 | 新增「权限」一节；「安全」一节重写 |
| `docs/.../2026-10-11-deepcode-mvp-design.md` | 改 | §9.2 P2 列标注已完成与偏差；§10 记 P2 的偏差 |

---

## 10. 验收标准

一张表，端到端为主，单测钉住纯函数边界。

| # | 标准 | 验法 |
|---|---|---|
| 1 | **托管 deny 压过个人 allow** | 托管写 `deny:["Bash(git push:*)"]`、用户级写 `allow:["Bash"]` → `tool.check` 得 `{decision:'deny', rule:'Bash(git push:*)'}`。单测 + 真实二进制端到端各一遍 |
| 2 | **个人插件放宽不了** | 在 `user` 层放一个对 `Write` 直接返回 `allow` 的插件 → 策略 deny 仍赢；且 trace 不出现比调用者更靠外的层 |
| 3 | **`next.to` 只能向下** | 目标不严格靠内时抛错（`test/dispatch.test.ts` 现有用例扩充） |
| 4 | **token 边界** | `Bash(git push:*)` 匹配 `git push origin main`、不匹配 `git pushup`；`Bash(git push)` 只匹配精确串；空白折叠（`git  push` 也中） |
| 5 | **路径 glob** | `Read(~/.ssh/**)` 匹配 `~/.ssh/id_rsa` 与 `~/.ssh/a/b`，不匹配 `~/.sshx`（`~` 展开到 home） |
| 6 | **可见性** | `deny:["WebSearch"]` → WebSearch 从 `describeTools` 的结果里消失；`deny:["Bash(git push:*)"]` → Bash **仍在** |
| 7 | **五层来源** | 五个源各自可读、可缺；`--settings=<路径>` 生效；`/permissions` 打出五层与托管文件真实路径 |
| 8 | **fail-closed 未退化** | 无规则命中时，只读放行 / 写问 / 未知拒 与 P1 逐条一致；`sec-default` 内部抛错 → deny |
| 9 | **解析失败可见** | 坏规则在启动时警告、在 `/permissions` 里列出原文与原因，且不生效 |
| 10 | **与 P1 无回归** | `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿；既有 142 个用例**语义**一条不改（座位表默认 `builtin` 是为此），`cliPlugins` 的**调用形状**会变，改动集中在 `test/cli.test.ts` 一处 |

新增测试文件：`test/policy.test.ts`（纯匹配与优先级）、`test/settings.test.ts`（五源解析与坏输入）、`test/permissions.test.ts`（规则插件 + 座位 + 隐藏）、`test/sec-default.test.ts`（持有 + 失败行为）＋ `test/cli.test.ts` / `test/e2e.test.ts` 的接线用例。

---

## 11. 已知偏差与存疑

**刻意的偏差**（与架构文档不一致，且是有意为之）：

1. **不做 deny 重放。** 文档的机制是"跑一遍 → 看谁放宽了 → `next.to(e,'append')` 跳过 `user` 层重放 → 重放给出规则 deny 就用它"。它成立的前提是：裁决由引擎按调用者作用域**重新推导**，且 `settings.read` 本身是**可被 hook 的事件**（文档 D8）。我们没有这两个前提 —— 设置是启动期解析好的不可变数组，插件碰不到；`settings.read` 也不是事件。在这种情况下重放跑第二遍必然得到与第一遍相同的答案，是**装样子**。取而代之的是 `sec-default` 直接把策略裁决拿在手里（§6.1），这比重放更强：少一段可能被插手的推导路。
   文档 §9.3 出口标准原文里的"决策可重放"因此**未实现**，由 §1 的表格显式记录。

2. **`sec-default` 不读 `$.settings.read`，规则在启动期注入。** 文档里它有 op 与事件两个面、并用 `createPolicyMemo(500)` 做 500ms 记忆化，为的是管理员中途换策略能生效。个人 CLI 上这不是真实场景，启动期读一次更简单也更好测。见 §12。

3. **`tool.check` 的规则不由内核求值，而由插件求值。** 文档说 `next(e)` 的落点是"规则 + mode + 工具自检 + PreToolUse 判定"，即规则属于引擎裁决。我们把它放在插件里，因为 P1 已经确立了"内建工具与第三方插件走完全相同的接口，内核里没有硬编码的工具表"这条线；把权限规则塞回内核会破坏它。代价是 §5.1 那三条 `combine` 分支得靠注释与测试维持，而不是靠类型。

4. **不做 `PermissionUpdate`（`/allow` 式写回 settings）。** 见 §12。

5. **`/help` 不反映工具隐藏**（§5.2）。隐藏只作用于模型可见清单。

6. **策略层没有环境变量来源。** 见 §4.4。文档的 `SettingsSource` 五层里本来也没有 env 这一层，这条是一致的。

**存疑**（无法从仓库证实，实现时按本文取定，若日后拿到实据再改）：

1. **"按权限过滤工具可见性"的原始语义。** 架构文档没有正面描述它，只有 MVP 设计 §9.2 的一行表格。本文给出的"只有整工具 deny 才隐藏"是一个自洽且安全的取定，但**不是**从证据推出来的。
2. **`*` 与 `:*` 的精确差别。** 文档只有 `Bash(git push:*)` 这一个例子，没有文法定义。本文取"`:` 是 token 边界、`*` 是余下任意"（§3.3），能解释那个例子，但 `Bash(git push:*)` 与 `Bash(git push:)`、`Bash(git push*:*)` 的行为是推定的。
3. **多条规则同时命中谁赢。** 文档明确没写。`LENIENCY` 是 `sec-default` 用来判断"某一环有没有放宽"的度量，**不是**规则间的优先级规则；两者容易被混为一谈。本文的固定优先级是自定的。

---

## 12. 明确不做（YAGNI）

- **权限模式**（`acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`），以及 `permissions.disableBypassPermissionsMode`、`allowDangerouslySkipPermissions`。已定不做；`bypassPermissions` 与"谁加自动放行谁是开倒车"直接冲突。
- **deny 重放**（§11 偏差 1）。
- **`settings.read` 作为事件 / op**，以及策略文件热重载（500ms memo）。到 P3 的 mod 体系才有意义。
- **`plugin.register` 准入闸门** —— 现在 core 恒返回 `{ allow: true }`，P3 才换。
- **`allowManagedModsOnly` / `allowModsToOverrideDenyRules` / `prependPlugins`** —— 治理对象是 profile 与 mod，我们没有。
- **`PermissionUpdate` API**（把规则写回 settings 的 `/allow` 式入口）。这是本轮**最大的便利性缺口**：没有它，加一条 allow 规则得手改 JSON。如实记下，不假装。它需要一个自己的设计（写回哪一层？`local` 还是 `project`？与 `policy` 层的关系？），不适合塞进本轮。
- **沙箱**（含 `sandbox.*` 全部键）—— 排 P4。
- **MDM 落地**（plist / 注册表 / ADMX）—— 排 P5。本轮只做文件，路径与 `DEEPCODE_MANAGED_SETTINGS` 已为 P5 留好接口。
- **`/status` 式的完整来源自检** —— `/permissions` 只覆盖权限面。
