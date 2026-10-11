# DeepCode —— P3 扩展面设计（插件目录与 classic hooks）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 同体例的先例是 [`2026-10-11-deepcode-p2-design.md`](2026-10-11-deepcode-p2-design.md)。
> 阶段顺序的三条硬约束见 MVP §9.1 —— P2 已在 P3 之前完成，本轮吃的是它的两个交付物：
> `settings` 的来源优先级，与「deny 携带规则名」。

**一句话**：让一个**掉进目录**的东西能扩展出新的用户能力，同时不能因此放宽一行权限。

---

## 0. 决策摘要

1. **P3 只做扩展面的承重部分**：插件清单格式 + 目录发现 + `plugin validate` + `plugin.register` 准入闸门
   + classic hooks 桥 + 两个实物示例插件。MCP 桥接、`ui.render`、workspaces 拆分**不做**，逐条记在 §11。
2. **第三方插件一律坐 `append`**，即个人规则（`user`）之内、内建（`builtin`）之外。这个位置不是挑的，是推出来的（§6）。
3. **「只能更严」由包装保证，不靠自觉**：第三方插件 hook 返回的 `{decision:'allow'}` 被换成 `next(e)`（§4.4）。
4. **`plugin.register` 第一次真正被用上**：第一方 `plugin-guard` 持有五层合并后的 `plugins.deny`，
   命中就 `refuse`。缺了它，`plugin.register` 自 MVP 起就是个空壳。
5. **classic hooks 只桥 3 个事件**（`PreToolUse` / `SessionStart` / `SessionEnd`），
   其余 30 个声明在契约里、加载时点名警告「本版本不跑」。
6. **不新增引擎事件**。`PreToolUse` 落在已有的 `tool.check` 上 —— 出口标准第三条（exit 2 阻断）
   靠 `loop.ts:148` 那行现成的 `ERROR: 已拒绝 —— ${rule}` 回喂模型实现。
7. **准入管的是链上的权威，不是代码能不能跑**：导入 entry 模块就是在执行它。装插件 = 信任它，
   与 Claude Code 一样；差别在于我们从第一天就把这件事写进文档、并让 `validate` 把要跑的命令原样列出来。

---

## 1. 三条出口标准怎么落

| 出口标准（MVP §9.3） | 落点 | 怎么验 |
| --- | --- | --- |
| 一个**不改引擎**的插件能扩展出新的用户能力 | `plugins/secret-guard/`（classic hook）与 `plugins/todo/`（entry 模块加一个新工具）。两条扩展路径各证一遍 | `src/` 里 grep 不到这两个名字（一条测试断言）；装上后 `$.tool.list()` 里出现 `TodoWrite`，模型能调它 |
| `deepcode plugin validate <dir>` 能拦住坏清单 | `src/contract/plugin-manifest.ts` 一份**纯函数**校验（零 IO），validate 与加载器**共用同一份实现** | 一组坏清单 fixture 逐条断言：报错点名 + 退出码 1 |
| classic hook 的 exit 2 能真正阻断工具调用 | `PreToolUse` → `tool.check`；exit 2 的 stderr 落进 `rule`，`loop.ts:147` 把它变成 `ERROR: 已拒绝 —— …` 回喂模型 | 让 `secret-guard` 拦下一次写 `.env`，断言模型收到的 tool_result 是错误且带 hook 的理由 |

**验收方式沿用 P2 的体例**：任务级只跑 `pnpm typecheck`，测试按 C1/C2/C3 三个检查点批量跑。
出口标准三条各留一条可复现的手工路径（§10）。

---

## 2. 插件目录与清单

```
<plugins-root>/<name>/
  plugin.json          ← 清单。在插件**根**，不是 .deepcode-plugin/ 子目录（§11 偏差 6）
  main.mjs|main.js|main.ts   ← 可选。入口模块
  hooks/hooks.json     ← 可选。classic hooks
  commands/ agents/ skills/ .mcp.json   ← 可选。P3 只发现与校验，不加载（§11 偏差 1）
```

### 2.1 `plugin.json`

