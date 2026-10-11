# DeepCode —— P4b 上下文与执行边界设计（沙箱 / 压缩 / 嵌套指令）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 分组依据是 [`2026-10-11-deepcode-p4a-design.md`](2026-10-11-deepcode-p4a-design.md) §17，
> 同体例的先例是 [`2026-10-11-deepcode-p4a-design.md`](2026-10-11-deepcode-p4a-design.md)。

**一句话**：给 `Bash` 装一道**任何权限规则都绕不过去**的路径闸，给会话装一个**宁可涨也不静默丢**的压缩，
再让 `AGENTS.md` 能按目录**惰性**地跟着模型读文件走 —— 三样都改的是既有实现的内部，一个新扩展点都不加。

---

## 0. 决策摘要

1. **沙箱是策略层的命令分析，不是 OS 隔离**。参考实现的沙箱靠 bubblewrap/sandbox-exec，**Windows 上没有对应的东西**，
   而本项目开发的机器就是 Windows —— 做真隔离等于写一段在本机永远跑不到、也永远测不了的代码。
   改做：spawn 之前把命令串拆开，取出候选路径，按规则判。跨平台、可测、能用反向验证钉住。
2. **沙箱的落点是 `process.run` 的内部**，位于整条权限链**下游**。
   于是"个人规则掀不翻托管策略"从 P4a 的**政策**层面升级成**结构**层面：
   任何 `allow` 规则都不可能绕过它，因为链已经走完了才轮到它 —— 不靠自觉，靠位置。
3. **沙箱规则的方向性写死**：拒（`deny`）各层取并集，个人配置能收紧自己；
   白名单（`allow`）**只有托管层能设**，其余来源设了会被忽略并出声。
4. **不做 `dangerouslyDisableSandbox`**。参考实现有这个逃生阀键，但它就是一个"放行开关" ——
   与"谁加自动放行开关谁就是在开倒车"正面冲突。**这一条要写进 README 的已知限制。**
5. **先把 token 数据接上，再谈压缩**。今天 `turn.complete` 的 `inputTokens`/`outputTokens` 是硬编码 `0` ——
   那是在撒谎。两个适配器的响应里本来就有 usage，解析出来即可；拿不到时回落到**字符数 ÷ 4 的估计并显式标记**。
6. **压缩策略 = 摘要替换 + 保留最近 N 轮原文**，`/compact` 手动始终可用，**自动压缩默认关**。
   理由：参考笔记对上下文窗口的原话是"完全不可见"，我们**不知道**模型的真实窗口 ——
   拿一个猜出来的阈值，在用户干活干到一半时静默丢细节，是这一轮最不该发生的事。
7. **压缩失败的方向与 fail-closed 相反，这是有意的**：摘要是**变换缝**（与 P4a 的 `skill.prompt` 同类），
   不是闸。摘要失败时**不压缩**、出声、原文一份不动 —— 宁可上下文继续涨，也不静默丢。
   **这条要写进文档，否则将来一定有人把它"统一"成 fail-closed。**
8. **嵌套的 `AGENTS.md` 挂在 `Read` 上**，与参考实现同形（它用 `$.fs.ancestors` 回溯，就是在读文件那一刻）。
   跨层去重靠"回溯从 root **下面**开始"（root 与用户层那两份已经进了 system prompt），
   同层去重靠"一个文件一次会话只附一次"。
9. **一个事件转正，零个新增**：`session.compact` 从 `UnimplementedEvent` 移进 `EventArgs`。
   39 这个总数不变，**实现数 15 → 16，未实现 24 → 23**（§5）。

---

## 1. 出口标准怎么落

MVP §9.2 的 P4 列里，本轮吃掉三格。逐格落点：

| 出口标准（P4 列，MVP §9.2:403/404/408） | 落点 | 怎么验 |
| --- | --- | --- |
| 沙箱（**仅 Bash**） | `src/core/nouns/sandbox.ts`（纯判定）+ `process.ts`（落点）+ `settings.ts`（规则来源） | 一组命令 fixture 逐条断言；**再加一条副作用验证** —— 真起一条本该写文件的命令，断言文件根本没被创建（§8 C1-4） |
| 上下文压缩 | `src/cli/compact.ts` + `events.ts`（`session.compact` 转正）+ 两个适配器的 usage | 压缩后 `messages` 的形状、摘要失败不压缩、**持久化游标不错位**（§8 C2） |
| `AGENTS.md` 惰性嵌套 + 双层去重 | `src/cli/agents-md.ts`（第一方插件，挂 `Read`） | 读文件时附上中间层、第二次读不重附、跨层不重附、root 之外不触发（§8 C3） |

