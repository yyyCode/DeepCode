export type ToolResult = {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
};

/** 发给模型的一条消息。工具结果在 Anthropic 协议里也是 user 消息，这里保持中立表示。 */
export type Message =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: readonly ContentBlock[] }
  | {
      readonly role: 'tool';
      /**
       * 一轮里模型可以同时要多个工具，结果**合并成一条消息**。
       *
       * 合并只发生在这个中立层：Anthropic 要"一条 user 消息里 N 个 tool_result block"，
       * OpenAI 要"N 条 role:'tool' 消息"。中立层一旦选边，另一边就必然错 ——
       * 所以由各自的 provider 在转换时决定怎么摊开。
       * 这不是为了省 token：OpenAI 那边最终发出去的仍然是 N 条消息。
       */
      readonly results: readonly ToolResult[];
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
 * 早先只有 Anthropic 一个实现，但接口先立着：加上 OpenAI 兼容适配器时，
 * 事件链与 agent loop 一行都没改。再添一家亦然。
 */
export type ModelProvider = {
  readonly name: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
};

/** 后端协议族。加第三家时这里加一项，`providers/index.ts` 加一条分支。 */
export type ProviderKind = 'anthropic' | 'openai';
