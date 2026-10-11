import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic';
import type { Message, StreamEvent } from '../src/contract/model-provider';

/**
 * 这些测试盯的是 SSE 解析 —— 之前**一个测试都没有**，于是整段代码只有真 API 才会走到。
 * 上一轮独立评审正是在这里找到：错误帧被静默略过，一次 overloaded_error 会变成一个
 * "成功的空 turn"（没文本、没工具、stopReason 还是 end_turn），用户的问题凭空消失。
 */

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function stub(chunks: readonly string[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)));
}

async function collect(messages: readonly Message[] = []): Promise<StreamEvent[]> {
  const provider = createAnthropicProvider({ apiKey: 'k', model: 'm' });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    system: 's',
    messages,
    tools: [],
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Anthropic SSE 解析', () => {
  it('文本增量与 stop_reason 正常透出', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: '你好' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('事件被切在半个字段上也能拼回来', async () => {
    // 真实网络里 chunk 边界与 SSE 帧边界无关：这一帧从 "event: content_block_del"
    // 处被切断，下一块才是 "ta"。按块解析的话两帧都会丢。
    stub([
      'event: content_block_del',
      'ta\ndata: {"index":0,"delta":{"type":"text_delta","text":"a"}}\n\nevent: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: 'a' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('没有事件名的帧在 Anthropic 侧被丢掉（sse.ts 共用后的行为不变）', async () => {
    // sseFrames 搬到 sse.ts 后，只带 data、不带 event 的帧也会被产出（OpenAI 要用）。
    // Anthropic 侧只认有名字的帧，所以这些帧必须像以前一样被丢弃，
    // 而不是被当成某个分支去解析。这是一条回归护栏。
    stub([
      'data: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"ignored"}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('tool_use 的 partial_json 逐片累积成一个完整 input', async () => {
    stub([
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"path\\":\\"a.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('错误帧必须抛出去，不能变成一个静默的空 turn', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);

    // 不抛的话这里会正常结束：没有文本、没有工具、stopReason 还是 end_turn，
    // loop 于是把它当成一次成功的回合 —— 用户的提问无声无息地消失，
    // 而且不会走退避重试。必须抛，才能落进 loop 的 provider 失败分支。
    await expect(collect()).rejects.toThrow(/overloaded_error/);
  });

  it('HTTP 非 2xx 抛出状态码与响应体', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"no key"}}', { status: 401 })),
    );

    await expect(collect()).rejects.toThrow(/401.*no key/s);
  });

  it('一条带两个结果的 tool 消息 → 一条 user 消息里两个 tool_result block', async () => {
    // toAnthropicMessages 不是 export 的，所以走 provider 整条路径，把请求体截下来看。
    let body: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = init.body as string;
        return sseResponse(['event: message_stop\ndata: {}\n\n']);
      }),
    );

    await collect([
      {
        role: 'tool',
        results: [
          { toolUseId: 'u1', content: 'AAA', isError: false },
          { toolUseId: 'u2', content: 'BBB', isError: false },
        ],
      },
    ]);

    const sent = JSON.parse(body!) as { messages: unknown };
    // 中立层里是一条 tool 消息；Anthropic 需要的是**一条 user 消息里的两个 block**，
    // 拆成两条 user 消息的话第二个 tool_result 会找不到对应的 tool_use。
    expect(sent.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'u1', content: 'AAA', is_error: false },
          { type: 'tool_result', tool_use_id: 'u2', content: 'BBB', is_error: false },
        ],
      },
    ]);
  });
});

describe('usage', () => {
  it('message_start 的 input_tokens 与 message_delta 的 output_tokens 归一成 usage', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":123,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":45}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: '好' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
  });

  it('端点没报 usage：`done` 上就没有 usage 这个字段（不塞 0）', async () => {
    stub([
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    expect(await collect()).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('只报了一半：整份不带 —— 报半个账比不报更坏', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":123}}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    expect(await collect()).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });
});