**验收方式沿用 P2/P3/P4a 的体例**：任务级只跑 `pnpm typecheck`，测试按 C1/C2/C3 三个检查点批量跑。

---

## 2. 沙箱：策略层命令分析

### 2.1 落点与权威（这一节是本设计最要紧的地方）

`process` 名词今天长这样（`src/contract/engine.ts:18-23`）：

```ts
export type ProcessNoun = {
  run(
    command: string,
    opts: { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
};
```

**判定的位置在 `run` 内部、`spawn` 之前**。这不是随便找个地方塞 —— 它决定了权威关系：

```
模型 → tool.check（权限链，五层规则，可被 allow 放宽）
        ↓ 放行
     tool.call → bash.ts → $.process.run
                            ↓  ← 沙箱在这里
                          spawn
```

权限链在**上游**，沙箱在**下游**。任何 `allow` 规则 —— 包括用户自己写的、包括将来的插件写的 ——
最多只能让请求**走到这儿**，走到这儿之后照样撞沙箱。**"个人规则掀不翻托管策略"于是不再靠自觉，靠位置。**

> 与 P4a 的 `agent.offer` 那个 fail-closed 底线是同一条思路的两个层次：那边是"链尾无人应答 = deny"，
> 这边是"链尾说了 allow 也不算数"。

沙箱**不是事件、不是 hook**。这是有意的：它是**闸**，不是扩展点。谁都能挂 hook 的东西做不了闸 ——
一个坐在 `prepend` 上的第三方插件随手就能把它换掉。

### 2.2 候选路径怎么取

纯函数，零 IO，住在 `src/contract/sandbox.ts`：

```ts
/** 从一条 shell 命令里取出**可能被写到的**路径候选（原样 token，**不解析、不展开 `~`**）。 */
export function candidatePaths(command: string): readonly string[];
```

**它只做切分，不做解析。** `contract/` 那一层今天**一个 `node:` 内置模块都没 import 过**，
这一层要保持这样：解析成绝对路径、展开 `~`、归一斜杠**都不在这儿**，全在下一节的 `checkSandbox` 里。

规则（全部是**保守**方向，宁可多取不可漏取）：

