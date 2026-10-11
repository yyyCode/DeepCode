# DeepCode P5c 实施计划：diff 分屏

> **给执行者：** 逐任务做，任务级验收只跑 `pnpm typecheck`；**测试按检查点批量做**（用户长期指令：
> 一次校验多个任务，争取快速完成开发）。任务之间连续执行，不要停下来问。
>
> 上位文档：[`2026-10-11-deepcode-p5-design.md`](../specs/2026-10-11-deepcode-p5-design.md) §5。
> 同体例先例：[`2026-10-11-deepcode-p5b.md`](2026-10-11-deepcode-p5b.md)。
> 参考实现：[`claude-code-架构分析/03-mod-diff.md`](../../../claude-code-架构分析/03-mod-diff.md)。

**目标**：把 `src/cli/diff.ts` 的纯逻辑搬进 `mods/diff/`，让 `/diff` 从"打印一串行"变成
"一个有表头的块"，并让 `git` 成为**第一个真可选依赖** —— 拿掉它，`/diff` 降级、其余一切照常。

**今天的形状**：`src/cli/diff.ts`（213 行，纯算法 + 上色混在一起）；`/diff` 由
`src/cli/commands.ts` 应答，只打印本会话改过的文件。没有 mod、没有探针、没有后端抽象。

---

## 1. 判定：三件事，九条分寸

### 1.1 只做三件事（§5.2）

| 抄什么 | 我们落成什么 |
| --- | --- |
| 不可变 `PaneModel` + 纯函数派生 | `mods/diff/pane.ts`：模型全 `readonly`，`headerTotalsOf` / `partitionOf` 是纯函数 |
| 后端抽象三层 | `mods/diff/backend.ts`：`Backend` / `BackendProbe` / `BackendWords` + `backendOf`（探针优先） |
| 性能闸放最前 | `mods/diff/pane.ts` 的 `FILE_LIMIT`：先只问"有几个文件"（便宜），超阈值就**不再问逐文件**（贵） |

### 1.2 分屏是什么（§5.1）

我们只有一个 surface，所以 **pane = 一块有表头的块**，不是真·侧栏：

```
── 工作区改动 · git ──  3 个文件  +42 −7
[本会话改动]
  src/cli/diff.ts: ...
[工作区未提交]
  src/cli/main.ts: ...
```

两块**来源不同、所有者不同**，这是本片最重要的一个判断：

- **「本会话改动」**：数据在 CLI 手里（`cli/changes.ts` 那张表，由 `tool.call` 记录）。
  `/diff` 今天打的就是它，**原样保留** —— 那件事没有任何毛病，P5c 不是来推翻它的。
- **「工作区未提交」**：数据要靠 `git` 去问。**这一块归 mod**，也就只有它会在 git 缺席时消失。
  §5.3 判据一（"把 git 从 PATH 里拿掉 → `/diff` 降级"）说的正是这一块。

### 1.3 九条分寸

1. **模型归 mod，渲染归 cli。** 边界规则（`scripts/check-boundaries.mjs`）不允许 mod import
   `cli/ansi`，而 §3.2 明说**不许把 `ansi.ts` 搬进 mod 糊过去**。所以 mod 产出**数据**
   （哪一行是 add、表头写什么），着色留在 `src/cli/diff-render.ts`。
   渲染器**从外面注入**（`builtinMods(render)`），mod 一个字都不认识 CLI —— 与遥测的
   `deps.sink` 同一个做法。
2. **`git` 不在 → mod 不装 → CLI 注册一句人话的 `/diff`。** 因果链要能被测试钉住，
   而不是靠读代码相信。装上了就**只有 mod 应答** `/diff`（免得两条应答者抢同一条命令）。
3. **探针失败 → 降级；`create` 抛 → 也降级但必须吼。** P5a 立的分寸原样沿用，这一片只是
   第一个**真**消费者。
