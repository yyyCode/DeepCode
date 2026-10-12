# 05 · 内建 mod `agents-md` 架构分析

> 本文分析仓库 `anthropics/claude-code` 中内建 mod `agents-md` 的实现，并借此说明引擎（engine）如何加载与编排项目指令文件（`CLAUDE.md` / `AGENTS.md`）。
> 所有路径均为仓库相对路径，行号以本仓库当前版本为准。引用的类型来自引擎声明文件 `mods/types/claude-code.d.ts`（由 `/plugin-types` 写出）。

---

## 定位

`agents-md` 是仓库 `mods/` 下随 CLI 一起编译进二进制的四个内建 mod 之一（见 `mods/README.md:11-16`）。它不改变引擎本身，而是作为一个 **plugin** 挂载到引擎的若干事件上，把 `AGENTS.md` 当作 `CLAUDE.md` 来用：

- 一个 `hooks/register.ts` 入口，`register(on, options)` 注册全部钩子（`mods/agents-md/hooks/register.ts:40`）。
- 一个选项 `instructionFiles`，四种取值，决定加载策略（`mods/agents-md/.claude-plugin/plugin.json:8-22`）。
- 一个真正的插件包结构：`.claude-plugin/plugin.json`、`hooks/hooks.json`（命名模块入口 `./register.ts`，`mods/agents-md/hooks/hooks.json:3`）与 `hooks/` 下的 TypeScript。

它的核心断言是：**“被当作 `project` 类型交回引擎的 `AGENTS.md`，对下游一切而言就是一个项目指令文件——同一位置、同一框架（framing）、同一省略规则、同一公告。”**（`mods/agents-md/README.md:30-41`）。这一句是全模块设计意图的浓缩：mod 只负责**发现（discovery）与投放（placement）**，**渲染（render）与框架（framing）由引擎完成**。

从“引擎如何加载项目指令文件”的角度看，`agents-md` 是一份可直接照抄的参考实现：它示范了 `prompt.context` 事件如何改写 `claudeMd` 背后的 `InstructionFile[]`、`Read` 工具调用如何惰性附带嵌套指令文件、以及一个 mod 如何消费另一个 mod（`telemetry`）在 `engine.create` 折叠中新增的名词。

---

## 职责与边界

### 职责（mod 自己做的）

1. **模式解析**：把存储的 `instructionFiles` 值（可能是 `undefined`、拼写错误、别的类型）归一为四个 `Mode` 之一（`mods/agents-md/hooks/modes/mode-of.ts:12-13`）。
2. **旧键兼容**：识别旧键 `projectInstructions` 的四个历史取值并映射为新模式，且在本 load 的第一次 `session.start` 于会话记录中说明（`mods/agents-md/hooks/modes/legacy-mode-of.ts:25-33`，`mods/agents-md/hooks/register.ts:55-65`）。
3. **文件发现**：用 `$.fs.ancestors` 向上回溯 `AGENTS.md` / `.claude/AGENTS.md`（`mods/agents-md/hooks/names/agents-names.ts:5`），并把找到的结果转成 `kind: 'project'` 的 `InstructionFile`（`mods/agents-md/hooks/files/files-of.ts:12-20`）。
4. **合并与定位**：把新文件插入到引擎已加载列表的正确位置，模拟引擎“root 在前”的项目文件顺序（`mods/agents-md/hooks/files/with-project-files.ts`、`mods/agents-md/hooks/files/insertion-index.ts`）。
5. **`managed-only` 过滤**：从上下文里剔除 `project` / `local` / `user` 三类，只留组织级 `managed` 与 `memory`（`mods/agents-md/hooks/files/dropped-kinds.ts:8-12`，`mods/agents-md/hooks/register.ts:74-88`）。
6. **惰性嵌套加载**：在 `Read` 工具调用上附带 root 与所读文件之间目录的 `AGENTS.md`（`mods/agents-md/hooks/register.ts:180-255`）。
7. **fork 去重**：`agent.spawn` 时把父 loop 已投递的嵌套文件集复制给 fork（`mods/agents-md/hooks/register.ts:169-178`）。
8. **遥测**：每次 load 发一行 mode 行、一次 load 行与一个 feature mark，Read 附带时发一行 nested 行（`mods/agents-md/hooks/telemetry/`）。

### 边界（mod 不做、或做不到的）

