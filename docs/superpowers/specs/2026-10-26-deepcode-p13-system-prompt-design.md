# DeepCode P13 系统提示设计

> 对标 Claude Code 的 System Prompt 机制（用户提供的「System prompt」材料）。
> 一句话口径：**先写行为红线，再把不变的那部分冻成前缀；能缓存的是前缀，不是整段提示。**

---

## 1. 现状与差距

P12 结束时，DeepCode 的系统提示只有 `src/cli/main.ts` 里的一小段字符串：

```ts
const SYSTEM_PROMPT = `你是 DeepCode，一个在用户终端里工作的编码助手。
工作方式：……回答保持简短，说清楚你改了什么、为什么。`;
```

P7 把它改成每轮重算（base + `prompt.section` + `agent.offer`），P12 又加了一节记忆。
功能上够用，但对照复刻对象，缺三样东西：

| 复刻对象 | DeepCode 之前 |
| --- | --- |
| 角色 + URL 红线（不编造链接） | 只有一句角色 |
| 安全边界：先确认授权范围，再拒绝破坏性操作 | 无 |
| 操作安全：可逆性、影响范围、难以撤销的操作先确认 | 无 |
| 专用工具优先于 Bash（Read / Glob / Grep） | 有一句"需要看代码就用"，但没写"别用 cat/find/grep" |
| Git 安全（不改已推送提交、不 `--amend`、不 force push、不擅自提交） | 无 |
| 输出效率（不写开场白、不复述、用 path:line） | 只有"回答保持简短" |
| 环境注入（cwd / 是否 Git 仓库 / 平台 / Shell / 日期） | 无 —— 模型不知道自己在哪台机器、哪个目录 |
| 静态/动态边界，供 prompt cache 命中 | 无 —— 每次请求一个整串，端点只能自己猜前缀 |
| 三级缓存（会话 / 组织 / 全局） | 无显式 `cache_control` |

差距不只是"少了几句话"。**没有静态/动态边界，提示词写得越长，每一轮越贵**；
而把环境、日期、指令文件混在里面，又会让本来可以命中的前缀每轮都变。

---

## 2. 设计口径

### 2.1 提示词不是权限边界

系统提示只能让模型**更少犯蠢**，拦不住一个被注入的、或执意越界的模型。
DeepCode 真正的闸门仍然是 `tool.check` 链、沙箱与确认提示。P13 不把任何安全承诺
从代码挪进提示词 —— 它只是把"模型该知道的事"写清楚。这一点写在 `prompt-text.ts` 顶部，
也写进 `site/已知限制.md`。

### 2.2 先给范围，再画红线

安全那一节的第一句是"先确认授权范围"，然后才是拒绝清单：

- 只帮助防御性安全、**经过授权**的安全测试、CTF 与教学；
- 拒绝破坏性攻击、DoS、大规模目标扫描、供应链投毒、规避检测；
- 不协助窃取凭证、绕过访问控制、隐藏恶意行为；
- 发现漏洞先报告与修复，不给可直接武器化的利用链。

顺序不是修辞：先问范围，模型才不会把"用户在做安全研究"直接当成"用户要攻击"；
反过来，先列禁令再补一句"授权除外"，模型容易把禁令当默认答案。

### 2.3 可逆性与影响范围

操作安全那一节要求模型在动手前判断两件事：

1. **可逆吗** —— 删除、覆盖、`reset --hard`、force push 属于难以撤销；
2. **影响多大** —— 单文件、整个目录、整个仓库、对外的推送/发布，不是一回事。

规则是：只读查询先做；写操作先确认目标；难以撤销或对外的操作，先说明后果并取得确认；
优先最小改动，不用破坏性手段"让它先跑起来"。

这与 DeepCode 已有的确认提示是两层：确认提示问的是用户**要不要放行**，
提示词让模型**先想清楚该不该提出这个请求**。

### 2.4 专用工具而不是 Bash

