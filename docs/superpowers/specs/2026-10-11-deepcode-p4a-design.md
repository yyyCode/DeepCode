# DeepCode —— P4a 组合面设计（子代理与技能）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 同体例的先例是 [`2026-10-11-deepcode-p3-design.md`](2026-10-11-deepcode-p3-design.md)。
> P4 那一列在 MVP §9.2 的矩阵里横跨十一个工作面，一份 spec 装不下，
> 所以**本轮只做「组合面 + 技能」**，其余记在 §17 并各自另立。

**一句话**：让一个会话能自己派出**受限的**子代理、按需加载知识包，
而这两件事都不新增任何一条放宽权限的路径。

---

## 0. 决策摘要

1. **子代理 = 内层再跑一遍 `runTurn`**。不是子进程、不是第二套循环 —— 同一个 `loop.ts`，
   换一份 `messages`、一段 system prompt、一份工具清单。于是**权限链原样生效**（§6.4）。
2. **内核里没有硬编码的名册，也没有硬编码的工具表**（P3 已经守住的第二条，本轮不能破）。
   内核只多一个名词 `$.agent.spawn`，它知道的全部是"换一份清单、跑一个 turn"。
   谁有资格派、按什么路由、清单怎么算，全在第一方插件 `cli/subagents.ts` 里。
3. **工具白名单只有一个落点**：`LoopContext.tools`。`describeTools` 与 `runOneTool` 两处认它 ——
   前者管"看不见"，后者管"够不着"。P3 的 `todo` 插件已经证明**只做前者是纸糊的**。
4. **嵌套不是一条规则，是白名单的推论**：`Task` 就是一个工具，清单里写了就能再派。
   另加一个**深度硬上限 3** —— 白名单能表达"允许不允许"，表达不了"允许几次"。
5. **技能只做渐进式披露的前两层**，第三层（`references/` `examples/` `scripts/`）
   靠已有的 `Read` / `Bash`，**我们一行代码都不写**（§10.1）。
6. **一个事件都不新增**。`agent.offer` / `agent.spawn` / `skill.prompt` 从"声明-only"
   转成实现，39 这个总数不变，实现数 12 → 15（§2.1）。
7. **`skill.prompt` 链尾无人应答 = 原文通过，不是 deny**。它与 `tool.check` 不是一类东西（§10.3）。
   这条要写进文档，否则将来一定有人把它"统一"成 fail-closed。
8. **frontmatter 自己解析**，零运行时依赖这条不破（§3）。多行标量/嵌套映射/锚点**不支持**，
   遇到就报错 —— 猜一个可能猜错的值比拒绝更危险。

---

## 1. 出口标准怎么落

MVP §9.2 的 P4 列里，本轮吃掉的是前六项。逐项落点：

| 出口标准（P4 列） | 落点 | 怎么验 |
| --- | --- | --- |
| `agents/*.md` 约定目录 + 解析 | `src/contract/frontmatter.ts`（纯函数，零 IO）+ `src/cli/agents.ts`（发现装配） | 一组 fixture 逐条断言；坏 frontmatter 不装 + 出声 |
| `description` 路由 | `agent.offer` → `cli/main.ts` 拼进 system prompt | 断言每个 agent 的 name + description 确实在提示词里；**概率性那一半只记执行记录**（§7） |
| `Task` 工具 | `cli/subagents.ts` 注册 `Task` | 脚本化 provider 下能派到指定的 spec |
| 工具白名单 | `LoopContext.tools`，两处认它 | 两条反向验证：各删一处，各红一条（§13） |
| 子上下文隔离 | 内层用全新 `messages`，只回传最后一段文本 | 断言父级拿到的结果里**不含**子代理读过的文件内容 |
| 模型分层 | `StreamRequest.model?` | 假 provider 记录到的 model 参数 |
| 技能（本轮一并做） | `Skill` 工具 + `skill.prompt` 缝 | 元数据进提示词、正文可加载、可被 hook 改写 |

**验收方式沿用 P2/P3 的体例**：任务级只跑 `pnpm typecheck`，测试按 C1/C2/C3 三个检查点批量跑。

---

## 2. 契约变宽（本轮唯一的加法）

### 2.1 三个事件转正

`src/contract/events.ts`：`agent.offer`、`agent.spawn`、`skill.prompt` 从 `UnimplementedEvent`
移进 `EventArgs` / `EventResult`。**`UnimplementedEvent` 少三个，总数 39 不变，实现数 12 → 15。**

```ts
// EventArgs 新增
'agent.offer': Record<string, never>;
'agent.spawn': { readonly name: string; readonly task: string; readonly model?: string };
'skill.prompt': { readonly name: string; readonly text: string };

// EventResult 新增
'agent.offer': {
  // `tools` 是**我们多加的**（参考实现的 AgentOfferInput 只有 name + description）：
  // 白名单是承重的东西，让用户与模型都看得见比藏起来好（§7）。
  readonly agents: readonly {
    readonly name: string;
    readonly description: string;
    readonly tools?: readonly string[];
  }[];
  readonly skills: readonly { readonly name: string; readonly description: string }[];
};
'agent.spawn': Record<string, never>;
'skill.prompt': { readonly text: string };
```

两处**内核默认实现**写进 `createEngine` 的 `coreImpls`（`core/create.ts:44`），不藏在别处：

```ts
// 链尾没人报清单 = 这个会话没有子代理也没有技能。**能力方向上的 fail-closed**：
// 报空清单，模型就派不了、也加载不了任何东西。
'agent.offer': () => ({ agents: [], skills: [] }) as const,
// 变换缝，不是闸：没人要改，就是文件自己那份原文（§10.3）。
'skill.prompt': (e) => ({ text: String(e.text) }),
```

`agent.spawn` 加进 `NOTIFICATION_EVENTS`（`events.ts:156`）——
它的语义就是"让插件看得见有人要派子代理了"，没有任何一条需要内核答复，
链尾 `{}` 兜底正是 `dispatch.ts:81` 已经实现的语义。

**三处偏离参考实现，都是有意的：**

- 参考实现的 `agent.offer` 是**每个候选 agent 调一次**（`AgentOfferInput` 带 `agent`/`source`/`provider`），
  hook 返回 `{isOffered:false}` 逐个隐藏。我们**一次问链、拿回整张表**。理由：逐个问要一个
  "候选人从哪来"的中间概念，而那个概念在我们这儿等于 `cli/subagents.ts` 内部的数组 ——
  绕一圈只是把同一个数组换个地方拆开再合上。
- 参考实现的 `agent.spawn` 允许 hook **改写** `prompt`/`model`/`cwd`。我们只做**通知**，不做改写。
  P4a 里没有任何一条需求要靠它，而"可改写"意味着要定义"改完之后谁负责重新解析白名单"。
- 名字偏窄：`agent.offer` 顺带报了技能清单。消费者是**同一个**（拼 system prompt 那一处），
  拆成 `skill.offer` 就是多一个第 40 个事件、多派一次、拼两份 ——
  而事件目录是这个架构里最不该随手加东西的地方（`events.ts:55-59`）。记为 §14 偏差。

### 2.2 `AgentSpec` / `SkillSpec`

新文件 `src/contract/agent.ts`，**type-only、零 import**（`contract/` 的边界不破）。

