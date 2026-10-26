import { describe, expect, it } from 'vitest';
import {
  CACHE_TURNS,
  runSystemPromptBenchmarks,
  sessionCost,
} from '../scripts/benchmark-system-prompt';

/**
 * 系统提示 benchmark 的断言（P13 §8）。
 *
 * 它钉的不是某个具体 token 数（估算法会变），而是四条**方向**：
 * 静态段真的存在且分节齐全；换项目时静态段逐字节不变；动态段确实在变；
 * 20 轮会话的缓存收益为正，且从第 2 轮起回本。
 */
describe('系统提示 benchmark', () => {
  it('静态分节一个不少，每节都有正文', async () => {
    const result = runSystemPromptBenchmarks();
    expect(result.staticTokens).toBeGreaterThan(0);
    expect(result.sections.map((row) => row.name)).toEqual([
      'role',
      'security',
      'behavior',
      'safety',
      'tools',
      'git',
      'output',
    ]);
    for (const row of result.sections) {
      expect(row.chars).toBeGreaterThan(0);
      expect(row.tokens).toBeGreaterThan(0);
    }
  });

  it('换项目、换日期、换模型：静态段逐字节相同', async () => {
    const result = runSystemPromptBenchmarks();
    expect(result.staticStable).toBe(true);
    const first = result.scenarios[0]?.staticText;
    expect(first).toBeDefined();
    for (const row of result.scenarios) {
      expect(row.staticText).toBe(first);
    }
  });

  it('动态段确实随项目变化，静态占比落在合理区间', async () => {
    const result = runSystemPromptBenchmarks();
    const small = result.scenarios.find((row) => row.name === 'small-service');
    const mono = result.scenarios.find((row) => row.name === 'monorepo');
    const bare = result.scenarios.find((row) => row.name === 'no-git');
    expect(small).toBeDefined();
    expect(mono).toBeDefined();
    expect(bare).toBeDefined();

    // 小项目：静态段该是大头；巨型 AGENTS.md：动态段会追上来，但仍不应归零。
    expect(small?.staticShare).toBeGreaterThan(0.5);
    expect(mono?.staticShare).toBeGreaterThan(0.2);
    expect(bare?.staticShare).toBeGreaterThan(0.7);
    expect(new Set(result.scenarios.map((row) => row.dynamicTokens)).size).toBeGreaterThan(1);
  });

  it('20 轮会话：有缓存一定更便宜，第 2 轮回本', async () => {
    const result = runSystemPromptBenchmarks();
    expect(result.cache.turns).toBe(CACHE_TURNS);
    for (const row of result.cache.rows) {
      expect(row.cachedUnits).toBeLessThan(row.baselineUnits);
      expect(row.savedUnits).toBeGreaterThan(0);
      expect(row.breakEvenTurn).toBe(2);
      // 最坏的那个场景（AGENTS.md 很长）也该有可见收益，不能只在小项目上成立。
      expect(row.savings).toBeGreaterThan(0.2);
    }
  });

  it('成本模型：没有缓存时每轮都付全价，缓存首轮多付写价', () => {
    const one = sessionCost(100, 50, 1);
    expect(one.baseline).toBe(150);
    expect(one.cached).toBe(175); // 100 × 1.25 + 50

    const two = sessionCost(100, 50, 2);
    expect(two.baseline).toBe(300);
    expect(two.cached).toBe(235); // 175 + (100 × 0.1 + 50)
    expect(two.breakEvenTurn).toBe(2);
  });
});
