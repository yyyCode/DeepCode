# DeepCode P14 Agent 循环与计划模式设计

> 对标 Claude Code 的 **Tool-Use Loop** 与 **Plan Mode**（用户提供的「Agent 循环」材料）。
> 一句话口径：**循环里没有"思考"这一步，只有工具调用与收手；计划模式不是引擎分支，是两个普通工具。**

---

## 1. 现状与差距

P13 结束时，DeepCode 的循环已经是 Tool-Use 形状：`runTurn` 每一跳发一次模型请求，
流里要么出 `tool_use`（继续），要么 `end_turn`（收手）；工具结果作为一条 `tool` 消息
推进历史，然后下一跳。也就是说，材料里最核心的那条 —— **不做 ReAct 的
Thought-Action-Observation 三段式** —— DeepCode 一开始就是对的，只是没有把它写成契约。

真正的差距在计划模式，以及"循环形状"本身没有任何度量：

| 复刻对象 | DeepCode 之前 |
| --- | --- |
| 一次请求一次决策：`tool_use` 或 `end_turn` | 已有，同形（`src/core/loop.ts`） |
| 不强制模型先写 Thought 再行动 | 已有；`text` 与 `tool_use` 并存，text 只给人看 |
| 计划模式：只读探索，不改文件 | 无 |
| `EnterPlanMode` / `ExitPlanMode` 是普通工具，不是引擎分支 | 无 |
| 计划写进文件，退出前落盘 | 无 |
| 计划模式里每 5 轮提醒一次 | 无 |
| 用户批准后才恢复权限；拒绝则继续规划 | 无 |
| 手动入口（材料里是 Shift+Tab） | 无 |
| "框架额外请求数"可度量 | 无 —— 没人能证明循环没有偷偷多打一轮 |

差距不只是"少了一个模式"。**没有计划模式，复杂任务会在探索阶段就开始改文件**：
模型读到第三个文件时已经动过手，方案错了也只能在已经改坏的树上继续。
计划模式把"探索"与"执行"拆成两段，代价是模型面需要一条只读提示与一套更窄的工具清单。

---

## 2. 设计口径

### 2.1 循环的形状：一次请求 = 一次决策

`runTurn` 的一跳只做四件事：

1. 拿当前工具清单发请求；
2. 收 `text`（推给渲染器）与 `tool_use` block；
3. 执行工具，把结果作为**一**条 `tool` 消息推进历史；
4. 没有 `tool_use` 就收手。

没有"先思考、再行动"的强制两段，也没有把 `text` 回灌成下一步输入。
模型愿意写一段说明再调工具可以，直接调也可以 —— **框架不要求 Thought**。

DeepCode 在"收手"之前另有三道缝（截断续写、空步重提示、`turn.stop` 钩子），
它们都是 P8/P4 的既有行为，发生在 `toolUses.length === 0` 之后。它们会真的多花模型请求，
但**只花在"这一轮没写完"上**，不会改变"工具批次数 + 1"这个基本账 —— benchmark 第一张表量的就是它。

### 2.2 计划模式是工具，不是引擎分支

复刻对象把 `EnterPlanMode` / `ExitPlanMode` 暴露成普通工具，引擎不认识"计划模式"。
DeepCode 照抄这条口径，理由比"抄"更实在：

- 引擎一旦多一个 `if (planMode)`，所有既有测试、所有子代理路径都要知道这个分支；
- 工具是插件面已有的能力 —— `tool.describe` 能收窄清单，`tool.check` 能拒绝，
  `tool.call` 能改状态，`prompt.section` 能注入动机，`turn.start` 能计数；
- `runTurn` **一个字没改**。计划模式整个落在 `src/builtins/plan.ts` 一个插件里。

### 2.3 只读是两道闸，不是一句提示

计划模式的说明文字只是让模型少浪费几次被拒的调用，真正拦住写操作的是两层：

1. `tool.describe` 把非只读工具从**模型可见清单**里藏掉；
2. `tool.check` 对**点名调用**再拒一次。

第二层不是冗余。模型可以凭空点名一个它没见过的工具（幻觉、提示注入、或者插件替它
应答）；藏起来只保证"看不见"，不保证"够不着"。白名单之外一律 `deny` —— 包括
未来新增的、我们还没决定要不要放行的工具。这是 **fail-closed**：不认识的就不许。

