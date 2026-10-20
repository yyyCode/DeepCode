import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './config';

/** 启动握手的上限。MCP server 起不来时，CLI 不该跟着卡住。 */
const INIT_TIMEOUT_MS = 5_000;

/** 列工具的上限。冷启动的 Python server 常常在 initialize 里就把活干完了。 */
const LIST_TIMEOUT_MS = 10_000;

/** 与 Bash 同一档：模型看到的东西不能无限长。 */
const MAX_OUTPUT_CHARS = 40_000;

const MAX_LIST_PAGES = 100;

export type RawMcpTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export type McpCallResult = {
  readonly text: string;
  readonly isError: boolean;
};

export type McpConnection = {
  readonly server: string;
  listTools(): Promise<readonly RawMcpTool[]>;
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
  /** 进程退出时用的同步兜底：异步 close 来不及跑。 */
  killSync(): void;
};

/**
 * 启动一个 MCP server 并完成握手。
 *
 * stdio 的 server 是**以当前用户身份跑的子进程** —— 配置里写了什么就执行什么，
 * 所以配置只从用户级文件来（见 config.ts）。这里不做 shell 解释，`command` 与
 * `args` 原样交给 spawn。
 */
export async function connectMcpServer(
  server: McpServerConfig,
  warn: (line: string) => void,
): Promise<McpConnection> {
  const client = new Client({ name: 'deepcode', version: '0.0.1' }, { capabilities: {} });

  const transport =
    server.transport === 'stdio'
      ? new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          env: childEnv(server.env),
          stderr: 'pipe',
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        })
      : new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { ...server.headers } },
        });

  if (transport instanceof StdioClientTransport) {
    const stderr = transport.stderr;
    stderr?.on('data', (chunk: unknown) => {
      const line = String(chunk).trim();
      if (line !== '') warn(`[mcp:${server.name}] ${line.slice(0, 1_000)}`);
    });
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch {
      // 已经退出的子进程再关一次会抛 —— 退出路径不该被它绊住。
    }
  };

  try {
    await client.connect(transport, { timeout: Math.min(server.timeoutMs, INIT_TIMEOUT_MS) });
  } catch (error) {
    await close();
    throw error;
  }

  const listTimeout = Math.min(server.timeoutMs, LIST_TIMEOUT_MS);

  return {
    server: server.name,

    async listTools(): Promise<readonly RawMcpTool[]> {
      const out: RawMcpTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          { timeout: listTimeout },
        );

        for (const tool of result.tools) {
          if (typeof tool.name !== 'string' || tool.name === '') {
            warn(`MCP 服务 ${server.name} 返回了一个没有名字的工具，已跳过。`);
            continue;
          }
          if (seen.has(tool.name)) {
            warn(`MCP 服务 ${server.name} 重复返回了工具 ${tool.name}，只保留第一份。`);
            continue;
          }
          if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
            warn(`MCP 工具 ${server.name}/${tool.name} 的 inputSchema 不是 object，已跳过。`);
            continue;
          }
          seen.add(tool.name);
          out.push({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: tool.inputSchema,
          });
        }

        cursor = result.nextCursor;
        if (cursor === undefined || cursor === '') break;
      }

      return out;
    },

    async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<McpCallResult> {
      if (!isRecord(input)) throw new Error('工具参数必须是一个对象');
      const result = await client.callTool(
        { name, arguments: input },
        undefined,
        {
          timeout: server.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return toCallResult(result);
    },

    close,

    killSync(): void {
      if (!(transport instanceof StdioClientTransport)) return;
      const pid = transport.pid;
      if (pid === null) return;
      try {
        process.kill(pid);
      } catch {
        // 已经退出了。
      }
    },
  };
}

function childEnv(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

function toCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) return { text: 'ERROR: MCP 返回了无法识别的内容', isError: true };

  if ('toolResult' in result) {
    const text = JSON.stringify(result.toolResult, null, 2);
    return cap(text === undefined ? '(MCP 工具没有返回内容)' : text, false);
  }

  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const text = contentText(block);
      if (text !== undefined) parts.push(text);
    }
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  const raw = parts.join('\n').trim();
  const text = raw === '' ? '(MCP 工具没有返回内容)' : raw;
  return cap(text, result.isError === true);
}

function contentText(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : undefined;

    case 'image':
      return `[图片 ${mimeOf(block)}]`;

    case 'audio':
      return `[音频 ${mimeOf(block)}]`;

    case 'resource': {
      if (!isRecord(block.resource)) return undefined;
      const uri = typeof block.resource.uri === 'string' ? block.resource.uri : '(未知地址)';
      return typeof block.resource.text === 'string'
        ? `[资源 ${uri}]\n${block.resource.text}`
        : `[资源 ${uri}：二进制内容已省略]`;
    }

    case 'resource_link': {
      const name = typeof block.name === 'string' ? block.name : '(未命名)';
      const uri = typeof block.uri === 'string' ? block.uri : '(未知地址)';
      return `[资源 ${name}: ${uri}]`;
    }

    default:
      return `[不支持的 MCP 内容类型：${String(block.type)}]`;
  }
}

function mimeOf(block: Record<string, unknown>): string {
  return typeof block.mimeType === 'string' ? block.mimeType : '未知类型';
}

function cap(text: string, isError: boolean): McpCallResult {
  let output = isError && !text.startsWith('ERROR:') ? `ERROR: ${text}` : text;
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n... 输出已截断`;
  }
  return { text: output, isError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
