# diff 内建 mod 架构分析

> 分析对象：`F:\ts\claude-code\mods\diff`（约 823 个文件）。
> 这是 `anthropics/claude-code` 公开仓库中 4 个内建 mod 之一，实现 `/diff` 功能。
> 所有行号均指仓库内相对路径文件；代码/接口名保持英文原文。

---

## 定位

`diff` 是一个 Claude Code 插件（mod），把会话的**未提交改动**渲染成 transcript 旁边的一个 pane：逐文件、带 hunk，随 Claude 编辑文件、执行 shell 命令而刷新。

- 它是一个完整的 plugin：`mods/diff/.claude-plugin/plugin.json`（`name: "diff"`）声明插件；`mods/diff/hooks/hooks.json` 的 `"modules": ["./register.ts"]` 指向唯一入口模块。
- mod 的行为全部写在 hooks module 里：一个 `register(on, options)` 入口，把引擎的事件钩成 `($, e, next)` 形式的函数（`mods/README.md:3-6`）。
- 产物会被编译进 Claude Code 二进制；`mods/` 目录里发布的是与二进制一致的源码（`mods/README.md:4-6`）。
- UI 使用 JSX（`mods/tsconfig.json`：`"jsx": "react"`、`"jsxFactory": "h"`、`"jsxFragmentFactory": "Fragment"`），面板由视图组件树渲染。

`register.ts` 顶部的文档注释概括了它的生命周期（`mods/diff/hooks/register.ts:31-40`）：

```
 * Registers the diff pane: `/diff` once the built-in stands down, the
 * pane's drawing and refresh, its opening on Claude's first edit, the ask.
 *
 * Git runs when the built-in's would: none at the start; `/diff` or the main
 * loop's first checkpointed edit with room pins the backend, until `/clear`,
 * which reads afresh under a pane it leaves open.
```

它是一个**真实世界的样本**：既接通终端 UI（pane / Button / Select / Code），又 shell out 调 git，还按下引擎事件驱动的刷新节奏。复刻同类产品时，可把它当作“引擎 mod 的参考实现”。

---

## 职责与边界

### 做什么

1. **开/关 pane**：`/diff` 手动开关；主循环的第一次成功编辑可自动开启（`mods/diff/hooks/register.ts:478-516`）。
2. **探测 git 状态**：`git rev-parse` 定位仓库，`git status` 建立 baseline，`git diff --shortstat/--numstat` 取统计，`git diff --raw -z -p` 取 hunk，`git ls-files` 列未跟踪文件（见 `git/argv/` 与 `git/probes/`）。
3. **分类文件**：把 test / generated / binary 归为“噪声”，默认折叠（`mods/diff/hooks/classify/`）。
4. **渲染 pane**：docked 布局（`sidebar-pane`）或 inline 对话框（`dialog-pane`），JSX 组件树（`mods/diff/hooks/views/`）。
5. **响应引擎事件刷新**：编辑落地、shell 命令、外部 commit（HEAD 轮询）都触发重新 fetch。
6. **ask**：某文件的 hunk 附着到下一条 prompt 的 `context`，一次性（`mods/diff/hooks/ask/`）。
7. **遥测**：通过 `$.telemetry` 名词（属于 telemetry mod）打点（`mods/diff/hooks/record/`）。

### 不做什么（边界）

- **不拥有 git**：所有 git 访问经 `Backend` 抽象；git 只是默认实现，其它 VCS 可通过 `BackendProbe` 抢占（`mods/diff/hooks/backend/backend-of.ts:17-30`）。
- **不与其他 `/diff` 抢**：`session.start` 调 `$.command.register`，若内建 `/diff` 已注册（拒绝消息匹配 `BUILTIN_HOLDS_PATTERN`，`mods/diff/hooks/names/texts/builtin-holds-pattern.ts`），mod 静默闲置（`mods/diff/hooks/register.ts:645-654`）。
- **会话开始不碰 git**：`session.start` 只 bind host 与注册命令，不探测仓库（`mods/diff/tests/register.test.ts:52-62` 断言 `world.runs` 为空）。
- **不向模型主动喂数据**：唯一写给模型的通道是 `prompt.submit` 上的 ask context；`mods/diff/hooks/README`/测试强调 ask “calls no tool”（`mods/diff/tests/register.test.ts:954-990`）。
- **不在 mobile 上渲染**：`isOnPaneSurface` 排除 `mobile`（`mods/diff/hooks/is-on-pane-surface/is-on-pane-surface.ts`），且 `Ui` 类型只取 `terminal | desktop`（`mods/diff/hooks/views/kit/ui/ui.ts`）。
- **遥测是可选依赖**：`$.telemetry` 缺失时整行丢弃，其余行为不变（`mods/diff/hooks/record/safely/safely.ts`、`mods/diff/README.md:92-93`）。

---

## 关键抽象与接口

### `Host`

`session.start` 时从 `$` 一次性绑定的引擎句柄，把 `$.noun.event(...)` 逐条拼出来，供后续所有 hook / timer / press 使用（`mods/diff/hooks/host/host.ts:14-130`）：

```ts
export type Host = {
  now: () => Promise<number>            // $.clock.now
  after: TimerCall                      // $.clock.after
  every: TimerCall                      // $.clock.every
  run: (argv, init) => Promise<ProcessRunResult>   // $.process.run
  stat / listDir / readFile             // $.fs.stat / list / read
  storeGet / storeSet                   // $.store.get / set
  isCheckpointing: () => Promise<boolean>
  messages: () => Promise<SessionMessage[]>
  invalidate / status / uiLog           // $.ui.*
  openPane / closePane                  // $.ui.open / close
  registerCommand                       // $.command.register
  sessionId / startedAt                 // $.session.id / usage.startedAt
  mark / log                            // $.telemetry.*
}
```

