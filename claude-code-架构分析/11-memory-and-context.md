# 11 · 记忆与上下文管理架构分析

> 范围：Claude Code 如何决定「每一轮请求带什么进模型」——常驻注入、上下文窗口账本、压缩（compaction）、跨会话持久记忆、会话恢复与回滚。
> 证据口径：`mods/types/claude-code.d.ts`（= 契约，事实源）＞ `CHANGELOG.md`（= 行为史，**全文无日期，只有版本号**）＞ 散文文档。本文另标注一类证据 **【本机观测】**：运行中的引擎写到磁盘上的产物（`~/.claude/**`），**不在本仓库内**，只能作旁证，不作事实主张。引擎内部实现不可见，凡推断一律进「存疑与待确认」。

---

## 定位

「记忆」在这套架构里**不是一个机制，而是六层寿命不同的存储加一个接缝**。把它们混为一谈是复刻时最容易犯的错：它们的写入者、寿命、以及「满了怎么办」完全不同。

| 层 | 寿命 | 载体 | 谁写 | 「满」了怎么办 |
|---|---|---|---|---|
| **L0 预算账本** | 一次请求 | 内存中的 token 计数 | 引擎 | 触发 L3 |
| **L1 常驻注入** | 每轮重建 | 系统提示的 section / block | 引擎 + mod + hook | 按类别计入账本，超限就压缩或报错 |
| **L2 会话转写** | 一个会话（可 resume） | append-only JSONL | 引擎 | 不删；只改「发送什么」 |
| **L3 压缩** | 跨越压缩边界 | 一条**摘要消息** | 引擎（可被 hook 改写） | 再压一次，保留更少 |
| **L4 持久记忆** | 跨会话 | Markdown 文件（`CLAUDE.md` 等） | 人 / Claude / 组织 | 硬截断 + 显式报错 |
| **L5 恢复与回滚** | 到清理期 | 文件版本备份 + 转写 | 引擎 | 按 `cleanupPeriodDays` 清理 |

核心接缝只有一个：**`prompt.context` / `prompt.section`（装填）** 与 **`session.compact`（卸载）**。所有六层最终都表现为「往这一次请求的消息数组里放什么」。

```
        人 / 组织 / Claude 写文件
                 │                          L4 持久记忆（Markdown，可 diff、可签入、可被 policy 覆盖）
                 ▼
   ┌──────────────────────────────┐
   │  prompt.section / .context    │◄── mod（agents-md）改写 instructionFiles
   │  prompt.attachment / .compose │◄── hook 注入 additionalContext
   └──────────────┬───────────────┘        L1 常驻注入（每轮重新求值，不是搬运）
                  ▼
        ┌───────────────────┐
        │  token 账本 L0     │  有效窗口 = 模型窗口 − 输出预留 − compaction buffer
        └────────┬──────────┘
                 │ 到阈值 / 请求过长
                 ▼
        ┌───────────────────┐   PreCompact（可否决）→ 摘要 → PostCompact
        │  session.compact  │   L3：有损；损失靠「跨压缩携带清单」补
        └────────┬──────────┘
                 ▼
   ┌──────────────────────────────┐
   │  append-only 转写 L2           │  摘要作为**一条消息**落回转写
   │  + 文件版本备份 / rewind  L5   │
   └──────────────────────────────┘
```

---

## 职责与边界

**在做的事**：把「无限长的会话」映射到「有限的窗口」上，且尽量不丢会让代理跑偏的状态。

**明确不做的事**（复刻时不要过度设计）：

- **不做语义检索**。除记忆召回外，全仓库没有 embedding、向量库或「相关片段检索」的痕迹。记忆是**按层全量注入**的文件——这让行为可预测、可 review。
- **不做跨仓库知识图谱**。唯一的跨会话共享是 `CLAUDE_MEMORY_STORES`（团队记忆库，`CHANGELOG.md` `2.1.172`）与 worktree 共享（`2.1.63`）。
- **不重写历史**。转写 append-only；压缩不删除转写，只改变「下一轮发送什么」。
- **不保证无损**。压缩是有损的，损失通过**一条条补丁**收敛（见下）。

**边界**：压缩算法本身、token 计数器的实现、prompt cache 的命中逻辑都在引擎内部，本仓库不可见（`00-overview.md:18`）。

---

## 关键抽象与接口

### A. 预算账本（「满了」是什么意思）

`SessionContextBreakdown`（`claude-code.d.ts:8704-8775`）是 `/context` 的数据源，也是这套机制最完整的自述：

