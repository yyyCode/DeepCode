# DeepCode —— P4d 设计（`prompt.*` 与文本通道 · 可观测）

P4 的最后一片。路线图上的一句话是「多 surface 与可观测」，本片把它拆成两节做一节：

- **D1 文本通道**：`prompt.section` 转正、`tool.result` 与 `turn.stop` 两个新事件、`prompt.submit`
  加一条能携带文本的通道，于是 classic 钩子从 3 个事件扩到 6 个，hookify 也从 1 个事件扩到 4 个。
- **D2 可观测**：`$.telemetry` 名词 + 一行一条的本地 JSONL + 零自由文本行协议 + 默认关。
- **D3 多 surface**（`ui.render` 的渲染树、`session.attach/detach/receive/measure`）**明确不做**，
  理由在 §9。

这两节合起来是"插件终于能把话带进模型看得见的地方，内核也终于能看见自己在做什么"。
前者是**缝**（可以携带文本），后者是**闸的反面**（只读不拦）。

---

## 0. 决策摘要

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| 1 | D1 先做、D2 随后、D3 不做 | D3 的两个面今天**零消费者**（没有 TUI、没有第二端），落地等于把一个猜出来的形状冻进契约。详见 §9 |
| 2 | `prompt.section` 转正，其余 6 个 `prompt.*` 继续只声明 | 只有它有一个真实消费者：`AGENTS.md` / `CLAUDE.md` 的装载今天硬编码在 `main.ts:337`，搬进事件后"摘掉注册 = 指令不再进提示"可被测试钉住 |
| 3 | `tool.result` / `turn.stop` 是**新事件**；`prompt.submit` 只是**契约变宽** | 前两个在事件目录里本来就是声明-only 的`UnimplementedEvent`吗？不是 —— 它们是全新的第 40、41 个。后者与 P3 给 `tool.check` 加 `toolUseId` 同形，两项计数都不动 |
| 4 | 三处"携带文本"共用**一个概念**：`context: string` | 落点不同（工具结果 / 用户消息 / 新一轮输入），但形状与标记串只有一个定义，写在 `contract/prompt-channel.ts` |
| 5 | `turn.stop` 的"不让收手"有**内核侧上限 3 次** | 一个永远 block 的钩子会让 CLI 无限转下去。参考实现靠钩子自己看 `stop_hook_active`，那是把死循环的责任推给写钩子的人 |
| 6 | `tool.result` 只在工具**真的跑了**之后派发 | 被权限拒掉、被用户拒掉、白名单拦下的，工具没执行过 —— 给它们派一个"工具结果"事件是假账 |
| 7 | classic 桥扩到 6 个，`PostToolUseFailure` 仍不桥 | 它的 stdin 载荷形状我们没核实过；编一个不如如实缺着（§4.3） |
| 8 | hookify 的判定词汇**按事件分表**：`deny`/`ask` 只在 PreToolUse，`notify` 只在 PostToolUse 与 UserPromptSubmit，`deny` 在 Stop | 沿用"能表达才允许"：`allow` 表达不出来就该报错，那么"在工具已经跑完之后拒绝"同样表达不出来 |
| 9 | 遥测是**名词**，不是 `telemetry.log` / `telemetry.mark` 两个事件 | 参考实现把它们做成事件是为了让别的插件能旁观 —— 我们有**零个**旁观者。没人 dispatch 的事件就是装饰，这条在 P4c-1 已经吃过一次 |
| 10 | 遥测**默认关**，且**只有用户层能开**、托管层能关 | 一个克隆下来的仓库不该悄悄打开你的遥测 —— 与 `plugins.enableByUser` 同一条理由；托管层能关是"只能更严" |
| 11 | 零自由文本行协议：字段值只许数字 / 布尔 / **标识符**字符串，违规整条丢弃并计数 | 行里能塞自由文本，就等于给了插件一条"把文件路径与工具输入写进磁盘"的通道 |
| 12 | 不写采集器、不发网络请求、不做轮转 | 零运行时依赖是本项目的立身之本；一份越攒越大的本地 JSONL 是"明确不做"而不是"忘了做" |

---

## 1. P4d 的出口标准

路线图只给了"多 surface 与可观测"六个字，没有出口标准。这里补上，五条，都可验：

