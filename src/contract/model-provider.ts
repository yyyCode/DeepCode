/** 发给模型的一条消息。工具结果在 Anthropic 协议里也是 user 消息，这里保持中立表示。 */
export type Message =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: readonly ContentBlock[] }
  | {
      readonly role: 'tool';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

/** provider 的流式输出。文本增量即时产出；工具调用在参数收齐后一次性产出。 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'done'; readonly stopReason: string };

export type StreamRequest = {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal: AbortSignal;
};

/**
 * MVP 只有 Anthropic 一个实现，但接口先立着：
 * 之后加 OpenAI 兼容适配器时，事件链与 agent loop 一行都不用改。
 */
export type ModelProvider = {
  readonly name: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
};
