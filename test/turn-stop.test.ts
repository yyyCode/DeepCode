import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import type { Message, ModelProvider, StreamEvent } from '../src/contract/model-provider';
import type { Args } from '../src/contract/events';
import type { LoopContext } from '../src/core/loop';
import { MAX_STOP_BLOCKS, runTurn } from '../src/core/loop';
import { createEngine } from '../src/core/create';

type Seen = Args<'turn.stop'>;

/**
 * `turn.stop` 的观测面。
 *
 * 脚本化的 provider：第 n 次拉它就说第 n 句话。于是"被拦住之后模型又转了一轮"
 * 这件事是**从 provider 被拉了几次**看出来的 —— 那是模型眼里的东西，别处看不见。
 */
function stopperPlugin(seen: Seen[], block: string | undefined, limit = Infinity): Plugin {
  return {
    name: 'test-stopper',
    uses: ['turn.stop'],
    register(on) {
      on('turn.stop', (_$, e) => {
        seen.push(e);
        if (block === undefined || seen.length > limit) return {};
        return { block };
      });
    },
  };
}

async function run(options: { block?: string; limit?: number } = {}) {
  const seen: Seen[] = [];
  const notices: string[] = [];
  let pulls = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(_req): AsyncGenerator<StreamEvent> {
      pulls += 1;
      yield { type: 'text', text: `第 ${pulls} 轮` };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [stopperPlugin(seen, options.block, options.limit ?? Infinity)],
    provider,
    ui: { print: () => {}, notice: (line) => notices.push(line), ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $,
    provider,
    signal: new AbortController().signal,
    dispatch,
    systemPrompt: 's',
    turnIndex: 0,
  };

  const stopReason = await runTurn(ctx, messages);
  return { seen, notices, pulls, messages, stopReason };
}

describe('turn.stop —— 收手那一刻', () => {
  it('没人应答就照常收手，一次都不多转（链尾是缝）', async () => {
    const { seen, pulls, stopReason, messages } = await run();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ stopHookActive: false, lastMessage: '第 1 轮' });
    expect(pulls).toBe(1);
    expect(stopReason).toBe('end_turn');
    expect(messages).toHaveLength(2); // 用户那句 + 助手那句
  });

  it('lastMessage 是模型这一轮说过的最后一段文本', async () => {
    const { seen } = await run();
    expect(seen[0]?.lastMessage).toBe('第 1 轮');
  });
});

describe('turn.stop —— 不让收手', () => {
  it('block 的文本作为一条新的 user 消息推进去，本 turn 接着转', async () => {
    const { pulls, messages } = await run({ block: '测试还没跑', limit: 1 });
    // 第一次 block 让它多转一轮，第二次就不再拦（limit: 1）—— 于是总共两轮。
    expect(pulls).toBe(2);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2]).toEqual({ role: 'user', content: '测试还没跑' });
  });

  it('stopHookActive 第一次是 false、第二次是 true', async () => {
    const { seen } = await run({ block: '继续', limit: 1 });
    expect(seen.map((s) => s.stopHookActive)).toEqual([false, true]);
  });

  it('一个永远 block 的钩子最多拦三次，然后收手并出声', async () => {
    const { seen, notices, pulls, stopReason } = await run({ block: '没完' });
    expect(pulls).toBe(1 + MAX_STOP_BLOCKS);
    // 第 1 次收手 + 每次拦住之后的收手，都会派一次 turn.stop。
    expect(seen).toHaveLength(1 + MAX_STOP_BLOCKS);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(String(MAX_STOP_BLOCKS));
    expect(stopReason).toBe('end_turn');
  });

  it('空白 block 不算拦（一个只有空行的 block 是噪声，不是指令）', async () => {
    const { pulls, notices } = await run({ block: '   \n ' });
    expect(pulls).toBe(1);
    expect(notices).toEqual([]);
  });
});
