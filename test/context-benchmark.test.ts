import { describe, expect, it } from 'vitest';
import { runBenchmarks } from '../scripts/benchmark-context';

/**
 * benchmark 的两条断言（P11 §8.1 第 6 条）：
 * 1. 分层策略的**峰值请求 token 不劣于**「只有第 5 层」；
 * 2. 摘要调用（第 4 层折叠 + 第 5 层全量）**不多于**基线。
 *
 * 这两条是回归护栏，不是性能证明：阈值或默认值改坏了，这里会先红。
 * 具体数字由 `pnpm bench` 打印，设计文档 §8.3 抄的就是那一张表。
 */
const rowsPromise = runBenchmarks();

describe('P11 benchmark：分层不劣于「只有第 5 层」', () => {
  it('三个场景：峰值更低或持平，摘要调用不多于基线', async () => {
    const rows = await rowsPromise;
    expect(rows.map((row) => row.scenario)).toEqual(['huge-reads', 'long-session', 'mixed']);

    for (const row of rows) {
      expect(row.layered.peakTokens).toBeLessThanOrEqual(row.baseline.peakTokens);
      expect(row.layered.summaryCalls + row.layered.collapseCalls).toBeLessThanOrEqual(
        row.baseline.summaryCalls,
      );
    }
  });

  it('huge-reads：第 1 层把每个 80K 结果都外置，峰值大幅下降', async () => {
    const row = (await rowsPromise).find((one) => one.scenario === 'huge-reads');
    expect(row?.layered.externalized).toBe(15);
    expect(row!.layered.peakTokens).toBeLessThan(row!.baseline.peakTokens * 0.5);
    expect(row?.layered.summaryCalls).toBe(0);
  });

  it('long-session：第 2 层把峰值压住，不动用全量摘要', async () => {
    const row = (await rowsPromise).find((one) => one.scenario === 'long-session');
    expect(row?.layered.snipRequests).toBeGreaterThan(0);
    expect(row?.layered.summaryCalls).toBe(0);
    expect(row?.baseline.summaryCalls).toBeGreaterThanOrEqual(1);
  });

  it('mixed：大读与小输出混在一起时，第 1 层仍认得出那 6 次大读', async () => {
    const row = (await rowsPromise).find((one) => one.scenario === 'mixed');
    expect(row?.layered.externalized).toBe(6);
    expect(row?.layered.summaryCalls).toBe(0);
    expect(row?.baseline.summaryCalls).toBeGreaterThanOrEqual(2);
  });
});
