# DeepCode P9 工具清单设计

> 对标 `claude-code-架构分析/13-tool-system.md`。复刻对象的事实、依据与版本锚点都在那一份里，
> 本文**不重述**，只写"我们缺什么、改什么、为什么、怎么验"。
>
> 一句话口径：**工具只有一份清单，但它有三个消费者，而今天其中两个看到的不是同一份。**
> 模型看的是 `tool.describe` 过滤后的结果，`/help` 看的是注册面的原始名字，`/context` 干脆
> 一个字都没算。这一阶段把三处收敛到**一个函数**，并让账本把工具算进合计。

---

## 1. 出口标准（可验证，四条）

1. **账本把工具算上**：`/context` 多一行「工具清单」，且 `合计 = 系统提示 + 工具清单 + 会话消息`
   —— 三个数都按同一种估法（`estimateTokens(chars)`，chars 是 4 字符 1 token 的粗估）。
2. **一份清单三个消费者**：模型拿到的 `ToolSpec[]`、`/help` 列的工具、`/tools` 列的工具
   **全部出自同一个函数**（`core/tool-list.ts` 的 `listTools`）。`loop.ts` 里不再有第二份实现。
3. **隐身与故障在用户侧也分得开**：不进模型可见清单的工具，`/tools` 逐个说明原因
   （「不在本次的工具清单里」/「被权限规则隐藏」/「没有注册描述 —— 故障」），不静默少一块。
4. **来源可见**：`/tools` 每一行都标出这个工具**是谁注册的**（`$.tool.origin`），
   内建与第三方插件在这一行上分得出来。

任务级验收只跑 `pnpm typecheck`；测试按检查点批量做（用户长期指令：一次校验多个任务）。

---

## 2. 与复刻对象的差异

`13-tool-system.md` 的 A–G 七组抽象逐条对我们：

| 它的做法 | 我们**已有** | 差距 → 本阶段怎么办 |
| --- | --- | --- |
| 定义面只有 `{name, description, inputSchema?}`，**没有策略旗标**（A1） | 同构：`ToolSpec` 只有这三个字段（`contract/model-provider.ts`），`readOnly` / `destructive` 这类自述一个都没有 —— 谁写谁就能撒谎，判据在别处 | **不是差距，是同构**。写进 §4 当"刻意不追"的第一条 |
| 无磁盘注册表：内建在二进制里，插件 `$.tool.register`，MCP 服务器（A1 定义面极薄） | 同构：`tool.list()` = 注册面上 `tool.call` 的 matcher 取值（`core/nouns/index.ts:66`），内核里没有硬编码工具表 | 已有。**不追**：磁盘注册表（marketplace）是 P5 之后的事 |
| `mcp__<server>__<tool>` 命名空间，三个来源共用（A2） | 没有命名空间，也没有 MCP 客户端 | **不追**（§4）：没有第二、第三个来源，命名空间现在没有对象 |
| `ToolInfo = {name, description, mcp}`：清单带来源标志（A3） | `tool.list()` 只返回**名字**。谁注册的，用户在哪儿都看不到 | **缺口（加法）** → §3.4 |
| 信任锚在 `source` 上，不在名字或前缀上（A3） | 同构且更强：第三方插件被**强制 append 座位**（`core/create.ts`），内建在它外面先应答，插件**盖不住**内建；`allow` 一律被丢弃 | 已有。这一条是"我们的结构比它更省事"的地方，写进 §2.2 |
| 生命周期四动词 `list` / `describe` / `call` / `check`，`tool.describe` 是**模型可见面**（A4） | 四个都有（`events.ts`）。但我们**没有**"模型可见面"这个概念的单一出口：`describeTools` 是 `loop.ts` 的私有函数 | **缺口** → §3.1 |
| `tool.describe` **每会话一次**并缓存，`$.ui.invalidate` 才失效（A4） | 每轮重算（`loop.ts:90`），没有缓存 | **不追**（§4）：与 P7 已记档的偏差同一条 —— 我们不主动管 prompt cache |
| 四层收窄（AgentSpec 白名单 / `disallowedTools` / skill `allowed-tools` / settings+CLI 旗标），"在列表里 ≠ 能跑"（A5） | 两层：`AgentSpec.tools`（两个落点：看不见 + 够不着）、`tool.describe` 的 `hidden`（权限规则整工具 deny） | 两层够用。**不追** CLI 旗标（§4）；但"在列表里 ≠ 能跑"这句话正好点中我们的一个真洞 → §2.1 探针 2 |
| 权限是链上的一次判定，`$.tool.check` 是**干跑入口**（A6） | 同构：`tool.check` 就是那条链，`confirmPlugin` 三个名字集 + 其余一律 deny | 已有。**不追** `rule?` 之外的字段 |
| 只读性是**每次调用**的属性（`ls` vs `rm -rf` 都是 Bash），未文档化，消费者必须一律当写（A6） | 我们**默认就是**"一律当写"：`MUTATING_TOOLS = {Write, Edit, Bash}`，三个都弹 y/N | **不是差距，是它推荐的那个默认**。**不追**（§4） |
| ToolSearch / 延迟加载：阈值 = 窗口的 10%，`defer_loading=false` 至少一个（A7） | 没有 | **不追**（§4）：6 个工具、工具部分约 437 token（§2.1 实测），延迟加载是给几十上百个工具准备的 |
| `consent` 建模成**一个人轮**，不是布尔；`allow` 可带 `updatedInput` / `updatedPermissions` 与四档落点（A6） | 同步 `y/N`（`$.ui.ask`），没有并行批次，没有"记住这个决定" | **不追**（§4）：后者会**放宽权限**，是我们刻意关掉的那条路 |
| 一批工具调一次 `PostToolBatch`（16 启示） | 工具串行、结果合成一条消息；`tool.result` 逐工具派一次 | **不追**（§4）：没有批次，也就没有"批次级"这个缝 |
| 没有 `category` / `group` 原语，分组 = 名字前缀或插件局部常量（16 启示） | 同构：`coreTools` 是硬编码清单，插件自己管自己的名字 | **不追**：同上，且有先例（`builtins/tools/index.ts:9` 的注释已经说了 P3 会取代它） |