1. **classic 钩子在 6 个事件上真的生效**：`PostToolUse` 能把一段话带进模型的上下文、`Stop` 能不让本轮收手（且有上限）、`UserPromptSubmit` 能在提示进模型之前补一段。三个都不是"跑了一下"而是"产生了可观察的效果"。
2. **系统提示的组装走过 `prompt.section`**：把那个贡献者从 `cliPlugins` 里摘掉，`AGENTS.md` 的内容就真的不再出现在送进模型的消息里（有测试红）。
3. **hookify 的规则能在四个事件上生效**，且**每个事件只有它能兑现的词汇** —— 在 PostToolUse 上写 `deny` 是规则文件的错误，报错要点名"这个事件上能写的是 notify"。
4. **遥测关掉时零输出**：不建目录、不开文件、不写一行、不吭一声；打开后每次事件落成一行，行里塞自由文本会被拒并计数，文件在用户级目录、权限 0600，`session.end` 冲盘。
5. **托管层能把它强制关掉**，而项目层 / 本地层 / `--settings` 都**打不开**它（写了会被告知已丢弃）。

---

## 2. 事件目录这一次怎么变

| 动作 | 事件 | 结果类型 |
| --- | --- | --- |
| 新增 | `tool.result` | `{ context?: string }` |
| 新增 | `turn.stop` | `{ block?: string }` |
| 转正（从 `UnimplementedEvent` 移进 `EventArgs`） | `prompt.section` | `{ sections: readonly PromptSection[] }` |
| 变宽（不加事件） | `prompt.submit` | 加 `{ context?: string }` |

计数：**39 声明 / 19 实现 / 20 未实现 → 41 声明 / 22 实现 / 19 未实现**。
（声明 +2，其中实现 +2；另从未实现里转正 1 个，故实现净 +3、未实现 −1 −2 = 19。算式见下。）

- 声明：39 + 2 = **41**
- 实现：19 + 2（新事件）+ 1（`prompt.section` 转正）= **22**
- 未实现：41 − 22 = **19**（原先 20，转正走掉 1 个）

三个新落点的链尾兜底**不在** `NOTIFICATION_EVENTS` 里 —— 它们都能携带文本，不是纯通知。
`tool.result` / `turn.stop` 在 `coreImpls` 里各给一条**缝**的默认值（`{}`），与 `skill.prompt` 同一族：
没人要说话，就什么都不加。**别把它们"统一"成 `tool.check` 那条 fail-closed 的形状** ——
在缝上 fail-closed，等于一个没人应答的钩子点把每一次工具调用都拦死。

`prompt.section` 的链尾兜底是 `{ sections: [] }`（能力方向的 fail-closed：没有贡献者就是没有）。

---

## 3. D1 之一：一份 `context`，三个落点

### 3.1 共用的一小块

```ts
// src/contract/prompt-channel.ts —— contract/ 是叶子，这个文件零 import
export const CONTEXT_MARKER = '[钩子补充的上下文]';

/** 把一段钩子给的上下文并进一段既有文本。空/纯空白 = 原样返回，不留空标记。 */
export function withContext(text: string, context: string | undefined): string {
  const extra = context?.trim() ?? '';
  if (extra === '') return text;
  return `${text}\n\n${CONTEXT_MARKER}\n${extra}`;
}
```

标记串**只有这一个定义**。三处落点都长一个样，用户翻转录时看到的就是同一句话。
长度不再另设上限 —— `hook-run.ts` 的 `OUTPUT_CAP`（64 KiB）已经在钩子那一头卡住了。

### 3.2 落点一：`tool.result`（新事件）

```ts
'tool.result': {
  readonly tool: string; readonly input: unknown; readonly toolUseId: string;
  readonly ok: boolean; readonly output: string;
};
```

派发点在 `loop.ts` 的 `runOneTool` **末尾**：算出 `content` 之后、`return` 之前。

- 只有工具**真的跑了**才派。白名单外、`tool.check` 判 deny、用户拒了 `ask`、`tool.call` 返回 deny —— 四者都不派（§0 决策 6）。
- `ok` 复用既有的约定：`!content.startsWith('ERROR:')`（`loop.ts:279` 已经在用它算 `isError`）。这条字符串 sniff 不好看，但它是**既有**的约定；这里另立一套会让同一件事有两个判据。
- 返回的 `context` **追加到那条工具结果的正文后面**（`withContext`），于是模型下一条消息就读到它，转录里也留着。这正是"补充上下文"该有的位置：它说的是关于**这次工具调用**的事。

**它同时是 D2 的观测点**（§6.5）：遥测插件挂在这个事件上记 `{tool, ok}`，不需要往工具执行路径里再塞一个钩子。

