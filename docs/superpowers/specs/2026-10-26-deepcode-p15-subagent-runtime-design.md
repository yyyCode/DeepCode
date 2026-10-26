# DeepCode P15 子代理运行时：开箱类型、只读并发与派发口径

> 输入是用户提供的一份《Claude Code Subagent 机制整理》（下称 **[输入]**），以及仓库里已有的
> `docs/claude-code-架构分析/14-subagents.md`（下称 **[14]**）与 P4a/P10 两份设计。
>
> **[14] 是契约级事实源，[输入] 是面向设计者的摘要。** 两者冲突时以 [14] 为准，并在 §1 逐条记下来。
>
> 一句话：**P4a/P10 已经把「隔离、工具面、深度上限」做成了结构；本阶段补三件它还缺的事 ——
> 开箱可用的子代理类型、只读探索的并发、以及把「什么时候该派」写进模型看得见的地方。
> 每一条都用测试或 benchmark 钉住，不用「更快」「更强」这类没有判据的词。**

---

## 1. 把 [输入] 拆成可判定的条目

[输入] 里的机制，逐条对到我们的现状。**「本阶段」一列才是要做的**，其余是已经成立或明确不追。

| [输入] 的说法 | [14] 的事实 | 我们的现状 | 本阶段 |
| --- | --- | --- | --- |
| 独立上下文，不继承父历史 | 同构：只序列化 `prompt` | **已成立**：内层 `messages` 只有一条 `user`（`core/nouns/agent.ts`） | 不动 |
| 只把摘要回传给父级 | 同构 | **已成立**：只取子代理最后一段文本（中间工具结果不外泄） | 不动 |
| 工具权限可配置（只读 / 读写 / 受限 Bash） | 四层收窄 | **已成立**：`tools` / `disallowedTools` 与内核求交（P10） | 不动 |
| 独立模型（Explorer 用 Haiku） | 模型解析四层 | 已有 `model` 字段与调用参数覆盖 | **不照抄 Haiku**：不为某个供应商写死别名（§4） |
| 子代理不能再派子代理（防递归） | **实际是深度 3**（`CHANGELOG` 3573）；曾出现前台比后台松的漏洞（4347） | 深度 3，内核统一判定（P10） | 保持 3；不改成「禁止嵌套」 |
| 前台 / 后台两种执行 | **后台是默认**，前台要论证 | 只有前台同步 | **不追**：没有「能等的东西」就不做后台（§4） |
| 内置 Explore / Plan / general-purpose | 内置类型 | **没有**：名册只来自文件与插件 | **做**：三个开箱类型（§3.1） |
| 自定义 agent 的 YAML frontmatter | 字段更多（`permissionMode` / `mcpServers` / `memory` / `isolation`） | 六个字段：`name` / `description` / `model` / `tools` / `disallowedTools` / `maxTurns` | 加 `readOnly`；其余不追 |
| `description` 决定自动委派 | 同构 | **已成立**：`renderOffer` 只印这一行 | 补充派发口径（§3.4） |
| 多子代理并行 | 并发子代理默认 20 | **没有**：`Task` 没声明 `readOnly`，一轮里只能串行 | **做**：只读探索并发（§3.2–§3.3） |
| 反模式：小任务、同文件并行、强依赖 | [14] 未展开 | 没有写进模型可见处 | **做**：写进 `Task` / `Explore` 描述与清单提示（§3.4） |
| Agent Teams（跨会话协作） | 已扁平化，只保留点对点消息 | 没有 | 不追（§4） |

两处必须写明的冲突：

1. **[输入] 说「subagent 不能再生成 subagent」，[14] 的实测是深度 3。** 我们保持 3：
   叶子的递归靠「`tools` 里没有 `Task`」从结构上断掉，深度只是保险丝。把保险丝改成「禁止」
   不会更安全，只会让「Explore 派 Plan 调研」这种正常的浅嵌套做不到。
2. **[输入] 把后台写成两种模式之一，[14] 说后台是默认。** 我们的前台同步是 P10 明确登记的
   不追项（[14] D1/D2）：同步返回结果时，调用方不需要句柄、等待表、通知与 `TaskStop`。
   这不是遗漏，是这一阶段的取舍。

