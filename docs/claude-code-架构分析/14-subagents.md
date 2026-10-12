# 14 · 子代理运行时：委派、隔离、交互与等待

> 范围：一个子代理**被创建之后、到它的答复回到父代理之前**，这一段运行时的完整面：怎么派生（委派的三层输入面）、上下文怎么隔离、主代理怎么把信息递下去、子代理怎么把结果交回来、哪些情况下主代理可以继续跑而哪些必须等、以及多个代理之间怎么互相说话。
> 论证口径同全套文档：**`mods/types/claude-code.d.ts` 的类型契约是单一事实源**；其次是 `CHANGELOG.md`（418 个版本段，**无日期**）给出的行为演进；再次是 `mods/`、`plugins/`、`examples/` 的实际用法；引擎内部（调度器、并发实现、`agentId` 生成规则、hand-back 分类器本身）**不可见**，凡属推断或查无实据的一律进文末「存疑与待确认」。
> 与相邻篇的分工：[08] 讲**怎么写**一个代理（`agents/*.md` 的 frontmatter、三套 schema、`description` 即路由）；[12] 讲委派在**执行链路**里的位置（句柄式委派、`turn.*` 三元组）；[11] 讲**上下文与压缩**；[13] 讲**工具**。本文只讲**正在跑的子代理**这一个运行时对象：它的出生、边界、通讯与生命周期。

---

## 定位

### 一句话

**子代理不是一次函数调用，是同一个引擎里的另一个 agent loop**——它有自己的系统提示、自己的消息历史、自己的转写文件、自己的压缩时机，而父代理拿到的只是**一个句柄**。

这句在契约里有逐字的依据：`AgentSpawnResult` 的文档写着「它和 `$.agent.spawn(input)` 一旦子代理**启动**就 resolve；它的答复是它自己的 `turn.complete`，带着这个 `agentId`」（`:313-321`）。所以委派在类型上**返回的是身份，不是结果**。

### 「委派」的四种出口形态

一次派生最终以哪种形态落到父代理的上下文里，由隔离模式和前台/后台决定：

| 形态 | 触发条件 | 父代理看到的 `result.status` | 答复何时到 |
|---|---|---|---|
| **同步（前台）** | `run_in_background: false` | `"completed"` | 同一轮内，`tool.call` 就带着完整报告 |
| **后台** | 默认（`run_in_background` 缺省为真） | `"async_launched"` | 之后作为一次 task-notification 投递 |
| **远程** | `isolation: "remote"` | `"remote_launched"` | 之后投递（远程云会话） |
| **fork** | 技能的 `context: fork`、或 `subagent_type: "fork"` | 技能的 `"forked"` / 代理的 `agentId` | 默认后台，可 `background: false` 关掉 |

注意「后台」是**默认值**，不是选项。Agent 工具的 `run_in_background` 文档把前台写成需要论证的例外：「代理默认在后台运行；完成时你会收到通知。**只有在你的下一个动作依赖这个代理的结果、且它在跑的时候没有任何别的事可做**，才设为 false」（`:12389-12390`）。

### 也不是什么

| 常见做法 | 本系统 |
|---|---|
| 子代理是进程 / 线程 / 独立服务 | ❌ 同一个引擎进程里的另一个 loop；上下文隔离靠**构造新上下文**，不靠地址空间 |
| 委派即阻塞调用，返回结果 | ❌ 默认非阻塞；返回**句柄**（`{ model, agentId }`），结果后到 |
| 子代理共享父的消息历史 | ❌ 非 fork 的派生只序列化 `prompt`（外加按规则继承的指令文件），**不带父的对话历史** |
| 有「团队」这种一级对象（创建/删除/命名） | ❌ 已扁平化：`TeamCreate`/`TeamDelete` 两个工具被移除（`CHANGELOG.md:4383`），每个会话只有一个**隐式团队**，`team_name` 参数「Deprecated; ignored」（`:12393-12394`） |
| 子代理没有独立转写，回看父的历史 | ❌ `SubagentStopHookInput` 带 **`agent_transcript_path`**（`:9573-9591`）——子代理有**自己的**转写文件 |

---

## 职责与边界

### 引擎负责

- **派生链的执行**：`agent.offer`（模型面可见性）→ `agent.spawn`（hook 可改写的那次派生）→ 真正启动，按 tier 串成中间件链。
- **上下文构造**：用 `AgentSpec.prompt` **整份替换**会话系统提示（`:365-368`），按 `omitClaudeMd` 决定是否拼接 CLAUDE.md 块（`:427-431`），按 `skills` 预加载技能（`:409-412`），按 `initialPrompt` 决定首轮用户消息（`:413-417`）。
- **模型解析**：`model` 参数 → 代理定义 `model` → 会话的子代理默认模型 → 父模型（见下文 A 节）。
- **身份与地址簿**：分配 `agentId`、给后台代理自动起名、维护 `$.agent.list()` 的名册、按名/按 id 路由 `SendMessage`。
- **存活与限额**：并发上限、嵌套深度上限、后台调度、完成时投递 task-notification、把「暂停」与「结束」在 Stop 判定里区分开。
- **结果交付（hand-back）**：把子代理的最终答复按一套分类规则（`send` / `flagged` / `withheld`）放进父代理看到的结果。

### 引擎不负责

- **不规定代理类型的内容**：一个类型的 `description`、`prompt`、`whenToUse` 是定义面的事（[08]）；引擎只负责「把它列给模型、按名分发」。
- **不提供团队原语**：没有创建/销毁团队、没有成员表。多个代理之间的「协作」是**点对点消息**（`SendMessage`），不是拓扑结构。
- **不保证子代理一定回答**：`handback: "withheld"` 意味着」**什么都没交付**（`:12613-12614`）——父代理可能拿到一份**空报告**，这是设计内的可能结局，不是 bug。
- **不替模型写 `prompt`**：给子代理的任务描述完全由调用方（模型或插件）撰述；引擎只做改写链，不做摘要或抽取。
- **不跨会话共享 loop**：跨会话的 `SendMessage` 走的是另一套投递（`session.receive`），子代理的 loop 只存在于**本会话**。

### 边界上的一个空洞

**`name` 的唯一性没有契约保证。** `AgentInfo.name` 的文档只说它是「SendMessage 用来寻址的名字」，从未声明同会话内唯一。而 `CHANGELOG.md:4103` 修的正是一个真实后果：「当一个重新派生的代理**复用了前一个代理的名字**时，`SendMessage` 会静默错投——现在工具会检出这个不匹配并要求调用方重新指定目标」。同类条目还有 `:6766`（队友意外地通过 `name` 参数派生嵌套队友）与 `:2534`（同一会话在 `ListAgents` 里出现两次，多了一个同名的幻影 "interactive" 孪生体）。**寻址靠名字、却不保证名字唯一**，是这套设计里最容易被复刻者照搬进坑里的一处。

