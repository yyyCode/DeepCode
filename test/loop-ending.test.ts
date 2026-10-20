import { describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamEvent } from '@deepcode/contract/model-provider';
import type { Plugin } from '@deepcode/contract/plugin';
import type { LoopContext } from '@deepcode/core/loop';
import { MAX_STOP_BLOCKS, runTurn } from '@deepcode/core/loop';
import { createEngine } from '@deepcode/core/create';

/**
 * 一轮**怎么收场**（P8）。
 *
 * 这里测的全是"结束"那一侧：被截断接不接得上、空步怎么办、炸在中途的半句还在不在、
 * 端点自己的停止原因会不会漏到产品层。工具与白名单那两条线在 `loop-options.test.ts`。
 */

const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });
const say = (text: string, stopReason = 'end_turn'): readonly StreamEvent[] => [
  { type: 'text', text },
  done(stopReason),
];

type RunOptions = {
  /** 每一跳的脚本。脚本用完之后兜底是 `done('end_turn')`（不兜的话会掩盖真实路径）。 */
  script: readonly (readonly StreamEvent[])[];
  maxHops?: number;
};

async function run(options: RunOptions) {
  const requests: { messages: Message[] }[] = [];
  const notices: string[] = [];
  const texts: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(req) {
      requests.push({ messages: [...req.messages] });
      for (const event of options.script[index++] ?? [done('end_turn')]) yield event;
    },
  };

  // 一个什么都不做的工具，只为让"这一步有 tool_use"成立。
  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe', 'tool.check', 'tool.result'],
    register(on) {
      on('tool.describe', { tool: 'Read' }, () => ({ description: '工具 Read', inputSchema: {} }));
      on('tool.call', { tool: 'Read' }, () => ({ value: 'ok' }));
      on('tool.check', () => ({ decision: 'allow' }) as const);
      on('tool.result', () => ({}) as const);
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [tools],
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
    ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
    onText: (text) => texts.push(text),
  };

  const reason = await runTurn(ctx, messages);
  const assistants = messages.filter((message) => message.role === 'assistant');
  const userTexts = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);

  return { reason, messages, requests, notices, texts, assistants, userTexts };
}

const callRead: readonly StreamEvent[] = [
  { type: 'tool_use', id: 'u1', name: 'Read', input: {} },
  done('tool_use'),
];

/** 一边要工具、一边被长度上限截断：这一支**不算**续写（走工具那条老路）。 */
const callReadTruncated: readonly StreamEvent[] = [
  { type: 'tool_use', id: 'u1', name: 'Read', input: {} },
  done('max_tokens'),
];

describe('P8 §3.1 两层停止原因：端点的串到不了产品层', () => {
  it('模型自己收手 → answer（不是端点的 end_turn）', async () => {
    const { reason } = await run({ script: [say('好')] });
    expect(reason).toBe('answer');
  });

  it('端点报了一个我们没建模的停止原因 → 也是 answer，原样透传到此为止', async () => {
    const { reason } = await run({ script: [say('半句话', 'pause_turn')] });
    expect(reason).toBe('answer');
  });

  it('拒答 → refusal（它是一等结果，不是"没说清的错误串"）', async () => {
    const { reason } = await run({ script: [say('这个我不做', 'refusal')] });
    expect(reason).toBe('refusal');
  });
});

describe('P8 §3.2 截断续写：max_tokens 不是收手', () => {
  it('被截断 → 接上去，两段拼成一段话（onText 拿到的是全文）', async () => {
    const { reason, requests, notices, texts, userTexts } = await run({
      script: [say('前半段。', 'max_tokens'), say('后半段。')],
    });

    expect(reason).toBe('answer'); // 接完了，这一轮是正常收场
    expect(requests.length).toBe(2); // 真的又发了一次请求
    expect(notices.join('\n')).toContain('被输出长度上限截断');
    // 子代理那边是**覆盖式**收集器：只给它最后那半截等于把前半句丢了。
    expect(texts).toEqual(['前半段。', '前半段。后半段。']);
    // 续写那条 user 消息是真的进了对话（模型当时就看到了它），也不是给用户看的黑话。
    expect(userTexts.at(-1)).toContain('接着往下写');
  });

  it('连续截断 → 到上限就停手，收场是 truncated，且说清"上面那段是半截的"', async () => {
    const { reason, requests, notices } = await run({
      script: [say('一', 'max_tokens'), say('二', 'max_tokens'), say('三', 'max_tokens'), say('四', 'max_tokens')],
    });

    expect(requests.length).toBe(4); // 首次 + 3 次续写，第四次截断之后不再发了
    expect(reason).toBe('truncated');
    expect(notices.join('\n')).toContain('上面那段回答是半截的');
  });

  it('截断时如果这一步还要工具 → 走工具那条老路，不插续写消息', async () => {
    const { requests } = await run({ script: [callReadTruncated, say('收工')] });
    // 第二次请求里最后那条 user 消息是工具结果，不是续写要求。
    expect(requests[1]?.messages.at(-1)?.role).toBe('tool');
    expect(
      requests[1]?.messages.some((m) => m.role === 'user' && m.content.includes('接着往下写')),
    ).toBe(false);
  });

  it('续写之后去调工具 → 那半句不再接在下一句话头上', async () => {
    const { texts } = await run({
      script: [say('半句', 'max_tokens'), callRead, say('问完了')],
    });
    // 第二跳去调工具了（对话翻页），第三跳的话是**它自己**的话，不被前面那半句污染。
    expect(texts).toEqual(['半句', '问完了']);
  });
});

