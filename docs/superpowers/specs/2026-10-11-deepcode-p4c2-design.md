# DeepCode —— P4c-2 治理设计（hookify DSL 与 `config.*` / `command.describe`）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 分组依据是 [`2026-10-11-deepcode-p4a-design.md`](2026-10-11-deepcode-p4a-design.md) §17，
> 同体例的先例是 [`2026-10-11-deepcode-p4c-design.md`](2026-10-11-deepcode-p4c-design.md)（P4c-1）。
>
> **本文把 P4c 剩下的两片合成一份**。P4c-1 的 §0 决策 1 说「这三样不共享代码也不共享数据，
> 一次 spec 装不下」，于是 marketplace 之后剩下 hookify 与 `config.*` 各排一轮 ——
> 那份拆分是本设计**有意推翻的**：两片加起来仍是一条「扩展面的外围」的边，
> 而且第二片（三个只声明未实现的事件）本来就小。理由与代价写在 §9 偏差 1。

**一句话**：把「分发」之后剩下的「治理」补齐 —— 让插件能把一份**声明式规则文件**变成一个
hook（hookify），再给事件目录补上三个一直被声明、从来没实现过的格子
（`command.describe`、`config.describe`、`config.set`）。

---

## 0. 决策摘要

1. **hookify 是插件，不是内核语法。** 参考实现里 `plugins/hookify/` 是一个普通插件：
   它的 `hooks.json` 挂四个 classic `command` 型钩子，脚本在运行时去读用户写的规则文件。
   参考笔记自己的结论就是这条 ——「协议做小做稳，**DSL 做成插件**」
   （`claude-code-架构分析/00-overview.md:100`）、「把 DSL 建成插件：hookify 证明…可行」
   （同目录 `07-hooks-system.md:460`）。所以本片**不动 `src/core/`**，也不给
   `hooks.json` 加新 `type`；hookify 是一个 `plugins/hookify/` 目录。
   这恰好是 P3 出口标准（「一个不改引擎的插件能扩展出新能力」）的第二次行使，
   而且比 `plugins/todo` 更贴题目：todo 加的是一个工具，hookify 加的是一种**写 hook 的方式**。

2. **规则文件放项目级，只放项目级**：`<工作目录>/.deepcode/hookify.*.local.md`。
   参考实现用 `.claude/hookify.*.local.md`（`07-hooks-system.md:421`），同样是「本地、不进仓库」的
   命名。不加用户级：P4c-1 刚吃过一次教训 —— 一个来源要么有明确的消费者，要么别加
   （那次的 `enableByUser` 是**必须**加的，因为落点没有别的来源；这里不是）。

3. **DSL 是 frontmatter + 正文，刻意扁平**。参考实现的规则文件是 YAML frontmatter +
   Markdown 正文，条件写在 frontmatter 的 `conditions` 里，有六种 operator
   （`07-hooks-system.md:497-503`）—— 但**那些 operator 的名字与形状笔记里没有摘录**，
   语法的权威文档在参考实现自己的 `writing-rules/SKILL.md` 里，不在我们手上。
   所以我们**自己定一套小的**，而不是抄一份看不懂的：frontmatter 里每条规则一层平铺的
   `key: value`（没有嵌套数组），够表达「哪个字段、什么算子、什么模式、怎么处置」。
   手写 frontmatter 解析器在参考实现里也有先例（`config_loader.py:87-195`），
   而且我们零运行时依赖，引 YAML 库是加依赖。

4. **判定词汇只有 `deny` 与 `ask`，表达不出 `allow`。** 与「第三方插件只能拧紧不能拧松」同一条
   （`src/core/third-party.ts:83-95` 会把 `allow` 剥掉）。写 `decision: allow` 是**错误**，
   按 §4 的方向处理并点名，而不是静默当没看见 —— 静默把它当 `ask` 会让写规则的人以为放行成功了。

5. **失败方向是 fail-closed，这是对参考实现的一处有意偏离。** 参考的 hookify 在
   `finally: sys.exit(0)` 里**永远退出 0**，注释写着「ALWAYS exit 0 - never block operations
   due to hook errors」（`07-hooks-system.md:436`）—— 那是 fail-open：一条写坏的 deny 规则
   会静默失效。我们不抄。规则文件读不懂 / JSON 坏 / operator 不认识 / 正则非法 → 脚本
   退出非零，而我们的 `classify` 把非零一律翻成 **deny**（`src/cli/hook-run.ts:193-195`）。
   代价写在 §9 偏差 2：一个坏文件会挡住所有 Write/Edit/Bash，直到你修它或卸掉 hookify。

