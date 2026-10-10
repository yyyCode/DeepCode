import type { EngineInterface } from './engine';
import type { Next } from './next';
import type { Tier } from './tier';

// ─────────────────────────────────────────────────────────────
// 第一族：MVP 实际实现链的 12 个事件
// ─────────────────────────────────────────────────────────────

export type EventArgs = {
  'engine.create': { readonly plugins: readonly string[] };
  'plugin.register': {
    readonly name: string;
    readonly tier: Tier;
    readonly uses: readonly string[];
  };
  'session.start': { readonly sessionId: string; readonly cwd: string; readonly root: string };
  'session.end': { readonly reason: 'exit' | 'interrupt' | 'error' };
  'prompt.submit': { readonly text: string };
  'turn.start': { readonly index: number };
  'turn.step': { readonly delta: string };
  'turn.complete': {
    readonly stopReason: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  'tool.call': { readonly tool: string; readonly input: unknown; readonly toolUseId: string };
  'tool.check': { readonly tool: string; readonly input: unknown };
  'tool.describe': { readonly tool: string };
  'command.run': { readonly name: string; readonly args: readonly string[] };
};

export type EventResult = {
  'engine.create': Partial<EngineInterface>;
  'plugin.register': { readonly allow: true } | { readonly refuse: string };
  'session.start': Record<string, never>;
  'session.end': Record<string, never>;
  'prompt.submit': { readonly handled?: boolean };
  'turn.start': Record<string, never>;
  'turn.step': Record<string, never>;
  'turn.complete': Record<string, never>;
  'tool.call': { readonly value: unknown } | { readonly deny: string };
  'tool.check': { readonly decision: 'allow' | 'ask' | 'deny'; readonly rule?: string };
  'tool.describe': { readonly description: string; readonly inputSchema: unknown };
  'command.run': { readonly handled?: boolean };
};

// ─────────────────────────────────────────────────────────────
// 第二族：只声明、未实现的事件（约 28 个）
//
// core 落到它们时抛 NotImplementedError。现在就冻结，是因为事件目录
// 是这套架构里最容易返工的部分 —— 见设计文档 §3.3。
// ─────────────────────────────────────────────────────────────

export type UnimplementedEvent =
  | 'ui.render'
  | 'ui.press'
  | 'ui.input'
  | 'ui.select'
  | 'ui.message'
  | 'ui.scroll'
  | 'ui.focus'
  | 'ui.resolve'
  | 'agent.offer'
  | 'agent.spawn'
  | 'prompt.fill'
  | 'prompt.suggest'
  | 'prompt.edit'
  | 'prompt.section'
  | 'prompt.context'
  | 'prompt.compose'
  | 'prompt.attachment'
  | 'command.describe'
  | 'config.set'
  | 'config.describe'
  | 'skill.prompt'
  | 'attribution.text'
  | 'session.receive'
  | 'session.compact'
  | 'session.attach'
  | 'session.detach'
  | 'session.measure';

export type AllEventArgs = EventArgs & {
  readonly [K in UnimplementedEvent]: Record<string, unknown>;
};
export type AllEventResult = EventResult & { readonly [K in UnimplementedEvent]: unknown };

export type EventName = keyof AllEventArgs;
export type Args<N extends EventName> = AllEventArgs[N];
export type Result<N extends EventName> = AllEventResult[N];

// ─────────────────────────────────────────────────────────────
// 事件与其参数的形状
// ─────────────────────────────────────────────────────────────

/**
 * 事件参数是深只读的：`e.command = 'ls'` 编译不过。
 * 改写必须拷贝后经 next 传下去：`next({ ...e, tool: 'Grep' })`。
 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** MVP 里只有 turn.step 是流式事件（其 hook 是 async generator）。 */
export const STREAMING_EVENTS = ['turn.step'] as const;
export type StreamingEventName = (typeof STREAMING_EVENTS)[number];

export type HookFor<N extends EventName> = (
  $: EngineInterface,
  e: DeepReadonly<Args<N>>,
  next: Next<Args<N>, Result<N>>,
) => Result<N> | Promise<Result<N>>;