---

## 关键抽象与接口

### A. 委派的四层输入面

同一个「派生」动作，在不同参与者眼里是四个不同的类型，字段多寡与可改写性各不同：

| 视角 | 类型 | 谁在用 | 字段特征 |
|---|---|---|---|
| **模型面** | Agent 工具输入（`BuiltinToolInputs.Agent`，`:12380-12399`） | 模型写工具调用 | `description`、`prompt`、`subagent_type?`、`model?`、`run_in_background?`、`name?`、`isolation?`；`team_name`/`mode` 已弃用 |
| **插件直派** | `AgentSpawnArgs`（`:221`） | 插件直接 `$.agent.spawn(...)` | 只有 `prompt` 必填 + `description`/`subagentType`/`model`/`name`/`cwd` 可选 |
| **hook 观测/改写** | `AgentSpawnInput`（`:231-294`） | `agent.spawn` 事件的 `e` | 内容字段可改；身份字段 pinned |
| **定义面** | `AgentSpec`（`:354-437`） | `agents/*.md` frontmatter 或 `$.agent.register` | 一个代理类型的全部可配置项 |

**可改写 vs pinned**（`:227-230` 明写）：可改写的是**内容**——`prompt`、`description`、`subagentType`、`model`、`background`、`cwd`；pinned 的是**身份**——`tool_use_id`、`name`、`fork`、`parentModel`、`permissionMode`、`parentAgentId`、`provider`。这条分界很关键：hook 能改「做什么」，不能改「谁在做、以什么权限做、由谁提供」。

**模型解析的四层优先级**（Agent 工具 `model` 文档 `:12387`）：`model` 参数 > 代理定义的 `model` > **会话配置的「默认子代理模型」** > 父模型。第三层在 [08] 里没有对应描述，是本文新增的一层（见「存疑」）。**fork 是例外**：`subagent_type: "fork"` 时 `model`「Ignored…forks always inherit the parent model」。

### B. 上下文隔离：隔离的机制是什么

这是「各种子代理怎么隔离」这个问题的正面回答。隔离**不是**沙箱、不是命名空间，而是**构造一份新上下文，只往里放四类东西**：

1. **系统提示** —— `AgentSpec.prompt` 是「整个」系统提示，「replaces the session's」（`:365-368`）。不是追加，是替换。
2. **指令文件** —— 默认继承 CLAUDE.md 块；`omitClaudeMd: true` 时「the agent's context carries no CLAUDE.md block (the person's, the project's, the rules): it takes what it needs from its prompt」（`:427-431`）。这是**显式的隔离旋钮**：想让子代理不受项目规则影响，就打开它。
3. **预加载技能** —— `skills?: readonly string[]`，「Preloaded into the agent's context before its first turn」（`:409-412`）。
4. **首轮用户消息** —— `initialPrompt`；其中 `{{intent}}` 会被替换成这次派生的 `prompt`。若不给 `initialPrompt`，「the spawn's prompt is the first turn」（`:413-417`）。

**父代理的消息历史不进子代理。** 非 fork 的派生只序列化 `prompt` 一项（`AgentSpawnArgs` 就是 `Pick<AgentSpawnInput, 'prompt'> & Partial<...>`，`:221`）——没有「把父的对话一起带过去」的字段。**必要的背景必须显式写进 `prompt`**，这是设计强加的纪律，也是委派最容易失败的地方（模型忘了传递关键上下文）。

**隔离是双向的，但不对称**：
- 子代理**看不见**父的历史、父的其他子代理、父的当前状态。
- 父代理**能看见**子代理的最终答复（经 hand-back 交付）与它自己写下的 `prompt`（结果里回显 `prompt`，`:12657`/`:12672`/`:12686`）。
- 子代理有**自己的转写文件**（`agent_transcript_path`，`:9573-9591`），所以压缩、resume、回看都是**按 loop 各自发生**的。

**子代理自己压缩自己的上下文。** `SessionCompactInput.agentId` 的文档：「The id of the loop compacting, for a subagent's or a fork's **own transcript**」。也就是说，一个长跑的子代理会独立触发压缩，**与父代理的压缩时机无关**——两者各自维护窗口账本（详见 [11]）。

**跨 run 的持久记忆。** `AgentSpec.memory?: 'user' | 'project' | 'local'`（`:418-422`）——「A persistent memory the agent keeps between runs」。这是隔离的唯一**受控例外**：同一类型的代理多次派生，可以带着上次的记忆起来。

### C. 身份、地址与两级轴

系统对「一个代理是谁」有两套正交的轴，[12] 已点明，这里展开成运行时表格：

| 轴 | 字段 | 含义 | 出处 |
|---|---|---|---|
| **loop 轴**（谁在跑） | `agentId` | 这个 loop 的 id；主 loop 上缺席 | `AgentLoop` `:164-174` |
| | `parentAgentId` / `AgentInfo.parentId` | 派生它的那个 loop；主 loop 派生时缺席 | `:137-141` |
| **origin 轴**（谁引起的） | `next.origin` / `AgentInfo.spawnedBy` | 哪个插件的 `$.agent.spawn`（或 Agent `$.tool.call`）启动了它 | `:142-148` |

**`AgentInfo`（`:117-154`）是运行时名册的一行**：`id`、`description`、`type`（`general-purpose`/`Explore`/…，队友则是 `teammate`）、`status`（`running`/`completed`/`failed`/`killed`/其它）、`parentId?`、`spawnedBy?`、`name?`。