这是 mod 与引擎之间**唯一的窄接口**：测试中可以用 engine 的 `$` + fixture 覆盖它（见 `tests/`）。

### Backend 契约族

`mods/diff/hooks/backend/types/` 下四个类型，构成“版本控制系统”抽象（每个名词一个文件夹，各自 `index.ts` barrel）：

- `Backend`（`.../backend/types/backend/backend.ts:11-46`）：`repository.toplevel`、`baseModes`、`words`、`fetchDiff(mode)`、`fetchHunks(data, files)`、`headKeyOf()`。
- `BackendHost`（`.../backend-host/backend-host.ts:12-23`）：pin 时需要的能力——`run`、`readFile`、`mtimeOf`、`entryKindsOf`、`nowMs`、`sessionStartMsOf`、`onBranchBase`。
- `BackendProbe`（`.../backend-probe/backend-probe.ts:10`）：`(host) => Promise<Backend | null>`，返回 `null` 即“让 git 接管”。
- `BackendWords`（`.../backend-words/backend-words.ts:9-30`）：`base`、`diffCommand`、`lister`、`untrackedNoteOf`，UI 文案里涉及后端的部分。

### Git 类型域

`mods/diff/hooks/git/types/` 逐名词一个文件夹，关键有：

- `Repository`：`{ toplevel, gitDir, commonDir }`（`.../repository/`）。
- `BaseMode`：`'session' | 'uncommitted' | 'branch'`（`.../base-mode/`）。
- `DiffData`（`.../diff-data/`）：一次 fetch 的完整结果——rows、totals、source、`baseRef`、`isUnborn`、`stalePaths`、`isUntrackedWithheld`。
- `FetchOutcome`：`no-repository | unavailable | data`（`.../fetch-outcome.ts`）。
- `FileStat`（`.../file-stat/`）：`path`、`renamedFrom`、`added`、`removed`、`isBinary`、`isUntracked`、`isPreSession`。
- `FileHunks` / `Hunk`：解析后的 body，`isTruncated`/`isLarge` 标志。
- `GitRun`：`(argv) => Promise<RunResult>`，**从不 reject**——失败是 exit code -1 的 `RunResult`（`.../git-run/`）。
- `GitDeps`（`.../git-deps/`）：fetch 抵达 host 的全部方式，含一次性读入的 `baseline`（dirty 路径集）。
- `StampProbe` / `KindWalk` / `WalkKind` / `Stamp`：按目录列表 + mtime 给文件“dating”的探针族。

### `PaneModel`

面板一次绘制的全部状态（`mods/diff/hooks/pane-state/pane-model/pane-model.ts:14-34`）：最近一次成功 fetch 的 `data`、`requestedMode`、`selectedPath`、`bodies`、`turns`、`todos`、`armedPath`、`placement`、`isFullscreen`、`dialogView`、`place` 等。初始值是一个 `Object.freeze` 的常量 `INITIAL_MODEL`（`.../initial-model/initial-model.ts`）。

更新风格是**不可变**的 spread：`model = { ...model, ... }`（`register.ts` 各处）。

### 视图层抽象

- `Kit`（`views/kit/kit.ts`）：一次绘制拿到的东西——`ui`（元素构造器）、`actions`（`PaneActions`）、`columns`、`rows`。
- `Ui`（`views/kit/ui/ui.ts`）：`Pick<ElementTable<'terminal' | 'desktop'>, 'Box' | 'Text' | 'Button' | 'Select' | 'Code'>`，来自 `$.ui.resolve(e)` 返回的冻结元素表。
- `PaneActions`（`views/pane-actions/pane-actions.ts`）：`selectFile`、`scrollList`、`toggleNoise`、`togglePreSession`、`cycleBase`、`chooseSource`、`toggleAsk`——由 `register.ts` 的 `actionsOf(engine)` 实现（`register.ts:535-613`）。
- `PaneSeat`（`views/pane-seat/pane-seat.ts`）：`placement: 'dock' | 'inline'` 与 `terminalColumns`。

### 遥测抽象

`Recorder`（`views`/`record/recorder/recorder.ts`）：`mark(feature, outcome)`、`shown(trigger, bucket)`、`asked()`。`recorderOf(host)` 用 `safely` 包裹每次发送（`record/recorder-of.ts`）。

### 引擎契约（来自 `mods/types/claude-code.d.ts`）

mod 只 `import type … from 'claude-code'`。关键类型：`On`、`Args<'event'>`、`ResultOf['tool.call']`、`PaneOpenArgs`（`claude-code.d.ts:5977`）、`PaneCloseArgs`（`:5936`）、`SessionMessage`、`Timer`、`RenderElement`、`ElementTable`。事件输入/结果成对声明，例如 `'ui.render': RenderInput`（`:3273`）与 `'ui.render': RenderElement`（`:3704`）。

---

## 数据流 / 时序

### 1. `session.start` — 绑定，不碰 git

`register.ts:656-698`：构造 `Host`（把 `$` 名词包一层），调 `bind()`：

- `bind()`（`register.ts:640-654`）先取 `sessionStartMs`（`startedAtOf`），设 `pin.cwd = cwd`，`engine.registerCommand(COMMAND_SPEC)`，成功后 `host = engine`。
- `registerCommand` 拒绝且匹配内建模式则静默；否则 `uiLog` 一行“不可用”（`register.ts:647-653`）。
- 随后 `openOnRestore(host)`（不等待）：读 transcript 的 turns，若有编辑则按“第一次编辑”的同样条件开面板（`register.ts:518-527`）。