### 3.3 落点二：`prompt.submit` 的 `context`

```ts
'prompt.submit': { readonly handled?: boolean; readonly context?: string };
```

`repl.ts` 与 `main.ts` 的一次性模式各有一处 `messages.push({ role: 'user', content: trimmed })`，
两处都改成 `withContext(trimmed, submitted.context)`。

**为什么拼进用户那条消息、而不是另插一条**：另插一条会造出两条连续的 `user` 消息，
而"user / assistant 严格交替"是某些端点会拒的形状 —— 我们没有承诺过要保证交替，
但也没有理由为了一句补充说明去踩这个坑。拼进去的代价是**转录里也含这段**，
这是对的：模型当时看到的就是这个。

### 3.4 落点三：`turn.stop`（新事件）与收手上限

```ts
'turn.stop': { readonly stopHookActive: boolean; readonly lastMessage: string };
// → { readonly block?: string }
```

`lastMessage` 是模型这一轮说过的最后一段文本（可能为空串）。**没有它，"不让收手"就没有触发条件** ——
一条 Stop 规则只能无条件地拦，那就是个绊脚石而不是规则。参考实现同名字段（`last_assistant_message`）。
它也是本事件里唯一可以拿来匹配的文本，于是 hookify 在 `Stop` 上的 `field` 取的就是它（§5.2）。

派发点在 `runTurn` 里模型**不再要工具**的那一支（`loop.ts:169`）：

```ts
if (toolUses.length === 0) {
  const stopped = await ctx.dispatch('turn.stop', { stopHookActive: blocked > 0 }, CORE_ORIGIN);
  const text = stopped.block?.trim() ?? '';
  if (text !== '') {
    if (blocked < MAX_STOP_BLOCKS) { blocked += 1; messages.push({ role: 'user', content: text }); continue; }
    ctx.$.ui.notice(`钩子第 ${MAX_STOP_BLOCKS} 次不让收手，已忽略（再往下就该是死循环了）`);
  }
  exhausted = false;
  break;
}
```

- `block` 的文本**作为一条新的 user 消息**推进去，然后**继续这个 turn**（`continue` 走下一跳）。
  它是"还没干完，接着干"的指令，本来就该是新一轮的输入。
- **上限 3 次**（`MAX_STOP_BLOCKS`，导出，供测试）。超了**忽略 block 并出声** —— 不是静默忽略：
  "我拦了 4 次你都不理"和"我拦了 4 次"对写钩子的人是两条不同的信息。
- 撞上限的那个 turn 收手时 `stopReason` 仍是 `end_turn`（用户看到的是"模型说完了"），
  只有连续转到 hop 上限才是 `max_hops`。区别在于：前者是"钩子不放手"，后者是"模型不放手"，
  而两者都已经被 `ui.notice` 说出去了。
- `stopHookActive` 给钩子一个自己判断的机会（参考实现同名字段），但**内核的上限不依赖它**。

### 3.5 `prompt.section`：系统提示的组装过一遍事件

```ts
'prompt.section': Record<string, never>;
// → { readonly sections: readonly PromptSection[] }
// PromptSection = { readonly name: string; readonly text: string }
```

`main.ts` 今天这一处：

```ts
const systemPrompt = [SYSTEM_PROMPT, instructions ?? '', renderOffer(offer)]
  .filter((part) => part !== '').join('\n\n');
```

改成：

```ts
const sections = await dispatch('prompt.section', {}, CORE_ORIGIN);
const systemPrompt = [SYSTEM_PROMPT, ...sections.sections.map((s) => s.text), renderOffer(offer)]
  .filter((part) => part !== '').join('\n\n');
```

`loadInstructions` **整个搬进** `src/builtins/instructions.ts` 的 `createInstructionsPlugin({root, home})`，
读文件改用 `$.fs`（于是这个插件只依赖 `contract/` 与 `$`，能坐在 `builtins/`）。
只有 `ENOENT` 当"这个文件没有"；别的读不动照旧抛出去（`exists` 那种"什么错都当没有"
会把一个权限错误变成安静的失效，而那正是本项目最想防的失败形状）。

**节序规则**（今天只有一个贡献者，写下来是给下一个贡献者看的）：每个 hook 的形状是
`const inner = await next(e); return { sections: [...inner.sections, mine] }` ——
**内层在前**，而同一 tier 内"先注册的在外层"，于是同一 tier 内的节序是**注册顺序的倒序**。
跨 tier 则是 tier 序（`prepend` 的贡献最后出现）。这条规则今天没有第二个使用者。

