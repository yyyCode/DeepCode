import { describe, expect, it } from 'vitest';
import type { ModDeps } from '../../../src/contract/mod';
import { DEFAULT_TELEMETRY } from '../../../src/contract/telemetry';
import { backendOf, type Backend, type BackendProbe, type BackendWords } from '../backend';
import { createGitBackend, gitProbe, parsePorcelain, parseUnified, type GitRunner } from '../git';

/**
 * 后端三层（P5 设计 §5.2）与那个**真**可选依赖 `git`。
 *
 * 全程注入假 `run`：git 不在 PATH 上这件事、改了 600 个文件的仓库，都不必真造出来。
 */

const DEPS: ModDeps = {
  root: '/repo',
  home: '/home/u',
  sessionId: 's1',
  warn: () => {},
  telemetry: DEFAULT_TELEMETRY,
  policyRules: [],
  managedInstructions: [],
};

const words: BackendWords = {
  name: 'x',
  clean: '干净',
  empty: '没有',
  degraded: (files, limit) => `${files}/${limit}`,
};

function stub(name: string, ok: boolean, probes: string[]): BackendProbe {
  return {
    name,
    probe: () => {
      probes.push(name);
      return ok;
    },
    of: (): Backend => ({ words, list: async () => [], hunks: async () => [] }),
  };
}

describe('backendOf：探针优先', () => {
  it('第一个说"有"的赢，后面的根本不被问', async () => {
    const asked: string[] = [];
    const got = await backendOf(
      [stub('first', true, asked), stub('second', true, asked)],
      DEPS,
    );
    expect(got?.words.name).toBe('x');
    expect(asked).toEqual(['first']);
  });

  it('前面都说没有 → 问到最后一个；都不说"有"就是 `undefined`（降级）', async () => {
    const asked: string[] = [];
    const got = await backendOf(
      [stub('a', false, asked), stub('b', false, asked)],
      DEPS,
    );
    expect(got).toBeUndefined();
    expect(asked).toEqual(['a', 'b']);
  });

  it('探针**抛**出去，不在这一层咽 —— 装载器要能分出"坏了"与"没有"', async () => {
    const boom: BackendProbe = {
      name: 'boom',
      probe: () => {
        throw new Error('探针写错了');
      },
      of: () => {
        throw new Error('不该走到这儿');
      },
    };
    await expect(backendOf([boom], DEPS)).rejects.toThrow('探针写错了');
  });
});

describe('gitProbe：这台机器有没有 git', () => {
  const runner = (exitCode: number, calls: string[][] = []): GitRunner =>
    async (args) => {
      calls.push([...args]);
      return { stdout: exitCode === 0 ? 'git version 2.43.0\n' : '', exitCode };
    };

  it('`git --version` 出得来就是有', async () => {
    expect(await gitProbe(DEPS, runner(0))).toBe(true);
  });

  it('非零退出（没装 / 不在 PATH）就是没有 —— 探针不抛，只是 false', async () => {
    expect(await gitProbe(DEPS, runner(127))).toBe(false);
  });

  it('探针问的就是 `--version`，不问别的', async () => {
    const calls: string[][] = [];
    await gitProbe(DEPS, runner(0, calls));
    expect(calls).toEqual([['--version']]);
  });
});

describe('git 后端：只读，且不跟用户的 git 抢锁', () => {
  const calling = (result: { stdout: string; exitCode: number }) => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const run: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return result;
    };
    return { calls, run };
  };

  it('每个调用都带 --no-optional-locks，且 cwd 是仓库根', async () => {
    const { calls, run } = calling({ stdout: '', exitCode: 0 });
    await createGitBackend(DEPS, run).list();
    await createGitBackend(DEPS, run).hunks(['a.ts']);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.args[0]).toBe('--no-optional-locks');
      expect(call.cwd).toBe('/repo');
    }
  });

  it('不是仓库（非零退出）→ 空数组，而不是抛 —— /diff 是个只读视图，它报错没人能处理', async () => {
    const { run } = calling({ stdout: 'fatal: not a git repository', exitCode: 128 });
    const backend = createGitBackend(DEPS, run);
    expect(await backend.list()).toEqual([]);
    expect(await backend.hunks(['a.ts'])).toEqual([
      { path: 'a.ts', lines: null, why: expect.stringContaining('git') },
    ]);
  });

  it('逐文件改动一次子进程读完全部路径（pathspec 没超上限时）', async () => {
    const { calls, run } = calling({ stdout: '', exitCode: 0 });
    await createGitBackend(DEPS, run).hunks(['a.ts', 'b.ts', 'c.ts']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--no-color');
    expect(calls[0]?.args.slice(-4)).toEqual(['--', 'a.ts', 'b.ts', 'c.ts']);
  });
});

describe('parsePorcelain：`git status --porcelain -z`', () => {
  it('四种状态各归各位', () => {
    const out = parsePorcelain('?? new.ts\0 M mod.ts\0A  add.ts\0 D del.ts\0');
    expect(out).toEqual([
      { path: 'new.ts', status: 'untracked' },
      { path: 'mod.ts', status: 'modified' },
      { path: 'add.ts', status: 'added' },
      { path: 'del.ts', status: 'deleted' },
    ]);
  });

  it('带空格的文件名不被切碎 —— 这正是选 `-z` 而不是默认那种写法的理由', () => {
    expect(parsePorcelain(' M my file.ts\0')).toEqual([
      { path: 'my file.ts', status: 'modified' },
    ]);
  });

  it('空输出是空数组，不是一条空记录', () => {
    expect(parsePorcelain('')).toEqual([]);
  });
});

describe('parseUnified：`git diff` 的输出', () => {
  it('三种前缀各归各位，文件级元信息一行都不算改动', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n');

    const parsed = parseUnified(text);
    expect(parsed.get('src/a.ts')?.lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('多个文件各归各的', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+x',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '+y',
    ].join('\n');

    const parsed = parseUnified(text);
    expect(parsed.get('a.ts')?.lines).toEqual([{ kind: 'add', text: 'x' }]);
    expect(parsed.get('b.ts')?.lines).toEqual([{ kind: 'add', text: 'y' }]);
  });

  it('空输出 → 空表（不是一条空记录）', () => {
    expect(parseUnified('').size).toBe(0);
  });
});