**我们真正要做的只有三件事**：工具清单的单一来源（$3.1）、账本把工具算上（§3.2）、
来源可见 + 用户侧的一份 `/tools`（§3.3/§3.4）。剩下 12 条逐条在 §4 有理由 —— **别把它们当待办**。

### 2.1 两个已经实测出来的洞（不是读代码猜的）

写这份设计之前，先拿两个探针在真 `createEngine` + 真 `runTurn` 上跑了一遍
（`test/probe-p9.test.ts`，用完就删，结论记在这里）。

**探针 1 —— 账本漏掉了工具清单。**

```
请求里带了几个工具： 6  Read,Write,Edit,Bash,Glob,Grep
工具部分字符数： 1748 → 约 437 token
账本：
  系统提示　10 token —— base 10
  会话消息　1 token（2 条）
  合计　　　11 token          ← 这一轮真的发出去的是约 448 token
```

`/context` 的三条口径里第三条是「**账要对得上**：逐节之和 = 系统提示那一行，
系统提示 + 消息 = 合计。对不上说明有东西没被算进去 —— 那是账本算错，不是显示问题。」
（`cli/context-view.ts:22-23`）。**它自己违反了这条**：`合计` 只算了两样，
而每次请求的第三个大件（工具清单）从来没进过账本。上面这组数里，工具占了真实请求的
**97.5%**，而账本报的 `合计` 连真实值的 2.5% 都不到。

这不是显示问题，是账本算错 —— 而且错的方向很坏：`合计` 与 `上次实测` 摆在一起比较，
正是用户判断"离阈值还有多远"的唯一依据。工具越多，这个比较越不可比。

**探针 2 —— `/help` 会列出模型看不见的工具。**

```
tool.list()： Read Write Edit Bash Glob Grep Ghost
模型实际拿到： Read Write Edit Bash Glob Grep
```