**清单一节（`renderOffer`）有意没走这条路**：它要的是 `agent.offer` 的结果，而插件拿不到
`dispatch`；把另一个事件的结果塞进 `prompt.section` 的 args 比留一处硬编码更坏 ——
那会让"这个事件的输入是什么"变成一个递归的问题。记为已知偏差（§8）。

---

## 4. D1 之二：classic 桥从三个扩到六个

```ts
export const BRIDGED_EVENTS = {
  PreToolUse: 'tool.check',
  PostToolUse: 'tool.result',
  UserPromptSubmit: 'prompt.submit',
  Stop: 'turn.stop',
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
} as const;
```

`registerHooks`（`cli/classic-hooks.ts`）今天是三个 `if/else`，扩到六个之后改成**按落点分派**：
`tool.check` 与 `tool.result` 共用"带 matcher 的工具钩子"那一支（`tool.result` 有 `e.tool`，
matcher 照样能筛），`prompt.submit` / `turn.stop` 各一支，`session.*` 沿用现成的通知支。

### 4.1 六个事件上的判定表

一张表定完。`fail`（起不来 / 超时 / 别的退出码）那一列与今天一致：**只在能拦的事件上拦**。

| classic 事件 | 链尾落点 | `silent` | `exit 2` | 判定 `allow` | 判定 `ask` | 判定 `deny` | `fail` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PreToolUse` | `tool.check` | 往下 | **deny** | 第三方忽略（喊一声） | **ask** | **deny** | **deny** |
| `PostToolUse` | `tool.result` | `context` 注入 | `reason` 当 `context` | 忽略（喊一声） | 忽略（喊一声） | 忽略（喊一声） | notice，不注入 |
| `UserPromptSubmit` | `prompt.submit` | `context` 注入 | `reason` 当 `context` | 同上 | 同上 | 同上 | notice，不注入 |
| `Stop` | `turn.stop` | 不注入 | `reason` 当 `block` | 忽略（喊一声） | 忽略（喊一声） | **block** | notice，不 block |
| `SessionStart` | `session.start` | 打一行 | notice | — | — | — | notice |
| `SessionEnd` | `session.end` | 打一行 | notice | — | — | — | notice |

三处值得写明的推论：

1. **`exit 2` 在拦不住的事件上降级成"说话"**。退出码 2 的语义本来就是"拦住，理由给模型看"；
   在工具已经跑完、提示词即将进模型的时刻，没有可拦的动作，而它的 stderr 本来就是写给模型看的
   —— 于是降级成 `context`。参考实现同向（`exit 2` 在这些事件上把 stderr 反馈给模型）。
2. **`allow` / `ask` / `deny` 在非阻断事件上"表达不出来"，但要喊一声**。与今天处理第三方
   `allow` 那条一字不差：当它没说过，同时 `$.ui.log` 说一句"这个事件上改不了裁决，这条判定被忽略"。
   静默忽略会让人以为自己写对了。
3. **`fail` 在非阻断事件上不注入、只 notice**。它没有可拦的动作，而"一个坏掉的钩子必须让动作停下来"
   这条不适用于"已经发生的事"。让一段来路不明的文本进模型上下文才是更坏的方向。

### 4.2 `classify` 要多读一个字段：`additionalContext`

`hook-run.ts` 的 `classify` 今天只认 `permissionDecision` / `permissionDecisionReason`。
加一条读取：`hookSpecificOutput.additionalContext`（或顶层同名），字符串，去空白后非空才算。
`HookVerdict` 的四种形态各加一个可选的 `context?: string`。

这不是新协议 —— 参考实现的事件输出里 `additionalContext` 是**通用**的那一个字段，
而 `permissionDecision` 只是它的一种。我们的读取顺序照旧：判定是判定，上下文是上下文，两者可以同时出现。

### 4.3 为什么 `PostToolUseFailure` 还是桥不了

它需要一个**失败专用**的载荷（参考实现里字段是 `error` 之类），而那份形状我们没有核实过。
按已知的写会编出一个错的 stdin，"如实缺着"更便宜 —— 与 `$CLAUDE_ENV_FILE` 那条同一个取向。
`tool.result` 的 args 里本来就有 `ok`，将来核实完形状，桥它是一行的事。

---

## 5. D1 之三：hookify 的四个事件与逐事件词表

### 5.1 规则文件上加一个 `event` 字段

```
---
name: no-aws-keys
event: PreToolUse          # 省略 = PreToolUse（既有规则文件一个字都不用改）
tool: Write|Edit
field: content
operator: matches
pattern: AKIA[0-9A-Z]{16}
decision: deny
message: 这段内容看着像 AWS access key。
---
```

`event` 取值只有 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop`，别的值**报错并点名**
（不是"跳过"—— 一个规则文件被静默忽略，正是 hookify 最该防的事）。