```ts
export type AgentSpec = {
  readonly name: string;
  readonly description: string;
  /** markdown 正文。**为空时回落到会话的基础 system prompt**（§5.1）。 */
  readonly prompt: string;
  /** 白名单。**省略 = 继承父级全部工具**；给了 = 只有列出的能用。 */
  readonly tools?: readonly string[];
  /** 在白名单之上再扣一层。 */
  readonly disallowedTools?: readonly string[];
  /** 'inherit' | 别名 | 完整 id。省略 = inherit。 */
  readonly model?: string;
  /** 本子代理单次调用的最大往返次数，省略 = loop 的 MAX_HOPS。 */
  readonly maxTurns?: number;
};

export type SkillSpec = {
  readonly name: string;
  readonly description: string;
  /** SKILL.md 的正文（第二层披露）。 */
  readonly body: string;
  /**
   * 这个技能自己的目录。
   *
   * **第三层要靠它**（§10.1）：披露的第三层是"模型自己去读 `references/`"，
   * 而模型得先知道那个目录在哪。`Skill` 工具的结果里会把路径一块儿给它。
   */
  readonly dir: string;
};
```

`AgentSpec` 收这几个字段，其余**逐条不做**：`color`（纯界面，连参考实现的 `AgentSpec` 类型里都没有）、
`permissionMode`（我们没有权限模式这套东西，权限是一条链不是一组模式）、`mcpServers` / `hooks`
（都没有）、`skills`（子代理要用 `Skill` 工具，把工具列进白名单就行，不需要预加载这个额外语义）、
`memory` / `background` / `isolation` / `omitClaudeMd` / `effort` / `initialPrompt`（都没有对应实现）。

**不认识的字段：警告 + 忽略，不报错。** 参考实现有 17 个字段，我们的 `agents/*.md`
多半是照那边抄的；一条「不认识 `color`，已忽略」比「文件坏了，整个 agent 不装」有用得多。
警告只在装载时出一次。

### 2.3 `$` 上多两个名词

`src/contract/engine.ts`：

```ts
export type AgentNoun = {
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>;
};

/**
 * 技能正文在经过 `skill.prompt` 这道缝之后的样子。
 *
 * 为什么这也得是个名词：**插件拿不到 `dispatch`**（`contract/plugin.ts` 的 hook 签名是
 * `($, e, next)`），所以"派一次 `skill.prompt` 让别的插件有机会改写"这件事，
 * 插件自己做不到 —— 和子代理要 `$.agent.spawn` 是同一个原因。
 *
 * 这一对名词是本轮"插件拿不到 dispatch"这条约束的**全部**代价：
 * 内核为此多开两个口子，而不是把 dispatch 漏给插件。
 */
export type SkillNoun = {
  load(req: { readonly name: string; readonly text: string }): Promise<{ readonly text: string }>;
};

export type AgentSpawnRequest = {
  /** 用于日志与错误消息。 */
  readonly name: string;
  /** **已解析**的系统提示词（回落已经算完）。内核不再做回落判断。 */
  readonly systemPrompt: string;
  readonly task: string;
  /** **已解析**的允许清单。内核只照着它过滤，不做任何减法。 */
  readonly tools: readonly string[];
  /** 已解析的模型；undefined = 用会话自己的。 */
  readonly model?: string;
  readonly maxHops?: number;
};

export type AgentSpawnResult = {
  readonly text: string;
  readonly stopReason: string;
};
```

**名词收的是"已解析"的三样东西，不是 `AgentSpec`。** 这是本轮最关键的一处职责切分：
白名单怎么算（`tools` 省略要不要继承、`disallowedTools` 怎么扣）、正文空了怎么办、
`model` 省略算不算 `inherit` —— 全是**策略**，全在插件里；内核收到的是一张已经算好的清单。
内核因此永远不需要知道"省略 `tools` 是什么意思"。

**`dispatch` 与 `$` 怎么给到名词。** `createCoreNouns(deps, registry)` 在 `createEngine` 里
跑在 `createDispatcher` **之前**、更跑在 `engine.create` 折叠**之前**，所以那时这两样都还不存在。
用**已经有的那个套路**（`core/dispatch.ts:19` 的 `engine: () => EngineInterface`，注释写着
"延迟取 `$`：`$` 要到 engine.create 折叠完成之后才存在"）。

**这两个延迟取的东西不进 `CoreNounsDeps`，走第三个参数** —— 因为 `CoreNounsDeps` 是
`CreateEngineDeps` 的一部分，而调用方（`cli/main.ts`）不该也不可能有 `dispatch`。
这和 `registry` 是第二个参数的理由一字不差（`nouns/index.ts:26-29` 的注释）：

```ts
// core/nouns/index.ts
export function createCoreNouns(
  deps: CoreNounsDeps,
  registry: Registry,
  refs: {
    /** 折叠完成之后才有值。 */
    readonly engine: () => EngineInterface;
    /** createDispatcher 返回之后才有值。 */
    readonly dispatch: () => DispatchFn;
  },
): CoreEngineInterface {
  return {
    // …既有十个名词
    agent: createAgentNoun({ engine: refs.engine, provider: deps.provider, signal: deps.signal, dispatch: refs.dispatch }),
    skill: createSkillNoun({ dispatch: refs.dispatch }),
  };
}
```

```ts
// core/create.ts
let engine: EngineInterface | undefined;
let dispatchFn: DispatchFn | undefined;

const coreNouns = createCoreNouns(deps, registry, {
  engine: () => {
    if (!engine) throw new Error('$ 尚未构建完成');
    return engine;
  },
  dispatch: () => {
    if (!dispatchFn) throw new Error('dispatch 尚未构建完成');
    return dispatchFn;
  },
});

const { dispatch } = createDispatcher({ /* … */ });
dispatchFn = dispatch;

const folded = (await dispatch('engine.create', /* … */)) as EngineInterface;
engine = folded;
```

两个 getter 与 `signal: () => AbortSignal` 是**同一个形状**：不是"现在就要一个东西"，
而是"用的时候现取一个"。`engine` 那个 getter 的第一行与 `create.ts` 里那个同名的
`engine` getter 一字不差地重复了一遍 —— 它们守的是同一条时序约束，抄同一句话是有意的。

### 2.4 `LoopContext` 多三个可选字段

`src/core/loop.ts`：

```ts
export type LoopContext = {
  // …既有六个字段不变
  /** 允许调用的工具。**undefined = 不筛**（会话主循环就是这一支）。 */
  tools?: ReadonlySet<string>;
  /** 覆盖 MAX_HOPS。子代理的 maxTurns 落在这里。 */
  maxHops?: number;
  /** 覆盖适配器配置里的 model（§2.5）。省略 = 用配置的那个。 */
  model?: string;
  /** 每一轮模型说的话。主循环不传（它直接走 turn.step 就出去了）。 */
  onText?: (text: string) => void;
};
```

**三个都是可选的，所以主循环一行都不用改。** 这是刻意的：白名单与模型分层不是
"子代理专用的分支"，而是循环本来就该有的参数，只是默认不限、不覆盖。

`model` 之所以必须**经过 `LoopContext`**：`loop.ts:54` 是直接调 `ctx.provider.stream(...)` 的，
**不经过 `$.model.stream`** —— 所以模型分层没有一个"从名词绕过去"的路径，
它只能从 ctx 走。

