import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic';
import type { StreamEvent } from '../src/contract/model-provider';

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

async function collect(): Promise<StreamEvent[]> {
  const provider = createAnthropicProvider({ apiKey: 'k', model: 'm' });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    system: 's',
    messages: [],
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
});
