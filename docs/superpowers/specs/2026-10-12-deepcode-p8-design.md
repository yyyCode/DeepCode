# DeepCode P8 执行循环的收场设计

> 对标 `docs/claude-code-架构分析/12-execution-loop.md`。复刻对象的事实、依据与版本锚点
> 都在那一份里，本文**不重述**，只写"我们缺什么、改什么、为什么、怎么验"。
>
> 一句话口径：**这一阶段一行新事件都不加** —— 只把"一轮怎么结束"这件事补齐：
> 停止原因分两层、截断接上去、空步出声、炸在半路的那半句不许消失。

---

## 1. 出口标准（可验证，四条）

1. **两层停止原因分开**：`turn.complete.stopReason` 只可能是产品字面量
   （`answer` / `max_hops` / `truncated` / `empty` / `refusal` / `error` / `interrupted`），
   端点的步级枚举（`end_turn` / `max_tokens` / `pause_turn` / …）一个都到不了那里。
2. **截断接上去**：模型以 `max_tokens` 停下时，循环把它接着写完（≤ 3 次，**每一次都出声**）；
   用尽仍被截断 → 这一轮以 `truncated` 收场，并说清"上面那段是半截的"。
3. **一次都不许凭空消失**：模型吐过的字、用户说过的话，在 `messages` 里都有痕迹 ——
   空步不再往对话里塞一条 `content: []` 的 assistant 消息（改成最多重提示一次），
   流炸在中途时那半句留在对话与转录里。
4. **"没做完"在两侧都认得出**：子代理把 `truncated` / `refusal` / `empty` 当异常回传给父级；
   一次性模式下除 `answer` 之外的任何收场都是非零退出码（**白名单**，不是黑名单）。

任务级验收只跑 `pnpm typecheck`；测试按检查点批量做（用户长期指令：一次校验多个任务）。

---

## 2. 与复刻对象的差异

复刻对象把一轮拆成 `turn.start → turn.step（0..n）→ turn.complete`，继续条件写在**步的结果**里
（`12-execution-loop.md:46-50`）。逐条对我们：

| 它的做法 | 启示 # | 我们**已有** | 差距 → 本阶段怎么办 |
| --- | --- | --- | --- |
| 轮与步在类型上分开 | 1 | `turn.start` / `turn.step` / `turn.complete` 都在（`contract/events.ts:27-48`），继续条件由 `toolUses.length === 0` 决定 | 结构上同构。**不追**：我们的 `turn.step` 是流式文本增量（`events.ts:295`），与它"一步=一次模型请求"不同名不同物，改名会动渲染器与全部既有断言，收益只是一个更漂亮的对应表 |
| 两层停止原因 | 2 | **一层**：端点的串直接当本轮的收场理由（`loop.ts:142,216`） | **真差距** → §3.1 |
| 续写/恢复默认导向"继续" | 12 | 只有"provider 报错退避重试一次"（`loop.ts:108-159`） | **真差距** → §3.2（截断）、§3.3（空步）、§3.4（保住半句） |
| 每一类续写都配上限 | 3 | `MAX_HOPS = 25`（`loop.ts:15`）、`MAX_STOP_BLOCKS = 3`（`loop.ts:24`）、重试 1 次 | 有先例，本阶段的每一类续写照抄这个形状 → §3.2/§3.3 |
| 拒绝是喂回模型的信息，不是终点 | 7 | `{ deny: reason }` → 错误结果喂回（`loop.ts:303-305`） | 已有，不动 |
| 工具结果两个受众（`result` / `context`） | 6 | `withContext`（`loop.ts:318`、`contract/prompt-channel.ts`） | 已有，不动 |
| 权限是链上的一次判定，且不可降级 | 8 | `tool.check` + 五层来源 + deny 压 ask（P2） | 已有，不动 |
| 中断是轮作用域的 | 9 | 每个 turn 一个 `AbortController`（`cli/turns.ts:18`） | 已有，不动。我们没有后台工作，所以"后台不连带被杀"这条**没有落点**（见 §4） |
| 类型级防幻觉工具调用 | 11 | `ContentBlock` 只有 `text` / `tool_use`；适配器发 `tool_use` 才成调用，模型在正文里写工具名不会被执行 | 已有，不动 |
| 终止权外置 + 闸 | 3 | `turn.stop` 这道缝 + 3 次上限（`loop.ts:183-198`） | 已有，不动 |
| 委派返回**句柄**，完成事件按 `agentId` 回填 | 4 | 同步阻塞：`agent.spawn` 交回 `{text, stopReason}`（`core/nouns/agent.ts:78`） | **不追**（§4）：要求"循环可挂起 + 不再有 while" |
| 循环是挂起/唤醒状态机 | 10 | 不是，就是一个 `for` | **不追**（§4）：要先有后台工作在等 |
| 一批工具调一次 `PostToolBatch` | 13 | 工具**串行**执行、结果合成一条消息（`loop.ts:203-210`） | **不追**（§4）：串行是我们有意的选择，批次并发不存在，也就没有"伪装成串行"这个陷阱 |