- **不渲染、不框架、不公告**：`claudeMd` 区块的文本由引擎按自身规则拼装（`mods/types/claude-code.d.ts:6780-6783`）。mod 只交回 `instructionFiles`。
- **不改引擎的嵌套 `CLAUDE.md` 行为**：`managed-only` 也无法阻止引擎自身的嵌套 `CLAUDE.md` 附带，因为那是引擎行为、当前不是事件（`mods/agents-md/README.md:24-28`）。
- **只在文本 `Read` 上附带**：`@` 提及的文件、IDE 打开的文件/选中、`Read` 的 notebook / 图片 / PDF 结果都不会触发附带（`mods/agents-md/README.md:130-134`）。
- **不进入读文件状态**：插件附带的嵌套文件不登记进 loop 的 read-file 状态，压缩后不会随“最近读取的文件”恢复（`mods/agents-md/README.md:135-139`）。
- **`--bare` / `CLAUDE_CODE_DISABLE_ATTACHMENTS` 下不附带**：只要引擎本轮不附带任何东西，mod 也不附带（`mods/agents-md/hooks/register.ts:258-281`）。
- **路径按拼写比较，不解析软链**：`Frames.isBelow` 是纯字符串前缀比较（`mods/agents-md/hooks/frames/is-below.ts:11-12`）。

完整的“与 `CLAUDE.md` 仍存在的差异”共 8 条，见 `mods/agents-md/README.md:125-158`。

---

## 关键抽象与接口

### 模式（Mode）与选项契约

```ts
// mods/agents-md/hooks/modes/types/mode/mode.ts:11-15
export type Mode =
  | 'claude-md'
  | 'claude-md-or-agents-md'
  | 'claude-md-and-agents-md'
  | 'managed-only'
```

四个模式语义（逐字引自 `plugin.json:12` 与 `mode.ts:5-9`）：

| 模式 | 含义 |
| --- | --- |
| `claude-md` | 只加载 `CLAUDE.md`，如引擎今日所为，插件不加任何东西。 |
| `claude-md-or-agents-md`（默认） | 项目**自己没有** `CLAUDE.md` 时，改加载其 `AGENTS.md`。 |
| `claude-md-and-agents-md` | `AGENTS.md` 与 `CLAUDE.md` **并列**加载（被 `CLAUDE.md` 已 `@` 导入或链接的不重复加载）。 |
| `managed-only` | 丢弃项目与个人的指令文件，保留组织的 `managed` 与 `memory`。 |

支撑常量与函数：

- `DEFAULT_MODE: Mode = 'claude-md-or-agents-md'`（`mods/agents-md/hooks/modes/default-mode.ts:8`）。
- `MODES: readonly Mode[]`，顺序即选项描述里的顺序（`mods/agents-md/hooks/modes/modes.ts:6-11`）。
- `modeOf(value: unknown): Mode`：`MODES.find(mode => mode === value) ?? DEFAULT_MODE`，未知值静默落到默认（`mods/agents-md/hooks/modes/mode-of.ts:12-13`）。
- `legacyModeOf(value: unknown): Mode | undefined`：旧键映射 `none→managed-only`、`claude→claude-md`、`agents-fallback→claude-md-or-agents-md`、`both→claude-md-and-agents-md`，任何其他值（含类型不符）映射为 `claude-md`（**不**映射为默认，以免意外加载 `AGENTS.md`）（`mods/agents-md/hooks/modes/legacy-mode-of.ts:7-33`）。

选项在插件清单中声明，作为内建 `/config` 的一行 picker 渲染：

```json
// mods/agents-md/.claude-plugin/plugin.json:8-22
"instructionFiles": {
  "type": "string",
  "title": "Project instructions",
  ...
  "default": "claude-md-or-agents-md",
  "options": ["claude-md", "claude-md-or-agents-md", "claude-md-and-agents-md", "managed-only"]
}
```

### 指令文件的数据模型（引擎契约）

```ts
// mods/types/claude-code.d.ts:4621
const INSTRUCTION_FILE_KINDS: readonly ["managed","user","project","local","memory"];

// mods/types/claude-code.d.ts:4627-4644
export type InstructionFile = {
  path: string;              // 绝对路径
  kind: InstructionFileKind; // 层级
  content: string;           // 加载时文本（注释与 frontmatter 已剥离）
  parent?: string;           // @ 导入它的那个文件的路径
};
```

层级语义：`managed`（组织策略）、`user`（个人）、`project`（项目签入）、`local`（项目私有）、`memory`。引擎按顺序渲染 `claudeMd`（`mods/types/claude-code.d.ts:4646-4650`）。

`prompt.context` 的输入/输出即围绕这份列表：

```ts
// mods/types/claude-code.d.ts:6802-6816（输入）
export type PromptContextInput = {
  blocks: readonly PromptContextBlock[];
  instructionFiles?: readonly InstructionFile[]; // 未定义 = 上层 hook 改写了 claudeMd 文本
};
// :6822-6835（输出）
export type PromptContextResult = {
  blocks: readonly PromptContextBlock[];
  instructionFiles?: readonly InstructionFile[];
};
```

