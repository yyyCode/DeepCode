import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import type { Message, ModelProvider, StreamEvent } from '../src/contract/model-provider';
import { createEngine } from '../src/core/create';
import { startRepl } from '../src/cli/repl';
import { createLineQueue } from '../src/cli/input';
import { createTurnSignals } from '../src/cli/turns';
import type { Renderer } from '../src/cli/render';
import { CONTEXT_MARKER } from '../src/contract/prompt-channel';
import { fakeReadline } from './harness';

/** 什么都不显示的渲染器。REPL 会调它，但这条测试断言的是消息数组，不是屏幕。 */
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

function submitPlugin(verdict: { handled?: boolean; context?: string }): Plugin {
  return {
    name: 'test-submit',
    uses: ['prompt.submit'],
    register(on) {
      on('prompt.submit', (_$, event) => ({ ...verdict, text: event.text }));
    },
  };
}

async function run(
  lines: readonly string[],
  verdict: { handled?: boolean; context?: string } = {},
): Promise<Message[]> {
  const provider: ModelProvider = {
    name: 'scripted',
    // 一次到底的应答：这条测试不关心模型说什么，只关心用户那条消息长什么样。
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', text: '收到' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [submitPlugin(verdict)],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const fake = fakeReadline();
  // 队列与真实路径同序：**先建队列，再让输入到达**（`main.ts` 就是 rl 一建好就挂上它）。
  // 反过来的话那几行会被发给没人听的 `line` 事件 —— 那正是 P6d 修掉的那个洞。
  const lines2 = createLineQueue(fake.rl, { windowMs: 0 });
  for (const line of lines) fake.pushLine(line);
  fake.pushEof();

  const messages: Message[] = [];
  await startRepl({
    $,
    dispatch,
    render: silentRenderer(),
    rl: fake.rl,
    lines: lines2,
    systemPrompt: '',
    turns: createTurnSignals(),
    messages,
    persist: async () => {},
  });
  return messages;
}

describe('prompt.submit 的 context', () => {
  it('没有钩子给上下文时，消息就是原文 —— 一个字节都不多', async () => {
    const messages = await run(['你好']);
    expect(messages[0]).toEqual({ role: 'user', content: '你好' });
  });

  it('钩子给的 context 与原文同处一条消息，原文在前、补充在后并被标记隔开', async () => {
    const messages = await run(['你好'], { context: '今天是 10 月 11 日' });
    const first = messages[0];
    expect(first?.role).toBe('user');
    const content = first?.role === 'user' ? first.content : '';
    expect(content).toBe(`你好\n\n${CONTEXT_MARKER}\n今天是 10 月 11 日`);
    // 单独再钉一遍"没有第二条 user 消息"：两条连续的 user 是某些端点会拒的形状，
    // 而"拼进同一条"正是为它选的写法。
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('handled 仍然算数：那一行不进模型，连用户消息都不落', async () => {
    const messages = await run(['你好'], { handled: true, context: '不该出现' });
    expect(messages).toEqual([]);
  });
});
