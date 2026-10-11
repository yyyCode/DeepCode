/**
 * 遥测的策略形状。
 *
 * 为什么在契约里：它是 `mods/telemetry` 与 CLI 之间**唯一的那句话**，而 mod 只许 import
 * 契约（`scripts/check-boundaries.mjs`）。在这之前它住在 `cli/settings.ts` ——
 * 那是**解析器**的位置（谁说了算、按什么优先级合并），不是**形状**的位置。
 *
 * 合并在哪一层做的、personal 能不能开、托管层怎么压过用户层，仍然全在 `cli/settings.ts`。
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