4. **先取小再决定要不要取大。** `list()`（`status --porcelain`，便宜）拿到文件数；
   超 `FILE_LIMIT` 就**一个字节的逐文件调用都不发**。
5. **git 调用有超时**（`GIT_TIMEOUT_MS = 5000`）且 `--no-optional-locks` —— 一个卡住的 git
   不该让 `/diff` 卡住。
6. **`run` 是注入的。** git 后端不直接 `execFile`，它拿一个 `GitRunner`；生产给真的，
   测试给假的。这样"600 个文件走退化路径"能测，而不是造一个真改了 600 个文件的仓库。
7. **`/diff` 的老输出逐字节不变**（mod 没装时）。`test/cli.test.ts` 那 5 条断言原样留着当回归。
8. **不新增事件名。** 这一片不需要事件（mod 自己应答命令），于是事件目录仍是
   41 声明 / 22 实现，三处文档计数不动。
9. **mod 自己带测试套件**（`mods/diff/test/`），`pnpm vitest run mods/diff` 必须绿 ——
   这是 §9.3 出口标准第一条"三个内建 mod 全部通过各自测试套件"的第三格（前两格 P5a 已交）。

---

## 2. 文件结构

**新建**

| 路径 | 责任 |
| --- | --- |
| `mods/diff/lines.ts` | 纯算法：`DiffLine` / `Hunk` / `splitLines` / `diffLines` / `toHunks`（从 `src/cli/diff.ts` 搬） |
| `mods/diff/pane.ts` | `PaneModel` 与两个纯派生 `headerTotalsOf` / `partitionOf`，`FILE_LIMIT`，`buildPane` |
| `mods/diff/backend.ts` | `Backend` / `BackendProbe` / `BackendWords` 三层 + `backendOf` |
| `mods/diff/git.ts` | git 后端与 `gitProbe`（`GitDeps` 带注入的 `run`） |
| `mods/diff/index.ts` | `spec: ModSpec`（`optionalDeps: [{ name: 'git', probe: gitProbe }]`）+ `/diff` 插件 |
| `mods/diff/README.md` | 这个 mod 做什么、依赖什么、拿掉 git 会怎样 |
| `mods/diff/test/lines.test.ts` | 从 `test/diff.test.ts` 搬来的纯算法断言 |
| `mods/diff/test/pane.test.ts` | 模型纯度、表头派生、性能闸 |
| `mods/diff/test/backend.test.ts` | 探针顺序与抢占、三种后端的词 |
| `mods/diff/test/plugin.test.ts` | `/diff` 插件：装了说什么、渲染器被怎么调 |
| `src/cli/diff-render.ts` | `formatUnified` / `displayPath` / `formatChange` / `formatPane`（**要 `Palette` 的都在这儿**） |
| `test/diff-render.test.ts` | 从 `test/diff.test.ts` 搬来的上色断言 |

**删除**

| 路径 | 去向 |
| --- | --- |
| `src/cli/diff.ts` | 拆成 `mods/diff/lines.ts`（纯逻辑）+ `src/cli/diff-render.ts`（上色） |
| `test/diff.test.ts` | 拆成 `mods/diff/test/lines.test.ts` + `test/diff-render.test.ts` |

**修改**

| 路径 | 改什么 |
| --- | --- |
| `src/cli/mods.ts` | `builtinMods(render)` 加第四个 mod；新增 `paneUnavailable(report)` |
| `src/cli/commands.ts` | 导入换成 `diff-render`；新增 `paneLoaded` 开关决定要不要注册 `/diff` |
| `src/cli/plugins.ts` | `CliPluginDeps` 透传 `paneLoaded` |
| `src/cli/main.ts` | 算 `paneLoaded`、给 `builtinMods` 传渲染器 |
| `test/harness.ts` | `modPlugins` 给 `builtinMods` 传渲染器 + 把 git 探针钉成 `true` |
| `test/mods.test.ts` | 真清单断言更新（**它今天明写着"到 P5c 那天这条会红"**） |
| `test/cli.test.ts` | `createSessionCommands` 的调用点补 `paneLoaded: false` |
| `test/plugin-wiring.test.ts` | 新增：`/diff` 的应答者由 mod 与 CLI 二选一，且顺序对 |
| `README.md` · `docs/项目简介.md` · `site/index.html` | P5c 一行 + 测试数/用例数 |