### 5.2 逐事件词表：能表达才允许

| `event` | 允许的 `decision` | 命中的效果 |
| --- | --- | --- |
| `PreToolUse` | `deny` / `ask` | 拦下 / 先问一次（今天的行为，不变） |
| `PostToolUse` | `notify` | 工具的**结果**后面跟着追上 `message`，模型下一条消息读到 |
| `UserPromptSubmit` | `notify` | 用户那句话的**前面**补上 `message`，然后才进模型 |
| `Stop` | `deny` | 不让本轮收手，`message` 作为新一轮输入 |

写错词汇是**规则文件的错误**（`RuleError`），报错点名：`在 PostToolUse 上写了 deny ——
这个事件上能表达的是 notify（工具已经跑完了，"拒绝"在这里是空头承诺）`。

`decision` 与 `event` 一样可以省略，默认值就是那张表里唯一（或第一个）的那个：
`PostToolUse` / `UserPromptSubmit` 省略即 `notify`，`PreToolUse` / `Stop` 省略即 `deny`。

**`field` 在哪个对象里取**：一张表定死，因为"我以为是字符串"是这个 DSL 最常踩的坑。

| `event` | `field` 取值处 | 典型写法 |
| --- | --- | --- |
| `PreToolUse` | `tool_input`（既有行为，不变） | `field: content` |
| `PostToolUse` | `tool_response`（我们桥成 `{ ok, output }`） | `field: output` |
| `UserPromptSubmit` | `{ prompt }` | `field: prompt` |
| `Stop` | `{ last_assistant_message }` | `field: last_assistant_message` |

`tool_response` 的形状是我们定的（`{ok, output}`），不是参考实现那一个 —— 本地钩子的 stdin
本来就由我们写，如实标在 README 里比假装一样好。

`notify` 是新加进词汇表的第三个词，理由和当年砍掉 `allow` 是同一条，只是方向反过来：
**在那个事件上表达不出来的动作，不该让它看起来能写**。
`Stop` 上继续用 `deny`（"不允许停止"本来就是一次拒绝）而不是再发明一个词。

### 5.3 一个脚本，四个事件

`hooks/pretooluse.mjs` 改名 `hooks/hook.mjs`，按 stdin 里的 `hook_event_name` 分派：

| 事件 | 输出 |
| --- | --- |
| `PreToolUse` | `hookSpecificOutput.permissionDecision` + `permissionDecisionReason` |
| `PostToolUse` / `UserPromptSubmit` | `hookSpecificOutput.additionalContext` |
| `Stop` | `hookSpecificOutput.permissionDecision: 'deny'` + `permissionDecisionReason` |

`hooks.json` 从 1 个事件变成 4 个，四节都指向同一个脚本。
`plugin.json` 的 `uses` 同步扩到 `["tool.check","tool.result","prompt.submit","turn.stop"]`
—— **不改这一条，整个插件在装载期会被撤掉**（`core/third-party.ts` 按事件名查 `uses` 越界）。
校验器那边 `W10` 本来就盯着这件事，改完 `uses` 它就不响了。

### 5.4 失败方向不变

四条规则读不懂 → `exit 1` → `fail`。在 `PreToolUse` 上仍是**拦下所有工具调用**；
在另外三个事件上退化成"notice 一声、什么都不注入/不 block"（§4.1 第三行）。
这个差别要写进 hookify 的 README：**同一个坏了，代价看在哪个事件上**。

---

## 6. D2：可观测

### 6.1 为什么是一个名词，不是两个事件

参考实现把 `telemetry.log` / `telemetry.mark` 做成事件，是为了**让别的插件能旁观**
（谁在记录什么、要不要拦）。今天我们有零个旁观者 —— 造两个没人 dispatch 的事件就是装饰。
而 `engine.create` 的折叠口子早就在（`contract/engine.ts:91-98` 的 `declare module` 注释就是为它写的），
一个名词挂上去就够了。

### 6.2 零自由文本行协议

