# DeepCode P1 —— 会话与体验 设计

> 前置：`2026-10-11-deepcode-mvp-design.md`（MVP，已完成并推送）。P1 是那份设计 §9.2 矩阵的第二列。
> 工作方式沿用 MVP：一次设计、一份计划、按检查点批量验收。

**目标**：MVP 能用但留不住 —— 退出即失忆，只有一个后端，改动完看不见自己改了什么。
P1 把这三件事补上，并顺手还掉 §10 挂账的两条已知缺陷。

**出口标准**（照抄 MVP 设计 §9.3，一字不改）：

1. 重启后 `deepcode --resume` 能接着上次会话。
2. TUI 下 `/diff` 能看到本会话的改动。
3. OpenAI 兼容 provider 用配置切换可用。

**三条已拍板的决定**（本轮开始前问过，不再重开）：

| 决定 | 选择 | 理由 |
|---|---|---|
| UI 层 | **零依赖手写 ANSI** | 保持零运行时依赖。Ink 会把依赖从 0 拉到几十个包，而本轮只需要转圈、着色、加粗三件事 |
| 范围 | 出口标准 + §10 两条缺陷 | 一个能干净断言"P1 完成"的最小自洽集 |
| 落盘位置 | **用户级 `~/.deepcode/projects/<slug>/`** | 转录里有代码内容；落进项目目录就有被提交进别人仓库的风险 |

---

## 1. 本轮范围

| # | 交付 | 对应的出口标准 / 缺陷 |
|---|---|---|
| 1 | 会话落盘（JSONL，用户级）+ `--resume` | 出口标准 1 |
| 2 | OpenAI 兼容 provider（配置切换） | 出口标准 3 |
| 3 | `/diff` + 本会话改动记录 | 出口标准 2 |
| 4 | 表现原语：ANSI 调色板、单行 spinner | 出口标准 2 的前置（`/diff` 要着色） |
| 5 | 同一轮多个工具结果合并成一条消息 | §10 缺陷 1 |
| 6 | 模型 id 形状校验 + API 404 翻成人话 | §10 缺陷 2 |
| 7 | 座位顺序显式化（同 tier 内按插件分组） | §9.2 矩阵"引擎内核"列 |
| 8 | `ui.*` 八个事件的参数/结果类型 | §9.2 矩阵"contract"列 |

**不在本轮**（矩阵里属于 P1 但本轮不做，理由各自成立）：

- **TodoWrite / WebFetch / WebSearch**：不在三条出口标准里。WebSearch 还要第三方搜索 API key，现在没有 —— 做了就是死代码。
- **指令文件补齐到四层**：MVP 已经读 `<root>/AGENTS.md`、`<root>/CLAUDE.md`、`~/.deepcode/AGENTS.md` 三层，剩下的那一层没有真实需求。
- **渲染走 `ui.render` 事件**：MVP 设计 §10 偏差 1 已排到 P3，本轮只补类型不补实现（见 §7）。

---

## 2. 会话落盘与 `--resume`

### 2.1 存哪儿

```
<home>/.deepcode/projects/<slug>/sessions/<session-id>.jsonl
```

- `<home>` = `process.env.USERPROFILE ?? HOME ?? cwd`（与配置文件的 home 同一个来源，不引入第二个概念）。
- `<slug>` = cwd 里每个非字母数字字符替换成一个 `-`。`F:\ts\DeepCode` → `F--ts-DeepCode`。
  **slug 只是分桶，不是身份**：`F:/ts/DeepCode` 与 `F:\ts\DeepCode` 会撞进同一个桶，
  所以每条转录里都记着真实的 `cwd`，`--resume` 拿它做最终比对（见 2.4）。
- `<session-id>` = `20261011-034855-a1b2`：本地时间（`getFullYear()` 那一套，**不是** `toISOString()` ——
  后者是 UTC，用户按本地时间找会话会差 8 小时）+ 2 字节随机十六进制。
  文件名按字典序排就是时间序，`ls` 出来天然是从旧到新。

### 2.2 什么格式

JSONL，一行一条记录。选它而不是"整个数组一次性写"：追加是 O(1)，崩在写一半只坏最后一行，
而且人可以直接 `grep`。

```jsonl
{"type":"session","v":1,"id":"20261011-034855-a1b2","cwd":"F:\\ts\\DeepCode","startedAt":1760000000000,"model":"deepseek-v4-flash","provider":"anthropic"}
{"type":"message","message":{"role":"user","content":"跑一下测试"}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}
```