| 字段 | 行 | 语义（引 JSDoc） |
|---|---|---|
| `categories` | 8709 | 每类一行，**包括 free space 与 compaction buffer**——即窗口内预留了压缩余量 |
| `totalTokens` | 8711 | 在用 token，**不夹逼**：超窗口时大于 `rawMaxTokens` |
| `rawMaxTokens` | 8722 | 度量用的窗口：模型上限，**或更小的压缩窗口** |
| `autocompactSource` | 8727 | 这个窗口是谁定的（`ContextWindowSource`） |
| `memoryFiles` | 8745 | 上下文里每个记忆文件（路径 + token 估算） |
| `skills` / `agents` / `mcpTools` / `slashCommands` | 8749-8762 | 其余按类别计费的注入项 |
| `autoCompactThreshold?` | 8766 | **自动压缩触发点；关闭时该字段缺席** |
| `isAutoCompactEnabled` | 8770 | 自动压缩是否开启 |
| `apiUsage` | 8774 | 上一次响应自己的 token 数 |

两个关键推论：

1. **有效窗口 ≠ 模型窗口**。窗口要减去输出预留，再留出 compaction buffer。历史上有三次修错正是账本算错：`2.1.7`（改用有效窗口）、`2.1.14`（曾在 ~65% 就拦人，应为 ~98%）、`2.1.273`（advisor 工具轮被按两倍计，导致**在真实窗口一半处就压缩**）。
2. **窗口是按模型可配的**：`2.1.247` 把 Sonnet 5 的自动压缩窗口设为完整 1M（约 967K 触发，而非 934K）；`2.1.296` 新增 subagent frontmatter `autoCompactWindow`，让子代理比主对话更早压缩；环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（`claude-code.d.ts:2004`）。

`SessionContextUsage`（`8785`）则是状态行口径：**首次响应之前为空**——「新会话，或刚压缩过的会话，直到下一次响应」（`8781-8783`）。

### B. 压缩（L3）

```ts
// claude-code.d.ts:8694 —— 谁在压
export type SessionCompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute';
```

`SessionCompactInput`（`8634-8663`）的三个字段就是全部可干预面：

| 字段 | 语义 | 可否改写 |
|---|---|---|
| `trigger` | 触发者；matcher 据此匹配 | **Pinned**：`next(e)` 原样传递 |
| `agentId?` | 正在压的是子代理/fork 的转写（主对话缺席） | **Pinned**：漏掉会被补回，改了则 hook 失败 |
| `instructions?` | **摘要该保什么、强调什么**：`/compact` 之后的文本，或插件给的 | 可：`next({ ...e, instructions })` |
| `messages` | 被压的转写，每条带引擎 `handle` | 可：`next({ ...e, messages })`；带 handle 的算引擎原件，不带则按构造读 |

两个极易被忽略的设计（**复刻时务必抄**）：

- **「没有 summary string：摘要就是一条消息」**（`8669`）。压缩不产生旁挂的摘要字段，它把消息数组**替换**为一条摘要消息。因此转写只有一个形状，恢复、渲染、导出都无需特例。
- **`precompute` 是唯一不安装任何东西的派发**：「它的结果留给随后到来的那次压缩，前提是它跑过的那个对话仍然领先」（`8690-8693`）。这是投机式压缩——提前算好，避免卡在阈值上现算。
- 否决用 `{ skip: string }`：`precompute` 上什么也不算不保留；其他 trigger 上「对话保持原样，并有一行说明为什么」（`8674-8677`）。**引擎自己也走这条路**：classic `PreCompact` hook 阻断时，由 core 来应答。

### C. 常驻注入（L1）

事件面：`prompt.section` / `prompt.context` / `prompt.compose` / `prompt.attachment`，在每轮组装系统提示时各触发一次（`01-engine-and-hooks.md:380`）。

- `prompt.context` 的 block 按名分槽：`claudeMd`、`userEmail`、`attachedProject`、`currentDate`（`claude-code.d.ts:6771-6784`）。
- `prompt.attachment` 的 kind 含 `nested_memory`、`instructions`（`3454`、`6558`）。
- **`prompt.context` / `prompt.section` / `prompt.attachment` 属于「引擎为会话缓存其答案」的六个事件**（`InvalidatableEventName`，`4666`）。这解释了 `05-mod-agents-md.md:295` 的现象：改配置无需重启，**下一个 `prompt.context` 就采用新模式**（缓存失效即重算）。