复刻对象给复刻者的 14 条启示里，**我们真正要抄的是 3 条**：两层停止原因（启示 2）、
每一类续写都配上限（启示 3）、失败默认续而不默认报错（启示 12）。
剩下 11 条逐条在 §4 有"不追"的理由 —— 别把它们当待办。

### 2.1 两个已经实测出来的洞（不是读代码猜的）

写这份设计之前，先拿两个探针在真 `runTurn` 上跑了一遍（探针用完就删，结论记在这里）：

| 探针 | 喂进去的 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| 空步 | `[{ type:'done', stopReason:'end_turn' }]`（没有文本、没有工具） | `messages` 变成 `[user, { role:'assistant', content: [] }]`；`stopReason` 是 `'end_turn'` | 用户问了一句，模型一个字没说，对话里却多了一条**空的 assistant 消息**，屏幕上什么都没有 |
| 炸在中途 | 先吐一段文本，再抛错 | `messages` 只剩 `[user]` —— 屏幕上已显示的那半句**不在对话里**，也不在转录里；`stopReason` 是 `'error'` | 记录与所见不一致：用户看见了，转录没有 |

两条都不需要 API 就能复现。§3.3 修第一条，§3.4 修第二条。

---

## 3. 逐项设计

### 3.1 两层停止原因

**是什么**：新增 `TurnReason`（产品语义、闭环枚举），`turn.complete.stopReason` 与
`AgentSpawnResult.stopReason` 都换成它；端点的步级串只活在 `runTurn` 内部。

```ts
// src/contract/turn.ts（新文件，零 import）
export type TurnReason =
  | 'answer'      // 模型自己收手了
  | 'max_hops'    // 撞上单轮往返上限
  | 'truncated'   // 被输出长度上限截断，续写次数也用完了
  | 'empty'       // 重提示过一次之后，模型仍然什么都没产出
  | 'refusal'     // 模型拒答
  | 'error'       // 这一轮失败（provider 报错）
  | 'interrupted';// 用户中断

/** 正常收场 = 这一轮把话说完了。其余一律算"没做完"。 */
export const NORMAL_TURN_REASONS: readonly TurnReason[] = ['answer'];
export function isNormalTurn(reason: string): boolean;
```

**为什么**（这不是洁癖，是一个**已经发生过的**真 bug）：子代理那边判断"这个子代理是不是
没干完"，用的是端点串做的**黑名单**：

```ts
// src/cli/subagents.ts:21-22（今天）
/** 子代理没正常结束的三种 stopReason。其余（end_turn / max_tokens / 端点自定义的）都当正常。 */
const ABNORMAL_STOP = new Set(['error', 'interrupted', 'max_hops']);
```

黑名单的下一句就是它的判决：`max_tokens`（被截断）**不在名单里**，于是"被砍掉一半的子代理"
把半截结论当成完整答复交回父级，父级拿着它继续干活，谁都不知道它没写完。白名单不会犯这个错：
新加一种收场方式时，它**默认**是"没做完"，要放行得去改 `NORMAL_TURN_REASONS` 这个列表。

**落点**：

- 新增 `src/contract/turn.ts`（零 import，避免 `events.ts → engine.ts → agent.ts → events.ts` 成环）。
- `contract/events.ts`：`turn.complete.stopReason: string` → `TurnReason`，注释里点明两层。
- `contract/agent.ts`：`AgentSpawnResult.stopReason: string` → `TurnReason`。
- `core/loop.ts`：`runTurn` 返回 `Promise<TurnReason>`；新增 `reasonOf(step, empty)` 做**唯一一处**翻译。

**口径**：端点的值哪个算哪个，写死在一处，且**不是**"照抄一遍枚举"：