```json
{
  "name": "secret-guard",
  "version": "0.1.0",
  "description": "拦住把密钥写进仓库",
  "author": { "name": "yqz" },
  "homepage": "https://github.com/yyyCode/DeepCode",
  "entry": "./main.mjs",
  "hooks": "./hooks/hooks.json",
  "uses": ["tool.check"]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | **是** | kebab-case，正则 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，≤64 |
| `version` | string | 否 | semver |
| `description` | string | 否 | 建议 50–200 字 |
| `author` | object \| string | 否 | `{name,email,url}` |
| `homepage` | string | 否 | 只做展示 |
| `entry` | string | 否 | 入口模块。**不声明就探测** `./main.mjs`/`./main.js`/`./main.ts`，一个都没有就是"没有入口"，不算错误；声明了却不存在则是 E8 |
| `hooks` | string | 否 | 默认 `./hooks/hooks.json`（存在就用） |
| `uses` | string[] | 否 | **声明的扩展面**（事件名）。缺省 `[]` = 什么都不许注册 |
| `commands`/`agents`/`skills`/`mcpServers` | string \| string[] | 否 | P3 只校验存在性 |

路径字段（`entry`/`hooks`/`commands`/`agents`/`skills`/`mcpServers`）一律：
**相对路径、以 `./` 开头、不含 `..`、不含反斜杠**。四条缺一不可 —— `..` 是唯一能让清单逃出插件目录的写法。

**未知顶层字段是警告，不是错误**：清单比引擎活得久，一个只在 P4 有意义的字段不该让插件装不上。

### 2.2 入口模块的契约

```js
// plugins/todo/main.mjs
export default {
  register(on) {
    on('tool.describe', { tool: 'TodoWrite' }, () => ({ description: '…', inputSchema: {…} }));
    on('tool.check',    { tool: 'TodoWrite' }, () => ({ decision: 'ask', rule: '插件工具：TodoWrite' }));
    on('tool.call',     { tool: 'TodoWrite' }, async ($, e) => ({ value: '…' }));
  },
};
```

- 只导出 `register(on)`。**`name` 与 `uses` 以清单为准**：entry 里写了别的 `name` 会被覆盖并警告一行。
  理由：准入闸门与 deny 名单按名字索引，名字不能由被审对象自述。
- 模块形态不限，`import(pathToFileURL(entry))` 能拿到 `default.register` 即可（`.mjs`/`.js`/`.ts` 都行；
  `.ts` 能跑是因为 `bin/deepcode.mjs` 一律经 tsx 起进程）。

### 2.3 校验规则全集（`plugin validate` 的判定清单）

两级：**E 级是错误（有任何一条 → 退出码 1），W 级是警告（退出码 0）**。
E 级是"装不上"，W 级是"能装，但照这么写会不work 或本版本不认" —— 两者的区别必须一眼看得出来。

| 编号 | 规则 |
| --- | --- |
| E1 | 目录存在、是个目录 |
| E2 | `plugin.json` 存在、能 parse 成对象 |
| E3 | `name` 存在、是 string、匹配 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`、长度 ≤64 |
| E4 | `version` 若存在，匹配 `^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$` |
| E5 | `description`/`homepage` 是 string；`author` 是 string 或对象 |
| E6 | 路径字段是 string 或 string[]；每个值相对、以 `./` 开头、无 `..`、无反斜杠 |
| E7 | `uses` 是 string 数组 |
| E8 | 声明的每个路径都存在 |
| E9 | `hooks.json` 能 parse 成对象 |
| E10 | `hooks.json` 每个事件名都在 33 个 classic 事件的白名单里 |
| E11 | 每个 matcher 组是 `{matcher?, hooks:[…]}`，`hooks` 是非空数组 |
| E12 | `HookDef.type === 'command'`（`'prompt'` 是 W12） |
| E13 | `HookDef.command` 是非空 string |
| E14 | `HookDef.timeout` 若存在，是 1..300 的整数 |
| W1 | 未识别的顶层字段（点名） |
| W2 | 未识别的 `HookDef` 字段（点名，例如 `if`/`asyncRewake`/`rewakeMessage`/`rewakeSummary`） |
| W3 | 声明了 30 个未桥接事件中的任意一个 → 点名「本版本不跑这个事件」 |
| W4 | `HookDef.type === 'prompt'` → 「本版本只支持 command 型钩子」 |
| W5 | matcher 是正则形态 → 「正则 matcher 不支持，这条 matcher 组会被跳过」（**跳**，不是放大，见 §5.3） |
| W6 | `uses` 里有 `tool.describe` 但没有 `tool.call` —— 描述了一个不会执行的东西 |
| W7 | `uses` 里有 `tool.call` 但没有 `tool.check` —— 「这个工具会被 confirm 当未知工具拒掉」 |
| W8 | 目录里有 `commands/`/`agents/`/`skills/`/`.mcp.json` 而清单没声明，或声明了但 P3 不加载 |
| W9 | 既没有入口、也没有钩子 —— 这个插件装上了什么都不做 |

W6/W7 是这条校验里唯一带**意图**的两条：它们不查格式，查的是"照这么写会不work"。

---

## 3. 发现与启用

| 来源 | 路径 | 加载条件 |
| --- | --- | --- |
| 用户级 | `~/.deepcode/plugins/<name>/` | **自动加载** —— 是你自己装的 |
| 项目级 | `<项目根>/.deepcode/plugins/<name>/` | **必须**在该项目的 settings 里列名 |