```ts
export type TelemetryEntry = {
  readonly kind: string;                                    // ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$
  readonly fields?: Readonly<Record<string, number | boolean | string>>;  // 键同上正则
};
// 值：有限数字 / 布尔 / 标识符形状的字符串（同一条正则）
// 违规 → 整条丢弃 + 计数 + 第一次出现时 warn 一行（不是截断，不是改写）
```

**为什么这么严**：能塞自由文本，就等于给了插件一条"把用户的文件路径、工具入参、
模型输出写进磁盘"的通道。这条协议是这份功能唯一的隐私闸门，松一格就没了。
行本身由我们补上 `at`（ISO 时间戳）与 `seq`（自增整数）—— 那两个是**我们生成的**，不走插件校验。

### 6.3 落盘

- 路径：`<home>/.deepcode/telemetry.jsonl`（用户级，**不是**项目级）。
  与转录同一条理由：它记的是你的操作，不是这个仓库的东西；写到项目里会被 git 带走。
- `mkdir -p` 目录 + `appendFile`，文件创建时 `mode: 0o600`（POSIX 上免费的那点保险，与转录一致）。
- **批量**：缓冲到 20 行或 `session.end` 时一次写完。一次 `appendFile` 写完这一批，
  崩在中间只坏最后一行 —— 与转录的写法定式一致。
- **冲盘失败不影响主流程**：notice 一次，然后不再重试（遥测坏掉不该让会话坏掉）。
- 被强制杀掉（Ctrl-C 连击 / 断电）会丢掉缓冲区里那几行。**能丢是设计的一部分**。

### 6.4 开关：只有用户层能开，托管层能关

`settings.json` 顶层新增 `telemetry: { enabled: boolean }`（加进 `KNOWN_TOP_LEVEL`）。

```ts
enabled = (用户层 === true) && (托管层 !== false)
```

- **只有用户层能开**：项目层 / local / `--settings` 写了 `enabled: true` 一律**丢弃并 warn** ——
  一个克隆下来的仓库不该悄悄打开你的遥测（与 `plugins.enableByUser` 完全同构）。
  它们写 `false` 也不生效（默认就是关的，写了只当没写）。
- **托管层能关**：它压过用户层。这是"只能更严"在这份设置上的落法 ——
  托管层管不了你开不开，但能一句话把它关掉。
- `ResolvedPolicy.telemetry = { enabled: boolean; why: string }`，`why` 是给人看的一句话
  （`默认关` / `用户层开了` / `托管层把它关了`），`/telemetry` 直接打出来。

### 6.5 谁真的在发射

**六个事件，全部第一方**。第三个是新增的 `tool.result`，其余五个是现成的通知事件：

| 事件 | 行 |
| --- | --- |
| `session.start` | `{kind:'session.start', fields:{session: <id>}}` |
| `session.end` | `{kind:'session.end', fields:{reason}}`（这条之后冲盘） |
| `turn.complete` | `{kind:'turn.complete', fields:{stopReason, inputTokens, outputTokens, estimated}}` |
| `tool.result` | `{kind:'tool.result', fields:{tool, ok}}` |
| `session.compact` | `{kind:'session.compact', fields:{trigger, tokensBefore}}` |
| `agent.spawn` | `{kind:'agent.spawn', fields:{agent}}` |

一条硬规矩：**这些 hook 一律 `return next(e)`**，不改任何裁决、不加任何文本。
遥测是**读者**，不是链上的一环。挂在 `tool.result` 上而不是 `tool.call` 上，正是为了让它在
工具执行路径之外（`tool.call` 的 hook 会包住真正的执行，透明度是个额外的负担）。

### 6.6 `/telemetry`

只读一条命令，打出：开/关 + `why` + 文件路径 + 本次会话写了几行 / 拒了几行（附第一次拒绝的理由）。
**不做 `/telemetry on|off`** —— 那个开关要落盘成设置，而 `config.set` 的可写白名单只有 `model`
（P4c-2 定的），为它开第二个写入口不值得。打开它要手改 `~/.deepcode/settings.json`，README 里写清楚。

插件住 `cli/`（它要 `node:fs` 的 `appendFile` / `mkdir` 与权限位，`$.fs` 没有这两样），
与 `config-command` / `transcript` 同一个先例。拆三个文件：

- `contract/telemetry.ts`? **不** —— 名词类型跟着插件走（`cli/telemetry.ts` 里
  `declare module '../contract/engine'`），与 `engine.ts:91-98` 那段注释描述的用法一致。
