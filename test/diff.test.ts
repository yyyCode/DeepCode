import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPalette } from '../src/cli/ansi';
import { diffLines, displayPath, formatUnified, splitLines, toHunks, type DiffLine } from '../src/cli/diff';

/** 只看 kind 序列，好断言又不会被文本噪音淹没。 */
const kinds = (lines: readonly DiffLine[]): string[] => lines.map((line) => line.kind);

describe('splitLines', () => {
  it('末尾换行不造出一行空行，空串是零行', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    // 这里第二个空串是**真的**空行：'a\n\n' 末尾那个换行符只收掉一个空串。
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('两侧相同，一行改动都没有', () => {
    const lines = ['a', 'b', 'c'];
    expect(diffLines(lines, lines).every((line) => line.kind === 'context')).toBe(true);
    expect(toHunks(diffLines(lines, lines))).toEqual([]);
  });

  it('新文件：整段都是 add，hunk 头一侧计数为 0', () => {
    const lines = diffLines([], ['a', 'b']);
    expect(kinds(lines)).toEqual(['add', 'add']);

    const hunks = toHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
  });

  it('删空文件：整段都是 del，hunk 头另一侧计数为 0', () => {
    const lines = diffLines(['a', 'b'], []);
    expect(kinds(lines)).toEqual(['del', 'del']);

    const hunks = toHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 });
  });

  it('改中间一行：一个 hunk，上下各带 3 行上下文', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[9] = 'line 9 (改过)';

    const hunks = toHunks(diffLines(before, after));
    expect(hunks).toHaveLength(1);

    // 3 上上下文 + del + add + 3 下上下文 = 8 行。
    const hunk = hunks[0]!;
    expect(hunk.lines).toHaveLength(8);
    expect(kinds(hunk.lines)).toEqual([
      'context',
      'context',
      'context',
      'del',
      'add',
      'context',
      'context',
      'context',
    ]);
    // 上下文行两侧都算：oldCount = 6 context + 1 del，newCount = 6 context + 1 add。
    expect(hunk.oldStart).toBe(7);
    expect(hunk.newStart).toBe(7);
    expect(hunk.oldCount).toBe(7);
    expect(hunk.newCount).toBe(7);
  });

  it('中段改动之间夹着的公共行只出一次，不会被同时当成 context 和 add', () => {
    // 单点替换走的是前后缀裁剪，碰不到 DP；这里是两个改动夹着 4 行公共行，
    // 才会真的进 lcsDiff。回溯时漏掉一侧前进的话，公共行会先当 context 吐一遍、
    // 再当 add 吐一遍，后面的行号跟着全歪。
    const lines = diffLines(['A', 'B', 'C', 'D', 'E', 'F'], ['A2', 'B', 'C', 'D', 'E', 'F2']);

    expect(kinds(lines)).toEqual([
      'del',
      'add',
      'context',
      'context',
      'context',
      'context',
      'del',
      'add',
    ]);
    expect(lines.filter((line) => line.text === 'B')).toHaveLength(1);
  });

  it('两处改动相距 5 行并成一个 hunk，相距 40 行分成两个', () => {
    const base = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const edit = (first: number, second: number): string[] => {
      const out = [...base];
      out[first] = `${out[first]} !`;
      out[second] = `${out[second]} !`;
      return out;
    };

    expect(toHunks(diffLines(base, edit(10, 15)))).toHaveLength(1);
    expect(toHunks(diffLines(base, edit(10, 50)))).toHaveLength(2);
  });

  it('超过 DP 上限时退化成整段替换，而不是卡死', () => {
    // 1200 × 1200 = 1.44M > MAX_DP_CELLS(1M)，且两侧元素两两不同、无公共前后缀，
    // 所以乘积就是唯一挡路的东西。
    const n = 1200;
    const before = Array.from({ length: n }, (_, i) => `old ${i}`);
    const after = Array.from({ length: n }, (_, i) => `new ${i}`);

    // 先确认前提成立：公共前后缀为空，否则规模会缩水、断言就白钉了。
    expect(before[0]).not.toBe(after[0]);
    expect(before[n - 1]).not.toBe(after[n - 1]);

    const lines = diffLines(before, after);

    // 直接钉住"走了退化分支"的形状：n + m 行、前半全 del、后半全 add。
    // 只断言"没卡死"是抓不住回归的 —— 真跑起 DP 也会返回（只是慢），
    // 而慢到一定程度就是卡死。
    expect(lines).toHaveLength(n + n);
    expect(lines.slice(0, n).every((line) => line.kind === 'del')).toBe(true);
    expect(lines.slice(n).every((line) => line.kind === 'add')).toBe(true);
    expect(lines[0]).toMatchObject({ kind: 'del', text: 'old 0' });
    expect(lines[n]).toMatchObject({ kind: 'add', text: 'new 0' });
  });
});

describe('formatUnified 与调色板', () => {
  const hunks = toHunks(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']));

  it('关掉着色时输出与"根本没有这个模块"逐字节相同', () => {
    const text = formatUnified('src/a.ts', hunks, createPalette(false));

    expect(text).not.toContain('\u001b');
    expect(text).toBe(
      ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n'),
    );
  });

  it('开着色时 hunk 头是青色、增删行是红绿', () => {
    const text = formatUnified('src/a.ts', hunks, createPalette(true));

    expect(text).toContain('\u001b[36m@@ -1,3 +1,3 @@\u001b[0m');
    expect(text).toContain('\u001b[32m+B\u001b[0m');
    expect(text).toContain('\u001b[31m-b\u001b[0m');
  });

  it('isNew 时旧侧指向 /dev/null', () => {
    const text = formatUnified('src/a.ts', toHunks(diffLines([], ['a'])), createPalette(false), {
      isNew: true,
    });

    expect(text.split('\n')[0]).toBe('--- /dev/null');
  });
});

describe('displayPath', () => {
  const ROOT = join(sep, 'work', 'p');

  it('root 里给相对路径，root 外照直给绝对路径', () => {
    expect(displayPath(join(ROOT, 'src', 'a.ts'), ROOT)).toBe(join('src', 'a.ts'));
    const outside = join(sep, 'other', 'x.ts');
    expect(displayPath(outside, ROOT)).toBe(outside);
  });
});