其中 `claudeMd` 区块的 `text` 由引擎“按框架引擎自己框架它们的样式”生成（`mods/types/claude-code.d.ts:6780-6783`）；`instructionFiles` 必须“在每个链接点与 `claudeMd` 文本保持同步”（`:6830-6832`）。

### 文件系统遍历契约

```ts
// mods/types/claude-code.d.ts:3984-4016
export type FsAncestor = { dir: string; name: string; content: string; parts: readonly FsAncestorPart[] };
export type FsAncestorPart = { path: string; content: string };

// :4022-4041
export type FsAncestorsRequest = { names: readonly string[]; of?: string; below?: string };
```

`parts` 是关键：第一个 part 是文件自身，其后是它的 `@` 导入（按 load 顺序），`content` 是这些文本的拼接（`mods/types/claude-code.d.ts:3993-4001`）。`below` 让遍历只读“严格位于其内”的目录，`of` 给出向下走到哪个文件——两者合起来正是引擎为嵌套 `CLAUDE.md` 所做的那套遍历（`:4036-4040`）。

### 名称常量

- `AGENTS_NAMES = ['AGENTS.md', '.claude/AGENTS.md']`（`mods/agents-md/hooks/names/agents-names.ts:5`）。
- `CLAUDE_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']`（`mods/agents-md/hooks/names/claude-names.ts:7-11`）。
- `MAIN_LOOP = 'main'`：主会话已投递文件集所用的 key；子 agent 用自己的 `agentId`（`mods/agents-md/hooks/names/main-loop.ts:5`）。

### 遥测名词（消费另一个 mod 的 noun）

`agents-md` 自己**不拥有** `$.telemetry`，而是消费 `telemetry` mod 的 noun 契约。它的类型不复制，而是从引擎接口派生：

```ts
// mods/agents-md/hooks/telemetry/types/telemetry-row/telemetry-row.ts:7
export type TelemetryRow = Parameters<EngineInterface['telemetry']['log']>[0];
// types/telemetry-mark/telemetry-mark.ts:7
export type TelemetryMark = Parameters<EngineInterface['telemetry']['mark']>[0];
// types/telemetry-prop/telemetry-prop.ts:9
export type TelemetryProp = NonNullable<TelemetryRow['props']>[string];
```

`EngineInterface['telemetry']` 由 `mods/telemetry/types/index.d.ts:123-131` 的 `declare module 'claude-code'` 声明；`mods/tsconfig.json:16` 的 `include` 里有 `*/types/**/*.d.ts`，因此这里能解析到该契约。契约本身规定属性值只能是“有限数字、布尔值或 `TelemetryChoice`，绝不允许自由文本”（`mods/telemetry/types/index.d.ts:107-121`）。

---

## 数据流 / 时序

`register()` 在一次 load 里建立这些游标状态（`mods/agents-md/hooks/register.ts:90-97`）：

| 变量 | 作用 |
| --- | --- |
| `given: Map<string, Set<string>>` | 每个 agent loop 已投递的嵌套文件路径集（`main` 或 `agentId`）。 |
| `inContext: readonly InstructionFile[]` | 最近一次上下文里的指令文件列表，嵌套去重要用。 |
| `home` | home 目录，惰性解析一次（`home ??=`）。 |
| `isClaudeProject` | `claude-md-or-agents-md` 下项目是否有自己的 `CLAUDE.md`（可缓存、可重置）。 |
| `rootSeen` / `rootLogged` | 最近一次见到的项目 root；后者决定 debug 行是否已输。 |
| `isCounted` | load 行与 mark 是否已发（每次 load 一次）。 |

### 时序 1：`session.start`（每个模式都挂）

```
on('session.start') →
  Telemetry.quietly(() => $.telemetry.log(modeRowOf(mode, e.isInteractive)))
  if (!isRenameTold) { isRenameTold = true; $.ui.log(<旧键说明>) }
  return next(e)
```

要点：`session.start` 从不等待这个插件（`return next(e)`，遥测以 `quietly` 浮起）；`modeRowOf` 发出事件 `agents_md_mode`，属性为 `{ mode: { value, of: MODES }, is_interactive }`（`mods/agents-md/hooks/register.ts:50-68`，`mods/agents-md/hooks/telemetry/mode-row-of.ts:14-20`）。旧键说明只在一次 load 里说一次（`isRenameTold` 初始为 `legacy === undefined`，即无旧键时无需说明）。

此后按模式分流（`register.ts:70-88`）：

- `claude-md` → 直接 `return`，引擎的 `CLAUDE.md` 遍历独行。
- `managed-only` → 只注册一个 `prompt.context` 钩子，matcher 为 `{ instructionFiles: { kind: DROPPED_KINDS } }`，把 `project` / `local` / `user` 过滤掉后交回（`register.ts:74-88`）。

### 时序 2：`prompt.context`（发现 + 合并）

