# 12 · 执行链路与 Agent 循环架构分析

> 范围：一轮对话从输入到结束，引擎内部经过哪些阶段；用的是什么 agent 模式；循环如何继续、如何终止、如何被中断、如何被外部接管。
> 证据口径：`mods/types/claude-code.d.ts`（= 契约，事实源）＞ `CHANGELOG.md`（= 行为史，**全文无日期，只有版本号**）＞ 散文文档。另标注 **【本机观测】**：运行中的引擎写到磁盘的转写产物（`~/.claude/projects/**/*.jsonl`，**不在本仓库内**，且是**追加中的活文件**），只作旁证。引擎实现不可见，凡推断一律进「存疑与待确认」。
> 与 [01] 的分工：`01-engine-and-hooks.md` 讲**事件链机制**（`$`、`on`、tier、中间件语义）；本文讲**控制流**——一个 turn 是什么、怎么走完、怎么停下来。两者交叉引用，不重复。

---

## 定位

### 一句话：它是什么模式

**「结构化工具调用循环」+ 「事件中介的控制面」+ 「句柄式委派」，三件套拼出来的一个可挂起、可再入的状态机。**

不是 ReAct。ReAct 的判定标志是「模型用**文本**输出 Thought/Action/Observation，宿主解析文本」。这套架构里**没有文本协议**：模型直接产出带类型的 `tool_use` block，引擎结构化执行，结果以 `tool_result` block 回来。证据在流式契约里——`turn.step` 把模型的输出切成带类型的 chunk，且有一条明确的守卫规则：

> 「一条 block，若它的 `tool` chunk 没从链里出来，就**不是**一次工具调用。」（`claude-code.d.ts:10564-10575`）

也就是说「是不是工具调用」由**类型化的 chunk** 决定，而不是由模型写的文字决定。这是它与 ReAct 类实现最本质的区别。

### 也不是什么

| 常见模式 | 是否 | 证据 |
|---|---|---|
| **ReAct**（文本 Thought/Action/Observation） | ❌ | 无文本解析；`tool_use`/`tool_result` 是结构化 block（`TurnStepChunk` 六种，`:10401`） |
| **plan-and-execute**（独立的规划阶段） | ❌ | **plan 不是循环阶段**，只是 `PermissionMode` 的一个字面量 `'plan'`（`:6073-6076`）；Agent 工具的 `mode` 参数已废弃，子代理改为继承父会话模式（`2.1.211`） |
| **reflexion**（自我批判阶段） | ⚠️ 变体 | 引擎无自我批判阶段，但把**注入反馈的位置**留了出来：`Stop`/`SubagentStop` hook 返回 `additionalContext` 可「给出反馈并让本轮继续」（`2.1.163`） |
| **supervisor / 多代理编排** | ⚠️ 部分 | 有委派（`agent.spawn`）与团队（teammate），但**编排策略写在提示词里**：`code-review` 命令的四阶段扇出是命令文本内的编排，不是引擎特性（`08-agents-and-skills.md:402-414`） |
| **纯 `while` 循环** | ❌ | 它是**挂起/唤醒**状态机：会话可以「结束」也可以「暂停等后台工作唤醒它」（`:9456`） |

### 一个 turn 的解剖

契约与观测对齐（左＝契约事件，右＝【本机观测】的落盘形态）：

| # | 阶段 | 契约 | 观测到的落盘 |
|---|---|---|---|
| 0 | 收到输入 | `prompt.submit`（可返回 `{ drop }`）；`session.receive` 可先 `{ consumed }` | `user` 记录，`message.content` 是**纯字符串** |
| 1 | 开轮 | `turn.start` → `next(e)` 解析为 `{ turnId }` | —（无对应记录） |
| 2 | **发模型请求** | `turn.step`：**每步一次**，流式 | 多个 `assistant` 记录，**每条只带 1 个 block**，共享同一 `message.id`；`apiBlockIndex` 连续 |
| 3 | 执行工具 | `tool.call` → `tool.check` → 执行（一批可并发） | `assistant` 的 `tool_use` block → 紧跟 `user` 记录的 `tool_result` block，**1:1 交替** |
| 4 | 批次收口 | `PostToolBatch`（**一批一次**，区别于逐工具的 `PostToolUse`） | — |
| 5 | **继续判定** | `TurnStepResult.stopReason === 'tool_use'` → 回到 2 | `message.stop_reason`：`tool_use` / `end_turn` |
| 6 | 收轮 | `turn.complete` → `{ text }`，`e.reason` ∈ `answer\|aborted\|refusal\|error` | `system:turn_duration`（末轮/空闲为 `system:away_summary`） |
| 7 | 挂起或结束 | `background_tasks` / `session_crons` | `system.pendingBackgroundAgentCount` |

**关键点：一个 turn 不是一次模型调用，而是一串 `turn.step`。** `turn.step` 的文档写得很直白：