### 2.4 批准是单向门，默认拒绝

`ExitPlanMode` 的顺序是固定的：

1. 计划为空 → 直接 `ERROR`，不写盘、不问人；
2. 写计划文件（`mkdir -p` 后写入）→ 写失败就是 `ERROR`，**不问人、不退出**；
3. 问用户（`y` 批准 / `n` 继续规划），`fallback: 'n'`；
4. 只有 `y` / `yes` 才 `leave()` 并恢复权限。

非交互、EOF、Ctrl-C 读不到答案时走 `fallback`，因此都留在计划模式。
拒绝时计划文件仍然保存 —— 被拒的是**执行**，不是计划本身；用户下一轮还能接着改。

### 2.5 不动静态前缀（P13 的缓存不受影响）

计划模式只往 `prompt.section` 里加一节（`name: 'plan-mode'`），属于**动态尾巴**。
P13 的七个静态分节一个字节不动，`cache_control` 断点仍在静态段末尾，
计划模式开关不会让缓存前缀失效。

### 2.6 只收窄，不扩权

"计划批准"恢复的是**原有**权限链（`confirm`、`permissions`、`sec-default` 照常），
不是"批准 = 全放行"。计划模式从不开任何一条新权限，它只会把工具面变窄。

### 2.7 计划文件落在 `.deepcode/plans/`

不复刻 `.claude/plans/`：DeepCode 有自己的 `.deepcode/` 目录（转录、记忆、工具结果外置都在它下面），
且它已经在 `.gitignore` 里。文件名：

```
.deepcode/plans/plan-<session-id>-<timestamp>.md
```

会话 id 先洗掉路径分隔符等字符（`[^A-Za-z0-9._-]` → `_`），空字符串回落 `session`。
时间戳保证同一会话多次进入不会覆盖上一次的计划。

---

## 3. 架构

```
                    ┌──────────────── 引擎（runTurn，未改）────────────────┐
用户输入 ──► REPL ──►│ turn.start ──► listTools ──► provider.stream ──► …  │
                    │      │             │                │               │
                    └──────┼─────────────┼────────────────┼───────────────┘
                           │             │                │
                plan-mode.tick()   tool.describe 链   tool.check 链
                           │             │                │
                     turns += 1    非只读 → hidden    非白名单 → deny
                           │             │                │
                     prompt.section  ────┘           tool.call
                     （只读说明 + 计划路径）           ├─ EnterPlanMode → 打开状态
                                                     └─ ExitPlanMode  → 写盘 + 批准
```

三张面各管一件事，互不替代：

| 面 | 钩子 | 作用 |
| --- | --- | --- |
| 工具清单 | `tool.describe` | 让模型**看不见**写工具 |
| 准入 | `tool.check` | 让点名调用**过不去** |
| 提示 | `prompt.section` | 让模型知道为什么工具少了、下一步该做什么 |

`/plan` 是手动入口，走 `command.run`；它与 `EnterPlanMode` 共用同一个 `PlanMode` 状态对象。

---

## 4. 逐层设计

### 4.1 循环（既有，P14 只加度量）

| 事实 | 值 | 位置 |
| --- | --- | --- |
| 每跳一次模型请求 | 是 | `src/core/loop.ts` |
| 收手条件 | 本跳没有 `tool_use` | 同上 |
| 跳数上限 | 25（子代理可覆盖） | `MAX_HOPS` |
| 只读工具 | 成批并发，写工具是屏障 | `runTools` |
| 工具结果形状 | 一轮汇总成**一条** `tool` 消息 | 同上 |
| 截断 | `max_tokens` 时续写（有上限，每次都出声） | P8 §3.2 |
| 空步 | 重提示一次 | P8 §3.3 |

P14 不改这些行为，只新增 `scripts/benchmark-agent-loop.ts` 把"请求数 = 工具调用数 + 1"钉住。
provider 是脚本，跑的是真的 `runTurn` —— 不是模拟循环。

### 4.2 状态