`/help` 打的是 `$.tool.list()`（`cli/commands.ts:180`），也就是**注册面**。
而模型看到的那一份还要过两道：`hidden`（权限规则整工具 deny）与"没注册描述"（故障，warn 后略去）。
上面这个 `Ghost` 就是后一类：一个用了 `$.tool.call` 却没注册 `tool.describe` 的插件，
它的工具**永远不可能被模型调用**，而 `/help` 照样把它列出来告诉用户"可用"。

复刻对象那句「在列表里 ≠ 能跑」正好是我们的现状。它自己的答案是**文档化**（写在使用说明里，
让写插件的人自己记住）；我们的答案简单一点：让用户看到的与模型看到的**是同一份**。

### 2.2 一个"我们已经和解"的地方（写下来，省得下次再怀疑）

复刻对象的"来源与溯源"那一节重点是**一个插件会不会盖住另一个**（A3：MCP 服务器与内建同名时
谁说了算）。我们这边不是靠命名空间或信任表做到的，是**结构上做不到**：

- 第三方插件的座位被**强制**成 `append`（`core/create.ts`），`builtin` 在外层先应答且不调 `next`
  —— 一个插件注册 `tool.call {tool:'Read'}` 也永远轮不到它；
- 第三方插件在 `tool.check` 上自己答 `allow` 会被**丢弃**并出声（`core/create.ts`），
  于是它的工具只能自己声明 `ask`，或者被 `confirmPlugin` 按"不认识的工具"拒掉；
- `uses` 越界 → **整个插件**不装（`core/registry.ts:102`）。

所以我们的"来源"不是一条安全边界（那条边界是座位与权限链），而是一条**信息**：
用户在 `/tools` 上看得见"这个是引擎给的、那个是你装的插件给的"。别把它读成安全机制。

---

## 3. 逐项设计

### 3.1 工具清单的单一来源：`core/tool-list.ts`

`loop.ts` 里那个私有的 `describeTools`（`:421-458`）整段搬进新文件 `src/core/tool-list.ts`，
改名为 `listTools`，**返回三个部分**而不是一个 `ToolSpec[]`：

```ts
export type ToolListing = {
  /** 模型这一轮能看到的（顺序 = 注册顺序，`tool.list()` 那个顺序）。 */
  readonly specs: readonly ToolSpec[];
  /** 不在可见清单里的，**逐个带原因** —— 这是 `/tools` 那一屏的全部内容。 */
  readonly skipped: readonly { readonly name: string; readonly why: string }[];
};

export async function listTools(deps: {
  readonly $: EngineInterface;
  readonly dispatch: DispatchFn;
  /** 子代理的白名单。省略 = 不筛。 */
  readonly tools?: ReadonlySet<string>;
}): Promise<ToolListing>;
```

`skipped.why` 用三种原样的话（现有代码里的两句注释与一条 warn 已经在说这件事，
这里只是把它们**变成字符串**）：

| 落在哪一支 | why |
| --- | --- |
| 白名单外 | `不在本次的工具清单里` |
| `hidden` | `被权限规则隐藏` |
| `tool.describe` 抛 | `没有注册描述（tool.describe 无人应答 —— 这是故障）` |

三条对应的日志**一个字不改**：前两条 `logger.debug`，第三条 `logger.warn`。
"隐身"与"故障"必须看得出区别（`cli/commands.ts:196` 那条注释），这条判据在 `/tools` 上
也要成立 —— 所以 `skipped` 里那两句人话的**措辞本身**就是判据，测试钉的是它。

`loop.ts` 那边变成一行：

```ts
const listing = await listTools({ $: ctx.$, dispatch: ctx.dispatch, ...(ctx.tools === undefined ? {} : { tools: ctx.tools }) });
const tools = listing.specs;
```

工具字符数也放在这个文件里 —— 它是"工具清单占多少"的唯一算法：

```ts
/** 一个工具在请求里占的字符数：名字 + 描述 + schema 的 JSON。 */
export function toolSpecChars(spec: ToolSpec): number;
export function toolsChars(specs: readonly ToolSpec[]): number;
```

⚠️ 口径：这是**字符数**，不是 token。token 由调用方 `estimateTokens` 换算 ——
与系统提示、会话消息用的是同一个函数，账本才能对得上。

### 3.2 账本把工具算上

`ContextReportInput` 多一个字段、输出多一行：

