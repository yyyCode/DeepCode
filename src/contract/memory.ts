/**
 * 记忆系统的契约（P12）。
 *
 * 四种类型是**封闭集合** —— 与复刻对象一样，不设 `any`。多一种类型会让写入方
 * 少做一次分类决策，而记忆膨胀通常就是从「先塞进去再说」开始的。
 *
 * 上限全部是常量，不做配置项：它们是这套机制的压力阀，可调就等于可以悄悄关掉。
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** 索引注入的硬上限（行 + 字节，两个维度都要查）。 */
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

/** 召回前最多扫多少个记忆文件（最新的优先）。 */
export const MAX_SCAN_FILES = 200;

/** 单条记忆正文的上限。超了 `save` 拒绝，不静默截断。 */
export const MAX_MEMORY_CHARS = 20_000;

/** 单条记忆注入正文的上限与一次召回的总上限。 */
export const MAX_RECALL_BODY_CHARS = 4_000;
export const MAX_RECALL_TOTAL_CHARS = 12_000;

/** `description` 的上限：一行、一句话，专门用于召回匹配。 */
export const MAX_DESCRIPTION_CHARS = 200;

/** `name`（也是文件名）的上限。 */
export const MAX_NAME_CHARS = 64;

/** 超过这么多天的记忆，注入时附带陈旧度警告。 */
export const FRESHNESS_DAYS = 1;

export type MemoryConfig = {
  /** 关掉 = 不注册 `Memory` 工具、不注入索引、不召回。 */
  readonly enabled: boolean;
  /** 每次最多召回几条。 */
  readonly maxRecall: number;
  /** 配了才走小模型召回；省略 = 纯关键词。 */
  readonly recallModel?: string;
};

export const DEFAULT_MEMORY: MemoryConfig = { enabled: true, maxRecall: 5 };

/** 扫描得到的头部信息。正文不在这里 —— 只有被召回时才读。 */
export type MemoryHeader = {
  /** 文件名去掉 `.md`，也是 `Memory` 工具的 `name`。 */
  readonly name: string;
  /** 磁盘上的文件名（含 `.md`）。 */
  readonly file: string;
  readonly description: string;
  readonly type: MemoryType;
  /** `modified` 的毫秒时间戳；缺失时回落到文件 mtime。 */
  readonly modified: number;
};

/** `/context` 的「记忆」那一行。数字全部来自插件自己，不另算一本账。 */
export type MemoryStats = {
  readonly enabled: boolean;
  /** 有效记忆数。 */
  readonly count: number;
  /** 坏掉（frontmatter 读不懂 / 类型不认识）而被跳过的文件数。 */
  readonly broken: number;
  /** 注入的索引行数与字符数（已截断之后）。 */
  readonly indexLines: number;
  readonly indexChars: number;
  readonly indexTruncated: boolean;
  /** 上一次提问真正召回的名字。 */
  readonly recalled: readonly string[];
  readonly recalledChars: number;
  readonly recallMode: 'keyword' | 'model' | 'none';
};
