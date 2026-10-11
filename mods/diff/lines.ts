/**
 * 行级 diff 的算法。**纯数据、纯函数、不认识颜色**（P5c 从 `src/cli/diff.ts` 搬来的）。
 *
 * 上色（`Palette`）留在了 `src/cli/diff-render.ts` —— 边界规则不许 mod import `cli/ansi`，
 * 而"把 `ansi.ts` 也搬进 mod"是绕开规则，不是遵守它（P5 设计 §3.2）。
 * 于是这个 mod 只能**产出模型**，渲染归引擎：`formatUnified` 拿这些 `DiffLine` 去上色。
 */

export type DiffLine = { readonly kind: 'context' | 'del' | 'add'; readonly text: string };

export type Hunk = {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
};

/** 中段做 DP 的规模上限：超过就退化成"整段替换"。 */
const MAX_DP_CELLS = 1_000_000;
const CONTEXT = 3;

/**
 * 拆行。`a\nb\n` 切出来是 ['a','b','']，末尾那个空串是行尾换行符的产物、不是一行空行 ——
 * 留着它会让"文件末尾有没有换行"变成一行假改动。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 行级 diff。
 *
 * 先砍公共前后缀：改一个文件通常只动了中间几行，砍完 DP 的规模小一个量级
 * （这是它便宜的原因，不是锦上添花）。中段用 LCS DP；规模超上限就整段替换 ——
 * 结果仍然正确，只是不好看，而不好看远好过卡死。
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const oldMid = before.slice(head, before.length - tail);
  const newMid = after.slice(head, after.length - tail);

  const out: DiffLine[] = before.slice(0, head).map((text) => ({ kind: 'context' as const, text }));

  if (oldMid.length === 0) {
    for (const text of newMid) out.push({ kind: 'add', text });
  } else if (newMid.length === 0) {
    for (const text of oldMid) out.push({ kind: 'del', text });
  } else if (oldMid.length * newMid.length > MAX_DP_CELLS) {
    for (const text of oldMid) out.push({ kind: 'del', text });
    for (const text of newMid) out.push({ kind: 'add', text });
  } else {
    out.push(...lcsDiff(oldMid, newMid));
  }

  for (const text of before.slice(before.length - tail)) out.push({ kind: 'context', text });
  return out;
}

function lcsDiff(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;

  // Uint32Array 而不是 number[][]：一百万格用嵌套数组会真的吃掉几十兆。
  const table = new Uint32Array((n + 1) * width);
  // noUncheckedIndexedAccess 下 typed array 的索引也带 undefined，收成两个小访问器，
  // 免得等式里到处撒 `!` 和 `??`。
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  const put = (i: number, j: number, value: number): void => {
    table[i * width + j] = value;
  };

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      put(
        i,
        j,
        oldLines[i] === newLines[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1)),
      );
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      // 配对上了就**两侧都**前进 —— 只走 i 的话 new[j] 没被消费，同一个元素
      // 下一轮又会当成 add 再吐一遍，剩下的行全被顶歪。
      out.push({ kind: 'context', text: oldLines[i]! });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: oldLines[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: newLines[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: oldLines[i++]! });
  while (j < m) out.push({ kind: 'add', text: newLines[j++]! });
  return out;
}

/**
 * 按上下文切 hunk。两处改动的间隔 ≤ 2*context 就并进同一个 —— 与 `git diff` 同口径。
 */
export function toHunks(lines: readonly DiffLine[], context: number = CONTEXT): Hunk[] {
  const changed = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const hunks: Hunk[] = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(lines.length, changed[0]! + context + 1);

  for (const index of changed.slice(1)) {
    if (index - context <= end) {
      end = Math.min(lines.length, index + context + 1);
      continue;
    }
    hunks.push(buildHunk(lines, start, end));
    start = Math.max(0, index - context);
    end = Math.min(lines.length, index + context + 1);
  }

  hunks.push(buildHunk(lines, start, end));
  return hunks;
}

function buildHunk(lines: readonly DiffLine[], start: number, end: number): Hunk {
  const slice = lines.slice(start, end);

  let oldCount = 0;
  let newCount = 0;
  for (const line of slice) {
    if (line.kind !== 'add') oldCount++;
    if (line.kind !== 'del') newCount++;
  }

  return {
    oldStart: hunkStart(lines, start, 'add', oldCount),
    oldCount,
    newStart: hunkStart(lines, start, 'del', newCount),
    newCount,
    lines: slice,
  };
}

/**
 * 这段 hunk 的起始行号。
 *
 * 一侧计数为 0 时起始号写 0（`@@ -0,0 +1,3 @@` 表示"从空文件长出来的"），
 * 这是 unified diff 的约定，不是 off-by-one。
 */
function hunkStart(
  lines: readonly DiffLine[],
  index: number,
  skip: 'add' | 'del',
  count: number,
): number {
  let before = 0;
  for (let i = 0; i < index; i++) {
    if (lines[i]!.kind !== skip) before++;
  }
  return count === 0 ? before : before + 1;
}