```
on('prompt.context') →
  handed = e.instructionFiles
  if (handed === undefined) return next(e).finally(clear given)   // 上层改写了文本，不加
  root = isFallback ? await $.session.root() : undefined
  isClaudeProject = root !== undefined &&
      (handed.some(isClaudeFileOnWalk(file, root)) || await $.fs.ancestors({names: CLAUDE_NAMES})...)
  found = isClaudeProject ? NONE : await $.fs.ancestors({names: AGENTS_NAMES}).catch(...)
  added = Files.unseenFiles(Files.filesOf(found), handed)
  if (!isCounted) { 发 load 行 + feature mark }   // 每次 load 一次
  if (isFirstLoad) $.ui.log('no CLAUDE.md found; AGENTS.md loaded: ...', { to: 'debug' })
  instructionFiles = Files.withProjectFiles(handed, added)
  return next({ ...e, instructionFiles }).finally(() => { given.clear(); inContext = instructionFiles })
```

关键判断一：**“项目是否有自己的 `CLAUDE.md`”不仅看 handed 列表，还要看一次文件系统遍历**。注释点明理由：“引擎可能藏起一个它已加载的项目 `CLAUDE.md`，而项目仍然有它”（`mods/agents-md/hooks/register.ts:110-123`）。`isClaudeFileOnWalk` 只认 root 及其下的、`parent === undefined` 的、名字以 `CLAUDE_NAMES` 之一结尾且为项目自身的文件——`managed`、`user`、`.claude/rules`、`@` 导入、added dir 的 `CLAUDE.md` 都不算（`mods/agents-md/hooks/files/is-claude-file-on-walk.ts:20-39`）。

关键判断二：规则 `.claude/rules`、`--add-dir` 的 `CLAUDE.md` 不算项目自有——与嵌套遍历的视野保持一致（`mods/agents-md/README.md:12-19`）。

关键判断三：遍历失败时 `.catch(() => { isWalkFailed = true; return NONE })`，上下文按原样继续；此时 feature mark 报 `sad` + `reason: 'walk_failed'`（`mods/agents-md/hooks/register.ts:124-144`，`mods/agents-md/hooks/telemetry/load-mark-of.ts:12-15`）。

### 时序 3：合并与定位（`withProjectFiles` / `insertionIndex`）

`filesOf` 把每个 `FsAncestor` 摊平成“文件 + 它的每个 `@` 导入”，导入项带 `parent`（`mods/agents-md/hooks/files/files-of.ts:12-20`）。`unseenFiles` 去重：路径命中 handed 的、或文本（trim 后）等于某个 handed 项目文件的，都跳过（`mods/agents-md/hooks/files/unseen-files.ts:18-40`）——这同时覆盖了“`CLAUDE.md` `@` 导入了 `AGENTS.md`”与“`CLAUDE.md` 是 `AGENTS.md` 的软链”两种情形。

`withProjectFiles` 按目录分组，再用 `insertionIndex` 定位（`mods/agents-md/hooks/files/with-project-files.ts:15-37`）。`insertionIndex` 的规则（`mods/agents-md/hooks/files/insertion-index.ts:20-44`）：

1. 若列表中存在“比本目录更深”的项目自有文件（导入项用其 `@` 链头 `chainRootOf` 归属目录），插到它之前；
2. 否则插到最后一个项目自有文件之后；
3. 否则插到 `memory` 之前；
4. 否则追加到末尾。

这精确模拟引擎“项目文件 root 在前”的顺序。`projectDirOf` 决定“文件所属项目目录”：普通文件取最后一个 `/` 之前，`.claude/CLAUDE.md` 取最后一个 `/.claude/` 之前（`mods/agents-md/hooks/files/project-dir-of.ts:10-16`）。

### 时序 4：`tool.call` on `Read`（惰性嵌套附带）

```
on('tool.call', { tool: 'Read' }) →
  result = await next(e)
  if (e.tool !== 'Read' || result.deny || result.isError) return result
  if (!(await attachesOnRead($))) return result          // --bare / DISABLE_ATTACHMENTS
  [root, cwd] = [$.session.root(), $.session.cwd()]
  home ??= await homeOf($, cwd)
  read = Frames.absoluteOf(e.file_path, cwd, home)       // ~ 展开、相对路径拼接
  if (root !== rootSeen) { rootSeen = root; isClaudeProject = undefined; given.clear() }
  isClaudeProject ??= isFallback && (await $.fs.ancestors({names: CLAUDE_NAMES})).length > 0
  isOutOfReach = isClaudeProject || !Frames.isBelow(read, root)
  if (isOutOfReach) return result
  [stack, claude] = await Promise.all([
    $.fs.ancestors({names: AGENTS_NAMES, of: read, below: root}),
    $.fs.ancestors({names: CLAUDE_NAMES, of: read, below: root}),
  ]).catch(() => [NONE, NONE])
  loop = e.agentId ?? MAIN_LOOP
  sent = given.get(loop) ?? new Set(); given.set(loop, sent)
  nested = (isFallback ? outsideClaudeDirs(stack, claude) : stack)
             .filter(file => isBelow(file.dir, root))
  fresh = unseenFiles(filesOf(nested), [...inContext, ...filesOf(claude)])
             .filter(file => !sent.has(file.path))
  attached = fresh.filter(file => !isFileAt(file, read))   // 不重复附带所读文件本身
  ... 把 fresh 计入 sent ...
  return attached.length
    ? { ...result, context: [...(result.context ?? []), ...attached.map(nestedFrame)] }
    : result
```