---

## 3. 关键形状（照此写，别改名）

```ts
// mods/diff/pane.ts
export const FILE_LIMIT = 50;

export type PaneFile = {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'untracked';
  /** 逐文件 hunk。退化时是 `null` —— **没算过**，不是"没有改动"。 */
  readonly lines: readonly DiffLine[] | null;
  readonly added: number;
  readonly removed: number;
};
export type PaneSection = { readonly title: string; readonly files: readonly PaneFile[] };
export type PaneModel = {
  /** 哪个后端答的（`git`）。模型是纯数据，这个字段只为报告用。 */
  readonly backend: string;
  readonly headline: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  /** 逐文件算过没有。退化时 `false`。 */
  readonly detailed: boolean;
  /** 退化时的一句人话；没退化是 `undefined`。 */
  readonly why?: string;
  readonly sections: readonly PaneSection[];
};

export function headerTotalsOf(files: readonly PaneFile[]): { files; added; removed };
export function partitionOf(files: readonly PaneFile[]): {
  readonly shown: readonly PaneFile[];
  readonly rest: number;
};
export async function buildPane(deps: PaneDeps): Promise<PaneModel>;
```

```ts
// mods/diff/backend.ts
export type BackendWords = {
  readonly name: string;            // 'git'
  readonly notARepo: string;
  readonly empty: string;
  readonly degraded: (files: number, limit: number) => string;
};
export type Backend = {
  readonly words: BackendWords;
  /** 便宜的那个：有几个文件、各是什么状态。**永远先问它。** */
  list(): Promise<readonly PaneEntry[]>;
  /** 贵的那个：逐文件 hunk。**只在 `list()` 的结果没超阈值时才问。** */
  hunks(paths: readonly string[]): Promise<readonly PaneFileHunks[]>;
};
export type BackendProbe = {
  readonly name: string;                              // 'git'
  readonly probe: (deps: ModDeps) => boolean | Promise<boolean>;
  readonly of: (deps: ModDeps) => Backend;
};
/** 探针优先：第一个说"有"的就是它。都不说 → `undefined`（降级）。 */
export async function backendOf(
  probes: readonly BackendProbe[],
  deps: ModDeps,
): Promise<Backend | undefined>;
```

```ts
// mods/diff/index.ts
/** 渲染器由 CLI 注入 —— mod 不认识 `Palette`，也不许认识（边界规则）。 */
export type PaneRenderer = (model: PaneModel) => readonly string[] | string;

export const spec: ModSpec = {
  name: 'diff',
  summary: '会话改动 + 工作区未提交的 pane',
  optionalDeps: [{ name: 'git', probe: gitProbe }],
  create: (deps) => [createDiffPanePlugin(deps)],
};
```

---

## 任务

### Task 1：搬纯算法

**Files:** Create `mods/diff/lines.ts`；Delete `src/cli/diff.ts`、`test/diff.test.ts`

`src/cli/diff.ts` 的 `DiffLine` / `Hunk` / `splitLines` / `diffLines` / `lcsDiff` /
`toHunks` / `buildHunk` / `hunkStart` / `MAX_DP_CELLS` / `CONTEXT` **逐字**搬进 `mods/diff/lines.ts`，
注释一起搬（那些注释是这一片最值钱的部分）。`formatUnified` / `displayPath` / `FormatOptions`
**不搬**（Task 6 去 `diff-render.ts`）。

`test/diff.test.ts` 里 `splitLines` / `diffLines` 那两个 describe 逐字搬到
`mods/diff/test/lines.test.ts`，import 路径改成 `../lines`。