1. 按空白切 token，**认单双引号**（引号内的空白不切）。
2. 第一个 token 是命令名，**跳过**——但它**不是**无条件跳过：`/usr/bin/rm` 这种带路径的命令名本身就是候选。
3. 其余 token：
   - 以 `-` 开头且不含路径分隔符 → 是旗标，跳过。
   - 含 `/` 或 `\`，或以 `~` 开头 → **候选**。
   - 纯词（`-rf` 之外的 `foo`）→ **不算**。理由：`git commit -m "fix bug"` 里那些词解析成相对路径也全是假的，
     而相对路径又要按 cwd 解析 —— 假阳性会把正常命令全拒掉。
4. 重定向目标一律算：`>` / `>>` 之后的那个 token，无条件算候选（哪怕它是个纯词，如 `> out.txt`）。
5. `~` **原样留着**，展开是下一节的事。

### 2.3 规则怎么判

复用**已有的**路径匹配器，不另写一套。`src/contract/policy.ts` 里
`matchesRule(rule, call)` 已经认 `PATH_TOOLS = {Read, Write, Edit}` 且入参键是 `file_path`。
于是判定就是：把每个候选解析成绝对路径，**合成一个 `Write` 调用**喂进去。

```ts
// src/core/nouns/sandbox.ts
/** 命中返回拒绝理由；放行返回 undefined。 */
export function checkSandbox(
  command: string,
  opts: { readonly cwd: string; readonly home: string },
  config: SandboxConfig,
): string | undefined;
```

`cwd` 用来解析相对路径，`home` 用来展开 `~`。**归一化的那几步复用 `policy.ts` 的现成代码**
（`expandHome` / `slashes` / `squeeze` —— 目前是模块私有的，**这一轮要把它们导出**）：

> 不另写一套的理由很实在：权限链那边已经立了一条规矩 ——"反斜杠统一成正斜杠，免得同一个路径
> 因为写法不同而匹配不上"（`policy.ts:57-59`）。沙箱要是自己再写一遍，**两套归一迟早分叉**，
> 而分叉的那一天表现是"同一条规则在权限链认、在沙箱不认"，一种最难查的错。

**为什么合成 `Write` 而不是按动词分读写**：文本分析分不出 `cat /x` 与 `rm /x`。
既然分不出，就**一律按写算** —— 严的方向错好过松的方向错。这条要写进注释。

判定顺序：

1. `config.enabled === false` → 直接放行（沙箱没开，零开销）。
2. 取候选。**一个都没有 → 放行**（`ls`、`git status` 这类不碰路径的命令不受影响）。
3. 每个候选先过 `allow`（白名单）：`allow` **非空**且没有任何一条命中 → 拒。
4. 每个候再过 `deny`：任一条命中 → 拒。
5. 全过 → 放行。

拒绝时把**是哪条规则拒的**写进理由（与权限链的 `Verdict.rule` 同一个腔调）——
"被拒了但不说为什么"是这一整套东西里最招人恨的一种失败。

### 2.4 规则从哪来

**类型住在 `src/contract/sandbox.ts`**（`core/nouns/process.ts` 要读它，不能反过来依赖 `cli/`）。
`src/cli/settings.ts` 的 `ResolvedPolicy` 加一个字段 `readonly sandbox: SandboxConfig`：

```ts
// src/contract/sandbox.ts
export type SandboxConfig = {
  readonly enabled: boolean;
  /** 各层并集。任何来源都能往这儿加 —— 它只会让沙箱更严。 */
  readonly deny: readonly Rule[];
  /** 白名单。**只有托管层（`policy`）能设**；其余来源设了会被忽略并出声。 */
  readonly allow: readonly Rule[];
};
```

- 设置文件里写成一个 `sandbox` 块。**注意两层形状不一样**：JSON 里路径是**字符串**（因为要过 `parseRule`），
  解析后是 `Rule[]`：

  ```jsonc

  ```jsonc
  {
    "sandbox": {
      "enabled": true,
      "paths": {
        "deny": ["~/.ssh/**", "/etc/**", "<root>/.git/**"],
        "allow": ["<root>/**", "/tmp/**"]
      }
    }
  }
  ```

  JSON 是 `sandbox.paths.{deny,allow}`（字符串数组），解析结果摊平成 `SandboxConfig.{deny,allow}`（`Rule[]`）。

- 解析走 `parseRule(text, 'deny', home)`，于是 `~` 展开、反斜杠归一、`**` 语义**全都是现成的**。
- `allow` 的来源过滤与 `plugins.enable` 同一条道理，写在 `resolvePolicy` 里：
  `SETTINGS_SOURCES.filter((s) => s !== 'policy')` 那份里读到的 `allow` → 丢弃 + 一条警告。

### 2.5 拒绝的形状，与它绕得过去的地方

非 `allow` 通行时，`run` **不起进程**，直接返回 —— 复用名词**已有的**"没真跑成"形状
（abort 与超时就是这么返回的，`src/core/nouns/process.ts`）：

```ts
{ stdout: '', stderr: `[沙箱拒绝] ${reason}`, exitCode: -1 }
```

于是它在 `bash.ts` 那边**自动**变成带 `ERROR:` 前缀的工具错误给模型看 ——
而 `bash.ts:44-48` 那条注释说过，`ERROR:` 前缀是 loop 判定 `is_error` 的依据。**一行都不用改 bash.ts。**

**代价（必须写进 README，与既有的那句诚实并列）**：

> 沙箱是**文本**分析，不是 shell 解析器。`x=/etc/passwd; rm $x`、`rm $(echo /etc/passwd)`、
> `cd /etc && ...` 全都绕得过去。**它是给手滑与误操作加的一道闸，不是反对抗手段** ——
> 与"前缀匹配不懂 shell 语法"是同一种局限，同一句话。