顺带修一处既有缺陷：`loop.ts:37` 的 `for` 循环**跑满 MAX_HOPS 时是静默退出的** ——
`stopReason` 停在上一次 provider 说的值上，调用方分不清"模型说完了"和"撞墙了"。
改成跑满时 `stopReason = 'max_hops'`。父级那条路也因此终于能知道自己是撞墙了。

### 2.5 `ModelProvider.stream` 认 `model`

```ts
export type StreamRequest = {
  // …既有四个字段不变
  /** 覆盖适配器配置里的 model。省略 = 用配置的那个。 */
  readonly model?: string;
};
```

两个适配器各改一行：`anthropic.ts:32` 与 `openai.ts:42` 的 `model: config.model`
→ `model: req.model ?? config.model`。这是模型分层**唯一**的实现方式：
今天 model 是适配器建的时候定死的，没有别的口子。

---

## 3. frontmatter 解析器

新文件 `src/contract/frontmatter.ts`。**纯函数、零 IO、零依赖。**

```ts
export type FrontmatterField = string | readonly string[];

export type Frontmatter = {
  readonly fields: ReadonlyMap<string, FrontmatterField>;
  /** frontmatter 之后的部分，原样。 */
  readonly body: string;
};

export function parseFrontmatter(text: string): Frontmatter;
```

**为什么自己写而不是装个 yaml：** 零运行时依赖是这个项目的既有承诺（`package.json`
只有 `devDependencies`），为十来个标量字段破这个戒不值得。

**支持的语法，就这些：**

| 写法 | 解析成 |
| --- | --- |
| `name: code-explorer` | 字符串 |
| `description: "带 \"引号\" 与 \n 转义"` | 字符串（双引号内识别 `\n` `\"` `\\`） |
| `tools: Glob, Grep, Read` | `['Glob','Grep','Read']`（逗号切分、trim、丢空项） |
| `tools: ["Read", "Grep"]` | `['Read','Grep']`（JSON 数组） |
| `# 注释`、空行 | 忽略 |
| `---` 结尾 | 正文开始 |

**不支持，遇到就抛：** 多行标量（`|` `>`）、嵌套映射、锚点/别名、单引号外的跨行续行、
重复键。**理由**：这些语法一个都不对应我们认识的字段；猜一个可能猜错的值，
比明说"这一行读不懂"坏得多。抛出的错误带上行号。

**没有 frontmatter 呢？** 对 `agents/*.md` 是**错误**（`name`/`description` 必填，
没有 `---` 就没有它们）；对技能同理。两类文件都必须有 frontmatter，
这与参考实现一致（那 15 个 agent 文件 15/15 都有）。

**`tools` 两种写法都要认** —— 参考笔记里实测两种各占一半（逗号串 3 个、JSON 数组 5 个），
而我们多半是照抄的。这是解析器里唯一一处"为了兼容参考实现而多做的"。

**但逗号切分不能长在 `parseFrontmatter` 里。** 它是个通用解析器，不知道哪个字段是列表；
而参考实现的 `description` 常含逗号（"review code for adherence to project guidelines,
style guides, and best practices"）—— 一刀切下去会把一句描述变成 `['…guidelines', 'style guides', …]`。

所以分工是：

- `parseFrontmatter` 只产出**标量**与**JSON 数组**（`[...]`）两种值。
- `readScalar(fm, key)` 取字符串；`readList(fm, key)` 取列表 —— **逗号切分在 `readList` 里**，
  由"我知道 `tools` 是个列表"的那一方负责。顺带也认 `[Read, Grep]` 这种没加引号的方括号写法
  （JSON.parse 失败就退回逗号切分，不报错）。

---

## 4. 发现与名册

### 4.1 三处根

| 来源 | agent | skill | 名字 |
| --- | --- | --- | --- |
| 项目级 | `<root>/.deepcode/agents/*.md` | `<root>/.deepcode/skills/<name>/SKILL.md` | 文件里写的 `name` |
| 用户级 | `~/.deepcode/agents/*.md` | `~/.deepcode/skills/<name>/SKILL.md` | 同上 |
| 插件级 | `<pluginDir>/agents/*.md` | `<pluginDir>/skills/<name>/SKILL.md` | `<插件名>:<name>` |

第三行是**补 P3 的窟窿**：P3 的清单校验器已经发现并校验了插件目录里的
`commands/ agents/ skills/`，但"只发现与校验，不加载"（P3 设计 §11 偏差 1）。本轮把它接上。

插件级名册跟着**装载结果**走，不跟着"目录在不在"走：只有 `discoverPlugins` 判为 `loaded`
的插件才贡献名册 —— 被 `plugins.deny` 关掉的、项目级没 enable 的、清单坏掉的，
它们的 agent 也不该出现。`installPlugins` 把 `DiscoveredPlugin[]` 拍扁成 `Plugin[]` 时丢掉了
`dir`，所以 `main.ts` 从 `discovery.loaded` 取 `{name, dir}` 交给两个发现函数
（**不给 `cliPlugins`** —— 它收到的是发现完之后的名册，见下）。

**发现是异步的，装配是同步的 —— 两者必须分开。** `discoverAgents` / `discoverSkills` 要
`readdir` / `readFile`，而 `cliPlugins()` 是同步函数（`cli/plugins.ts:60`）。
所以发现放在 `main.ts` 里（它已经在做插件的发现与装载），结果是两张**已经解析好的名册**
以参数进 `CliPluginDeps`，再交给 `createSubagentsPlugin`。
**不把异步塞进同步函数**，也不用"先建空对象、稍后填充"那类把时序问题藏起来的手法。

**项目级 agent/skill 不要求显式 `enable`**，与 P3 的插件相反。理由必须白纸黑字：
**插件 = 执行代码 = 需要同意；agent 文件与技能 = 文本 = 与这个仓库的 README、源码同级。**
而 `Read` 是无闸的，模型本来就能把仓库里任何文件读进上下文 ——
给文本加一道 `enable` 而放着 `Read` 敞着，是仪式不是防线。

### 4.2 同名与优先级

- 项目级 vs 用户级同名 → **项目级赢**（与 settings、插件同一个方向：`discoverPlugins`
  `plugin-dir.ts:102-112` 已经定了这个方向）。
- 插件级带命名空间前缀，**结构上撞不上**。
- 落选的那份**出声**（一条 warn，说清被谁顶掉了），不是静默丢弃 ——
  静默丢弃会让人对着一个改了半天没反应的 agent 文件发呆。

### 4.3 目录遍历复用，校验器不复用

`plugin-dir.ts:185` 的 `subdirectories()`（不存在 → 安静；在但读不了 → 吼一声，这一层全不装）
抽到 `src/cli/walkdir.ts`，三处共用。**不复用 `plugin-manifest.ts`** —— 那是 JSON 清单的校验器，
字段集与 frontmatter 完全不同；硬套会得到一个两边都不像的东西。

---

## 5. 子代理怎么跑

实现在新文件 `src/core/nouns/agent.ts`，`createAgentNoun(deps)`：

```ts
async spawn(req) {
  await dispatch('agent.spawn', { name: req.name, task: req.task, model: req.model }, CORE_ORIGIN);
  const messages: Message[] = [{ role: 'user', content: req.task }];
  let text = '';
  const stopReason = await runTurn(
    {
      $: deps.engine(),
      provider: deps.provider,
      signal: deps.signal(),
      dispatch: silent,          // §5.2
      systemPrompt: req.systemPrompt,
      turnIndex: 0,
      tools: new Set(req.tools),
      maxHops: req.maxHops,
      onText: (chunk) => { text = chunk; },   // §5.3：只要最后一段
    },
    messages,
  );
  return { text, stopReason };
}
```