明确写出 `Read` / `Glob` / `Grep` 与 Bash 的 `cat` / `find` / `grep` 的分工。
理由不是偏好：专用工具有结构化的参数、只读标记（可并发）、结果外置与 `offset` / `limit`
读回；`cat` 一个 10MB 文件只会把上下文炸掉。

### 2.5 Git 安全

写进提示词的是几条**不可逆或影响他人**的操作：

- 提交前先看 `git status` / `git diff`；
- 不对已推送的提交 `--amend`，不 force push，不改用户的 git 配置；
- 除用户明确要求外，不提交、不推送、不创建 PR；
- 不回滚不是自己做的改动；
- 交互式命令（`rebase -i`）在非交互终端里会卡住，改用非交互形式。

`--amend` 单独点名，因为它是"看起来只改一条提交、实际上改写了历史"的典型：
本地未推送时 usually 安全，已推送时会把别人的分支顶掉。

### 2.6 输出效率

- 直接给结果，不写"好的，我来……"；
- 不复述用户已经知道的事，不主动生成大段总结；
- 改完用一两句话说明改了什么、为什么；
- 引用位置用 `path:line`。

目标是让终端输出可扫读，而不是把模型的思考过程再抄一遍给用户。

### 2.7 环境注入：观测到什么写什么

环境段包含：

```
环境（会话开始时）：
- 工作目录：/home/dev/app
- Git 仓库：是
- 平台：Linux
- Shell：bash
- 模型：deepseek-chat
- 今天：2026-10-26
```

三条口径：

1. **只写观测到的**：没有 `.git` 就写"否"；Shell / 模型拿不到就整行不写，不拿默认值冒充事实。
2. **日期用本地日期**，不用 `toISOString()` —— 东八区 23:30 会被 UTC 写成第二天。
3. **只探测一次**（会话开始时）。cwd 与模型在会话中不会变；日期跨午夜会老一天，
   这是刻意取舍：每轮重算日期会让动态尾巴无谓翻动，而"今天"差一天的代价更小。

### 2.8 静态/动态边界与三级缓存

复刻对象在提示字符串里放了一个 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 标记，把前面冻成前缀。
DeepCode **不抄这个字符串标记**，而是把边界变成类型：

```ts
type PromptPiece = { name: string; text: string; cache?: 'static' | 'dynamic' };
type BuiltPrompt = { text: string; pieces: PromptPiece[]; staticText: string; dynamicText: string };
```

理由：字符串标记会被正文里的同名文本撞上，也无法在编译期保证"静态段没有排在动态段后面"。
结构化边界可以断言：静态段逐字节稳定、静态段是整段提示的前缀、`text === static + '\n\n' + dynamic`。

三级缓存里，**只有会话级前缀缓存是客户端能做的**：

| 级别 | 谁能做 | DeepCode |
| --- | --- | --- |
| 全局（跨用户/跨组织） | 推理基础设施 | 做不到，也不假装 |
| 组织/项目共享 | 端点 + 同一把 API key | 静态前缀跨项目逐字节相同，同一 key 在 TTL 内可复用；不是显式共享 |
| 会话内前缀 | 客户端 | 做：一个 `cache_control` 断点在静态段末尾 |

Anthropic 的缓存前缀顺序是 **tools → system → messages**。断点放在静态系统提示末尾，
一次盖住工具清单与静态正文 —— 这是每次请求里最大且最稳定的两块。消息前缀每轮追加、
失效判定复杂，这一阶段不打第二个断点。

---

## 3. 架构

```
STATIC_PROMPT_SECTIONS          ← 代码常量，7 节
        │
        ├─ role / security / behavior / safety / tools / git / output
        │
        ▼
assemblePrompt
        │  staticText   = 静态分节 join('\n\n')          cache: 'static'
        │  dynamicText  = 环境 + prompt.section + 清单    cache: 'dynamic'
        │  text         = staticText + '\n\n' + dynamicText
        ▼
createPromptBuilder（每轮重算）
        │
        ▼
runTurn / REPL ──► StreamRequest { system, systemParts }
        │
        ├─ Anthropic: system = [
        │    { type:'text', text:static, cache_control:{type:'ephemeral'} },
        │    { type:'text', text:dynamic }
        │  ]
        │
        └─ OpenAI 兼容: system 仍是一条字符串，静态段天然在最前
```

