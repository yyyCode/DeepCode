import { describe, expect, it } from 'vitest';
import type { ModDeps } from '@deepcode/contract/mod';
import { DEFAULT_TELEMETRY } from '@deepcode/contract/telemetry';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { createHarness, seat } from '../../../test/harness';
import type { PaneModel } from '../pane';
import { createDiffPanePlugin, diffSpec, plainRenderer, type PaneRenderer } from '../index';

/**
 * `/diff` 插件：它说什么、怎么说。
 *
 * 这个 mod **只**贡献一条命令的应答者（工作区那一块），本会话改动那一段是 CLI 补的
 * （见 `packages/cli/src/diff-render.ts` 的 `formatPane`）—— 所以这里断言的是模型与渲染器
 * 之间的那一截，不是整屏输出。
 */

const DEPS: ModDeps = {
  root: process.cwd(),
  home: '/home/u',
  sessionId: 's1',
  warn: () => {},
  telemetry: DEFAULT_TELEMETRY,
  policyRules: [],
  managedInstructions: [],
};

async function run(render: PaneRenderer): Promise<string[]> {
  const logs: string[] = [];
  const h = createHarness({
    engine: { ui: { log: (line: string) => logs.push(line), notice: () => {}, ask: async () => 'n' } } as never,
  });
  seat(h, createDiffPanePlugin(DEPS, render), 'builtin');
  await h.dispatch('command.run', { name: 'diff', args: [] }, CORE_ORIGIN);
  return logs;
}

describe('/diff 插件', () => {
  it('渲染器返回的行逐条打出去', async () => {
    const logs = await run((model: PaneModel) => [`第一行(${model.backend})`, '第二行']);
    expect(logs).toEqual(['第一行(git)', '第二行']);
  });

  it('渲染器返回一整段字符串也行 —— 注入方不该被一种形状绑住', async () => {
    const logs = await run(() => '甲\n乙\n');
    expect(logs).toEqual(['甲', '乙']);
  });

  it('空段被丢掉 —— 不留一行空行在块中间', async () => {
    const logs = await run(() => ['甲', '', '乙']);
    expect(logs).toEqual(['甲', '乙']);
  });

  it('渲染器拿到的模型是**真**从后端来的（这里就是本仓库的工作区）', async () => {
    let seen: PaneModel | undefined;
    await run((model) => {
      seen = model;
      return ['x'];
    });
    expect(seen).toBeDefined();
    expect(seen?.backend).toBe('git');
    // 本仓库在跑测试时未必干净，但那个模型一定长成它该有的样子。
    expect(typeof seen?.files).toBe('number');
  });

  it('有 describe 应答者（漏了的话 /help 会当它"忘了写"）', async () => {
    const h = createHarness({ engine: {} as never });
    seat(h, createDiffPanePlugin(DEPS, plainRenderer), 'builtin');
    const said = await h.dispatch('command.describe', { name: 'diff' }, CORE_ORIGIN);
    expect(said).toMatchObject({ description: expect.stringContaining('工作区') });
  });
});

describe('plainRenderer：只给测试用的那个', () => {
  it('把模型摊成几行，表头那一行说明后端与总数', () => {
    const lines = [
      ...(plainRenderer({
        backend: 'git',
        headline: '工作区改动',
        files: 2,
        added: 5,
        removed: 1,
        detailed: true,
        sections: [
          { title: '工作区未提交', files: [{ path: 'a.ts', status: 'modified', lines: null, why: '太大' }] },
        ],
      }) as readonly string[]),
    ];
    expect(lines[0]).toBe('── 工作区改动 · git ──  2 个文件  +5 −1');
    expect(lines).toContain('[工作区未提交]');
    expect(lines.join('\n')).toContain('a.ts（太大）');
  });
});

describe('spec 描述符', () => {
  it('名字是 diff，且可选依赖只有 git 一条', () => {
    const spec = diffSpec(plainRenderer);
    expect(spec.name).toBe('diff');
    expect(spec.optionalDeps?.map((dep) => dep.name)).toEqual(['git']);
  });
});