---

## 2. 现状与缺口

P10 之后已经成立的三条结构（本阶段不重做）：

- **隔离**：内层 `runTurn` 用的是同一份循环、同一条 `dispatch`、同一个 `tool.check`；换的只有
  `messages`、`systemPrompt`、工具面与 `maxHops`。
- **面只会更小**：`allow` 与父面**求交**，`deny` 再减一层；父级看不见的工具，子代理连点名也够不着。
- **深度只有一处**：`MAX_DEPTH = 3` 在内核，`Task` 与插件直派共用。

缺口有四个：

**A. 开箱没有可派的子代理。** 一个刚装好的会话，名册是空的；模型看到 `Task` 却没有任何
`subagent_type` 可填。要先用一个文件定义一个 agent，第一条委派才可能发生。

**B. 只有串行。** `Task` 在 `tool.describe` 里没有声明 `readOnly`，于是同一轮里的多个 `Task`
被写成屏障逐条跑。三个互不依赖的探索任务，墙钟是三者之和。而 P10 的面栈注释已经写明：
**面栈在并发 `spawn` 下会错位** —— 要做并发，先得把「父面」从全局栈换成按异步执行流分开。

**C. 模型不知道「该不该派」。** 清单只列名字与 `description`；「小任务不值得派」「两个子代理
别改同一个文件」「有先后依赖要串行」这些反模式一个字都没进提示。模型只能凭感觉。

**D. 没有一条能复现的收益账。** 隔离省了多少父级上下文、并发省了多少墙钟，今天只能靠叙述。
P11/P12/P13/P14 都各有一张 benchmark 表；子代理没有。

---

## 3. 设计

### 3.1 开箱类型：`explore` / `plan` / `general-purpose`

三个内置 `AgentSpec` 住 `src/cli/builtin-agents.ts`，由 `main.ts` 显式传给 `discoverAgents`
的 `builtins` 参数（默认 `[]`，发现函数本身不硬编码产品名册）。

| 名字 | tools | readOnly | model | maxTurns | 用途 |
| --- | --- | --- | --- | --- | --- |
| `explore` | `Read` / `Glob` / `Grep` | **是** | inherit | 12 | 定位文件、梳理调用链、给带 `path:line` 的结论 |
| `plan` | `Read` / `Glob` / `Grep` | **是** | inherit | 16 | 为写计划收集事实：涉及文件、约束、风险、未确认项 |
| `general-purpose` | 省略（继承父面） | 否 | inherit | 省略（25） | 需要读写、执行命令或多步完成的任务 |

三条决定：

- **优先级最低。** 合并顺序是「项目级 → 用户级 → 插件级 → 内置」。同名时前面的赢，
  内置**静默**让位：覆盖一个内置类型是预期行为，为此打一条 warn 只是噪音。
  这与用户文件之间的落选不同 —— 后者永远出声。
- **不写死供应商别名。** [输入] 的 Explore 用 Haiku，但 `haiku` 在 OpenAI 兼容端点上没有意义。
  三个内置都留 `model: inherit`；要换模型，在项目/用户 agent 文件里写 `model`，或者由调用参数覆盖。
- **`general-purpose` 的正文为空**，于是走既有回落：会话基础提示 + 一句身份说明。
  这是唯一一个继承完整静态提示的内置类型；`explore` / `plan` 的正文是整份替换（P10 的硬隔离不变）。

### 3.2 只读声明与 `Explore` 工具

**声明面（文件）：**

```yaml
---
name: explorer
description: 只读探索代码库
tools: Read, Glob, Grep
readOnly: true
---
```

- `readOnly: true` 是**作者声明**，不是权限。它只在 `Explore` 的资格判断与内核验证里用。
- **必须同时写 `tools`。** 省略 `tools` 意味着继承父面（可能含 `Write` / `Bash`），
  与 `readOnly: true` 自相矛盾。发现阶段会 warn 并**忽略这个标志**：该 agent 仍可用 `Task` 派，
  只是不进 `Explore` 的名册。
- 现有 `Task` / `tools` 语义一个字不变：`readOnly` 不放宽任何东西，只多一个「可以并发」的资格。

**验证面（内核）：**

