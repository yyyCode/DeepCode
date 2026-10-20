import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffLines, splitLines, toHunks } from '../mods/diff/lines';
import type { PaneModel } from '../mods/diff/pane';
import { createPalette } from '@deepcode/cli/ansi';
import { displayPath, formatChange, formatPane, formatUnified } from '@deepcode/cli/diff-render';
import type { FileChange } from '@deepcode/cli/changes';

/**
 * 渲染那一侧的断言（P5c 从 `test/diff.test.ts` 搬来的三条 + 新增 pane 的几条）。
 *
 * 它留在这边而**不搬进 `mods/diff/test/`**：这一整个文件测的东西都要 `Palette`，
 * 而 mod 不许认识 `Palette`（边界规则）。搬过去的话，要么测试红，要么规则破。
 */

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

describe('formatChange：一条会话改动', () => {
  const ROOT = join(sep, 'work', 'p');
  const palette = createPalette(false);

  it('新建文件 → 整段是 add，旧侧指 /dev/null', () => {
    const change: FileChange = {
      path: join(ROOT, 'a.ts'),
      before: { kind: 'absent' },
      after: { kind: 'text', text: 'hi\n' },
    };
    const text = formatChange(change, ROOT, palette);
    expect(text).toContain('--- /dev/null');
    expect(text).toContain('+hi');
  });

  it('写了一遍但一字未变 → 说"没有净改动"，不打一片空白', () => {
    const change: FileChange = {
      path: join(ROOT, 'a.ts'),
      before: { kind: 'text', text: 'hi\n' },
      after: { kind: 'text', text: 'hi\n' },
    };
    expect(formatChange(change, ROOT, palette)).toBe('a.ts: 没有净改动。');
  });

  it('一侧 skipped → 说清为什么没内容，别假装没改过', () => {
    const change: FileChange = {
      path: join(ROOT, 'big.bin'),
      before: { kind: 'skipped', why: '文件太大' },
      after: { kind: 'text', text: 'x' },
    };
    expect(formatChange(change, ROOT, palette)).toBe('big.bin: 未记录内容（文件太大）');
  });
});

describe('formatPane：两块合起来的那一屏', () => {
  const ROOT = join(sep, 'work', 'p');
  const palette = createPalette(false);

  const model = (over: Partial<PaneModel> = {}): PaneModel => ({
    backend: 'git',
    headline: '工作区改动',
    files: 1,
    added: 2,
    removed: 1,
    detailed: true,
    sections: [
      {
        title: '工作区未提交',
        files: [
          {
            path: join(ROOT, 'src', 'b.ts'),
            status: 'modified',
            lines: diffLines(splitLines('a\n'), splitLines('a\nb\n')),
          },
        ],
      },
    ],
    ...over,
  });

  it('表头那一行说明后端、文件数与增删', () => {
    const lines = formatPane(model(), palette, [], ROOT);
    expect(lines[0]).toBe('── 工作区改动 · git ──  1 个文件  +2 −1');
  });

  it('退化时表头后紧跟那句人话 —— `+0 −0` 会被读成"没改动"', () => {
    const lines = formatPane(
      model({ detailed: false, added: 0, removed: 0, why: '文件太多，没逐文件算' }),
      palette,
      [],
      ROOT,
    );
    expect(lines[1]).toContain('文件太多');
  });

  it('两块**都在**，且本会话那一段在前', () => {
    const session: readonly FileChange[] = [
      {
        path: join(ROOT, 'src', 'a.ts'),
        before: { kind: 'absent' },
        after: { kind: 'text', text: 'hi\n' },
      },
    ];
    const lines = formatPane(model(), palette, session, ROOT);

    const sessionAt = lines.indexOf('[本会话改动]');
    const worktreeAt = lines.indexOf('[工作区未提交]');
    expect(sessionAt).toBeGreaterThan(0);
    expect(worktreeAt).toBeGreaterThan(sessionAt);
    // 两块各自的内容真的在
    expect(lines.join('\n')).toContain('+hi');
    expect(lines.join('\n')).toContain(join('src', 'b.ts'));
  });

  it('本会话一个文件都没改过 → 那一段说一句，不留下一个空标题', () => {
    const lines = formatPane(model(), palette, [], ROOT);
    expect(lines[lines.indexOf('[本会话改动]') + 1]).toBe('  （本会话还没有改动过文件）');
  });

  it('工作区那一块自己拿不到逐行时 → 那一行带原因', () => {
    const lines = formatPane(
      model({
        sections: [
          {
            title: '工作区未提交',
            files: [{ path: join(ROOT, 'x.bin'), status: 'modified', lines: null, why: '文件太大' }],
          },
        ],
      }),
      palette,
      [],
      ROOT,
    );
    expect(lines.join('\n')).toContain('x.bin（文件太大）');
  });
});
