import { connectMcpServer, type McpCallResult, type McpConnection } from './client';
import type { McpConfig, McpServerConfig } from './config';
import { allocateVisibleToolNames } from './names';

export type McpToolInfo = {
  /** MCP server 的配置名。 */
  readonly server: string;
  /** server 自己报的工具名，也是 `tools/call` 里要用的那个。 */
  readonly name: string;
  /** 模型看到的工具名。 */
  readonly visibleName: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export type McpHost = {
  readonly tools: readonly McpToolInfo[];
  call(visibleName: string, input: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
  killSync(): void;
};

export type ConnectMcpHostDeps = {
  readonly warn?: (line: string) => void;
};

type LiveServer = {
  readonly config: McpServerConfig;
  readonly connection: McpConnection;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[];
};

/**
 * 连接配置里的全部 MCP server，并把它们的工具摊平成一张模型可见的清单。
 *
 * 失败是**按 server 隔离**的：一个服务起不来只让它自己的工具消失，
 * 其余服务与 CLI 照常。所有失败都经过 `warn` 说出来 —— 安静地少几个工具，
 * 用户只会以为模型不会用。
 *
 * 工具名在全部 server 都列完之后统一分配，这样跨服务的重名也能一次处理掉。
 */
export async function connectMcpHost(
  config: McpConfig,
  deps: ConnectMcpHostDeps = {},
): Promise<McpHost> {
  const warn = deps.warn ?? (() => {});

  if (config.servers.length === 0) return emptyHost();

  const settled = await Promise.all(
    config.servers.map(async (server): Promise<LiveServer | undefined> => {
      let connection: McpConnection | undefined;
      try {
        connection = await connectMcpServer(server, warn);
        const tools = await connection.listTools();
        if (tools.length === 0) warn(`MCP 服务 ${server.name} 没有暴露工具。`);
        return { config: server, connection, tools };
      } catch (error) {
        await connection?.close();
        warn(`MCP 服务 ${server.name} 启动失败：${describe(error)}（已跳过）`);
        return undefined;
      }
    }),
  );

  const live = settled.filter((server): server is LiveServer => server !== undefined);
  if (live.length === 0) return emptyHost();

  const flat = live.flatMap((server) =>
    server.tools.map((tool) => ({ server, tool })),
  );
  const names = allocateVisibleToolNames(
    flat.map(({ server, tool }) => ({ server: server.config.name, name: tool.name })),
  );

  const tools: McpToolInfo[] = flat.map(({ server, tool }, index) => ({
    server: server.config.name,
    name: tool.name,
    visibleName: names[index] ?? `mcp__tool_${index}`,
    description:
      tool.description === ''
        ? `MCP 工具：${server.config.name}/${tool.name}`
        : tool.description,
    inputSchema: tool.inputSchema,
  }));

  const byVisible = new Map<
    string,
    { readonly connection: McpConnection; readonly originalName: string }
  >();
  for (const [index, info] of tools.entries()) {
    const entry = flat[index];
    if (entry === undefined) continue;
    byVisible.set(info.visibleName, {
      connection: entry.server.connection,
      originalName: info.name,
    });
  }

  let closed = false;

  return {
    tools,

    async call(visibleName, input, signal) {
      if (closed) throw new Error('MCP 已经关闭');
      const target = byVisible.get(visibleName);
      if (target === undefined) throw new Error(`未知的 MCP 工具：${visibleName}`);
      return target.connection.callTool(target.originalName, input, signal);
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(live.map((server) => server.connection.close()));
    },

    killSync() {
      for (const server of live) server.connection.killSync();
    },
  };
}

function emptyHost(): McpHost {
  return {
    tools: [],
    async call(visibleName) {
      throw new Error(`未知的 MCP 工具：${visibleName}`);
    },
    async close() {},
    killSync() {},
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