`COMMAND_SPEC` 只有 `name`/`description`（`command-spec/command-spec.ts`）。

### 2. `ui.render` of `PromptHint` — 量宽

`register.ts:700-719`：若非 mobile 表面，读 `e.viewport.columns` 与 `e.viewport.isFullscreen` 存入 `columns`/`model.isFullscreen`。首次量到宽度且 transcript 已有编辑时，触发 `openOnFirstEdit`（支持 resume 场景）。

### 3. `/diff`（`command.run`）— pin + 开/关

`register.ts:768-817`：

1. `pinBackend(host)`（连调两次，见下）。
2. 无 backend → 返回 `NOT_IN_REPOSITORY_TEXT` 或 `GIT_UNANSWERED_TEXT`。
3. 由 `e.presentation` 取 `isFullscreen`/`columns`。
4. `PaneToggle.paneToggleOf({ isOpen, columns })` → `'open' | 'close' | 'too-narrow'`（`pane-toggle/pane-toggle-of.ts`）；`too-narrow` 返回 `RESIZE_TERMINAL_TEXT`。
5. `open` → `openPane(host, 'manual')`；`close` → `closePane`。
6. 记录 `markTabSwitch`，写 `$.store`（`STORE_OPEN_KEY`）。返回 `Diff panel shown|hidden` 或对话框文案。

### 4. `pinBackend` / `probeBackend` — 一次探测，结果被复用

- `pinBackend`（`register.ts:107-117`）：若已有 backend 或 `pin.isEmpty` 直接 `true`；否则共用同一个 `probing` Promise（并发 `/diff` 只探一次，测试 `register.test.ts:233-250` 验证）。
- `probeBackend`（`register.ts:119-167`）：
  - 用 `backendHostOf(engine)` 包出 `BackendHost`；记录 `epoch` 快照。
  - `Backend.backendOf(host, Backend.INSTALLED_BACKEND_PROBES)`。
  - 若 `epoch` 变了（期间发生 `/clear`）返回 `false`。
  - 设 `backend`、`pin.isEmpty`；`startPoll`；从 `$.store` 读回该仓库上次选择的 base mode，若在当前 `baseModes` 内则设 `model.requestedMode`。
- `backendOf`（`backend/backend-of.ts:17-30`）：先逐个跑外部 probe，否则 `Git.gitBackendOf(host)`。
- `INSTALLED_BACKEND_PROBES`（`backend/installed-backend-probes.ts:12`）是模块级 `Set`，**默认空**；宿主编译时在注册前注入（注释标为 `module-state-allow`）。

错误区分（`register.ts:126-135`）：`process.run` 的异常若形如 `aborted` 且是 `git`，视为“未应答”（timeout），`pin.isEmpty` 不被误置；`git` 无法启动则是“已应答的 not-a-repository”（测试 `register.test.ts:272-281`、`:1118-1138`）。

### 5. `refresh` — 一次 fetch 的生命周期

`register.ts:322-391`（带重入保护 `isRefreshing`/`isRefreshQueued`）：

1. `pinned.fetchDiff(model.requestedMode)` 与 `engine.messages()` 并行。
2. `PaneState.afterFetch(model, { outcome, messages })` 写入 `data`/`turns`/`todos`；`unavailable` 时保留旧 `data`（最后一份好 diff 留在屏上）（`pane-state/after-fetch/after-fetch.ts`）。
3. outcome `data` → `generation += 1`；`unavailable` → 遥测打 `git_diff_failed`。
4. `loadBodies(engine)` 取 hunk。
5. `finally` 里 `redraw`，若有 queued 再 `scheduleRefresh`。

`scheduleRefresh`（`register.ts:393-403`）用 `REFRESH_DEBOUNCE_MS`（150ms，`limits/timing/refresh-debounce-ms.ts`）做 trailing-edge 去抖，一串编辑只 fetch 一次。

### 6. `fetchDiff` 内部（git 侧）

`git/fetch-diff/fetch-diff.ts:16-33`：

1. `Probes.isTransient(entryKindsOf, gitDir)`：看 `.git` 下的状态文件/目录判断是否 mid-merge/rebase/cherry-pick/revert（`git/probes/is-transient.ts`），是则 `unavailable`。
2. `Tiers.fetchContextOf(deps, mode)` 造共享上下文（含一个 `stampProbeOf`）。
3. `branch` 模式走 `Tiers.branchTier`，否则 `Tiers.workingTreeTier`。

`workingTreeTier`（`git/tiers/working-tree-tier.ts`）与 `branchTier`（`git/tiers/branch-tier.ts`）：`Probes.statsOf(context, base)` 拿短统计与行 → 失败则尝试 `unbornTier`（unborn HEAD 是唯一“永久性”失败原因，用 `--cached` 读，叠加 unstaged；`git/tiers/unborn-tier/`）。成功则 `withUntracked`（合并未跟踪 0/0 行）后 `diffDataOf` 成 `DiffData`。

`statsOf`（`git/probes/stats-of.ts`）**先跑 `--shortstat`**：文件数超过 `MAX_FILES_FOR_DETAILS`（500）就只返回 totals，**不再跑 `--numstat`、不列 untracked**（性能关键，见下）。

### 7. `fetchHunks` — 一次子进程读全部 body

`git/fetch-hunks/fetch-hunks.ts:22-87`：