这一条不对称是刻意的：项目级自动加载意味着 `git clone` 一个陌生仓库再跑 `deepcode`，
就执行了那个仓库的插件代码。用户级那份是你自己放进主目录的，性质不同。

启用写在 settings 里（与权限规则同一套五层来源）：

```json
{ "plugins": { "enable": ["todo"], "deny": ["evil"] } }
```

- `enable` 取 **project / local / flag** 三源（user 级无意义 —— 用户级本来自动加载；在 user 级写 enable 会警告）
- `deny` 取**任何**来源，任一来源 deny 即禁。顺带给了「某个项目禁掉一个用户级插件」的出口，不需要另造机制
- 同名：项目级**已启用**则项目目录那份生效（并警告一行「同名，项目级覆盖用户级」）；项目级没启用则用户级那份生效
- 扫描顺序按名字字典序，保证确定性

**加载期任何一处失败 = 整个插件不装**，警告里点名是哪里坏。不做"半装"：
P1 已经吃过一次半装的亏（清单里少一个插件、`typecheck` 全绿、产品一开口就崩），
而半装的插件是同一个失败模式的复发。

---

## 4. 准入闸门

### 4.1 `plugin.register` 从空壳变成闸门

`core/create.ts:41` 今天是 `() => ({ allow: true })`。P3 不动这行（内核仍然全放行），
而是新增一个第一方插件 `plugin-guard` 坐 `prepend`，**持有五层合并后的 `plugins.deny` 并集**，答 `plugin.register`：

```
命中 deny → { refuse: `插件 ${name} 被禁用（规则来自 ${来源文件}）` }
否则      → next(e)          // 没有意见，落到 core 的 allow
```

**为什么这里取并集，而权限规则那侧要分来源优先级**：`deny` 的效力上限是"禁用"，它**不可能放宽任何东西**。
所以"哪一层写的"只影响报错时点名谁，不影响该不该生效 —— 任一来源 deny 即禁，是安全的、
也顺带给了「某个项目禁掉一个用户级插件」的出口，不必另造机制。需要来源优先级的永远是
`allow` 那一侧（谁能放宽），而插件的启用面里 `enable` 走的是 §3 的 loader 过滤，不经过这条链。

这正好接上 MVP §9.1 那句「没有 `settings.read` 的来源优先级，`plugin.register` 准入闸门没有判定依据」——
判定依据就是 settings，而 settings 的多来源解析是 P2 交的。

**第一方插件的名字出现在 deny 列表里 → 启动期警告 + 忽略。** 理由是这条不变量：
托管策略是给「掉进目录的东西」设的闸，不该变成一个拆自己承重墙的开关 ——
一条 `deny: ["sec-default"]` 就能让守门器不装，那是把安全交付物做成了自杀开关。
这种情况是配置错误，警告点名，然后照装。

### 4.2 座位一律 `append`

第三方插件（发现的那些）座位恒为 `append`。**清单里没有 tier 字段** —— 沿用 P2 §2.2
「座位由 CLI 钉，不由插件自述」：插件连"我想坐哪儿"都无处表达。

这一层在 P2 是留空的，位置见 §6 的推导。

### 4.3 `uses` 覆盖检查：越界即整体拒绝

给第三方插件的 `on` 会逐条检查：注册的 `pattern` 必须被 `uses` 覆盖。

| `uses` 里写了 | 覆盖 |
| --- | --- |
| `tool.call` | 只有 `tool.call` |
| `tool.*` | `tool.call` / `tool.describe` / `tool.check` … |
| `*` | 一切 |

越界 → `registry.revoke(plugin)` 撤掉这个插件的**全部**注册 + 警告点名哪条 pattern 越界。
**整体拒绝而不是单条丢弃**：hook 之间确实彼此独立，但半装的插件是最糟的失败模式 ——
加载器的警告会被淹没，而插件看起来"装了"。整体拒绝只让插件不生效，而 `tool.call` 的兜底是
`deny`（未知工具拒绝），不会 fail-open。

### 4.4 「只能更严」用包装保证

给第三方插件的 `on` 还会把它 hook 的返回值过一道：

```ts
const out = await hook($, e, next);
if (out 是对象 && out.decision === 'allow') {
  $.ui.log(`[插件] ${plugin} 想放行这次 ${e.tool} —— 第三方插件只能拧紧，这条判定被忽略。`);
  return next(e);      // 等价于"这条 hook 没有意见"
}
return out;
```

三点必须说清：