`AgentSpawnRequest` 加一个可选 `readOnly?: true`。内核在算出**这一轮真正的面**之后，
拿 `listTools` 返回的 `readOnly` 集合逐个核对：

```
若 req.readOnly === true：
  面里任何一个工具没有声明 readOnly → 拒绝这次派生
```

拒绝发生在 `agent.spawn` 事件**之前**，于是屏幕上不会出现一行「派子代理 X」却永远不回来
（P10 踩过的那条假账）。理由里列出那几个工具，并明确说「用 Task 串行派它」。
这是 fail-closed：文件可以撒谎，内核不信。

**工具面（模型）：**

`Explore` 是子代理插件注册的第二个派生工具，和 `Task` 并列：

```json
{
  "subagent_type": "explore",   // 可选；省略 = 内置 explore
  "prompt": "要它做什么、看哪些文件、回报什么"
}
```

- `tool.describe` 里声明 **`readOnly: true`**。执行面据此把同一轮里**连续**的多个 `Explore`
  并发跑；准入仍然逐条串行（确认提示不能两个一起弹）。写工具与 `Task` 仍是屏障。
- `tool.call` 只接受**声明了 `readOnly: true`** 的 agent；`general-purpose` 之类会被拒，
  并提示改用 `Task`。内核在更里面再做一次同样的验证（§3.2 验证面），两层是同一件事的
  快失败与兜底。
- `confirm` 把 `Explore` 放进借道放行名单：它自己不碰磁盘，子代理内部每一次工具调用
  照样再走一遍 `tool.check`。**放行 `Explore` 绝不等于免确认。**
- 计划模式把 `Explore` 加进 `PLAN_ALLOWED`：它的输出面已经被内核验证为只读，
  在「只读研究」阶段并行探索正是它该用的地方。`Task` 仍然被计划模式藏起来。

### 3.3 并发下的父面：把栈换成 `AsyncLocalStorage`

P10 的父面栈是一条全局数组，push / pop 围着内层 `runTurn`。串行时它是对的；
`Promise.all` 同时派两个子代理时，两边的 push / pop 会交错，第二层会把第一层的面当父面。
P10 的注释已经把这条代价写在明处，并给出下一步：**要并发就上 `AsyncLocalStorage`**。

本阶段就做这一步：

```ts
type LoopScope = {
  readonly face: ReadonlySet<string>;   // 这一层模型看得见的工具
  readonly depth: number;               // 1 = 会话直接派的
  readonly names: readonly string[];    // 名字链，只用于拒绝消息
};

const scopes = new AsyncLocalStorage<LoopScope>();
```

- `spawn`：读当前 store。没有 store = 会话那一层：父面现算（全量），`depth = 1`。
  有 store：父面就是 `store.face`，`depth = store.depth + 1`，名字链拼上自己。
- 深度判定用拼好的 `depth`，措辞与 P10 一字不差。
- 验证通过后，`await scopes.run(scope, () => runTurn(ctx, messages))`。整个子代理循环
  （包括它内部所有工具调用与嵌套 `spawn`）都活在这份 store 里。
- 于是两个并发 `Explore` 各自看到自己的父面与 `depth = 1`；其中一个再嵌套也不会读到另一个的面。
  **没有共享的可变栈**，也就没有交错。

代价与边界：

- `AsyncLocalStorage` 是 `node:async_hooks` 的内建，不加运行时依赖；但它只覆盖
  **从 `runTurn` 的异步上下文里发起的 `spawn`**。一个插件 `void $.agent.spawn(...)`
  在同一个 tick 之外丢了上下文，会退回「会话那一层」的父面与 `depth = 1` —— 那本来就是
  一次没有父级的派生，行为仍然是安全的（面不会更大）。
- 事件 `agent.spawn` 移到验证之后派：只读验证失败、深度超限都不再留下一条假的「即将启动」。

### 3.4 派发口径：让「什么时候别派」也进提示

三处，都是模型真的会读到的地方：

1. **`agent.offer` 的清单**（`renderOffer`）：只读类型标注「只读，可用 Explore 并发」，
   并在清单末尾加一段派法：
   - 独立只读探索优先 `Explore`，一次响应可以发多个，会并发跑；
   - 要写盘、或有先后依赖的用 `Task`，串行；
   - 小到几条工具调用能做完的任务，不要派；两个子代理不要改同一个文件。