### D. 指令文件与持久记忆（L4）

```ts
// claude-code.d.ts:4621 —— 指令文件的五层
const INSTRUCTION_FILE_KINDS: readonly ["managed", "user", "project", "local", "memory"];
```

`InstructionFile = { path, kind, content, parent? }`（`4627-4644`）：`content` 是**已剥离注释与 frontmatter 的正文**，`parent` 记录是哪个文件的 `@import` 把它带进来的。层级语义：`managed`（组织策略）、`user`（个人）、`project`（签入）、`local`（项目私有）、`memory`。

`ContextMemoryFile`（`1919-1933`）是它在账本侧的投影：`{ path, type, tokens }`，`type` 是显示标签，取值 **`Project` / `User` / `Local` / `Managed` / `AutoMem`**——注意 `AutoMem`：**自动记忆（auto-memory）与 `CLAUDE.md` 同处一个注入通道，只是来源标签不同**。

其余接口：`ContextSkills = { totalSkills, includedSkills, tokens, skillFrontmatter }`——`includedSkills` 是「在 token 预算内被纳入列表的数量」，即技能列表本身也受预算挤出（`08-agents-and-skills.md:280-291`）。

### E. 与本机制相关的 5 个 hook（契约原文）

```ts
// 6385-6389
type PreCompactHookInput = BaseHookInput & {
    hook_event_name: 'PreCompact';
    trigger: 'manual' | 'auto';
    custom_instructions: string | null;
};
// 6296-6303
type PostCompactHookInput = BaseHookInput & {
    hook_event_name: 'PostCompact';
    trigger: 'manual' | 'auto';
    /** The conversation summary produced by compaction */
    compact_summary: string;
};
// 9153-9175
type SessionStartHookInput = BaseHookInput & {
    hook_event_name: 'SessionStart';
    source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
    session_title?: string;
    seconds_since_last_response?: number;   // resume/fork
    context_tokens?: number;                // resume/fork
    prompt_cache_likely_expired?: boolean;  // resume/fork
    estimated_cache_write_usd?: number;     // resume/fork
};
// 4652-4660
type InstructionsLoadedHookInput = BaseHookInput & {
    hook_event_name: 'InstructionsLoaded';
    file_path: string;
    memory_type: 'User' | 'Project' | 'Local' | 'Managed';
    load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
    globs?: string[];
    trigger_file_path?: string;
    parent_file_path?: string;
};
```

`BaseHookInput`（`583`）人人都有：`session_id`、`transcript_path`、`cwd`、`permission_mode?`、`agent_id?`、`agent_type?`、`effort?`。`$.session.id()` 的定义就是「转写文件的名字」（`2380-2382`）。

**三处必须记住的非对称**（复刻时照抄，否则 API 会拧）：

1. `InstructionsLoaded.load_reason` 里有 **`'compact'`** ——**指令文件在压缩边界上被重新加载**，不是「压进去的」。compaction 丢的是对话，不是文件。
2. `PreCompact` 用 snake_case 的 **`custom_instructions`**，而引擎事件 `session.compact` 用 **`instructions`**；全仓库**没有** `customInstructions` 驼峰写法（`6388` vs `8654`）。
3. `PostCompact.trigger` / `PreCompact.trigger` **只有 `'manual' | 'auto'`**，比 `SessionCompactTrigger` 少了 `plugin | precompute`——classic 面比引擎面窄。

---

## 数据流 / 时序

### 一轮请求的装填

```
prompt.section / prompt.context / prompt.compose / prompt.attachment
   → 依次求值（答案被会话缓存，直到被 prompt.context 失效）
   → 组装：system sections + claudeMd block + date/env/git + 技能列表 + 代理列表
   → 计入账本：categories（含 free space / compaction buffer）
   → 若 totalTokens ≥ autoCompactThreshold → 进入压缩（auto）
   → 否则发请求；响应回来更新 apiUsage
```

【本机观测】引擎把每一步的注入都记成转写里的 `attachment` 记录，可观测到的 kind 包括：`instructions`（携带 `{path, type:'Project', content}`）、`session_context`（git 状态，且自带免责声明「这是会话开始时的快照，不会更新」）、`date`、`environment`（`workingDirectory`、`isGitRepo`、`isWorktree`、`shell`、`platform`）、`model`、`skill_listing`、`agent_listing_delta`、`hook_additional_context`、`prompt_snapshot`、以及**每轮一枚 `total_tokens_reminder`**。后者是模型侧的自我预算信号（本会话中它渲染为 `<total_tokens>…tokens left</total_tokens>`）——**模型知道自己还剩多少预算，靠的就是它**。转写记录之间以 `parentUuid` 相连，是一棵树（子代理为 sidechain），不是数组。

