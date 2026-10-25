import { describe, expect, it } from 'vitest';
import { runMemoryBenchmarks } from '../scripts/benchmark-memory';

/**
 * 记忆 benchmark 的断言（P12 §8）。
 *
 * 它钉的不是具体 token 数（估算法会变），而是三条**方向**：
 * 索引比全量正文小一个数量级；关键词召回在造好的样本上全中；250 条时索引按规矩截断。
 */
describe('记忆 benchmark', () => {
  it('关键词召回在 40 条样本上全中，且注入量远小于全量正文', async () => {
    const result = await runMemoryBenchmarks();
    const row = result.rows.find((item) => item.scenario === 'recall-40');
    expect(row).toBeDefined();

    expect(row?.hits).toBe(row?.queries);
    expect(row?.queries).toBe(12);
    expect(row?.indexed.tokens).toBeLessThan((row?.baseline.baselineTokens ?? 0) * 0.2);
    expect(row?.indexTruncated).toBe(false);
  });

  it('250 条时索引按 200 行截断，注入量仍然小于全量', async () => {
    const result = await runMemoryBenchmarks();
    const row = result.rows.find((item) => item.scenario === 'large-index');
    expect(row?.memories).toBe(250);
    expect(row?.indexLines).toBe(200);
    expect(row?.indexTruncated).toBe(true);
    expect(row?.indexed.tokens).toBeLessThan(row?.baseline.baselineTokens ?? 0);
  });

  it('中英混排的查询各自命中同语种的记忆', async () => {
    const result = await runMemoryBenchmarks();
    const mixed = result.rows.find((item) => item.scenario === 'mixed-language');
    expect(mixed?.hits).toBe(mixed?.queries);
    expect(mixed?.queries).toBe(8);
  });

  it('每一次召回记录里期望的那条都在 picked 里', async () => {
    const result = await runMemoryBenchmarks();
    for (const row of result.recallRows) {
      expect(row.picked.length).toBeGreaterThan(0);
      expect(row.picked.length).toBeLessThanOrEqual(5);
      expect(row.hit).toBe(true);
    }
  });
});
