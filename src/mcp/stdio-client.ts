import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { McpServerConfig, McpToolInfo } from '../contract/mcp';
import { serverPrefix, toolName } from './config';
import {
  JsonRpcPeer,
  JsonRpcTimeoutError,
  type JsonRpcId,
  type JsonRpcRequestOptions,
} from './jsonrpc';

/**
 * 一台 stdio MCP server 的连接。
 *
 * 这一层只懂 MCP 与管道：不认识工具插件、权限、渲染器。工具名合法化用
 * `config.ts` 的 `toolName`（与 `/mcp` 显示的名字必须是同一份）。
 *
 * 连接失败**不抛**：返回 `{ ok: false, reason }`，由运行时决定怎么报。
 * 会话不能因为一台 server 起不来就起不来 —— 那正是把可选的扩展点变成硬依赖。
 */

const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'deepcode';
const CLIENT_VERSION = '0.0.1';
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const INITIALIZE_TIMEOUT_MS = 10_000;
const TOOLS_LIST_TIMEOUT_MS = 15_000;
const MAX_TOOL_PAGES = 100;
const CLOSE_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_000;

export type McpConnectDeps = {
  /** 调试行（`DEEPCODE_DEBUG=1` 时才有内容）。 */
  readonly debug?: (line: string) => void;
  /** 用户看得见的警告：非法行、未知协议版本、翻页超限。 */
  readonly warn?: (line: string) => void;
  /** 子进程的环境变量基线。省略 = `process.env`。 */
  readonly env?: Record<string, string | undefined>;
  /** 平台。省略 = `process.platform`（测试里可注入）。 */
  readonly platform?: NodeJS.Platform;
};

export type McpCallOptions = {
  /** 省略 = server 配置里的 `timeoutMs`。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type McpConnection = {
  readonly config: McpServerConfig;
  readonly protocolVersion: string;
  readonly tools: readonly McpToolInfo[];
  /** 永远返回字符串（失败也返回 `ERROR: ...`），与内建工具同一条。 */
  call(rawTool: string, input: unknown, options?: McpCallOptions): Promise<string>;
  /** 幂等。 */
  close(): Promise<void>;
  /** 进程已退出或连接已判死。 */
  readonly dead: boolean;
};

export type McpConnectResult =
  | { readonly ok: true; readonly connection: McpConnection }
  | { readonly ok: false; readonly reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * cmd.exe 的参数转义。Windows 上必须启用 shell 才能跑 `npx` 这类 `.cmd`，
 * 而 `spawn(..., { shell: true })` 只是把命令与参数用空格拼起来 —— 不替我们加引号。
 * 含空白或 shell 元字符的参数必须自己包起来。
 */
export function windowsQuote(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** `tools/call` 的部分转成给模型看的文本。规则见设计 §5.4。 */
export function renderCallResult(result: unknown): string {
  const record = isObject(result) ? result : {};
  const content = record['content'];

  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) parts.push(renderItem(item));
  }

  if (parts.length === 0) {
    if (record['structuredContent'] !== undefined) {
      return JSON.stringify(record['structuredContent']);
    }
    return '(MCP server 返回了空结果)';
  }

  const text = parts.join('\n');
  return record['isError'] === true ? `ERROR: ${text}` : text;
}

function renderItem(item: unknown): string {
  if (!isObject(item)) return JSON.stringify(item);

  const type = item['type'];
  if (type === 'text' && typeof item['text'] === 'string') return item['text'];

  if (type === 'resource') {
    const resource = item['resource'];
    if (isObject(resource)) {
      if (typeof resource['text'] === 'string') return resource['text'];
      if (typeof resource['blob'] === 'string') {
        const uri = typeof resource['uri'] === 'string' ? resource['uri'] : '?';
        return `[资源 ${uri}（base64，已省略）]`;
      }
    }
    return JSON.stringify(item);
  }

  if (type === 'image' || type === 'audio') {
    const mime = typeof item['mimeType'] === 'string' ? item['mimeType'] : '未知类型';
    return `[${type} ${mime}，已省略 base64]`;
  }

  return JSON.stringify(item);
}