| 步级（端点） | 轮级（我们） | 谁做的决定 |
| --- | --- | --- |
| `end_turn` 及其它没建模的值 | `answer` | 从产品视角看，"它说完了"，无论供应商怎么称呼这件事 |
| `max_tokens` | `truncated`（先走 §3.2 的续写） | 循环 |
| `refusal` | `refusal` | 端点 |
| `tool_use` | —— | 根本到不了这儿：有 tool_use 就继续跑工具 |
| （跑满 hop） | `max_hops` | 循环，**压过**上面全部 |
| （`text` 与工具都没有） | `empty` | 循环（§3.3） |

判据：喂一个端点自定义的 `stopReason: 'pause_turn'`，断言本轮收场是 `answer` 而**不是**
`pause_turn`。

### 3.2 截断续写

**是什么**：步级 `max_tokens` 且这一步没有工具调用时，**这不是收手** —— 循环往对话里推一条
user 消息把话接下去，最多 3 次，每次都在屏幕上说一声。

**为什么**：今天模型被输出长度上限砍断时，这一轮**就这么结束了**，半截回答就是最终答复；
一次性模式下它甚至退 0（`main.ts:494-498` 只认 `error` / `interrupted` / `max_hops`），
`deepcode "写一份长报告" && 下一步` 会带着半截结果往下走。复刻对象为此专门有一条机制
（`2.1.269`，转圈文案是 "picking the thought back up"）：**输出被截断 → 自动续写**。

**落点**（`core/loop.ts`，收手分支里）：

```ts
const MAX_CONTINUATIONS = 3;
const CONTINUE_PROMPT =
  '上一条回答被输出长度上限截断了。**接着往下写**：从断掉的地方继续，' +
  '不要重复已经写过的内容，也不要重新开头。';

// 步级 max_tokens 且没有工具 → 接上去（不是收手）
if (lastStep === 'max_tokens' && continuations < MAX_CONTINUATIONS) {
  continuations += 1;
  carried += text;
  ctx.$.ui.notice(`这一轮被输出长度上限截断，接着往下写（第 ${continuations}/${MAX_CONTINUATIONS} 次）`);
  messages.push({ role: 'user', content: CONTINUE_PROMPT });
  continue;
}
```

三条附带决定（都要有测试钉住）：

1. **`carried` 只跨相邻的续写步**。续写出来的第二段与第一段是**同一句话**，所以
   `onText` 收到的是**拼起来的全文**；走进工具分支时把它清掉（对话翻页了，不再接在这句话头上）。
   不这么做的话，子代理的收集器是**覆盖式**的（`core/nouns/agent.ts:71`），
   续写之后父级只会拿到最后那半截。
2. **一次都不许悄悄花**：每一次续写都 `ui.notice`。复刻对象在转圈文案上说，我们在这条
   通知上说 —— 但都得说。
3. **有 tool_use 的那一步不算截断**。`max_tokens` 与 `tool_use` 同时出现时走工具那条老路，
   下一跳自然继续，不需要也不该再插一条续写消息。判据：脚本给
   `[tool_use, done(max_tokens)]`，断言第二次请求的 user 消息**不是** `CONTINUE_PROMPT`。

**上限 3 的出处（如实写）**：与 `MAX_STOP_BLOCKS` 同一个数，那是**我们自己定的**
（`loop.ts:17-23` 写了理由：参考实现把这件事推给写钩子的人，我们内核兜一道）。
复刻对象的对应闸是 8（`2.1.143`）与 14（`2.1.286`），**我们没抄它们的数**，注释里标明。

### 3.3 空步：重提示一次，且不往对话里塞空消息

**是什么**：一步里既没有文本也没有工具调用时 —— ①那条空的 assistant 消息不再进 `messages`；
②重提示一次；③仍然空 → 本轮以 `empty` 收场并说清楚。

**为什么**（两件事，第一件是 §2.1 实测出来的）：

1. **空消息会随下一次请求发出去**。实测 `messages` 里躺了一条 `{role:'assistant', content: []}`，
   而我们的适配器是照搬的（`providers/anthropic.ts` 的 `toAnthropicMessages` 原样映射 content）。
   一条 content 为空的 assistant 消息是**非法**的，下一次请求大概率被拒。
   ⚠️ **"端点会不会拒"这一条我们没实测**（拿不到一个会只回思考块的端点），
   已实测的是"这条消息确实会被发出去"。