这句话不是免责声明，是**设计要求**：正因为它是这样一道闸，所以它**不能**成为"可以放开权限"的理由。
参考实现的 `sandbox.autoAllowBashIfSandboxed` 键（沙箱开了就自动放行 Bash）**明确不做** ——
它把"我加了闸"读成了"所以不用问了"，正好把闸的意义倒过来。

---

## 3. 上下文压缩

### 3.1 先把 token 数据接上

今天的事实：`src/contract/model-provider.ts:35-54` 的 `StreamEvent` 里**没有** usage；
`src/core/loop.ts:124,157` 里 `inputTokens: 0, outputTokens: 0` 是**写死的**；
两个适配器**没有解析**响应里的 usage。也就是说 `turn.complete` 今天在报假账。

改法：

1. `StreamEvent` 的 `done` 分支加可选 usage：

   ```ts
   | { readonly type: 'done'; readonly stopReason: string;
       readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }
   ```

2. 两个适配器解析各自的字段，归一成同一对名字：
   - `src/providers/anthropic.ts`：响应体的 `usage.input_tokens` / `usage.output_tokens`
   - `src/providers/openai.ts`：响应体的 `usage.prompt_tokens` / `usage.completion_tokens`
   - 两个都**只在字段真的是有限数时**才带上；缺了就不带（不塞 `0` —— 塞 `0` 就是又一次撒谎）。
3. `loop.ts` 把它填进 `turn.complete`；拿不到时用估计值并**标出来**：
   `turn.complete` 的入参加 `usageEstimated?: boolean`。

**估计函数**（`src/core/loop.ts` 或 `src/cli/compact.ts`，纯函数）：

```ts
/** 拿不到真 usage 时的兜底。**是估计** —— 中英混排会失真，文档里要说明。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

### 3.2 触发

| 方式 | 行为 |
| --- | --- |
| `/compact` | 手动，**始终可用**（`command.run` 的一个命令，与 `/diff` `/permissions` 并列） |
| 自动 | `compact.auto: true` 时才开，**默认关** |
| 提醒 | 每轮 `turn.complete` 后比对阈值；跨过时**出声一次**（"上下文已到 X，可用 /compact 压缩"），不刷屏 |

配置（住在 `src/cli/settings.ts` —— 只有 CLI 层用它，不必上 contract）。类型与 JSON 同名同形：

```ts
export type CompactConfig = {
  readonly auto: boolean;      // 默认 false
  readonly atTokens: number;   // 默认 100_000
  readonly keepTurns: number;  // 默认 6
};
```

**只对 REPL 生效。** 一次性模式（`deepcode "..."`，`main.ts` 那条路）跑完一个 turn 就退出，
自动压缩在那儿没有意义 —— 别为了"统一"在一次性路径上也插一个调用点。

`atTokens` 的默认值是**猜的** —— 我们不知道模型的真实窗口（参考笔记：引擎内部不可见）。
计划里要把这条写进注释，并在 README 的限制里点名"这个数是猜的，按你的模型调"。

### 3.3 策略

一轮 = 一条 `role === 'user'` 消息**及其之后**的一切。`keepTurns` 从尾部数。

```
messages: [u1 a1 t1 a2 ... u9 a9 t9 a10 u10 a10]
                                          ↑ 保留最近 2 轮
          └────────── 这一整段喂去摘要 ──────┘