describe('P8 §3.3 空步：重提示一次，且不往对话里塞空消息', () => {
  it('一步什么都没产出 → 不塞空 assistant 消息，重提示一次，然后拿到回答', async () => {
    const { reason, requests, assistants, notices } = await run({
      script: [[done('end_turn')], say('这才是我要说的')],
    });

    // 改之前这里躺着一条 `{ role:'assistant', content: [] }` —— 它还会随下一次请求发出去。
    expect(assistants.every((m) => m.role === 'assistant' && m.content.length > 0)).toBe(true);
    expect(requests.length).toBe(2);
    expect(notices.join('\n')).toContain('重提示一次');
    expect(reason).toBe('answer');
  });

  it('重提示之后还是空的 → 收场是 empty，并且说出"两次都没产出"', async () => {
    const { reason, requests, notices, assistants } = await run({
      script: [[done('end_turn')], [done('end_turn')]],
    });

    expect(requests.length).toBe(2); // 只重提示**一次**，不无限重试
    expect(reason).toBe('empty');
    expect(notices.join('\n')).toContain('两次都没有产出任何内容');
    expect(assistants.length).toBe(0);
  });

  it('空且截断 → 按**续写**处置（截断更接近真相），不走重提示那条', async () => {
    const { reason, requests, notices, texts } = await run({
      script: [[done('max_tokens')], say('写完了')],
    });
    expect(requests.length).toBe(2); // 接了一次
    expect(notices.join('\n')).toContain('被输出长度上限截断');
    expect(notices.join('\n')).not.toContain('什么都没产出');
    // 第一步没文本，两段拼起来就是第二步那段 —— 不凭空造一个空串进去。
    expect(texts).toEqual(['写完了']);
    expect(reason).toBe('answer');
  });
});

describe('P8 §3.4 炸在中途：已经吐出来的那半句必须留下', () => {
  it('流中途抛错 → 屏幕上显示过的那半句在对话里（转录不许撒谎）', async () => {
    const provider: ModelProvider = {
      name: 'boom',
      async *stream() {
        yield { type: 'text', text: '我看到了『前半段' };
        throw new Error('socket 断了');
      },
    };
    const { $, dispatch } = await createEngine({
      plugins: [],
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const texts: string[] = [];
    const reason = await runTurn(
      {
        $,
        provider,
        signal: new AbortController().signal,
        dispatch,
        systemPrompt: 's',
        turnIndex: 0,
        onText: (text) => texts.push(text),
      },
      messages,
    );

    expect(reason).toBe('error');
    expect(messages).toEqual([
      { role: 'user', content: '干活' },
      { role: 'assistant', content: [{ type: 'text', text: '我看到了『前半段' }] },
    ]);
    // 子代理那一侧也拿得到这半句（它回给父级的是 ERROR + 正文）。
    expect(texts).toEqual(['我看到了『前半段']);
  });

  it('一个字都没吐就炸了 → 对话里不留下任何东西（不塞空消息）', async () => {
    let round = 0;
    const provider: ModelProvider = {
      name: 'boom',
      async *stream() {
        round += 1;
        throw new Error('连不上了');
      },
    };
    const { $, dispatch } = await createEngine({
      plugins: [],
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const reason = await runTurn(
      { $, provider, signal: new AbortController().signal, dispatch, systemPrompt: 's', turnIndex: 0 },
      messages,
    );

    expect(round).toBe(2); // 一个字都没出去 ⇒ 退避重试了一次（既有行为，P8 不动它）
    expect(reason).toBe('error');
    expect(messages).toEqual([{ role: 'user', content: '干活' }]);
  });

  it('工具已经拿到手但流炸了 → 半句留下，tool_use 一个都不留（否则下次请求非法）', async () => {
    const provider: ModelProvider = {
      name: 'boom',
      async *stream() {
        yield { type: 'text', text: '让我读一下' };
        yield { type: 'tool_use', id: 'u9', name: 'Read', input: {} };
        throw new Error('断了');
      },
    };
    const { $, dispatch } = await createEngine({
      plugins: [],
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const reason = await runTurn(
      { $, provider, signal: new AbortController().signal, dispatch, systemPrompt: 's', turnIndex: 0 },
      messages,
    );

    expect(reason).toBe('error');
    // 那个 tool_use **没跑过**：留一个没有配对 tool_result 的 tool_use block 会让
    // 下一次请求的 messages 非法，所以只留正文。
    expect(messages).toEqual([
      { role: 'user', content: '干活' },
      { role: 'assistant', content: [{ type: 'text', text: '让我读一下' }] },
    ]);
  });
});

describe('P8 收场理由与既有闸的关系', () => {
  it('跑满 hop 压过一切：下一跳本来要收手也一样是 max_hops', async () => {
    // hop 上限 1：第一跳要工具、工具跑完循环就到期了，模型根本没机会说那句话。
    const { reason } = await run({ script: [callRead, say('好')], maxHops: 1 });
    expect(reason).toBe('max_hops');
  });

  it('撞上 hop 上限时不会顺手把用户那句话当成"没做完的续写"', async () => {
    const { notices } = await run({ script: [callRead, callRead], maxHops: 2 });
    expect(notices.join('\n')).not.toContain('截断');
  });

  it('`turn.stop` 那道闸还在（P8 没动它）', async () => {
    const { reason } = await run({ script: [say('好')] });
    expect(reason).toBe('answer');
    // 这个常量是既有的：改 P8 时不许顺手把它挪走。
    expect(MAX_STOP_BLOCKS).toBe(3);
  });
});