2. **用户的话凭空消失**。屏幕上没有回答、没有报错、没有异常，只有这个 turn 静悄悄地结束。
   我们自己的适配器注释里已经写过这个形状有多坏（`providers/anthropic.ts:99-102`：
   "一次 overloaded_error 就会变成一个'成功的空 turn'"）。复刻对象对这一类的处置是
   **只回 thinking block → 重提示一次**（`2.1.183`）。

**落点**：

```ts
const MAX_EMPTY_NUDGES = 1;
const NUDGE_PROMPT = '你上一步没有输出任何内容（只有思考，没有正文）。请直接给出回答。';

const emptyStep = text === '' && blocks.length === 0;
// 全空的一步不往对话里塞：一条 content 为空的 assistant 消息既没信息，又会发出去。
if (assistantBlocks.length > 0) messages.push({ role: 'assistant', content: assistantBlocks });

if (emptyStep && nudges < MAX_EMPTY_NUDGES) {
  nudges += 1;
  ctx.$.ui.notice('模型这一步什么都没产出（可能只回了思考块），重提示一次。');
  messages.push({ role: 'user', content: NUDGE_PROMPT });
  continue;
}
```

顺序是**先续写、再重提示、最后才轮到 `turn.stop`**：空步与截断都不是"准备收手"，不该让
这条缝来裁决；只有走到最后真的收手了，才说那句"为什么收在这里"（截断用尽 → "上面那段是
半截的"；重提示也空 → "模型两次都没产出任何内容"）。

### 3.4 炸在中途时，已经吐出来的那半句必须留下

**是什么**：`failure !== undefined` 那条收尾路径上，先把 `text` 推进对话，再收场。

**为什么**：§2.1 实测——屏幕上已经显示的那半句，`messages` 里没有，转录里也没有。用户
看见了，记录说他没说过 —— **一份会撒谎的转录比一份短的转录坏得多**（`2.1.199` 是同一件事：
"保留已到达的部分并标注不完整"）。

**落点**：

```ts
if (failure !== undefined) {
  ...
  // 已经吐给用户的那半句要留在对话里（用户看见了，转录里却没有 = 记录撒谎）。
  // 只推 text，**绝不推 tool_use** —— 一个没有配对 tool_result 的 tool_use block
  // 会让下一次请求的 messages 非法（Anthropic 那边是硬拒），而这次工具根本没跑。
  if (text !== '') {
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
    ctx.onText?.(carried + text);   // 子代理那一侧也能拿到这半句（父级会收到 ERROR + 部分正文）
  }
  await complete(interrupted ? 'interrupted' : 'error');
  ...
}
```

**口径：不给这半句加"（不完整）"这类注记。** 模型说过的话就是它说过的话，往正文里掺我们
自己的一句话就是**篡改转录**；"不完整"这件事由**收场理由 + 屏幕上那条通知**承担。

### 3.5 "没做完"落到两侧：子代理与退出码

**是什么**：两处把黑名单换成白名单。

```ts
// src/cli/subagents.ts
if (!isNormalTurn(result.stopReason)) {
  return { value: `ERROR: 子代理 ${spec.name} 未正常结束（${result.stopReason}）\n\n${result.text}` };
}
```

```ts
// src/cli/main.ts（一次性模式）
if (reason === 'interrupted') process.exitCode = 130;
else if (reason !== 'answer') process.exitCode = 1;
// 除 `answer` 之外一律非零 —— 白名单，不是黑名单：将来多一种收场方式时它**默认**是非零，
// 不会像 `max_tokens` 那样悄悄退 0。
```

**为什么**：截断、拒答、空步在脚本里都等于"这趟没做成"。复刻对象的子代理到上限时
"返回部分结果并标注 partial"（`2.1.246`）—— 我们**没有 partial 这个通道**，也不新开一个
（工作面上多一种结果形状的代价比这个场景值钱），所以照现状把它做成 `ERROR:` 前缀的错误结果，
正文照带回去：父级既能看见"它没做完"，也拿得到那半截内容。

**一处可争的地方（写下来，不藏）**：拒答（`refusal`）被算作"没做完"（非零退出码、
子代理报异常）。理由：对 `deepcode "..." && 下一步` 来说任务确实没完成，fail-closed 方向上
更安全。代价：一个"模型礼貌拒绝"的交互式会话，用户会看到退出码 1 —— 一次性模式下这没坏处，
REPL 里我们不看退出码。

