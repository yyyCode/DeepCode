import { describe, expect, it } from 'vitest';
import type { ModDeps, ModSpec } from '../src/contract/mod';
import type { Plugin } from '../src/contract/plugin';
import { DEFAULT_TELEMETRY } from '../src/contract/telemetry';
import { builtinMods, describeMods, loadMods } from '../src/cli/mods';

/**
 * 装载器自己的测试。
 *
 * 全程用**夹具 mod**（就地定义），不碰 `mods/` 里那四个真货 —— 这里要问的是
 * "缺依赖会怎样"，而真货今天都不依赖外部东西，问不出来。
 *
 * 出口标准那条"可选依赖缺失时主流程无损"在这里落地：降级不是"优化"，是**必须**；
 * 而三种降级的原因必须**分得开**（探针说没有 / 探针坏了 / create 抛了）——
 * 混成一个 `failed` 会让我们的 bug 混进"用户的机器没有东西"里被静默。
 */

const DEPS: ModDeps = {
  root: '/repo',
  home: '/home/u',
  sessionId: 's1',
  warn: () => {},
  telemetry: DEFAULT_TELEMETRY,
  policyRules: [],
};

function plugin(name: string): Plugin {
  return { name, uses: [], register: () => {} };
}

describe('loadMods：正常路径', () => {
  it('探针全过 → 插件按 mod 顺序进来，报告全是 loaded，且一句话都不多说', async () => {
    const a: ModSpec = { name: 'a', summary: '甲', create: () => [plugin('a1'), plugin('a2')] };
    const b: ModSpec = {
      name: 'b',
      summary: '乙',
      optionalDeps: [{ name: 'nope', probe: () => true }],
      create: () => [plugin('b1')],
    };

    const { plugins, report } = await loadMods(DEPS, [a, b]);

    expect(plugins.map((p) => p.name)).toEqual(['a1', 'a2', 'b1']);
    expect(report.outcomes).toEqual([
      { name: 'a', status: 'loaded' },
      { name: 'b', status: 'loaded' },
    ]);
    // 全都装上了就**一个字都不许说** —— 正常路径上的额外输出会训练人忽略它。
    expect(describeMods(report)).toEqual([]);
  });

  it('一个 mod 都没有 → 零插件、零输出', async () => {
    const { plugins, report } = await loadMods(DEPS, []);
    expect(plugins).toEqual([]);
    expect(describeMods(report)).toEqual([]);
  });
});

describe('loadMods：缺了依赖（降级，且说人话）', () => {
  it('探针说 false → 不装这个 mod，其余照装，报告点名是哪个依赖', async () => {
    const missing: ModSpec = {
      name: 'ghi',
      summary: '要 git',
      optionalDeps: [{ name: 'git', probe: () => false }],
      create: () => [plugin('不该出现')],
    };
    const other: ModSpec = { name: 'ok', summary: '没事', create: () => [plugin('ok1')] };

    const { plugins, report } = await loadMods(DEPS, [missing, other]);

    expect(plugins.map((p) => p.name)).toEqual(['ok1']);
    expect(report.outcomes[0]).toEqual({ name: 'ghi', status: 'missing', dep: 'git' });
    const said = describeMods(report);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('ghi');
    expect(said[0]).toContain('git');
  });

  it('第一个依赖就缺 → 后面的探针不再跑（别问一个已经不装的 mod 后面的问题）', async () => {
    let secondRan = false;
    const mod: ModSpec = {
      name: 'x',
      summary: '',
      optionalDeps: [
        { name: 'first', probe: () => false },
        { name: 'second', probe: () => { secondRan = true; return true; } },
      ],
      create: () => [],
    };
    await loadMods(DEPS, [mod]);
    expect(secondRan).toBe(false);
  });

  it('探针**抛**了 → 与"没有这个依赖"分得开：报告说这是我们自己的 bug', async () => {
    const brokenProbe: ModSpec = {
      name: 'y',
      summary: '',
      optionalDeps: [
        {
          name: 'git',
          probe: () => {
            throw new Error('探针写错了');
          },
        },
      ],
      create: () => [plugin('不该出现')],
    };

    const { plugins, report } = await loadMods(DEPS, [brokenProbe]);

    expect(plugins).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ name: 'y', status: 'probe-failed', dep: 'git' });
    const said = describeMods(report)[0] ?? '';
    expect(said).toContain('bug');
    // 与 missing 那条判词不同 —— 这正是四态存在的理由。
    expect(said).not.toContain('这台机器上没有');
  });
});

describe('loadMods：装配期炸了（也不许传染）', () => {
  it('create 抛 → 这个 mod 报 broken，别的 mod 照装，CLI 不会因此起不来', async () => {
    const boom: ModSpec = {
      name: 'boom',
      summary: '',
      create: () => {
        throw new Error('装配时炸了');
      },
    };
    const ok: ModSpec = { name: 'ok', summary: '', create: () => [plugin('ok1')] };

    const { plugins, report } = await loadMods(DEPS, [boom, ok]);

    expect(plugins.map((p) => p.name)).toEqual(['ok1']);
    expect(report.outcomes).toEqual([
      { name: 'boom', status: 'broken', error: 'Error: 装配时炸了' },
      { name: 'ok', status: 'loaded' },
    ]);
    expect(describeMods(report)[0] ?? '').toContain('装配失败');
  });
});

describe('builtinMods：真清单', () => {
  it('三个 mod，顺序是 sec-default → agents-md → telemetry（顺序即契约）', async () => {
    // sec-default 要与 plugin-guard 挨着；agents-md 整片在 coreTools 之前；
    // telemetry 是个读者，放最后。三条都写在 `cli/mods.ts` 的注释里。
    expect(builtinMods().map((mod) => mod.name)).toEqual(['sec-default', 'agents-md', 'telemetry']);
  });

  it('真清单装出来的插件名是可预期的（装配表按名字推豁免名单）', async () => {
    const { plugins, report } = await loadMods(DEPS, builtinMods());
    expect(plugins.map((p) => p.name)).toEqual(['sec-default', 'instructions', 'agents-md', 'telemetry']);
    expect(describeMods(report)).toEqual([]);
  });

  it('真清单今天**没有**可选依赖 —— 这不是忘了写，是它们真的不挑环境', async () => {
    // 第一个真依赖（git）随 P5c 的 diff mod 进来。到那天这条断言会红 ——
    // 那正是它该红的时候：红的这一刻提醒你，出口标准第二条终于有了真实例证，
    // 该在 P5c 的检查点里补上"把 git 拿掉，主流程无损"那一条。
    expect(builtinMods().every((mod) => (mod.optionalDeps ?? []).length === 0)).toBe(true);
  });
});
