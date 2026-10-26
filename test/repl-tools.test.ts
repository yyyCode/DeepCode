import { describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamEvent, ToolSpec } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { createEngine } from '../src/core/create';
import { startRepl } from '../src/cli/repl';
import { createLineQueue } from '../src/cli/input';
import { createTurnSignals } from '../src/cli/turns';
import { contextReport } from '../src/cli/context-view';
import type { Renderer } from '../src/cli/render';
import { fakeReadline } from './harness';

/**
 * `onTools` 从 REPL 接到 `runTurn` 上（P9 §3.2）。
 *
 * ⚠️ 与 `/context` 那条端到端用例同一条理由：`onTools` 是**可选** deps，
 * 少传一个 TypeScript 一声不吭 —— 而账本从此又漏掉工具那一份，且一声不响。
 * 所以这里真的跑一遍 `startRepl`（不是调 `runTurn` 就完事）。
 */

const CONFIG = { auto: false, atTokens: 100_000, keepTurns: 6 };

/** 一个工具。描述长度刻意是 4 的倍数，好让账本那几行对得上（同 context-view 的用例）。 */
const ONE_TOOL: Plugin = {
  name: 'tool-probe',
  uses: ['tool.describe', 'tool.call'],
  register(on) {
    on('tool.describe', { tool: 'Probe' }, () => ({ description: '甲乙丙丁', inputSchema: {} }));
    on('tool.call', { tool: 'Probe' }, () => ({ value: 'ok' }));
  },
};

function silentRenderer(): Renderer {
  return {
    print: () => {},
    notice: () => {},
    ask: async () => 'y',
    delta: () => {},
    newline: () => {},
    thinking: () => {},
    activity: () => {},
    settle: () => {},
  };
}

async function run(): Promise<{ messages: Message[]; reported: (readonly ToolSpec[])[] }> {
  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', text: '收到' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { $, dispatch } = await createEngine({
    plugins: [ONE_TOOL],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const fake = fakeReadline();
  const lines = createLineQueue(fake.rl, { windowMs: 0 });
  fake.pushLine('干活');
  fake.pushEof();

  const reported: (readonly ToolSpec[])[] = [];
  const messages: Message[] = [];
  await startRepl({
    $,
    dispatch,
    render: silentRenderer(),
    rl: fake.rl,
    lines,
    systemPrompt: async () => ({ text: '系统提示' }),
    turns: createTurnSignals(),
    messages,
    persist: async () => {},
    onTools: (specs) => reported.push(specs),
  });
  return { messages, reported };
}

describe('P9：REPL 把工具清单交给账本', () => {
  it('跑完一轮，onTools 里就是这一个工具（名字与描述都在）', async () => {
    const { reported } = await run();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.map((spec) => spec.name)).toEqual(['Probe']);
    expect(reported[0]?.[0]?.description).toBe('甲乙丙丁');
  });

  it('拿它算出来的账本那一行不是"还没发过请求" —— 这正是本阶段要修的那个洞', async () => {
    const { messages, reported } = await run();
    const base = { pieces: [{ name: 'base', text: '系统提示' }], messages, compact: CONFIG };
    const withTools = contextReport({ ...base, tools: reported[0] });
    const without = contextReport({ ...base, tools: undefined });

    const toolsLine = withTools.find((one) => one.trimStart().startsWith('工具清单'));
    expect(toolsLine).toContain('1 个');
    expect(toolsLine).not.toContain('还没发过请求');

    // 合计真的含工具：自己算一遍同一个式子（系统提示 4 + 消息 4 + 工具 11 字符）。
    const spec = reported[0]![0]!;
    const chars = 4 + 4 + spec.name.length + spec.description.length + JSON.stringify(spec.inputSchema).length;
    const total = (lines: readonly string[]): string =>
      lines.find((one) => one.trimStart().startsWith('合计')) ?? '';
    expect(total(withTools)).toContain(`${Math.ceil(chars / 4)} token`);
    // 抽掉工具就变小 —— 反过来说明上一条不是拿一个常数对上的。
    expect(total(without)).toContain(`${Math.ceil(8 / 4)} token`);
    expect(total(withTools)).not.toEqual(total(without));
  });
});
