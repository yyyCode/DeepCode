import type {
  ContentBlock,
  Message,
  ModelProvider,
  StreamEvent,
  ToolSpec,
} from '../contract/model-provider';
import { describeHttpFailure } from './http';
import { sseFrames } from './sse';

export type OpenAIConfig = {
  apiKey: string;
  model: string;
  /** 要自带版本段（`https://api.deepseek.com/v1`）：不做"猜着补 /v1"的魔法，猜错就是 404。 */
  baseUrl?: string;
  maxTokens?: number;
};

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** OpenAI 的 finish_reason → 中立 stopReason。没列的照原样透传。 */
const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
};

export function createOpenAIProvider(config: OpenAIConfig): ModelProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    name: 'openai',
    async *stream({ system, messages, tools, signal, model }) {
      const effectiveModel = model ?? config.model;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: config.maxTokens ?? 8192,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(await describeHttpFailure('openai', response, effectiveModel));
      }
      if (!response.body) throw new Error('openai: 响应没有 body');

      // tool_calls 是**分片**来的：index 相同的就是同一个调用，arguments 要一段段接起来。
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = 'end_turn';

      for await (const frame of sseFrames(response.body)) {
        const data = frame.data.trim();
        // OpenAI 用这一行收尾。但不能只靠它 —— 有的兼容端点根本不发，循环自然结束也要收场。
        if (data === '[DONE]') break;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 切帧切坏了的残片：跳过，不值得把整个 turn 打死
        }

        // 错误帧必须抛。默不作声地略过，一次 overloaded 就会变成一个"成功的空 turn"：
        // 没有文本、没有工具调用、stopReason 还是 end_turn，用户的话凭空消失。
        // 与 anthropic.ts 里那段注释是同一条教训。
        if (parsed?.error) {
          const type = parsed.error.type ?? parsed.error.code ?? 'error';
          const detail = parsed.error.message;
          throw new Error(`openai 流中错误帧: ${type}${detail ? ` — ${detail}` : ''}`);
        }

        const choice = parsed?.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { type: 'text', text: delta.content } satisfies StreamEvent;
        }

        for (const call of delta.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const entry = pending.get(index) ?? { id: '', name: '', args: '' };
          if (typeof call.id === 'string') entry.id = call.id;
          if (typeof call.function?.name === 'string') entry.name = call.function.name;
          if (typeof call.function?.arguments === 'string') entry.args += call.function.arguments;
          pending.set(index, entry);
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
          stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
        }
      }

      // 工具调用统一在流末尾产出（与 anthropic 侧在 content_block_stop 产出的时机对齐），
      // 按 index 排序：它是模型给的调用顺序。
      for (const [index, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          type: 'tool_use',
          // 极少数端点不给 id。给一个稳定的替身，总好过让 loop 拿 undefined 去配对结果。
          id: entry.id === '' ? `call_${index}` : entry.id,
          name: entry.name,
          input: parseArguments(entry.args),
        } satisfies StreamEvent;
      }

      yield { type: 'done', stopReason } satisfies StreamEvent;
    },
  };
}

/**
 * arguments 是分片拼出来的 JSON 字符串。解析失败退化成 `{}` ——
 * 工具会因为缺少参数报错，那条 ERROR 会回到模型手里，比整个 turn 崩掉有用。
 */
function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 中立表示 → OpenAI 协议。注意 tool 结果在这边是**一条一个**，不是合并的。
 *
 * `ToolResult.isError` 在 OpenAI 协议里**没有对应字段**，所以这里不参与编码 ——
 * 工具失败本来就是靠 `content` 里的 `ERROR:` 前缀传回给模型的（见 `loop.ts`）。
 * 这是有意的，不是漏了。
 */
function toOpenAIMessages(system: string, messages: readonly Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'tool') {
      // OpenAI 的协议是 tool_call_id 一条一个，所以中立层合并的一组在这里摊开。
      for (const result of message.results) {
        out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.content });
      }
      continue;
    }

    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));

    out.push({
      role: 'assistant',
      // 只有工具调用、没有文本时必须发 null：部分端点把空字符串当成"空回复"直接报错。
      content: text === '' ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

function toOpenAITool(tool: ToolSpec): unknown {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}