### 压缩时序（含三条旁路）

```
阈值到达 / 请求过长（reactive）
   │
   ├─ precompute：先算，不安装；随后的压缩若仍领先则取用其果
   │
   ├─ classic PreCompact hook（exit 2 或 {"decision":"block"}）
   │        └─ 阻断 → SessionCompactSkipped{ skip } → 对话原样保留 + 一行说明
   │            （PreCompact 不能返回 additionalContext，它只有否决权）
   │
   ▼
session.compact（trigger/agentId 不可改；instructions/messages 可改）
   │   └─ 摘要请求前先**剥掉** image/document blocks 与 progress 消息大负载
   ▼
摘要生成（流式；见「设计决策」第 2 条）
   │
   ▼
用一个**摘要消息**替换被压的消息  → SessionCompacted{ messages, tokensBefore?, tokensAfter? }
   │
   ├─ PostCompact hook（拿到 compact_summary 全文）
   ├─ InstructionsLoaded（load_reason='compact'）→ CLAUDE.md / rules 重新装入
   └─ 若压完仍超长 → 再压一次，且**保留更少的近期对话**（2.1.284）
```

### 恢复 / 回滚

`sessions` 会话的身份是转写文件；`--resume <id>`「恢复的是写过转写的会话：一个从未跑过 prompt、或关闭了持久化的会话，在这个 id 下什么都没留下」（`9141-9150`）。恢复时 `SessionStart` 的 `source` 为 `resume`（或 `fork`），并携带**三个成本提示字段**：`context_tokens`、`prompt_cache_likely_expired`、`estimated_cache_write_usd`——引擎直接把「恢复这一下要重新付多少缓存钱」交给 hook。历史上有 `2.1.30` 用 stat 替代会话索引，把 `--resume` 内存占用降 68%。

### 压缩边界上：什么被保留、什么被丢弃

这是本机制的核心问题。把三类证据拼起来：

**① 明确被「剥掉」的（进摘要请求之前，为的是塞得下 / 便宜）**

| 对象 | 版本 | 说明 |
|---|---|---|
| `image` / `document` blocks | `2.1.47`、`2.1.229` | 先剥文档再剥图片；都剥不了时会因 32MB 上限重试失败 |
| progress 消息的大负载 | `2.1.63`、`2.1.77` | 顺带修「progress 消息活过压缩」的内存增长 |

**② 明确被「保住」的（逐条补出来的）**

| 状态 | 版本 | 教训 |
|---|---|---|
| todo 列表 | `1.0.11` | 最早被意识到需要跨压缩携带的状态 |
| 图片（**为了复用 prompt cache**） | `2.1.70` | 保留图片不是为好看，是为让摘要请求命中缓存、更快更便宜 |
| plan mode | `2.1.47` | 曾丢失，导致模型从规划模式滑进实现模式 |
| 会话名 / 自定义标题 | `2.1.47` | 曾丢失 |
| 扩展思考配置 | `2.1.198` | 子代理与压缩继承会话的 thinking 配置 |
| 压缩后告知模型的 git 状态 | `2.1.269` | 曾错误地沿用**会话开始时**的状态，而非当前状态 |
| 「敏感用户指令」 | `2.1.139` | **摘要提示词本身被改成要求保留敏感用户指令** |
| 恢复的记忆文件「年龄注记」 | `2.1.275` | 注记随请求变化会造成缓存未命中——**为缓存稳定而冻结** |

**③ 被替换的**：被压的消息数组 → 一条摘要消息（`8669`）。转写不删（L2 保留全史），只有「发送什么」变了。

**④ 默认不携带的**：`omitClaudeMd` 的代理不带任何 CLAUDE.md 块（`claude-code.d.ts:427-431`，`2.1.271` 加入 frontmatter）；`--bare` / `--safe-mode` / `CLAUDE_CODE_SIMPLE` 下则关掉整条注入链。

> **一句话总结**：保留规则不是一条通用策略，而是**一张不断打补丁的清单**。这正是复刻时最该抄的东西——见「对复刻产品的启示」第 3 条。

---

## 扩展点