- 过滤出“有 body”的行：非 untracked、非 binary、非 rename、不在 `stalePaths`。
- 其余直接给 `EMPTY_FILE_HUNKS`。
- 取路径并累加长度，超过 `MAX_PATHSPEC_CHARS` 的路径不进这个子进程（转下轮）。
- 一次 `run(['--literal-pathspecs', ...DIFF_LEADING_ARGS, ...HUNKS_ARGS, baseRef, '--', ...asked])`（`--raw -z -p`）。
- `Parse.parseFileDiffs(stdout, asked)` 校验 names/patches 是否配得上；没配上的再递归取。
- 结果按顺序（除最后一个）补空行 `withClosingLine`。

### 8. `loadBodies` / `fetchBodies` — 增量取 body

`register.ts:216-270`：

- `bodyStampOf(data) = `${generation}|${data.baseRef}``，base 变了就清空 `bodies` 与 `bodyLoads`。
- `drawnFilesOf(model)` 算出“当前会画的行”，过滤掉已加载的，`backend.fetchHunks(data, files)`，把结果并进 `model.bodies`，`redraw`。
- 若返回含 `null`（读失败）→ 遥测 `git_hunks_failed`。

`drawnFilesOf`（`drawn-files-of/drawn-files-of.ts`）区分 docked（列出 session 行 + 展开的 pre-session 行，受 `PRE_SESSION_BODY_CAP` 限）与 inline（仅窗口内 `MAX_VISIBLE_FILES` 行，turn 时为空）。

### 9. `startPoll` — 外部 commit 感知

`register.ts:291-320`：以 `engine.every(HEAD_POLL_MS=2000ms)` 轮询 `pinned.headKeyOf()`；仅当 pane 开着，且 key 变了才 `scheduleRefresh`。`headKeyOf` 读 HEAD 文本 + 相关文件 mtime（见 `git/probes/head-key-of/`）。

### 10. `tool.call` — 编辑/命令触发

`register.ts:970-986` 钩住 `{ tool: [...EDITING_TOOLS, ...SHELL_TOOLS] }`（`Edit/Write/NotebookEdit/Bash/PowerShell`），在 `finally` 里 `afterTool`：

`afterTool`（`register.ts:940-968`）：

- 编辑工具且结果不是 deny/error → `hasEdited`（`landed += 1`）。
- shell 工具 → `Tools.mayHaveWritten(result)`：抛异常或正常返回都算“可能写过”，除非引擎标了 `isReadOnly`；deny 永不算（`tools/may-have-written.ts`）。
- `hasLanded && isPaneOpen` → `scheduleRefresh`。
- 仅**主循环**（`e.agentId === undefined`）的成功编辑 → `openOnFirstEdit`。

### 11. `openOnFirstEdit` — 首次编辑自动开

`register.ts:478-516`：逐条门槛——未开且未自动开过；读偏好 `STORE_OPEN_KEY`（未表态用 `AUTO_OPEN_MIN_COLUMNS=144`，曾保留用 `OPEN_MIN_COLUMNS=110`，曾关闭则不动）；必须是 fullscreen 且宽度够；`isCheckpointing()`；`pinBackend`；成功才 `openPane(engine, 'auto_open')`。

### 12. `openPane` / `closePane`

`openPane`（`register.ts:417-464`）：清选择与滚动、`dialogRows`；docked 先 `await refresh`（避免落到 `Loading diff…`）；`engine.openPane(...)`；若返回 `{ isPlaced: false }`（宽度不够被引擎留空）→ 立即 `closePane` 撤回，返回 `false`；成功则 `isPaneOpen = true`、`keepBaseline`、`markShown`，若 stale 再 `refresh`。

### 13. 渲染：`ui.render` of `Pane`

`register.ts:721-766`：仅处理 `e.requestId === PANE_ID` 且非 mobile。`$.ui.resolve(e)` 取元素；把 `e.props.placement`、`e.props.bodyColumns`、`e.props.scroll.bodyRows` 写回 model.place；若座位变了（`isReseated`）则 `loadBodies`；返回 `Views.paneView({ ui, actions, columns, rows }, model, { placement, terminalColumns })`。

`paneView`（`views/pane-view.tsx:29-51`）：docked → `sidebarPane(insetOf(kit), model)`；inline 且窄且有 fullscreen → `dimNote(RESIZE_TERMINAL_TEXT)`；否则 `dialogPane`。

### 14. `prompt.submit` — ask 携带

`register.ts:988-1034`：若 `armed` 且未在 carrying，把 `asked.text` 用 `fittedAskTextOf` 裁到剩余 context 预算（`PROMPT_CONTEXT_MAX_CHARS=32000` 减去已有 context）；放不下就 disarm 并 status 一行；放得下则 `next({ ...e, context: [...context, text] })`；`next` 未被 drop 则记 `asked()` 并 disarm。

### 15. `command.run` of `clear|resume`

`register.ts:899-938`：`next` 后 `unpin()`（清 backend、poll、清空 `polled`），重置 `hasAutoOpened/hasRestoredEdits/bodies`，`disarm`，`model = afterNewSession(model)`，重置 `sessionStartMs`。`/clear` 保留开着的 pane 并重新 pin + refresh；`/resume` 关 pane 并 `openOnRestore`。

### 16. `ui.close` / `ui.focus` / `ui.scroll`

