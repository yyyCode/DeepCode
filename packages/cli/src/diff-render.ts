import { isAbsolute, relative } from 'node:path';
// `cli/ -> mods/` 这个方向是边界规则明确放行的那一条（只有 `packages/cli/src/` 可以 import mod）。
import { diffLines, splitLines, toHunks } from '../../../mods/diff/lines';
import type { Hunk } from '../../../mods/diff/lines';
import type { PaneModel } from '../../../mods/diff/pane';
import type { Palette } from './ansi';
import type { FileChange } from './changes';

/**
 * diff 的**渲染** —— 需要 `Palette` 的东西全在这儿（P5c）。
 *
 * 为什么不在 `mods/diff/` 里：边界规则（`scripts/check-boundaries.mjs`）不许 mod import
 * `cli/ansi`，而"把 `ansi.ts` 一起搬进 mod"是绕开规则。于是形状是：
 *
 * > **mod 产出模型（纯数据），渲染归引擎。**
 *
 * 这一条同时也是那个 mod 的 `PaneRenderer` 从外面注入的原因 —— 它自己不认识颜色，
 * 颜色是 CLI 递给它的一个函数（见 `mods/diff/index.ts`）。
 */

/** 落在 root 里就给相对路径；出不去就别拿一串 ../ 糊弄人，直接给绝对路径。 */
export function displayPath(path: string, root: string): string {
  const rel = relative(root, path);
  if (rel === '') return path;
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

export type FormatOptions = { readonly isNew?: boolean };

export function formatUnified(
  path: string,
  hunks: readonly Hunk[],
  palette: Palette,
  options: FormatOptions = {},
): string {
  const out = [
    palette.bold(`--- ${options.isNew ? '/dev/null' : `a/${path}`}`),
    palette.bold(`+++ b/${path}`),
  ];

  for (const hunk of hunks) {
    out.push(palette.cyan(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
    for (const line of hunk.lines) {
      if (line.kind === 'add') out.push(palette.green(`+${line.text}`));
      else if (line.kind === 'del') out.push(palette.red(`-${line.text}`));
      else out.push(` ${line.text}`);
    }
  }

  return out.join('\n');
}

/**
 * 一条会话改动的 `+N −M`（P6c）。
 *
 * **与 `/diff` 读同一份数据、同一套 diff** —— 这里只是不渲染正文，只数行数。
 * 两处各算一份的话，屏幕上那行 `+3 −1` 迟早会与 `/diff` 里那块对不上。
 *
 * 任一侧 `skipped`（太大 / 是目录 / 读不动）就给不出数字：那时候连正文都没有，
 * 编一个 `+0 −0` 出来是假账。调用方拿到 `undefined` 就**不印**这一段。
 */
export function changeStat(
  change: FileChange,
): { readonly added: number; readonly removed: number } | undefined {
  if (change.before.kind === 'skipped' || change.after.kind === 'skipped') return undefined;

  const before = change.before.kind === 'text' ? splitLines(change.before.text) : [];
  const after = change.after.kind === 'text' ? splitLines(change.after.text) : [];
  const lines = diffLines(before, after);
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'del').length,
  };
}

/**
 * 一条**会话改动**渲染成一屏 unified diff（或一句退化说明）。
 *
 * 三种退化各有独立输出，不混成一句：
 * - 任意一侧 skipped（太大 / 是目录 / 读不动）→ 说清为什么没内容，别假装没改过；
 * - `hunks.length === 0`（写了一遍却一字未变，或改了又改回去）→ "没有净改动"，
 *   说了也白说，不打一片空白。
 *
 * （P5c 之前这是 `cli/commands.ts` 里的 `renderChange`，逐字搬来的 —— 现在
 * `/diff` 有两条路径（mod 装了 / 没装）都要它，搬出来才不至于抄两份。）
 */
export function formatChange(change: FileChange, root: string, palette: Palette): string {
  const label = displayPath(change.path, root);

  const skipped = [change.before, change.after].find((s) => s.kind === 'skipped');
  if (skipped?.kind === 'skipped') return `${label}: 未记录内容（${skipped.why}）`;

  const before = change.before.kind === 'text' ? splitLines(change.before.text) : [];
  const after = change.after.kind === 'text' ? splitLines(change.after.text) : [];
  const hunks = toHunks(diffLines(before, after));
  if (hunks.length === 0) return `${label}: 没有净改动。`;

  return formatUnified(label, hunks, palette, { isNew: change.before.kind === 'absent' });
}

/**
 * 一整块 pane —— **这是 `/diff` 装上内建 mod `diff` 之后看到的东西**。
 *
 * 两块，来源不同：
 *
 * | 段 | 数据在谁手里 |
 * | --- | --- |
 * | `[本会话改动]` | CLI（`cli/changes.ts`） |
 * | `[工作区未提交]` | mod（`PaneModel`） |
 *
 * ⚠️ **会话那一段是在这里补的，不在 `PaneModel` 里。** 那是 CLI 自己的状态，
 * 让 mod 的模型去装它，就把"只有工作区那一块会随 git 消失"这条所有权判定反过来了 ——
 * 而那条判定正是这一片存在的理由。
 *
 * `session` 每次现取（调用方传 `changes.list()` 的结果，不是早先的快照）：
 * 表在整个会话里长，快照会过期。
 */
export function formatPane(
  model: PaneModel,
  palette: Palette,
  session: readonly FileChange[],
  root: string,
): readonly string[] {
  const lines = [
    palette.bold(
      `── ${model.headline} · ${model.backend} ──  ${model.files} 个文件  +${model.added} −${model.removed}`,
    ),
  ];
  // 退化那句紧跟表头：`+0 −0` 会被读成"没改动"，而真相是"没算"，这句就是那个更正。
  // 用 `bold` 而不是引一个新色：调色板只有五个色，为一行警告加第六个不值当
  // （`ansi.ts` 那五个色各有语义，`yellow` 进来会先例一开就收不住）。
  if (model.why !== undefined) lines.push(palette.bold(`⚠️ ${model.why}`));

  lines.push(palette.bold('[本会话改动]'));
  if (session.length === 0) lines.push('  （本会话还没有改动过文件）');
  else for (const change of session) lines.push(formatChange(change, root, palette));

  for (const section of model.sections) {
    lines.push(palette.bold(`[${section.title}]`));
    for (const file of section.files) {
      const label = displayPath(file.path, root);
      if (file.lines === null) {
        lines.push(`  ${label}（${file.why ?? '没有逐行改动'}）`);
        continue;
      }
      lines.push(indent(formatUnified(label, toHunks(file.lines), palette)));
    }
  }

  return lines;
}

/** 第二块整体缩进两格，好让"它在段里"看得见。 */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