```ts
readonly tools: readonly ToolSpec[] | undefined;   // undefined = 这一轮还没发过请求
```

```
上下文账本（除「上次实测」外都是估的）：
  系统提示　130 token —— base 100 · instructions 30
  工具清单　6 个 · 84 token —— Read 21 · Write 19 · Edit 18 · Bash 12 · Glob 8 · Grep 6
  会话消息　30 token（2 条）
  合计　　　244 token
  阈值　　　100,000 token · 自动压缩 关 · 保留最近 6 轮
  上次实测　还没发过请求。
不报「还剩多少」：…
```

三条口径各自怎么落：

1. **逐工具之和 = 工具清单那一行**：那一行的总数是 `estimateTokens(toolsChars(specs))`，
   逐工具是 `estimateTokens(toolSpecChars(spec))` —— 与系统提示那一行**同一个形状**
   （`context-view.ts:46-51`），取整余数造成的 1 token 级出入与它同源、同样不掩饰。
2. **合计 = 三样之和**：`estimateTokens(piecesChars + toolsChars + messageChars)`。
   `tools === undefined` 时它算 0，那一行说「这一轮还没发过请求。」（与「系统提示　这一轮还没算过」
   同一种口气）。
3. **不截断**：工具多的时候这一行会很长。不砍尾巴是刻意的 —— 砍了就不叫账本
   （费用是既成事实，不随屏幕宽度变）。这条写进 README 的已知限制。

数据的来路：**`runTurn` 报出来的是它真的发出去的那一份**，不是 `/context` 现算的。
`LoopContext` 多一个可选回调，与 `onUsage` 完全同形：

```ts
/** 这一轮真正推进请求里的工具清单（`turn.complete` 的同一条数据）。账本吃它。 */
onTools?: (specs: readonly ToolSpec[]) => void;
```

理由与 `onUsage` 一模一样：插件拿不到 `dispatch`，而账本是 CLI 的一屏 ——
CLI 记最后一份，`/context` 读它。**好处是账本报的永远是"发出去的那一份"**，
与 `上次实测` 的比较因此是可比的（这正是 §2.1 探针 1 要修的东西）。
子代理与一次性模式不接这个回调，行为不变。

### 3.3 `/tools`

新命令，一行一个工具：

```
模型这一轮能用的工具（6 个）：
  Read　来自 tool-read　读取一个文本文件的内容，返回带行号的正文。
  Write　来自 tool-write　写入一个文件。已有文件需要本会话读过它。
  …
不进模型可见清单的（1 个）：
  Ghost　没有注册描述（tool.describe 无人应答 —— 这是故障）
```

- **来源那一格**来自 `$.tool.origin(name)`（§3.4）。取不到时打 `来源不明`，不省略那一格。
- **描述只取第一行，超 80 字符截尾加 `…`**。这是**显示的截断**，与模型那一份无关
  —— P6 已经立过这条先例（屏幕截断 ≠ 模型拿到的被截断）。`/tools` 顶部那句话要写明这一点，
  否则读的人会以为模型也只拿到 80 字。
- 第二段（不进清单的）为空时**整个不出现**；非空时明确列出个数与原因。
- 与 `/compact` / `/context` 同一条纪律：**依赖没注进来就不注册这条命令**
  （`cli/commands.ts` 的 `toolListing?: () => Promise<ToolListing>`），
  `/help` 也不列它 —— 比"命令在、点了没反应"诚实。

`/help` 那一行的收敛（`commands.ts:180`）：

```
可用工具：Read  Write  Edit  Bash  Glob  Grep　（/tools 看每个工具是干什么的）
另有 1 个不在模型可见清单里（/tools 有原因）
```

`toolListing` 没注入时（少数的测试装配）退回 `$.tool.list()` 并**当场说出这是没过滤的**：
`可用工具：… （未过滤：这一份是注册面，不是模型可见面）`。回退方向是"多列"不是"少列"，
所以不会静默少一块 —— 但两种含义不同，必须说出来。

### 3.4 来源：`$.tool.origin(name)`

```ts
export type ToolNoun = {
  list(): readonly string[];
  /** 这个名字**是谁注册的**（插件名）。没人注册 → undefined。 */
  origin(name: string): string | undefined;
};
```