- 头部只在**创建**时写一次。`--resume` 之后是往同一个文件追加，不再写第二个头部。
- 读取时逐行 `JSON.parse`，**坏行跳过**（最后一行可能被截断）；第一行是 `session` 记录则作为头部。
- 文件以 `mode: 0o600` 创建。Windows 上 mode 基本被忽略，但在 POSIX 上这是免费的。

### 2.3 什么时候写

**每个 turn 结束之后**，把 `messages` 里新增的那几条追加下去。

不做"每条消息即时落盘"：loop 就地往 `messages` 里追加，要即时落盘就得让内核知道磁盘存在，
而内核不该知道。代价是进程死在 turn 中间会丢这一整个 turn —— 接受。

落盘由 `src/cli/transcript.ts` 的 `createPersister(transcript, alreadySaved)` 负责，
它自己记着"上次写到第几条"，调用方每次把整个 `messages` 递进来即可。

### 2.4 怎么找回来

`parseArgs` 认两个形态（**没有 `-r`**：`-v` 的教训 —— 别去抢那些在别处有含义的短开关）：

| argv | 语义 |
|---|---|
| `--resume` | 接上**当前目录**最近一次会话 |
| `--resume=<id>` | 接上指定 id |
| `--resume=`（空 id） | 当作 `--resume` |

两个形态都**从提示词里摘掉**：`deepcode --resume "继续修测试"` 里那句话是提示词，不是 id。
不用"`--resume` 后面跟一个裸 token"的写法 —— 那和"后面跟一句提示词"在语法上分不开。

选最近一次的规则：

1. `sessions/` 下的 `*.jsonl`，按文件名倒序（= 时间倒序）。
2. 跳过**只有头部、一条消息都没有**的会话（启动又立刻退出留下的空壳，接上它没意义）。
3. 取第一个 `header.cwd` 与当前 cwd 相同的。比对照搬原字符串，不做大小写折叠 ——
   Windows 路径大小写不敏感，但把 `F:\TS\DeepCode` 当成 `F:\ts\DeepCode` 接上，比找不到更让人困惑。

找不到时：`--resume=<id>` 报错并**列出这个目录下有哪些 id**；`--resume` 报"这个目录还没有可接上的会话"。
两者都以退出码 1 收场 —— 用户明确要求了恢复，没能恢复就不是成功。

### 2.5 落盘失败不能拖垮产品

`~/.deepcode` 只读、磁盘满、路径被占，这些都和"能不能干活"无关。创建转录失败时
**打一行 warn，然后不带落盘继续跑**，而不是启动失败。这是本轮唯一一处刻意容忍的降级。

### 2.6 隐私

转录里是**代码与文件内容**。README 要写明它落在哪、怎么删。
不做加密、不做过期清理 —— 没有真实需求，而且在有真实需求之前加一层密钥管理只会更难删干净。

---

## 3. OpenAI 兼容 provider

### 3.1 怎么切换

配置里多一个字段，默认 `anthropic`：

```json
{ "provider": "openai", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }
```

- 环境变量：`DEEPCODE_PROVIDER`（与其余变量同一套优先级：环境变量 > 项目级 > 用户级）。
- 取值只有 `anthropic` / `openai`。**写别的直接抛**，并说出这两个合法值 ——
  静默退回 `anthropic` 会让用户拿着 openai 的端点去发 anthropic 的请求，然后收到一个看不懂的 404。
- `baseUrl` 的**默认值随 provider 走**：`anthropic` → `https://api.anthropic.com`，
  `openai` → `https://api.openai.com/v1`。默认值放在各自的 provider 模块里，不放在 config。

### 3.2 OpenAI 侧的路径约定

`POST ${baseUrl}/chat/completions`，**`baseUrl` 里要自带版本段**（`https://api.deepseek.com/v1`）。
不做"看到没 `/v1` 就替你补上"的魔法：那只能靠猜，而猜错的症状是 404。
这条约定写在 README 里，与 OpenAI 官方文档 `base_url="https://api.openai.com/v1"` 一致。

### 3.3 消息转换：中立表示与两种协议

这是本轮唯一需要"翻译三次"的地方。中立 `Message` 里工具结果**合并成一组**（见 §5），
而两种协议要的形状不一样：

