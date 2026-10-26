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

/**
 * 一次调用的用量。**只在端点真报了的时候才带** —— 缺了就缺了，塞 0 是撒谎
 * （`turn.complete` 的 `inputTokens` 曾经长期写死 0，压缩器拿到的信号一直是"上下文是空的"）。
 */
export type Usage = { readonly inputTokens: number; readonly outputTokens: number };

/** provider 的流式输出。文本增量即时产出；工具调用在参数收齐后一次性产出。 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'done'; readonly stopReason: string; readonly usage?: Usage };

/**
 * 两家适配器共用的归一：`input` 是 anthropic 的 `input_tokens` / openai 的 `prompt_tokens`，
 * 同理 `output`。
 *
 * **只有两个都是有限数才成一份 usage。** 缺一个就当整份没有 —— 报半个账比不报更坏：
 * 消费端会拿它当"这一轮就这么点输入"去比阈值。
 */
export function toUsage(input: unknown, output: unknown): Usage | undefined {
  const inputTokens = count(input);
  const outputTokens = count(output);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 系统提示的静态前缀与动态尾巴（P13）。
 *
 * `static` 必须逐字节稳定，并且 `system` 以它开头 —— provider 会把缓存断点放在它后面。
 * 两个都不含分隔符：真正发出去的 `system` 是 `static + '\n\n' + dynamic`（有空段时少一个）。
 */
export type SystemPromptParts = {
  readonly static: string;
  readonly dynamic: string;
};

export type StreamRequest = {
  readonly system: string;
  /**
   * 静态/动态拆分。省略 = 不启用分级缓存（旧行为：`system` 原样发）。
   *
   * 这是**可选**的：十几处测试与子代理都只给一个字符串，没有理由为了缓存把它们全改一遍。
   * Anthropic 用它把静态段包成 `cache_control` 块；OpenAI 兼容端点忽略它，靠稳定前缀
   * 自动命中。
   */
  readonly systemParts?: SystemPromptParts;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal: AbortSignal;
  /**
   * 覆盖适配器配置里的 model。省略 = 用配置的那个（会话级那个，也就是父级）。
   *
   * 模型分层没有别的表达方式：今天 model 是**适配器建的时候**定死的，没有别的口子。
   * 别名（`haiku` / `sonnet` / `opus`）**原样透传**，不翻译、不映射 ——
   * 我们不知道用户配的端点认不认它们，`providers/http.ts` 的 `MODEL_HINT_RE`
   * 已经会在模型 id 不存在时说一句人话，那已经是最好的处理方式。
   */
  readonly model?: string;
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