设计要点：

- **遍历只覆盖 root 与所读文件之间的目录**（`below: root`），从不再次上溯到文件系统根（`mods/agents-md/hooks/register.ts:212-214`）。
- **每个 loop 每个文件只附一次**（`given` / `sent`），且已在上下文里的文件不再附；`inContext` 随 `prompt.context` 重算而改变，压缩或 `/clear` 之后计数重置（`register.ts:163-166`, `219-236`）。
- **`claude-md-or-agents-md` 下用 `outsideClaudeDirs`**：同目录有 `CLAUDE.md` 的，其 `AGENTS.md` 被整个让给引擎（`mods/agents-md/hooks/frames/outside-claude-dirs.ts:14-21`）；`claude-md-and-agents-md` 下则直接取 `stack`。
- **框架逐字节对齐引擎**：`nestedFrame` 生成 `Contents of <path>:\n\n<content>`（`mods/agents-md/hooks/frames/nested-frame.ts:10-11`），且保留原始尾部换行（注释：“the text as loaded, trailing newline and all”）。
- **`root` 实时读取**：`/cd`、宿主目录变更、worktree 移动都会被跟随；root 变化时重置 `given` 与 `isClaudeProject`（`register.ts:197-206`）。

### 时序 5：`agent.spawn` fork 继承

```
on('agent.spawn', { fork: true }) →
  result = await next(e)
  if (result.agentId !== undefined) {
    parent = given.get(e.parentAgentId ?? MAIN_LOOP)
    given.set(result.agentId, new Set(parent))
  }
  return result
```

fork 与父共享 prompt 前缀，因此父 loop 已投递的嵌套文件被复制到 fork，而不再次附带（`mods/agents-md/hooks/register.ts:169-178`）。`fork` 是 `AgentSpawnInput` 上的 pinned 字段（`mods/types/claude-code.d.ts:295-299`），`parentAgentId` 亦然（`:273-281`）。

### 时序 6：遥测

每行都经 `quietly` 发送——它 `void Promise.resolve().then(send).catch(() => undefined)`，保证“没有 telemetry 名词的构建、被拒的行、不接受它的 ingest，都不会干扰指令”（`mods/agents-md/hooks/telemetry/quietly.ts:9-13`）。

| 事件 | 时机 | 属性（`props`） |
| --- | --- | --- |
| `agents_md_mode` | 每次新 load 的 `session.start` | `mode`、`is_interactive` |
| `agents_md_load` | load 的第一次 context（两种 AGENTS 模式） | `mode`、`file_count`、`import_count`、`total_content_length`、`yielded`、`walk_failed` |
| （mark） | 与 load 行同时 | feature `agents_md`：`ok`，或 `sad` + `reason: 'walk_failed'` |
| `agents_md_nested` | 一次实际附带嵌套文件的 Read | `mode`、`file_count` |

`loadCountsOf` 的计数逻辑：`importCount` 是带 `parent` 的条目数，`fileCount = added.length - importCount`，`totalContentLength` 是所有条目 `content.length` 之和（`mods/agents-md/hooks/telemetry/load-counts-of.ts:15-35`）。类型 `LoadCounts` 见 `mods/agents-md/hooks/telemetry/types/load-counts/load-counts.ts:8-14`。

---

## 扩展点

1. **选项即扩展点**：一个 `instructionFiles` 枚举，清单里的 `userConfig` 驱动内建 `/config` 的 picker（`plugin.json:8-22`）。改值会重载模块，下一个 `prompt.context`（reload 后的下一轮、新会话、`/clear`、压缩）即采用新模式（`mods/agents-md/README.md:62-66`）。手写非法值只在会话里说一次并退回默认（`README.md:66-68`）。

2. **事件钩子**：`session.start`（遥测 + 旧键说明）、`prompt.context`（发现/合并/过滤）、`tool.call` on `Read`（嵌套附带）、`agent.spawn` fork（继承）。这些是 hook 作者可复用/可替换的接缝（`mods/agents-md/hooks/register.ts`）。