| 扩展点 | 能力 | 依据 |
|---|---|---|
| `PreCompact` hook | **否决**压缩（exit 2 / `{"decision":"block"}`） | `2.1.105`、`8677` |
| `session.compact` 的 `instructions` | 改写「摘要该保什么」——**最被低估的扩展点** | `8649-8654` |
| `session.compact` 的 `messages` | 改写被摘要的内容本身 | `8656-8662` |
| `PostCompact` hook | 读摘要全文 `compact_summary`，做审计/落盘/再注入 | `6296-6303`、`2.1.76` |
| `InstructionsLoaded` | 观测每个记忆文件何时、因何、被谁带入（含 `compact`） | `4652-4660`、`2.1.69` |
| `SessionStart` 返回 `additionalContext` / `initialUserMessage` / `watchPaths` / `reloadSkills` | 会话开局注入与重载 | `claude-code.d.ts:976-1052`、`plugins/explanatory-output-style/hooks` |
| `prompt.context` 返回 `instructionFiles` | 重排/过滤/替换整个指令文件集（`agents-md` 的实现基础） | `6815`、`6834` |
| `PostToolUse` 返回 `updatedToolOutput` | 让模型看到的工具/ MCP 结果是**改写过的**（唯一的 hook 级脱敏/截断口） | `1029-1036` |
| 配置开关 | `cleanupPeriodDays`（会话数据保留期）、`autoMemoryDirectory`、`fileCheckpointingEnabled`、`promptCacheTtl` / `subagentPromptCacheTtl` | `2.1.74`、`2.1.243`、`mods/diff/hooks/is-checkpointing/is-checkpointing.ts:19` |
| 环境变量 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`DISABLE_COMPACT`、`ENABLE_PROMPT_CACHING_1H`、`FORCE_PROMPT_CACHING_5M`、`CLAUDE_CODE_DISABLE_1M_CONTEXT`、`CLAUDE_CODE_DISABLE_CLAUDE_MDS`、`CLAUDE_MEMORY_STORES` | `2004`、`2.1.98`、`2.1.108`、`2.1.223`、`mods/agents-md/README.md:73`、`2.1.172` |

**工具结果的外置**（上下文窗口守门）是另一条独立通道：大于 50K 字符的工具结果落盘并只在上下文里留引用（`2.1.51`，原阈值 100K），落盘总量 1GB 封顶（`2.1.238`）；MCP 可用 `_meta["anthropic/maxResultSizeChars"]` 覆盖（上限 500K，`2.1.91`）；Bash 结果类型里有 `rawOutputPath`（`12695`），Read 有 `truncatedByTokenCap`（`12927`）。

---

## 设计决策与权衡

**1. 摘要即消息，不设旁挂字段。** `8669` 明说「没有 summary string：摘要就是一条消息」。好处：转写只有一种形状，resume / 渲染 / 导出 / 子代理全都复用同一条路径。代价：想审计摘要就得走 `PostCompact`。

**2. 压缩被当成可观测的操作，而不是黑箱。** 有 spinner 文案（`2.1.273`：`Running PreCompact hooks…`）、有 `TurnStopReason = 'compaction'`（`10596`）、有 `tokensBefore/tokensAfter`（`8607-8628`）。`2.1.283` 起压缩进度条换成流式计数（计时从压缩开始、随摘要流式累加），取代百分比条。

**3. 承认有损，并用「补丁清单 + 三重断电器」兜住。** 断电器：连续失败 3 次即停（`2.1.76`）；**连续压 3 次后若上下文立刻又满**则判定抖动并报可操作的错，而不是继续烧 API（`2.1.89`）；压完仍超长则「再压一次，保留更少近期对话」（`2.1.284`）。reactive 路径还会用原始请求的溢出量给首次摘要做种子，避免一次注定失败的重试（`2.1.142`）。

**4. 重算优于搬运。** L1 的每一块都是**每轮重新求值**的（`prompt.context` 的答案被缓存，配置变更即失效）。这带来一个反直觉但重要的性质：**压缩与 `/clear` 天然重置注入状态**——`agents-md` 的计数、嵌套加载去重都会在压缩后重置（`05-mod-agents-md.md:259`、`:295`），也因此 `2.1.89` 需要专门修「nested CLAUDE.md 被重复注入几十次」。