- `ui.close`（`register.ts:819-854`）：inline 且 view 为 `detail` 且 person 关闭 → 退回 list 并拒绝本次 close（`{ deny: 'back to the file list' }`）。否则走 `next`；person 关闭且 docked 时记 `markTabSwitch('convo')` 并写 store。
- `ui.focus`（`register.ts:856-876`）：inline list 时用 `dialogFocusOf` 求选择与落焦 key；`stay` 则吞掉；否则改 model、loadBodies、`fitDialog`、`invalidate`，`next({ ...e, element })` 落焦。
- `ui.scroll`（`register.ts:878-897`）：docked 且 person 滚轮时，`isWheelOverList` 决定滚列表还是 body（`listScrolledBy`/`bodyScrolledBy`），`host.invalidate()`，吞掉事件。

### 17. redraw / fitDialog

- `redraw`（`register.ts:200-214`）：先 `fitDialog`（inline dialog 行数变了就重开 pane 调整高度），再用 `engine.after(REDRAW_COALESCE_MS=100ms)` 合并成一次 `engine.invalidate()`。
- `markShown`（`register.ts:405-415`）：同一 session 只打一次 `tengu_repl_diff_panel_shown`。

---

## 扩展点

1. **其它版本控制系统**：`BackendProbe` + `INSTALLED_BACKEND_PROBES`。宿主在注册前注入 probe，probe 可凭自己的规则抢占目录（“nearer of two markers”），返回 `null` 让 git 接管（`backend/backend-of.ts:4-16`）。`BackendWords` 让 UI 文案不写死 git。
2. **文案/常量**：`names/`（命令名、pane id/title、store key、各种文本）与 `limits/`（列宽、字节、时序上限）都是独立小模块，替换即可。
3. **`COMMAND_SPEC`**：`/diff` 命令 spec 的单一构造点，未来 CommandSpec 字段在此加（`command-spec/command-spec.ts`）。
4. **遥测特征名**：`record/features/features.ts` 与内建同名，保证换装后特征序列连续。
5. **模块装配**：`hooks/hooks.json` 的 `modules` 数组；当前只有 `./register.ts`。子模块通过 `hooks/index.ts` 统一 barrel 导出。
6. **后端探测顺序、baseModes**：`GIT_BASE_MODES` 决定 picker 顺序（`git/git-base-modes/`）。
7. **工具集**：`tools/editing-tools.ts` / `shell-tools.ts` / `todo-tool.ts`——新工具名加进常量即可被计入刷新/自动开触发。

---

## 设计决策与权衡

### A. “一个关注点一个文件夹/文件”的分解风格

这是本 mod 最值得学习的设计。`hooks/` 下几乎每个概念都是自己的目录：

```
array-of/  count-of/  kept-of/        # 泛型小工具
is-record/  message-of/               # 类型守卫/转换
mtime-of/  entry-kinds-of/            # host 探针适配
drawn-files-of/  entry-kinds-of/      # 派生量
git/  backend/  classify/  pane-state/  views/  ask/  turns/
todos/  tools/  record/  limits/  names/  pane-toggle/
```

约定：

- 每个目录一个 `index.ts` barrel（`export * from './x.js'` + `export * as default from '.'`），根 `hooks/index.ts` 再聚合成 `export * from './register.js'`。
- 一个概念一个类型文件，文件里通常只有**一个函数或一个类型**，并带一段解释“为什么/与内建如何对齐”的文档注释。

好处：可测试性（`tests/` 与 `hooks/` 一一对应，如 `git.test.ts` 对 `hooks/git/`）、可替换性（换文案换 `names/`）、可读性（`register.ts` 只编排，细节下沉）。例如 `register.ts` 的 `probeBackend` 读起来像伪代码，因为它把 `epoch`、`pin`、`store` 等细节留在小模块里。

权衡：文件数极多（823 个），导航靠 barrel 和命名约定；小模块的文档注释成本高，但换来“零意外行为”。

### B. git 调用被“钉死”（pinning）

`gitBackendOf`（`git/git-backend-of.ts:23-79`）：

- 先用 `runOf(null)`（不带 pin）跑 `rev-parse`；找到 `Repository` 后所有后续子进程都带 `Argv.pinnedLeadOf(repository)`（`--git-dir=<gitDir> --work-tree=<toplevel>`）。
- 每个子进程 `{ timeoutMs: GIT_TIMEOUT_MS(5000), env: GIT_CHILD_ENV, cwd: toplevel }`（`git-backend-of.ts:26-40`）。
- `GIT_CHILD_ENV = { LC_ALL: 'C', LANGUAGE: '' }`：让 `--shortstat`、git 消息在各环境一致解析（`git/argv/git-child-env/`）。
- `DIFF_LEADING_ARGS`（`git/argv/diff-leading-args.ts`）：`--no-optional-locks`、`-c diff.relative=false`、`-c core.quotePath=false`、`diff --no-ext-diff --no-textconv --ignore-submodules=dirty --submodule=short`——让路径始终相对仓库根、非 ASCII 按字节、不取 index 锁、不跑外部 diff/textconv。
- `--git-dir` 使 git 不从 cwd 发现仓库，嵌套仓库不会误读。

权衡：牺牲“跟随用户的 git 设置”换确定性/可解析性。

### C. 只在需要时探测仓库

`session.start` 不跑 git；仓库在 `/diff` 或“有空间的首个编辑”时才探测；探测结果（含“无仓库”）被记住，直到 `/clear`/`/resume`（`register.ts:169-177`、测试 `register.test.ts:1035-1090`）。这避免了每个会话启动时的 git 开销。

`rev-parse` 要求**恰好三行且都是绝对路径**，否则视为无仓库（防老版本 git 把 `--path-format` 回显成一行，`git/probes/repository-of/`）。