`agent.spawn` 这一派**在开跑之前**，所以订阅它的插件（将来的 `SubagentStart` 桥、telemetry）
在子代理动手之前就看得见。它不带改写能力（§2.1 偏差 3），只报名字、任务与模型。

### 5.1 内层那五个参数

| 参数 | 值 | 为什么 |
| --- | --- | --- |
| `messages` | **全新数组，只有 `req.task` 一条** | 隔离。子代理看不到父级的对话历史。参考实现里 `feature-dev` 要求"子代理返回 5–10 个文件路径、父级再自己读"正是因为中间推理不回流 |
| `systemPrompt` | `req.systemPrompt`（**插件已经算好回落**） | spec 没写正文时回落到会话那份基础提示 —— 回落判断在插件里（§2.3） |
| `tools` | `new Set(req.tools)`（插件已经算好） | §6 |
| `maxHops` | `req.maxHops` | §2.4 |
| `signal` | `deps.signal()` **现取** | `CoreNounsDeps.signal` 的注释（`nouns/index.ts:15-23`）：一个 abort 过的 signal 再也回不去，构造时定死会让第一次 Ctrl-C 永久废掉会话 |
| `provider` | `deps.provider` | 同一个适配器 |
| `turnIndex` | `0` | 子代理自己那本账从 0 开始 |

`runTurn` 的 `provider.stream` 调用要带上 `model: req.model`（§2.5）。

### 5.2 静音：只吞 `turn.step`，其余照发

`streamPlugin` 是**拿自己的 `render` 闭包直接写屏幕**的（`cli/stream.ts`），不走 `$.ui` ——
所以"换一个安静的 `$`"这条思路根本拦不住它。唯一的闸是**事件派发**这一层：
名词把 `dispatch` 包一层，`turn.step` 不往下传。

```ts
const silent = <N extends EventName>(event: N, args: Args<N>, origin: Origin) =>
  event === 'turn.step'
    ? Promise.resolve({} as Result<N>)
    : dispatch(event, args, origin);
```

**只吞 `turn.step`，`tool.*` 与 `turn.start`/`turn.complete` 一律照发。**

- `tool.*` 必须照发：子代理改的文件**要进 `/diff`**，这是 `createChangesPlugin` 记的账。
  静音静的是**屏幕**，不是**事实**。
- `turn.start`/`turn.complete` 也必须照发：它们记录的是"这里真的跑过一次 turn"。
  吞掉会让观察者（将来的 telemetry、`session.measure`）少数一层。

**屏幕上仍然有痕迹**，否则一个跑两分钟的子代理看起来就是卡死：
`cli/subagents.ts` 在派之前 `$.ui.notice('派子代理 explorer（第 1 层）…')`，
回来之后 `notice('子代理 explorer 回来了（end_turn）')`。全量结果不回显
—— 它作为 `tool.call` 的结果回到父级上下文里，模型看得见就够了。

### 5.3 回传

**只有本次 turn 里模型最后一段文本。** `runTurn` 的返回值目前只有 `stopReason`，
所以 `LoopContext` 加了 §2.4 里那个 `onText` 回调：在 `loop.ts:111`（`assistantBlocks`
组装处）调一次，传进去的是**这一轮**模型说的话。子代理名词传一个只保留最后一份的收集器
（`(chunk) => { text = chunk; }`）—— 覆盖而不是累加，因为要的就是"最后一段"。
主循环不传它，一个字都不受影响。

**中间的工具结果一个字都不回流** —— 它们留在子代理自己那本 `messages` 里，随它一起丢掉。
这就是"隔离"的全部含义。

**子代理失败了怎么办？** provider 抛异常、撞 `max_hops`、被中断 —— 都**不是**让父级
整个 turn 炸掉，而是变成这次 `tool.call` 的**错误结果**回给父级：
父级应该知道"那个子代理失败了"并继续，而不是自己一起倒下。
`stopReason === 'error'` / `'interrupted'` / `'max_hops'` 时，结果文本前面加上
一句 `ERROR: 子代理 ${name} 未正常结束（${stopReason}）` —— `loop.ts:169` 那行
`content.startsWith('ERROR:')` 就把它标成 `isError`。

---

## 6. 工具白名单

### 6.1 三条规则（在插件里解析，内核只收结果）

> ⚠️ **P10 更正（2026-10-12）**：下面写的是 P4a 当时的实现。P10 把「这份面按什么算」从插件挪进了**内核**：
> 三条规则现在都跑在 `core/nouns/agent.ts` 里，`allow` 是**求交**（父面 ∩ 声明）而不是替换，
> 「省略 `tools`」继承的是**父级那一轮的面**（不是 `$.tool.list()` 那个会话注册面）。本节末尾那段
> 代码片段已经不在了 —— `resolveTools` 整个函数删掉。理由、实测数字与代价见
> `2026-10-12-deepcode-p10-design.md` §2.1 / §3.1–§3.3 / §5 偏差 1 与 8。
> 本节与 §6.5 的正文**按「不改历史」的惯例保持原样**，更正只写在这里。

1. **省略 `tools` ⇒ 继承父级全部工具**（`$.tool.list()`）。
2. **给出 `tools` ⇒ 白名单**，清单外的调不通。
3. **`disallowedTools` 在白名单之上再扣一层。**

解析就是一行减法，写在 `cli/subagents.ts` 里：

```ts
const inherited = spec.tools ?? $.tool.list();
const allowed = inherited.filter((t) => !spec.disallowedTools?.includes(t));
```

**"继承父级全部"在参考笔记里被标成风险较高的默认值**（启示 #3 建议改成默认最小集）。
我们照抄这个语义，理由不是"参考实现这么做"，而是**在我们的架构里"全权"指的是工具面、
不是免确认**：一个省略 `tools` 的子代理去写文件，照样要走同一条 `tool.check` 链 ——
`confirm` 在 `builtin`、个人规则在 `user`、守门器在 `prepend`，一个都不少。
这件事有一条出口标准专门钉它（§13 第 4 条），不是靠这句话说服人。

### 6.2 落点一：`describeTools` —— 看不见

`loop.ts:179`：

```ts
for (const name of ctx.$.tool.list()) {
  if (ctx.tools !== undefined && !ctx.tools.has(name)) {
    // 与 `hidden` 同一条：**安静**略去，一条 debug。
    // 这不是"没注册描述"（那是故障，要 warn），是"这个子代理不许用"。
    ctx.$.logger.debug(`工具 ${name} 不在本次的工具清单里，不进模型可见列表。`);
    continue;
  }
  // …既有逻辑
}
```

### 6.3 落点二：`runOneTool` —— 够不着

`loop.ts:141`，**在 `tool.check` 之前**：

```ts
if (ctx.tools !== undefined && !ctx.tools.has(use.name)) {
  return {
    toolUseId: use.id,
    content: `ERROR: 已拒绝 —— 工具 ${use.name} 不在本次的工具清单里（可用：${[...ctx.tools].join(', ')}）`,
    isError: true,
  };
}
```

### 6.4 为什么要两处

P3 的 `todo` 插件栽过一次：只做"看不见"不够，模型可以照样点名一个它没见过的工具，
插件也可以替你应答它。**看不见管的是模型那一侧，够不着管的是链那一侧。**
两个落点各自有一条反向验证钉着（§13 第 2 条）—— 任一条不红，就是那一处摆设。