- `cli/telemetry-rows.ts`：纯逻辑（正则、`validateEntry`、`formatRow`、路径拼接）。零 IO。
- `cli/telemetry-sink.ts`：带缓冲的写盘（IO 可注入：`append` / `mkdir` / `now`）。
- `cli/telemetry.ts`：插件本体（挂事件、提供名词、`/telemetry` 命令）。

---

## 7. 验收标准

按本项目的惯例：任务级只跑 `pnpm typecheck`，测试与反向验证按检查点批量做。

### C1：纯单元 / 纯函数（批量）

- `withContext` 的三条分支（空上下文原样、有上下文带标记、标记只有一处定义）。
- `classify` 读 `additionalContext` 的四种形态（silent+context / say+context / block+context / 非字符串忽略）。
- hookify 的 `RuleError`：不认识的 `event`、四个事件 × 非法 `decision` 八条、合法的四条。
- `validateEntry`：合法的 kind/字段、大写与冒号连字符、**被拒的九种**（空格、中文、超长、空、数字键、`undefined`、`NaN`、`Infinity`、非标量值）。
- `resolvePolicy` 的 `telemetry` 四条：默认关、用户层开、用户层开+托管关、项目层写 true 被丢弃并 warn。

### C2：链上 / 端到端

- `tool.result` 的 `context` 真的进了那条工具结果，且**被拒的工具不派发**（四种拒绝路径各一条）。
- `turn.stop` 的 block 真的让 turn 多转了一轮；`MAX_STOP_BLOCKS` 撞上限后忽略并 notice；`stopHookActive` 第二次为 true。
- `prompt.submit` 的 `context` 进了 user 消息（repl 与一次性模式各一条）。
- `prompt.section`：摘掉 `instructions` 插件，`AGENTS.md` 不再进系统提示（**这条就是出口标准 2**）。
- classic 六个事件的判定表逐格验（用 `test/fixtures/hooks/` 里现成的桩 + 新增 `say-context.mjs`）。
- hookify 端到端：`plugins/hookify` 装进一个临时项目，四个事件各命中一条规则（**出口标准 3**）。
- 遥测：关着的时候一个文件都不建（**出口标准 4**）；开着时 `turn.complete` 等事件落成行；
  自由文本被拒并计数；`/telemetry` 打出的行数与实际写盘行数一致；托管层关掉后用户层打开了也零输出（**出口标准 5**）。

### C3：反向验证（每片 3–5 条变异，每条都要先确认变异真的落上了）

候选：把 `MAX_STOP_BLOCKS` 的 `continue` 改成 `break`；把 `tool.result` 的派发提前到 `tool.check` 之前；
把 `withContext` 的标记去掉；把 `validateEntry` 的字符串正则换成 `typeof value === 'string'`；
把 `enabled` 的 `&& policy !== false` 去掉；把 `instructions` 插件的注册从 `cliPlugins` 里删掉（这条必须红）。

---

## 8. 已知偏差与存疑

1. **`prompt.context` / `prompt.attachment` / `prompt.fill` / `prompt.suggest` / `prompt.edit` /
   `prompt.compose` 仍然只声明**。它们各自对应一个我们还没做的功能（附件、提示词补全、
   提示词编辑、结构化 context 段），今天没有消费者。如实标注，不造空实现。
2. **清单一节（`renderOffer`）没走 `prompt.section`**，理由见 §3.5。
3. **`PostToolUseFailure` 不桥**，理由见 §4.3。
4. **遥测不做 `telemetry.log` / `telemetry.mark` 两个事件**，也不做网络采集器、不做轮转、不做保留期。
5. **遥测行的时间戳与序号由内核生成**，不走插件的自由文本校验 —— 这是协议的一部分，不是例外。
6. **`prompt.section` 的节序规则**（内层在前 = 同一 tier 内注册顺序的倒序）今天只有一个使用者，
   规则是推出来的、没有第二个用例验证过。
7. **`$.telemetry` 是插件提供的名词**：只在那个插件装上的时候存在。测试桩或别的装配里少了它，
   `$.telemetry` 会是 `undefined`；调用方（今天只有遥测插件自己）要自己保证。
8. **hookify 的 `event` 字段是新加的**，省略即 `PreToolUse`，既有规则文件不受影响 ——
   但规则文件里如果原本写了一个叫 `event` 的未知字段，今天它只告警、改完会开始生效。这条
   在 hookify 的 README 里点名。
