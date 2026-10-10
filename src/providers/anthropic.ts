import type {
  ContentBlock,
  Message,
  ModelProvider,
  StreamEvent,
  ToolSpec,
} from '../contract/model-provider';

export type AnthropicConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
};

export function createAnthropicProvider(config: AnthropicConfig): ModelProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    name: 'anthropic',
    async *stream({ system, messages, tools, signal }) {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 8192,
          system,
          messages: toAnthropicMessages(messages),
          tools: tools.map(toAnthropicTool),
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`anthropic ${response.status}: ${await response.text()}`);
      }
      if (!response.body) throw new Error('anthropic: 响应没有 body');

      const pending = new Map<number, { type: string; id: string; name: string; json: string }>();
      let stopReason = 'end_turn';

      for await (const frame of sseFrames(response.body)) {
        if (frame.event === 'content_block_start') {
          const data = JSON.parse(frame.data);
          const block = data.content_block ?? {};
          pending.set(data.index, {
            type: block.type,
            id: block.id ?? '',
            name: block.name ?? '',
            json: '',
          });
        } else if (frame.event === 'content_block_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.type === 'text_delta') {
            yield { type: 'text', text: data.delta.text } satisfies StreamEvent;
          } else if (data.delta?.type === 'input_json_delta') {
            const entry = pending.get(data.index);
            if (entry) entry.json += data.delta.partial_json ?? '';
          }
        } else if (frame.event === 'content_block_stop') {
          const data = JSON.parse(frame.data);
          const entry = pending.get(data.index);
          if (entry?.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: entry.id,
              name: entry.name,
              input: JSON.parse(entry.json || '{}'),
            } satisfies StreamEvent;
          }
        } else if (frame.event === 'message_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        } else if (frame.event === 'error') {
          // 错误帧必须抛出去。默不作声地略过，一次 overloaded_error 就会变成一个
          // "成功的空 turn"：没有文本、没有工具调用、stopReason 还是 end_turn ——
          // 用户的问题凭空消失，连一句报错都没有，而且不会退避重试。
          // 这条路径只有真 API 会走到，脚本化 provider 测不出来。
          const data = JSON.parse(frame.data);
          const type = data?.error?.type ?? 'error';
          const detail = data?.error?.message;
          throw new Error(
            `anthropic 流中错误帧: ${type}${detail ? ` — ${detail}` : ''}`,
          );
        } else if (frame.event === 'message_stop') {
          yield { type: 'done', stopReason } satisfies StreamEvent;
          return;
        }
      }

      // 服务端没发 message_stop 就断了：当作正常结束，不留悬挂的 await。
      yield { type: 'done', stopReason };
    },
  };
}

/** 中立的 Message 表示 → Anthropic 协议。工具结果在 Anthropic 里是 user 消息里的 tool_result block。 */
function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolUseId,
            content: message.content,
            is_error: message.isError,
          },
        ],
      };
    }
    return {
      role: 'assistant',
      content: message.content.map((block: ContentBlock) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
      ),
    };
  });
}

function toAnthropicTool(tool: ToolSpec): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

/** 逐帧读 SSE。Anthropic 的流是 `event: X\ndata: {...}\n\n`。 */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = '';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (event && dataLines.length > 0) {
        yield { event, data: dataLines.join('\n') };
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