### 6.5 白名单只做减法

> ⚠️ **P10 更正**：这句话在 P4a 当时**只到第一层**成立。「子代理走的是同一条链」是真的，
> 但「拿不到父级拿不到的东西」当时并**不**成立 —— 白名单是按**会话注册面**（`$.tool.list()`）算的，
> 于是嵌套一层就把被扣掉的面拿了回来（P10 设计 §2.1 探针 A 实测：外层看得见 2 个、内层 8 个）。
> P10 之后它才真的成立：面按**父级那一轮**算。下面这段正文保留原样。

**没有任何一条路径能通过子代理拿到父级拿不到的东西。** 这不是一条要人去守的规则，
是结构：子代理走的是同一条 `runTurn` → 同一条 `dispatch` → 同一条链。
子代理的 `tool.check` 与父级**是同一个函数调用**，只是 `ctx.tools` 更小。

反过来，子代理**更严**是被允许的：父子两个 spec 的白名单天然层层相交。

### 6.6 一处诚实的残余

子代理内部的 hook 拿到的 `$` 是**外层那个**（`dispatch.ts:92` 的 `deps.engine()`），
所以从 hook 里读 `$.tool.list()` 看到的仍然是会话的全部工具名。
**这不是一个漏洞**：hook 不能自己发起工具调用，循环是唯一的调用者，
而循环已经按 `ctx.tools` 拒过了。记进 §14，免得有人照着"hook 里看得见"推错结论。

### 6.7 `Task` 与 `Skill` 必须先被确认器认识 —— 否则它们一出生就是死的

**写实施计划逐行对照 `builtins/confirm.ts` 时发现的，是个真窟窿。**

`confirm` 坐 `builtin`，它的 `tool.check` **不带 matcher、不调 `next`**，而且：

```ts
if (!MUTATING_TOOLS.has(tool)) {
  // 不认识的工具：拒绝，不是放行。
  return { decision: 'deny', rule: `未知工具 ${tool}，不在确认器的白名单里` };
}
```

于是 `Task` 与 `Skill` 注册上来的**第一件事就是被 `confirm` 当"未知工具"拒掉** ——
`tool.describe` 一切正常、模型看得见它们、调了就吃一句 `ERROR: 已拒绝 —— 未知工具 Task`。

这是 P3 的 `todo` 插件踩过的同一个坑，它留下的注释（`plugins/todo/main.mjs`）写得很清楚：
插件工具要么**自己在 `builtin` 之外答一次 `tool.check`**，要么确认器得认识它。

`Task` / `Skill` 是第一方工具，所以走第二条路 —— 判定归 `confirm`（它是"哪些工具要问"这件事
的主人，六个 MVP 工具名本来就硬编码在它里面）。新增一类：

```ts
/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 不碰磁盘、不执行命令，但也不是"读一个文件"的：借道放行，不问。
 *
 * - `Skill`：把一段文本加载进上下文 —— 与 `Read` 同类。
 * - `Task`：派一个子代理。**放过它绝不等于免确认**：子代理内部每一次工具调用都要
 *   再走一遍这条链（`core/loop.ts` 是同一个 `runTurn`），它要写文件照样弹 y/N。
 *   在 `Task` 上再问一次只是让用户多按一次 y，还会误导出"我批准了 Task
 *   就是批准了它接下来做的一切"。
 */
const PASS_THROUGH_TOOLS = new Set(['Skill', 'Task']);

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);
```

**第三方的插件工具不走这条**：它们坐在 `append`（在 `builtin` 之外），自己答一次 `tool.check`
就结束了 —— 那条路 P3 已经建好并且有测试。这里只补第一方那两个。

---

## 7. 路由：`agent.offer` → system prompt

`cli/main.ts:243` 现在把 `SYSTEM_PROMPT` 与 `CLAUDE.md` 拼在一起。加第三步：

```ts
const offer = await dispatch('agent.offer', {}, CORE_ORIGIN);
const systemPrompt = [SYSTEM_PROMPT, instructions, renderOffer(offer)]
  .filter((s) => s !== '')
  .join('\n\n');
```

`renderOffer` 渲染两节：

```
可用子代理（用 Task 工具派发，subagent_type 填名字）：
- explorer: 深入探索代码库…（tools: Read, Glob, Grep）
- reviewer: 审查刚写完的代码…

可用技能（用 Skill 工具按名加载）：
- design-notes: 本项目的设计口径与写法约定…
```

**模型看到的是一行 `description`，不是文件** —— 与参考实现一致（`AgentOfferInput.description`
就是"该定义在模型代理列表中的那一行文本（whenToUse）"）。`tools` 一并印出来是**我们多加的**：
既然白名单是承重的东西，让用户与模型都看得见比藏起来好。

`agents` 与 `skills` 都空时**整节不打**（别给空白加标题）。

### 7.1 两个工具的入参

```ts
// Task
{ subagent_type: string; prompt: string; model?: string }
// Skill
{ name: string }
```

`prompt` 是派给子代理的**全部任务说明**（它没有别的上下文可看，§5.1）。
`subagent_type` 必须精确匹配名册里的名字，**不做前缀匹配、不做模糊匹配**；
对不上就 deny 并把可选名字列出来。空 `prompt` 拒绝（§11）。

### 7.2 路由是概率性的，出口标准必须承认这一点

参考实现的官方文档专门有一节教用户"怎么提高命中率"（`pr-review-toolkit/README.md:265-281`
的 "Agent Not Triggering"），等于官方承认软路由会误命中、会不命中。

所以出口标准拆成两条，只有前一条算数：

- **可验证的**：清单确实进了 system prompt；`Task` 确实能派到指定的 spec；
  `subagent_type` 不在名册里 → deny 且把可选名字列出来。
- **概率性的，只记执行记录**：真会话里说一句普通需求，看模型自己会不会选它。
  这条**不进出口标准** —— 把一个概率事件写成断言，只会得到一个偶尔红的测试。

---

## 8. 嵌套与深度

`Task` **就是一个工具**。子代理的白名单里写了 `Task` 它就能再派，没写就不能 ——
**深度不是一条单独的规则，是白名单的推论**（用户拍板：由白名单决定，不设独立机制）。

另加一个**硬上限 3**，超了 deny：

```ts
// 白名单能表达"允许不允许"，表达不了"允许几次"。
// 一次失控的递归要花真钱 —— 这不是策略，是保险丝。
const MAX_DEPTH = 3;  // 顶层 Task 的 depth = 1
```

深度由 `cli/subagents.ts` 的**闭包栈**维护（不是模块级变量：模块级的会跨测试泄漏）：

```ts
const stack: string[] = [];  // 只用来在错误消息里说清是"谁派的谁"
```

派之前 `stack.push(spec.name)`、`finally` 里 `pop()`。因为工具是**串行**执行的
（`loop.ts:118`），这个栈不会交错。

`tools: []` 的 agent 连 `Task` 都没有 → **递归从结构上断掉**，不靠规则。
这是 §13 第 5 条要钉的性质。

---

## 9. 模型分层

解析顺序：`Task` 调用的 `model` 参数 → spec 自带的 `model` → 父级会话的 model。

```ts
const model = callModel ?? (spec.model === 'inherit' ? undefined : spec.model);
```