> 「当引擎**将要发出一个 turn 的一次模型请求**时触发，主对话的或子代理的（`e.agentId`）……`next({ ...e, model })` 或 `effort` 换成另一次；**turn、index 与 messageCount 是 pinned 的**。**一个不调 `next` 的应答就不发请求。**」（`:3635-3641`）

所以「turn = 从用户输入到最终答复」，「step = 其中一次模型往返」。循环的**继续条件**就写在 step 结果里：模型这步以 `tool_use` 停下 → 引擎执行工具 → 再发一步；以 `end_turn` 停下 → `turn.complete`。

---

## 职责与边界

**引擎负责**：turn 生命周期（start/step/complete/abort）、步进与继续判定、工具派发与**批次并发**、权限判定、终止判定、子代理委派与生命周期、**挂起与再入调度**、错误恢复与自动续写。

**引擎不负责**（复刻时别做进内核）：

- **编排策略**。谁派几个代理、按什么顺序，写在提示词/命令里，不由引擎规定。
- **思考协议**。没有「请先输出 Thought」这类提示词工程约定；thinking 是模型的 block 类型，不是循环的一步。
- **任务清单**。todo/task 工具正在被**主动弃用**：新模型上默认不提供，需 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 才恢复（`2.1.233`、`2.1.268`）。这说明「让模型自己维护待办」被判定为不如让模型直接行动。

**边界**：循环的调度器、并发实现、重试实现都在引擎内部，本仓库不可见。

---

## 关键抽象与接口

### A. turn 三元组（+ 一个 abort）

| 事件 | 输入类型 | `next(e)` 解析为 | 可否改写 |
|---|---|---|---|
| `turn.start` | `TurnStartInput`（`:3633`） | `{ turnId }` | **否**——「Observe: a different return changes nothing」 |
| `turn.step` | `TurnStepInput`（`:10427`） | 整条响应 | **仅 `model` / `effort`** |
| `turn.complete` | `TurnCompleteInput`（`:3651`） | `{ text }`（答复） | 可改**展示文本**，不改写转写 |
| `turn.abort` | op（`:5599`） | `void` | 取消正在跑的 turn，「其运行中的工具被停止」 |

`turn.step` 的输入就是「这一步的旋钮」：

```ts
// claude-code.d.ts:10427-10461
export type TurnStepInput = {
    turnId: string;      // Pinned：子代理循环里，就是它 turn.complete 会携带的那个 id
    index: number;       // Pinned：本 turn 内的步号，从 0
    model: string;       // 可改写
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number;  // 可改写
    messageCount: number;// Pinned：转写不在这个事件上，它就是引擎的
    agentId?: string;    // Pinned：子代理的循环 id，主对话缺席
};
```

「转写不在事件上」是刻意的：事件只携带**计数**，要看内容得走 `$.session.messages()`。这避免了把整段对话在链上传来传去。

`turn.complete` 的改写语义也值得抄：可以返回一个不同的 `text`「显示在答复下方（一段梗概、一行 TL;DR）」，但**转写的记录永远不会被重写**（`:3647-3649`）。即：展示层可加戏，事实层不可篡改。

### B. 两层「停止原因」——循环判定的核心

这是最容易看错的地方：**有两个不同的类型，管两件不同的事。**

```ts
// claude-code.d.ts:10596 —— 步级：模型这一步为什么停（API 语义）
type TurnStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
                   | 'pause_turn' | 'compaction' | 'refusal'
                   | 'model_context_window_exceeded' | null;

// claude-code.d.ts:10328 —— 轮级：这个 turn 为什么结束（产品语义）
export type TurnCompleteReason = 'answer' | 'aborted' | 'refusal' | 'error';
```

- 步级 `'tool_use'` → **继续**（执行工具，再来一步）。步级 `'end_turn'` → 收轮，轮级 `'answer'`。
- 步级 `'max_tokens'` → 触发**自动续写**（见「设计决策」第 10 条）。
- 步级 `'compaction'` → 压缩接管（见 [11]）。
- 轮级 `'aborted'` ↔ `TurnCompleteFields.isAborted`：「该轮以中断结束（`reason === 'aborted'`）」（`:10289-10291`）。

`TurnCompleteInput` 还分岔出 `TurnCompleteRefused { reason: 'refusal'; refusal: TurnRefusal }`，`TurnRefusal = { category, explanation }`（`:10334-10366`）——即**拒答是一等结果**，不是一个错误字符串。

### C. 工具派发：一个信封、三种结局、两条通道

```ts
// claude-code.d.ts:9797 / 10028-10039
ToolCallInput = ToolCallEnvelope & AgentLoop;
ToolCallEnvelope = { tool: Name; tool_use_id: string } & Arguments;  // e.command 就在旁边（Bash）
```

`tool`、`tool_use_id`、`agentId` 三者 **reserved**：「对其中任何一个的改写都会被拒绝」（`:9789-9795`）。工具自己声明的 `tool.call` 语义是：