---

## 4. 明确不做（YAGNI，逐条给理由）

| 复刻对象有 | 启示 # | 我们不做的理由 |
| --- | --- | --- |
| 挂起/唤醒状态机（`background_tasks` + `session_crons` + `prompt.submit.source`） | 10 | 它不是"循环写得更好"，是**另一整套东西**：进程要能持久化"我在等什么"，要有三类唤醒源，要能在重启后按 id 恢复。前提是**先有后台工作**，而那是下一行。 |
| 委派返回句柄、`agentId` 回填、后台默认、并发 20 / 禁嵌套 | 4、5 | 同上：句柄式委派的价值全在"父循环不阻塞"，而不阻塞就必须有挂起与唤醒。我们今天的同步委派是**自洽**的（父级在等，子代理的工具结果照样进 `/diff`），单独换成句柄只会得到一个"立即返回但没人等"的 `agentId`。 |
| `PostToolBatch`（一批一次的事件） | 13 | 它的用处是让集成方看见"这批是并发的"。我们**串行**执行工具（`loop.ts:203-204` 写了理由：并行 Bash 的交错输出对用户没好处），批次是 1 个，事件没东西可报。哪天真做并发，这条要**同时**做。 |
| `$.tool.check` 预演（跑链不执行） | 8 | 今天没有消费方（`/permissions` 报的是规则表，不是某次调用的判定）。为一个假想的 diff/plan 场景新开一个内核入口，是给内核加税。 |
| pinned 字段那套（`tool`/`tool_use_id`/`agentId`/`turnId` 不可改写，`model`/`effort` 可改写） | 5 | 我们的链**没有任何改写能力**（hook 只能 `{value}` / `{deny}` / `{context}` / `{sections}` / `{block}`），没有可改写的字段，也就没有要钉的字段。将来加"按步换模型"时，这条是**第一件**要照着做的事。 |
| 按步换模型 / 按步换思考档位 | 1 | 同上：要 `turn.step` 这一级的事件才能表达，而我们的 `turn.step` 是文本增量。真要做，它是新事件 + 适配器新字段，不塞进这一阶段。 |
| `turn.complete` 的展示改写（梗概 / TL;DR） | 2 | 前置是"转写与展示分离"，我们两处是同一份数据。要做得先有"转写不可改写"这条约束的落点。 |
| 自动续写之外的多种恢复（非交互断流续、内容过滤器掐断重试、malformed 工具调用重试） | 12 | 它们都建立在**端点行为**的具体形状上（流断在哪、错误码是什么），而那些形状我们手上没有样本 —— 照抄会得到一堆永不触发的分支。等真遇到再逐条加，每加一条配一条闸（与 §3.2 同一个形状）。 |
| `StopFailure` / `SubagentStop` / `additionalContext` 反馈续轮 | 12 | 我们的 `turn.stop` 已经能"不让收手"（Ralph 式循环的落点），缺的是**子代理那一半**（`SubagentStop`）。落点清晰（子代理收场时也派一次），但没有消费方，等有第三方插件喊再说。 |
| todo/task 工具、plan 阶段 | 14 | 复刻对象正在**主动弃用**它们（新模型上默认不提供，`2.1.233`/`2.1.268`）。我们本来就没有 —— 这条是"我们已经在它要去的地方"，不是待办。 |

---

## 5. 偏差与代价（如实写）

1. **续写的 3 是抄我们自己的数**（`MAX_STOP_BLOCKS`），不是测出来的，也不是复刻对象的
   （它那边是 8 与 14）。注释与本节都标了出处。
2. **续写会多花钱**：每一次 `max_tokens` 都会多一次模型请求，最多 3 次。这是有意的取舍 ——
   半截回答对用户的价值通常高于那次请求的钱；所以**每一次都要出声**，让人能看见钱花在哪。
3. **一次都不许悄悄花**：与 1 冲突时选出声。宁可多一行通知，也不要"怎么又慢又贵"。
4. **"端点会拒一条空 content 的消息"未实测**。已实测的只有"这条消息确实会被发出去"
   （§2.1）。写成"大概率被拒"是推断，不是观测 —— 所以 §3.3 的理由里，真正承重的是
   "用户的话凭空消失"那一条，空消息那条是**外加**的好处。