| 中立 | Anthropic | OpenAI |
|---|---|---|
| `{role:'tool', results:[r1,r2]}` | **一条** user 消息，`content` 里两个 `tool_result` block | **两条** `{role:'tool', tool_call_id}` 消息 |
| assistant 的 `tool_use` block | `tool_use` block | `tool_calls[{id,type:'function',function:{name,arguments:JSON字符串}}]` |
| system | 顶层 `system` 字段 | messages 里第一条 `{role:'system'}` |

**注意 OpenAI 那一格是两条**：它的协议要求一个 `tool_call_id` 一条消息，
所以"合并"只发生在我们自己的中立层，落地时该拆还得拆。把这条写在中立类型的注释里，
免得后来者以为合并是为了省 token。

assistant 消息只有工具调用、没有文本时，OpenAI 侧 `content` 发 `null`（不能发空字符串：
部分端点会当成"空回复"报错）。

### 3.4 流式解析

OpenAI 的 SSE 帧是 `data: {...}`，**没有 `event:` 行**，以 `data: [DONE]` 收尾。
现有的 `sseFrames`（在 `providers/anthropic.ts` 里）要求帧带事件名，所以把它提到
`providers/sse.ts` 共用：产出的 `event` 允许是空串，Anthropic 侧照旧只认有名字的帧
（行为不变 —— 之前那些帧本来也被丢掉）。

逐帧处理：

- `choices[0].delta.content` 是字符串 → `{type:'text'}`。
- `choices[0].delta.tool_calls[]` → 按 `index` 累积 `{id, name, arguments}` 三段。
  `arguments` 是**分片拼出来的 JSON 字符串**，收齐后 `JSON.parse`；解析失败退化成 `{}`
  —— 工具会因为缺少参数报错，那比整个 turn 崩掉有用。
- `choices[0].finish_reason` → `stop`/`length`/`tool_calls` 映射成 `end_turn`/`max_tokens`/`tool_use`。
- `data: [DONE]` → 结束。**但不能只靠它**：有的端点不发，循环自然结束也要照常收尾。
- `{"error":{...}}` 帧 → **抛**。理由与 Anthropic 侧一字不差（见 `anthropic.ts` 里那段注释）：
  咽下去就等于把一次 overloaded 变成"成功的空 turn"，用户的话凭空消失。
- 非 2xx → 抛，带状态码与响应体。

工具调用统一在**流末尾**产出（与 Anthropic 侧在 `content_block_stop` 产出的时机对齐），
按 `index` 排序。

---

## 4. `/diff`

### 4.1 记什么

一个 `SessionChanges`：**路径 → (before, after)** 内容快照，同一路径多次改动**合并**
（保留第一次的 before 和最后一次的 after），这样 `/diff` 看到的是"这一整场会话对这个文件的净改动"。

记录者是挂在 `tool.call` 上的 **外层** hook（`Write` / `Edit` 各一条）：

```
before = 读文件（读之前先 stat，超过 512KB 记 'too-big'）
result = next(e)          ← 让真正的工具去写
after  = 再读一次
若 result 不是 ERROR: 开头 → 记录下来
```

几个刻意的点：

- **hook 放在外层**（调用 `next` 之前先读、之后再审），而不是去改 `Write`/`Edit` 工具。
  工具不需要知道有"会话改动"这回事；P3 的工具换一批，这里一行不用动。
- **只记成功**。失败（`ERROR:` 开头，含"覆盖前必须先 Read"那道拦截）不留痕迹，
  否则 `/diff` 会显示一堆没发生过的改动。
- **超过 512KB 不记内容**，只记路径与 `too-big` 标记，`/diff` 打一行"文件太大，未记录内容"。
  没有路径围栏（MVP 设计 §5），模型完全可能写到一个几百 MB 的文件上；把两边都读进内存是
  一件能把进程干掉的事。
- 路径按 `resolve()` 归一后作 key，`./a.ts` 与 `a.ts` 合并成一条。

### 4.2 怎么算

`src/cli/diff.ts` 是一个**纯模块**（行数组进，hunk 出，不碰磁盘、不碰终端）：

1. 砍掉公共前后缀（改一个文件通常只动了中间几行，砍完 DP 的规模小一个量级）。
2. 中段做 LCS DP。**规模设上限**：`n*m > 1_000_000` 就不做 DP，整段按"全删 + 全加"输出。
   这是老实的降级 —— 结果仍然正确，只是不好看，而不好看远好过卡死。
