# DeepCode P5a 实施计划：内建 mod 平台

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐任务执行。
> 步骤用 `- [ ]` 勾。上位设计：`docs/superpowers/specs/2026-10-11-deepcode-p5-design.md` §3。

**Goal:** 把内建 mod 从"`src/` 里的一堆文件"变成"`mods/<name>/` 下一个能单独测试、能单独拿走、缺了也不塌的单元"。

**Architecture:** 物理搬迁（`src/**` → `mods/<name>/`）+ 一条**单向边界规则**（mod 只许 import 契约；CLI 可以 import mod，内核不行）+ 一个**不 import 任何 mod 的装载器**（探针失败 → 降级 + 如实报告）。

**Tech Stack:** TypeScript / vitest / 现有 `scripts/check-boundaries.mjs`。

**验收方式（用户长期指令）**：任务级只跑 `pnpm typecheck`；测试与反向验证**按检查点批量做**（C1/C2/C3）。

---

## 文件结构（本片确定的形状）

| 路径 | 职责 |
| --- | --- |
| `src/contract/telemetry.ts` | **新**：`TelemetryPolicy` / `DEFAULT_TELEMETRY` 搬进契约（mod 只许 import 契约） |
| `src/contract/mod.ts` | **新**：`ModDeps` / `ModDep` / `ModSpec` / `ModOutcome` / `ModReport` |
| `mods/telemetry/{index,sink,rows}.ts` | 由 `src/cli/telemetry*.ts` 搬来 |
| `mods/agents-md/{nested,instructions}.ts` | 由 `src/cli/agents-md.ts` + `src/builtins/instructions.ts` 搬来 |
| `mods/sec-default/index.ts` | 由 `src/builtins/sec-default.ts` 搬来（**只归位，行为零变化**） |
| `mods/<name>/test/*.test.ts` | 各 mod 自己的测试套件 |
| `src/cli/mods.ts` | **新**：装载器 + `builtinMods()` 清单 + 报告渲染 |
| `scripts/check-boundaries.mjs` | **改**：新增 `mods/` 分支 + 放行 `src/cli` → `mods/` |
| `tsconfig.json` / `vitest.config.ts` | **改**：把 `mods` 纳入 |

**本片不动 `mods/diff`**（P5c 才搬进来）。

---

## Task 1：`TelemetryPolicy` 进契约

**Files:** Create `src/contract/telemetry.ts`; Modify `src/cli/settings.ts:78-87`

- [ ] 建 `src/contract/telemetry.ts`：

```ts
/**
 * 遥测的策略形状。放在契约里，因为它是 mod（`mods/telemetry`）与 CLI 之间唯一的那句话 ——
 * 而 mod 只许 import 契约（`scripts/check-boundaries.mjs`）。
 * 在这之前它住在 `cli/settings.ts`，那是**解析器**的位置，不是形状的位置。
 */
export type TelemetryPolicy = {
  readonly enabled: boolean;
  /** 为什么是这个值。给 `/telemetry` 直接打出来 —— 一个不给理由的开关没人敢用。 */
  readonly why: string;
};

export const DEFAULT_TELEMETRY: TelemetryPolicy = {
  enabled: false,
  why: '默认关（没有哪一层说要开）',
};
```

- [ ] `src/cli/settings.ts` 删掉原定义（78-87 行），改成**从契约来**并原样再导出（现有 `test/cli.test.ts` / `test/plugin-wiring.test.ts` / `test/telemetry.test.ts` 从 settings 取 `DEFAULT_TELEMETRY`，不搬它们的 import）：

```ts
export type { TelemetryPolicy } from '../contract/telemetry';
export { DEFAULT_TELEMETRY } from '../contract/telemetry';
```

并把文件里用到这两处的内部引用改成从 `'../contract/telemetry'` import（`verbatimModuleSyntax` 下类型要用 `import type`）。

- [ ] 跑 `pnpm typecheck`。

## Task 2：`src/contract/mod.ts`

**Files:** Create `src/contract/mod.ts`

- [ ]：