```ts
type PlanMode = {
  active(): boolean;
  path(): string | undefined;
  turns(): number;
  enter($): string;   // 建路径、置 active；已在内则返回状态
  leave(): void;      // 直接退出，已保存的计划文件不动
  tick(): void;       // turn.start 调一次
  prompt(): string | undefined;
  status(): string;
};
```

状态是纯对象，不持有引擎、不碰磁盘（`enter` 只读 `session.id` / `session.root` / `clock.now`）。
测试与 benchmark 可以直接构造它看状态，不必经过模型。

### 4.3 工具面收窄

```ts
const PLAN_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill']);
const PLAN_TOOLS      = new Set(['EnterPlanMode', 'ExitPlanMode']);
const PLAN_ALLOWED    = new Set([...PLAN_READ_TOOLS, ...PLAN_TOOLS]);
```

`Skill` 算只读：它只把一段正文加载进上下文，不碰磁盘。
`Task` / `Bash` / `Write` / `Edit` / `Memory` 一律不在计划模式里 —— 子代理与 Bash
都能绕过"只读"的承诺，记忆的 `save` 会写用户目录。

宽 `tool.describe` 注册在**最前**（同插件内先注册者在最外层）：

- 不在计划模式：只有 `ExitPlanMode` 隐身（没入口时它没有意义）；
- 在计划模式：`EnterPlanMode` 隐身（已经进来了），白名单之外的都隐身。

### 4.4 准入

`tool.check` 在计划模式里只放行 `PLAN_ALLOWED`，其余返回：

```
deny · 计划模式只读：<工具名> 不在可用工具里（先 ExitPlanMode 并取得批准）
```

不在计划模式时直接 `next(e)`，不影响既有链。
`src/builtins/confirm.ts` 的 `PASS_THROUGH_TOOLS` 增加了两个模式工具 —— 否则 confirm
会把它们当成未知工具拒掉。

### 4.5 提示

```
计划模式（只读）：
- 你现在只能探索：Read / Glob / Grep / Skill。Write / Edit / Bash / Task 等不在工具清单里。
- 先读现状再下结论，不要猜文件内容；不要尝试改文件。
- 完成探索后调用 ExitPlanMode，把完整计划放进 plan 参数：目标、涉及文件、步骤、验证方式、风险。
- 计划文件：<path>
```

第 5、10、15… 轮末尾多一行提醒。轮数语义：`turns` 是**当前是第几轮**（从 1 开始）。
REPL 在 `runTurn` 之前拼系统提示，而 `turn.start`（计数）在 `runTurn` 里面，
所以 `PlanMode.prompt()` 用 `turns + 1` 补上当前轮 —— 不补的话第 5 轮的提醒会拖到第 6 轮。

**进入当轮的系统提示不会变**：`ctx.systemPrompt` 在 `runTurn` 前就固定了，同一条 turn
内的后续跳沿用同一份。下一轮起才看得到这一节。工具清单则有同样的一轮延迟（见 §7 偏差 5），
当轮由 `tool.check` 兜底。

### 4.6 退出

```
ExitPlanMode(plan)
  ├─ 不在计划模式      → ERROR
  ├─ plan 去空白为空    → ERROR（不写盘、不问人）
  ├─ mkdir + write 失败 → ERROR（不问人、不退出）
  ├─ ask("批准计划并开始执行？", y/n, fallback n)
  │    ├─ y / yes      → leave() + notice("恢复读写权限") + 成功
  │    └─ 其它          → 留在计划模式；计划文件已保存
```

写盘发生在**批准之前**：用户看到的是一个已经落盘的计划，不是一段还会变的草稿。

### 4.7 手动入口

`/plan` 进入或显示状态；`/plan off`（也认 `exit` / `stop`）直接退出且**不执行**计划。
其它参数打用法。`command.describe` 让 `/help` 能列出它。

### 4.8 `FsNoun.mkdir`

计划目录可能不存在，`$.fs.write` 只保证写文件不保证建目录。
契约新增：

```ts
mkdir(path: string): Promise<void>;   // 递归创建
```

`src/core/nouns/fs.ts` 用 `node:fs/promises` 的 `mkdir(..., { recursive: true })` 实现。
三个只实现了一部分 `FsNoun` 的测试/benchmark 夹具同步补了 `mkdir`。