3. 用 Int32Array 存 DP 表（`noUncheckedIndexedAccess` 下用一个小访问器函数取值，
   别到处 `!`）。
4. 回溯出 `context / del / add` 序列，再按 3 行上下文切成 hunk；两段改动之间间隔
   ≤ 6 行就并进同一个 hunk（与 `git diff` 同口径）。

`formatUnified(path, hunks, palette)` 输出：

```
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,6 @@
   const a = 1;
-  return new Date(input);
+  const normalized = input.replace(' ', 'T');
+  return new Date(normalized + '+08:00');
```

- 新文件：`--- /dev/null`，`oldStart = 0`。
- 路径落在会话根目录里就用相对路径（`relative(root, path)`），出不去就用绝对路径。
- 着色：hunk 头青色，`+` 绿，`-` 红，文件头加粗。没改动过文件时 `/diff` 说
  "本会话还没有改动过文件。"，不是打一片空白。

### 4.3 `/diff` 住在哪一层

**放在 `src/cli/`，不放 `src/builtins/`。** 依赖边界规则（MVP 设计 §2.1）规定
`builtins` 只能 import `contract`，而 `/diff` 要着色、要知道会话根目录 —— 那是表现层的东西。
把它塞进 `builtins` 就得放宽那条规则，为一条命令放宽全局规则不划算。

所以 `builtins/commands.ts` 继续管不需要外设的命令（`/exit`、`/help`），
新增的 `src/cli/commands.ts` 管要碰渲染与会话状态的命令（`/diff`、`/clear`）。
`/help` 的命令列表来自注册面（`$.command.list()`），所以分两个文件注册不影响它列全。

### 4.4 `/clear`

清空**上下文**（`messages.length = 0`），不动磁盘上的转录，也不动 `SessionChanges` ——
用户清的是"要发给模型的历史"，不是"我改过什么"。

实现方式：CLI 命令插件持有 REPL 正在用的那个 `messages` 数组（同一个对象引用），
命令里就地清空。不新增事件，不新增名词。

---

## 5. 合并同一轮的多个工具结果

`Message` 的 tool 形态从"一条一个结果"改成"一条带一组结果"：

```ts
export type ToolResult = {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
};

| { readonly role: 'tool'; readonly results: readonly ToolResult[] }
```

loop 里所有工具跑完之后推**一条** tool 消息。工具仍然**串行**执行（并行 Bash 的输出交错
对用户没有任何好处，而并行带来的不确定性是白送的）。

改动面已经确认过，只有三处：`src/core/loop.ts` 构造它、`src/providers/anthropic.ts` 读它、
`test/e2e.test.ts` 断言它。

---

## 6. 模型 id：能查的查，查不了的翻译

§10 缺陷 2 的原话是"模型 id 写错时错误来自 API 的 404，不是启动期就报"。拆成两半办：

**启动期能查的只有形状**：非空、不含空白字符（`claude sonnet` 这种手滑）。
在 `resolveSettings` 里查，它是环境变量与配置合流之后的唯一出口。

**存在性只能等 API 回话**，所以把 API 那句话翻译成人话：两个 provider 在非 2xx 时
统一走 `providers/http.ts` 的 `describeHttpFailure(label, response, model)`，
当状态码是 404 **或**响应体里出现 `model_not_found` / `invalid model` / `does not exist` 之类时，
在错误信息后面补一句"（模型 id "X" 在这个端点看来不存在，检查配置里的 model 项）"。

**不假装能查存在性**。没有一张权威的模型清单可查 —— 换个兼容端点就都不一样，
硬编一张表只会让合法模型被自己的校验拦住。

---

## 7. 两类契约改动

### 7.1 座位顺序显式化

现状：`Registry.hooksFor` 按 `(tierIndex, seq)` 排，`seq` 是**全局注册序号**。
因为 `createEngine` 是一个插件接一个插件地注册，全局序号恰好等于"先按插件、再按注册顺序"，
所以现在是对的 —— 但这是**碰巧**：一个插件只要在运行期懒注册一个 hook（比如第一次
调用工具时再挂），它的 hook 就会插到别的插件后面去。