结果:     [ (user) "以下是更早对话的摘要：…"   u9 a9 t9 a10 u10 a10 ]
```

1. 找切点：从尾部数第 `keepTurns` 条 `role === 'user'` 的下标。
2. 切点之前那一段 → 调模型写摘要。
3. **就地**把 `messages` 改成 `[摘要那条, ...保留的那一段]`。

摘要的调用**不走 `runTurn`** —— `runTurn` 会往 `messages` 里追加，而我们要的是一次旁路调用：
直接 `provider.stream({ system, messages: [...旧段, {role:'user', content: SUMMARIZE_PROMPT}], tools: [], signal })`，
把 `text` 事件收集起来。`tools: []` 是**必须的** —— 摘要那一轮绝不能让模型去调工具。

`SUMMARIZE_PROMPT` 要求包含：用户的目标、已做的改动（文件路径）、已知的结论与未决问题、以及
**"不要复述过程"**。摘要里应当明确带上被压掉的消息条数，让模型知道自己少了一段。

### 3.4 失败方向（与 fail-closed 相反，这是有意的）

`session.compact` 是**变换缝**，与 P4a 的 `skill.prompt` 同类，**不是闸**：

- 摘要调用失败（网络、超时、模型返回空）→ **不压缩**，出声一条警告，`messages` 一份不动。
- 摘要返回了但**空**→ 同上，当作失败。
- 压缩之后的结果**不比原来短**（摘要比原文还长，短会话上会发生）→ 放弃这次压缩，出声。**这一条最容易漏。**

宁可上下文继续涨到真的报错，也不静默丢掉用户已经做过的事。

### 3.5 持久化游标那处陷阱

`src/cli/transcript.ts:97-124` 的 `createPersister` 内部有一个 `written` 游标：

```ts
let written = alreadySaved;
return async (messages) => {
  if (messages.length <= written) return;   // ← 压缩把数组改短之后，这一行会静默地什么都不做
  const batch = messages.slice(written);
  written = messages.length;
  // …
};
```

压缩**把数组改短**。于是：

- 短于旧游标的那段时间，**落盘静默停止**（不报错，什么都没写）；
- 等数组再长过旧游标，`slice(written)` 取到的是**错位的一批** —— 写到转录里的内容与真实对话对不上。

这是本设计里唯一一处**会静默损坏数据**的地方。改法：`createPersister` 返回的函数上加一个逃生口

```ts
export type Persister = {
  (messages: readonly Message[]): Promise<void>;
  /** 压缩把数组改短之后必须调 —— 否则游标错位，落盘静默写错。 */
  reseed(length: number): void;
};
```

`compact.ts` 在改完 `messages` 之后调 `persist.reseed(messages.length)`。
**计划里必须有一条专门钉这个的用例**（§8 C2-11），不能靠"记得调"。

### 3.6 `session.compact` 转正

`src/contract/events.ts`：`session.compact` 从 `UnimplementedEvent` 移进 `EventArgs`：

```ts
'session.compact': { readonly trigger: 'manual' | 'auto'; readonly tokensBefore: number };
```

**是通知事件，不是权威事件** —— 参数如上，**结果类型是空对象**（与 `session.start` 同一族），
`coreImpls` 里给 `() => ({})`。它**不返回"压缩后的 messages"**：压缩是 CLI 自己的事，
事件只是"这里发生过一次压缩"的广播。把结果做成可变的东西会让它变成一个**权威**事件，
而权威事件是要 fail-closed 的 —— 那正好与 §3.4 讲的方向冲突。
`src/contract/classic.ts:33-34` 里 `PreCompact` / `PostCompact` 两个经典 hook 名**早就占好位了** ——
接线几乎是白送的：压缩前后各派一次，桥到经典 hook。

---

## 4. `AGENTS.md` 惰性嵌套

### 4.1 触发与落点

新的第一方插件 `src/cli/agents-md.ts`，钩 `tool.call` 的 `{ tool: 'Read' }`，**在 `next(e)` 之后**追加：
先拿到 `Read` 的结果，若是 `deny`、或 `value` 以 `ERROR:` 开头，**不追加**（读都没读成，附约定没有意义）。

要附的是：从**会话 root 到这个文件所在目录之间每一层目录**里的 `AGENTS.md` / `CLAUDE.md`。
每份内容按既有腔调包一层出处：

```
以下是 <dir> 的目录约定（AGENTS.md）：