> 「当引擎将**要运行**一个工具时触发。`next(e)` 运行下层 hook，然后是 core（**权限提示、工具本身**）。返回 `{ deny: reason }` 拒绝，或返回 `{ result }` 自己应答；**一个 hook 在它的 `next` 还挂着时返回，就会中止下层要跑的东西**。」（`:3244-3251`）

`ToolCallResult` 是三分支联合（`:9832-9903`）：

| 分支 | 形状 | 模型的感受 |
|---|---|---|
| 拒绝 | `{ deny: string }` | 「模型把这个文本当作**错误结果**收到」——拒绝是**喂回模型的信息**，不是死胡同 |
| 应答 | `{ result; context?; ref?; text? }` | 正常结果 |
| 出错 | `{ isError: true; result; ... }` | 错误结果 |

**最值得抄的设计：`result` 与 `context` 分离。**

> `context`：「**模型在工具结果之后读到、而用户永远看不到的东西**……超过 100,000（合计 200,000）就保留头 + 路径。」（`:9853-9861`）

也就是说工具结果有**两个受众**：给人看的部分（界面）和只给模型看的补充说明。**同一份数据可以既保持界面干净、又让模型拿到足够上下文。** 还有一个保留键 `consent`：「引发这次调用时，人自己说的话」（`:9816-9820`）——为人工批准留了结构化的合法性来源。

### D. 权限判定在链中的位置

- 事件：`tool.check`（函数 hook，`:3264`）+ classic 的 `PermissionRequest` / `PermissionDenied` / `PreToolUse`。
- **注意：没有 `permission.*` 事件名词**。权限不是独立阶段，是**工具调用链上的一次判定**。
- 时机被文档钉死：「在 `tool.call` 与 PreToolUse hook **之后**、在模式裁决一个 ask **之前**触发」（`:3254-3259`）。
- 三值 `ToolCheckDecision = 'allow' | 'ask' | 'deny'`（`:9915`）；`ToolCheckResult.rule?` 携带**规则名**（可重放，见 [06]）。
- 「最后一句在链上的人说了算」：`{ decision }` 由链上最后返回者决定（`:9948-9950`）。
- `$.tool.check` 跑**同一条链但什么都不执行**（`:3258-3259`）——这让「预演权限」成为可能（[07] 里的 diff/plan 需要它）。

### E. 委派：句柄，而不是返回值

```ts
// claude-code.d.ts:312-345（含契约自带的示例代码）
export type AgentSpawnResult = { model: string; agentId?: string; deny?: undefined }
                            | { deny: string; model?: undefined; agentId?: undefined };
```

> 「它和 `$.agent.spawn(input)` 在**子代理启动时**就解析；**它的答复是它自己的 `turn.complete`，携带这个 `agentId`**。留住这个 id，把 `got[agentId]` 设成「在等待的东西」；一个 `turn.complete` hook 会解析它：
> `on("turn.complete", ($, e, next) => (got[e.agentId]?.(e.answer), next(e)))`」（`:316-322`）

**这是整套设计里最漂亮的一处**：委派返回的是**句柄**而不是结果，结果通过**同一个 `turn.complete` 事件按 `agentId` 回填**。于是：

- 父循环不被阻塞（后台委派是默认，`2.1.232`）；
- 「等待子代理」不需要新机制，只是父级在一个 map 里挂了个 promise；
- 子代理循环**不抛 `turn.start`**，只有它的 `turn.step` 带 `turnId`、`turn.complete` 带 `agentId`（`:10293-10295`）。

`agent.spawn` 输入里 **pinned** 的是：`tool_use_id`、`name`、`fork`、`parentModel`、`permissionMode`、`parentAgentId`、`provider`；**可改写**的是：`prompt`、`description`、`subagentType`、`model`、`background`、`cwd`（`:224-229`、`:286`）。`fork: true` 的子代理「继承父级的上下文与模型，且 `model` 被忽略」（`:299`）。

### F. 挂起与再入（循环不是 `while`）

```ts
// claude-code.d.ts:9448-9463
type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;                  // 递归保护位
    last_assistant_message?: string;            // 免去解析转写
    background_tasks?: BackgroundTaskSummary[]; // 进行中的后台工作
    session_crons?: SessionCronSummary[];       // 之后会唤醒本会话的定时任务
};
```

`background_tasks` 的文档就是这套状态机的自述：

> 「本会话注册的**进行中**后台工作（运行中/待处理 + 已转后台）。让 hook 能区分「**会话已完成**」与「**会话暂停、在等后台工作唤醒它**」。」（`:9456`）

`BackgroundTaskSummary` 的类型是 `shell | subagent | monitor | workflow`（`:550-581`）——**四种后台工作**，每一种都能成为唤醒源。`session_crons` 则涵盖 `CronCreate`、`ScheduleWakeup`、`/loop`（`:9460`）。

