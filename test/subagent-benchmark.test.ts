import { describe, expect, it } from 'vitest';
import {
  formatSubagentTables,
  runSubagentBenchmarks,
} from '../scripts/benchmark-subagents';

/**
 * P15 benchmark 的口径测试。
 *
 * 断言的是**结构**，不是绝对耗时：
 * - 委派之后父级上下文只增长摘要量级；
 * - Explore 的三个只读子代理真的重叠，Task 的三个仍然排队；
 * - 开箱名册与内核的只读验证各自成立。
 */

describe('子代理 benchmark：隔离', () => {
  it('同一个 60k 工具结果，委派后父级只剩摘要', async () => {
    const { isolation } = await runSubagentBenchmarks();

    expect(isolation.inline.parentChars).toBeGreaterThan(50_000);
    expect(isolation.delegated.parentChars).toBeLessThan(isolation.inline.parentChars / 4);
    expect(isolation.ratio).toBeLessThan(0.25);
    // 委派多跑了一次模型请求（子代理那一轮），但父级窗口没有跟着涨。
    expect(isolation.delegated.requests).toBeGreaterThan(isolation.inline.requests);
  });
});

describe('子代理 benchmark：并发', () => {
  it('Explore 峰值 3、Task 峰值 1，且并发墙钟更短', async () => {
    const { concurrency } = await runSubagentBenchmarks();
    const explore = concurrency.find((row) => row.tool === 'Explore');
    const task = concurrency.find((row) => row.tool === 'Task');

    expect(explore?.calls).toBe(3);
    expect(explore?.peak).toBe(3);
    expect(task?.calls).toBe(3);
    expect(task?.peak).toBe(1);
    expect(explore!.wallMs).toBeLessThan(task!.wallMs);
  });
});

describe('子代理 benchmark：名册与底线', () => {
  it('内置三个类型，explore / plan 只读，general-purpose 继承父面', async () => {
    const { builtins } = await runSubagentBenchmarks();

    expect(builtins.map((row) => row.name)).toEqual(['explore', 'general-purpose', 'plan']);
    expect(builtins.find((row) => row.name === 'explore')?.readOnly).toBe(true);
    expect(builtins.find((row) => row.name === 'plan')?.readOnly).toBe(true);
    expect(builtins.find((row) => row.name === 'general-purpose')?.readOnly).toBe(false);
    expect(builtins.find((row) => row.name === 'general-purpose')?.tools).toBeUndefined();
  });

  it('谎报 readOnly 的 agent 被内核拒，子代理一次都没跑', async () => {
    const { guard } = await runSubagentBenchmarks();

    expect(guard.denied).toBe(true);
    expect(guard.reason).toContain('Write');
    expect(guard.reason).toContain('Task');
    expect(guard.childRequests).toBe(0);
  });

  it('三张表都有', async () => {
    const text = formatSubagentTables(await runSubagentBenchmarks());
    expect(text).toContain('隔离');
    expect(text).toContain('并发');
    expect(text).toContain('内置名册');
    expect(text).toContain('fail-closed');
  });
});
