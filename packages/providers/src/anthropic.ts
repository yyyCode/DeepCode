import type {
  ContentBlock,
  Message,
  ModelProvider,
  StreamEvent,
  ToolSpec,
  Usage,
} from '@deepcode/contract/model-provider';
import { toUsage } from '@deepcode/contract/model-provider';
import { describeHttpFailure } from './http';
import { sseFrames } from './sse';

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
    // `req.model` 是模型分层的唯一落点。别名（haiku/sonnet/opus）**原样透传**，
    // 不翻译、不映射 —— 我们不知道用户配的端点认不认它们，猜错还不如让端点自己说。
    // 出错的提示语也要用**真正发出去的那个** id，否则报的是"模型 claude-opus-5-5 不存在"，
    // 而真正发出去的是 haiku，用户照着提示去查会查错地方。
    async *stream({ system, messages, tools, signal, model }) {
      const effectiveModel = model ?? config.model;
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: config.maxTokens ?? 8192,
          system,
          messages: toAnthropicMessages(messages),
          tools: tools.map(toAnthropicTool),
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(await describeHttpFailure('anthropic', response, effectiveModel));
      }
      if (!response.body) throw new Error('anthropic: 响应没有 body');

      const pending = new Map<number, { type: string; id: string; name: string; json: string }>();
      let stopReason = 'end_turn';
      // 两份用量分两次到达：Anthropic 在 `message_start` 里给 `input_tokens`，
      // 在末尾的 `message_delta` 里给 `output_tokens`。少接一个就会报半个假账。
      let inputTokens: unknown;
      let outputTokens: unknown;

      for await (const frame of sseFrames(response.body)) {
        if (frame.event === 'message_start') {
          // 这一帧此前**完全没有被处理过** —— `usage.input_tokens` 就藏在它里面。
          const data = JSON.parse(frame.data);
          inputTokens = data?.message?.usage?.input_tokens ?? inputTokens;
        } else if (frame.event === 'content_block_start') {
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
          outputTokens = data?.usage?.output_tokens ?? outputTokens;
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
          yield doneEvent(stopReason, toUsage(inputTokens, outputTokens));
          return;
        }
      }

      // 服务端没发 message_stop 就断了：当作正常结束，不留悬挂的 await。
      yield doneEvent(stopReason, toUsage(inputTokens, outputTokens));
    },
  };
}

/** 没有用量就不带那个字段 —— 带上一个 `usage: undefined` 会让"端点报了"与"端点没报"长得一样。 */
function doneEvent(stopReason: string, usage: Usage | undefined): StreamEvent {
  return usage === undefined ? { type: 'done', stopReason } : { type: 'done', stopReason, usage };
}

/** 中立的 Message 表示 → Anthropic 协议。工具结果在 Anthropic 里是 user 消息里的 tool_result block。 */
function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: result.content,
          is_error: result.isError,
        })),
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