function describeCallError(error: unknown): string {
  if (error instanceof JsonRpcTimeoutError) return `请求超时（${error.timeoutMs}ms）`;
  const message = messageOf(error);
  // 中断那条由 `jsonrpc.ts` 统一措辞；换成模型看得懂的两个字，别把类名漏出去。
  if (message.includes('已中断')) return '已中断';
  return message;
}

export async function connectMcpServer(
  config: McpServerConfig,
  deps: McpConnectDeps = {},
): Promise<McpConnectResult> {
  if (!config.enabled) return { ok: false, reason: '已禁用（enabled: false）' };

  const debug = deps.debug ?? (() => {});
  const warn = deps.warn ?? (() => {});
  const platform = deps.platform ?? process.platform;
  const tag = `[mcp:${config.name}]`;

  let stderrTail = '';
  let stderrBuffer = '';
  const stderrDecoder = new StringDecoder('utf8');

  const feedStderr = (chunk: Buffer): void => {
    stderrBuffer += stderrDecoder.write(chunk);
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.replace(/\r$/, '');
      if (text.trim() === '') continue;
      debug(`${tag} ${text}`);
      stderrTail = `${stderrTail}${text}\n`.slice(-STDERR_TAIL_CHARS);
    }
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    const command = platform === 'win32' ? windowsQuote(config.command) : config.command;
    const args = platform === 'win32' ? config.args.map(windowsQuote) : [...config.args];
    child = spawn(command, args, {
      cwd: config.cwd,
      env: { ...(deps.env ?? process.env), ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 不启用 shell 就跑不了 `.cmd`（`npx` 就是）。POSIX 上不启用 ——
      // 参数里一个 `;` 不该变成第二条命令。
      shell: platform === 'win32',
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, reason: `无法启动：${messageOf(error)}` };
  }

  let exited = false;
  let dead = false;
  let invalidWarned = false;

  const exitReason = (code: number | null, signal: NodeJS.Signals | null): string => {
    const tail = stderrTail.trim();
    const how = signal !== null ? `信号 ${signal}` : `code ${code ?? '?'}`;
    return `进程退出（${how}）${tail === '' ? '' : `：${tail}`}`;
  };

  const peer = new JsonRpcPeer({
    write: (line) => {
      if (child.stdin.destroyed) throw new Error('stdin 已关闭');
      child.stdin.write(`${line}\n`);
    },
    onInvalid: (line, error) => {
      if (!invalidWarned) {
        invalidWarned = true;
        warn(`${tag} 收到非法 JSON-RPC 行（已丢弃）：${messageOf(error)} — ${line.slice(0, 120)}`);
      } else {
        debug(`${tag} 丢弃非法行：${messageOf(error)}`);
      }
    },
    onNotification: (method, params) => {
      if (method === 'notifications/message' && isObject(params)) {
        debug(`${tag} ${typeof params['level'] === 'string' ? params['level'] : 'info'}: ${String(params['data'] ?? '')}`);
      } else if (method === 'notifications/tools/list_changed') {
        debug(`${tag} 工具清单变了 —— 本版本不热更新，下个会话生效。`);
      } else {
        debug(`${tag} 通知 ${method}`);
      }
    },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of peer.lines.push(chunk)) peer.handleLine(line);
  });
  child.stderr.on('data', feedStderr);
  child.stdin.on('error', (error) => {
    peer.failAll(new Error(`写 stdin 失败：${error.message}`));
  });
  child.on('error', (error) => {
    exited = true;
    peer.failAll(new Error(`无法启动：${error.message}`));
  });
  child.on('exit', (code, signal) => {
    exited = true;
    const tail = stderrDecoder.end();
    if (tail !== '') stderrTail = `${stderrTail}${tail}`.slice(-STDERR_TAIL_CHARS);
    peer.failAll(new Error(exitReason(code, signal)));
  });
  child.stdout.on('close', () => {
    for (const line of peer.lines.end()) peer.handleLine(line);
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      dead = true;
      peer.failAll(new Error('连接已关闭'));
      try {
        child.stdin.end();
      } catch {
        // 管道可能已经断了。关闭是尽力而为。
      }
      if (exited) return;
      const exitedNow = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_GRACE_MS).unref?.();
      });
      await Promise.race([exitedNow, timeout]);
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经死了。
        }
      }
    })();
    return closing;
  };

  const fail = async (reason: string): Promise<McpConnectResult> => {
    dead = true;
    peer.failAll(new Error(reason));
    try {
      child.kill('SIGKILL');
    } catch {
      // 起不来的进程没什么可杀的。
    }
    return { ok: false, reason };
  };

  let init: unknown;
  try {
    init = await peer.request(
      'initialize',
      {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
  } catch (error) {
    return fail(`initialize 失败：${messageOf(error)}`);
  }

  if (!isObject(init)) return fail('initialize 返回的不是对象');

  const protocolVersion =
    typeof init['protocolVersion'] === 'string' ? init['protocolVersion'] : CLIENT_PROTOCOL_VERSION;
  if (!KNOWN_PROTOCOL_VERSIONS.has(protocolVersion)) {
    // 已知版本之间工具面同构；不认识的版本也先按同构处理 —— 拒绝连接只会让人无路可走。
    warn(`${tag} server 报告的协议版本 ${protocolVersion} 不在已知集合里，按兼容继续。`);
  }

  peer.notify('notifications/initialized', undefined);

  const capabilities = init['capabilities'];
  const hasTools = isObject(capabilities) && capabilities['tools'] !== undefined;

  const tools: McpToolInfo[] = [];
  if (hasTools) {
    const used = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_TOOL_PAGES) {
        warn(`${tag} tools/list 翻了 ${MAX_TOOL_PAGES} 页还没完，后面的工具不接了。`);
        break;
      }

      let listed: unknown;
      try {
        listed = await peer.request(
          'tools/list',
          cursor === undefined ? {} : { cursor },
          { timeoutMs: TOOLS_LIST_TIMEOUT_MS },
        );
      } catch (error) {
        return fail(`tools/list 失败：${messageOf(error)}`);
      }
      if (!isObject(listed) || !Array.isArray(listed['tools'])) {
        return fail('tools/list 返回的 tools 不是数组');
      }

      for (const item of listed['tools']) {
        if (!isObject(item) || typeof item['name'] !== 'string' || item['name'] === '') {
          warn(`${tag} tools/list 里有一条没有 name 的工具，已跳过。`);
          continue;
        }
        const raw = item['name'];
        tools.push({
          server: config.name,
          serverPrefix: serverPrefix(config.name),
          name: toolName(config.name, raw, used),
          tool: raw,
          description: typeof item['description'] === 'string' ? item['description'] : '',
          inputSchema: item['inputSchema'],
        });
      }

      const next = listed['nextCursor'];
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
  }

  const connection: McpConnection = {
    config,
    protocolVersion,
    tools,
    async call(rawTool, input, options = {}) {
      if (!isObject(input)) {
        return `ERROR: MCP ${config.name}/${rawTool} 调用的 arguments 必须是对象`;
      }
      const requestOptions: JsonRpcRequestOptions = {
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onCancel: (reason, requestId: JsonRpcId) => {
          // 本地删表只是不再等；server 那边还在干活。这是唯一一条能叫停它的消息。
          peer.notify('notifications/cancelled', { requestId, reason });
        },
      };
      try {
        const result = await peer.request(
          'tools/call',
          { name: rawTool, arguments: input },
          requestOptions,
        );
        return renderCallResult(result);
      } catch (error) {
        return `ERROR: MCP ${config.name}/${rawTool} 调用失败：${describeCallError(error)}`;
      }
    },
    close,
    get dead() {
      return dead || exited;
    },
  };

  return { ok: true, connection };
}