1. **只对不可能落在流式事件上的 pattern 包装**。判定用现成的 `matchesPattern(pattern, 'turn.step')`
   （`core/registry.ts` 已有这个函数，不另写一套）：命中就不包装。
   理由：`turn.step` 的 hook 是 async generator，外面套一层 async 函数会把
   `Promise<AsyncGenerator>` 交出去，生成器协议当场断掉。
2. 形状判断覆盖不到别的返回值 —— 只有 `tool.check` 的结果有 `decision` 字段，所以这道包装**天然只作用于权限判定**。
3. 于是「第三方插件给自己发放行条」这件事，**连表达都表达不出来**。这与 P2 那条
   「个人 allow 的效力上限是把一次 ask 变成 allow」是同一条线上的第三档：
   托管策略 > 个人规则 > 第三方插件，越往里越只能拧紧。

### 4.5 第三方插件不能扩展 `$`

往 `engine.create` 挂 hook 会被**明确拒绝 + 警告**，而不是今天那样静默无效（MVP §10 偏差 7 的地雷）。

MVP 指出的修法是"两趟注册"（第一趟只收集 `engine.create` 的 hook，第二趟做准入）。
本轮**不做**，理由：P3 的两个实物插件都不需要新名词，而两趟注册要引入一个暂存的 `$`
与一次重新折叠，动的是引擎最脆的那段。**但静默无效必须变成有声拒绝** ——
这是本轮唯一一处"把已知地雷换个处理方式"而不是"拆掉它"的地方，记在 §11 偏差 8。

### 4.6 边界要说白

准入闸门管的是**「在事件链上能声称多大权威」**，不是「代码能不能跑」。

导入 entry 模块**就是**在执行它 —— 加载器要拿到 `register` 就必须 import，而 import 会跑顶层代码。
`uses` 越界的插件在被 revoke 之前，它的顶层代码已经跑完了。

所以：**装一个插件目录等于信任它**，与 Claude Code 一致。差别只在于我们把这件事写进文档、
不让它藏在"插件系统"这个词后面，并且让 `validate` 把 hook 将要执行的命令**原样列出来**给人过目（§8）。

---

## 5. classic hooks 桥

### 5.1 只桥 3 个事件

| classic 事件 | 我们的钩子点 | 能力 |
| --- | --- | --- |
| `PreToolUse` | `tool.check` | **承重**。`exit 2` → deny，stderr 回喂模型 |
| `SessionStart` | `session.start` | 只跑命令，stdout/stderr 打到终端 |
| `SessionEnd` | `session.end` | 同上 |

其余 30 个事件：**声明在契约里**（`src/contract/classic.ts` 的 33 成员字面量联合），
`hooks.json` 里用到就点名警告「本版本不跑」。

为什么只有这三个：它们是仅有的、能落到**已有钩子点**上的三个。`PostToolUse` 需要一个 `tool.result` 事件、
`Stop` 与 `UserPromptSubmit` 需要一条能携带文本的通道 —— 都要动事件目录或 prompt 组装面，排在 P4（§11 偏差 2）。

**没有新增引擎事件**，所以「39 个已声明 / 12 个已实现」这个数字在本轮**不变**。
33 个 classic 事件名是契约里**另一份目录**，不是 33 个引擎事件 —— 造了也没人会 dispatch 它们（§11 偏差 1）。

### 5.2 stdin / env / 退出码

stdin（照参考实现的形状）：

```json
{
  "session_id": "20261011-034855-a1b2",
  "transcript_path": "C:\\Users\\…\\.deepcode\\projects\\F--ts-DeepCode\\sessions\\….jsonl",
  "cwd": "F:\\ts\\DeepCode",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": ".env", "content": "…" },
  "tool_use_id": "toolu_…"
}
```

`tool_use_id` 是**契约的一处小改动**：`tool.check` 今天的参数只有 `{tool, input}`，
而参考实现的 stdin 里 `tool_use_id` 是一等字段 —— 缺了它，hook 没法把判定与具体那一次调用对上
（一个回合里可能并列好几个同样的工具调用）。所以 `EventArgs['tool.check']` 加一个 `toolUseId`，
`loop.ts:142` 那处 dispatch 多传一个字段。**这不是新增事件**，是给已有事件补一个参数。

环境变量四个：`DEEPCODE_PLUGIN_ROOT` / `DEEPCODE_PROJECT_DIR`，以及它们的历史别名
`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PROJECT_DIR`。别名是为了让一份现成的 Claude Code 插件
`hooks.json` 能原样跑 —— 成本是一次 replace，收益是"能拿真插件当回归样例"。