`undefined` 一路传到 `StreamRequest.model` 的省略 → 适配器用 `config.model` → 就是父级那份。
**`inherit` 是缺省**（参考实现 15 个 agent 里 8 个写 `inherit`）。

别名不翻译：`haiku` / `sonnet` / `opus` 原样发给适配器。我们不知道用户配的端点认不认这些别名 ——
`providers/http.ts:2` 已经有一条 `MODEL_HINT_RE`，模型 id 不存在时会给一句人话的提示，
那已经是最好的处理方式了：**不猜、不映射、把端点的话原样转达。**

---

## 10. 技能

### 10.1 三层披露：第三层我们一行代码都不写

| 层 | 谁负责 | 我们做什么 |
| --- | --- | --- |
| 元数据（`name` + 一行 `description`，常驻） | 内核 | 经 `agent.offer` 进 system prompt（§7），与 agent 清单同一处 |
| 正文（`SKILL.md` body，命中才进上下文） | 内核 | 一个 `Skill` 工具，参数 `{ name }`，正文作为工具结果返回 |
| 捆绑资源（`references/` `examples/` `scripts/`） | **模型 + 已有的 `Read` / `Bash`** | **零代码** |

第三层是白送的。参考笔记里那句"scripts 可以不读进上下文直接执行，所以预算是无限的"
在我们这儿就等于：模型用 `Read` 读 `<skillDir>/references/x.md`，或者用 `Bash` 跑它。
**不发明资源引用语法，不发明 `@path` 插值，不做 `skill.prompt` 之外的任何机制。**

唯一加的一根保险丝：装载时 `description` 超过 **500 字符** → 截断 + warn。
500 是参考实现给的 description 规范上限，不是我们拍的数。

**不设技能条数上限。** 参考实现有个 token 预算字段（`ContextSkills.includedSkills`），
但那个类型只暴露计数、不暴露阈值 —— 我们既没有测量手段也没有一个真实数字，
拍一个数比不拍更坏。

### 10.2 `Skill` 工具

`{ name: string }` → 该技能的正文。**点名不存在的技能 → deny，并把可用技能名列出来**
（不静默失败、不猜、不做前缀匹配）。

工具描述是**静态的**（"按名字把一个技能的知识正文加载进当前上下文；可用技能见系统提示词里的清单"）
—— 清单只在 system prompt 里印一次，不重复第二份（§7 的同一个道理）。

技能**不带工具白名单**。技能是注入**当前**上下文的文本，而当前上下文的工具就是会话的工具；
"只在读这个技能时限制工具"没有作用域可言。子代理那边有白名单，是另一码事
（参考笔记里 skill 级 `allowed-tools` 在一整个仓库的 SKILL.md 里都找不到，无法证实，
不做一个连参考实现都没证据的字段）。

### 10.3 `skill.prompt` 是变换缝，不是闸

`Skill` 工具读到正文后派 `skill.prompt`（`{name, text}`），谁想改就返回 `{text}`；
**链尾无人应答 = 原文通过**（§2.1 的 coreImpl）。

这段话必须原样留在文档里，因为这个仓库反复强调 fail-closed，将来一定会有人想把
"链尾无人应答"统一成 deny：

> **fail-closed 是权威事件的性质** —— `tool.check`、`plugin.register` 说的是"没人批准就不能做"。
> **`skill.prompt` 是变换缝** —— 它问的是"有没有人想把这段文本改一下"，
> 缝尾没人应答的含义是"没人要改"，而默认值就是文件自己那份原文。
> 在这儿 deny 会让一个没被任何插件碰过的技能彻底不可用。

同理，`Skill` 点名不存在的技能、`Task` 点名不存在的 agent，这两条**是**权威判定
（"能不能加载这个东西"），跟 `skill.prompt` 不是一类。

### 10.4 与斜杠命令的关系：本轮**不合并**

参考实现里 `/name`、`Skill` 工具、子代理预加载走的是同一条 `skill.prompt` 通道
（"Typed as `/name`, called through the Skill tool, or preloaded into a subagent: the same event at each"）。
我们只借这一点：`skill.prompt` 是技能展开成文本那一刻的缝。

但 **`commands/*.md` 那套模板加载器不做**。它自带至少七种插值语法
（`$ARGUMENTS`、`$1..$n`、`@path`、`` !`cmd` ``、`` ```! `` 围栏、`${PLUGIN_ROOT}`、`argument-hint` 一致性校验），
而参考笔记里连"参数含空格怎么切分"都标着"复刻时需自行定义"。那是一个独立工作面，
不是 P4a 的附赠品。我们现有五个斜杠命令继续是第一方插件里的硬编码 handler，
`$.command.list()` 继续从 `command.run` 的 matcher 取值。

---

## 11. 失败行为表

| 情形 | 方向 | 依据 |
| --- | --- | --- |
| agent / skill 文件 frontmatter 坏 | **整个文件不装 + warn** | 与 `plugin-dir` 同一条：没有半个 agent |
| 文件里有不认识的字段 | warn + 忽略（装载时一次） | §2.2 |
| frontmatter 用了不支持的语法 | 报错（带行号）、该文件不装 | §3，不猜 |
| `agents/`、`skills/` 目录不存在 | **安静**（常态） | 同 `plugin-dir:194` |
| 目录在但读不了 | warn，这一层一个都不装 | 同 `plugin-dir:196` |
| 项目级 / 用户级同名 | 项目级赢，落选那份出声 | §4.2 |
| `Task` 的 `subagent_type` 不在名册 | deny + 列出可选名 | 不静默、不猜 |
| `Task` 的 `prompt` 是空串 | deny | 派一个没任务的子代理没有意义 |
| 嵌套深度 > 3 | deny | §8，保险丝 |
| 子代理内的工具越界 | 循环层拒（`runOneTool`） | §6.3 |
| 子代理的 provider 抛异常 | 变成本次 `tool.call` 的**错误结果**回父级 | §5.3 |
| 子代理撞 `max_hops` / 被中断 | 同上，理由里点明 | §5.3 |
| `Skill` 点名不存在的技能 | deny + 列出可用名 | §10.2 |
| `skill.prompt` 链尾无人应答 | **原文通过** | §10.3，变换缝不是闸 |
| `agent.offer` 链尾无人应答 | `{agents: [], skills: []}` | §2.1，能力方向的 fail-closed |

---

## 12. 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/contract/events.ts` | 改 | 三个事件转正；`agent.spawn` 进 `NOTIFICATION_EVENTS` |
| `src/contract/agent.ts` | **新** | `AgentSpec` / `SkillSpec` / `AgentSpawnRequest` / `AgentSpawnResult`（type-only，零 import） |
| `src/contract/frontmatter.ts` | **新** | `parseFrontmatter`（纯函数，零 IO） |
| `src/contract/engine.ts` | 改 | `AgentNoun`；`CoreEngineInterface` 加 `agent` |
| `src/contract/model-provider.ts` | 改 | `StreamRequest.model?` |
| `src/core/loop.ts` | 改 | `LoopContext.tools?` / `maxHops?` / `onText?`；两个落点；`max_hops` |
| `src/core/nouns/agent.ts` | **新** | `createAgentNoun`：内层 `runTurn` + 静音包装 |
| `src/core/nouns/skill.ts` | **新** | `createSkillNoun`：把正文过一遍 `skill.prompt` |
| `src/core/nouns/index.ts` | 改 | 装配 `agent` / `skill` 两个名词；多一个 `refs` 参数（`engine` / `dispatch` 的延迟取） |
| `src/core/create.ts` | 改 | 两个延迟取的接线；两条 coreImpl（`agent.offer` / `skill.prompt` 的默认答复） |
| `src/builtins/confirm.ts` | 改 | 新增「借道放行」一类：`Task` / `Skill`（§6.7） |
| `src/providers/anthropic.ts` | 改 | `model: req.model ?? config.model` |
| `src/providers/openai.ts` | 改 | 同上 |
| `src/cli/walkdir.ts` | **新** | 从 `plugin-dir.ts` 抽出的目录遍历（三处共用） |
| `src/cli/plugin-dir.ts` | 改 | 改用 `walkdir.ts` |
| `src/cli/agents.ts` | **新** | agent 名册：**异步**发现（§4.1）、解析成 `AgentSpec`、白名单解析 |
| `src/cli/skills.ts` | **新** | 技能名册：**异步**发现、解析成 `SkillSpec` |
| `src/cli/subagents.ts` | **新** | 第一方插件：应答 `agent.offer`、注册 `Task` 与 `Skill`、深度栈、屏幕通知 |
| `src/cli/plugins.ts` | 改 | 装 `subagents` 插件；deps 加 `agents` / `skills` 两张**已解析**的名册（同步收，发现已在 main 里做完） |
| `src/cli/main.ts` | 改 | 异步发现 agent/skill 名册并传给 `cliPlugins`；system prompt 多拼一节 `agent.offer` |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 改 | 计数 12 → 15；插件一节补 agent/skill 约定目录 |

