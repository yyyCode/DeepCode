import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIProvider } from '../src/providers/openai';
import type { Message, StreamEvent, ToolSpec } from '../src/contract/model-provider';

/**
 * 盯的是 OpenAI 兼容端的 SSE 解析与消息转换。与 provider.test.ts 同一教训：
 * 这些路径只有真 API 才走得到，所以假 fetch 一律返回**真 `Response`**，
 * 让 `sseFrames` 走真实解析而不是被 mock 掉。
 */

const encoder = new TextEncoder();

/** 一段 SSE 文本包成真 Response。chunks 是网络分块，与帧边界无关。 */
function sseResponse(chunks: readonly string[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    init ?? { status: 200 },
  );
}

/** 一帧只有 `data:` 行 —— OpenAI 没有 `event:` 行。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function stub(chunks: readonly string[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)));
}

async function collect(
  messages: readonly Message[] = [],
  tools: readonly ToolSpec[] = [],
): Promise<StreamEvent[]> {
  const provider = createOpenAIProvider({ apiKey: 'k', model: 'm' });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    system: 'SYS',
    messages,
    tools,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI 兼容 SSE 解析', () => {
  it('delta.content 增量按顺序产出 text', async () => {
    stub([
      frame({ choices: [{ delta: { content: '你' } }] }),
      frame({ choices: [{ delta: { content: '好' } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('tool_calls 分片到达：id 与 name 只在第一片，arguments 拆成四片也能拼齐', async () => {
    // 真实情况里 arguments 是逐字吐出来的：这里拆成 4 片，
    // 拼起来才是 `{"file_path":"a.ts"}`。
    stub([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } },
              ],
            },
          },
        ],
      }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('两个工具交错到达（index 0 与 1）→ 两个 tool_use，按 index 排序', async () => {
    stub([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{"file' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'Grep', arguments: '{"pat' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"x"}' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'tern":"y"}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    expect(await collect()).toEqual([
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } },
      { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'y' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('data: [DONE] 之后不再产出文本', async () => {
    stub([
      frame({ choices: [{ delta: { content: 'before' } }] }),
      'data: [DONE]\n\n',
      frame({ choices: [{ delta: { content: 'after' } }] }),
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: 'before' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('没有 [DONE]，流直接结束也必须产出 done（不悬挂）', async () => {
    // 有的兼容端点压根不发 [DONE]。循环自然结束时若没有兜底，消费方会一直等下去。
    stub([frame({ choices: [{ delta: { content: 'x' } }] })]);

    expect(await collect()).toEqual([
      { type: 'text', text: 'x' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('错误帧必须抛，不能变成静默的空 turn', async () => {
    stub([frame({ error: { type: 'overloaded_error', message: 'busy' } })]);

    await expect(collect()).rejects.toThrow(/overloaded_error/);
  });

  it('HTTP 非 2xx：404 且响应体暗示模型不存在 → 抛出模型 id 提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"code":"model_not_found"}}', { status: 404 })),
    );

    await expect(collect()).rejects.toThrow(/404[\s\S]*模型 id "m"/);
  });

  it('坏 JSON 的 arguments 退化成 {}，不抛', async () => {
    stub([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'Read', arguments: '{oops' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    expect(await collect()).toEqual([
      { type: 'tool_use', id: 'x', name: 'Read', input: {} },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('请求体形状：system 在首位；一条带两个结果的 tool 消息摊成两条 role:tool；只有工具调用的 assistant 发 content:null', async () => {
    let body: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = init.body as string;
        return sseResponse(['data: [DONE]\n\n']);
      }),
    );

    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'u2', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
      {
        role: 'tool',
        results: [
          { toolUseId: 'u1', content: 'AAA', isError: false },
          { toolUseId: 'u2', content: 'BBB', isError: true },
        ],
      },
    ];
    const tools: ToolSpec[] = [
      { name: 'Read', description: 'd', inputSchema: { type: 'object' } },
    ];

    await collect(messages, tools);

    const sent = JSON.parse(body!) as { messages: unknown; tools: unknown };
    // 中立层里是一条 tool 消息（与 Anthropic 要的一条 user 多 block 相反），
    // 到 OpenAI 这边必须摊成两条 —— 它的协议是 tool_call_id 一条一个。
    expect(sent.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null, // 只有工具调用，没有文本 → null，不是 ""
        tool_calls: [
          { id: 'u1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
          { id: 'u2', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'u1', content: 'AAA' },
      { role: 'tool', tool_call_id: 'u2', content: 'BBB' },
    ]);
    expect(sent.tools).toEqual([
      { type: 'function', function: { name: 'Read', description: 'd', parameters: { type: 'object' } } },
    ]);
  });
});
