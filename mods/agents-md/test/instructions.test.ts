import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { ManagedInstruction } from '@deepcode/contract/instructions';
import { createEngine } from '@deepcode/core/create';
import { createInstructionsPlugin } from '../instructions';
import { scriptedProvider } from '../../../test/harness';

let root: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-instructions-root-'));
  home = await mkdtemp(join(tmpdir(), 'deepcode-instructions-home-'));
  await mkdir(join(home, '.deepcode'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '根 AGENTS 正文', 'utf8');
  await writeFile(join(root, 'CLAUDE.md'), '根 CLAUDE 正文', 'utf8');
  await writeFile(join(home, '.deepcode', 'AGENTS.md'), '用户层 AGENTS 正文', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function sections(
  files = { root, home },
  managed: readonly ManagedInstruction[] = [],
): Promise<readonly { readonly name: string; readonly text: string }[]> {
  const { dispatch } = await createEngine({
    plugins: [createInstructionsPlugin({ ...files, managed })],
    provider: scriptedProvider([]),
    ui: { print: () => {}, notice: () => {}, ask: async () => '' },
    sessionInfo: { id: 's1', cwd: files.root, root: files.root },
    env: {},
    signal: () => new AbortController().signal,
  });
  const result = await dispatch('prompt.section', {}, CORE_ORIGIN);
  return result.sections;
}

describe('prompt.section：指令文件从事件里来', () => {
  it('三份都不在 = 没有这一节（不是一节空文本）', async () => {
    // 空目录：这条同时是"链尾空清单"与"插件自己空手而归"两条路的交集。
    const empty = await mkdtemp(join(tmpdir(), 'deepcode-instructions-empty-'));
    try {
      expect(await sections({ root: empty, home: empty })).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('三份都在 = 一节，顺序是 根 AGENTS → 根 CLAUDE → 用户层 AGENTS', async () => {
    const got = await sections();
    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe('instructions');

    const text = got[0]?.text ?? '';
    expect(text).toContain('根 AGENTS 正文');
    expect(text).toContain('根 CLAUDE 正文');
    expect(text).toContain('用户层 AGENTS 正文');
    // 顺序不是随手排的：越靠近项目的越靠前 —— 三份都有时，模型的注意力先落在项目上。
    const order = ['根 AGENTS 正文', '根 CLAUDE 正文', '用户层 AGENTS 正文'].map((needle) =>
      text.indexOf(needle),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('每份正文都带着自己的路径 —— 模型得知道每段话是从哪个文件来的', async () => {
    const text = await sections().then((got) => got[0]?.text ?? '');
    expect(text).toContain(`Contents of ${join(root, 'AGENTS.md')}:`);
    expect(text).toContain(`Contents of ${join(root, 'CLAUDE.md')}:`);
    expect(text).toContain(`Contents of ${join(home, '.deepcode', 'AGENTS.md')}:`);
  });

  it('一个项目文件都不在时，用户层那份照样成节（不是"全有才出一节"）', async () => {
    const lonely = await mkdtemp(join(tmpdir(), 'deepcode-instructions-lonely-'));
    try {
      const got = await sections({ root: lonely, home });
      expect(got).toHaveLength(1);
      expect(got[0]?.text).toContain('用户层 AGENTS 正文');
      expect(got[0]?.text).not.toContain('根 AGENTS 正文');
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
  });

  it('**只有 ENOENT 算"没有"**：读不动的文件让这一节整节消失，而不是悄悄少一半', async () => {
    // 用一个"存在但读不成文本"的路径 —— 目录。它不是 ENOENT，所以插件会抛。
    // 抛出去之后链的故障隔离会跳过这个 hook，链尾的空清单顶上 —— 于是这一节是空的，
    // 同时 stderr 上留了一句警告。这正是想要的形状：**安静的失效**才是要防的东西。
    const brokenRoot = await mkdtemp(join(tmpdir(), 'deepcode-instructions-broken-'));
    await mkdir(join(brokenRoot, 'CLAUDE.md'), { recursive: true });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await sections({ root: brokenRoot, home })).toEqual([]);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('instructions') && line.includes('prompt.section'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });
});

/**
 * P5b：本机层与托管下发。
 *
 * 上面那五条是 P5a 原样搬过来的回归 —— 它们钉的顺序（根 AGENTS → 根 CLAUDE →
 * 用户层 AGENTS）在这一轮之后**仍然成立**：新加的 `local` 层插在 project 与 user
 * 之间，`managed` 排在最后，都没有打乱那三份的相对次序。这正是"顺序从
 * `INSTRUCTION_LAYERS` 推"的好处：改动加一层，不需要去改旧断言。
 */
describe('五层：本机层、用户层与托管下发的顺序', () => {
  /** 造一棵有 project + local 两层的树，返回它的根。 */
  async function layeredRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'deepcode-instructions-five-'));
    await mkdir(join(dir, '.deepcode'), { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), '项目层正文', 'utf8');
    await writeFile(join(dir, '.deepcode', 'AGENTS.md'), '本机层正文', 'utf8');
    return dir;
  }

  it('项目 → 本机 → 用户 → 托管：越贴近这个仓库的越靠前，托管最后说话', async () => {
    const dir = await layeredRoot();
    try {
      const text = await sections({ root: dir, home }, [
        { label: '/etc/deepcode/policy.md', text: '托管层正文' },
      ]).then((got) => got[0]?.text ?? '');

      // 四份都在，且次序就是契约里那张表。
      const at = ['项目层正文', '本机层正文', '用户层 AGENTS 正文', '托管层正文'].map((needle) =>
        text.indexOf(needle),
      );
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('本机层住 `.deepcode/`，两份文件都收 —— 它不该进版本库，那个目录已经在 .gitignore 里', async () => {
    const dir = await layeredRoot();
    try {
      await writeFile(join(dir, '.deepcode', 'CLAUDE.md'), '本机层 CLAUDE 正文', 'utf8');
      const text = await sections({ root: dir, home }).then((got) => got[0]?.text ?? '');
      expect(text).toContain(`Contents of ${join(dir, '.deepcode', 'AGENTS.md')}:`);
      expect(text).toContain(`Contents of ${join(dir, '.deepcode', 'CLAUDE.md')}:`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('托管下发的那几段带自己的出处，且按给的顺序排', async () => {
    const dir = await layeredRoot();
    try {
      const text = await sections({ root: dir, home }, [
        { label: '/etc/deepcode/a.md', text: '甲段' },
        { label: `${dir} 内嵌的 instructions.text`, text: '乙段' },
      ]).then((got) => got[0]?.text ?? '');

      // 出处要跟着正文走：模型得知道每段话是从哪儿来的。
      expect(text).toContain('托管下发的指令（/etc/deepcode/a.md）：');
      expect(text).toContain(`托管下发的指令（${dir} 内嵌的 instructions.text）：`);
      const at = ['甲段', '乙段'].map((needle) => text.indexOf(needle));
      expect(at).toEqual([...at].sort((a, b) => a - b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没有任何下发时，这一个字节都不多 —— 与今天的三层完全一样', async () => {
    const dir = await layeredRoot();
    try {
      const text = await sections({ root: dir, home }).then((got) => got[0]?.text ?? '');
      expect(text).not.toContain('托管');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('只有托管那一份时也成节 —— 组织下发的东西不依赖仓库里有没有指令文件', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'deepcode-instructions-only-managed-'));
    try {
      const got = await sections({ root: empty, home: empty }, [
        { label: '托管设置', text: '只有托管这一句' },
      ]);
      expect(got).toHaveLength(1);
      expect(got[0]?.text).toContain('只有托管这一句');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