6. **`config.set` 能写的键只有一个：`model`。** `apiKey` 是凭据，`baseUrl` 决定你的请求发去哪 ——
   这两个由一条命令替你写，是可以安静地把流量端掉的。想让它们改，自己开文件看了一眼再改。
   这一条不是洁癖：`~/.deepcode/config.json` 里本来就可能躺着 apiKey（`src/cli/config.ts:159-164`
   就在为「key 进了文件」告警），一条 `config set baseUrl https://…` 比手改文件少了一次注视。

7. **`config.set` 只写用户级 `~/.deepcode/config.json`，且永远不碰 settings。**
   权限 / 沙箱 / `plugins.enable` 是另一套文件、另一套层（`src/cli/settings.ts`）。
   一个能在运行时改权限判定来源的入口就是第二个「自动放行开关」——
   「谁加自动放行开关谁就是在开倒车」。写着 `permissions.*` / `sandbox.*` / `plugins.*`
   的键一律**拒绝并点名**（不是静默忽略）。

8. **`config.describe` 会把 `apiKey` 打码。** 它是给人看的清单，不是给日志看的。
   打码规则：非空则 `前 6 位…（共 N 位）`，空则显式说「没配」——「没配」与「配了但打码」
   必须看得出区别，否则你会对着一个空字符串猜半天。

9. **`command.describe` 与 `tool.describe` 同形**（`src/contract/events.ts:40`、`:90`），
   补上 `command.run` 缺的那一半。消费方是 `/help`：今天它只打名字
   （`src/builtins/commands.ts:19-30`，列表来自 `$.command.list()`），之后打「名字 + 一句话」。
   **每条已注册的命令都必须能自述**：缺 describe 是故障，`/help` 会 warn 并退回裸名字
   —— 与 `describeTools` 里那条「没注册描述是故障，要 warn」同一条分寸
   （`src/core/loop.ts:292-294`）。核心实现**抛**，由消费方兜底，形状与 `tool.describe` 一致
   （`src/core/create.ts:90-92`）。

10. **三个事件转正，计数要跟着动**：已声明 39 / 已实现 16 → **39 / 19**，未实现 23 → **20**。
    README、`docs/项目简介.md`、`site/index.html`、`test/dispatch.test.ts:392-401` 的那句注释
    里都有这几个数，必须一起改（P4c-1 收口时漏过一处同类问题，见那份计划的对照表）。

11. **不引网络、不引依赖、不加 `--force`、不加自动放行** —— 与前面每一片同。

---

## 1. 出口标准怎么落

MVP §9.4 的 P4 行出口标准是「`agents/*.md` 子代理能被 `description` 正确路由，工具白名单生效」，
由 P4a 兑现。P4c 没有自己的出口标准行（P4c-1 §1 已如实记过一句）。
所以本片的验收标准是自定的，沿用 P4c-1 的两检查点体例：

- **C1（纯单元 / 纯函数）**：hookify 的规则解析与求值、`config` 的键白名单与打码、
  `command.describe` 的兜底。批量跑。
- **C2（端到端）**：真起 hookify 的钩子进程，用一份真规则文件把一次真 Write 拦下来；
  `deepcode config set model …` 真落盘再被下一次 `loadConfig` 读回。

---

## 2. hookify 的形状

一个插件目录，三样东西：

```
plugins/hookify/
  plugin.json           { name: "hookify", uses: ["tool.check"], hooks: "./hooks/hooks.json" }
  hooks/hooks.json      PreToolUse，**不带 matcher**，一个 command 型 HookDef
  hooks/pretooluse.mjs  stdin JSON → 读规则 → 求值 → stdout JSON / 退出码
  core/rules.mjs        纯逻辑：解析、装载、求值（无 IO，可被单独 spawn 测）
  README.md             规则语法说明（人看的权威文档）
```