**5. prompt cache 是第一约束，不是优化项。** 大量设计只有在缓存视角下才讲得通：日期被移出系统提示（`2.1.42`）、压缩时保留图片以复用缓存（`2.1.70`）、记忆文件年龄注记必须跨请求稳定（`2.1.275`）、模型切换/OAuth 刷新不得重渲染工具定义（`2.1.248`、`2.1.259`、`2.1.267`）、空闲 75 分钟后提示 `/clear` 以减少陈旧会话的重复缓存（`2.1.84`）、`/cost` 与状态行暴露 `prompt_cache`（命中率/未命中/重新缓存/warm-cold，`2.1.251`）并给出未命中原因（`2.1.260`）、TTL 可配（默认 5m，`ENABLE_PROMPT_CACHING_1H` 开 1h，`2.1.108`；主对话与子代理可分别设，`2.1.243`）。**结论：任何改变请求前缀的设计，都要问「它会不会打断缓存」。**

**6. 记忆是文件，不是数据库。** L4 全部落在 Markdown：可 diff、可 review、可签入、可被组织策略覆盖（`managed` 层）。代价是**尺寸治理必须自己做**：`MEMORY.md` 索引 25KB / 200 行双上限（`2.1.83`），超限时提醒代理**压缩自己的索引**（`2.1.186`），注释与 frontmatter 不计入加载量（`2.1.211`），写超限时**显式报错而非静默截断**（`2.1.210`），截断警告要说明**切了多少行、从哪切**（`2.1.268`）。记忆文件的 frontmatter 带 ISO `modified` 时间戳，供模型判断新鲜度（`2.1.75`、`2.1.214`）。

**7. 注入面必须防「伪装成引擎自己」。** `2.1.284`：在 `MEMORY.md` 与召回的记忆笔记里，**不可见字符与模仿 Claude Code 自身标记的标签，在到达模型前被中和**。这是记忆机制的安全边界——被写入记忆的内容是**不可信输入**。

**8. 用户可见的压缩，也是用户可编辑的压缩。** `/rewind`（`2.0.0`，`/undo` 为别名）与「Summarize from here」（`2.1.32`）、「Summarize up to here」（`2.1.141`）把压缩变成**对话编辑操作**：既压又能保住近期轮次。`/rewind` 甚至支持回到 `/clear` 之前（`2.1.191`）——而 `/clear` 在引擎内部是触发 `session.end` 的事件之一（`01-engine-and-hooks.md:382`）。

**9. 磁盘/IO 卫生被当作一等公民。** 转写体积在编辑密集会话中被压缩到 1/79（`2.1.208`，靠**剪除被取代的文件历史备份**），同时给 checkpoint 磁盘用量设界；`2.1.296` 起转写文件「若重写只能省下不足 10%」就不重写。

**10. 记忆的开关必须是「失败的开关」。** `--safe-mode` / `CLAUDE_CODE_SIMPLE` 一次性关掉 CLAUDE.md、插件、技能、hooks、MCP（`2.1.169`、`2.1.50`）；`cleanupPeriodDays: 0` 从「静默关闭转写持久化」改为**校验报错**（`2.1.89`）。

---

## 对复刻产品的启示

