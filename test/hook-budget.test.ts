// test/hook-budget.test.ts
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { createHarness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 20ms 的预算 —— 于是 80ms 一定超时，而测试不用等 10 秒。 */
const BUDGET = 20;
const SLOW = 80;

describe('hook 时间预算', () => {
  it('tool.call 不上预算：慢工具不会被判成 hook 失败', async () => {
    const h = createHarness({ hookBudgetMs: BUDGET });
    h.on('builtin', 'slow-tool', 'tool.call', async () => {
      await sleep(SLOW);
      return { value: '跑完了' };
    });

    const result = await h.dispatch(
      'tool.call',
      { tool: 'Bash', input: {}, toolUseId: 'u1' },
      CORE_ORIGIN,
    );

    expect(result).toEqual({ value: '跑完了' });
    // 关键的一条：不能有"失败已跳过"。旧行为下这里是假的 unknown tool，
    // 而命令其实还在后台跑 —— 这正是要修掉的病。
    expect(h.warnings).toEqual([]);
  });

  it('对照：别的事件照旧上预算，超时的 hook 被摘掉、由下层应答', async () => {
    const h = createHarness({ hookBudgetMs: BUDGET });
    // 慢的那个钉在 `user`（比 `builtin` 靠外）—— 用**座位**而不是注册顺序来定内外，
    // 这样这条用例不依赖"同 tier 内先注册者在外层"那个细节。
    h.on('user', 'slow-describer', 'tool.describe', async () => {
      await sleep(SLOW);
      return { description: '来自慢的那个', inputSchema: {} };
    });
    h.on('builtin', 'fast-describer', 'tool.describe', () => ({
      description: '来自下层',
      inputSchema: {},
    }));

    const result = await h.dispatch('tool.describe', { tool: 'Read' }, CORE_ORIGIN);

    expect(result).toEqual({ description: '来自下层', inputSchema: {} });
    expect(h.warnings.some((line) => line.includes('失败已跳过'))).toBe(true);
  });

  it('next.budget.ms：tool.call 是不上预算的名义值，普通事件拿到 10 秒', async () => {
    // 这个不对称是这一任务的全部意义 —— 只测"慢工具没被判死"是行为层，
    // 这一条把它钉在 `next.budget` 这个可观测面上（否则将来有人"顺手统一"回去没人拦得住）。
    // 探针要 `next(e)` 透传到底，所以链底得给个应答者 —— 否则落进 NotImplementedError，
    // 与预算无关。这条桩只为让透传跑完，断言与它无关。
    const h = createHarness({
      coreImpls: {
        'tool.call': () => ({ value: 'core' }),
        'tool.describe': () => ({ description: 'core', inputSchema: {} }),
      },
    });
    let onToolCall: number | undefined;
    let onDescribe: number | undefined;
    h.on('builtin', 'probe-call', 'tool.call', async (_$, e, next) => {
      onToolCall = next.budget.ms;
      return next(e);
    });
    h.on('builtin', 'probe-desc', 'tool.describe', async (_$, e, next) => {
      onDescribe = next.budget.ms;
      return next(e);
    });

    await h.dispatch('tool.call', { tool: 'Bash', input: {}, toolUseId: 'u1' }, CORE_ORIGIN);
    await h.dispatch('tool.describe', { tool: 'Read' }, CORE_ORIGIN);

    expect(onToolCall).toBe(Number.POSITIVE_INFINITY);
    expect(onDescribe).toBe(10_000);
  });
});