**为什么 `hooks.json` 不带 matcher**：参考实现就是这样（`07-hooks-system.md:147`
「无 matcher 的组（如 hookify 的 hooks.json）对所有工具生效，再由脚本内部按 `tool_name` 分流」）。
我们的 matcher 是浅比较（`src/core/registry.ts:31-37`），一个规则文件里的规则可以各自面向不同工具；
挂 `Write|Edit` 会让「一条面向 Bash 的规则」直接不生效，而用户看不出为什么。

**脚本读的东西**：`hook-run.ts` 喂的 stdin JSON（`src/cli/classic-hooks.ts:54-64`）里，
`cwd` 是会话根 —— 规则目录从它拼，不从 `process.cwd()` 拼（钩子进程的 cwd 不保证是会话根）。

**脚本吐的东西**：与 `plugins/secret-guard/scan.mjs` 同一套语言 —— 命中就
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
"permissionDecisionReason":…}}` **或** `exit 2` + stderr。两种都认（`src/cli/hook-run.ts:187-222`、
`src/cli/classic-hooks.ts:75-80`）。我们**选 stdout JSON**：理由与参考实现一样
（`07-hooks-system.md:430`「hookify 的引擎即按事件切换两种格式」），而且 `deny` 与 `ask`
都能表达 —— `exit 2` 只能表达 deny。`ask` 是有用的：「这条规则想问一句」比「一律拒绝」常见。

⚠️ **理由的字段名是 `permissionDecisionReason`，不是参考实现的 `systemMessage`**
（`src/cli/hook-run.ts:219` 读的是前者，后者被静默忽略）。照参考实现抄会得到一个
「拦下了但一句话不说」的钩子 —— 正是本设计 §4 想避免的那类沉默。

⚠️ **顺带修一处潜伏的缺陷**：`src/cli/classic-hooks.ts:73` 会把钩子的 stdout **原样回显**
给用户（`$.ui.log('[钩子 …] ' + said)`）。今天没有钩子走 JSON 判定那条路
（`secret-guard` 用 `exit 2` + stderr，stdout 是空的），所以它一直没咬人。
hookify 是第一个走它的 —— 用户会看到一行生 JSON 被当成"钩子说的话"打出来。
修法：只有当 `classify` 说「没意见」（`kind === 'silent'`）时才回显；
带判定的 JSON 是协议，不是给人看的话。这一处要单独一条用例。

---

## 3. 规则语法

**一份文件一条规则**，正文加一个 YAML-ish frontmatter。多重性由文件名给
（`hookify.no-keys.local.md`、`hookify.no-force-push.local.md`…），不在一份文件里塞多条 ——
后者要让解析器去切 `---`，而正文里一个 Markdown 分隔线就能把文件劈成两半。
参考实现也是「一个主题一个文件」（`07-hooks-system.md:421`）。

```markdown
---
name: no-aws-keys
tool: Write|Edit
field: content
operator: matches
pattern: AKIA[0-9A-Z]{16}
decision: deny
message: 文件里出现了形似 AWS access key 的东西
---