`contract/` 的依赖边界不破：`agent.ts` 与 `frontmatter.ts` 都**零 import**。
`check-boundaries.mjs` 的五行规则一行都不改。

---

## 13. 验收标准

任务级只跑 `pnpm typecheck`，测试按 C1/C2/C3 三个检查点批量跑（用户长期指令）。

### C1：契约与解析

1. `parseFrontmatter` 的 fixture 组：裸标量、带转义的双引号、逗号串 `tools`、
   JSON 数组 `tools`、注释、无 frontmatter（agent → 报错）、多行标量（报错且带行号）、
   重复键（报错）。
2. `agent.offer` 默认答复是空清单（不接插件的裸引擎）。
3. `skill.prompt` 默认答复是原文（同上）。
4. `StreamRequest.model` 省略时两个适配器都用 `config.model`；给了就用给的。
   —— 断言方式：假 provider 记录收到的请求，**不需要真网络**。

### C2：子代理

5. 造一个 `tools: [Read, Glob, Grep]` 的 agent，脚本化 provider 下：
   - 它看到的工具表**恰好**是三个（`tool.describe` 的派发次数也恰好三次）；
   - 它试图 `Write`，结果 `isError`，理由里带"不在本次的工具清单里"。
6. **两条反向验证**（本仓库的规矩：把实现改坏，确认断言真的会红）：
   - 删掉 `describeTools` 那处过滤 → 第 5 条前半句红；
   - 删掉 `runOneTool` 那处判断 → 第 5 条后半句红。
   **任一条不红，就说明那一处是摆设，要修的是断言本身。**
7. **隔离**：子代理 `Read` 了一个内容已知的文件，父级收到的 `tool.call` 结果里
   **不含**那个文件的内容，只含子代理最后那段文本。
8. **静音**：注入一个假 renderer，断言内层的 `turn.step` **没有**写到它上面；
   同时断言内层的 `tool.call` **有**派发（`/diff` 的账不能丢）。
9. **`tools: []` 的 agent 连 `Task` 都没有** → 递归从结构上断掉（不是靠深度规则）。
10. **深度**：3 层过，第 4 层 deny。
11. **不越权的正面证明**：一个 `tools` 省略（= 全权）的子代理发起一次写操作，
    `confirm` 仍然弹出 `ask` —— **"全权"指工具面，不是免确认**。
12. **模型分层**：`model: haiku` 的 agent 派出去时，假 provider 记录到的 `req.model === 'haiku'`；
   写 `inherit` 或省略时是 `undefined`。
13. **失败不炸父级**：让子代理的 provider 抛异常，断言父级拿到的是错误结果、且父级 turn 继续。

### C3：技能与收口

14. `skills/x/SKILL.md` 的 name + description 出现在 system prompt 里。
15. `Skill` 工具拿回正文；点名不存在的技能 → deny 且列出可用名。
16. 一个测试插件经 `skill.prompt` 改写正文，断言模型收到的是改写后的。
17. **第三层没代码**：`references/` 下的文件通过普通 `Read` 读到 —— 一条端到端，
    证明"我们没为第三层写东西"这句话是真的。
18. 反向验证：把 `skill.prompt` 的 coreImpl 改成 `throw` → 第 16 条里**没装改写插件**的那一路红
    （证明默认答复确实承重）。
19. `pnpm typecheck && pnpm lint && pnpm test` 全绿；
    `README.md` / `docs/项目简介.md` / `site/index.html` 三处计数同步（12 → 15 实现数、用例数）。
20. **一条只记执行记录、不进出口标准的**：真会话里说一句普通需求，看模型会不会自己派 agent。
    概率性事件不写成断言。

---

## 14. 已知偏差与存疑

### 计划期纠正（写实施计划时逐行对照源码，发现设计稿有错，改的是设计稿本身）

1. **`Task` 与 `Skill` 会被 `confirm` 当"未知工具"拒掉** —— 设计稿原先只字未提。
   `builtins/confirm.ts` 对不在两张表里的工具一律 `deny`，所以两个新工具**一出生就是死的**。
   改法见新的 §6.7（`confirm` 新增「借道放行」一类）。
2. **`skill.prompt` 没人派得动** —— 插件拿不到 `dispatch`，所以"派一次让别的插件改写"
   这件事插件自己做不了。设计稿原先写的是 `Skill` 工具直接派，那是做不到的。
   改成多一个 `$.skill.load` 名词（§2.3）。
3. **`LoopContext` 是三个可选字段，不是两个**（`model` 与 `onText` 上一版都漏在字段清单外）——
   `loop.ts:54` 直接调 `ctx.provider.stream(...)`，不经过 `$.model.stream`，
   所以 `model` 只能从 ctx 走。改的是 §2.4。
4. **`agent.offer` 的 agent 条目要带 `tools`** —— 设计稿 §7 的渲染样张里印了工具清单，
   而 §2.1 的结果类型里没有这个字段，两处对不上。按 §7 的样张补上（§2.1）。
5. **`SkillSpec` 要带 `dir`** —— 第三层披露是"模型自己用 `Read` 去读 `references/`"，
   而模型得先知道那个目录在哪。补进 §2.2。
6. **逗号切分不能放在通用 frontmatter 解析器里** —— 参考实现里的 `description` 常含逗号
   （"…guidelines, style guides, and best practices"），一刀切下去会把一句描述切成数组。
   解析器只认标量与 JSON 数组，**逗号串由"取列表字段"的那个读取器负责**（§3 末）。

### 偏差（与参考实现或与本项目既有约定不一致）