3. **matcher 缩窄**：`on('prompt.context', { instructionFiles: { kind: Files.DROPPED_KINDS } })` 利用“数组值在任一元素匹配时成立”的 matcher 语义，只在存在被丢弃层级时触发（`mods/agents-md/hooks/files/dropped-kinds.ts:8-12`，`mods/types/claude-code.d.ts:4921`）。

4. **跨 mod noun**：通过 `import type ... from 'claude-code'` + `Parameters<...>` 消费 `telemetry` 的契约，而不复制类型；`mods/tsconfig.json:16` 的 `*/types/**/*.d.ts` 让这一引用成立（见 `mods/README.md:88-104`）。组织的前置插件部署在 `prompt.context` 上、位于本 mod 之上，拥有对文件的最终决定权（`mods/agents-md/README.md:39-41`）。

5. **模式的可组合性**：`claude-md` 与 `managed-only` 均为“早退式”实现，不注册搜索钩子；新增模式时只需在 `modes.ts`、`mode.ts`、`plugin.json`、`register()` 分流处各改一处。

---

## 设计决策与权衡

### 1. 单一枚举选项，而非多个布尔开关

`claude-md` / `claude-md-or-agents-md` / `claude-md-and-agents-md` / `managed-only` 在语义上互斥，用**一个** `instructionFiles` 枚举表达，而不是 `useAgentsMd`、`preferAgentsMd`、`dropProjectFiles` 等一堆 flag。好处：

- 枚举天然排除矛盾组合，内建 `/config` 直接渲染为 picker（`plugin.json`）。
- 每个值可独立演进、可读、可遥测（`mode` 以闭合选择 `{ value, of }` 上报，`mods/agents-md/hooks/telemetry/mode-choice-of.ts:10-13`）。
- 切换即重载，无需处理“多个开关同时为真”的优先级。

### 2. 旧键迁移的“单向兜底”

旧键 `projectInstructions` 只在 `instructionFiles` 仍是默认值时被读取（`register.ts:46-48`）。旧值中的未知值映射为 `claude-md`（不加任何东西），**绝不**映射为默认（会意外加载 `AGENTS.md`）（`legacy-mode-of.ts:14-32`）。迁移期用 `COMPAT_BREAK(agents-md-project-instructions)` 标记，提示设置迁移完成后删除映射。这是一种“宁可少做事，不可意外改变行为”的兼容策略。

### 3. 逐字节对齐引擎的框架与定位

这是整个 mod 的核心约束。两处体现：

- **上下文里的框架**由引擎完成，mod 只需交回 `kind: 'project'` 的文件；测试断言引擎渲染出 `Contents of /repo/AGENTS.md (project instructions, checked into the codebase):\n\n# top`（`mods/agents-md/tests/register.test.ts:37-40`）。
- **嵌套附带**由 mod 亲自拼字符串，因此必须逐字节复刻：`Contents of ${file.path}:\n\n${file.content}`（`mods/agents-md/hooks/frames/nested-frame.ts:11`），并保留原始尾部换行。

代价：路径按拼写比较（不解析软链），`--add-dir` 目录不贡献 `AGENTS.md`，`~`/相对路径需手动按 Read 工具规则展开（`mods/agents-md/hooks/register.ts:294-305`）。

### 4. 惰性嵌套加载 + 双重去重

嵌套文件不做预加载，只在 `Read` 命中时才附带；去重有两个维度：**全局/上下文维度**（`inContext` 与 handed 项目文件按路径或文本去重，`unseen-files.ts`）与**每个 loop 维度**（`given` / `sent`）。这既省 token，又让“一次会话/一个 loop 内每文件只附一次”成立；代价是压缩后需重新附带（不进 read-file 状态），且非 fork 子 agent 会与父重复附带（`mods/agents-md/README.md:155-158`）。

### 5. 失败隔离与“引擎行为优先”

- 所有 `$.fs.ancestors` 调用都 `.catch`，遍历失败时上下文按原样继续（`register.ts:116-130`）。
- 所有遥测走 `quietly`，无 noun 时静默丢弃（`quietly.ts`）。
- `attachesOnRead` 每次都通过 `$.env.get` 读 `CLAUDE_CODE_SIMPLE` 与 `CLAUDE_CODE_DISABLE_ATTACHMENTS`，因为设置 `env` 块或托管下发可能在一个会话中途翻转（`register.ts:258-281`）。
- 开关拼写与引擎一致：`1` / `true` / `yes` / `on`，大小写与首尾空白不敏感（`mods/agents-md/hooks/switches/is-switched-on.ts:4-14`）。

### 6. `managed-only` 作为“减法模式”

它只过滤层级、不加载任何东西，且明确承认引擎自身的嵌套 `CLAUDE.md` 附带无法阻止（`README.md:24-28`）。这是对“插件能力边界”的诚实标注。