三个关键点：

1. **拼装是纯函数**。`assemblePrompt` 不碰引擎、不碰磁盘，benchmark 与测试直接用它；
   `createPromptBuilder` 只负责派发两个事件、把环境塞进去。
2. **字符串仍是唯一事实来源**。`system` 与 `systemParts` 同时给；拆分只影响缓存标记，
   不影响模型看到的内容。两处不一致的后果是缓存不命中，不是请求变错。
3. **旧调用方不必改**。`systemParts` 可选；不给就原样发字符串（P12 的字节形状不变）。

---

## 4. 逐层设计

### 4.1 静态分节

`src/cli/prompt-text.ts` 导出七节，顺序固定：

| 分节 | 内容 | 字符 | token（估） |
| --- | --- | ---: | ---: |
| `role` | 身份、语言、不编造 URL | 119 | 30 |
| `security` | 先范围后红线 | 172 | 43 |
| `behavior` | 看清现状、不编造、不改无关代码 | 166 | 42 |
| `safety` | 可逆性与影响范围、最小改动、密钥 | 168 | 42 |
| `tools` | 专用工具优先、Edit/Write、ERROR:、外置 | 252 | 63 |
| `git` | status/diff、`--amend`、force push、不擅自提交 | 215 | 54 |
| `output` | 不写开场白、不复述、path:line | 133 | 34 |
| **合计** | | **1,237** | **310** |

这比复刻对象的完整提示短得多。取舍是刻意的：DeepCode 的模型不一定是 Claude，
逐字搬运一大段英文提示既增加成本，也无法保证在别的模型上同样有效。
这里只保留**能改变行为**的约束，每一条都能在测试或代码里找到对应。

### 4.2 环境段

`src/cli/environment.ts` 负责三件观测：

- `isGitRepo(start)`：从 cwd 向上找 `.git`（worktree 的 `.git` 是文件，也算）；
- `shellName()`：`SHELL` → `ComSpec` → 平台默认，只取文件名；
- `todayLabel()`：本地日期 `YYYY-MM-DD`。

`renderEnvironment(env)` 在 `prompt-text.ts` 里，是纯函数。
环境段永远标记 `dynamic` —— 它不是"每轮都变"，而是"**跨会话**会变"，
而缓存前缀要求跨会话也逐字节稳定。

### 4.3 拼装顺序与不变量

顺序是契约：

```
静态分节 → 环境 → prompt.section（指令文件 / 记忆）→ 清单（agent.offer）
```

`assemblePrompt` 保证四条不变量（`test/system-prompt-cache.test.ts` 钉住）：

1. 静态段逐字节稳定：换项目、换日期、换模型都不动；
2. 静态段是 `text` 的前缀；
3. `text === staticText + '\n\n' + dynamicText`（有空段时少一个分隔符）；
4. `pieces` 就是拼进 `text` 的那一批，`/context` 不另算一份账。

空段（`''`）不进 `pieces`，与 P7/P12 一致。

### 4.4 Provider 接线

**Anthropic**（`src/providers/anthropic.ts`）：

```ts
system: toAnthropicSystem(system, systemParts)
// [
//   { type: 'text', text: static, cache_control: { type: 'ephemeral' } },
//   { type: 'text', text: dynamic }
// ]
```

- 静态段为空时不带断点（缓存空块端点不接受）；
- 动态段为空时只发静态块；
- 没给 `systemParts` 时原样发字符串。

**OpenAI 兼容**（`src/providers/openai.ts`）：有意不接 `systemParts`。
这类端点没有显式 `cache_control`，靠稳定前缀自动命中；把 `system` 拼成一条 system 消息、
静态段排在最前，已经是最有利于命中的形状。拆成两条反而可能被端点当成不同前缀。
DeepSeek 的自动上下文缓存走的也是这条路。