2. **`Task` / `Explore` 的工具描述**：各自说清什么时候用它、什么时候用另一个。
   `Explore` 明确写「同一个响应里可以发多个，它们会并发跑」。
3. **静态提示的「工具选择」一节**：加一条与上面同向的短句。它属于不随项目变的静态前缀，
   因此不会破坏 P13 的前缀缓存。

[输入] 的「探索 10+ 文件或 3+ 独立子任务才值得派」是一个**经验值**，不是我们测出来的；
不写进提示，避免把别人的数字伪装成我们的结论。写进本文档，供以后有数据时再定。

### 3.5 不变量（实现与测试都要守）

1. `Explore` 派出的子代理，面里**不可能**出现 `Write` / `Edit` / `Bash` / `Task` / `Explore`
   —— 前三个由 `tools` 白名单挡，后两个由「只读声明」与内核验证挡。
2. 同一轮里连续的 `Explore` 可以并发；`Task` 与任何写工具是屏障，执行顺序不越过模型给的顺序。
3. 并发的两个 `Explore` 各自 `depth = 1`、各自父面；嵌套各自 `depth = 2`，互不污染。
4. `readOnly: true` 但没有 `tools` 的 agent 不会被 `Explore` 选中；写了 `tools` 却含写工具的
   agent 即使声明 `readOnly: true`，内核也会拒绝。
5. 子代理内部每一次写盘 / 执行仍然走确认链；`Explore` 的放行不改变这一点。
6. 深度上限仍是 3，所有路径共用同一个数。

---

## 4. 明确不做

1. **后台、句柄、`TaskOutput` / `TaskStop` / `SendMessage`**。它们是一组依赖：没有「能等的
   东西」，就没有「运行中的代理」这个可寻址对象。P10 已经记过；本阶段不碰。
2. **hand-back 安全分类（`send` / `flagged` / `withheld`）**。外部内容在我们的面里只有
   `Read` / `Bash` 两条路；真正的注入防护该落在「外部内容进上下文」那一处。不假装做了。
3. **每个 agent 的持久记忆（`memory: user | project | local`）**。跨 run 记忆需要三件设计
   （住哪儿、谁清理、与 `Memory` 工具怎么分工），一件都没有。
4. **MCP 服务器、`permissionMode`、`isolation: worktree | remote`**。没有对应基础设施；
   `permissionMode` 还会绕过本仓库唯一的安全底线（每条写盘都要人点头）。
5. **子代理自己的转录与压缩**。今天的子代理只活在父级那一轮里，`maxTurns` 是它的成本保险丝；
   上下文五层压缩只作用于会话主线。要做「子代理也能长跑」，得先有 §1 的后台。
6. **禁止嵌套**。保持深度 3；叶子的递归由工具面断掉。
7. **把 `Explore` 做成写工具的并发容器**。并发只对「内核已经验证为只读」的面开放；
   两个写子代理同时改同一个文件是 [输入] 明确列出的反模式，我们没有能力检测文件冲突。

---

## 5. 验收与 benchmark

新增 `pnpm bench:subagent`（`scripts/benchmark-subagents.ts`）。不调用真模型、不需要 key，
provider 是脚本；表里的数可以离线复现。

| 指标 | 怎么量 | 方向 |
| --- | --- | --- |
| 隔离收益 | 同一个 60 000 字符的工具结果：父级直接读 vs 派 `explore` 读。量父级 `messages` 的字符与估算 token | 委派后父级只增长摘要量级 |
| 并发收益 | 一轮里 3 个独立探索：`Explore`（并发）vs `Task`（串行）。量峰值并发与墙钟 | 峰值 3 vs 1；墙钟明显更短 |
| 开箱名册 | 内置三个类型的 tools / readOnly / 提示 token | 与 §3.1 表一致 |
| fail-closed | `readOnly: true` 但面里含 `Write` 的 agent，经内核派生 | `ok: false`，且理由里点名那个工具 |

测试断言的是**结构**，不是绝对耗时：