```ts
import type { Plugin } from './plugin';
import type { Rule } from './policy';
import type { TelemetryPolicy } from './telemetry';

/**
 * 一个内建 mod 能拿到的那几样东西。
 *
 * ⚠️ **全是数据**，一个 mod 拿不到 `dispatch`、拿不到 registry、拿不到 `$` ——
 * 那三样要经过座位与准入（P2/P3 立的规矩：权威由 CLI 钉，不由插件自述）。
 * 也正因为它只带数据，装载器才**不需要 import 任何 mod** 就能被测试。
 */
export type ModDeps = {
  readonly root: string;
  readonly home: string;
  readonly sessionId: string;
  readonly warn: (line: string) => void;
  readonly telemetry: TelemetryPolicy;
  /** **只**来自 policy 源的那份规则（`sec-default` 的持有物）。 */
  readonly policyRules: readonly Rule[];
};

/** 一条可选依赖：探针返回 false = 这台机器上没有它，这个 mod 不装，主流程照常。 */
export type ModDep = {
  readonly name: string;
  readonly probe: (deps: ModDeps) => boolean | Promise<boolean>;
};

export type ModSpec = {
  readonly name: string;
  readonly summary: string;
  readonly optionalDeps?: readonly ModDep[];
  /** 一个 mod 可以贡献不止一个插件（`agents-md` 就是两个）。 */
  readonly create: (deps: ModDeps) => readonly Plugin[];
};

/**
 * 装载结果。四态而不是"成功/失败"两态，是因为**原因不同，处置也不同**：
 * - `missing`：这台机器没有它依赖的东西 —— 正常，降级；
 * - `probe-failed`：探针自己坏了 —— **我们的 bug**，混进上一条会被静默；
 * - `broken`：`create` 抛了 —— 我们的 bug，但同样不能让 CLI 起不来；
 * - `loaded`：正常。
 */
export type ModOutcome =
  | { readonly name: string; readonly status: 'loaded' }
  | { readonly name: string; readonly status: 'missing'; readonly dep: string }
  | { readonly name: string; readonly status: 'probe-failed'; readonly dep: string; readonly error: string }
  | { readonly name: string; readonly status: 'broken'; readonly error: string };

export type ModReport = { readonly outcomes: readonly ModOutcome[] };
```

- [ ] 跑 `pnpm typecheck`。

## Task 3：搬 `telemetry` 到 `mods/telemetry/`

**Files:** `git mv` 三个源文件 + 三个测试；改 import

- [ ] ```bash
mkdir -p mods/telemetry/test
git mv src/cli/telemetry.ts       mods/telemetry/index.ts
git mv src/cli/telemetry-sink.ts  mods/telemetry/sink.ts
git mv src/cli/telemetry-rows.ts  mods/telemetry/rows.ts
git mv test/telemetry.test.ts       mods/telemetry/test/plugin.test.ts
git mv test/telemetry-sink.test.ts  mods/telemetry/test/sink.test.ts
git mv test/telemetry-rows.test.ts  mods/telemetry/test/rows.test.ts
```

- [ ] 改 import（`verbatimModuleSyntax`）：
  - `mods/telemetry/index.ts`：`'../contract/plugin'` → `'../../src/contract/plugin'`；`'./settings'` → `'../../src/contract/telemetry'`；`'./telemetry-sink'` → `'./sink'`；`'./telemetry-rows'` → `'./rows'`。
    同时**删掉那段 `declare module '../contract/engine'` 的模块路径**要改成 `'../../src/contract/engine'`。
  - `mods/telemetry/sink.ts`：`'./telemetry-rows'` → `'./rows'`。
  - 三个测试：`'../src/cli/telemetry*'` → `'../index'` / `'../sink'` / `'../rows'`；`'../src/contract/...'` → `'../../../src/contract/...'`；`'../src/core/...'` → `'../../../src/core/...'`；`'../src/cli/...'` → `'../../../src/cli/...'`；`'./harness'` → `'../../../test/harness'`。
- [ ] 加一个 `mods/telemetry/index.ts` 的 **mod 描述符**（放在插件工厂**下面**，不删原工厂）：

```ts
/**
 * P5a 的 mod 描述符。探针：遥测**没有**可选依赖 —— 它关着的时候一个系统调用都不发，
 * 开着的时候写不进去也只吭一声（sink 自己咽）。所以 `optionalDeps` 是空的，
 * 这不是"忘了写"，是它真的不挑环境。
 */
export const spec: ModSpec = {
  name: 'telemetry',
  summary: '本地行为记录（默认关，一行一条 JSONL）',
  create: (deps) => [
    createTelemetryPlugin({
      home: deps.home,
      policy: deps.telemetry,
      sessionId: deps.sessionId,
      warn: deps.warn,
    }),
  ],
};
```