---

## 对复刻产品的启示

若要构建同类产品（把 `AGENTS.md` 或任意等价文件接入项目指令体系），以下要点应直接照抄：

1. **分层优先级模型是骨架**：`managed` / `user` / `project` / `local` / `memory` 五层，`project` 内部再按目录深度从 root 向外排。新增文件必须标注正确 `kind`，并被插到“该目录的项目文件应在的位置”。
   - 定位算法可直接移植 `insertionIndex`（`mods/agents-md/hooks/files/insertion-index.ts`）。
   - 归属目录算法移植 `projectDirOf`（`.claude/` 特例）。

2. **“是否已有原生指令文件”要查文件系统，而非只信上下文**：因为引擎可能加载后又藏起一个 `CLAUDE.md`。`isClaudeFileOnWalk` 是参考实现（`mods/agents-md/hooks/files/is-claude-file-on-walk.ts`）。

3. **渲染/框架/公告交给宿主**：只提供 `InstructionFile[]`，让宿主用自己的框架字符串去渲染，才能保证与原生文件“同一位置、同一框架”。若必须自己拼字符串（如嵌套附带），则必须逐字节复刻宿主格式（`nested-frame.ts:11`）。

4. **惰性 + 去重**：嵌套文件在“读取附近文件”时才附带；用“已投递集合（按 loop）+ 当前上下文集合”两道去重；fork 继承父集合。

5. **单一枚举选项**：语义互斥的模式用一个枚举，清单声明 + picker 渲染 + 闭合选择遥测。

6. **失败隔离**：所有遍历 `.catch`、所有遥测 fire-and-forget，指令装配永不被外围故障打断。

7. **遥测只报计数与闭合选择**，绝不上报路径与文件正文（`mods/agents-md/README.md:113-115`）。

8. **诚实标注与宿主仍存在的差异**（`README.md:125-158`），便于用户预期管理，也标注了未来可补齐的接口缺口。

---

## 关键文件索引

入口与清单：

- `mods/agents-md/hooks/register.ts` — 唯一入口 `register(on, options)`；模式解析、三种分流、上下文发现/合并、Read 嵌套附带、fork 继承、`attachesOnRead`、`homeOf`。
- `mods/agents-md/hooks/hooks.json` — 声明 `modules: ["./register.ts"]`。
- `mods/agents-md/.claude-plugin/plugin.json` — 名称、描述、`userConfig.instructionFiles` 四值 picker。
- `mods/agents-md/README.md` — 权威行为说明（模式、事件表、`$` 调用表、日志表、8 条差异、旧键迁移）。
- `mods/README.md` — 四个内建 mod 概览、mod 测试约定、noun 组合契约。

模式：

- `mods/agents-md/hooks/modes/types/mode/mode.ts` — `Mode` 联合类型。
- `mods/agents-md/hooks/modes/modes.ts` / `default-mode.ts` / `mode-of.ts` / `legacy-mode-of.ts`。

文件发现与合并：

- `mods/agents-md/hooks/files/files-of.ts` — `FsAncestor → InstructionFile[]`（含 `@` 导入）。
- `mods/agents-md/hooks/files/unseen-files.ts` — 路径/文本去重。
- `mods/agents-md/hooks/files/with-project-files.ts` / `insertion-index.ts` / `chain-root-of.ts` / `project-dir-of.ts` — 定位与归属。
- `mods/agents-md/hooks/files/is-claude-file-on-walk.ts` / `is-project-own.ts` / `is-kept-without-instructions.ts` / `dropped-kinds.ts`。

框架与路径：

- `mods/agents-md/hooks/frames/nested-frame.ts` — `Contents of <path>:\n\n<content>`。
- `mods/agents-md/hooks/frames/absolute-of.ts` / `is-below.ts` / `is-file-at.ts` / `normal-spelling-of.ts` / `outside-claude-dirs.ts`。

名称与开关：

- `mods/agents-md/hooks/names/agents-names.ts` / `claude-names.ts` / `main-loop.ts`。
- `mods/agents-md/hooks/switches/is-switched-on.ts`。

遥测：

- `mods/agents-md/hooks/telemetry/`（`load-row-of.ts`、`load-mark-of.ts`、`load-counts-of.ts`、`mode-row-of.ts`、`nested-row-of.ts`、`quietly.ts`、`feature-name.ts`、`walk-failed-reason.ts`、`types/`）。

测试与夹具：

- `mods/agents-md/tests/register.test.ts` — 默认模式三个场景 + 遥测两场景（含断言引擎框架字符串）。
- `mods/agents-md/tests/fixtures/`（`project-of.ts`、`ancestor-of.ts`、`recording.ts`、`rows-of.ts`、`started-of.ts`、`session.ts`、`unreadable-project-of.ts`、`types/`）。

