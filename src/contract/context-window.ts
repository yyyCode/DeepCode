import type { Message, ToolResult } from './model-provider';

/**
 * 五层压缩的旋钮（P11）。全部可配置，但默认值**照抄复刻对象的形状**，
 * 不是我们测出来的最优值 —— 这一条在设计文档 §7 偏差 2 里写明。
 *
 * 比例全部锚在 `compact.atTokens` 上：我们没有模型注册表，不知道真实窗口是多少，
 * 也就不发明一个窗口（与 P7 `/context` 那条"不报还剩多少"同一条纪律）。
 */
export type ContextLayerConfig = {
  /** 单个工具结果超过这个字符数就落盘，只留预览。 */
  readonly toolResultMaxChars: number;
  /** 预览保留多少字符。 */
  readonly toolResultPreviewChars: number;
  /** 同一条 `role:'tool'` 消息的总字符上限；超了继续外置最大的结果。 */
  readonly toolMessageMaxChars: number;
  /** 第 2 层触发比例（相对 atTokens）。 */
  readonly snipAtRatio: number;
  /** 第 2 层保留最近几轮原文。 */
  readonly snipKeepTurns: number;
  /** 第 3 层触发比例。 */
  readonly microAtRatio: number;
  /** 第 3 层保留最近几个可重新获取的工具结果。 */
  readonly microKeepRecent: number;
  /** 第 3 层的第二个触发：距上次请求超过这么久（缓存大概率已过期）。 */
  readonly microIdleMs: number;
  /** 第 4 层触发比例。 */
  readonly collapseAtRatio: number;
  /** 第 4 层紧急模式触发比例（保留更少轮次）。 */
  readonly collapseUrgentRatio: number;
  /** 第 4 层正常保留最近几轮。 */
  readonly collapseKeepTurns: number;
  /** 第 4 层紧急模式保留最近几轮。 */
  readonly collapseUrgentKeepTurns: number;
};

export const DEFAULT_CONTEXT_LAYERS: ContextLayerConfig = {
  toolResultMaxChars: 50_000,
  toolResultPreviewChars: 2_000,
  toolMessageMaxChars: 200_000,
  snipAtRatio: 0.8,
  snipKeepTurns: 6,
  microAtRatio: 0.85,
  microKeepRecent: 5,
  microIdleMs: 60 * 60 * 1000,
  collapseAtRatio: 0.9,
  collapseUrgentRatio: 0.95,
  collapseKeepTurns: 4,
  collapseUrgentKeepTurns: 2,
};

/** 一次请求的投影统计。`externalized` / `collapsed*` 是会话累计，其余是上一次请求。 */
export type LayerStats = {
  readonly externalized: number;
  readonly externalizedChars: number;
  readonly snippedMessages: number;
  readonly clearedResults: number;
  readonly collapsedSegments: number;
  readonly collapsedMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
};

export function emptyLayerStats(): LayerStats {
  return {
    externalized: 0,
    externalizedChars: 0,
    snippedMessages: 0,
    clearedResults: 0,
    collapsedSegments: 0,
    collapsedMessages: 0,
    tokensBefore: 0,
    tokensAfter: 0,
  };
}

export type ProjectionRequest = {
  /** 这一轮系统提示的字符数。 */
  readonly systemChars: number;
  /** 这一轮工具清单的字符数（`core/tool-list.ts` 的 `toolsChars`）。 */
  readonly toolChars: number;
  /** 第 4 层摘要调用用的中断信号。 */
  readonly signal: AbortSignal;
  /** 第 3 层「时间衰减」判据用的当前时间（毫秒）。 */
  readonly now: number;
};

export type RequestProjection = {
  readonly messages: readonly Message[];
  readonly stats: LayerStats;
  /** 这次请求实际命中的层，按执行顺序。`/context` 与测试都用它。 */
  readonly applied: readonly ('snip' | 'micro' | 'collapse')[];
};

/**
 * 上下文窗口控制器。
 *
 * 第 1 层是**写时**的（工具结果进消息列表之前替换成预览）；第 2–4 层是**读时投影**
 * （只影响这一次请求，不改 `messages`）。第 5 层不在这里 —— 它是 `cli/compact.ts`。
 */
export type ContextWindow = {
  /**
   * 第 1 层：把过大的工具结果落盘，返回替换后的结果数组。
   * 失败方向是 fail-open：写不进去就原样返回。
   */
  absorbToolResults(
    results: readonly ToolResult[],
    /** `toolUseId → 工具名`。工具名决定预览里给什么恢复建议。 */
    names: ReadonlyMap<string, string>,
  ): Promise<readonly ToolResult[]>;
  /** 第 2–4 层：算这一次请求的视图。**绝不修改传入的 `messages`。** */
  project(messages: readonly Message[], req: ProjectionRequest): Promise<RequestProjection>;
  /** 最近一次投影统计（`/context` 读它）。还没投影过时 `undefined`。 */
  last(): LayerStats | undefined;
};