### D. baseline：一次 `git status` 建立“会话前脏路径”

第一次 fetch 时 `dirtyPathsOf(run)` 跑一次 `git status --porcelain -z --untracked-files=all --no-renames --ignore-submodules=dirty`（`git/probes/dirty-paths-of/`），结果 `ReadonlySet<string>` 作为 `GitDeps.baseline` 复用。用途：判断一个旧时间戳文件的“旧”是否可信——不在 baseline 里的路径是后来才出现的（rename 的新名、moved-in 文件），不算 pre-session（`git/probes/was-dirty-at-start/`）。

这是**用一次盘查换多次 dating 的正确性**的设计。

### E. session 模式与 pre-session 分区

base mode 三种：`session`（默认，以 `$.session.usage().startedAt` 为界）、`uncommitted`（纯 HEAD）、`branch`（与默认分支 merge-base）。选择按仓库持久化（`base:<toplevel>`，`names/keys/base-store-key-of.ts`）。

`FileStat.isPreSession` 仅在 session 模式由 `tagPreSession` 打标：mtime 早于 `sessionStartMs` **且** baseline 里已有该路径（`git/probes/tag-pre-session.ts`）。`partitionOf` 再按 `isPreSession`/noise 分组、按 `displayPathOf` 排序（`pane-state/partition-of.ts`）。

### F. 文件分类（test / generated / binary）

`classify/` 是纯函数，规则与引擎内建面板一致（Linguist 风格）：

- `isNoiseFile = isTestFile || isGeneratedFile`（`classify/is-noise-file.ts`）。
- `isTestFile`：`rootedPathOf(path)` 含 `TEST_DIRECTORIES`（`/test/`、`/__tests__/`、`/fixtures/`…，`rootedPathOf` 补前导 `/` 以便相对路径也匹配）**或** basename 匹配 `TEST_FILENAME_PATTERNS`（`.test.`、`.spec.`、`_test.`、`.snap`）（`classify/is-test-file/`）。
- `isGeneratedFile`：`GENERATED_FILENAMES`（lockfile 集合）+ `GENERATED_SUFFIXES`（`.lock`、`.min.js`、`.d.ts`…）+ `GENERATED_DIRECTORIES`（`/dist/`、`/node_modules/`…）+ `GENERATED_FILENAME_PATTERNS`（`.pb.go`、`_pb2.py`、`.generated.`…）（`classify/is-generated-file/`）。

**为什么**：噪声文件的 hunk 淹没真正的改动。分类让它们默认折叠（`isNoiseShown`），`partitionOf` 把它们从 `shown` 剔除但记 `noiseCount`，UI 上给一个可点开的计数（`body/plan` 里的 `hasNoise`）。

测试 `tests/classify/is-noise-file.test.ts` 断言 `src/contest/entry.ts`、`src/latest.ts`、`README.md` **不是**噪声——用 basename 模式而非子串匹配避免误伤。

### G. binary / untracked / rename 的 body 处理

- untracked：`ls-files -z --others --exclude-standard --full-name` 列出，作为 0/0 行（`git/probes/untracked-files/`）。
- binary：`--numstat` 给 `- -`（解析为 `isBinary`），不请求 body（`fetch-hunks.ts:27-34`）。
- rename：`--no-renames` 使每侧重名，`renameDisplayOf` 复刻 `git diff --stat` 的 `{a => b}` 展示（`git/rename-display-of/`、`git/display-path-of/`）。

### H. 性能设计（limits/ 是核心）

`limits/` 每项一个说明，很多标注“内建面板的同一上限”：

- **两段式统计**：`statsOf` 先 `--shortstat`；`filesCount > MAX_FILES_FOR_DETAILS(500)` 时只留 totals，跳过 `--numstat` 与 untracked 列表（`git/probes/stats-of.ts`）。这是最大的一道性能闸。
- **一次 hunk 子进程**：`fetchHunks` 用 `--raw -z -p` 一次读最多 `MAX_FILES(50)` 个文件（`git/fetch-hunks/`，测试 `git.test.ts:75-113` 验证“one hunks child a read”）。
- **pathspec 长度上限**：`MAX_PATHSPEC_CHARS`，超长路径进后续子进程。
- **切 hunk**：`MAX_LINES_PER_FILE(400)`（`git/cut-hunks/`），超过标 `isTruncated`，UI 显示“… diff truncated (exceeded 400 line limit)”。
- **大文件**：`MAX_DIFF_BYTES(1_000_000)`，超过则 `LARGE_FILE_HUNKS`（不解析 hunk，`isLarge`）。
- **host 输出上限**：`HOST_OUTPUT_CAP_BYTES(4MB)`，被截断的 `-z` 列表通过 `isWholeAnswer`/`isWholeListing` 识别为“非整答”，放弃解析。
- **dating 预算**：`MAX_LISTED_DIRECTORIES(512)`、`MAX_UNTRACKED_PROBES(500)`；`kindWalkOf` 的每个目录只列一次，且**按预算停止**（`over-budget`），避免病态目录树。
- **时序**：`REFRESH_DEBOUNCE_MS(150)`、`REDRAW_COALESCE_MS(100)`、`HEAD_POLL_MS(2000)`、`GIT_TIMEOUT_MS(5000)`。
- **绘制窗口**：`MAX_SUMMARY_ROWS(8)`、`MAX_VISIBLE_FILES(5)`、`SCROLL_MARGIN_ROWS(8)`、`WHEEL_ROWS(3)`、`PRE_SESSION_BODY_CAP(20)`。

