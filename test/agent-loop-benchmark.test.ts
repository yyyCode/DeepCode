import { describe, expect, it } from 'vitest';
import {
  formatAgentLoopTables,
  runAgentLoopBenchmarks,
} from '../scripts/benchmark-agent-loop';
import { planModePrompt } from '../src/builtins/plan';

/**
 * P14 benchmark 的口径测试。
 *
 * 这些数字不是"性能"，是结构：Tool-Use Loop 不插入额外模型请求；计划模式把
 * 写工具从模型面上拿掉，省下的工具 schema 大于注入的计划提示。
 */

describe('Tool-Use Loop 没有额外往返', () => {
  it('需要 N 次工具就是 N+1 次模型请求，框架额外请求为 0', async () => {
    const result = await runAgentLoopBenchmarks();
    expect(result.roundTrips.map((row) => row.toolCalls)).toEqual([0, 1, 3, 5, 10]);
    for (const row of result.roundTrips) {
      expect(row.requests).toBe(row.toolCalls + 1);
      expect(row.executed).toBe(row.toolCalls);
      expect(row.extraRequests).toBe(0);
    }
  });
});

describe('计划模式的工具面', () => {
  it('普通模式看得见写工具，计划模式只留只读与出口', async () => {
    const result = await runAgentLoopBenchmarks();
    const { plan } = result;

    for (const name of ['Write', 'Edit', 'Bash', 'EnterPlanMode']) {
      expect(plan.baselineTools).toContain(name);
      expect(plan.planTools).not.toContain(name);
      expect(plan.blockedTools).toContain(name);
    }
    for (const name of ['Read', 'Glob', 'Grep', 'ExitPlanMode']) {
      expect(plan.planTools).toContain(name);
    }
    expect(plan.planToolTokens).toBeLessThan(plan.baselineToolTokens);
  });

  it('计划提示比省掉的工具 schema 小：净账为负（更省）', async () => {
    const result = await runAgentLoopBenchmarks();
    const { plan } = result;

    expect(plan.planPromptTokens).toBeGreaterThan(0);
    for (const row of plan.turns) {
      expect(row.savedToolTokens).toBeGreaterThan(row.promptTokens);
      expect(row.deltaTokens).toBeLessThan(0);
    }
  });

  it('每 5 轮多一张提醒，其余轮次没有', () => {
    const four = planModePrompt({ path: '/p', turns: 4 });
    const five = planModePrompt({ path: '/p', turns: 5 });
    expect(four).not.toContain('提醒：');
    expect(five).toContain('提醒：');
  });

  it('表格里有三张表与口径', async () => {
    const text = formatAgentLoopTables(await runAgentLoopBenchmarks());
    expect(text).toContain('Tool-Use Loop');
    expect(text).toContain('计划模式的工具面');
    expect(text).toContain('计划模式的净账');
    expect(text).toContain('净变化（负 = 更省）');
  });
});