`${DEEPCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 在 `command` 里同样展开。

**退出码与输出**：

| 情形 | `PreToolUse` 的判定 |
| --- | --- |
| `exit 0`，stdout 不是 JSON | 放行。stdout 原样打到终端 |
| `exit 0`，stdout 是 JSON | 读 `hookSpecificOutput.permissionDecision`（也接受顶层 `permissionDecision`）：`deny`→deny、`ask`→ask、**`allow`→忽略**（等于没表态，链往下走） |
| `exit 2` | **deny**。stderr 原文进 `rule` |
| 其它退出码（含 1） | **deny**（`rule` 写明退出码与 stderr 摘要） |
| 超时 | **deny**，并 `kill()` 子进程 |
| 起不来（ENOENT 等） | **deny** |
| stdout 是坏 JSON | **deny** |

一句话概括：**判定路径里只有 0 与 2 两个明确出口，其余一律 deny。**
这与 P2 出口标准「每个判定路径都有明确的失败行为」是同一条线 —— 判定路径里没有"不知道"这个状态。
（参考实现里 `exit 1` 是**非阻断**（放行），这里有意偏离，见 §11 偏差 4。）

`SessionStart` / `SessionEnd` 上 exit 2 与非零都只打一行警告，不影响主流程 —— 它们没有可阻断的东西。

### 5.3 matcher 与执行顺序

- **精确名** `"Write"` → 我们的 `{ tool: 'Write' }`
- **`A|B`** → 按 `|` 拆成多个精确名注册（参考实现有这条，且 hookify 的引擎也实现了它）
- **`*` 或省略** → 不带 matcher，对所有工具生效
- **正则形态**（含有 `[A-Za-z0-9_|]` 之外的字符）→ **跳过这一整个 matcher 组** + 警告。
  这里必须跳而不是"当精确名比对"：一条本意只覆盖 `mcp__.*__delete.*` 的规则若被放大到所有工具，
  那是**放宽**，不是收紧。方向不对的降级不做。

**执行顺序**：一个 matcher 组内多个 `HookDef` **串行、按声明顺序**，第一个给出 `deny` 的短路胜出，后面不再跑。
（参考实现是并行且顺序不定 —— 对一条能阻断的闸来说，不可复现是硬伤。见 §11 偏差 5。）

`timeout` 默认 **10 秒**，取值 1..300。参考实现默认 60 秒，那是给可能做 LLM 调用的钩子留的；
我们桥的都是**同步挡在工具调用前面**的事件，一个手滑的钩子把 CLI 冻住一分钟是用户敌意。见 §11 偏差 4。

### 5.4 忽略的输出字段

`suppressOutput`、`additionalContext`、`systemMessage`、`updatedInput`、`continue`/`stopReason`：
一律读不出效果，未知字段静默忽略（JSON 的未知键本来就该忽略）。

其中 `additionalContext` 值得单独说：它不是"忘了做"，是**没有通道**——
`prompt.submit` 的结果只有 `{handled}`，`session.start` 是纯通知事件，两者都没法携带文本。
要造这条通道得连 prompt 组装面一起做，排在 P4（§11 偏差 2）。
`updatedInput` 同理：`tool.check` 的结果类型 `{decision, rule}` 里没有改写入参的位置。

---

## 6. 座位：为什么第三方插件只能坐 `append`

这不是选的，是推出来的。两条约束一夹，只剩一个位置。

**约束一：必须在 `builtin` 之外。** `confirm` 坐 `builtin`，对 `tool.check` 的注册**不带 matcher 且不调 `next`**
（`builtins/confirm.ts` 里那个无名工具分支直接 return）。所以任何坐 `builtin` 或更里的
`tool.check` hook 都**永远不会被跑到** —— 出口标准第三条会直接落空。
classic hooks 桥必须在 `confirm` 外面。

**约束二：不能坐到 `user` 或更外。** `user` 是个人规则，`prepend` 是托管策略。第三方插件坐到那里，
就是让一个掉进目录的东西持有个人规则乃至策略的权威。

`append` 是唯一同时满足两者的层：在 `user` 之内、在 `builtin` 之外。

### 两条后果，都推过

**（a）插件的 `deny` 压得过个人的 `allow`。** `permissions` 的形状是"先 `next(e)` 再裁决"，
下游是 deny 就原样上抛（`builtins/permissions.ts` 里那条注释写得很清楚）。所以
「更严的永远赢」在插件这一档继续成立。

**（b）插件的 `ask` 会被个人的 `allow` 吃掉。** 这正是 P2 已定的语义（个人 `allow` 的效力上限是
把一次 `ask` 变成 `allow`），不是引入的新规矩。**托管策略仍然掀不翻**：`sec-default` 在最外层，
它拿到的是链尾的最终答案。

### 连带的一个结果

第三方插件挂 `tool.check` 并返回 `ask` 时，链就在它那里结束，`confirm` 不会跑 ——
**那个工具不会有 `confirm` 生成的预览**（Bash 的 `$ 命令`、Edit 的 diff）。
插件要显示什么得自己 `$.ui.log`。这不是缺陷，是"链上先应答者胜"的直接后果，
写在这里免得当成 bug 追。

---

## 7. 失败行为表

每个判定路径都有明确去向 —— P2 §7 那张表的续篇。

| 情形 | 行为 |
| --- | --- |
| `plugin.json` 缺失 / 坏 / `name` 非法 | 警告 + **整个插件不装** |
| 声明的路径不存在 | 警告 + 整个插件不装 |
| `hooks.json` 坏 | 警告 + 整个插件不装（不做半装） |
| entry `import` 抛错 | 警告 + 整个插件不装 |
| entry 没导出 `register` | 警告 + 整个插件不装 |
| entry 导出的 `name` 与清单不一致 | 覆盖成清单的名字 + 警告 |
| 注册越界 `uses` | `registry.revoke` 撤掉全部注册 + 警告点名 |
| 第三方插件挂 `engine.create` | 拒绝该条注册 + 警告（不是静默无效） |
| 第三方插件返回 `decision:'allow'` | 换成 `next(e)` + 警告 |
| 任一来源的 `plugins.deny` 命中插件名 | 不装 + 警告（点名来源文件） |
| **第一方**插件名出现在 `deny` 列表 | 启动期警告 + **忽略**（§4.1） |
| hook 命令起不来 / 超时 / exit 非 0 非 2 / 坏 JSON | `PreToolUse` → deny；`Session*` → 一行警告 |
| 发现目录不存在 | 静默（没装插件是常态，不是错误） |
| 发现目录下的非目录项（散落的文件） | 静默跳过 |

---

## 8. 子命令

```
deepcode plugin validate <dir>   校验一个插件目录，退出码 0/1
deepcode plugin list             发现了什么、启用了什么、被谁 deny 了、各自要跑哪些命令
```

识别规则：第一个非开关 token **恰好是 `plugin`** 且第二个是 `validate|list` 才进子命令模式；
其余一律照旧当提示词（`deepcode plugin` 单独出现时打印子命令说明，不是发给模型）。

`validate` 的输出样张：

```
$ deepcode plugin validate plugins/secret-guard
secret-guard  0.1.0  拦住把密钥写进仓库

  清单    plugin.json        ok
  入口    —                  无
  钩子    hooks/hooks.json   ok

  这个插件会在每次工具调用前跑这些命令（${DEEPCODE_PLUGIN_ROOT} 已展开）：
    PreToolUse   matcher=Write|Edit|Bash
      node F:\ts\DeepCode\plugins\secret-guard\hooks\guard.mjs      超时 10s

  警告
    · 未识别的清单字段：icon（本版本忽略）