1. **`agent.offer` 一次问链拿整张表**，参考实现是每个候选调一次。理由见 §2.1。
2. **`agent.offer` 顺带报技能清单**，没有 `skill.offer`。理由见 §2.1（不新增第 40 个事件）。
3. **`agent.spawn` 只通知，不可改写**，参考实现允许 hook 改写 prompt/model/cwd。理由见 §2.1。
4. **`Task` 不吃 `description` 参数**。参考实现的 `AgentSpawnInput` 有它（一个短标签，给 UI 用）。
   我们用 agent 的名字当标签就够了。
5. **`AgentSpec` 只收 7 个字段**，参考实现 17 个。逐条理由在 §2.2。
6. **省略 `tools` = 全权**沿用参考实现，而参考笔记的启示 #3 建议改成默认最小集。
   我们照抄的理由是"全权指工具面、不指免确认"，且有一条出口标准钉它（§13 第 11 条）。
   **存疑**：如果将来真出现"子代理能做的事比父级预想的多"这类抱怨，就要回头把这个默认值翻过来。
7. **子代理内部的 hook 读到的 `$.tool.list()` 仍是会话全部工具**（§6.6）。
   不是漏洞（hook 不能发起工具调用），但会让"看得见"与"够得着"在一个地方不一致。
8. **`agent.offer` 由 `cli/main.ts` 派一次**，不在 `createEngine` 里自动派。
   所以"提示词里没有 agent 清单"这件事只可能发生在**绕开 main.ts 直接建引擎**的场合（测试与将来的 SDK）。

### 存疑（本设计拍板，但上位文档说不清）

9. **技能的 `version` / `license` 字段解析了但不使用。** 解析是为了"认识的字段就静静收下、
   别掉进"不认识"那条 warn"；不使用是因为没有任何东西消费它们。
10. **`MAX_DEPTH = 3`** 是拍的。它是个保险丝而不是策略，所以拍一个偏小的值是对的；
    但它不是从任何原则推出来的。
11. **`agent.offer` 的 `Record<string, never>` 参数**：参考实现的 `AgentOfferInput` 带了
    上下文（cwd 等）。我们不给，是因为应答方（第一方插件）手里已经有 `$`。
    如果将来出现一个第三方插件想按 cwd 过滤 agent 清单，就要给这个事件加参数。

---

## 15. 明确不做（YAGNI）

逐条给理由，不写"以后再说"：

| 不做 | 为什么 |
| --- | --- |
| `commands/*.md` 模板加载器 + 七种插值 | 独立工作面，参考笔记里连参数切分规则都标着"需自行定义"（§10.4） |
| 技能预加载进子代理（`AgentSpec.skills`） | 子代理要用 `Skill` 工具，把 `Skill` 列进白名单就行 |
| 具名子代理的 `/agents` 命令 | 名册已经在 system prompt 里印出来了，再加一个只读命令是重复 |
| `$.agent.list()` / `$.agent.register()` | 参考实现有，但它服务的是"运行时注册"这个第三方场景；我们的名册是文件驱动的，插件要用 `engine.create` hook 贡献名词的能力 P4a 还不开放（见下条） |
| 第三方插件扩展 `$`（P3 遗留） | `agent`/`skill` 是内核提供的**第一方**名词，与"让别人往 `$` 上挂东西"不是一回事。P3 设计 §4.5 已经把它排在 P4，本轮仍不做 |
| classic hooks 的 `SubagentStart`/`SubagentStop` 桥 | P3 把它们列在契约里但没桥（`classic.ts:64` 注释说推到 P4）。它们要靠 `agent.spawn` 这个通知事件才立得住，**而本轮刚把它变成通知事件** —— 桥本身很小，但它是另一条工作面（classic hooks 那一侧），放进 P4b |
| Bash 沙箱 / 上下文压缩 / marketplace / hookify DSL / 多 surface / telemetry / CI | 见 §17 |
| 并行派子代理 | 我们整条链是串行的（`loop.ts:118` 的注释：并行 Bash 的交错输出对用户没有好处）。并行要重做工具的调度与结果汇总，是另一个工作面 |
| 子代理的 worktree / remote 隔离 | 都没有对应实现，且我们**故意没有路径围栏**（MVP 决策） |

---

## 16. 关键文件索引（实现时对照）

- 事件目录与通知事件：`src/contract/events.ts:9-52`（`EventArgs`）、`:99-118`（`UnimplementedEvent`）、
  `:156-162`（`NOTIFICATION_EVENTS`）
- 链尾兜底：`src/core/dispatch.ts:77-83`（`isNotificationEvent` → `{}`；否则 coreImpls；
  否则 `NotImplementedError`）
- 懒取 `$` 的先例：`src/core/dispatch.ts:19`；懒取 signal 的先例：`src/core/nouns/index.ts:15-23`
- coreImpls 表：`src/core/create.ts:44-71`
- 折叠与注册：`src/core/create.ts:73-125`
- `LoopContext` / `runTurn` / `runOneTool` / `describeTools`：`src/core/loop.ts:15-22,31,137,177`
- 工具清单的来源（不是硬编码表）：`src/core/nouns/index.ts:39`
- system prompt 拼装：`src/cli/main.ts:242-243`
- 屏幕出口（静音要绕开的那一处）：`src/cli/stream.ts`
- 目录遍历（要抽出去的）：`src/cli/plugin-dir.ts:185-201`
- 项目级 vs 用户级的优先级先例：`src/cli/plugin-dir.ts:102-112`
- 参考实现笔记：`docs/claude-code-架构分析/08-agents-and-skills.md`
  （frontmatter schema `:71-146`、路由 `:160-174`、白名单三条 `:176-197`、
  模型解析 `:199-211`、技能 schema `:213-255`、三层披露 `:257-297`、存疑 `:580-601`）

---

## 17. P4 余下的部分与 P5 边界

P4 那一列在 MVP §9.2 里横跨十一个工作面，一份 spec 与一个计划装不下。
本轮（P4a）吃的是**组合面 + 技能**。余下的按依赖关系分组，每一组各自走
brainstorm → spec → plan：

| 组 | 内容 | 为什么不在本轮 |
| --- | --- | --- |
| **P4b 上下文与执行边界** | `session.compact`（触发阈值与压缩策略要自行设计，参考笔记明说"引擎内部不可见"）、Bash 沙箱（只在 `process` 名词这一层）、`AGENTS.md` 的嵌套加载 | 三样都改的是**既有事件的实现**而不是加扩展点，与组合面没有共享代码 |
| **P4c 分发与治理** | marketplace（`.deepcode-plugin/marketplace.json`）、hookify DSL、`config.*` 与 `command.describe` | 都是扩展面的**外围**，依赖 P3 的插件目录已经稳定（它稳定了） |
| **P4d 可观测与多 surface** | `mod-telemetry`、`ui.render` 的 `RenderNode`、`session.attach/detach/receive/measure`、`prompt.*` 一族 | 参考笔记里 `ui.render` 现在只是"暂定形状"，真接上时要重画 |
| **P4e 工程化** | CI（GitHub Actions）、`check-boundaries` 扩到 `plugins/`、发布流程 | 与功能无关，可以任何时候插队 |
| **P4f? 遗留的第三方 `$` 扩展** | 两段式注册：让第三方插件也能往 `$` 上挂名词 | 它是**加权威**的动作，与 P3 的"第三方只能更严"正面冲突，要单独想清楚 |

**P5 内建与分发**（MVP §9.2 的最后一段）不在以上任何一组的范围内，
它在 P4 全部收口之后才谈 —— 因为"内建"这个词的边界取决于扩展面最终长什么样。