实现落在 `Registry` 上，与 `matcherValues` **共用一次扫描**（不许第二份算法）：

```ts
/** 某个 matcher 取值**是谁的**：按 hooksFor 同样的键序（tier → 装载顺序 → 注册序）取第一个。 */
matcherOwner(pattern: string, key: string, value: string): string | undefined;
```

取的是**第一个 `tool.describe {tool: name}` 的注册者**（工具的"面孔"由 describe 决定），
没有 describe 的退回第一个 `tool.call` 的注册者。这一条要在注释里写清：
一个工具名**可以有多个注册者**（`tool.call` 是一条链，`session-changes` 就挂在 `Write` 上），
所以 `origin` 报的是"**谁在应答它**"，不是"谁碰过它"。

座位那一层不在这一格里 —— 第三方插件被强制 append，于是 `origin` 报出来的名字
天然只有内建与第一方（见 §2.2）。**这不是安全机制**，只是信息。

### 3.5 不动的东西（列出来，省得被当成漏项）

- `$.tool.list()`：**语义不变**，仍是注册面。子代理的白名单（`cli/subagents.ts:134` 的
  `resolveTools`）吃的是它 —— 那里要的正是"注册过哪些名字"。注册面与模型面**两个都有用**，
  所以不是"改掉一个"，是"补上另一个"。
  ⚠️ **P10 更正（2026-10-12）**：后半句过期了 —— `resolveTools` 已整个删掉，子代理的面不再吃
  注册面，而是**走上面这一个函数**（按"父级那一轮"算，`core/nouns/agent.ts`）。注册面今天的
  消费者是 `/help` 的**回退**那一支与诊断。见 `2026-10-12-deepcode-p10-design.md` §3.1。
- `tool.describe` / `tool.call` / `tool.check` / `tool.result` 四个事件的形状：一个字不改。
  本阶段**不加事件**（与 P8 同一口径）。
- `confirmPlugin` 的三个名字集：不改（§4 有理由）。
- 六个内建工具的实现与上限（`read` 2000 行 / `bash` 40000 字符 / `glob` 500 / `grep` 200）：
  已经有，不动（§4）。
- `describeTools` 每轮重算：不改（§4）。

---

## 4. 明确不做（十二条，逐条给理由）

1. **工具定义面上的策略旗标**（`readOnly` / `destructive` / `concurrencySafe`）。复刻对象
   **刻意没有**，理由是"自述不可信，判据要在可信的那一层"；我们的判据是链上的一次判定
   （`tool.check`），旗标加进去只会多一个能被撒谎的面。**同构，不是差距。**
2. **`tool.describe` 的每会话缓存 + `$.ui.invalidate`。** 复刻对象的理由是不稳定的答案会花掉
   prompt cache；我们每轮重算，与 P7 已经记档的偏差同一条（我们不主动管 prompt cache，
   换来的是"会话中改 AGENTS.md 当场生效"）。内建工具的 describe 是静态常量，缓存只是省几微秒。
3. **ToolSearch / 延迟加载。** 阈值是模型窗口的 10%，而我们**连窗口是多少都不知道**
   （`context-view.ts` 那句"不报还剩多少"就是为这个）—— 拿一个我们不知道的数去算阈值，
   正是那份文档里反复警告的事。工具部分是 437 token（实测），延迟加载是给几十上百个工具准备的。
4. **`mcp__<server>__<tool>` 命名空间。** 没有 MCP 客户端，没有第二、第三个来源。
5. **按来源分组 / 过滤的 UI。** 我们只把来源**显示**出来，不据此排布或筛选 ——
   一个插件的名字不该改变命令的输出结构。
6. **per-call 只读信号。** 复刻对象自己把它标成未文档化，并说消费者必须一律当写。
   我们的 `confirmPlugin` 正是那个保守默认（`MUTATING_TOOLS`），**要改就是改成更差的**。
   真要做就得解析 shell 语法 —— 那正是它自己警告过的坑。
7. **`consent` 作为人轮 / 并行的工具批。** 我们是同步 `y/N`、串行执行，没有并发批次，
   也就没有"先占位后批准"要解决的问题。