- [ ] `tsconfig.json` 的 `include` 改成 `["src", "test", "scripts", "mods"]`；`vitest.config.ts` 的 `include` 改成 `['test/**/*.test.ts', 'mods/**/test/**/*.test.ts']`。
- [ ] 跑 `pnpm typecheck`。

## Task 4：搬 `agents-md` 到 `mods/agents-md/`

**Files:** `git mv` 两个源文件 + 两个测试

- [ ] ```bash
mkdir -p mods/agents-md/test
git mv src/cli/agents-md.ts          mods/agents-md/nested.ts
git mv src/builtins/instructions.ts  mods/agents-md/instructions.ts
git mv test/agents-md.test.ts        mods/agents-md/test/nested.test.ts
git mv test/prompt-section.test.ts   mods/agents-md/test/instructions.test.ts
```

- [ ] 改 import：`'../contract/engine'` / `'../contract/plugin'` → `'../../src/contract/...'`；测试里 `'../src/...'` → `'../../../src/...'`、`'./harness'` → `'../../../test/harness'`。
- [ ] `mods/agents-md/index.ts`（**新**）导出描述符 —— 一个 mod 贡献两个插件：

```ts
import type { ModSpec } from '../../src/contract/mod';
import { createAgentsMdPlugin } from './nested';
import { createInstructionsPlugin } from './instructions';

export const spec: ModSpec = {
  name: 'agents-md',
  summary: 'AGENTS.md / CLAUDE.md：指令文件 + 惰性嵌套',
  // ⚠️ 顺序是契约：嵌套那个必须在 coreTools 之前（同 tier 内先装载者在外层），
  // 而"在 coreTools 之前"由 `cli/plugins.ts` 把 mods 排在 firstParty 前面保证。
  create: (deps) => [
    createAgentsMdPlugin({ root: deps.root }),
    createInstructionsPlugin({ root: deps.root, home: deps.home }),
  ],
};
```

- [ ] 跑 `pnpm typecheck`。

## Task 5：`sec-default` 归位（行为零变化）

**Files:** `git mv src/builtins/sec-default.ts` → `mods/sec-default/index.ts`；搬它的测试

- [ ] ```bash
mkdir -p mods/sec-default/test
git mv src/builtins/sec-default.ts     mods/sec-default/index.ts
git mv test/sec-default.test.ts        mods/sec-default/test/index.test.ts
```
- [ ] 改 import：`'../contract/policy'` / `'../contract/plugin'` → `'../../src/contract/...'`；测试路径同上。
- [ ] 在文件末尾（工厂之后）加描述符：

```ts
export const spec: ModSpec = {
  name: 'sec-default',
  summary: '守门器：只持有托管策略，个人规则一个字都不读',
  create: (deps) => [createSecDefaultPlugin({ rules: deps.policyRules })],
};
```

- [ ] 跑 `pnpm typecheck`。

## Task 6：边界规则（`check-boundaries.mjs`）

**Files:** Modify `scripts/check-boundaries.mjs`; Test `test/tooling.test.ts`

- [ ] 新增 `MODS = join(ROOT_DIR, 'mods')` 与第三个分支。规则（设计 §3.2）：

```
mods/<name>/** 的非测试源码：
  允许：node: 内建 · src/contract/** · 自己这个目录里的相对路径
  禁止：裸包名 · src/ 的其它目录 · 跨到 mods/<别的名字>/
  豁免：**/test/** 与 *.test.ts（测试本来就要用真的 createEngine 与 vitest）
```