关于“`mtime-of/` 缓存”：`mtime-of.ts` 本身只是一个 `stat(...).then(s => s.mtimeMs, () => null)` 的适配器，**没有缓存**。真正的复用发生在 `kindWalkOf` 内部的 `listings: Map`（同一目录只列一次）与 `dirtyPathsOf` 的 baseline 的一次性读取。`was-dirty-at-start` 用 baseline 避免重复判断。

### I. heading 的“逐步加载”体感

`openPane` 对 docked 面板先 `await refresh` 再 open，避免闪现 `Loading diff…`（`register.ts:432-437`）；若引擎因宽度把 open 留作未放置，立即撤回，避免之后 resize 把它“坐”出来（`register.ts:444-450`，测试 `register.test.ts:607-702`）。

### J. 手动 ask 的一次性语义

`armed`（`ArmedAsk`）保存 path + 文本；`carrying` 防止同一条 ask 在一轮 `next` 链里重复插入；`prompt.submit` 后若未被 drop 才 disarm（`register.ts:988-1034`）。`fittedAskTextOf` 在预算内整段携带，否则取前若干行 + `ASK_CUT_NOTE`；连第一行都放不下则 `undefined` → 丢弃并提示（`ask/fitted-ask-text-of.ts`）。

### K. 内建对齐（可替换性）

大量注释明确“与内建面板同一措辞/同一常量/同一特征名”（如 `record/features`、`names/texts/*`、`limits/*` 的多处 “ReplDiffSidebar's …”）。这是为了让该 mod 能**无缝替换**内建 `/diff`（在 `$.telemetry` 上保持同一 series，在文案与行为上保持连续）。

### L. 可选依赖的健壮性

`Recorder` 的每个方法经 `safely` 包裹：`$.telemetry` 缺失会同步抛，被 `try/catch` 吞；被拒绝的 row 也会 catch（`record/safely/safely.ts`）。因此没有 telemetry mod 时 diff 完全正常。

---

## 对复刻产品的启示

1. **把“引擎句柄”收成一个窄接口**（`Host`）：业务代码只依赖这 20 来个方法，测试可用 engine 的 `$` + fixtures 直接替换，无需 mock 整个引擎。
2. **后端抽象要早做**：`Backend`/`BackendProbe`/`BackendWords` 三层，让“git 只是默认实现”从一开始成立；否则后期接别的 VCS 会到处漏 git。
3. **“一次探测、结果复用、失败也记住”**：`pinBackend` 的 Promise 去重 + `pin.isEmpty` + `epoch` 快照，是并发与生命周期竞态的标准解法。
4. **性能闸放最前**：先 `--shortstat`，超阈值直接退化到只显示 totals。UI 类产品尤其要避免“先取全量再裁剪”。
5. **用一次昂贵操作换后续正确性**：`status` baseline 让 dating 正确，`kindWalk` 的目录 memo 避免重复 list。
6. **不可变模型 + 派生子模块**：`PaneModel` 全用 spread 更新，`partitionOf`/`drawnFilesOf`/`headerTotalsOf` 都是纯函数从 model 派生——易测易调。
7. **一概念一文件夹**：可测试性与可替换性极高；代价是文件多，靠 barrel + 文档注释导航。若产品规模小，可退化为“一概念一文件”。
8. **交互事件要“吞掉/放行”明确**：`ui.scroll`/`ui.focus`/`ui.close` 通过返回 `{}` 表示处理、`next(e)` 表示放行、`{ deny }` 表示拒绝——这是 hook 链的关键协议。
9. **文案与遥测走独立常量模块**：便于本地化、A/B、与既有内建保持同一特征 series。
10. **可选依赖必须静默降级**：`safely` 模式适用于任何“有则更好、无则照常”的能力。

---

## 关键文件索引