再入的入口在 `prompt.submit` 的 `source`：除了人打的，还有 **`loop_wakeup`、`schedule_wakeup`、`poll_event`**（`:11284-11290`）——即「这一轮不是人发起的，是循环/排程/轮询唤醒的」。配合 `PromptSubmitInput.turnId`：「一个**在 turn 运行中**被提交的 prompt……**排队投递**（比如某个 peer 会话的消息）会在一轮运行中到达模型」（`:7206-7214`），以及「引擎**无论哪种**都会把 turn 中输入的 prompt 排队」（`:7215-7223`）。

### G. 中断与预算

| 机制 | 语义 | 依据 |
|---|---|---|
| `next.signal` | 「当这次 dispatch 所属的调用被放弃时中止：**用户中断了**、上方的 hook 先定了、或本 hook 超了预算」 | `:5256` |
| `next.budget` | `{ ms, remainingMs }`——hook **限时** | `:5301`、`:5315-5325` |
| `$.turn.abort` | 取消正在跑的 turn，「其运行中的工具被停止」；`turnId` 不匹配则拒绝 | `:2478-2487` |
| 中断的可见后果 | 轮级 `reason: 'aborted'` | `:10328`、`:10289-10291` |

**中断是「轮作用域」的**：`2.1.286` 起 VS Code 里「Stop 与 Escape 只结束当前 turn，**后台代理继续运行**，可在 agent map 里逐个停」。这是个重要的产品决策——中断用户交互，但不杀掉已经派出去的自主工作。

---

## 数据流 / 时序

### 主循环

```
用户输入 / 排队消息 / 唤醒（loop_wakeup|schedule_wakeup|poll_event）
      │  prompt.submit（可 drop）→ session.receive 可 consumed
      ▼
  turn.start ──► { turnId }                     ← 只读，不可改写
      │
      ├──────────────────┐
      ▼                  │  （stopReason === 'tool_use' 时回到 turn.step）
  turn.step（index=0,1,2,…）                      ← 可改写 model / effort
      │  流式 chunk：text | thinking | tool | input | stop | engine
      │      └─ 「没有 tool chunk 的 block 就不是工具调用」
      ▼
  TurnStepResult { answer, toolUses[], stopReason, usage }
      │
      ├─ stopReason === 'tool_use'
      │     ▼
      │   工具批次（可并发 N 个）
      │     每个：tool.call ─► hook 链 ─► tool.check ─► core
      │                                  （allow | ask | deny）
      │            deny → 文本作为错误结果喂回模型
      │            结果分两路：result（给人）/ context（只给模型）
      │     ▼
      │   PostToolBatch（一批一次）
      │     └────────────► 回到 turn.step（下一个 index）
      │
      ├─ stopReason === 'end_turn' → 收轮
      ├─ stopReason === 'max_tokens' → 自动续写（截断继续）
      └─ stopReason === 'compaction' → 压缩接管 [11]
      ▼
  turn.complete ──► { text }（可加展示用梗概，转写不改写）
      │  hook 可返回 additionalContext 给出反馈并让本轮继续
      ▼
  Stop 事件 ──► 放行 / block（重灌 reason 作为新输入）/ preventContinuation
      │
      └─ background_tasks / session_crons 非空？→ 会话**挂起**，等唤醒再回到顶部
```

### 工具批次并发

契约只在 classic hook 的文档里承认并发：

> 「每一批工具调用**全部**解决后触发一次，在下一次模型请求之前。`PostToolUse` **逐工具**触发，且对并行工具调用**可能并发运行**；`PostToolBatch` 恰好一次，携带整批。」（`:6344`）

【本机观测】：一个 `message.id` 内的 `tool_use` 数量分布为 `{0:19, 1:18, 2:12, 4:3, 10:1}`——**最多同批 10 个工具调用**。而转写把每个 `tool_use` 与它自己的 `tool_result` **成对交替**写入（`apiBlockIndex` 连续、`tool_result` 的 `parentUuid` 指向对应 `tool_use` 的 `uuid`），所以**文件顺序看起来是串行的，实际那批是并发的**。读转写时若把它当串行会得出错误结论——这一点尤其值得复刻者注意。

### 子代理委派（父子两条循环）

```
父循环 turn.step
   │  模型产出 tool_use: Agent
   ▼
agent.offer（列出时 / dispatch 时同一事件；可 { isOffered:false } 隐瞒）
   ▼
agent.spawn（模型尚未解析）
   │  pinned: tool_use_id/name/fork/parentModel/permissionMode/parentAgentId/provider
   │  可改: prompt/description/subagentType/model/background/cwd
   ▼
AgentSpawnResult { model, agentId }   ← 立即解析（句柄）
   │
   ├─ 父循环继续（默认后台，不阻塞）
   │
   ▼
子循环：自己的 turn.step 序列（携带 agentId）
   │     · 不抛 turn.start
   │     · 独立上下文窗口；其 tool.call 带 agentId
   ▼
子循环 turn.complete（携带 agentId）──► 父级在 got[agentId] 上解析
```