---

## 5. 失败方向

| 失败 | 行为 |
| --- | --- |
| 计划为空 | `ERROR`，不写盘、不问人，仍在计划模式 |
| 写计划文件失败（权限/磁盘） | `ERROR`，**不询问、不退出** —— 计划留不了档就不执行 |
| `ui.ask` 读不到答案（非交互 / EOF / Ctrl-C） | 按 `fallback: 'n'` 处理，留在计划模式 |
| 模型点名调用被藏起来的工具 | `tool.check` `deny`，错误文本点明"先 ExitPlanMode 并取得批准" |
| 模型调用 `ExitPlanMode` 但不在计划模式 | `ERROR`，不产生副作用 |
| `/plan` 带未知参数 | 打用法，状态不变 |
| 计划目录建不出来 | 与"写失败"同一条路径：`ERROR`，不退出 |

---

## 6. 可观测性与 Benchmark

### 6.1 `/tools`

计划模式没开时，`ExitPlanMode` 被隐藏，所以 `/tools` 第一次出现「不进模型可见清单的」那一段：

```
不进模型可见清单的（1 个）：
  ExitPlanMode　被权限规则隐藏
```

模型可见工具从 9 个变成 10 个（多了 `EnterPlanMode`）。`test/cli.test.ts` 把这个数写死 ——
它本来就是个该被人看见的数。

### 6.2 `pnpm bench:loop`

三张表，不调用模型、不需要 key：

1. **Tool-Use Loop**：脚本 provider + 真 `runTurn`，N 次工具应得 N+1 次请求；
2. **计划模式的工具面**：普通 vs 计划模式的可见工具与 schema token；
3. **计划模式的净账**：按 1/5/10/20 轮，把计划提示的 token 与省掉的工具 schema 相抵。

口径（也印在输出末尾）：

- token 用 `ceil(chars/4)`，中英混排会失真；同一把尺子，**比值有意义，绝对值没有**；
- 只算工具 schema + 计划提示，不含对话历史、工具结果与缓存；
- 工具 schema 的 token 用 `toolSpecChars` 估算，不等于适配器真正发出的字节数；
- 计划模式隐藏哪些工具是当前白名单，不是"所有未来的只读工具都会自动放行"。

---

## 7. 偏差与代价（如实写）

1. **没有 Shift+Tab。** 手动入口是 `/plan`；REPL 的按键层没有模式切换通道。
2. **计划文件在 `.deepcode/plans/`，不是 `.claude/plans/`。** 见 §2.7。
3. **计划模式状态不持久化。** 进程退出即丢失，已保存的计划文件留在盘上；
   `--resume` 不会回到计划模式。
4. **计划模式不传给子代理。** `Task` 在计划模式里被藏掉，所以也调不出子代理；
   即使调得出，子代理拿到的也只有静态提示，不知道有"计划模式"这回事。
5. **工具清单与系统提示有一轮延迟。** 两者都在 `runTurn` 前/开头固定：
   进入计划模式的**当轮**模型仍看得到写工具、也看不到只读说明；下一轮起才收窄。
   当轮的安全由 `tool.check` 保证，代价是模型可能白撞一次 `deny`。
6. **提醒按轮数，不按墙钟或工具调用数。** 一轮里读 20 个文件也只算一轮。
7. **计划模式只认工具名白名单。** 新加的只读工具要手动放进 `PLAN_ALLOWED`，
   否则会被误藏。方向是 fail-closed（安全但不便），不是"自动识别只读"。
8. **批准是一次性的。** 没有"批准其中三步"、没有计划 diff、没有批准后自动执行；
   模型拿到成功结果后按计划继续做，是否照做仍靠提示与用户监督。
9. **拒绝也保存文件。** 被拒的是执行，不是计划本身；同一会话再次 `ExitPlanMode`
   会写一个新时间戳的文件，不会覆盖上一版 —— 代价是旧计划不会自动清理。
10. **benchmark 不测计划质量。** 它量的是请求数与 token 面，不是"计划写得好不好"；
    后者需要人评或模型评审，这一阶段不做。