### Task 2：模型与两个纯派生

**Files:** Create `mods/diff/pane.ts`

按 §3 的形状写 `PaneFile` / `PaneSection` / `PaneModel` / `FILE_LIMIT` /
`headerTotalsOf` / `partitionOf` / `buildPane`。

- `headerTotalsOf`：把 `added` / `removed` 相加、`files` 是数组长度。**退化时那些数字是 0**
  （没算过），调用方看 `detailed` 而不是看 0 猜。
- `partitionOf`：`shown` 是前 `FILE_LIMIT` 个，`rest` 是剩下的个数。**纯函数**，
  不碰 `list()` 的结果顺序。
- `buildPane`：**性能闸就在这儿**，顺序不能换：

```ts
const entries = await deps.backend.list();
if (entries.length === 0) return emptyModel(deps.backend.words);

// ⚠️ 退化判断必须在 `hunks()` **之前** —— "先取小再决定要不要取大"这句判据
// 的全部意义就在这一行的位置。挪到后面，闸门就成了摆设（测试 5 会红）。
if (entries.length > FILE_LIMIT) return degradedModel(deps.backend.words, entries);

const hunks = await deps.backend.hunks(entries.map((e) => e.path));
return detailedModel(deps.backend.words, entries, hunks);
```

`PaneDeps = { readonly backend: Backend }`，`Backend` 从 `./backend` 类型导入。

### Task 3：后端三层

**Files:** Create `mods/diff/backend.ts`

按 §3 的形状写四个类型与 `backendOf`。`backendOf` 逐个 `await probe(deps)`：
第一个 `true` → 用它的 `of(deps)` 建后端；都不 `true` → `undefined`。
探针**抛**出去，不在这一层咽 —— 装载器（`cli/mods.ts`）要把"探针坏了"与"这台机器没有"
分成两句话，在这儿咽掉就没得分辨了。

### Task 4：git 后端

**Files:** Create `mods/diff/git.ts`

```ts
export const GIT_TIMEOUT_MS = 5000;

/** 跑一次 git。**注入**的：测试给假的，于是"600 个文件"不必真造一个仓库。 */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly exitCode: number }>;

export function createGitBackend(deps: ModDeps, run: GitRunner = defaultRunner): Backend;
export const gitProbe: ...;   // `git --version` 出得来就算有
```

- `defaultRunner` 用 `node:child_process` 的 `execFile`，`cwd` = `deps.root`，
  `signal: AbortSignal.timeout(GIT_TIMEOUT_MS)`，`windowsHide: true`，`maxBuffer` 给个上限。
- 每个 git 调用都带 `--no-optional-locks`（不跟用户正在跑的 git 抢索引锁）。
- `list()`：`['status','--porcelain','-z','--untracked-files=all']` →
  逐条解析成 `PaneEntry`（`??` → `untracked`，`A` → `added`，`D` → `deleted`，其余 `modified`）。
  `exitCode !== 0` → 空数组（不是仓库 / git 抽风都不该炸）。
- `hunks()`：`['diff','--no-color','--', ...paths]` **一次子进程读完全部文件**
  （`03-mod-diff.md` 的 `fetch-hunks` 那条：一次调用换后面正确性），
  用 `lines.ts` 的 `splitLines` / `diffLines` / `toHunks` 把文本切成 `DiffLine[]`。
  单个文件超过 `MAX_HUNK_BYTES` 就不给 `lines`（给 `null`），理由是"这个文件太大"。
  路径数超过 `MAX_PATHSPEC`（20）就分批。
- `unborn HEAD`（还没有第一个提交）：`status` 照样有输出，`diff` 会报错 → 那一格给空 `lines`。

### Task 5：mod 描述符与 `/diff` 插件

**Files:** Create `mods/diff/index.ts`、`mods/diff/README.md`

`createDiffPanePlugin(deps: ModDeps, render: PaneRenderer)`：