**并发与深度的护栏**（都是版本演进出来的）：并发子代理**上限默认 20**（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`，`2.1.217`）；**默认禁止子代理再派子代理**（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`，`2.1.217`）；曾有的「每会话 200 个」上限被**移除**（`2.1.224`），改由并发与深度约束。`--max-turns` 到顶的子代理**返回部分结果并标注 partial**，附「用 `SendMessage` 继续它」的提示（`2.1.246`）。

【本机观测】：这两份父级转写里**没有任何 `isSidechain: true` 的记录**——子代理的对话**不**作为 sidechain 混进父转写；父级只留下 `toolUseResult.agentId`（含 `canContinueAgent`、`canReadOutputFile`、`outputFile`、`isAsync`、`resolvedModel`、`status`）。**子代理有自己独立的转写文件。**

### 中断、挂起、再入

```
Esc / Stop ──► turn.abort（轮作用域）→ turn.complete{ reason:'aborted' }
                 └─ 后台代理**不被杀**（2.1.286：可逐个停）

排队消息 ──► queue-operation（enqueue → dequeue）在 turn 之间流转
                └─ 【本机观测】总是紧跟在 system:turn_duration 之后、下一条 user prompt 之前

后台工作完成 / 定时到期 ──► 唤醒 → prompt.submit(source=loop_wakeup|schedule_wakeup|poll_event)
```

【本机观测】的 turn 边界确认：一个 turn 由「`user` 提示记录」开始，以 **`system:turn_duration`** 结束（最后一个 turn 用 **`system:away_summary`**，它是唯一带 `content` 的 system 记录）。`assistant` 记录**每条只带一个 content block**（`message.content` 长度恒为 1），同一 `message.id` 下的多条记录拼成一条逻辑消息，块序稳定为 **thinking → text → tool_use…**。`user` 记录的 `message.content` 有两种形态：**纯字符串**（真人提示 / 注入的通知）或**长度 1 的列表且是 `tool_result` block**（工具结果），另有兄弟字段 `toolUseResult` 存放结构化载荷。

---

## 扩展点

| 想做的事 | 挂在哪 | 怎么做 | 依据 |
|---|---|---|---|
| 观察每一轮开始 | `turn.start` | 只读；返回值无效 | `:3629-3632` |
| **换模型/换思考档位（按步）** | `turn.step` | `next({ ...e, model \| effort })` | `:3635-3641` |
| **彻底不请求**（拦截这一步） | `turn.step` | 不调 `next` 直接返回 | 同上 |
| 给答复加展示用梗概 | `turn.complete` | 返回不同 `{ text }`（转写不改） | `:3647-3649` |
| 拒绝/自己应答一次工具调用 | `tool.call` | `{ deny: reason }` / `{ result, context }` | `:3244-3251` |
| 预演权限、不改状态 | `$.tool.check` | 跑同一条链，不执行 | `:3258-3259` |
| 改写工具入参 | `PreToolUse` hook | `updatedInput`（会按 schema 复验） | `:6488-6494` |
| 改写模型看到的工具输出 | `PostToolUse` hook | `updatedToolOutput` / `updatedMCPToolOutput` | `:1029-1036` |
| 隐瞒某个代理类型 | `agent.offer` | `{ isOffered: false }`（列表隐藏 + dispatch 拒绝） | `:3344-3351` |
| 改写或否决委派 | `agent.spawn` | 改写可改字段，或 `{ deny: reason }` | `:3355-3360` |
| **让本轮不要结束** | `Stop` / `SubagentStop` | `{ decision: "block", reason }`（reason 作为新输入继续） | `2.1.105` / `:977-981` |
| 给反馈但继续 | `Stop` / `SubagentStop` | `hookSpecificOutput.additionalContext` | `2.1.163` |
| **强制彻底停止** | 任意 hook | `preventContinuation: true`（语义于 `2.1.92` 恢复） | `:982-989` |
| 结束后的错误处理 | `StopFailure`（`2.1.78`） | API 错误致轮结束时触发 | `:9441` |
| 整批工具后动作 | `PostToolBatch` | 一批一次 | `:6344-6349` |
| 会话开局注入 | `SessionStart` | `additionalContext` / `initialUserMessage` / `reloadSkills` | `:976-1052` |
| 取消正在跑的轮 | `$.turn.abort` | `{ turnId }` | `:2478-2487` |
| 排程唤醒自己 | `CronCreate` / `ScheduleWakeup` / `/loop` | 到期以 `schedule_wakeup` 再入 | `:9460`、`:11284-11290` |

---

## 设计决策与权衡

**1. 循环本身是公开契约，且「可改 / 不可改」是精心划分的。** `turn.step` 只放开 `model` 与 `effort`，钉死 `turnId`/`index`/`messageCount`/`agentId`；`tool.call` 只放开参数，钉死 `tool`/`tool_use_id`/`agentId`。这条线就是**「可观测性与可干预性」的边界**：足以改写策略（换模型、换档位、换提示、拒绝调用），不足以伪造身份或破坏记账。复刻时这条线要一次划对，事后加钉子会破坏兼容。