通过（0 错误 / 1 警告）
```

失败样张（退出码 1）：

```
$ deepcode plugin validate plugins/broken
  清单    plugin.json        1 处错误
    E3  name "Secret_Guard" 不是 kebab-case（要求 ^[a-z][a-z0-9]*(-[a-z0-9]+)*$）
    E6  hooks 的路径必须是相对的且以 ./ 开头，实际是 "../shared/hooks.json"

不通过（2 错误 / 0 警告）
```

`/permissions` 增一节显示 `plugins enable/deny` 与各自的来源文件 —— P2 把它做成可审计面，插件这条继续挂在上面。

---

## 9. 文件结构

```
新增  src/contract/plugin-manifest.ts   清单与约定目录的形状 + 纯函数校验（validate 与加载器共用）
新增  src/contract/classic.ts           classic 事件名（33）+ hooks.json 形状 + 桥接白名单（3）
新增  src/cli/plugin-dir.ts             发现用户级/项目级目录、读清单、import entry、读 hooks.json
新增  src/cli/hook-run.ts               唯一的 spawn 点：stdin JSON、展开变量、超时、退出码与输出解析
新增  src/cli/plugin-command.ts         validate / list 的渲染
新增  src/builtins/plugin-guard.ts      座位 prepend：答 plugin.register，持有 policy 的 plugins.deny
新增  src/builtins/classic-hooks.ts     座位 append：把解析好的钩子映射到 tool.check / session.*

改    src/contract/events.ts            tool.check 的参数加一个 toolUseId（§5.2）
改    src/core/loop.ts                  tool.check 那处 dispatch 多传 toolUseId
改    src/core/create.ts                + thirdParty 名单 → 包装 on（剥 allow / 查 uses / 拒 engine.create）
改    src/core/registry.ts              + revoke(plugin)
改    src/cli/settings.ts               + plugins.enable / plugins.deny 的五层解析
改    src/cli/args.ts                   + plugin 子命令的识别
改    src/cli/main.ts                   + 发现 → 装载 → 传给 createEngine；`--help` 补子命令
改    src/cli/plugins.ts                + 两个新插件入清单与座位表；返回 thirdParty 名单
改    src/cli/permissions-command.ts    + plugins 那一节