引擎契约：

- `mods/types/claude-code.d.ts` — `InstructionFile`(:4627)、`InstructionFileKind`(:4650)、`INSTRUCTION_FILE_KINDS`(:4621)、`FsAncestor`(:3984)、`FsAncestorsRequest`(:4022)、`PromptContextInput/Result`(:6802/:6822)、`AgentSpawnInput.fork`(:295)、`ToolCallResult.context`(:9861)、`UiLogSink`(:10820)。
- `mods/telemetry/types/index.d.ts` — `$.telemetry` noun 契约与 `declare module 'claude-code'`。
- `mods/tsconfig.json` — `include: ["types", "*/types/**/*.d.ts", "*/hooks", "*/tests"]`。

指令文件格式的真实样例：

- `CLAUDE.md`（仓库根）— 纯 Markdown、`# CLAUDE.md` 标题、`##` 小节、约定式正文，即引擎读取并渲染的格式。

---

## 存疑与待确认

1. **`fs.ancestors` 的上溯起点术语不一致**：类型文档写“every directory above the session's **original** working directory”（`mods/types/claude-code.d.ts:2832-2833`），而 mod 用 `$.session.root()` 作为 `below` 边界并把 root 当作项目边界。二者在普通场景一致，但 `/cd` 或宿主切目录后，“original cwd”与“root”是否始终相同，需要引擎源码确认。

2. **引擎框架字符串仅在测试中出现**：`Contents of <path> (project instructions, checked into the codebase):\n\n…` 只见于测试断言（`mods/agents-md/tests/register.test.ts:37-40`），`mods/types/claude-code.d.ts` 只描述“引擎按自身框架渲染”而未给出确切字符串。mod 依赖此字符串，但契约文字层面未固化；若引擎改措辞，mod 的“逐字节一致”只能靠测试守住。

3. **`isCounted` 的生命周期**：它是 `register()` 闭包内的单次标志，因此在同一 load 内即使多次 `prompt.context`（多轮、`/clear`、压缩）也只发一次 load 行。README 说“the first context of a load”，与此一致，但若一个进程内一次 load 服务多个项目 root（`/cd` 换项目），计数不再重发——这是有意还是遗漏，文档未明说。

4. **`claude-md-and-agents-md` 下 `isClaudeProject` 恒为假**：`isClaudeProject ??=` 仅在 `isFallback`（即 `claude-md-or-agents-md`）时求值为真（`register.ts:203-205`），因此该模式下 `isOutOfReach = !isBelow(read, root)` 单独决定，行为正确；但这意味着 Read 路径永远会走 `$.fs.ancestors({names: CLAUDE_NAMES})`（用于 `outsideClaudeDirs` 的 `claude` 参数），开销与语义需留意。

5. **`home` 的缓存与平台判定**：`homeOf` 用 `cwd.includes('\\')` 判定 Windows 拼写（`register.ts:302-304`），且 `home` 整个 load 只解析一次（`home ??=`）。若同一 load 内 cwd 在 Windows 与 POSIX 拼写间切换，或 `HOME`/`USERPROFILE` 中途变化，缓存不会刷新。README 称其“once per load”，属已知取舍。

6. **`loadCountsOf` 的 `file_count` 口径**：`fileCount = added.length - importCount`（`load-counts-of.ts:26`）。`added` 同时含文件与其 `@` 导入，故这是“文件数（不含导入）”。测试未直接断言该行数值，实际口径需与 `README.md:122` 的描述对齐确认。

7. **`managed-only` 依赖 matcher 触发**：钩子只在 handed 列表里存在被丢弃层级时被调用（matcher 语义）。若 handed 为空或上层改写使 `instructionFiles === undefined`，钩子不会被调用，也就无从过滤——这是否完全等价于“丢弃项目/个人文件”，取决于引擎 matcher 对 `undefined` 的处理，需以引擎源码为准。

8. **`test 之外`未验证的行为**：`agent.spawn` fork 的“同一工具批次里的 Read 使 fork 继承该 Read 的文件（其前缀对它是占位符）”一句（`README.md:95`）在代码中体现为 `given` 集的复制，但“占位符”这一引擎侧细节无法从仓库 mod 源码验证。

9. **`README.md` 与实现的一处措辞**：`mods/README.md:13` 与 `mods/agents-md/README.md:8` 对 `claude-md-or-agents-md` 的“项目没有 `CLAUDE.md`”判定，代码实现为“handed 中命中 `isClaudeFileOnWalk` **或** 一次 `$.fs.ancestors(CLAUDE_NAMES)` 非空”（`register.ts:113-123`）。文字与代码一致，但“项目自有”的精确边界（如 `.claude/rules` 不计）应以 `is-claude-file-on-walk.ts` 为准。
