import { describe, expect, it } from 'vitest';
import type { Backend, BackendWords, PaneEntry, PaneFileHunks } from '../backend';
import { buildPane, FILE_LIMIT, headerTotalsOf, partitionOf, type PaneFile } from '../pane';
import { diffLines, splitLines } from '../lines';

/**
 * 模型那一侧的断言。全程**假后端** —— 这里要问的是"给我一份改动，模型长什么样"，
 * 与 git 一个字的关系都没有（那是 `backend.test.ts` 的事）。
 *
 * §5.3 判据三里那句"模型是纯数据"就在第一组：
 * 同一份改动算两次，模型逐字节相同。
 */

const WORDS: BackendWords = {
  name: 'fake',
  clean: '工作区干净',
  empty: 'fake 没有给出逐行改动',
  degraded: (files, limit) => `改了 ${files} 个文件，超过 ${limit} 个就不逐文件算了`,
};

const entries = (n: number): readonly PaneEntry[] =>
  Array.from({ length: n }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' as const }));

function fakeBackend(
  list: readonly PaneEntry[],
  hunks: (paths: readonly string[]) => readonly PaneFileHunks[],
): Backend {
  return { words: WORDS, list: async () => list, hunks: async (paths) => hunks(paths) };
}

const oneHunk = (path: string): PaneFileHunks => ({
  path,
  lines: diffLines(splitLines('a\n'), splitLines('a\nb\n')),
});

describe('模型是纯数据（§5.3 判据三）', () => {
  it('同一份改动算两次，逐字节相同', async () => {
    const backend = fakeBackend(entries(3), (paths) => paths.map(oneHunk));

    const first = await buildPane({ backend });
    const second = await buildPane({ backend });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // 而且不是"两次都空"这种廉价的相等
    expect(first.added).toBeGreaterThan(0);
  });

  it('headerTotalsOf 只从那一份文件数组推 —— 同一份输入永远同一个数', () => {
    const files: readonly PaneFile[] = [
      { path: 'a', status: 'modified', lines: diffLines(splitLines('a\n'), splitLines('a\nb\n')) },
      { path: 'b', status: 'added', lines: diffLines([], splitLines('x\ny\n')) },
    ];
    expect(headerTotalsOf(files)).toEqual({ files: 2, added: 3, removed: 0 });
  });

  it('partitionOf 只按位置切一刀，不改变顺序', () => {
    const files: readonly PaneFile[] = Array.from({ length: FILE_LIMIT + 3 }, (_, i) => ({
      path: `f${i}`,
      status: 'modified' as const,
      lines: null,
    }));
    const { shown, rest } = partitionOf(files);
    expect(shown).toHaveLength(FILE_LIMIT);
    expect(rest).toBe(3);
    expect(shown[0]?.path).toBe('f0');
  });
});

describe('工作区干净', () => {
  it('零个文件 → 用后端自己那句话，不打一块空的东西出来', async () => {
    const model = await buildPane({ backend: fakeBackend([], () => []) });
    expect(model.headline).toBe('工作区干净');
    expect(model.files).toBe(0);
    expect(model.detailed).toBe(true);
    expect(model.sections).toEqual([]);
  });
});

describe('性能闸：先取小再决定要不要取大（§5.2）', () => {
  it('恰好 FILE_LIMIT 个文件 → 走逐文件那条路', async () => {
    const model = await buildPane({
      backend: fakeBackend(entries(FILE_LIMIT), (paths) => paths.map(oneHunk)),
    });
    expect(model.detailed).toBe(true);
    expect(model.added).toBe(FILE_LIMIT);
    expect(model.sections[0]?.files[0]?.lines).not.toBeNull();
  });

  it('FILE_LIMIT + 1 个文件 → 退化：只给总数与文件名', async () => {
    const model = await buildPane({
      backend: fakeBackend(entries(FILE_LIMIT + 1), (paths) => paths.map(oneHunk)),
    });
    expect(model.detailed).toBe(false);
    expect(model.files).toBe(FILE_LIMIT + 1);
    expect(model.why).toBe(WORDS.degraded(FILE_LIMIT + 1, FILE_LIMIT));
    expect(model.sections[0]?.files.every((file) => file.lines === null)).toBe(true);
  });

  it('退化时**一次都没有**调用逐文件那条路', async () => {
    // ⚠️ 这条是本片最承重的断言，做法也是刻意的：不在假后端里记调用次数 ——
    // 记次数只证明"没调"，而这里让那一格**直接抛**。
    // 闸门要是被挪到 `hunks()` 之后（行为上看不出来：输出还是退化的样子），
    // 这条会当场炸；而**输出形状那几条全都还是绿的**。
    const backend = fakeBackend(entries(FILE_LIMIT + 1), () => {
      throw new Error('退化路径不该调用逐文件那一格');
    });
    const model = await buildPane({ backend });
    expect(model.detailed).toBe(false);
  });

  it('退化的那一份里 added/removed 是 0，读的人是靠 `detailed` 分辨的', async () => {
    const model = await buildPane({
      backend: fakeBackend(entries(FILE_LIMIT + 1), (paths) => paths.map(oneHunk)),
    });
    expect(model.added).toBe(0);
    expect(model.removed).toBe(0);
    // 于是"0"有两种意思，而 `detailed` 是那个区分字 —— 它必须在。
    expect(model.detailed).toBe(false);
  });
});

describe('后端漏了一格时按"没算过"报，不按"没改动"报', () => {
  it('hunks 里没有这个文件 → lines 是 null，且带一句原因', async () => {
    const model = await buildPane({
      backend: fakeBackend(entries(1), () => []),
    });
    expect(model.sections[0]?.files[0]?.lines).toBeNull();
    expect(model.sections[0]?.files[0]?.why).toContain('后端没有给出');
  });
});