5. **拒答算"没做完"**：一次性模式下 `refusal` 退出码 1。见 §3.5 末尾那处可争的地方。
6. **续写出来的对话，转录里是多条消息**：一条 assistant（前半）+ 一条 user（续写要求）+
   一条 assistant（后半）。**我们不把它们缝成一条** —— 模型当时看到的、我们发出去的，
   就是这三条。谁要一份"干净"的转录，那是显示层的事，不是记录层的事。
7. **`TurnReason` 是收紧，不是放宽**：`turn.complete.stopReason` 的类型从 `string` 变成
   七字面量的联合。链上没有人**返回**这个值（`turn.complete` 是纯通知），所以没有插件能被
   它卡住；能观察它的地方（classic 钩子的 JSON、telemetry）拿到的都是这七个之一。
8. **一条真的、看得见的行为变化：telemetry 里 `stop_reason` 的值变了**。telemetry 插件是
   原样透传 `turn.complete.stopReason`（`mods/telemetry`），于是它记下来的东西从
   `end_turn` 变成 `answer`。这**不是**顺手改的（那个字段本来就该是产品语义那一层），
   但后果得写下来：把改之前与改之后的日志混在一张图上看，会像是"模型忽然换了收手方式"。
   要么按时间切开看，要么把旧的 `end_turn` 读成 `answer`。
9. **黑名单 → 白名单也改变了"行为不正常的脚本"的结局**：从前"一步什么都没产出"会被当成
   正常收场（`end_turn` → 退出码 0、子代理当成功），现在它是 `empty`（退出码 1、
   子代理报异常）。三条既有用例正是踩着这个旧口径绿的（假响应只给了 `done`、没给正文），
   修法是把那些假响应补上一句话让"模型答了句"这个意图成立，**不是**去改判据。

---

## 6. 任务分解与验收

| # | 任务 | 落点 | 验收 |
| --- | --- | --- | --- |
| 1 | `TurnReason` 契约 + 唯一一处翻译 | 新增 `contract/turn.ts`、`events.ts`、`agent.ts`、`loop.ts` | 端点自定义串（`pause_turn`）到不了本轮收场；`end_turn` → `answer` |
| 2 | 截断续写 | `core/loop.ts` | 两次模型调用拼成一段（含 `onText` 累积）；连截 3 次后停手并出声，收场是 `truncated` |
| 3 | 空步重提示 | `core/loop.ts` | 对话里没有 `content: []` 的消息；重提示一次后拿到回答；两次都空 → `empty` |
| 4 | 保住炸掉的半句 | `core/loop.ts` | 中途抛错后 `messages` 里有那半句、**没有** tool_use block |
| 5 | 两侧认得出"没做完" | `cli/subagents.ts`、`cli/main.ts` | 被截断的子代理回给父级的是 `ERROR:`；一次性模式除 `answer` 外都是非零退出码 |

**检查点**（批量做，不逐任务卡）：

- **C1 = 任务 1+2**：两层停止原因成立，截断真的接上去。
- **C2 = 任务 3+4**：两条"不许消失"的路径（空步、半句）各自有断言。
- **C3 = 任务 5 + 全套**：子代理与退出码收口，整轮 `pnpm typecheck && pnpm lint && pnpm test`。

反向验证（至少两条，做法照旧：把实现改坏一次，确认那条断言真的会红）：

| 把什么改坏 | 该红的 | 实测 |
| --- | --- | --- |
| 删掉 §3.4 里那次 `messages.push` | §3.4 那两条"半句留下" | ✅ 两条红：`expected [ { role:'user', content:'干活' } ] to deeply equal [ …(2) ]` |
| `NORMAL_TURN_REASONS` 里加回 `'truncated'`（= 旧黑名单的形状） | §3.5 的"半截子代理不能当完整答复" | ✅ 一条红：`expected '前半截后半截再半截还半截' to contain '未正常结束（truncated）'` |

第二条红出来的样子值得记一笔：被砍断一半的子代理，它的半截答复**原样**交回了父级
（断言里的那串正文），父级当它是结论继续干活 —— 这就是 P8 要修的那个真 bug 的形状。

验收之外要同步的四处（仓库口径，不是可选项）：`README.md`（已知限制里那条"截断"，
以及命令/行为表里需要提的话）、`CHANGELOG.md`（P8 一节 + 总表行）、`docs/项目简介.md`、
MVP 设计 §9.2/§9.3 的 P8 列与出口标准；官网只在"已知限制"那一块补一句。