```ts
on('command.describe', { name: 'diff' }, () => ({
  description: '看本会话改过什么、工作区还有什么没提交',
}));

on('command.run', { name: 'diff' }, async ($) => {
  const backend = await backendOf(PROBES, deps);   // 探针已经在装载期过了一遍，这里只是取它
  if (backend === undefined) {                      // 理论到不了：探针没过就不会装
    $.ui.log('这台机器上没有 git，工作区那一块看不成了。');
    return { handled: true };
  }
  const model = await buildPane({ backend });
  for (const line of toLines(render(model))) $.ui.log(line);
  return { handled: true };                         // **不调 next**：装上了就只由它应答
});
```

`spec.create = (deps) => [createDiffPanePlugin(deps, RENDER_REFS.get(deps) ?? plainRenderer)]`
—— 不行，渲染器**不是**从 `ModDeps` 来的（`ModDeps` 是数据，且 mod 不该碰 Palette）。
落法是 `spec` 变成一个**工厂**：

```ts
export function diffSpec(render: PaneRenderer): ModSpec { ... }
```

`cli/mods.ts` 的 `builtinMods(render)` 调它。`mods/diff/index.ts` 另导出一个
`plainRenderer`（不着色、逐行拼）**只给测试用**，并在注释里说明生产路径永远是 CLI 注入的那个。

`README.md` 写：这个 mod 做什么、`optionalDeps` 是 `git`、拿掉 git 会怎样、
`/diff` 的两块分别归谁。

### Task 6：CLI 侧的渲染器

**Files:** Create `src/cli/diff-render.ts`；Modify `src/cli/commands.ts`

`src/cli/diff-render.ts` 收三样：

1. `formatUnified(path, hunks, palette, options)` —— 从 `src/cli/diff.ts` **逐字**搬
   （连同 `FormatOptions`、`isNew` 那段 `/dev/null` 注释）；
2. `displayPath(path, root)` —— 同上；
3. `formatChange(change, root, palette)` —— 从 `cli/commands.ts` 的 `renderChange`
   **逐字**搬（三种退化各自一句，注释保留），改名 `formatChange`；
4. **新增** `formatPane(model: PaneModel, palette: Palette, session: readonly FileChange[], root: string): readonly string[]`：
   表头一行（`` `── ${model.headline} · ${model.backend} ──  ${model.files} 个文件  +${model.added} −${model.removed}` ``），
   然后 `[本会话改动]` 段（`formatChange` 逐条），再 `[工作区未提交]` 段（`model.sections` 里的
   `lines` 走 `formatUnified`，`lines === null` 的走一句"没算逐文件改动（…）"），
   退化时表头后追加 `model.why`。

会话那一段**由渲染器加**，不在 `PaneModel` 里 —— 那是 CLI 自己的数据，
让 mod 的模型去装 CLI 的状态，就把 1.2 那条所有权判定反过来了。这句话要写进注释。

`src/cli/commands.ts`：
- import 换成 `./diff-render`（`formatChange` + `formatUnified` 不再需要）；
- `SessionCommandsDeps` 加**必填** `readonly paneLoaded: boolean`；
- `paneLoaded === false` 时才注册 `command.run {name:'diff'}` 与 `command.describe {name:'diff'}`，
  并在开头多打一句 `deps.paneUnavailable ?? '…'`。

必填理由（写进注释）：给默认值的话，"忘了接线"会表现成**两条应答者抢同一条命令**
（mod 与 CLI 各答一次，输出翻倍）而三条检查全绿。

### Task 7：接线

**Files:** Modify `src/cli/mods.ts`、`src/cli/plugins.ts`、`src/cli/main.ts`、`test/harness.ts`

- `cli/mods.ts`：`builtinMods(render: PaneRenderer)` 返回四个（`diff` 排最后 ——
  它不裁决任何动作，放进来的顺序只为让 `/diff` 那一条命令的应答者与别的 mod 挨着）；
  新增