<内容>
```

**为什么挂 `Read` 而不是启动时全树预读**：全树预读会在大仓库上白烧 token，而 `AGENTS.md` 是
"读到这一层才需要"的东西 —— 这正是"惰性"二字的意思，也是与参考实现同形的做法
（`claude-code-架构分析/05-mod-agents-md.md:28,31` 记的就是在读文件那一刻回溯附带）。

### 4.2 双层去重（两层意思都落实）

| 层 | 去重怎么做 |
| --- | --- |
| 跨层 | root 与用户层那两份**已经进了 system prompt**（`main.ts:34` 的 `loadInstructions` 读死三层）。所以回溯**从 root 下面开始**，root 自己不再附 —— 否则模型每个文件都要重读一遍根约定。 |
| 同层 | 插件持有一个 `Set<string>` 记已附过的绝对路径。**一个文件一次会话只附一次。** |

### 4.3 边界

- **只对 root 之内的文件触发**。读 root 之外（`~/.ssh/…`、另一个仓库）不回溯、不附带 ——
  不跨界去拽无关的约定文件。
- 子代理共享同一个 `Read` 工具，于是**也享受嵌套**。这是想要的：子代理更需要局部约定。
- 读文件走 `$.fs`（插件 hook 的 `$` 上有），不走 `node:fs` —— 保可测性，与"六个工具都必须依赖 `$` 名词"同一条道理。
- 模型**显式读** `AGENTS.md` 本身时不特殊处理（它就在 root 下或某层目录里，走同一条路）。

---

## 5. 契约变化汇总

| 项 | 变化 |
| --- | --- |
| `EventArgs` | **15 → 16**（`session.compact` 转正） |
| `UnimplementedEvent` | **16 → 15** |
| 未实现总数（含 8 个 `ui.*`） | **24 → 23** |
| 声明总数 | **39 不变**（这是 P4a 立的口径，本轮继续守） |
| `StreamEvent` | `done` 分支加可选 `usage` |
| `turn.complete` 入参 | 加可选 `usageEstimated` |
| 工具数 | **8 不变**（本轮不加工具） |
| `ProcessNoun` | 签名不变，**行为**在 `run` 内部多一道闸 |
| 新增设置块 | `sandbox`、`compact` |
| 新增 `$` 名词 | **无** |

README / `docs/项目简介.md` / `site/index.html` 三处的 **15/24 要改成 16/23**。
上一轮的教训写在这儿：**只改一处，会被另一处的旧数字顶回去。**

---

## 6. 失败行为表

| 情况 | 行为 |
| --- | --- |
| 沙箱拒了这条命令 | 不起进程；`exitCode: -1`；stderr 带 `[沙箱拒绝] <理由>`；模型看到的是工具错误。**不是崩溃。** |
| 沙箱开着但规则一条都没有 | 放行（闸没关，但也没设圈）。`enabled: false` 同理。 |
| 非托管层设了 `sandbox.paths.allow` | 丢弃 + 警告一次。**不静默。** |
| 设置文件里 `sandbox` 块写坏 | 整块忽略 + 警告一次。**不"猜一个更严的"** —— 猜严会把用户的正常命令全拒掉，比不沙箱更糟；猜松则等于没配。读不懂就不动，与 `parseRule` 对不认识的规则的处理一致。 |
| 适配器拿不到 usage | 用估计值填 `turn.complete`，并置 `usageEstimated: true`。 |
| 摘要调用失败 / 返回空 | **不压缩**；警告一条；`messages` 不动。 |
| 压缩后反而更长 | 放弃这次压缩；警告一条；`messages` 不动。 |
| 压缩改了数组长度 | 必须 `persist.reseed(messages.length)`。**下面那一条是它的后果。** |
| 漏了 `reseed` | 落盘静默停止，随后错位写入。**§3.5 —— 这是本轮唯一的静默数据损坏点。** |
| `Read` 失败（deny / `ERROR:`） | 不追加嵌套内容。 |
| 某层目录没有 `AGENTS.md` | 正常，安静跳过。 |

---

## 7. 文件结构

**新建**

| 文件 | 职责 |
| --- | --- |
| `src/contract/sandbox.ts` | `SandboxConfig` 类型 + `candidatePaths()`（纯函数，零 IO、零依赖，contract 边界不破） |
| `src/core/nouns/sandbox.ts` | `checkSandbox()` —— 合成 `Call` 喂 `matchesRule`，给理由不给布尔 |
| `src/cli/agents-md.ts` | 嵌套 `AGENTS.md` 的第一方插件 |
| `src/cli/compact.ts` | 摘要策略、阈值判定、`reseed` 调用、`/compact` 命令的实现 |
| `test/sandbox.test.ts` | 候选提取 + 判定 + 副作用验证 |
| `test/compact.test.ts` | 摘要、失败方向、游标不错位 |
| `test/agents-md.test.ts` | 嵌套、两种去重、边界 |

**改动**

| 文件 | 改什么 |
| --- | --- |
| `src/contract/policy.ts` | **把 `expandHome` / `slashes` / `squeeze` 导出**（见 §2.3 —— 沙箱复用同一套归一，否则两套会分叉） |
| `src/core/nouns/process.ts` | 收一个 `SandboxConfig` 与 `home`，`spawn` 之前判定 |
| `src/core/nouns/index.ts` | `CoreNounsDeps` 加 `sandbox?`，透传给 `createProcessNoun` |
| `src/cli/settings.ts` | 读 `sandbox` 与 `compact` 两块；`allow` 的来源过滤 |
| `src/cli/main.ts` | 透传配置；`/compact` 的接线 |
| `src/cli/repl.ts` | 每轮之后判阈值、提醒；自动压缩的调用点 |
| `src/cli/commands.ts` | 注册 `/compact` |
| `src/cli/plugins.ts` | 把 agents-md 插件加进第一方 |
| `src/cli/transcript.ts` | `createPersister` 加 `reseed` |
| `src/contract/events.ts` | `session.compact` 转正 |
| `src/contract/model-provider.ts` | `StreamEvent.done` 加 `usage` |
| `src/core/loop.ts` | 把 usage 填进 `turn.complete`；估计兜底 |
| `src/providers/anthropic.ts`、`openai.ts` | 解析 usage |
| `README.md`、`docs/项目简介.md`、`site/index.html` | 计数 16/23；沙箱那一节的诚实说明；「不做 `dangerouslyDisableSandbox`」 |

---

## 8. 验收标准

### C1（沙箱）

1. `deny` 命中的路径被拒，理由里带**是哪条规则**拒的。
2. `allow` 非空时，白名单外的路径被拒。
3. 圈内路径放行，命令**真的执行**（退出码与输出都对）。
4. **副作用验证**：一条本该写文件的命令（`echo x > <圈外路径>`）被拒后，
   **文件根本不存在**，退出码 `-1`，stderr 带 `[沙箱拒绝]`。← 这条比断言返回值难糊弄得多。
5. **结构性权威**：给 `Bash` 配一条 `allow` 权限规则，沙箱照样拒 —— `allow` 到不了它。
6. 非托管层设 `sandbox.paths.allow` 被丢弃，且**有警告**。
7. `enabled: false` 与"规则为空"两种情况下，命令照常跑。

### C2（压缩与 usage）

8. 两个适配器都从响应里解析出 usage（假 fetch，不碰真网络）。
9. 拿不到 usage 时回落估计，且 `turn.complete` 上 `usageEstimated: true`。
10. 压缩后 `messages` 的形状 = **一条摘要 + 最近 N 轮原文**，且轮边界按 `role === 'user'` 数。
11. **游标**：压缩之后继续落盘，写进转录的内容**与内存里的 messages 一致**（不漏、不错位）。
12. 摘要失败 / 返回空 / 压完反而更长 —— 三种情况都**不压缩**、出声、原文不动。
13. `session.compact` 真的被派了，`trigger` 分得清 `manual` 与 `auto`。

### C3（嵌套与收口）

14. 读某个子目录里的文件时，中间层目录的 `AGENTS.md` 被附在那次工具结果上。
15. 同一个文件第二次读**不重附**。
16. root 与用户层那两份**不重附**（它们已经在 system prompt 里）。
17. 读 root 之外的文件**不触发**。
18. 三处文档数字对齐为 **16 实现 / 23 未实现**，旧口径扫描零残留。

---

## 9. 已知偏差与存疑

1. **与参考实现的偏差：沙箱不是 OS 隔离。** 见 §0.1。这是本设计里最大的一处"我们做不到"，
   必须在 README 里说清楚，不能让它读起来像"我们有沙箱了"。
2. **`atTokens` 的默认 100_000 是猜的。** 我们不知道模型的真实窗口。文档里点名。
3. **"字符 ÷ 4" 只是估计**，中英混排会失真（中文一个字约等于 1-2 个 token，不是 0.25 个）。
   我们把它**标出来**（`usageEstimated`）而不是假装精确。
4. **候选路径提取没有基准可测。** 只有一组手写 fixture，覆盖我们想得到的写法。
   它的准确率是"我们信这组 fixture"，不是"我们量过"——这句话要写进文档。
5. **一个文件一次会话只附一次**这句里的"一次会话"是以**插件实例**为界的。
   `--resume` 起一个新实例，已附过的会再附一次。可接受（重新开始一段对话，重新给一遍上下文是对的），
   但记在这儿免得将来当成 bug。

---

## 10. 明确不做（YAGNI）

| 不做 | 为什么 |
| --- | --- |
| OS 级隔离（bubblewrap / sandbox-exec / job object） | 平台不支持且本机测不到；写一段永远跑不到的代码比不写更坏 |
| 网络隔离 / 域名白名单 | URL 提取比路径更容易骗过去。**做一半的隔离比不做更危险** —— 它让人以为安全了 |
| `dangerouslyDisableSandbox` 逃生阀 | 它就是"放行开关"，与"谁加自动放行开关谁就是在开倒车"正面冲突 |
| `sandbox.autoAllowBashIfSandboxed` | 把"我加了闸"读成"所以不用问了"，正好把闸的意义倒过来 |
| 按动词区分读写的路径判定 | 文本分析分不出 `cat` 与 `rm`；一律按写算，严的方向错好过松的方向错 |
| 自动压缩默认开 | 阈值是猜的，静默丢细节不能是默认行为 |
| `PreCompact.custom_instructions` | 参考实现有；我们没有真实需求 |
| 压缩后恢复"最近读取的文件"状态 | 参考实现记过这条注记（`05-mod-agents-md.md:40`），**我们这儿根本没有那个状态** |
| 子代理内部的压缩 | 子代理一轮就跑完，上下文由它的 `prompt` 与 `maxTurns` 封住 |
| 指令文件的五层优先级 | MVP §9.2 把它排在 **P5**（`五层优先级 + 托管下发`） |
| 压缩成"丢工具结果"这类第二策略 | 一种策略做扎实，好过两种都半吊子 |

---

## 11. 关键文件索引（实现时对照）

| 要改的东西 | 去哪儿看 | 关键行 |
| --- | --- | --- |
| 权限规则的路径匹配（**复用**） | `src/contract/policy.ts` | `matchesRule` :126、`PATH_TOOLS` :47、`parseRule` :78 |
| `process` 名词（沙箱落点） | `src/core/nouns/process.ts` | `run` :5；abort 形状 :8-10 |
| 名词装配（透传配置） | `src/core/nouns/index.ts` | `createCoreNouns` :47、`process:` :71 |
| 引擎装配 | `src/core/create.ts` | `CreateEngineDeps` :11 |
| `Bash` 工具（**不用改**，但要确认 `ERROR:` 前缀这条链） | `src/builtins/tools/bash.ts` | :44-48、:49-55 |
| 设置解析与五层来源 | `src/cli/settings.ts` | `ResolvedPolicy` :55、`resolvePolicy` :104+、:155-156 |
| 持久化游标（**陷阱**） | `src/cli/transcript.ts` | `createPersister` :97-124 |
| loop 与 `turn.complete` | `src/core/loop.ts` | :124、:157、`LoopContext` :15-36 |
| 流事件契约 | `src/contract/model-provider.ts` | `StreamEvent` :35-54 |
| 指令加载（**要接嵌套**） | `src/cli/main.ts` | `loadInstructions` :34-43、拼装 :264-266 |
| REPL 的 turn 循环（自动压缩的调用点） | `src/cli/repl.ts` | :86-103 |
| 参考实现的嵌套做法 | `claude-code-架构分析/05-mod-agents-md.md` | :28、:31、:38、:40 |
| 参考实现的沙箱键表 | `claude-code-架构分析/06-security-permissions.md` | :139-157、:515-516、:630 |

---

## 12. P4 余下的部分

按 P4a §17 的分组，本轮吃掉 **P4b 上下文与执行边界**。余下：

| 组 | 内容 |
| --- | --- |
| **P4c 分发与治理** | marketplace、hookify DSL、`config.*` 与 `command.describe` |
| **P4d 可观测与多 surface** | `mod-telemetry`、`ui.render` 的 `RenderNode`、`session.attach/detach/receive/measure`、`prompt.*` 一族 |
| **P4e 工程化** | CI、`check-boundaries` 扩到 `plugins/`、发布流程 |
| **P4f? 遗留的第三方 `$` 扩展** | 两段式注册；它是**加权威**的动作，与"第三方只能更严"正面冲突，要单独想清楚 |

`P5 内建与分发` 仍在 P4 全部收口之后 —— "内建"这个词的边界取决于扩展面最终长什么样。