改成显式记录：注册时给插件分配一个 `pluginOrder`（首次出现时分配），排序键变成
`(tierIndex, pluginOrder, seq)`。这样 MVP 设计 §10 存疑表里那条
"同事件、同 tier 的多个 hook 之间的精确排序"就有了答案：**同 tier 内按插件装载顺序分组，
同插件内先注册者最外层**。

### 7.2 `ui.*` 八个事件的类型

`ui.render` / `ui.press` / `ui.input` / `ui.select` / `ui.message` / `ui.scroll` / `ui.focus` / `ui.resolve`
从 `Record<string, unknown>` 换成真实类型。

**它们仍然不实现** —— 落到它们照样抛 `NotImplementedError`。本轮只钉形状，
而且这些形状是**暂定**的：P3 真正接上 `ui.render` 时该改就改，不要为了"不改契约"而将就
一个想当然的数据树。这一点写进类型的注释里。

`RenderNode`（纯数据渲染树）的定义同样放在 contract 里：

```ts
export type RenderNode = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly RenderNode[];
};
```

---

## 8. 表现原语（`src/cli/ansi.ts`、`src/cli/spinner.ts`）

### 8.1 调色板

```ts
export function colorEnabled(stream, env): boolean
export function createPalette(enabled?: boolean): Palette
```

判定顺序：`NO_COLOR` 非空 → 关；`FORCE_COLOR` 非 `0` → 开；`TERM=dumb` → 关；
否则看 `stream.isTTY`。

**关掉时输出必须与现在逐字节相同** —— 现有测试断言的是纯文本，它们得继续绿。
这不只是"为了过测试"：管道、CI、重定向到文件时输出带转义序列是明确有害的。

### 8.2 spinner

一个只在 `stderr` 上转的单行 spinner（braille 帧，90ms 一帧）。

- 只在 `stream.isTTY` 且 `TERM !== 'dumb'` 时启用。测试环境 stdout 不是 TTY，所以它天然是空操作。
- **由渲染器持有**：`render.thinking()` 开转，`delta` / `print` / `notice` / `newline` 任何一次
  输出都先把它停掉 —— 半行 spinner 和模型的第一段文本叠在一起是最典型的 TUI 事故。
- 确认提示落笔前也要停（`prompt.ask` 之前）。
- 进程退出时也停（`process.on('exit')`），否则会把光标停在隐藏状态上。

---

## 9. 验证策略

**与 MVP 同一口径**（MVP 设计 §6.1）：任务级只要求 `pnpm typecheck` 通过，
测试按检查点批量做，不逐任务写 TDD 步骤。

| 检查点 | 内容 | 判据 |
|---|---|---|
| **C1 · 契约与内核** | 座位分组、合并工具结果、`ui.*` 类型、两个 provider 的协议转换与 SSE 解析 | `pnpm typecheck` 与 `pnpm lint` 绿；`dispatch` / `e2e` / `provider` 三个文件全绿 |
| **C2 · 会话与 CLI** | 转录读写与 `--resume` 查找、diff 算法与着色、调色板与 spinner 的开关、配置新增字段 | 上述之外加上新的 `diff` / `transcript` / `openai` 三个文件，全量 `pnpm test` 绿 |
| **C3 · 手动端到端** | 用户在一个真 TTY 里跑三条出口标准 | 见下 |

C3 的手动脚本（**用户在真终端里跑，我跑不了**）：

```bash
cd /某个有 git 的仓库
deepcode "给 README 加一行用法说明，然后跑一下测试"     # 看 /diff 里能看见这次改动
/diff                                                   # 出口标准 2
/exit
deepcode --resume                                       # 出口标准 1：接着上次聊
```

出口标准 3 用一次配置切换验证：把 `~/.deepcode/config.json` 里加 `"provider": "openai"` 与
对应的 `baseUrl`，确认换后端之后照常跑通一轮。

**反向验证**：里程碑结束时把每个新特性最核心的那一处实现临时改坏，确认对应的测试真的会红。
MVP 阶段这条纪律抓到过一个空转的验收夹具，继续保留。

---

## 10. 明确不做（本轮）

- WebSearch（要第三方搜索 key）、TodoWrite、WebFetch
- Ink / React / 任何运行时依赖
- `ui.render` 的真正实现
- 转录加密、转录清理、跨机器同步
- 任何形式的自动放行开关（MVP 设计 §6.3 的决定继续有效）
- 会话内上下文压缩（矩阵把它排在 P4）