9. **一次性模式（`deepcode "..."`）也派 `prompt.submit`，但只采纳 `context`，忽略 `handled`**。
   `handled` 的语义是"这一行输入被吃掉了，别送给模型"—— 一次性模式没有可以"继续"的交互循环，
   把它当真会得到一个**静默什么都没做、退出码 0** 的调用。两害相权：让 `UserPromptSubmit`
   钩子在脚本模式里也能补上下文，代价是 `handled` 在那里没有意义（写进文档）。

---

## 9. 明确不做

- **D3 多 surface**：`ui.render` 的 `RenderNode` 与 `session.attach/detach/receive/measure`。
  理由：**零消费者**。没有 TUI、没有第二个前端、没有远程会话，"surface" 是什么今天说不出来。
  `RenderNode` 现在是一份**暂定**的形状（`events.ts:169-175` 写明了"P3 真接上时该改就改"），
  为它写实现就是把一个猜出来的数据树冻进契约。同理，`session.receive` / `attach` 的真实语义
  要有一个"第二端"才能定，而今天连那个端是什么都答不上来。
  落地它们会产出**能编译、能过测、什么也不做**的代码 —— 那正是本项目把
  "装饰性断言"挑出来骂过的东西。留住契约、如实标着未实现，是这一片对它们最负责的处理。
- **`SubagentStart` / `PreCompact` / `PostCompact` 的 classic 桥**（引擎事件早就有，
  桥一行的成本也很低）：它们不在本片的出口标准里，加进来只会让 §4.1 那张表多三行没人用的格子。
- **`/telemetry on|off`**，理由见 §6.6。
- **遥测的网络上报、轮转、保留期、采样**。
- **`prompt.*` 另外六个事件的实现**，理由见 §8.1。

---

## 10. 关键文件索引

| 文件 | 这一片对它的动作 |
| --- | --- |
| `src/contract/prompt-channel.ts` | **新建**：`CONTEXT_MARKER` / `withContext` |
| `src/contract/events.ts` | 加 `tool.result` / `turn.stop`；`prompt.submit` 加 `context`；`prompt.section` 从 `UnimplementedEvent` 移出并转正 |
| `src/contract/classic.ts` | `BRIDGED_EVENTS` 3 → 6；注释与计数跟上 |
| `src/core/loop.ts` | `runOneTool` 末尾派 `tool.result` 并把 `context` 并进结果；`runTurn` 的收手支派 `turn.stop` + `MAX_STOP_BLOCKS` |
| `src/core/create.ts` | `tool.result` / `turn.stop` / `prompt.section` 三条链尾缝的默认值 |
| `src/cli/main.ts` | 系统提示改走 `prompt.section`；`loadInstructions` 搬走；一次性模式拼 `context` |
| `src/cli/repl.ts` | `prompt.submit` 的 `context` 拼进 user 消息 |
| `src/builtins/instructions.ts` | **新建**：`createInstructionsPlugin`（`AGENTS.md` / `CLAUDE.md` 的装载） |
| `src/cli/plugins.ts` | 装 `instructions` 与 `telemetry` 两个插件；座位表 |
| `src/cli/hook-run.ts` | `classify` 多读 `additionalContext`，`HookVerdict` 四形态各加 `context?` |
| `src/cli/classic-hooks.ts` | 六个事件的分派与判定表 |
| `src/contract/plugin-manifest.ts` | `W3` 那句写死的三个事件名改成从 `BRIDGED_EVENTS` 推 |
| `src/cli/settings.ts` | `telemetry` 顶层键 + 解析规则 + `TelemetryPolicy` |
| `src/cli/telemetry-rows.ts` | **新建**：纯逻辑 |
| `src/cli/telemetry-sink.ts` | **新建**：带缓冲的写盘 |
| `src/cli/telemetry.ts` | **新建**：插件本体 + 名词 + `/telemetry` |
| `plugins/hookify/core/rules.mjs` | `event` 字段 + 逐事件词表 |
| `plugins/hookify/hooks/hook.mjs` | 由 `pretooluse.mjs` 改名，按 `hook_event_name` 分派 |
| `plugins/hookify/hooks/hooks.json` | 1 个事件 → 4 个 |
| `plugins/hookify/plugin.json` | `uses` 扩到四个引擎事件 |
| `plugins/hookify/README.md` | 四个事件、逐事件词表、失败代价的差别 |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 事件计数 41/22/19、遥测一节、路线图 P4 收口 |