- 隔离：委派后的父级字符数小于直接读的 1/4；子代理回传的字数等于摘要字数。
- 并发：`Explore` 峰值并发 = 3，`Task` 峰值 = 1；并发墙钟 < 串行墙钟。
- 面：`explore` 那一轮请求里的工具名只有 `Read` / `Glob` / `Grep`。
- 权限：`general-purpose` 不能走 `Explore`；说谎的 `readOnly` agent 被内核拒。
- 名册：内置三个开箱就在；项目级同名文件覆盖内置。

---

## 6. 偏差与代价（预先登记）

1. **可见工具从 10 个变成 11 个**（多一个 `Explore`）。README、官网、`/tools` 的用例计数都要跟着改。
   这是本阶段唯一对模型面的加宽；加宽的是「只读探索」，不是权限。
2. **内置类型对每个会话都可见。** 名册不再是「装了才有」。这是有意的开箱体验；代价是
   系统提示多三行。
3. **`readOnly` 是新的 frontmatter 字段。** 不写它不影响任何现有 agent；写了但没写 `tools`
   会被忽略并 warn。旧文件零改动。
4. **`agent.spawn` 事件晚于只读验证。** 被验证拒绝的派生不再产生事件；这是修正 P10 的
   「假账」形状（事件只对真会跑的那次派）。订阅方无需改动。
5. **`AsyncLocalStorage` 是 Node 内建。** 不破坏零运行时依赖；但它把「父面」从显式栈
   变成隐式异步上下文，读代码的人要习惯 `scopes.run` 这一层。好处是并发安全，
   坏处是「不在 `runTurn` 里的 `spawn`」拿不到父面（行为安全，只是层级退回 1）。
6. **计划模式多允许一个 `Explore`。** 它是只读面，方向与计划模式一致；`Task` 仍然被藏。
7. **内置 `explore` / `plan` 的正文是整份替换**，所以它们看不到 `AGENTS.md`（P10 的硬隔离）。
   要求它们守项目规矩，得在自定义 agent 文件里重述，或者用省略正文的 `general-purpose`
   （它回落到基础提示，但仍然不含指令文件）。这条代价进已知限制。
8. **并发只覆盖只读。** 写子代理仍然串行；同文件并行编辑没有防护，靠提示与人工确认。

---

## 7. 任务分解与检查点

| # | 任务 | 文件 |
| --- | --- | --- |
| T1 | 契约：`AgentSpec.readOnly`、`AgentSpawnRequest.readOnly`、`agent.offer` 的 `readOnly?` | `contract/agent.ts`、`contract/events.ts` |
| T2 | 发现：解析 `readOnly`（要求显式 `tools`）、内置名册三型、合并优先级 | `cli/agents.ts`、`cli/builtin-agents.ts`、`cli/main.ts` |
| T3 | 内核：`AsyncLocalStorage` 面/深度/名字链、只读验证、事件移到验证之后 | `core/nouns/agent.ts` |
| T4 | 工具面：`Explore` 工具、`Task`/`Explore` 描述、offer 标注与派法、confirm 借道 | `cli/subagents.ts`、`cli/offer.ts`、`builtins/confirm.ts` |
| T5 | 界面：`Explore` 的活动行、嵌套计数、计划模式允许 | `cli/activity.ts`、`cli/result-view.ts`、`builtins/plan.ts` |
| T6 | benchmark 与测试 | `scripts/benchmark-subagents.ts`、`test/subagent-parallel.test.ts`、`test/subagent-benchmark.test.ts`、`test/agents.test.ts`、`test/offer.test.ts`、`test/cli.test.ts` |
| T7 | 口径同步：README、官网文档、项目简介、CHANGELOG | `README.md`、`site/docs.html`、`site/项目简介.md`、`CHANGELOG.md` |

**检查点（批量做，用户长期指令）**

- **C1（T1–T3）**：`pnpm typecheck` + `npx vitest run test/agent-noun.test.ts test/agent-boundary.test.ts test/subagent.test.ts test/agents.test.ts`。
- **C2（T4–T6）**：`npx vitest run test/subagent-parallel.test.ts test/subagent-benchmark.test.ts test/offer.test.ts test/plan-mode.test.ts test/cli.test.ts`。
- **C3（T7）**：`pnpm typecheck && pnpm lint && pnpm test`，并跑 `pnpm bench:subagent` 把实测数字填进 §8。

