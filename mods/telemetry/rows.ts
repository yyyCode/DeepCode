import { join } from 'node:path';

/**
 * 遥测的纯逻辑：一条插件给的记录怎么算合格、一行怎么拼。
 *
 * 没有 IO —— 读盘写盘全在 `telemetry-sink.ts` 里。拆开是为了让"什么算自由文本"
 * 能被穷举测试：这条协议是这份功能**唯一**的隐私闸门，松一格就没了。
 */

/**
 * 一个标识符：字母数字开头，只含 `[A-Za-z0-9_.:-]`，最长 64。
 *
 * 这条路是**故意窄的**：它要挡住的不是"奇怪的字符"，而是自由文本本身 ——
 * 一个空格、一个斜杠、一个引号之后就该走别的路（或者干脆别记）。
 * 工具名（`Bash` / `mcp__x__y`）与日期时间戳都能过，文件路径过不去，这正是想要的。
 */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export type TelemetryFields = Readonly<Record<string, number | boolean | string>>;

export type TelemetryEntry = { readonly kind: string; readonly fields?: TelemetryFields };

/** 落到磁盘上的一行。`at` / `seq` 是**我们**补的，不走插件校验。 */
export type TelemetryRow = {
  readonly at: string;
  readonly seq: number;
  readonly kind: string;
  readonly fields: TelemetryFields;
};

export type ValidateResult =
  | { readonly ok: true; readonly kind: string; readonly fields: TelemetryFields }
  | { readonly ok: false; readonly reason: string };

/**
 * 校验一条记录。不合格**不截断、不改写**，直接退回并说清是哪一项 ——
 * 一条被悄悄改写过的行比一条丢了的更难查，而这条协议全部的意义就是"落下去的
 * 每一个字节都长这样"。
 */
export function validateEntry(entry: TelemetryEntry): ValidateResult {
  if (typeof entry?.kind !== 'string' || !IDENT.test(entry.kind)) {
    return {
      ok: false,
      reason: `kind ${JSON.stringify(entry?.kind)} 不是标识符（自由文本记不进遥测）`,
    };
  }

  const fields: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (!IDENT.test(key)) return { ok: false, reason: `字段名 ${JSON.stringify(key)} 不是标识符` };
    if (typeof value === 'number') {
      // `Infinity` / `NaN` 会被 `JSON.stringify` 写成 `null` —— 一条悄悄变成
      // `null` 的行读起来像是"这个字段是空的"，而不是"当时算出来的不是个数"。
      if (!Number.isFinite(value)) return { ok: false, reason: `字段 ${key} 是 ${value}，不是有限数字` };
      fields[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      fields[key] = value;
      continue;
    }
    if (typeof value === 'string' && IDENT.test(value)) {
      fields[key] = value;
      continue;
    }
    return { ok: false, reason: `字段 ${key} 的值是自由文本（只许有限数字 / 布尔 / 标识符）` };
  }

  return { ok: true, kind: entry.kind, fields };
}

/** 一行一条，行尾一个 `\n` —— 与转录文件同一个读法（`tail` 友好的 jsonl）。 */
export function formatRow(row: TelemetryRow): string {
  return `${JSON.stringify(row)}\n`;
}

/**
 * 行都落在一个文件里。
 *
 * 一天一个文件会攒出一片没人删的目录，而它本来就是给 `tail` 看的。
 * 位置在**用户级** `~/.deepcode/` 下，与转录同一条道理：里面是行为记录，
 * 不该跟着仓库走、更不该被 `git add .` 带上去。
 */
export function telemetryPath(home: string): string {
  return join(home, '.deepcode', 'telemetry.jsonl');
}