| 路径 | 角色 |
| --- | --- |
| `mods/diff/.claude-plugin/plugin.json` | 插件清单（name/version/description） |
| `mods/diff/hooks/hooks.json` | hooks module 清单（`./register.ts`）+ 描述 |
| `mods/diff/hooks/register.ts` | 唯一入口：所有事件编排、状态、开/关 pane、刷新、ask |
| `mods/diff/hooks/index.ts` | 汇聚所有子模块的 barrel |
| `mods/diff/README.md` | 行为总览 + “What it hooks”事件表 + “What it calls on `$`” |
| `mods/README.md` | mod/hook 模型、测试套件（`claude plugin test mods/diff`）、noun 契约 |
| `mods/types/claude-code.d.ts` | 引擎类型契约（事件 Args/Results、PaneOpenArgs、ElementTable…） |
| `mods/diff/hooks/host/host.ts` | `Host` 类型：窄引擎接口 |
| `mods/diff/hooks/backend/backend-of.ts` | probe-优先的后端选择 |
| `mods/diff/hooks/backend/types/*` | `Backend`/`BackendHost`/`BackendProbe`/`BackendWords` |
| `mods/diff/hooks/backend/installed-backend-probes.ts` | 外部 VCS probe 注入点（默认空） |
| `mods/diff/hooks/git/git-backend-of.ts` | git 后端实现（pin、超时、env、deps） |
| `mods/diff/hooks/git/argv/*` | git 参数常量（pin lead、diff 前缀、hunks 参数、C locale、no-optional-locks） |
| `mods/diff/hooks/git/probes/*` | `rev-parse`/`status`/`head-key`/`stats`/untracked/dating/is-transient 等探针 |
| `mods/diff/hooks/git/tiers/*` | working-tree / branch / unborn 三种 fetch 分层 + untracked 合并 |
| `mods/diff/hooks/git/fetch-diff/fetch-diff.ts` | 一次 fetch 入口 |
| `mods/diff/hooks/git/fetch-hunks/fetch-hunks.ts` | 一次子进程读全部 body |
| `mods/diff/hooks/git/parse/*` | `--numstat`/`--shortstat`/`--raw -z -p`/rename/`isWholeAnswer` 解析 |
| `mods/diff/hooks/git/types/*` | git 类型域（Repository/DiffData/FileStat/Hunk/GitDeps…） |
| `mods/diff/hooks/classify/*` | test/generated/noise 判定 |
| `mods/diff/hooks/limits/*` | 所有上限与时长常量 |
| `mods/diff/hooks/names/*` | 命令名、pane id/title、store key、全部 UI 文案 |
| `mods/diff/hooks/pane-state/*` | `PaneModel`、`afterFetch`、`partitionOf`、`modeLabelOf`、`emptyStateOf` 等 |
| `mods/diff/hooks/pane-toggle/*` | `/diff` 开/关/太窄的单一决策点 |
| `mods/diff/hooks/ask/*` | ask 文本构造、裁剪、`ArmedAsk` |
| `mods/diff/hooks/tools/*` | 编辑/命令/todo 工具名与 `mayHaveWritten` |
| `mods/diff/hooks/turns/*` | 从 transcript 重组每轮编辑（source picker 的 `T<n>`） |
| `mods/diff/hooks/todos/*` | 从 `TodoWrite` 结果算进度条 |
| `mods/diff/hooks/record/*` | telemetry 特征名、recorder、safe 包裹 |
| `mods/diff/hooks/views/pane-view.tsx` | 顶层视图分派（docked/inline/太窄） |
| `mods/diff/hooks/views/sidebar-pane/sidebar-pane.tsx` | docked 面板布局 |
| `mods/diff/hooks/views/dialog-pane/dialog-pane.tsx` | inline 对话框 |
| `mods/diff/hooks/views/body/*` | docked body 的段/窗口/滚动计算 |
| `mods/diff/hooks/views/detail/*` | 单文件 hunk 详情（`Code` diff 块） |
| `mods/diff/hooks/views/sections/*` | 各类可点击行/头部/图例/来源选择器 |
| `mods/diff/hooks/views/kit/*` | `Kit`/`Ui` 元素表 |
| `mods/diff/tests/register.test.ts` | 行为总规格（git 调用时机、自动开、ask、resume…） |
| `mods/diff/tests/git.test.ts` | git 调用形态与性能断言 |
| `mods/diff/tests/backend/backend-of.test.ts` | probe 顺序与抢占语义 |
| `mods/diff/tests/fixtures/*` | 共享 fixture（REPOSITORY、inRepository、mock kit 等） |

---

## 存疑与待确认

1. **`INSTALLED_BACKEND_PROBES` 的实际注入者**：源码中它是空的模块级 `Set`，注释说“编译宿主在注册前注入”。仓库内未见注入代码，`claude-code.d.ts` 也未声明该通道。待确认：真实二进制里是否/何时注入非 git probe。
2. **`mtime-of/` 的“缓存”**：任务描述提到 “`mtime-of/` caching”，但 `hooks/mtime-of/mtime-of.ts` 只是一次 `stat` 的适配器，无缓存。真正的复用是 `kindWalkOf` 中的 `listings` Map 与 baseline。此处以代码为准，任务措辞可能指代 `kind-walk` 的目录 memo，存疑。
3. **`$.telemetry` 名词的提供方**：`host.ts` 注释称它是 telemetry 内建的名词，缺失时 diff 正常。`mods/README.md:98-107` 说明了 noun 契约机制；但 diff 与 telemetry 的实际装配（谁在 `engine.create` 折叠里加 `$.telemetry`）未在本子树内展开。
4. **`ui.render` 缓存与 `invalidate` 语义的细节**：`register.ts` 大量依赖 `engine.invalidate()` 触发重画；`claude-code.d.ts:2049-2059` 说 `ui.render` 结果被缓存、`invalidate` 重跑。其精确的每秒重画上限（注释称“ten a second”，面板 30）与本地观测是否一致，未在测试中覆盖。
5. **`views/` 部分未被逐一细读**：`views/sections/header-view.tsx`、`file-row`、`legend-row`、`list-row`、`name-row`、`title-row`、`todo-bar`、`views/layout/*`（`cell-width`、`wide-ranges`、`wrapped-lines`、`tab-width`）、`views/detail/code-blocks-of` 的内部算法在本分析中只按调用方语义概述，未逐行核对其宽度/换行/截断实现。
6. **`branch` 模式的完整判定**：`branch-base-of.ts` 覆盖了 `origin/HEAD`→约定名→`main`、`--is-ancestor` 比较本地/远端 base 等，但未与引擎内建面板的判定逐条比对（注释声称一致，未独立验证）。
7. **`stalePaths`（unborn HEAD 上 staged 后又编辑的文件）**与 `untrackedRowsOf` 的 `slots`/`scope` 边界行为，只读了实现与注释，未见直接针对边界（如恰好 `MAX_UNTRACKED_PROBES`）的测试断言。
8. **`mods/tsconfig.json` 的 `include`**：包含 `"*/types/**/*.d.ts"`，但 `mods/diff/` 下没有 `types/`（diff 的类型契约来自 `mods/types/claude-code.d.ts` 与 `telemetry/types`）。若复刻时需给 diff 增加自定义 noun，应参照 telemetry 的 `types/index.d.ts` 模式。