**反向验证（至少三条）**

| 改坏什么 | 应该红在哪 |
| --- | --- |
| 把 `Explore` 的 `readOnly` 声明删掉 | 并发用例：峰值变成 1 |
| 内核不验证 `readOnly`，只信 `spec.readOnly` | 说谎 agent 的 fail-closed 用例 |
| 父面改回全局栈并用 `Promise.all` 派两个 | 并发面隔离用例：其中一个子代理看到另一个的面 |
| 内置名册不传给 `discoverAgents` | 开箱名册用例 |

---

## 8. 实测结果

> 数字来自 `pnpm bench:subagent`（2026-10-26，Node 20 / Windows 11），测试来自全量
> `pnpm test`。脚本不调真模型、不需要 key，跑的是真的 `runTurn` 与真的内核验证。

### 8.1 隔离：父级上下文

同一个 60 000 字符的工具结果，父级直接读 vs 派 `explore` 读：

| 模式 | 父级 messages 字符 | 父级 token（估） | 模型请求 |
| --- | ---: | ---: | ---: |
| 父级直接读 | 60,099 | 15,025 | 2 |
| 派 explore 读 | 245 | 62 | 4 |

委派后父级字符是直接读的 **0.4%**。多花的两次请求是子代理自己的两跳（读 + 总结）；
父级付的是那 245 字符的结论，而不是 60 000 字符的原文。token 是 `ceil(chars/4)`
估算，绝对值不可当真，比值有意义。

### 8.2 并发：三个独立探索

| 入口 | 调用 | 峰值并发 | 墙钟 |
| --- | ---: | ---: | ---: |
| Explore | 3 | 3 | 50 ms |
| Task | 3 | 1 | 138 ms |

每次探索用 `sleep(40ms)` 模拟。`Explore` 声明了 `readOnly`，三个调用在 `runTurn`
里走并发批；`Task` 没声明，走串行。墙钟含框架开销，断言方向是结构（3 vs 1、
并发更短），绝对值随机器变化。

### 8.3 内置名册

| 名字 | tools | 只读 | maxTurns | 提示字符 |
| --- | --- | --- | ---: | ---: |
| explore | Read / Glob / Grep | 是 | 12 | 206 |
| general-purpose | （继承父面） | 否 | — | 0 |
| plan | Read / Glob / Grep | 是 | 16 | 140 |

排序与 `discoverAgents` 一致（按名字），也就是模型在系统提示里看到的顺序。
`general-purpose` 不写 `prompt`、不写 `tools`：继承父面，保持和 P4a 一样的行为。

### 8.4 fail-closed：谎报 `readOnly` 的 agent

| agent | 结果 | 子代理请求 | 理由 |
| --- | --- | ---: | --- |
| liar | 拒绝 | 0 | 只读子代理 liar 的工具面里还有没声明只读的工具：Write。要派它写盘或执行命令，请用 Task（串行）。 |

文件可以写 `readOnly: true`，但只要有效面里有一个工具没声明 `readOnly`，内核就在
派发前拒绝，`agent.spawn` 不派、子代理一个请求都不发 —— 屏幕上不会出现“派子代理”
却永远不回来的假象。

### 8.5 全量测试

`pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿：86 个测试文件，1359 通过、1 跳过。

反向验证实际做了三条（改坏 → 跑测试 → 恢复）：

| 改坏什么 | 结果 |
| --- | --- |
| 删掉 `explore` 的 `readOnly` | `subagent-parallel` 红 2 条：默认 Explore 被自己的只读校验拒掉；三个 Explore 峰值不再是 3 |
| 内核跳过 `readOnly` 核对（`&& false`） | fail-closed 用例红：说谎 agent 被放行 |
| `discoverAgents` 不合并 `builtins` | 开箱名册用例红 |

第四条（父面改回全局栈）没有注入故障：`AsyncLocalStorage` 的并发隔离由
`subagent-parallel` 的嵌套面用例正向钉住（wide-a 的孙代理只看到 `Read`，wide-b
的只看到 `Glob`）。
