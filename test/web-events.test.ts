import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import type { AskContext } from '../src/cli/web/ui';
import { createWebEventsPlugin, TOOL_OUTPUT_LIMIT } from '../src/cli/web/events';
import { createHarness, seat } from './harness';

function setup(now?: () => number) {
  const h = createHarness();
  const events: Record<string, unknown>[] = [];
  const contexts: AskContext[] = [];
  seat(
    h,
    createWebEventsPlugin({
      emit: (event) => events.push(event),
      onAskContext: (context) => contexts.push(context),
      ...(now === undefined ? {} : { now }),
    }),
    'builtin',
  );
  return { h, events, contexts };
}

const callArgs = (toolUseId = 't1') => ({
  tool: 'Bash',
  input: { command: 'ls' },
  toolUseId,
});

describe('createWebEventsPlugin', () => {
  it('tool.call 发 tool.start，tool.result 发 tool.end（带输出与耗时）', async () => {
    let clock = 1_000;
    const { h, events } = setup(() => clock);
    h.on('builtin', 'tool-bash', 'tool.call', { tool: 'Bash' }, async () => ({ value: 'ok' }));
    h.on('builtin', 'tool-bash', 'tool.result', async () => ({}));

    const result = await h.dispatch('tool.call', callArgs(), CORE_ORIGIN);
    expect(result).toEqual({ value: 'ok' });
    expect(events).toEqual([
      { type: 'tool.start', toolUseId: 't1', tool: 'Bash', input: { command: 'ls' } },
    ]);

    clock = 1_250;
    await h.dispatch(
      'tool.result',
      { ...callArgs(), ok: true, output: '文件一\n文件二' },
      CORE_ORIGIN,
    );
    expect(events[1]).toEqual({
      type: 'tool.end',
      toolUseId: 't1',
      status: 'ok',
      output: '文件一\n文件二',
      durationMs: 250,
    });
  });

  it('tool.call 返回 deny → tool.end {status: denied}，返回值原样', async () => {
    const { h, events } = setup();
    h.on('builtin', 'tool-bash', 'tool.call', { tool: 'Bash' }, async () => ({ deny: '越界' }));

    const result = await h.dispatch('tool.call', callArgs(), CORE_ORIGIN);

    expect(result).toEqual({ deny: '越界' });
    expect(events[1]).toMatchObject({ type: 'tool.end', toolUseId: 't1', status: 'denied' });
  });

  it('tool.call 抛错 → tool.end {status: error}，错误继续抛出去', async () => {
    const { h, events } = setup();
    h.on('builtin', 'tool-bash', 'tool.call', { tool: 'Bash' }, async () => {
      throw new Error('炸了');
    });

    // 派发器会隔离抛错的 hook 并继续往下走，所以最终看到的是链尾的
    // NotImplementedError；关键是我们的卡片仍然收场成 error（不是永远转着）。
    await expect(h.dispatch('tool.call', callArgs(), CORE_ORIGIN)).rejects.toThrow();
    expect(events[1]).toMatchObject({ type: 'tool.end', toolUseId: 't1', status: 'error' });
  });

  it('tool.result 的 output 截断到上限并标 truncated', async () => {
    const { h, events } = setup();
    const output = 'x'.repeat(TOOL_OUTPUT_LIMIT + 1);
    h.on('builtin', 'tool-bash', 'tool.result', async () => ({}));

    await h.dispatch('tool.result', { ...callArgs(), ok: true, output }, CORE_ORIGIN);

    const end = events.at(-1) as Record<string, unknown>;
    expect(end['output']).toHaveLength(TOOL_OUTPUT_LIMIT);
    expect(end['truncated']).toBe(true);
  });

  it('tool.check 拒绝 → tool.denied；ask → 记下权限卡上下文', async () => {
    const { h, events, contexts } = setup();
    h.on('builtin', 'rule', 'tool.check', async () => ({ decision: 'deny', rule: 'sec-default' }));

    const denied = await h.dispatch('tool.check', callArgs(), CORE_ORIGIN);
    expect(denied).toEqual({ decision: 'deny', rule: 'sec-default' });
    expect(events[0]).toEqual({
      type: 'tool.denied',
      toolUseId: 't1',
      tool: 'Bash',
      rule: 'sec-default',
    });

    const askHarness = setup();
    askHarness.h.on('builtin', 'rule', 'tool.check', async () => ({ decision: 'ask' }));
    await askHarness.h.dispatch('tool.check', callArgs('t2'), CORE_ORIGIN);
    expect(askHarness.contexts).toEqual([
      { tool: 'Bash', input: { command: 'ls' }, toolUseId: 't2' },
    ]);
  });

  it('turn.start / turn.complete 发 turn 与 busy', async () => {
    const { h, events } = setup();

    await h.dispatch('turn.start', { index: 3 }, CORE_ORIGIN);
    await h.dispatch(
      'turn.complete',
      { stopReason: 'answer', inputTokens: 10, outputTokens: 2 },
      CORE_ORIGIN,
    );

    expect(events).toEqual([
      { type: 'turn', phase: 'start', index: 3 },
      { type: 'busy', busy: true },
      {
        type: 'turn',
        phase: 'end',
        stopReason: 'answer',
        inputTokens: 10,
        outputTokens: 2,
      },
      { type: 'busy', busy: false },
    ]);
  });

  it('tool.consent 通知照原样透传', async () => {
    const { h, events } = setup();
    const result = await h.dispatch(
      'tool.consent',
      { ...callArgs(), granted: 'always' },
      CORE_ORIGIN,
    );
    expect(result).toEqual({});
    expect(events).toEqual([{ type: 'consent', tool: 'Bash', granted: 'always' }]);
  });
});