- [ ] 同一次改掉 `src/` 分支那条"逃出了 src/"：**唯一放行的逃逸目标是 `mods/`，且只从 `cli/` 出发**。理由写成注释：单向依赖 —— CLI 可以 import 内建 mod，内核（`core/`）与 `builtins/` 不可以（内核不认识 mod）。
- [ ] 在 `test/tooling.test.ts` 的 `check-boundaries` 一节里补用例（正反成对，钉具体判词）：
  - 干净 mod（`node:` + `../../src/contract/plugin` + 同目录）→ 通过；
  - `mods/t/index.ts` import `../../src/core/dispatch` → 红，判词含"只许 import src/contract"；
  - `mods/t/index.ts` import `'vitest'`（裸包名）→ 红；
  - `mods/t/index.ts` import `../u/x`（跨 mod）→ 红；
  - `mods/t/test/x.test.ts` import `../../../src/core/create` → **通过**（测试豁免）；
  - `src/cli/mods.ts` import `'../../mods/telemetry/index'` → 通过；
  - `src/core/x.ts` import `'../../mods/telemetry/index'` → 红。
- [ ] 跑 `pnpm typecheck`（任务级），C2 再跑 `pnpm lint` + 反向验证。

## Task 7：装载器 `src/cli/mods.ts`

**Files:** Create `src/cli/mods.ts`

- [ ]：

```ts
import type { Plugin } from '../contract/plugin';
import type { ModDeps, ModOutcome, ModReport, ModSpec } from '../contract/mod';

/**
 * 内建 mod 的装载器。**它不 import 任何一个 mod** —— 清单从参数进来，
 * 于是"探针失败会怎样"能用一个夹具 mod 测，而不是靠读代码相信。
 *
 * 两条分寸（设计 §3.3）：
 * 1. 探针失败 → **降级**（不装这个 mod，CLI 照跑）；
 * 2. `create` 抛 → 也降级，但**必须吼** —— 那是我们的 bug，不是这台机器的环境问题。
 */
export async function loadMods(
  deps: ModDeps,
  mods: readonly ModSpec[],
): Promise<{ plugins: readonly Plugin[]; report: ModReport }> { … }
```

实现要点（逐条写清，别自由发挥）：
- 对每个 mod 的 `optionalDeps` 顺序跑探针：
  - 返回 false → `{name, status:'missing', dep}`，**不装**，`continue`；
  - 抛 → `{name, status:'probe-failed', dep, error: messageOf(err)}`，**不装**，`continue`；
- 探针全过 → `try { plugins.push(...mod.create(deps)) } catch { broken }`；
- `ModOutcome` 顺序与传入的 mod 顺序一致（报告要可预期）。
- 另导出 `describeMods(report): string[]`：**只对非 loaded 的**产出人话，一行一个，例如
  `内建 mod diff 没装：这台机器上没有 git`、`内建 mod foo 的探针自己坏了（Error: …）—— 这是我们的 bug`。装载全成功时返回 `[]`（一个字节的额外输出都不许有）。

- [ ] 跑 `pnpm typecheck`。

## Task 8：接进装配（`cli/plugins.ts` + `main.ts`）

**Files:** Modify `src/cli/plugins.ts`; Modify `src/cli/main.ts`

- [ ] `CliPluginDeps` 加一个**必填**的 `readonly mods: readonly Plugin[]`。必填不是洁癖：给个 `[]` 默认值的话，"忘了接线"就会表现成"内建 mod 全都不见了"而全绿 —— 与 `cliPlugins` 顶部那段注释记的事故同一种形状。
- [ ] `firstParty` 数组里**删掉**：`createAgentsMdPlugin`、`createInstructionsPlugin`、`createTelemetryPlugin` 三处调用（它们现在从 `mods` 来）。`secDefault` 那行也删（改为从 `mods` 来），它仍坐 `prepend`、仍排在 guard 之后。
- [ ] 插件清单改成：

```ts
plugins: [guard, ...deps.mods, ...firstParty, ...discovered],
```
（`deps.mods` 的**顺序由 `builtinMods()` 定**：`sec-default` 在前，因为它要与 guard 挨着；`agents-md` 在 `firstParty` 之前，因为它的嵌套 hook 必须在 `coreTools` 外层。）

- [ ] `names`（第一方豁免名单）改成从**实际装上的插件**推：`['plugin-guard', ...deps.mods.map((p) => p.name), ...firstParty.map((p) => p.name)]`。这条是 P2 的 C3 变异测试实测出来的，别改回静态名单。
- [ ] `src/cli/mods.ts` 里加清单：

```ts
export function builtinMods(): readonly ModSpec[] {
  return [secDefault.spec, agentsMd.spec, telemetry.spec];
}
```