**Loop / REPL**：`LoopContext.systemParts` 可选；REPL 的 `systemPrompt` 返回值多带
`staticText` / `dynamicText`，只给 `text` 的旧调用方仍然能编译（不启用分级缓存）。
一次性模式与 REPL 都把 `builder.build()` 的拆分原样传下去。

### 4.5 失败方向

| 失败 | 行为 |
| --- | --- |
| 读不到 `.git`（权限/IO） | 当作"否"并继续。无法区分"没有"与"读不了"是已知限制 |
| Shell / 模型取不到 | 整行不写，不拿默认值冒充 |
| `prompt.section` / `agent.offer` 抛错 | 维持 P7 行为：这个 turn 失败。提示是必需输入，不是可选装饰 |
| 端点不认 `systemParts` | OpenAI 侧忽略；Anthropic 侧只有一家协议，按官方形状发 |
| 端点不支持缓存 | `cache_control` 被忽略，请求仍然有效，只是不省钱 |

---

## 5. 可观测性

`/context` 在「系统提示」之后多一行：

```
  缓存前缀　静态 310 token（可缓存） · 动态 209 token（每轮重算）
```

只有分节带 `cache` 标记时才出现 —— 旧夹具没有标记，硬算会报一个假的 0。

`pnpm bench:prompt` 输出三张表：静态分节、三个项目的静态/动态拆分、20 轮缓存账。
它不调用模型，不需要 key。

---

## 6. 偏差与代价（如实写）

1. **提示词不是安全边界。** 它降低犯错概率，不提供保证；权限仍只走 `tool.check`。
2. **只对 Anthropic 显式缓存。** OpenAI 兼容端点靠自动前缀缓存，命中与否不可见；
   DeepSeek 的缓存策略也不由我们控制。
3. **只打一个缓存断点，不缓存消息。** 消息前缀每轮追加，失效判定复杂；收益远小于静态段。
4. **静态段 310 token 是 `chars/4` 估算。** 中文实际 token 密度更高，绝对值会偏大；
   与动态段用同一把尺子，比值有意义，绝对值没有。
5. **环境只探测一次。** 跨午夜的会话日期会老一天；会话中 `git init` 也不会刷新。
6. **不注入知识截止日期。** 我们不知道端点上跑的是哪个模型、它的截止日期是什么，
   编一个日期比不写更坏。
7. **不做跨用户/全局缓存。** 那是推理基础设施的能力，客户端做不到。
8. **缓存命中不可观测。** 当前 `Usage` 只读 `input_tokens` / `output_tokens`；
   Anthropic 的 `cache_creation_input_tokens` / `cache_read_input_tokens` 没有解析。
   benchmark 算的是**成本模型**，不是真实命中率 —— 这一点不混为一谈。
9. **子代理拿不到环境、指令文件与记忆。** 它们拿到 `STATIC_PROMPT_TEXT` 加自己的角色描述；
   这是 P10 硬隔离的延续，不是遗漏。
10. **静态分节是手写的，不是按模型自动优化。** 没有 A/B、没有按模型切换；
   换模型后哪几句仍然有效，需要另外实测。
11. **端点有最小可缓存长度。** Anthropic 对 Sonnet / Opus 是 1,024 token、
   Haiku 是 2,048 token；低于这个长度，`cache_control` 不报错但**不会建立缓存**。
   我们的静态段估算 310 token，加上工具清单可能过线、也可能不过；而 `chars/4`
   本身又不精确。所以 benchmark 是**上限模型**（假设每轮命中），不是命中承诺。

---

## 7. 验收

### 7.1 出口标准

