import type { Plugin } from './plugin';
import type { Rule } from './policy';
import type { TelemetryPolicy } from './telemetry';

/**
 * 一个内建 mod 能拿到的那几样东西。
 *
 * ⚠️ **全是数据**：一个 mod 拿不到 `dispatch`、拿不到 registry、拿不到 `$` ——
 * 那三样要经过座位与准入，而 P2/P3 立的规矩是"权威由 CLI 钉，不由插件自述"。
 * 也正因为它只带数据，装载器（`cli/mods.ts`）**不需要 import 任何 mod**
 * 就能被测试：夹具 mod 从外面传进来就行。
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

/**
 * 一条可选依赖。
 *
 * 探针返回 `false` = 这台机器上没有它 → 这个 mod **不装**，主流程照常。
 * 探针**抛** = 探针自己坏了 → 也不装，但报告里与上一条分得开（那是我们的 bug，
 * 混进"环境没有"里会被静默 —— 而安静的失效是这项目最想防的失败形状）。
 */
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
 * 装载结果。四态而不是两态，因为**原因不同、处置也不同**：
 * - `missing`：这台机器没有它依赖的东西 —— 正常，降级，说一句人话；
 * - `probe-failed`：探针自己坏了 —— 我们的 bug，也要说，且说法不一样；
 * - `broken`：`create` 抛了 —— 我们的 bug，同样不能让 CLI 起不来；
 * - `loaded`：正常（一个字节的额外输出都不该有）。
 */
export type ModOutcome =
  | { readonly name: string; readonly status: 'loaded' }
  | { readonly name: string; readonly status: 'missing'; readonly dep: string }
  | {
      readonly name: string;
      readonly status: 'probe-failed';
      readonly dep: string;
      readonly error: string;
    }
  | { readonly name: string; readonly status: 'broken'; readonly error: string };

/** 装载报告。顺序与传入的 mod 顺序一致 —— 报告要可预期，才好被钉。 */
export type ModReport = { readonly outcomes: readonly ModOutcome[] };