```ts
/** `/diff` 的工作区那一块看不成了时要说的话。装上了返回 `undefined`。 */
export function paneUnavailable(report: ModReport): string | undefined
```

  （查 `report.outcomes` 里 `name === 'diff'` 那条；`loaded` → `undefined`，
  其余按四态给不同的话，与 `describeMods` 同一口径）。
- `cli/plugins.ts`：`CliPluginDeps` 加 `readonly paneLoaded: boolean`，透传给 `createSessionCommands`；
  `mods` 那一行注释补一句"`diff` 的 `/diff` 应答者就在这一片里，所以它整片排在 firstParty 之前".
- `main.ts`：
  ```ts
  const { plugins: modPlugins, report } = await loadMods(
    { ... }, builtinMods((model) => formatPane(model, palette, changes.list(), root)),
  );
  ...
  paneLoaded: !paneUnavailable(report),
  ```
- `test/harness.ts`：`modPlugins` 传一个不许色的渲染器，并把 `diff` 的 `optionalDeps`
  换成锁死的 `probe: () => true`（注释写明理由：**测试结果不该取决于跑测试的那台机器有没有 git**）。

### Task 8：测试

**Files:** Create `mods/diff/test/pane.test.ts`、`backend.test.ts`、`plugin.test.ts`、
`test/diff-render.test.ts`；Modify `test/mods.test.ts`、`test/cli.test.ts`、`test/plugin-wiring.test.ts`

`mods/diff/test/pane.test.ts`（用假 backend，全是纯数据）

1. 同一份改动、不同 `PaneFile` 数组顺序无关的字段（`headerTotalsOf`）**逐字节相同**；
2. 几行 hunk → 表头加起来对；
3. 恰好 `FILE_LIMIT` 个文件 → **走逐文件路径**（`detailed === true`）；
4. `FILE_LIMIT + 1` 个 → 退化，`detailed === false`，`why` 是人话；
5. **退化时 `hunks` 一次都没被调用** —— 假 backend 的 `hunks` 里放一个 `throw`，
   退化那条实测跑通就算过（比记调用次数更硬）；
6. 0 个文件 → `headline` 说"工作区干净"，不打空块。

`mods/diff/test/backend.test.ts`

7. 探针顺序：第一个 `true` 的赢，后面的**根本不被问**；
8. 都不 `true` → `undefined`；
9. 探针抛 → 抛出去（不咽）。

`mods/diff/test/plugin.test.ts`

10. `/diff` 应答者会调 `render`，并把返回的行逐条 `$.ui.log`；
11. `render` 返回字符串（不是数组）时也照打 —— 注入方不该被一种形状绑住；
12. `command.describe` 有话说。

`test/diff-render.test.ts`（从 `test/diff.test.ts` 搬 + 新增）

13-15. `formatUnified` 那三条（关色时逐字节等于没这个模块、开色时青头红绿、
   `isNew` 指 `/dev/null`）**原样搬**；
16. `displayPath` 那条**原样搬**；
17. `formatPane`：表头那一行的形状（文件数、`+a −d`）；
18. `formatPane` 里会话那一段与工作区那一段**都在**，且顺序是会话在前。

`test/mods.test.ts`

19. `builtinMods(render)` 的四个名字顺序（`sec-default → agents-md → telemetry → diff`）；
20. **改掉**"真清单今天没有可选依赖"那一条 —— 它现在该红了。改成反向断言：
    `diff` **有**且**只有**一个可选依赖，名字是 `git`；
21. 新增 `paneUnavailable`：`loaded` → `undefined`；`missing` → 含 `git` 的人话；
22. `probe-failed` → 含 `bug`（与 `missing` 分得开）。

`test/cli.test.ts`

23. 既有 5 条 `/diff` 断言**原样留着**（`paneLoaded: false` 的老输出就是今天的输出）；
24. `paneLoaded: true` 时 `command.run {name:'diff'}` **没有** CLI 侧的应答者。

`test/plugin-wiring.test.ts`