- [ ] `src/cli/main.ts`：在 `cliPlugins(...)` 之前 `const { plugins: modPlugins, report } = await loadMods(modDeps, builtinMods());`，把 `mods: modPlugins` 传进去；`modDeps` 从已解析的 `policy` / `root` / `home` / `sessionId` / `warn: warnLine` 拼。紧接着 `for (const line of describeMods(report)) warnLine(line);` —— **降级必须看得见**。
- [ ] 跑 `pnpm typecheck`。

## Task 9：装载器自己的测试

**Files:** Create `test/mods.test.ts`

- [ ] 用**夹具 mod**（就地定义 `ModSpec`，不碰 `mods/` 里的真货）覆盖：
  - 全过 → 插件按顺序进来，`report.outcomes` 全是 `loaded`，`describeMods` 返回 `[]`；
  - 探针 false → 不装、`missing` 点名是哪个依赖、`describeMods` 有一行含 mod 名与依赖名；
  - 探针抛 → `probe-failed`，且**与 `missing` 分得开**（判词不同）；
  - `create` 抛 → `broken`，其余 mod 照装（**不传染**）；
  - 空清单 → 零插件、零输出。
- [ ] 跑 `pnpm typecheck`。

## Task 10：装配级的钉子

**Files:** Modify `test/plugin-wiring.test.ts`（与其它 `cliPlugins` 调用点）

- [ ] 所有 `cliPlugins({...})` 调用点补 `mods: <loadMods 的结果>`（测试里可以直接 `await loadMods(deps, builtinMods())`）。
- [ ] 新增断言：**四个内建 mod 的插件名全在清单里**（`telemetry` / `agents-md` / `instructions` / `sec-default`），且**都不在 `thirdParty` 里**（第一方豁免仍然成立）。
- [ ] 跑 `pnpm typecheck`。

---

## 检查点

### C1（Task 1–5）：搬家搬完，全量绿

- [ ] `pnpm typecheck` && `pnpm lint` && `pnpm test` 三条全绿（**搬迁不许有任何行为变化** —— 测试用例数与预期一字不改，只改路径）。
- [ ] `ls mods/*/test/` 三个目录各有测试；`pnpm vitest run mods/telemetry` 等三条**单独**都能跑绿。
- [ ] 反向验证一条：把 `mods/telemetry/rows.ts` 的 `IDENT` 正则改坏，确认 `mods/telemetry/test/rows.test.ts` 真的红 → 改回。（证明"各自成套件"不是摆设。）

### C2（Task 6）：边界规则真的拦得住

- [ ] `pnpm lint` 绿。
- [ ] 反向验证四条，每条先 `grep` 确认改坏了、看完红再改回：
  1. 往 `mods/telemetry/index.ts` 加 `import { dispatch } from '../../src/core/dispatch'` → 红；
  2. 加 `import { describe } from 'vitest'` → 红（裸包名）；
  3. 把 `mods/agents-md/test/instructions.test.ts` 的 `src/core/create` 那行删掉 → **不该**变红（测试豁免）；反而把**源码**里塞同样的 import 才该红；
  4. 往 `src/core/create.ts` 加 `import '../../mods/telemetry/index'` → 红（内核不认识 mod）。

### C3（Task 7–10）：降级看得见，且不传染

- [ ] `pnpm typecheck` && `pnpm lint` && `pnpm test` 全绿。
- [ ] 反向验证两条：
  1. 把 `loadMods` 里"探针抛异常"那一支改成静默 `missing` → `test/mods.test.ts` 红（证明两种原因真的分得开）；
  2. 把 `describeMods` 改成永远返回 `[]` → 至少一条测试红（证明"降级可见"不是口号）。
- [ ] 端到端一眼：`pnpm dev` 起来后 `/help` 里仍有 `/diff` `/telemetry` `/permissions` `/config`，且没有任何多余输出（三个 mod 都装上了 → 报告是空的）。

## Task 11：文档同步

- [ ] README：「内建 mod」一节按 §2 的口径改成"四个内建 mod（P5 收口三个）"，测试行数与文件数按实测更新。
- [ ] `docs/项目简介.md` / `site/index.html`：同一句话一起改（P4d 的做法）。
- [ ] 提交。