8. **`PermissionRequest.allow` 带 `updatedInput` / `updatedPermissions` 与四档落点。**
   这是"记住这个决定"那条路，**它会放宽权限**，而我们连 `--yes` 都刻意没有
   （README 那句「谁加自动放行开关谁就是在开倒车」）。明确的反向选择，不是漏项。
9. **`PostToolBatch`。** 工具串行 + 结果合成一条消息（`loop.ts`），批次不存在。
10. **`category` / `group` 原语。** 复刻对象自己也没有；我们的分组是名字前缀与插件局部常量。
11. **磁盘上的工具注册表 / marketplace。** P5 之后的事，现在做等于先造一个没人写的目录格式。
12. **给工具结果加输出上限、给写工具加路径围栏。** 上限**已经有**（`read` / `bash` / `glob` /
    `grep` 各一个常量）；围栏是 MVP 设计里明确不做的（`README` 已知限制），换的是
    "写入范围由权限链与用户确认承担"。

---

## 5. 偏差与代价（预先登记，做完逐条核对）

1. **账本的口径变了**：`合计` 从此包含工具清单，因此**与 P8 之前的 `/context` 数字不可比**。
   旧数字是偏低的那一个。CHANGELOG 要写这一条。
2. **`/context` 那一行会很长**（工具多时）。不截断是刻意的（§3.2 口径 3），
   代价进了 README 的已知限制。
3. **`onTools` 是一个新的可选回调**，形状与 `onUsage` 同形但只被 CLI 接。
   不接的装配（子代理、一次性模式、多数测试）行为不变 —— 这是"可选"的全部含义。
4. **`ToolNoun` 多一个方法**，是**契约变更**。桩与 mock 通过 `as unknown as EngineInterface`
   转型，typecheck 不受影响；只有真的调它的那一条路（`/tools`）需要真实现。
5. **`/help` 的工具那一行可能变短**（模型看不见的被拿掉了）。这是修 bug，不是功能删减；
   但"以前 `Ghost` 在那儿、现在不在了"是**用户可见的变化**，CHANGELOG 要提。
6. **`/tools` 的每行描述截到 80 字符**是显示行为，模型那一份不变 —— 顶部那句话必须写明，
   否则读的人会把屏幕上的截断当成模型拿到的截断。
7. **`origin` 报的"谁"是"谁在应答它"**，不是"谁碰过它"（`tool.call` 是链，一个工具名可以有
   多个注册者）。这一条在注释与文档里都要写，不然第一次遇到"Write 的来源是 tool-write
   但它还有别的 hook"的人会以为这是个 bug。
8. **本阶段不加、不改任何事件**。四个工具事件的形状一个字不动 —— 于是第三方插件
   （`plugins/todo/main.mjs`）**一行都不用改**。做完拿它验一遍。

---

## 6. 任务分解与检查点

| # | 任务 | 文件 |
| --- | --- | --- |
| T1 | `listTools` + `toolSpecChars` / `toolsChars` 独立成文件；`loop.ts` 改用它；`onTools` 回调打通 | `core/tool-list.ts`(新)、`core/loop.ts` |
| T2 | `Registry.matcherOwner`、`ToolNoun.origin`、`nouns/index.ts` 接线 | `core/registry.ts`、`contract/engine.ts`、`core/nouns/index.ts` |
| T3 | 账本：`tools` 输入 + 「工具清单」行 + 合计三样 | `cli/context-view.ts` |
| T4 | `/tools` 命令 + `/help` 那一行收敛 + `toolListing` 注入 | `cli/commands.ts`、`cli/main.ts` |
| T5 | `onTools` 从 `main.ts` 经 `repl.ts` 接到 `runTurn` | `cli/main.ts`、`cli/repl.ts` |

**检查点**

- **C1（T1+T2）**：`pnpm typecheck` + `npx vitest run test/tools.test.ts test/tooling.test.ts test/loop-options.test.ts test/loop-ending.test.ts`；
  新用例：`listTools` 三类结果各一条、白名单筛选不出现在 `skipped` 之外的路径、
  `matcherOwner` 在内建与第三方两种注册下各一条。