1. **先把「窗口账本」做对，再做压缩。** 定义 `有效窗口 = 模型窗口 − 输出预留 − compaction buffer`，并把窗口来源（模型默认/设置/账号/实验/环境变量）作为一等数据暴露出来（对标 `ContextWindowSource`）。历史三次事故（`2.1.7`/`2.1.14`/`2.1.273`）全部源于账本算错，而算错的代价是「在真实窗口一半处就压缩」。
2. **把压缩建模为「一条带类型的操作」，不是函数调用。** 复刻 `SessionCompactInput{ trigger, agentId, instructions, messages }` + `Result = Compacted | Skipped{skip}`。`trigger` / `agentId` 必须 **pinned**（不可被 hook 改写），否则可观测性会被破坏。
3. **维护一份显式的「跨压缩携带清单」，并为每条写测试。** 这是本文最重要的一条。别指望摘要自己能记住 plan mode、会话标题、todo、git 状态、thinking 配置——这份仓库的历史就是**这些状态一条条丢失、再一条条补回**的历史。把它做成一个结构化的 carry-over 对象，在压缩前后断言相等。
4. **摘要落成一条消息，别设旁挂字段。** 一条形状 = 一套渲染/恢复/导出路径。审计需求交给 `PostCompact` 式的钩子，而不是扩宽存储模型。
5. **给出可干预点，而且给在「指令」上。** 最小可用的干预面是：`PreCompact`（可否决）+ `session.compact.instructions`（可改写摘要要求）+ `PostCompact`（可读结果）。其中 **`instructions` 可改写**这条极便宜、极有力，很多产品漏掉它。
6. **先剥再摘。** 送进摘要器之前先剥掉图片/文档/进度大负载；同时**保留图片**（若你的供应商支持）以便摘要请求命中缓存。剥离顺序与上限（32MB 请求上限）要显式处理，否则会陷入「剥无可剥却一直重试」。
7. **三重断电器照抄**：连续失败 N 次即停；连续压缩 N 次后上下文立刻再满 → 判定抖动并报**可操作的错**；压完仍超长 → 再压一次且保留更少近期内容。
8. **压缩前后重新加载文件，而不是把文件压进摘要。** `InstructionsLoaded.load_reason='compact'` 是正确姿势：对话有损、文件无损。若把 CLAUDE.md 塞进摘要，你会得到「记忆越压越糊」的退化。
9. **把 prompt cache 稳定性写进评审清单。** 任何改动请求前缀的东西（日期、环境、工具定义渲染、记忆文件的「年龄」注记）都要问：会不会造成未命中？并用可观测指标兜住（命中率、未命中原因、重新缓存 token 数）。
10. **记忆用文件 + 硬上限 + 显式报错。** 给索引设双上限（字节 + 行数），超限时**提示代理自己去整理**，写入超限**报错而非静默截断**。这让记忆可 diff、可签入、可被组织策略覆盖，也让「记忆膨胀」变成一个看得见、可操作的问题。
11. **记忆是注入面，因此是攻击面。** 中和不可见字符与「模仿自家标记」的标签；对来自记忆的内容按不可信处理。组织级要能强制只保留 `managed` + `memory`（`managed-only`），并能让单个代理完全不携带项目/个人记忆（`omitClaudeMd`）。
12. **给用户可见的压缩控制。** 提供 `/rewind`、`/compact`、以及「从这里开始摘要 / 摘要到这里」式**部分压缩**——用户在长会话里最需要的是「保住最近几轮，把前面压掉」。
13. **工具结果外置要有一套独立阈值策略**：字符阈值（本仓库 50K）、总量上限（1GB）、可被工具元数据覆盖（`maxResultSizeChars`），并在模型侧留下「要去哪里读全文」的引用。这是上下文窗口最有效的一道闸。
14. **让模型自己知道预算。** 每轮注入一枚「剩余预算」提示（对标 `total_tokens_reminder`）成本极低，却让「快满了，我该收尾/该落盘」成为模型可自主执行的行为。

---

## 关键文件索引

| 路径 | 内容 |
|---|---|
| `mods/types/claude-code.d.ts:1919-1933` | `ContextMemoryFile`（含 `AutoMem` 标签） |
| `mods/types/claude-code.d.ts:2004-2007` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `ContextWindowSource` |
| `mods/types/claude-code.d.ts:427-431` | 代理 `omitClaudeMd` |
| `mods/types/claude-code.d.ts:4621-4660` | `INSTRUCTION_FILE_KINDS` 五层、`InstructionFile`、`InstructionsLoaded` 输入 |
| `mods/types/claude-code.d.ts:4666` | `InvalidatableEventName`（注入答案的会话缓存） |
| `mods/types/claude-code.d.ts:583-600` | `BaseHookInput`（`session_id` / `transcript_path`） |
| `mods/types/claude-code.d.ts:6296-6303` | `PostCompactHookInput` |
| `mods/types/claude-code.d.ts:6385-6389` | `PreCompactHookInput` |
| `mods/types/claude-code.d.ts:6771-6784` | `prompt.context` 的 block 命名 |
| `mods/types/claude-code.d.ts:8634-8694` | `SessionCompactInput/Result/Skipped`、`SessionCompactTrigger` |
| `mods/types/claude-code.d.ts:8704-8775` | `SessionContextBreakdown`（`/context` 的完整口径） |
| `mods/types/claude-code.d.ts:8785-8800` | `SessionContextUsage` |
| `mods/types/claude-code.d.ts:9141-9175` | `SessionResume`、`SessionStartHookInput` |
| `mods/types/claude-code.d.ts:976-1077` | `ClassicResult` 与按事件的输出白名单 |
| `mods/types/claude-code.d.ts:2350-2382` | `$.session.messages()`（取最新 4096 条）、`$.session.id()` |
| `mods/agents-md/README.md:23-28,30-41,105-106,147,150-154` | 指令文件加载、`managed-only`、`/memory` 与 `#` 不认 `AGENTS.md` |
| `mods/agents-md/hooks/register.ts:274-275` | `CLAUDE_CODE_SIMPLE` / `CLAUDE_CODE_DISABLE_ATTACHMENTS` |
| `mods/diff/hooks/is-checkpointing/is-checkpointing.ts:4-20` | 会话 checkpoint 开关 |
| `mods/sec-default/tests/fixtures/memory.ts:6-9` | 系统提示的 `memory` section fixture |
| `plugins/ralph-wiggum/hooks/stop-hook.sh:58-81` | 插件侧读 `transcript_path`（JSONL）的实例 |
| `CHANGELOG.md` | 行为史（418 个版本段落，**无日期**）；关键锚点：`8740`(0.2.47 压缩引入)、`8719`(0.2.54 `#`)、`8621`(0.2.107 `@import`)、`8380`(1.0.51 阈值 60→80%)、`8393`(1.0.48 PreCompact)、`7676`(2.0.70 移除 `#`)、`7722`(2.0.64 `.claude/rules/`)、`6878`(2.1.59 auto-memory)、`6737`(2.1.69 InstructionsLoaded)、`6503`(2.1.76 PostCompact)、`5148`(2.1.139 摘要保留敏感指令) |