（这段正文可选，会接在 message 后面一起作为拒绝理由给你看。）
```

### 3.1 frontmatter 字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 规则名。出现在拒绝理由里 |
| `tool` | 否 | 工具 matcher，语法与 `hooks.json` 的 matcher 同一套：精确名 / `A|B` / `*` / 省略=全部（`src/contract/classic.ts:138-148`） |
| `field` | 是 | 取 `tool_input` 里的哪个键当被检文本 |
| `operator` | 是 | 见 3.3 |
| `pattern` | 是 | 算子右边的操作数 |
| `decision` | 否 | `deny`（默认）或 `ask` |
| `message` | 是 | 一句话，进拒绝理由 |

其余键**点名告警并跳过整条规则**（不是整份文件）—— 与 `hooks.json` 的 W2 同一条分寸
（`src/contract/plugin-manifest.ts:432`：未识别字段点名，不是静默忽略）。
缺必填字段 → 见 §4（错误方向）。

### 3.2 `field` 怎么取

`field` 就是 `tool_input` 的键名，逐工具如此（与 `plugins/secret-guard/scan.mjs:30-45`
读 `.content` / `.new_string` 是同一件事，只是那边写死在脚本里）：

| 工具 | 常见 field |
| --- | --- |
| `Write` | `file_path`、`content` |
| `Edit` | `file_path`、`old_string`、`new_string` |
| `Bash` | `command` |
| `Read` / `Glob` / `Grep` | `file_path` / `path` / `pattern` |

取值规则：**只取字符串**。键不存在、或是数组 / 对象 → **这条规则不匹配**（不是错误）。
不做「把整个 input 序列化后搜」那种兜底 —— 它会让 `field` 这个字段失去意义，
而失去意义的字段比没有这个字段更坏。

### 3.3 operator

五种，每种一行代码：

| operator | 语义 |
| --- | --- |
| `matches` | 正则（`new RegExp(pattern)`，**不**加 `g`，避免 `lastIndex` 状态） |
| `contains` | 子串 |
| `equals` | 全等 |
| `starts_with` | 前缀 |
| `ends_with` | 后缀 |

不认识的 operator → 错误（§4）。`matches` 的 `pattern` 编译失败 → 错误（§4）。
正则本身是用户写的、对本机自己的输入求值，不构成边界；写一个会跑很久的正则的代价，
由钩子超时兜底（10 秒 → deny，`src/cli/hook-run.ts:145-154`）。

### 3.4 多条规则怎么合

所有规则文件之间：**全部求值，收集所有命中的**。
命中里只要有 `deny` 就是 `deny`；否则只要有 `ask` 就是 `ask`；都没有就是放行（退出 0）。
理由串成多行，每条一行 `[规则名] message`，正文接在后面 —— 与参考实现的
`"\n\n".join(messages)`（`07-hooks-system.md:309-336`）同形。
文件按名字排序装载，保证同样的输入给出同样的判定顺序。

---

## 4. hookify 的失败方向（对参考实现的有意偏离）

参考实现：任何错误都 `exit 0`（`07-hooks-system.md:436`），fail-open。
本设计：**任何脚本自己出的错 → 退出非零 → 框架翻成 deny**。逐条说清哪些算错：

| 情形 | 处置 | 为什么 |
| --- | --- | --- |
| 没有规则文件 | 退出 0 | 常态，不是错 |
| 规则文件读不动（权限 / IO） | **错** | 读不动 ≠ 没有；可能正是一条 deny 规则在读不动 |
| frontmatter 不闭合 / 无 `name` | **错** | 无法判定这条规则本意是什么 |
| `operator` / `field` / `pattern` / `message` 缺失 | **错** | 同上 |
| `operator` 不认识 | **错** | 一条看不懂的规则被跳过 = 静默失效 |
| `pattern` 正则非法（`matches`） | **错** | 同上 |
| `decision` 不是 `deny`/`ask` | **错**，理由里点名这一条 | 说得出「你写的 `allow` 表达不出来」，比静默当 `ask` 好 |
| 未知 frontmatter 字段 | 告警 + 跳过**这条规则** | 这一点是收窄：未知字段不影响这条规则自己的判定 |
| `tool_input` 里没有那个 `field` | 不匹配，正常继续 | §3.2 |

一句话：**「这条规则到底想干什么」说不清楚时，就 deny。** 说清楚了但这条规则自己不认识某个
周边字段时，只跳过这条规则。这条例外是必要的，否则给 frontmatter 加一个新字段（比如将来的
`event`）会让所有规则全变成 deny —— 一个不许演进的格式等于一个死格式。

代价（写进 §9 偏差 2）：一个坏文件挡住所有 Write/Edit/Bash。退出手段是修文件、
删文件、或者 `plugin remove hookify`。这与 `secret-guard` 的 `exit(1)`（读不懂 JSON 就 deny，
`plugins/secret-guard/scan.mjs:16-22`）是同一条分寸。

---

## 5. `config.describe` 与 `config.set`

### 5.1 事件契约

```ts
'config.describe': Record<string, never>;
'config.set': { readonly key: string; readonly value: string };
```

结果：

```ts
'config.describe': { readonly entries: readonly ConfigEntry[] };
'config.set': { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
```

```ts
type ConfigEntry = {
  readonly key: string;
  readonly value: string;      // 已经打码 / 已格式化的**给人看**的值
  readonly source: 'env' | 'user' | 'project' | 'default';
  readonly writable: boolean;
};
```

`source` 直接复用 `resolveSettings` 的语义（`src/cli/config.ts:78-96`）：
环境变量盖过文件。一个键同时来自环境与文件时，报 `env` 并**不**把文件里的值也列一遍 ——
那正是 `resolveSettings` 那条告警要防的「你以为配置生效了」（`src/cli/config.ts:56-63`）。

### 5.2 可写白名单：只有 `model`

| 键 | 可写 | 为什么 |
| --- | --- | --- |
| `model` | **是** | 切换模型是最常见的真实需求，且它不改变「谁收到你的数据」 |
| `baseUrl` | 否 | 它决定请求发去哪。一条命令替你改这个，可以安静地把端点换成别处 |
| `apiKey` | 否 | 凭据。经由一条命令写进盘，等于让它在 shell 历史里留一份 |
| `provider` / `debug` | 否 | 不是本轮的需求；加进来是给白名单充电，不是给它用处 |

拒绝时的 `error` 要说清是哪一个原因（不在白名单 / 是安全相关），而且**点名那三个前缀**。

### 5.3 `config.set` 的落盘

- **只写用户级** `~/.deepcode/config.json`（`src/cli/config.ts:148`）。不写项目级：
  项目级那个文件是仓库的，写它正是「key 跟着仓库走」那条路
  （`src/cli/config.ts:159-164` 正在为它告警）。
- **读-改-写**：先 `loadConfig` 那一层读出来（保留其它键），合并这一个键，再写回。
  不留一个「只写了 model、把 apiKey 抹了」的出口。
- **原子**：写 `config.json.tmp` 再 `rename` —— 与 P4c-1 的落盘同一条（那份设计 §5）。
  一次中断留下的是半个 JSON，而 `parseLayer` 会把它当**坏文件**抛
  （`src/cli/config.ts:178-182`）—— 那时你的配置就全都读不出来了。
- **权限 0600**（新建时）：这个文件里可能有 apiKey。与转写文件同一条分寸。
  已存在则不改动它的 mode（不是我们的东西就别动）。
- 值先过 `assertModelShape`（`src/cli/config.ts:115-122`）：空、含空白 → 拒绝。

### 5.4 谁答这两个事件

新文件 **`src/cli/config-command.ts`**，一个插件（`Plugin`），deps 收 `{ home, root, warn }`。
住在 `cli/` 不住 `builtins/` 的理由与 `src/cli/commands.ts:14-19` 一字不差：
它要读盘（`loadConfig`），而 `builtins/` 只许 import `contract/`
（`scripts/check-boundaries.mjs`）。

它同时注册三样：
- `config.describe` → §5.1 的清单
- `config.set` → §5.2 / §5.3
- `command.run { name: 'config' }` → 在 REPL 里打同一份清单，并提示 `deepcode config set …`

于是这两个事件有**两个**消费者（CLI 子命令与 `/config`），不是摆设。

### 5.5 CLI 子命令

`deepcode config list` / `deepcode config set <key> <value>`，形状照 `plugin` 那一套
（`src/cli/args.ts:87-94` 的 `parsePluginCommand` 是模板）。子命令**派发事件**、不直接调 `loadConfig`
—— 否则事件是假的（一个没有消费者的钩子点，与摆设断言是同一个毛病）。

---

## 6. `command.describe`

```ts
'command.describe': { readonly name: string };
'command.describe': { readonly description: string; readonly usage?: string } | { readonly hidden: true };
```

- **核心实现抛**（`no description registered for command: X`），形状与 `tool.describe` 一致
  （`src/core/create.ts:88-92`）。
- **消费方 `/help` 兜底**：逐条 try/catch，抛了就打裸名字并 warn 一行。命令清单仍然来自
  `$.command.list()`（`src/core/nouns/index.ts:67`），不硬编。
- 六条已注册命令各加一个 `on('command.describe', { name }, …)`：`exit` / `help`
  （`src/builtins/commands.ts`）、`diff` / `clear` / `compact`（`src/cli/commands.ts`）、
  `permissions`（`src/cli/permissions-command.ts`）。
- `hidden: true` 留给将来（整命令隐藏）；本轮没有任何命令用它，但结果类型里留着它与
  `tool.describe` 对称。

`/help` 的输出从「一行名字列表」变成「一行一条 `/名字  一句话`」——
这是本轮唯一一处**改用户看得见的行为**的地方，端到端测试要更新。

---

## 7. 事件目录的计数变化

`src/contract/events.ts:152-167` 的 `UnimplementedEvent` 里移出 `command.describe`、
`config.set`、`config.describe`，加进 `EventArgs` / `EventResult`：

| | 之前 | 之后 |
| --- | --- | --- |
| 已声明 | 39 | 39 |
| 已实现 | 16 | **19** |
| 未实现（抛 `NotImplementedError`） | 23 | **20** |

要跟着改的地方（`grep` 得到，逐个核）：
- `test/dispatch.test.ts:280-285`、`:392-401`（点名 `config.set` 的那两条 —— 换成仍然
  未实现的事件，语义一字不变）、`:438-447`
- `README.md` 与 `docs/项目简介.md` 的「39 个已声明，16 个已实现」
- `site/index.html:72`（`16/39`）以及讲事件诚实标注的那张卡
- `src/contract/events.ts` 里 `NotImplementedError` 那两句注释里的数

---

## 8. 验收标准

### C1：纯单元 / 纯函数（批量）

| 检查 | 阈值 |
| --- | --- |
| `pnpm typecheck` | 无错 |
| `pnpm lint` | 依赖边界 + 工作流硬化双绿 |
| hookify 规则解析：好文件 / 缺 `name` / frontmatter 不闭合 / 未知字段 / 五种 operator 各一条 | 各一条用例 |
| hookify 求值：deny 胜 ask / 多文件合并 / `tool` matcher `A|B` / field 不存在 → 不匹配 / 非字符串 field → 不匹配 | 各一条用例 |
| config 键白名单：`model` 可写、`baseUrl`/`apiKey`/`permissions.*`/`sandbox.*`/`plugins.*` 各被拒并点名 | 逐条 |
| apiKey 打码：非空 → 前缀 + 位数；空 → 显式「没配」；两者输出不同 | 三条 |
| `command.describe` 兜底：某命令没注册 describe 时 `/help` 不炸、打裸名、warn 一行 | 一条 |
| 现有测试全绿 | 至少不回退（基线 41 文件 / 658 用例） |

### C2：端到端

| 检查 | 怎么验 |
| --- | --- |
| 真规则文件拦下真 Write | 临时工程里放 `.deepcode/hookify.no-keys.local.md`，走真链路跑一次 Write，断 deny 且理由里有规则名 |
| `ask` 规则 | 同一装置换成 `decision: ask`，断进的是确认框那条路（非 deny） |
| 坏规则文件 → deny | 一份 frontmatter 不闭合的文件，断言不是「静默放行」 |
| `decision: allow` → deny 且点名 | 断言理由里说出 `allow` 表达不出来 |
| `config set model` 真落盘并被下次读回 | 真跑 bin，再 `loadConfig` 断言 |
| `config set baseUrl …` 被拒 | 断言退出码非零、点名、**文件没被动** |
| `config set` 不碰 settings | 断言 `~/.deepcode/settings.json` 不存在或未被改 |
| 零密钥 | 四条 API 环境变量全清 |
| 计数 | 39 / 19 / 20 三处数字与文档一致 |

---

## 9. 已知偏差与存疑

1. **推翻了 P4c-1 §0 决策 1 的拆分**。那份设计说两片「不共享代码也不共享数据，一次 spec 装不下」。
   前一半成立（确实不共享），后一半不成立：hookify 是一个插件目录、`config.*` 是一个
   `cli/` 侧插件加一条 CLI 子命令、`command.describe` 是给六条命令各补一个 handler ——
   三样加起来仍是一条边。**加这一片不是为了省事，是因为拆开之后第二片会小到撑不起一份
   独立设计的体例**。阶段名「分发与治理」到本片结束时才算兑现完。
2. **hookify 的失败方向会挡住一切**（§4）。一个手写坏的文件让所有改盘工具 deny，
   直到修文件或卸插件。这是 fail-closed 的代价，与整个项目的地板同一条；写在这里是因为
   它是本片**最可能被用户抱怨**的一处。
3. **我们自己定了 DSL 的语法**（§3），不是抄参考实现 —— 因为那六种 operator 的名字与形状
   不在我们手上（只有「有六种」这条索引信息，`07-hooks-system.md:497-503`）。
   我们的五种是**猜的**，先能用、可加。这与 P4c-1 砍 `category` 字段是同一条：
   可在后面加回来，先加后删不是。
4. **`field` 只取字符串**（§3.2）。数组 / 对象字段不匹配。代价是表达不了
   「Write 的内容里有任何一个元素匹配」，收益是 `field` 这个词不失去意义。
5. **`config.set` 只认 `model`**（§5.2）。这是本片最保守的一处，也可能最容易被要求放宽。
   放宽它之前请先读 §0 决策 6：`baseUrl` 可写等于一条安静改写流量去向的命令。
6. **`command.describe` 改了 `/help` 的输出形状**。既有测试会红，这是**预期**的红（C2 里点名验）。
7. **存疑：hookify 要不要支持 `PostToolUse` / `Stop` / `UserPromptSubmit`。**
   参考实现挂这四个事件（`07-hooks-system.md:82`），我们只桥了三个引擎钩子点，
   且 `tool.check` 之外的两个（`session.start` / `session.end`）是纯通知、拦不住东西
   （`src/contract/classic.ts:68-72`）。本轮 hookify **只挂 `PreToolUse`**：一个拦不住的
   hookify 规则是骗人的。要支持其余三个事件，得先有 `tool.result` 与一条能携带文本的通道
   —— 那是 P4d 的 `prompt.*` 与事件目录的活。

---

## 10. 明确不做

- **不改 `src/core/`**：hookify 不进内核（决策 1）。这是本片最硬的一条边界。
- **不给 `hooks.json` 加新 `type`**：`prompt` 型仍然只 W4 告警
  （`src/contract/plugin-manifest.ts:436`）。
- **不做用户级规则文件**（决策 2）。
- **不做规则文件的热重载**：钩子每次调用都重读规则，本来就「无需重启」
  （参考实现 `07-hooks-system.md:38`）—— 这不叫功能，是这条架构的副产品。
- **不做 `if`（工具命令前缀匹配）、`asyncRewake` 一族**：P3 已明确不做
  （`2026-10-11-deepcode-p3-design.md:602-612`）。
- **不让 `config.set` 碰权限 / 沙箱 / 插件名单**（决策 7）。
- **不做 `config.set` 的项目级落点**（§5.3）。
- **不做 `config` 的交互式编辑器 / `config get <key>` 单键查询**：`list` 已经够用，
  单键查询是 `list | grep`。

---

## 11. 关键文件索引

**要新建**

- `plugins/hookify/plugin.json`、`plugins/hookify/hooks/hooks.json`
- `plugins/hookify/hooks/pretooluse.mjs`（IO + stdin/stdout 协议）
- `plugins/hookify/core/rules.mjs`（纯逻辑：frontmatter 解析 + 求值）
- `plugins/hookify/README.md`（规则语法的人读版本）
- `src/cli/config-command.ts`（插件：`config.describe` / `config.set` / `/config`）
- `test/hookify.test.ts`、`test/config-command.test.ts`、`test/command-describe.test.ts`
- 夹具：`.deepcode/hookify.*.local.md` 的临时树

**要改**

- `src/contract/events.ts` —— 三个事件从 `UnimplementedEvent` 移进 `EventArgs` / `EventResult`（:152-172、:36-46、:86-96）；注释里的计数
- `src/core/create.ts` —— `coreImpls` 加 `command.describe`（抛）、`config.describe` 与
  `config.set` 的兜底（不回话 / 报错）
- `src/builtins/commands.ts` —— `exit` / `help` 的 describe；`/help` 改打「名字 + 一句话」
- `src/cli/commands.ts` —— `diff` / `clear` / `compact` 的 describe
- `src/cli/permissions-command.ts` —— `permissions` 的 describe
- `src/cli/args.ts` —— `config` 子命令（照 `parsePluginCommand` 的体例）
- `src/cli/main.ts` —— 装配 `config-command` 插件、派发 `config list/set`
- `src/cli/config.ts` —— 可写白名单、打码、读-改-写落盘（`assertModelShape` 复用）
- `src/cli/plugins.ts` —— 把 `config-command` 装进转盘
- `src/cli/classic-hooks.ts:73` —— stdout 只在「没意见」时回显（§2 的潜伏缺陷）
- `test/classic-hooks.test.ts` —— 上面那一条的用例
- `test/dispatch.test.ts` —— 点名 `config.set` 的三处换成仍未实现的事件
- `test/cli.test.ts` —— `config list/set` 的端到端
- `test/plugin-e2e.test.ts` —— hookify 真拦一次
- `README.md`、`docs/项目简介.md`、`site/index.html` —— 事件计数、插件一节加 hookify
