import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest } from '../src/contract/model-provider';
import { createAnthropicProvider } from '../src/providers/anthropic';
import { createOpenAIProvider } from '../src/providers/openai';

const REQUEST: StreamRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
};

/** 假 fetch：记下发出去的请求体，回一段立刻收尾的 SSE。不碰真网络。 */
function stubFetch(frames: string): { sent(): Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(frames, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return { sent: () => body };
}

const ANTHROPIC_FRAMES = 'event: message_stop\ndata: {}\n\n';
const OPENAI_FRAMES = 'data: [DONE]\n\n';

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // 排空而已：这一组测的是发出去的请求，不是收回来的响应。
  }
}

describe('系统提示分级缓存（P13）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('anthropic：静态段带 cache_control，动态段原样跟在后面', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(
      provider.stream({
        ...REQUEST,
        system: '静态段\n\n动态段',
        systemParts: { static: '静态段', dynamic: '动态段' },
      }),
    );

    expect(fake.sent().system).toEqual([
      { type: 'text', text: '静态段', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '动态段' },
    ]);
  });

  it('anthropic：没有 systemParts 时仍然发一个字符串（旧行为逐字节不变）', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(provider.stream({ ...REQUEST, system: '整段提示' }));

    expect(fake.sent().system).toBe('整段提示');
  });

  it('anthropic：动态段为空时只发带缓存断点的静态块', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(
      provider.stream({
        ...REQUEST,
        system: '静态段',
        systemParts: { static: '静态段', dynamic: '' },
      }),
    );

    expect(fake.sent().system).toEqual([
      { type: 'text', text: '静态段', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('openai：仍然是一条 system 消息，静态前缀排在最前', async () => {
    const fake = stubFetch(OPENAI_FRAMES);
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt-4o' });
    await drain(
      provider.stream({
        ...REQUEST,
        system: '静态段\n\n动态段',
        systemParts: { static: '静态段', dynamic: '动态段' },
      }),
    );

    expect(fake.sent().messages).toEqual([
      { role: 'system', content: '静态段\n\n动态段' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('模型分层：StreamRequest.model 覆盖适配器配置里的 model', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('anthropic：给了 model 就发它', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(provider.stream({ ...REQUEST, model: 'haiku' }));
    expect(fake.sent().model).toBe('haiku');
  });

  it('anthropic：没给就用配置里那个 —— 会话主循环走的是这一支', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(provider.stream({ ...REQUEST }));
    expect(fake.sent().model).toBe('claude-opus-5-5');
  });

  it('openai：给了 model 就发它', async () => {
    const fake = stubFetch(OPENAI_FRAMES);
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt-4o' });
    await drain(provider.stream({ ...REQUEST, model: 'haiku' }));
    expect(fake.sent().model).toBe('haiku');
  });

  it('openai：没给就用配置里那个', async () => {
    const fake = stubFetch(OPENAI_FRAMES);
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt-4o' });
    await drain(provider.stream({ ...REQUEST }));
    expect(fake.sent().model).toBe('gpt-4o');
  });
});