1. **静态段稳定**：三个不同项目、日期、模型下，`staticText` 逐字节相同。
2. **边界可断言**：`staticText` 是 `text` 的前缀；`text = static + 动态`。
3. **红线真的写进去**：`--amend`、`force push`、可逆性、授权范围、URL、`ERROR:` 都能在静态正文里找到。
4. **环境只进动态段**：cwd / 日期不出现在静态前缀；Git 仓库为否时如实写"否"。
5. **Anthropic 请求形状**：有拆分时两个 text block，静态块带 `cache_control`；
   没有拆分时仍是一个字符串。
6. **OpenAI 形状不变**：仍是一条 system 消息，静态段在最前。
7. **账本对得上**：静态 + 动态分节之和 = 系统提示那一行（取整余数除外）。
8. **benchmark 方向正确**：20 轮缓存成本低于无缓存，第 2 轮回本；
   静态占比在小项目 > 50%，巨型 AGENTS.md 场景仍 > 20%。

### 7.2 Benchmark 场景

| 场景 | 环境 | 指令文件 | 清单 |
| --- | --- | ---: | ---: |
| `small-service` | Linux / Git / bash | 600 字符 | 120 字符 |
| `monorepo` | Linux / Git / bash，路径更长 | 2,400 字符 | 300 字符 |
| `no-git` | Windows / 非 Git / cmd.exe | 0 | 0 |

成本模型：输入 token 价 = 1；缓存写 1.25×、读 0.1×；20 轮；假设每轮命中
（忽略端点最小可缓存长度，见 §6 偏差 11 —— 这是上限，不是承诺）。

### 7.3 实测（`pnpm bench:prompt`，2026-10-26）

| 场景 | 静态 | 动态 | 静态占比 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| small-service | 310 token | 209 token | 59.7% | 519 token |
| monorepo | 310 token | 712 token | 30.3% | 1,022 token |
| no-git | 310 token | 29 token | 91.4% | 339 token |

| 场景 | 无缓存 20 轮 | 有缓存 20 轮 | 省下 | 降幅 | 回本 |
| --- | ---: | ---: | ---: | ---: | ---: |
| small-service | 10,380 | 5,157 | 5,224 | 50.3% | 第 2 轮 |
| monorepo | 20,440 | 15,217 | 5,224 | 25.6% | 第 2 轮 |
| no-git | 6,780 | 1,557 | 5,224 | 77.0% | 第 2 轮 |

「省下」三个场景相同，因为省的是静态段的固定成本：20 轮全价 6,200，
换成一次写价 387.5 + 19 次读价 589，净省 5,223.5。动态段不在缓存里，省不了。
真实的缓存前缀还包括工具清单，那一份也是稳定的，只会让收益更大 —— 这里刻意没算进去。

---

## 8. 任务分解

| 任务 | 落点 |
| --- | --- |
| 静态正文七节 | `src/cli/prompt-text.ts` |
| 环境探测 | `src/cli/environment.ts` |
| 拼装与分界 | `src/cli/system-prompt.ts`（`assemblePrompt` / `createPromptBuilder`） |
| 请求契约 | `src/contract/model-provider.ts`（`SystemPromptParts.systemParts`） |
| Anthropic 缓存断点 | `src/providers/anthropic.ts` |
| Loop / REPL 接线 | `src/core/loop.ts`、`src/cli/repl.ts`、`src/cli/main.ts` |
| 账本 | `src/cli/context-view.ts`（「缓存前缀」一行） |
| Benchmark | `scripts/benchmark-system-prompt.ts`、`test/system-prompt-benchmark.test.ts` |
| 测试 | `test/system-prompt-cache.test.ts`、`test/environment.test.ts`、provider / context-view 增补 |
| 文档 | README、CHANGELOG、官网阶段表、`site/已知限制.md` |

---

## 9. 后续（不在这阶段做）

- 解析 Anthropic 的 cache 命中字段，把"真命中率"接进 `/context` 与告警；
- 给消息前缀打第二个断点（需要按 turn 边界失效，复杂度高）；
- 按模型切换静态正文（不同模型对提示的敏感度不同，需要实测）；
- 子代理继承环境（现在只继承静态正文，子代理不知道自己在哪个目录）。
