import { describe, expect, it } from 'vitest';
import { createWebUi } from '../src/cli/web/ui';

const CHOICES = [
  { value: 'y', label: '允许一次' },
  { value: 'a', label: '总是允许' },
  { value: 'n', label: '拒绝' },
];

function setup(askTimeoutMs?: number) {
  const events: Record<string, unknown>[] = [];
  const ui = createWebUi({
    emit: (event) => events.push(event),
    ...(askTimeoutMs === undefined ? {} : { askTimeoutMs }),
  });
  return { events, ui };
}

describe('createWebUi', () => {
  it('ask 发一条事件并挂起，answer 落值并再发 ask.resolved', async () => {
    const { events, ui } = setup();
    const answer = ui.ask('执行 Bash?', { choices: CHOICES, fallback: 'n' });

    expect(events).toEqual([
      { type: 'ask', id: 'a1', question: '执行 Bash?', choices: CHOICES, fallback: 'n' },
    ]);

    expect(ui.answer('a1', 'y')).toBe(true);
    await expect(answer).resolves.toBe('y');
    expect(events[1]).toEqual({ type: 'ask.resolved', id: 'a1', value: 'y', reason: 'answer' });
  });

  it('没人回答时到点回 fallback', async () => {
    const { events, ui } = setup(10);
    const answer = ui.ask('执行 Bash?', { choices: CHOICES, fallback: 'n' });

    await expect(answer).resolves.toBe('n');
    expect(events[1]).toEqual({
      type: 'ask.resolved',
      id: 'a1',
      value: 'n',
      reason: 'timeout',
    });
  });

  it('close() 把挂起的 ask 全部按 fallback 收场', async () => {
    const { events, ui } = setup();
    const first = ui.ask('一?', { choices: CHOICES, fallback: 'n' });
    const second = ui.ask('二?', { choices: CHOICES, fallback: 'a' });

    ui.close();

    await expect(first).resolves.toBe('n');
    await expect(second).resolves.toBe('a');
    expect(events.filter((event) => event['type'] === 'ask.resolved')).toEqual([
      { type: 'ask.resolved', id: 'a1', value: 'n', reason: 'closed' },
      { type: 'ask.resolved', id: 'a2', value: 'a', reason: 'closed' },
    ]);
  });

  it('abortAll 用各自的 fallback 收场，reason 是 abort', async () => {
    const { events, ui } = setup();
    const answer = ui.ask('执行 Bash?', { choices: CHOICES, fallback: 'n' });

    ui.abortAll('abort');

    await expect(answer).resolves.toBe('n');
    expect(events[1]).toEqual({ type: 'ask.resolved', id: 'a1', value: 'n', reason: 'abort' });
  });

  it('print/notice/delta 分别映射成 log info / log warn / delta', () => {
    const { events, ui } = setup();
    ui.print('普通');
    ui.notice('警告');
    ui.delta('流式');
    expect(events).toEqual([
      { type: 'log', level: 'info', text: '普通' },
      { type: 'log', level: 'warn', text: '警告' },
      { type: 'delta', text: '流式' },
    ]);
  });

  it('未知 id 的 answer 返回 false，不误伤别的 ask', async () => {
    const { events, ui } = setup();
    const first = ui.ask('一?', { choices: CHOICES, fallback: 'n' });
    const second = ui.ask('二?', { choices: CHOICES, fallback: 'n' });

    expect(ui.answer('a99', 'y')).toBe(false);
    // 值不在 choices 里也不落，问题继续挂着。
    expect(ui.answer('a1', 'bogus')).toBe(false);
    expect(events.filter((event) => event['type'] === 'ask.resolved')).toEqual([]);

    expect(ui.answer('a2', 'a')).toBe(true);
    await expect(second).resolves.toBe('a');

    ui.abortAll('abort');
    await expect(first).resolves.toBe('n');
  });

  it('setAskContext 的上下文只被下一次 ask 消费一次', () => {
    const { events, ui } = setup();
    ui.setAskContext({ tool: 'Bash', input: { command: 'ls' }, toolUseId: 't1' });

    void ui.ask('执行 Bash?', { choices: CHOICES, fallback: 'n' });
    void ui.ask('再说一次?', { choices: CHOICES, fallback: 'n' });

    expect(events[0]).toEqual({
      type: 'ask',
      id: 'a1',
      question: '执行 Bash?',
      choices: CHOICES,
      fallback: 'n',
      tool: 'Bash',
      input: { command: 'ls' },
      toolUseId: 't1',
    });
    expect(events[1]).not.toHaveProperty('tool');

    ui.close();
  });
});