**`name` 是给人用的地址，不是身份。** 文档反复强调：「What SendMessage addresses it by (`Agent({ name })`, or **the engine's own for a background agent**), when it has one; **not `description` or `type`**」（`:149-153`）。两个要点：(1) 后台代理的名字由**引擎**起，调用方不必给；(2) 名字不等于类型标签，别拿 `description` 当地址。

**有些 loop 有 id 但名册里没有。** `AgentLoop.agentId` 文档明说：「**A workflow's agents and the engine's own forks (compaction, memory) carry ids no list names**」（`:169-170`）。即：压缩、记忆这类引擎自派 fork，以及 workflow 内部的代理，都有 `agentId` 参与事件，但 `$.agent.list()` **列不出**它们。复刻时别假设「有 id ⇒ 可被 `SendMessage` 寻址」。

### D. 主 → 子：三条信息通道

| 通道 | 时机 | 承载 | 特点 |
|---|---|---|---|
| **定义面** | 编译期/注册期 | `AgentSpec` 的 `prompt`/`initialPrompt`/`skills`/`tools`/`mcpServers`/`hooks`/`model`/`effort`/`permissionMode`/`maxTurns` | 一次配置，所有派生共享；类型级的「人设」 |
| **派生的 `prompt`** | 每次派生 | 这次任务的全部背景 | **唯一的显式上下文通道**；父必须把必要信息写进去 |
| **运行中的 `SendMessage`** | 子代理跑着的时候 | 一条消息（第一行是收件人预览） | 可在中途追加信息；也可用于叫醒已停的子代理 |

**`SendMessage` 的关键行为**（Agent 工具 `name` 文档 `:12391`）：「Name for the spawned agent. Makes it **addressable via `SendMessage({to: name})` while running**」——注意 **while running**：名字在运行期可寻址，且 `CHANGELOG.md:6491-6492` 记录了「Agent 工具不再接受 `resume` 参数——改用 `SendMessage({to: agentId})`…`SendMessage` 现在会在后台**自动 resume 已停止的代理**」。所以「给一个已完成的子代理发消息」是**合法的唤醒手段**，不是错误。

**`SendMessage` 的字段**（`:12524-12531`）：`to`（名册名/`name [ref]`/队友名/`"main"`/agentId，是个 schema 拼不出的联合类型）、`summary?`（「**not transmitted** — the recipient previews the first line of `message`」）、`message`（第一行是预览）、`notify_when_idle?`（一次性空闲通知，**不轮询**）。结果类型在本次构建里**刻意未定型**（`SendMessage: unknown`，`:13043`）。

**跨会话是同一个工具。** `SendMessage` 不止用于本会话的子代理：它也能发给**另一台机器上的另一个 Claude 会话**（`CHANGELOG.md:3430`），以及云会话。投递在接收侧是一条带 `origin` 的 `UserMessage`（[12] 的会话接收面），`PromptOrigin.kind` 里有两档：`peer`（「Another Claude session sent a message」）与 `peer-send-message`（「Another session's `SendMessage` delivery, **model-authored and framed as a notification**」，`:7063-7066`）。

**两条安全纪律**：(1) 转发来的消息**不携带用户权限**——`CHANGELOG.md:4541`：「messages relayed via `SendMessage` … no longer carry user authority — receivers **refuse relayed permission requests**」；(2) 入站可关——`crossSessionInbound`（示例见 `examples/settings/settings-hipaa.json:54` 的 `"refuse"`），`CHANGELOG.md:3129` 说明拒绝时会向发送方回报「refused」，`:3428` 说明给「已绕过权限的会话」的跨会话消息会**扣留待批准**。

### E. 子 → 主：hand-back 交付

子代理的答复回到父代理时，会被**分类**成三种交付结果之一，这是契约里一个 `@internal` 但语义完整的字段（`:12613-12614`）：

```ts
/** @internal How the report reached this result under the subagent hand-back contract:
 *  'send'    = the child's classified SubagentHandback delivery,
 *  'flagged' = that delivery under a SECURITY WARNING,
 *  'withheld'= nothing was delivered (not a stable consumer field) */
handback?: "send" | "flagged" | "withheld"
```

含义：子代理的产出先经过一次**分类**，正常内容以 `send` 交付；被判为可疑的内容以 `flagged` 交付并**戴上安全警告**；而 `withheld` 意味着**父代理一无所获**。这条设计把「提示注入防护」放在了委派边界上——子代理读过外部内容后，它的「答复」本身是**不可信输入**，父代理拿到的报告带**来源标记**。

配套的三个 `@internal` 记账字段（`:12606-12611`）用于**防篡改**：`harnessNoteCount`（前导 harness 内容块数）、`harnessTailCount`（尾部 harness 内容块数）、`harnessSectionHash`（「把 harness 段落计数**绑定到它们被计算时的确切内容**上；hook 改写会使计数失效，而不是错放被改写的字节」）。即：hook 若改写了结果内容，这套计数**主动失效**而非算出错误的偏移——安全记账的 fail-safe。

**同步形态的结果很厚。** `status: "completed"` 的 Agent 结果（`:12604-12659`）带：`content[]`（最终答复）、`resolvedModel?`、`modelsUsed?`（**长度 > 1 表示运行中途换了模型**，`:12669`）、`totalToolUseCount`、`totalDurationMs`、`totalTokens`、`usage`（含 cache/thinking 明细）、`toolStats`（`readCount`/`searchCount`/`bashCount`/`editFileCount`/`linesAdded`/`linesRemoved`/`otherToolCount`/`frameCount?`）、`prompt`（回显）、`worktreePath?`/`worktreeBranch?`（隔离模式下产物在哪）。这是一份**完整的运行报告**，不只是答复文本。

**后台形态暴露输出文件。** `status: "async_launched"` 带 `agentId`、`description`、`outputFile`、`canReadOutputFile?`（「Whether the calling agent has Read/Bash tools to check progress」，`:12673-12676`）。父代理**可以主动去读这个文件看进度**，而不必干等通知——这解释了为什么 `outputFile` 是后台结果的一等字段。`CHANGELOG.md:6675` 记录的正是它为什么重要：「completion notifications missing the output file path… hard for parent agents to recover agent results **after context compaction**」。

### F. 等待还是继续：本系统的回答

这是「什么情况下主代理可以继续、什么情况该等」的正面回答。系统的立场很清晰：**默认全部继续，把「必须等」压缩成一个由调用方显式申明的例外**。

**判定规则（一句话）**：**只有当「下一个动作依赖这个结果」且「它在跑时无事可做」时，才设 `run_in_background: false`（`:12389-12390`）**。除此之外一律后台。

**「会话结束」vs「会话挂起」由一份在飞清单决定。** `StopHookInput.background_tasks` 的文档（`:9455-9458`）是全篇最吃重的一句：

> 「In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish **'session is done'** from **'session is paused waiting for background work to wake it'**. Empty array when nothing is in flight.」

`BackgroundTaskSummary`（`:550-581`）是这份清单的一项，带友好类型标签（`shell`/`subagent`/`monitor`/`workflow`），且**字段按类型分化**：`command` 只对 `shell`、`agent_type` 只对 `subagent`、`server`/`tool` 对 `monitor`、`name` 对 `workflow`。同一对字段（`background_tasks` + `session_crons`）在 `SubagentStopHookInput` 上**同样存在**（`:9583-9590`）——因为子代理自己也会「等它的后台工作」。

**完成是怎么到达父代理的**：不是父代理轮询，而是子代理自己的 `turn.complete` 携带 `agentId` 触发（`:316-321`），最终作为一条 **task-notification** 投递（`PromptOrigin.kind: 'task-notification'`：「dequeued when the session went idle **or delivered into a running turn**」，`:7047-7052`）。这条通知在转写里是一行 `UserMessage`，带 `task?: UserMessageTask`（`id` = 子代理的 `agentId`、`status` ∈ `completed`/`failed`/`killed`、`durationMs`，`:11238-11273`）。

**唤醒 = 一次带来源标记的重新进入。** `UserPromptSubmit.source` 的取值里有 `loop_wakeup | schedule_wakeup | poll_event`，以及 `system`（「other machine-injected turns (peer/channel messages, task notifications, auto-continuation)」，`:11288-11290`）。也就是说「被后台工作唤醒」在内部就是**又进了一轮 prompt**，只不过来源不是人。

**中断是「轮作用域」的，不是「代理作用域」的。** `$.turn.abort({ turnId })` 只结束**当前这一轮**（`：2478-2489`），并且「Rejects, naming both ids, when `turnId` is not the running turn's」。`CHANGELOG.md:895` 把产品行为说透：「Stop 和 Escape 只结束当前轮；**后台代理继续运行**，可以逐个从 agent 面板停掉」。要停某个具体代理，用 `TaskStop`（`:12548-12553`，接受 agent id 或 name）。

**手动收口的两件工具**：`TaskOutput({ task_id, block, timeout })`（轮询/阻塞等一个后台任务的输出，`:12540-12547`）与 `TaskStop`（停一个任务）。`CHANGELOG.md:4017` 记录其边界修复：「`TaskStop`/`TaskOutput` 找不到**由另一个代理派生的**后台代理——现在报错会列出正在运行的代理及其 id 与描述」。`CHANGELOG.md:6526` 则保证：「杀掉一个后台代理**会保留它的部分结果**」。

**通知的两条出口**：一条是上面那条 `UserMessage`（进上下文），另一条是 `Notification` hook（出到用户表面）。`CHANGELOG.md:4117`：「sessions that need input or finish now fire the `Notification` hook (`agent_needs_input` / `agent_completed`)」，`NotificationHookInput` 是通用载体（`:5378`）。

### G. 隔离模式、并发与深度

**隔离模式（`isolation`）**，两层都有（Agent 工具 `:12397-12398`、`AgentSpec` `:432-436`）：

| 值 | 语义 | 备注 |
|---|---|---|
| `"worktree"` | 建一个**临时 git worktree**，代理在仓库的隔离副本上干活 | 结果里回带 `worktreePath`/`worktreeBranch`；`CHANGELOG.md:505` 修过「主会话进出别的 worktree 后后台子代理在它自己的 worktree 里丢掉写与 Bash 权限」 |
| `"remote"` | 在**远程云环境**启动（「always runs in background; availability is gated」） | 结果是 `remote_launched` 形态，带 `taskId` 与 `sessionUrl` |

**定义级强制后台**：`AgentSpec.background?: true`——「Set so that **every spawn** of the agent runs in the background」（`:423-426`）。而 hook 侧看到的 `background: boolean` 文档给了完整的三方角力：「A rewrite is read back as the call's `run_in_background`. The agent's own definition and remote isolation can **still force it on**, and **disabled background tasks force it off**」（`:287-294`）。即优先级是：**禁用后台 > 定义级/远程强制 > hook 改写 > 调用方默认**。

**限额（全部来自 `CHANGELOG.md`，契约无对应类型）**：

| 限额 | 值 | 出处 |
|---|---|---|
| 并发子代理数 | 默认 **20**，`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 可覆盖 | `CHANGELOG.md:3633` |
| 嵌套深度 | 默认 **3**，`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 可调（设 1 关闭嵌套） | `CHANGELOG.md:3573` |
| 每会话 spawn 总数 | **已移除**上限（原 200） | `CHANGELOG.md:3446` |
| Workflow 内并发代理 | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`（1–256） | `CHANGELOG.md:2125` |
| 预算 | `--max-budget-usd` 到达上限后，新 spawn 被拒、**在跑的后台代理被中止** | `CHANGELOG.md:3635` |

**嵌套的演化史很值得看**（复刻时的警示）：先是「默认不再嵌套」（`CHANGELOG.md:3634`），后改成「默认深度 3，设 1 关闭」（`:3573`），中间还有一次「前台子代理会派生出无界嵌套链，现在与后台共享同一个 5 层上限」（`:4347`）——**前台路径一度比后台路径更松，是一个真实的漏洞形状**。复刻时，嵌套限额必须**同时**施加于前后台两条路径。

### H. 与技能共享的运行时（`context: fork`）

「子代理」和「在 fork 上下文里跑的技能」在本系统里是**同一个运行时**：技能声明 `context: fork` 就落进一个子代理 loop，默认后台（`CHANGELOG.md:7497-7498`、`:3610`），可 `background: false` 关掉。它的结果形态是 `status: "forked"`，带 `agentId`、`result`、`background?`——也就是说**技能的产出同样走「句柄 + 后到」这条路**。复刻时若把技能与子代理做成两套运行时，会重复实现同一件事。

---

## 数据流 / 时序

### 1. 一次后台委派的全生命周期

```
  父 loop（主代理）
  │
  │  模型发一个 Agent 工具调用 ─────────────┐
  │                                        ▼
  │                            ┌───────────────────────────┐
  │                            │ agent.offer  是否列给模型？ │  ← isOffered:false 可隐藏
  │                            └────────────┬──────────────┘
  │                                         ▼
  │                            ┌───────────────────────────┐
  │                            │ agent.spawn   hook 可改写  │  可改：prompt/description/
  │                            │              subagentType/ │       subagentType/model/
  │                            │              model/background/cwd
  │                            │              pinned: tool_use_id, name, fork,
  │                            │                      parentModel, permissionMode,
  │                            │                      parentAgentId, provider
  │                            └────────────┬──────────────┘
  │       ┌─────────────────────────────────┴──── 解析模型（4 层） ─────────────┐
  │       ▼                                                                     │
  │  ┌──────────────────────┐                                    ┌──────────────▼──────────┐
  │  │ run_in_background:   │  否（前台）                        │ 是（默认）               │
  │  │ false                │──────────────┐                     │                          │
  │  └──────────────────────┘              │                     ▼                          │
  │                                        │        ┌────────────────────────┐              │
  │                                        │        │ 分配 agentId（+自动起名）│              │
  │                                        │        │ $.agent.list() 里可见    │              │
  │                                        │        └───────────┬────────────┘              │
  │                                        │                    │                            │
  │                                        ▼                    ▼                            │
  │                       ╔════════════════════════════════════════════╗                    │
  │                       ║  子 loop 启动：新系统提示 + 新消息历史        ║                    │
  │                       ║  （prompt 整份替换；CLAUDE.md 可选；技能预载） ║                    │
  │                       ║  自己的转写文件 agent_transcript_path        ║                    │
  │                       ║  自己的压缩时机 / 自己的窗口账本             ║                    │
  │                       ╚════════════════════════════════════════════╝                    │
  │                                        │                            │                     │
  │   父等这一轮 ──────────────────────────┘                            │                     │
  │   （next 动作依赖它，无别的事可做）                                   │                     │
  │                                                                     ▼                     │
  │                                                       子 loop 跑完 → 它自己的           │
  │                                                       turn.complete（带 agentId）        │
  │                                                                     │                     │
  │                    父代理继续下一轮（不被阻塞）◄────────────────────┘                     │
  │                                                                     │                     │
  │                                                                     ▼                     │
  │                                                      hand-back 分类：send / flagged /    │
  │                                                      withheld → 结果里带 handback 标记     │
  │                                                                     │                     │
  │                                                                     ▼                     │
  │                     一条 task-notification UserMessage（id=agentId,  │                     │
  │                     status, durationMs, outputFile）投递回父会话      │                     │
  │                     ── 空闲时出队，或投进正在跑的轮（turnId 已设）    │                     │
  │                                                                     │                     │
  │                     同时也触发 Notification hook（agent_completed /  │                     │
  │                     agent_needs_input）                              │                     │
```

### 2. 上下文隔离边界（什么进子 loop、什么不进）

```
  父 loop 的上下文                        子 loop 的上下文
  ┌────────────────────────┐              ┌──────────────────────────────┐
  │ 系统提示（会话的）      │──── 被替换 ─▶│ AgentSpec.prompt（整份）       │
  │ CLAUDE.md 块           │── 可选继承 ─▶│ CLAUDE.md 块（omitClaudeMd 关）│
  │ 全部对话历史            │──── ✗ ─────▶│ （不进入）                     │
  │ 其它子代理的答复        │──── ✗ ─────▶│ （不进入）                     │
  │ 当前 TodoWrite 状态     │──── ✗ ─────▶│ （不进入）                     │
  └────────────────────────┘              │ skills 预加载                  │
  ┌────────────────────────┐              │ initialPrompt（{{intent}}→prompt）│
  │ Agent 调用的 prompt     │── 仅此 ────▶│ 首轮用户消息 = spawn 的 prompt  │
  └────────────────────────┘              │ 自己的转写文件                 │
                                          │ 自己的压缩 / 窗口账本           │
    ▲                                     │ memory: user|project|local      │
    │                                     └──────────────────────────────┘
    │  回到父代理的只有：
    └── content[]（最终答复，经 hand-back 分类）+ 运行报告（resolvedModel/
        modelsUsed/toolStats/usage/…）+ 回显的 prompt + worktreePath?
        同步形态：同轮内到；后台形态：结果只含 agentId/outputFile，
        真正的答复之后作为 task-notification 到
```

### 3. 父代理「等待」还是「继续」的判定

```
  Agent 工具调用
        │
        ▼
  ┌───────────────────────────────────────────────┐
  │ 下一个动作是否依赖这个代理的结果？              │
  └───────┬───────────────────────────────┬───────┘
        否│                               │是
          ▼                               ▼
   ┌─────────────┐              ┌──────────────────────────────┐
   │ 后台（默认）│              │ 它在跑的时候，还有别的事可做吗？│
   │ 立即继续    │              └───────┬──────────────┬───────┘
   └─────────────┘                     是│              │否
                                         ▼              ▼
                                  ┌─────────────┐ ┌───────────────────┐
                                  │ 仍后台       │ │ run_in_background:│
                                  │ 继续         │ │ false（前台，等）  │
                                  └─────────────┘ └───────────────────┘

  会话层面的判定（Stop / SubagentStop hook 看得到）：
    background_tasks 为空 且 session_crons 为空  →  会话「结束」
    否则                                          →  会话「挂起，等被唤醒」
```

### 4. hand-back：子代理答复如何到达父代理

```
  子 loop 收轮（turn.complete）─▶ 最终答复
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │ hand-back 分类         │
                        └───┬───────────┬───────┬┘
                            │           │       │
                   正常  ───┘   可疑  ───┘  什么都 ──┘
                            │           │   没交付
                            ▼           ▼       ▼
                        "send"     "flagged"  "withheld"
                      （原样交付）（戴安全警告）（父一无所获）
                            │           │       │
                            └─────┬─────┴───────┘
                                  ▼
                    父看到的 Agent 结果：
                      handback 标记 + harnessNoteCount /
                      harnessTailCount / harnessSectionHash（防篡改记账；
                      hook 改写使计数失效，而非错位）
                                  │
                                  ▼
                    同步：本轮的 tool.call result 里就是它
                    后台：结果只有 agentId/outputFile，
                          真正的答复之后作为 task-notification 进上下文
```

---

## 扩展点

| 扩展点 | 形态 | 能做什么 |
|---|---|---|
| `agent.offer` | 事件（模型面） | 返回 `{ isOffered: false }` 把某个代理类型**从模型的列表里隐藏**并拒绝对它的分发；**不管**插件自己的 `$.agent.spawn`（`:182`、`:3353-3362`） |
| `agent.spawn` | 事件（可改写） | 改写 `prompt`/`description`/`subagentType`/`model`/`background`/`cwd`，或返回 `{ deny }` 拒绝这次派生；身份字段 pinned |
| `$.agent.spawn(args)` | 名词方法 | 插件直接派生子代理；**总是后台**，返回 `{ model, agentId }` 或 `{ deny }`（`:218-219`） |
| `$.agent.list()` | 名词方法 | 返回本会话的子代理（模型的与插件的都在内）`AgentInfo[]` |
| `$.agent.register(spec)` | 名词方法 | 运行时定义一个代理类型，名 `<plugin>:<name>`；可被 `agent.offer` 单独隐藏（`:2703-2728`） |
| `agent.register` | 事件 | `register` 的底层事件（`:5634`） |
| `SubagentStart` | classic hook | 子代理启动时触发，输入 `{ agent_id, agent_type }`（`:9567+`） |
| `SubagentStop` | classic hook | 子代理收轮时触发，输入含 `stop_hook_active`、**`agent_transcript_path`**、`last_assistant_message?`、`background_tasks?`、`session_crons?`；**可以像 `Stop` 一样阻止它停下** |
| `TaskCreated` / `TaskCompleted` | classic hook | 任务（含子代理）创建/完成（`CHANGELOG.md` 演化） |
| `TeammateIdle` | classic hook | 队友进入空闲 |
| `Notification` | classic hook | 通用通知出口；`agent_completed` / `agent_needs_input`（`CHANGELOG.md:4117`） |
| `BaseHookInput.agent_id` / `agent_type` | 所有事件的公共字段 | 区分「这次 hook 是不是在子代理里触发的」；文档明说**用 `agent_id` 而非 `agent_type`**（`:583-609`） |
| `turn.complete` 的 `agentId` | 事件字段 | 按 `agentId` 把子代理的答复回填到父代理的等待表（`:316-321` 的 `got[agentId]` 惯用法） |
| `session.receive` | 事件 | 跨会话入站投递（relay/peer/Remote Control prompt），投递前已消毒（`:9042`） |
| `SendMessage` | 工具 | 点对点寻址：名册名 / `name [ref]` / 队友名 / `"main"` / agentId；跨会话同工具 |
| `ListAgents` | 工具 | 名册（结果为**一段格式化文本** `listing: string`）；`channel`/`q` 参数在本构建里是**空壳**（「Not available in this build; leave unset.」） |
| `TaskOutput` / `TaskStop` | 工具 | 手动轮询/阻塞等输出、停止某个后台任务（接受 id 或 name） |
| `crossSessionInbound` | 设置 | 控制入站跨会话消息：`refuse` 或扣留待批准 |

---

## 设计决策与权衡

**D1 · 委派返回句柄，而不是结果。** 派生在**启动时**就 resolve（`{ model, agentId }`），答复走子代理自己的 `turn.complete`。**收益**：委派天然非阻塞、可并行、可嵌套，且不需要一个新的「等待原语」——父代理只要维护一张 `agentId → 回调` 的表（`:316-321` 的惯用法）。**代价**：调用方必须自己记句柄、自己关联答复；「谁的回答是哪条」变成调用方的责任。

**D2 · 后台是默认，前台要论证。** 与其为「什么时候可以并行」定规则，不如把默认设成并行，把「必须等」压缩成一个显式申明的例外（`:12389-12390`）。**收益**：用户可以在代理跑的时候继续给主代理派活（文档原话：「so the user can hand you other work」）。**代价**：上下文里会**异步地**冒出新报告，提示缓存与上下文账本都要处理「运行中被插入一条消息」（见 [11]）。

**D3 · 隔离靠「构造新上下文」而非「共享后过滤」。** 子代理不继承父的历史，只拿 `prompt` + 定义（`:221`）。**收益**：上下文成本可预测、无泄漏、可把子代理当成一次「纯函数」（输入 prompt，输出报告）。**代价**：**传递必要背景完全是调用方的责任**，模型漏写就失败；这是委派最常见的失败模式。

**D4 · 系统提示是替换，不是追加。** `AgentSpec.prompt`「replaces the session's」（`:365-368`）。**收益**：一个代理类型是**完全可定义的人设**，不受主会话提示污染。**代价**：写代理的人必须**自己重述**所有必要约束；配合 `omitClaudeMd`（`:427-431`）时，代理可以完全脱离项目规则运行——是能力也是风险。

**D5 · 答复要过一遍安全分类（hand-back）。** `send`/`flagged`/`withheld` 三档（`:12613-12614`）+ `harnessSectionHash` 防篡改记账（`:12610-12611`）。**收益**：子代理读过的外部内容不会被父代理**无条件信任**；注入防护落在委派边界上。**代价**：父代理必须处理「**什么都没拿到**」（`withheld`）这种情况——报告可能是空的，调用方不能假设有内容。附带收益：改写使计数**失效而非错位**（fail-safe 记账）。

**D6 · 名字是地址，但不是身份。** `SendMessage` 按 `name` 寻址，`agentId` 才是身份（`:149-153`、`:301`）。**收益**：模型可以用人类可读的名字说话，不必管 id。**代价**：**唯一性无契约保证**，重名会静默错投（`CHANGELOG.md:4103` 修过一次）。复刻时要么加唯一性不变量，要么让寻址**以 id 为准、名字只是别名**。

**D7 · 团队被扁平化成一个隐式团队。** `TeamCreate`/`TeamDelete` 被移除，`team_name` 收下即忽略（`CHANGELOG.md:4383`、`:12393-12394`）。**收益**：没有拓扑对象要维护、要序列化、要处理生命周期；协作退化成**点对点消息**（`SendMessage`），足够且更简单。**代价**：无法表达结构化的协作（谁向谁汇报、广播、角色层级）——这类能力被推给了 `SendMessage` 的上层约定。

**D8 · 一个工具同时用于本会话寻址与跨会话寻址。** `SendMessage` 既能发给子代理，也能发给另一台机器的另一个会话（`CHANGELOG.md:3430`）。**收益**：**一套寻址心智模型**，`ListAgents` 名册统一列出子代理、队友、其它本机会话、Remote Control/云会话。**代价**：跨会话引入**权限边界**问题，于是有了两条纪律——转发消息**不带用户权限**（`:4541`）、可入站可关/可扣留待批准（`crossSessionInbound`）。**这是「统一接口」最典型的隐性代价。**

**D9 · 中断是轮作用域的。** `$.turn.abort({ turnId })` 只结束当前轮（`:2478-2489`）；`CHANGELOG.md:895` 明说后台代理继续跑。**收益**：用户按 Stop 不再误杀一堆后台工作，后台代理可**逐个**停。**代价**：「停」有两个粒度（轮 vs 代理），UI 与 API 都得把两者分开暴露，否则用户会困惑为什么「停了还跑」。

**D10 · 完成是通知，不是轮询。** 子代理收轮 → task-notification 投递（空闲时出队，或投进正在跑的轮 `:7047-7052`）+ `Notification` hook（`:4117`）。**收益**：父代理不必 poll，模型不必写轮询循环。**代价**：通知是**异步插入**上下文的，且**可能丢失**——`CHANGELOG.md:1804`（窗口重载后丢完成通知）、`:6675`（通知缺 outputFile，压缩后难以找回结果）都是这条路径的真实故障；于是 `outputFile` 成了后台结果的一等字段，作为**可主动读取的兜底**。

**D11 · 限额是全局兜底，不是设计约束。** 并发 20（`CHANGELOG.md:3633`）、深度 3（`:3573`）、每会话总数上限**已删**（`:3446`）。**收益**：正常用法不受限。**代价**：这些数字都**不在类型契约里**，只能从 CHANGELOG 反推——复刻时必须自己**显式定义**并发/深度/预算三类限额，并**同时施加于前后台两条路径**（`CHANGELOG.md:4347` 的教训：前台路径一度比后台松）。

**D12 · 技能与子代理共用一个运行时。** `context: fork` 的技能落进子代理 loop，结果形态 `status: "forked"` + `agentId`（`CHANGELOG.md:7497-7498`、`:3610`）。**收益**：**只实现一次**「隔离上下文 + 句柄 + 后到答复 + hand-back」这套机制，技能与子代理都受益。**代价**：两个概念的语义被耦合——`AgentSpec` 的字段（`skills`、`memory`、`isolation`）要同时服务两边。

---

## 对复刻产品的启示

1. **把委派建模成「句柄 + 后到的答复」，不要建模成阻塞调用。** 派生返回 `{ model, agentId }`，答复走子代理自己的 `turn.complete`。父代理维护 `agentId → 回调` 的表。这一条决定后面所有事（并行、嵌套、通知）能不能自然长出来。

2. **默认后台，把「必须等」做成显式申明。** 前台只允许留一句判据：「下一个动作依赖它，且它在跑时无事可做」。不要为「何时可并行」写复杂规则。

3. **上下文隔离 = 构造新上下文，只放四类东西**：新系统提示（整份替换）、可选的指令文件、（可选）预加载技能、首轮用户消息。**父的历史一律不进**。把「传背景」当作**调用方的显式义务**，并在产品层给出可诊断手段（「为什么这个子代理答偏了」）。

4. **给系统提示一个「替换 vs 追加」的明确选择，并默认替换。** 同时提供 `omitClaudeMd` 这类**显式的隔离旋钮**，让「不带项目规则跑」成为一个可见决定，而不是默认行为。

5. **在委派边界上做安全分类（hand-back）。** 子代理的答复是不可信输入：定 `send`/`flagged`/`withheld` 三态，**让调用方必须处理「空报告」**；配套**防篡改记账**（计数 + 内容指纹），并让 hook 改写时**计数失效而非错位**（fail-safe）。

6. **身份与地址分开。** `agentId` 是身份，`name` 是地址。至少做一条：**寻址以 id 为准，名字只是别名**；或对名字加唯一性不变量。否则重名静默错投是迟早的事。

7. **不要引入「团队」这类拓扑对象。** 协作用点对点消息就够。删除 `TeamCreate`/`TeamDelete` 的收益是免掉了整个生命周期；代价（结构化协作）交给上层约定。

8. **后台任务要有一份「在飞清单」，让「结束」与「挂起」可区分。** 在 Stop 判定里暴露 `background_tasks`（+ `session_crons`），**非空 = 挂起等唤醒，空 = 真的结束**。并给每项一个友好类型标签 + 按类型分化的字段。

9. **完成走通知，不走轮询；同时留一条「主动读输出文件」的兜底。** 通知会丢（窗口重载、压缩边界），所以后台结果里**必须**带 `outputFile`，且调用方应有权限去读它。没有这条兜底，长跑任务的结果会在压缩后失联。

10. **中断要分两个粒度，并都暴露出来。** `abort(turnId)` 只结束当前轮；`TaskStop` 停某个具体代理。UI 上把「停这一轮」与「停这个代理」明确分开。**杀代理时保留它的部分结果**。

11. **限额必须显式定义并同时施加于前后台两条路径**：并发数、嵌套深度、预算。别学「前台路径比后台松」这个漏洞形状（`CHANGELOG.md:4347`）。这些数字**写进你自己的类型契约**，不要只留在文档里——本仓库的限额就只在 CHANGELOG 里。

12. **技能与子代理共用一个运行时。** 别做两套「隔离上下文 + 句柄 + hand-back」。`context: fork` 之类的能力应当**复用**子代理机制。

13. **寻址可以统一，但权限不能跟着统一。** 若让一个工具（`SendMessage`）既能发给本会话子代理、又能跨会话/跨机器，那必须同时做：**转发消息不带用户权限**（接收方拒绝转发的权限请求）、**入站可关/可扣留待批准**（对标 `crossSessionInbound`）。统一的是**寻址模型**，不是**权限边界**。

14. **跨 run 的持久记忆是隔离的受控例外，要显式提供。** `memory: user|project|local` 让同一类型代理多次派生能带记忆起来。默认隔离，持久记忆必须**按代理类型显式打开**。

15. **每个代理一份自己的转写与自己的压缩时机。** 子代理的压缩与父代理**无关**，两者各自维护窗口账本。`SubagentStop` 能看到自己的 `agent_transcript_path`，所以「按 loop 回看/导出/resume」是天然可做的。别把子代理的转写并进父转写。

16. **hook 面的分界要钉死：内容可改、身份不可改。** 派生事件允许改写 `prompt`/`description`/`subagentType`/`model`/`background`/`cwd`，但 `tool_use_id`/`name`/`fork`/`parentModel`/`permissionMode`/`parentAgentId`/`provider` **pinned**。这条分界是「可组合性」与「可审计性」的分界线。

---

## 关键文件索引

| 路径 | 关键内容 |
|---|---|
| `mods/types/claude-code.d.ts:88-154` | `AgentCallRecord`（插件直派的返回）、`AgentInfo`（运行时名册一行） |
| `mods/types/claude-code.d.ts:156-174` | `AgentLoop`（loop 轴：`agentId`；workflow/引擎 fork 的 id 不在名册里） |
| `mods/types/claude-code.d.ts:175-212` | `AgentOfferInput`/`AgentOfferResult`（模型面可见性开关） |
| `mods/types/claude-code.d.ts:214-321` | `AgentSpawnArgs`（插件面）、`AgentSpawnInput`（hook 可改写 vs pinned）、`AgentSpawnResult`（句柄惯用法） |
| `mods/types/claude-code.d.ts:354-437` | `AgentSpec` 全字段：`prompt` 整份替换、`omitClaudeMd`、`skills`、`initialPrompt`、`memory`、`background`、`isolation` |
| `mods/types/claude-code.d.ts:550-581` | `BackgroundTaskSummary`（在飞清单的一项，字段按类型分化） |
| `mods/types/claude-code.d.ts:583-609` | `BaseHookInput.agent_id`/`agent_type`（区分是否在子代理内触发） |
| `mods/types/claude-code.d.ts:2685-2729` | `$.agent` 名词：`spawn`/`list`/`register` |
| `mods/types/claude-code.d.ts:7047-7066` | `PromptOrigin`：`task-notification`、`peer`、`peer-send-message` |
| `mods/types/claude-code.d.ts:9455-9462` | `StopHookInput.background_tasks`/`session_crons`（「结束 vs 挂起」判据） |
| `mods/types/claude-code.d.ts:9567-9596` | `SubagentStart`/`SubagentStop`（含 `agent_transcript_path`）、`TeammateIdle`、`TaskCreated`/`TaskCompleted` |
| `mods/types/claude-code.d.ts:10289-10330` | `TurnCompleteFields.agentId`、`TurnCompleteReason`（含 `aborted`） |
| `mods/types/claude-code.d.ts:11226-11290` | `UserMessageFrom`、`UserMessageTask`（通知行）、`UserPromptSubmit.source`（唤醒来源） |
| `mods/types/claude-code.d.ts:12380-12399` | Agent 工具输入（模型面）：`run_in_background`/`name`/`isolation`，`team_name`/`mode` 已弃用 |
| `mods/types/claude-code.d.ts:12524-12553` | `SendMessage`、`TaskOutput`、`TaskStop` 的输入 |
| `mods/types/claude-code.d.ts:12604-12689` | Agent 工具结果的三种形态 + `handback`/`harness*` 记账 |
| `mods/types/claude-code.d.ts:12840-12841`、`:13043`、`:13072-13081` | `ListAgents` 结果（`listing: string`）、`SendMessage`/`TaskOutput` 结果（本构建未定型） |
| `examples/settings/settings-hipaa.json:54`、`examples/settings/README-hipaa.md:77` | `crossSessionInbound: "refuse"` |
| `CHANGELOG.md:4383` | 移除 `TeamCreate`/`TeamDelete`，一个隐式团队 |
| `CHANGELOG.md:6491-6492` | `SendMessage` 取代 Agent 的 `resume`；自动 resume 已停代理 |
| `CHANGELOG.md:4541` | 转发的消息不带用户权限，接收方拒绝转发的权限请求 |
| `CHANGELOG.md:4103`、`:6766`、`:2534` | `name` 唯一性问题的三次真实故障 |
| `CHANGELOG.md:3633`、`:3573`、`:3446`、`:2125`、`:3635` | 并发/深度/总数/Workflow 并发/预算五类限额 |
| `CHANGELOG.md:4347` | 前台子代理曾比后台更松的真实漏洞形状 |
| `CHANGELOG.md:4115`、`:3283` | 子代理默认后台（渐进式铺开） |
| `CHANGELOG.md:4117`、`:4945`、`:6675`、`:1804` | 完成通知（`agent_completed`/`agent_needs_input`、时长、outputFile、丢失场景） |
| `CHANGELOG.md:895`、`:6526`、`:4017` | 轮作用域中断、杀代理保留部分结果、`TaskStop`/`TaskOutput` 跨代理寻址 |
| `CHANGELOG.md:7497-7498`、`:3610` | `context: fork` 技能默认后台，可 `background: false` |
| `CHANGELOG.md:505` | worktree 隔离与主会话 worktree 切换的冲突修复 |

---

## 存疑与待确认

1. **`agentId` 的生成规则与唯一性范围**：契约只说它是「这个 loop 的 id」，未说格式、是否全局唯一、跨 resume 是否稳定。§C 的表格只反映类型，不反映生成规则。
2. **「会话配置的默认子代理模型」这一层**在哪里配置：Agent 工具 `model` 文档（`:12387`）承认它存在（优先级第 3 层），但契约与 `examples/` 里**找不到**对应的设置键。这是 [08] 未覆盖的一层。
3. **hand-back 分类器本身**：`send`/`flagged`/`withheld` 三态由谁判、判据是什么、`SECURITY WARNING` 的文本形状——全部不可见。契约只暴露结果字段。
4. **`harnessNoteCount`/`harnessTailCount`/`harnessSectionHash` 的确切算法**：文档自述是「hand-back provenance bookkeeping」且 `@internal`、「not a stable consumer field」；指纹算法与失效语义不可见。
5. **`name` 的唯一性不变量**：契约未声明；只有三次故障记录（`CHANGELOG.md:4103`/`:6766`/`:2534`）旁证其**不可靠**。复刻时必须自行拍板。
6. **后台任务的调度实现**：并发 20 是硬闸还是软排队？超限时新 spawn 是**等待**还是**被拒**？`CHANGELOG.md:3635` 说预算到限时「new spawns are denied」，但并发到限时的行为未写。
7. **嵌套深度的计量口径**：「深度 3」是从主 loop 数还是从被派者数？`CHANGELOG.md:4347` 提到「5-level depth limit」与 `:3573` 的「depth 3 by default」**数字不一致**，疑为不同时期的两种口径。
8. **`AgentLoop.agentId` 与 `AgentInfo.id` 是否恒等**：文档说 loop 的 id 就是名册给的 id，但又说 workflow/引擎 fork 的 id「不在名册里」——两者的交集边界未明。
9. **`cwd` 的语义**：`AgentSpawnInput` 把 `cwd` 列为可改写字段（`:227-230`），但契约未定义它与 `isolation: worktree` 的相对优先级（先切 cwd 再建 worktree？反之？）。
10. **`mode` 弃用后的权限继承细节**：「子代理继承父会话的权限模式」（`:12395-12396`）——但 `AgentSpec.permissionMode` 仍可覆盖（`:388-394`），两者冲突时的裁决顺序未写。
11. **跨会话 `SendMessage` 的完整投递语义**：`session.receive` 的 `SessionReceiveOrigin.kind` 有 8 个取值，哪些会**唤醒**接收会话、哪些只是排队，不可见；`crossSessionInbound` 也未进契约（只在 `examples/`）。
12. **技能 `context: fork` 的结果何时触发 task-notification**：「默认后台」在 CHANGELOG 里有，但 fork 结果形态（`status: "forked"` + `agentId`）**未出现在 Agent 工具结果联合类型**中——它是另一条结果路径，其投递语义查无实据。
13. **`outputFile` 的格式与保留期**：契约只说它是路径；文件内容格式、被清理的时机、`canReadOutputFile` 为假时怎么办，均不可见。
14. **`estimated` 的 `modelsUsed` 中途换模型**：`length > 1 means a mid-run swap`（`:12669`）——谁触发换模型（引擎降级？预算？）不可见。
15. **队友（`teammate`）与本篇的子代理是否同一 loop 类型**：`AgentInfo.type` 可为 `teammate`，`TeammateIdleHookInput` 存在，`PromptComposeTrait` 含 `'teammate'`——但队友的派生、隔离、hand-back 是否与普通子代理完全一致，契约未分别声明。

---

## 与 `00-overview.md` 漂移清单的关系（本文新增/更正）

- **漂移清单第 9 条的补强**：清单说「`/fork` 与 `/subtask` 尚不触发 `agent.spawn`」。本文补一层：**`context: fork` 的技能**是走子代理运行时的（`CHANGELOG.md:7497-7498`），其结果为 `status: "forked"` + `agentId`。所以「fork 不抛委派事件」与「fork 走子代理运行时」并不矛盾——**契约领先于实现**这一点在技能 fork 上同样成立。
- **新增一层模型解析**：Agent 工具的 `model` 文档（`:12387`）暴露了 [08] 未记载的**第三层「会话配置的默认子代理模型」**（见「存疑」第 2 条）。
- **新增 `handback` 语义**：委派结果里有一个 `@internal` 但语义完整的**安全分类**字段（`send`/`flagged`/`withheld`），以及三个防篡改记账字段。这在 [12] 的「句柄式委派」里没有展开，是委派边界的**安全面**。