---

## 存疑与待确认

1. **压缩算法与提示词全文不在仓库内。** 摘要提示词只以行为描述出现（`2.1.139`），无文本。本文所有「保留/丢弃」都是**从修复记录反推**，不是读实现得到的。
2. **`trigger: 'precompute'` 的调度时机未定义。** 契约只说「提前算、不安装」（`8690-8693`），何时触发、多大比例会被复用，无从得知。
3. **`ContextWindowSource` 的完整取值未核实。** 只确认存在该类型与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 这一来源；「设置/账号/实验」等来源来自 JSDoc 散文（`2004`），未逐一列举。
4. **`memory` 层（`INSTRUCTION_FILE_KINDS`）与 `AutoMem`（`ContextMemoryFile.type`）的关系未定义。** 契约从不解释 `memory` 层在磁盘上的确切路径、写入者与优先级；`InstructionsLoaded.memory_type` 又只列 `User|Project|Local|Managed`（**不含 `memory`/`AutoMem`**）——三处口径不一致，复刻时须自行拍板。
5. **auto-memory 的写入契约完全不可见。** 没有记忆工具的 JSON schema、没有「何时该记」的规则文本。只有行为与治理面（`2.1.59` 引入、`autoMemoryDirectory`、25KB/200 行上限、`modified` 时间戳、注入中和、团队记忆库 `CLAUDE_MEMORY_STORES`）。
6. **转写的确切落盘路径不在本仓库**。契约只保证 `transcript_path` 是不透明字符串；`~/.claude/projects/<slug>/<session>.jsonl` 是 **【本机观测】** 的产物，未在任何文档或类型中声明，版本间可能变。
7. **`custom_instructions` 与 `instructions` 的命名不统一**（`6388` vs `8654`），且无驼峰变体。是历史遗留还是有意分层，无从判断。
8. **classic 面与引擎面的 trigger 集合不一致**（classic 只有 `manual|auto`）。`plugin` / `precompute` 压缩在 classic hook 侧如何呈现（是否根本不触发 PreCompact），未说明。
9. **`#` 快捷记忆在 `2.0.70` 被移除**，改由「让 Claude 去编辑你的 CLAUDE.md」。仓库内 `#` 的唯一残留是 `mods/agents-md/README.md:147` 提到 `/memory` 与 `#` 不认 `AGENTS.md`——**该句已过时**（正是 `00-overview.md` 所说的「文档—实现漂移」）。
10. **`/rewind` 与 checkpoint 在类型契约中完全缺席。** `claude-code.d.ts` 里搜不到 rewind / checkpoint 事件或类型，只有 `mods/diff` 镜像出的 `isCheckpointing()` 与设置项。文件版本备份的 `hash@vN` 命名同样是 **【本机观测】**。
11. **缓存 TTL 与压缩的具体耦合未量化。** 「保留图片以便复用缓存」（`2.1.70`）与「记忆注记变化导致未命中」（`2.1.275`）说明耦合存在，但没有任何契约字段或文档给出量化模型。
12. **`$.session.messages()` 只返回最新 4096 条**（`2350-2357`）。超过之后压缩看到的世界与完整转写不同——这个上限与压缩窗口的关系（谁先到）未说明。
