/**
 * MCP 桥接的契约面。
 *
 * 这一层只放**形状与常量**：`src/mcp/` 与 `src/cli/` 都要认同一份
 * `McpServerConfig` / `McpToolInfo`，各写一份迟早会漂。
 *
 * 传输只做 stdio（P16 设计 §2）：其余类型的配置在解析期就被点名跳过，
 * 不会变成这里的一个可选字段 —— 一个「看起来支持、实际没有实现」的字段
 * 比明确不支持更坏。
 */

/** 一台 server 的配置从哪来。用户级优先；插件同名时插件那台被跳过。 */
export type McpServerOrigin = 'user' | 'plugin';

/** 一台已经通过形状校验、变量展开与名字合法化的 stdio server。 */
export type McpServerConfig = {
  /** 配置里的原始键，`/mcp` 用它显示。 */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** 已解析成绝对路径；没写是 undefined，连接时回落到会话根目录。 */
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly origin: McpServerOrigin;
  /** `origin === 'plugin'` 时提供它的插件名。 */
  readonly plugin: string | undefined;
};

/** 一个 server 报上来的工具，以及它在模型面前的样子。 */
export type McpToolInfo = {
  /** server 原始名。 */
  readonly server: string;
  /** 合法化之后的 server 段（`-` → `_`）。 */
  readonly serverPrefix: string;
  /** server 报的原始工具名。 */
  readonly name: string;
  /** 模型与权限规则看到的完整工具名：`mcp__<server>__<tool>`。 */
  readonly tool: string;
  /** 已加 `[MCP <server>]` 前缀。 */
  readonly description: string;
  readonly inputSchema: unknown;
};

export type McpServerStatus =
  | { readonly kind: 'connected'; readonly tools: number; readonly protocolVersion: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'disabled' };

export type McpServerState = {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly tools: readonly McpToolInfo[];
};

/** `tools/call` 的默认超时。与 Bash 的默认值不同：MCP 调用常常是网络或索引操作。 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
/** 上限。配置写了更大的数按默认值处理并警告 —— 一个没有上限的等待不是超时。 */
export const MAX_MCP_TIMEOUT_MS = 600_000;
/** 单行 JSON-RPC 上限。超过就判这台 server 死，不把内存交给一个坏掉的进程。 */
export const MAX_MCP_LINE_BYTES = 16 * 1024 * 1024;
/** 模型/权限规则看到的工具名上限（`mcp__<server>__<tool>` 整串）。 */
export const MAX_TOOL_NAME_LENGTH = 64;
/** server 名（配置键）的长度上限。留给工具段至少 30 个字符。 */
export const MAX_SERVER_NAME_LENGTH = 32;