**2. 终止权外置，并且为此配了三道防失控闸。** 循环何时结束，可以被外部 hook 否决（`Stop` block）/强制（`preventContinuation`）。这非常强，所以必须有闸：
- **连续阻断 8 次**后该轮以警告结束（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`，`2.1.143`）；
- 每个模型调用**一份重试预算，默认最多 14 次请求**（`2.1.286`），非流式回退**共享**同一预算而非新开一套（`2.1.285`）；
- auto 模式安全判定**连续拒绝 10 次**后停轮并给出说明，且拒绝会退避（`2.1.244`）。

> 复刻时的教训：**把「外部可控制循环生死」做成一等能力，就必须同时把「外部控制失灵」做成一等防护。**

**3. 两层 stop reason：步级用 API 语义，轮级用产品语义。** `TurnStopReason` 直通 API（`end_turn`/`max_tokens`/`tool_use`/`refusal`/`pause_turn`/`model_context_window_exceeded`…），`TurnCompleteReason` 是产品概念（`answer`/`aborted`/`refusal`/`error`）。分开的好处：**供应商的枚举变化不会污染产品层的终止语义**——这也解释了为什么「续写」能作为独立机制存在（它只关心步级 `max_tokens`）。

**4. 工具结果有两个受众。** `result` 给人看，`context` 只给模型看，且超限时「保留头 + 路径」（`:9853-9861`）。`consent` 保留键把「人当初是怎么批准的」结构化留下来。这是**人机混合**场景里很关键的一块——UI 要干净，模型要够用。

**5. 委派返回句柄，结果用同一个事件回填。** 见「关键抽象 E」。收益：后台默认、父不阻塞、等待机制零新增；代价：**必须靠 `agentId` 关联**，因此 `agentId` 必须是 pinned 的，且子循环的命运要能被单独观察（`SubagentStart`/`SubagentStop`）。

**6. 权限在链中，不是循环外的一个阶段。** 且演进方向一致地「**不可被降级**」：`permissions.deny` 压过 PreToolUse 的 `ask`（`2.1.101`）；hook 的 `ask` 把 auto 模式的裁决**兜底到至少一次提示**（`2.1.243`）；PreToolUse 改写入参后要**重新过** deny 与安全规则（`2.1.296`）；匹配 PreToolUse 失败时该调用**直接阻断**（`2.1.269`）。见 [06]。

**7. 中断按「轮作用域」划分。** Esc/Stop 只结束当前 turn，后台代理继续（`2.1.286`）。这是「人在回路」与「自主工作」的解耦：用户收回交互权，但不摧毁已派出去的并行工作。

**8. 循环是挂起/唤醒状态机，不是 `while`。** `background_tasks` + `session_crons` + `prompt.submit.source` 的 `loop_wakeup`/`schedule_wakeup`/`poll_event` 三者合起来，才构成「会话可以停下、且稍后自己醒来」的能力。这直接决定了**进程必须能持久化「我在等什么」**，也是 `2.1.292` 那类修复（一次性运行不再 5 秒后杀掉后台命令、不再丢掉排程唤醒）存在的理由。

**9. 对「模型幻觉工具调用」有类型级防御。** 「没有 `tool` chunk 的 block 就不是工具调用」（`:10564-10575`）——**链被过滤掉的工具，不会因为模型写了它的名字而真的执行**。配合 malformed tool call 的重试会把**坏输出从重试上下文中丢掉**（`2.1.251`），以及「模型在 `--max-turns` 下交替产出不可解析工具调用与输出截断时无限重试」的修复（`2.1.281`）。

**10. 失败默认导向「继续」而不是「报错」。** 一整套续写/恢复机制：输出被截断 → **自动续写**（`2.1.269`，spinner 文案 "picking the thought back up"）；非交互会话中途断流 → **自动继续**（`2.1.246`）；子代理被切断 → **自动继续**（`2.1.257`）；流中途报错 → **保留已到达的部分**并标注不完整（`2.1.199`）；只返回 thinking block → **重提示一次**（`2.1.183`）；内容过滤器在思考中途掐断 → **重试一次**（`2.1.290`）。

**11. 无 ReAct 文本协议带来的直接收益：一切类型化。** 块的种类（text/thinking/tool/input/stop/engine）、工具调用（`tool_use`）、工具结果（`tool_result`）、拒答（`TurnRefusal`）、停止原因（两层枚举）全是类型。**没有需要正则解析的「Thought:」前缀**，也就没有对应的解析崩溃面。

**12. 已知缺口（值得复刻者引以为戒）**：`mods/agents-md/README.md:95` 自述「`/fork` 或 `/subtask` 的 fork **尚不**触发 `agent.spawn`，且从空集合开始，就像此前所有 fork 一样」——而契约把 `agent.spawn` 说成「Agent 工具将要启动子代理时触发」并让 `fork` 成为它的 pinned 字段。**契约与实现在此处有偏差**，README 用 "yet" 承认了它。这是「先冻结事件目录、再写实现」这条承重墙的反例（见 [00] 原则 1）。

---

## 对复刻产品的启示

1. **把「轮」和「步」在类型上分开，别混用。** 轮 = 一次用户意图（`turn.start`→`turn.complete`），步 = 一次模型往返（`turn.step`）。循环的继续条件写在**步的结果**里（`stopReason === 'tool_use'`），不是写在轮的末尾。混成一个概念后，你无法表达「模型在一步里同时回答并调工具」。
2. **直接抄两层停止原因。** 步级用供应商枚举（`end_turn`/`max_tokens`/`tool_use`/`refusal`/…），轮级用你自己的产品语义（`answer`/`aborted`/`refusal`/`error`）。这层隔离让「截断续写」「压缩接管」能各自独立演进。
3. **把「循环可被外部否决」做成一等能力，然后立刻配齐三道闸。** 否则一个写错的 Stop hook 就能让你的产品无限烧钱。本仓库的数值可直接借用：连续阻断 8 次封顶、每次模型调用一份 ≤14 次请求的预算、连续拒绝 10 次停轮。
4. **委派返回句柄 + 用同一个完成事件回填。** `spawn → { model, agentId }`，子代理的答复就是它自己的 `turn.complete`（带 `agentId`）。父级只是在 map 上挂了个 promise。**别为「等子代理」发明第二个等待机制。**
5. **pinned 字段的选择就是你的安全边界。** 钉住身份与记账（`tool`/`tool_use_id`/`agentId`/`turnId`/`index`/`messageCount`），放开策略（`model`/`effort`/`prompt`/参数）。`tool_use_id` 可改写等于允许伪造调用链；`messageCount` 可改写等于允许对记账撒谎。
6. **工具结果区分「给人看」与「给模型看」。** 一个 `result`、一个 `context`，超限保留头 + 路径。这是唯一能让 UI 保持干净、同时不阉割模型上下文的做法。顺带把「人批准时说的话」结构化留下来（`consent`）。
7. **拒绝是喂回模型的信息，不是终点。** `{ deny: reason }` 的语义是「模型把这个文本当作**错误结果**收到」。让模型知道为什么被拒，它才会换路子，而不是卡死重试。
8. **权限做成链上的一次判定（`tool.check`），并把「不可降级」写死。** deny 必须压过 ask；hook 的 ask 必须至少等于一次提示；改写入参后必须重过规则。再提供「只跑链不执行」的预演入口（`$.tool.check`）给 diff/plan 这类场景。
9. **中断是轮作用域的，后台工作不连带被杀。** 否则用户一按 Esc，派出去的 20 个子代理全废——而它们可能只差一步就出结果。
10. **把循环实现成挂起/唤醒状态机，并持久化「我在等什么」。** 需要三类唤醒源（后台任务完成、定时任务、外部轮询）和一条「谁唤醒了我」的来源标记（`loop_wakeup`/`schedule_wakeup`/`poll_event`）。这也是「会话可以跨进程重启继续」的前提。
11. **给工具调用做类型级防幻觉。** 用流式 chunk 决定「这次到底有没有工具调用」，而不是相信模型输出的文本里写了工具名。链过滤掉的工具绝不能被执行。
12. **失败默认续，不默认报错。** 输出截断、流中断、连接丢失、只回 thinking block——都应先尝试自动继续/重试一次，并把已到达的部分保留下来标注不完整。但每一类续写都要有次数上限（见启示 3）。
13. **工具批次并发要在类型上可观测。** 转写里 1:1 交替写入会**伪装成串行**——如果你也这样做，务必提供一个「一批一次」的事件（对标 `PostToolBatch`），否则集成方会写出错误的时序假设。同时给批次设并发上限与深度上限（本仓库：并发 20、默认禁嵌套）。
14. **不要给模型加它不需要的阶段。** 这个仓库把 todo/task 工具在新模型上**默认关掉了**（`2.1.233`/`2.1.268`），plan 也只是权限模式的一个字面量而非独立循环阶段。用户要的是「把事做完」，不是「先列清单再规划」。**每加一个强制阶段，都是给每一次循环征税。**

---

## 关键文件索引

| 路径 | 内容 |
|---|---|
| `mods/types/claude-code.d.ts:3629-3651` | `turn.start` / `turn.step` / `turn.complete` 的事件文档（pinned 与可改写规则） |
| `mods/types/claude-code.d.ts:10420-10461` | `TurnStepInput`（一步模型请求的全部旋钮） |
| `mods/types/claude-code.d.ts:10487-10515` | `TurnStepResult`（`stopReason` 在这里） |
| `mods/types/claude-code.d.ts:10401-10590` | `TurnStepChunk` 六种 + `TurnStepToolChunk`「tool chunk 定生死」 |
| `mods/types/claude-code.d.ts:10596` | `TurnStopReason`（步级） |
| `mods/types/claude-code.d.ts:10322-10366` | `TurnCompleteInput` / `TurnCompleteReason` / `TurnRefusal`（轮级） |
| `mods/types/claude-code.d.ts:312-345` | `AgentSpawnResult`（句柄式委派 + 回填示例代码） |
| `mods/types/claude-code.d.ts:231-310` | `AgentSpawnInput`（pinned / 可改写清单） |
| `mods/types/claude-code.d.ts:164-174` | `AgentLoop.agentId`（子循环的轴） |
| `mods/types/claude-code.d.ts:9797-9903` | `ToolCallInput` / `ToolCallEnvelope` / `ToolCallResult` 三分支 |
| `mods/types/claude-code.d.ts:9915-9969` | `ToolCheckDecision` / `ToolCheckResult` |
| `mods/types/claude-code.d.ts:3244-3264` | `tool.call` / `tool.check` 事件文档（链中位置） |
| `mods/types/claude-code.d.ts:9448-9463` | `StopHookInput`（`background_tasks` / `session_crons`） |
| `mods/types/claude-code.d.ts:6343-6356` | `PostToolBatch`（批次并发唯一的契约陈述） |
| `mods/types/claude-code.d.ts:550-581` | `BackgroundTaskSummary`（shell/subagent/monitor/workflow） |
| `mods/types/claude-code.d.ts:5230-5325` | `next.signal` / `next.budget` / `next.trace` |
| `mods/types/claude-code.d.ts:6073-6076` | `PermissionMode`（`'plan'` 只是一个字面量） |
| `mods/types/claude-code.d.ts:12380-12399` | Agent 工具的 schema（含已废弃的 `mode`） |
| `plugins/ralph-wiggum/hooks/stop-hook.sh` | 用 `Stop` hook 造出的完整自治循环（`07-hooks-system.md:375-381`） |
| `plugins/security-guidance/hooks/hooks.json:57-69` | `asyncRewake`：Stop 后的异步review 注入 |
| `CHANGELOG.md` | 行为史；关键锚点：`8681`(0.2.70 并行+ESC)、`8672`(0.2.74 Task 工具)、`8664`(0.2.75 排队)、`8610`(0.2.108 实时转向)、`8421`(1.0.41 Stop/SubagentStop 拆分)、`8320`(1.0.60 子代理)、`7716`(2.0.64 异步唤醒)、`5005`(2.1.143 阻断上限 8)、`3633`(2.1.217 并发 20/禁嵌套)、`3283`(2.1.232 fork 与后台默认)、`874`(2.1.286 重试预算 14)、`2126`(2.1.269 截断自动续写) |

---

## 存疑与待确认

1. **引擎实现不可见。** 本文所有时序都是从事件文档 + 转写观测**反推**的；步与步之间是否还有未暴露的子阶段，无从得知。
2. **`index` 与工具批次的对应关系未声明。** 观测显示一个 `message.id` 内最多 10 个 `tool_use`。
3. **`turn.start` 为何不可改写、`turn.complete` 为何只能改展示文本**，只有「Observe: a different return changes nothing」「转写记录永不被重写」两句解释，设计意图属推断。
4. **`pause_turn` 的语义未知。** 它是步级 `TurnStopReason` 的一员，但契约未说明引擎对它做什么（是否等价于挂起）。
5. **`agentId` 的生成与唯一性范围未定义**（跨会话？跨重启？）。`2.1.296` 提到杀进程再恢复后要能「按 id 恢复后台代理」，暗示它必须稳定，但契约未承诺。
6. **`consent` 保留键的确切来源未定义**：只说「人自己说的话」，未说它如何被采集与校验。
7. **权限的默认失败行为未在契约中写死**（[06] 的 fail-closed 是从 `sec-default` 实现反推的），本文只记录链中位置。
8. **`$.tool.check` 与 `tool.call` 内 core 的判定是否**逐字**同一套规则**，契约说「跑同一条链」，但两者在 mode 裁决 ask 的前后关系上措辞不同，需自行验证。
9. **子代理转写的确切路径不在本仓库**（契约只保证 `transcript_path` 是不透明字符串）。【本机观测】：子代理不出现在父转写的 sidechain 里，只留 `toolUseResult.agentId` 与 `outputFile`。
10. **`fork` 的缺口是暂态还是长期**：`mods/agents-md/README.md:95` 称 `/fork`、`/subtask` 尚不抛 `agent.spawn`（原文用 "yet"），与契约不一致，无法从仓库判断哪边是目标状态。
11. **`away_summary` 的触发条件未定义**。观测到它是**唯一带 `content` 的 `system` 记录**，出现在最后一个 turn 代替 `turn_duration`，疑似空闲/离开时的续接摘要，但契约与变更日志都没有说明。
12. **重试与续写的具体次数在引擎内部**，只有部分通过环境变量暴露（`CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES`、`CLAUDE_CODE_OVERLOADED_RETRY_*`、`CLAUDE_CODE_RETRY_WATCHDOG_*`）。