25. 真装内建 mod 之后，`/diff` 的应答者里有 mod 那个插件名、且 `session-commands` **不在**
    这一条命令的应答者里 —— 两条应答者抢同一条命令是这一片最容易犯的错。

### Task 9：文档同步

**Files:** Modify `README.md`、`docs/项目简介.md`、`site/index.html`

- README 的 `/diff` 那一节：两块来源 + `git` 是可选依赖 + 拿掉会怎样；
- 项目简介与官网的 P5 一行从"P5b 已完成"进到"P5c 已完成"；
- 测试文件数与用例数按实测改（三处）。

---

## 检查点

### C1（Task 1-5）：mod 自成一格
`pnpm typecheck` + `pnpm vitest run mods/diff`
判据：§9.3 出口标准第一条第三格 —— `mods/diff` 有自己的测试套件，且它自己绿。
（此时 CLI 还没接线，`src/cli/commands.ts` 会因 `src/cli/diff.ts` 被删而红 ——
所以 C1 只跑 `mods/diff`，typecheck 允许在本检查点内部红，**C2 结束必须全绿**。）

### C2（Task 6-8）：接线 + 全量
`pnpm typecheck` + `pnpm lint` + `pnpm test`

### C3：三绿 + 反向验证

先 `pnpm typecheck && pnpm lint && pnpm test` 三绿，然后**逐条把断言改坏、确认它真的红**，
再还原（备份到 `/tmp/*.bak`，改完先 `grep` 确认变异落地）：

| # | 变异 | 必须红的是 |
| --- | --- | --- |
| 1 | 把 `buildPane` 里那个 `entries.length > FILE_LIMIT` 的闸挪到 `hunks()` **之后** | 第 5 条（退化时没调逐文件那条路径）—— 否则性能闸是摆设 |
| 2 | `gitProbe` 改成永远 `true` | 第 21 条会在"没有 git 的环境"下失去意义 → 改成：把 `optionalDeps` 摘掉 | 第 20 条（`diff` 有且只有一个可选依赖） |
| 3 | `paneLoaded` 恒为 `false` | 第 25 条（两条应答者抢一条命令） |
| 4 | `formatPane` 里把会话那一段删掉 | 第 18 条 |
| 5 | `backendOf` 改成"最后一个探针赢" | 第 7 条 |

最后把测试数同步进 README / 项目简介 / 官网。

**出口标准第二条的真实例证**（这一条是本片存在的理由，要**手工**跑一次记进提交信息）：
把 `git` 从 PATH 里拿掉（`PATH=/usr/bin:/bin` 之类，或临时改 `defaultRunner` 让
`git --version` 失败）→ CLI 起得来、启动时有一句"内建 mod diff 没装：这台机器上没有 git"、
`/diff` 仍打出本会话改动 + 一句人话、其余一切照常。

## 刻意不做

- **不新增事件名**：这一片不需要（mod 自己应答命令），事件目录仍是 41 / 22，三处计数不动。
- **不做实时重绘**：§5.1 判的是"下次打印时刷新"。一个每隔 150ms 重画的 pane 需要 TUI，
  而 MVP 明确没有 TUI。
- **不做噪声文件折叠**（`isNoiseFile` / `isGeneratedFile`）：参考实现那套是为"改动几百个文件"
  的仓库设计的，而我们真正的闸是 `FILE_LIMIT` 那一条 —— 阈值到了就退化，比按规则折叠简单得多，
  也不会把"测试文件里也改了东西"藏起来。
- **不做 rename 的 `{a => b}` 展示**：`status --porcelain` 给的是两行（D + ?），
  把它拼成一行需要 `--find-renames`（更贵的一次调用）。今天不值得。
- **不做二进制文件标记**：`lines: null` 之外不分"太大"与"二进制"，两者对用户是同一件事：看不了逐行。
- **不搬 `ansi.ts` 进 mod**：§3.2 明说那是绕开规则而不是遵守它。