11. **token 估算是 `chars/4`。** 中文实际密度更高；净账是成本模型，不是账单。
12. **没有计划模式的快捷键与状态栏。** 界面上唯一的提示是 `notice` 与 `/plan` 的文本。

---

## 8. 验收

### 8.1 出口标准

1. **循环不插入额外请求**：N 次工具 = N+1 次模型请求，`extraRequests === 0`。
2. **计划模式立即收窄工具面**：进入后可见工具只剩 `Read` / `Glob` / `Grep` / `Skill` / `ExitPlanMode`。
3. **藏起来也调不动**：直接 dispatch `Write` 的 `tool.check` 得到 `deny`，`Read` 得到 `allow`。
4. **空计划不落盘、不问人**：`ERROR`，仍在计划模式。
5. **批准才恢复**：`y` 后写文件、退出、`Write` 重新可见；`n` 后留在计划模式、文件仍在。
6. **提醒节奏**：第 5 轮出现「提醒：」，第 4 轮没有。
7. **静态前缀不受影响**：计划模式只加 `prompt.section`，P13 的静态段断言不变。
8. **手动入口**：`/plan` 进入、`/plan off` 退出且不执行计划。

### 8.2 实测（`pnpm bench:loop`，2026-10-26）

**Tool-Use Loop**

| 工具调用 | 模型请求 | 工具执行 | 框架额外请求 |
| ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 0 |
| 1 | 2 | 1 | 0 |
| 3 | 4 | 3 | 0 |
| 5 | 6 | 5 | 0 |
| 10 | 11 | 10 | 0 |

**计划模式的工具面**

| 阶段 | 可见工具 | 工具 schema token |
| --- | ---: | ---: |
| 普通模式 | 7（EnterPlanMode / Read / Write / Edit / Bash / Glob / Grep） | 422 |
| 计划模式 | 4（ExitPlanMode / Read / Glob / Grep） | 234 |
| 被藏起来 | 4（EnterPlanMode / Write / Edit / Bash） | — |

计划提示：224 字符 / 56 token（第 1 轮）。

**计划模式的净账**（工具 schema + 系统提示，不含对话历史）

| 计划轮次 | 普通模式 | 计划模式 | 计划提示 | 工具 schema 节省 | 净变化（负 = 更省） |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 422 | 290 | 56 | 188 | -132 |
| 5 | 2,110 | 1,461 | 291 | 940 | -649 |
| 10 | 4,220 | 2,922 | 582 | 1,880 | -1,298 |
| 20 | 8,440 | 5,844 | 1,164 | 3,760 | -2,596 |

结论只有一条：**计划模式在模型面是省钱的**，而且计划轮次越多越省 ——
省掉的工具 schema 远大于注入的计划提示。这不代表计划模式"更快"：
它多出来的是**探索轮**，那些轮本来就该花，只是以前花在错误的顺序上。

---

## 9. 任务分解

| 任务 | 落点 |
| --- | --- |
| 计划模式状态与插件 | `src/builtins/plan.ts` |
| 工具名白名单 | 同上（`PLAN_ALLOWED`） |
| 计划目录创建 | `src/contract/engine.ts`（`FsNoun.mkdir`）、`src/core/nouns/fs.ts` |
| confirm 放行模式工具 | `src/builtins/confirm.ts` |
| CLI 装配 | `src/cli/plugins.ts` |
| Benchmark | `scripts/benchmark-agent-loop.ts`、`test/agent-loop-benchmark.test.ts` |
| 测试 | `test/plan-mode.test.ts`、`test/cli.test.ts` 增补、`FsNoun` 夹具增补 |
| 文档 | README、CHANGELOG、官网阶段表、`site/已知限制.md` |

---

## 10. 后续（不在这阶段做）

- 解析每个 hop 的工具清单（现在一轮一份），让进入计划模式的当轮就收窄；
- 计划持久化：把 `active` / `planPath` / `turns` 写进会话，`--resume` 回到计划模式；
- 计划 diff 与部分批准（"这三步可以，第四步再想想"）；
- 按任务复杂度自动建议进入计划模式（需要先有真实使用数据）；
- 子代理的只读模式（现在靠"藏掉 Task"实现，粒度太粗）；
- 计划质量评估：把"计划有没有覆盖验证步骤"做成可测的检查项。