- **C2（T3）**：`npx vitest run test/context-view.test.ts`；新用例：工具那一行逐工具之和 =
  那一行总数（长度取 4 的倍数）、`合计` 含工具（抽掉一个工具，合计就变）、
  `tools === undefined` 时那一行说"还没发过请求"且合计等于两样之和。
- **C3（T4+T5）**：`npx vitest run test/cli.test.ts test/e2e.test.ts test/subagent.test.ts test/plugin-e2e.test.ts`；
  新用例：`/tools` 三段输出（可见 / 不进清单 / 来源）、`/help` 不再列没描述的工具、
  `Ghost` 那条 why 的具体措辞、`toolListing` 没注入时 `/tools` 不存在且 `/help` 出声说明未过滤。
- **收尾**：`pnpm typecheck && pnpm lint && pnpm test` 三条全绿 + 拿 `plugins/todo` 手工跑一遍
  （它一行没改，装上之后 `/tools` 应多出 `TodoWrite 来自 todo`）。

**反向验证（至少两条，改坏实现看它红不红）**

| 改坏什么 | 应该红在哪 | 实测 |
| --- | --- | --- |
| 合计里去掉 `toolsChars` | C2 那条"抽掉一个工具，合计就变" | ✅ 2 红 / 9 绿（`context-view` 的 P9 合计用例 + `repl-tools` 的合计用例，两条正好喊出同一件事） |
| `skipped` 里把"没有注册描述"写成与 `hidden` 同一句 | C3 那条钉措辞的用例（隐身与故障要分得开） | ✅ 3 红 / 7 绿（`C1-1` 两条 + `C3-1` 一条） |
| `/help` 退回 `$.tool.list()` | C3 那条"不再列 Ghost" | ✅ 1 红 / 4 绿（`C3-3`） |

三轮都是**先红在指定的那条断言上**（不是红在别处、也不是顺带把一整套打红），随后还原、复绿。

**第三方插件那一遍**：`plugins/todo/main.mjs`（`plugins/todo/plugin.json:6` 的 `uses`）**一个字没改**，
按 `test/plugin-e2e.test.ts` 的同一条路（`discoverPlugins` → `loadPlugins` → `createEngine`）装进来后：

```
可见: Read TodoWrite | 不来: [Write/Edit/Bash/Glob/Grep —— "不在本次的工具清单里"(探针只给了两项白名单)]
TodoWrite 来源 = todo | Read 来源 = tool-read
```

即：新工具自动进模型面（`$.tool.list()` 是注册面，`listTools` 过滤后仍是它），
`origin` 在**第一方插件（`tool-read`）与第三方插件（`todo`）上报的是同一种东西** —— 这正是出口标准四。
探针是临时的，跑完即删（它要的效果已经被 `test/tool-list.test.ts` / `test/tools-command.test.ts` 长期钉住）。

**同步四处**（与 P7/P8 同一套）：`README.md`（新增 `/tools` 与账本口径变化 + 已知限制加两条：
那一行会很长、工具清单是估的）、`docs/项目简介.md`（阶段行 + 计数）、
`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md` §9.2 的 P9 列、`site/index.html`
（数字与一张卡片：账本漏掉 97.5% 这件事本身就是个亮点）＋ `CHANGELOG.md`（含合并清单那一行）。

**收尾实测**：`pnpm typecheck` ✅ ／ `pnpm lint` ✅（依赖边界 + 工作流硬化两条都在跑）／
`npx vitest run` = **70 个文件 / 1177 passed / 1 skipped**（P8 收尾时是 67 / 1159）。
新增三个测试文件：`test/tool-list.test.ts`（5）、`test/tools-command.test.ts`（5）、
`test/repl-tools.test.ts`（2）；既有文件里加：`loop-options` +2、`context-view` +3、`cli` +1（真 bin 端到端）。

⚠️ 那条真 bin 用例里，**真会话是 8 个工具**（六个内建 + `Task`/`Skill` 来自 `subagents` 插件），
不是设计时以为的 6 个 —— 断言按实测的 8 写，并顺带钉了 `Task　来自 subagents`（第三方来源那一半）。