新增  plugins/secret-guard/             plugin.json + hooks/hooks.json + hooks/guard.mjs
新增  plugins/todo/                     plugin.json + main.mjs
新增  test/plugin-manifest.test.ts  test/classic-hooks.test.ts
      test/plugin-dir.test.ts       test/plugin-e2e.test.ts
新增  docs/superpowers/specs/2026-10-11-deepcode-p3-design.md（本文）
```

**依赖边界的落法**：`builtins/` 只许 import `contract/`，所以路径发现与 `hooks.json` 的读取全部留在 `cli/`；
`builtins/classic-hooks.ts` 只接收**解析好的钩子配置**（`createClassicHooksPlugin({ hooks: [...] })`），
与 `createPermissionsPlugin({ rules })` 是同一手法。`builtins/` 直接用 `node:child_process` 不受边界脚本管辖
（`bash.ts` 就是这么做的）。

---

## 10. 验收标准

### 出口标准一：不改引擎的插件扩展出新能力

```bash
# 1) 装上两个示例插件（用户级 = 自动加载）
mkdir -p ~/.deepcode/plugins
cp -r plugins/secret-guard plugins/todo ~/.deepcode/plugins/

# 2) 工具面：todo 注册的 TodoWrite 进了模型可见清单
deepcode "把「跑一遍测试」记到待办里"
#    期望：模型调用 TodoWrite，终端先问一次 y/N（插件自己申报的 ask）

# 3) 钩子面：secret-guard 的 PreToolUse 拦住写 .env
deepcode "把 API key 写进 .env"
#    期望：Write 被拒，模型收到的错误里带 guard.mjs 打的那句理由

# 4) 「不改引擎」的字面证明
grep -rn "secret-guard\|TodoWrite" src/      # 期望：零命中
```

### 出口标准二：`validate` 拦住坏清单

一组 fixture 目录（放 `test/fixtures/plugins/`）逐条覆盖 §2.3 的 E1–E14，断言**报错点名**且退出码为 1；
W 级的 fixture 断言退出码 0 且警告点名。

### 出口标准三：classic hook 的 exit 2 真的阻断

一个测试用 hook：`PreToolUse` + `matcher: "Write"` + `command` 打印一行理由到 stderr 后 `exit 2`。
断言 `tool.check` 的判定是 `deny`，且 `rule` 里含那行理由；再断言这条 `deny` 能穿过
`permissions` 的个人 `allow`（「更严的永远赢」在插件这一档仍成立）。

### 批量验收（沿用 P2 体例）

| 检查点 | 覆盖 | 跑什么 |
| --- | --- | --- |
| C1 | §2 清单与校验、§3 发现与启用、`plugin validate`/`list` | `pnpm typecheck && pnpm test plugin-manifest plugin-dir` |
| C2 | §4 准入闸门（deny、uses 越界、剥 allow、拒 `engine.create`）、§6 座位 | `pnpm test` 全套 + 一条手工：往 policy 里写 `deny: ["todo"]`，看它不装并点名来源 |
| C3 | §5 classic hooks 桥、§7 失败行为表、三个出口标准 | `pnpm typecheck && pnpm lint && pnpm test` 全绿 + §10 那三条手工路径 |

---

## 11. 已知偏差与存疑

### 偏差（与 MVP §9.2 矩阵的 P3 列不一致，或与本项目既有约定不一致）

1. **不做 MCP 桥接**（矩阵 P3 列的"工具 / MCP 桥接"）。它是全套 stdio JSON-RPC 客户端 + 生命周期 + 工具名前缀，
   是独立的一块协议实现，而三条出口标准一条都没提到它。排到 P4/P5。
   连带影响：`02-plugin-system.md` 里的 `.mcp.json` 只被"发现与校验"，不被加载。
2. **不做 `ui.render` 数据树与 `$.ui.resolve`**（矩阵 P3 列的"UI"）。cli 层直接写 stdout 这条路是通的，
   而把渲染改成事件要动 `stream.ts`/`render.ts` 的骨架，收益要到多 surface（P5）才兑现。排到 P4。
   **连带的一条真实缺口**：classic hook 的 `additionalContext` / `updatedInput` 没有着陆点，
   所以本轮的桥只做"阻断类"，不做"注入类"。
3. **不拆 `packages/*` workspaces**（矩阵 P3 列的"扩展面"首项，MVP §2.2 说它是 P3 的明确交付物）。
   它买到的只有一件事：第三方插件**按路径导入同一份契约**。但契约是 type-only 导入，
   而运行时 `on` 是引擎注入的 —— **插件的运行时代码一个 import 都不需要**。
   物理分离真正值钱的时候是"要发布"的时候，那是 P5 的安装面。排到 P5。
4. **classic hooks 只桥 3 个事件**（30 个声明但不跑），且 `exit 1` 与非零一律 deny、`timeout` 默认 10s。
   参考实现的对应语义是 `exit 1` 非阻断、默认 60s。两处都是**收紧方向**的偏离，
   理由分别是"判定路径没有不知道这个状态"与"同步挡在工具调用前面的钩子不该冻住 CLI 一分钟"。
5. **classic hooks 串行执行**（参考实现并行、顺序不定）。一条能阻断的闸不可复现是硬伤。
6. **`plugin.json` 在插件根**，不在 `.deepcode-plugin/` 子目录（参考实现是后者）。
   参考那层嵌套是因为 Claude Code 的插件目录**同时充当 marketplace 根**（`.claude-plugin/` 里
   两个文件都放）。我们的 marketplace（P4）是一份独立的索引文件，插件目录只有"一个插件"这一个身份，
   嵌套买不到东西。
7. **第三方插件的 `allow` 判定被剥掉**（参考实现里 PreToolUse hook 的 `allow` 能绕过确认框）。
   与本项目「谁加自动放行开关谁就是在开倒车」同一条线 —— 让插件自己发放行条，
   就是给那句话开一个后门。
8. **第三方插件不能扩展 `$`**：往 `engine.create` 挂 hook 被拒绝并警告，而不是静默无效。
   MVP §10 偏差 7 给的修法（两趟注册）**没做**，因为本轮的两个实物插件都不需要新名词。
   这条是"把已知地雷换成有声拒绝"，不是"拆掉地雷"。
9. **`uses` 只在事件层面校验**，不校验 matcher。理由是 matcher 的可见范围属于"插件内部实现"，
   而闸门要守的是"链上的权威面"。代价：一个插件可以用 `tool.call` 的 `{tool:'Read'}` matcher
   顶掉内建 `Read`。这与「链上每一环都能被替换」是同一件事，属于装即信任的范围（§4.6），
   不是准入闸门该管的。

### 存疑（本设计拍板，但上位文档说不清）

| 主题 | 拍板内容 | 依据 |
| --- | --- | --- |
| `uses` 越界是丢一条还是丢整个插件 | 丢整个 | 半装的插件是 P1 已经吃过一次的失败模式 |
| 加载期任一处失败是否整体拒绝 | 是 | 同上，一致性优于粒度 |
| hook 超时的失败方向 | deny | 与"判定路径没有不知道这个状态"一致 |
| 正则 matcher 怎么办 | 跳过该 matcher 组 + 警告 | 放大一条收窄的规则是放宽；方向不对的降级不做 |
| 33 个 classic 事件以什么形式进契约 | 一个 33 成员字面量联合 | 不为它们各造一个引擎事件 —— 造了也没人会 dispatch |

---

## 12. 明确不做（YAGNI）

- `plugin install` / `uninstall` / marketplace 与本地索引（P4）
- `--plugin=<dir>` 这样一个"临时装一个"的开关（目录就是装载路径，不需要第二个入口）
- `type: 'prompt'` 的 LLM 型钩子（需要一次模型调用 + 新的预算面）
- `hooks.json` 的 `if`（工具命令前缀匹配）与 `asyncRewake` 一族（参考实现里它们连文档都没成文）
- 正则 matcher
- `updatedInput`（改写工具入参）
- `additionalContext` 注入
- 插件之间的依赖声明与拓扑排序
- 插件级配置（`plugin-settings` 那套 `.local.md`）

---

## 13. 关键文件索引（实现时对照）

| 本设计的章节 | 对应架构参考笔记 |
| --- | --- |
| §2 清单格式 | `02-plugin-system.md` §关键抽象 1（manifest 字段集与路径规则） |
| §2.2 入口模块 | `02-plugin-system.md` §数据流 A（发现与加载） |
| §3 发现与启用 | `02-plugin-system.md` §数据流 A；`07-hooks-system.md` §数据流 |
| §4 准入闸门 | `02-plugin-system.md` §设计决策；`07-hooks-system.md` §定位 |
| §5 stdin / 退出码 / matcher | `07-hooks-system.md` §4 输入契约、§5 输出契约、§3 Matcher 语法 |
| §5.2 环境变量 | `07-hooks-system.md` §6 环境变量 |
| §6 座位 | `01-engine-and-hooks.md` §数据流；P2 设计 §2 |
| §8 子命令 | `09-ci-and-automation.md`（校验器进 CI） |
