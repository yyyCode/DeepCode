import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 用户级 MCP 配置文件。**只认用户级** —— 见下面 `loadMcpConfig` 的注释。 */
export const MCP_CONFIG_FILE = 'mcp.json';

/** 单次工具调用的默认超时。初始化与列工具另有更短的发现超时。 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

export type McpStdioServer = {
  readonly name: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs: number;
};

export type McpHttpServer = {
  readonly name: string;
  readonly transport: 'http';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

export type McpServerConfig = McpStdioServer | McpHttpServer;

export type McpConfig = {
  readonly servers: readonly McpServerConfig[];
};

export const EMPTY_MCP_CONFIG: McpConfig = { servers: [] };

export type LoadMcpConfigDeps = {
  readonly home: string;
  /** 测试替身：返回 undefined 表示文件不存在。默认真读磁盘。 */
  readonly readText?: (path: string) => Promise<string | undefined>;
  readonly warn?: (line: string) => void;
};

export function mcpConfigPath(home: string): string {
  return join(home, '.deepcode', MCP_CONFIG_FILE);
}

/**
 * 读 `~/.deepcode/mcp.json`。
 *
 * **刻意不读项目级配置**：MCP server 是以当前用户身份启动的一个进程，
 * 让克隆下来的仓库文件自动拉进程，等于把"打开一个仓库"变成"执行仓库里的命令"。
 * 以后要支持项目级，也得先有一道显式的信任开关。
 *
 * 坏文件的处置与设置文件一致：**整份按空处理并出声**，不让 CLI 起不来。
 * 一个 MCP 服务配错不该阻断编码。
 */
export async function loadMcpConfig(deps: LoadMcpConfigDeps): Promise<McpConfig> {
  const warn = deps.warn ?? (() => {});
  const readText = deps.readText ?? readTextFile;
  const path = mcpConfigPath(deps.home);

  let text: string | undefined;
  try {
    text = await readText(path);
  } catch (error) {
    warn(`MCP 配置 ${path} 读不了（${describe(error)}），本次不启用 MCP。`);
    return EMPTY_MCP_CONFIG;
  }
  if (text === undefined) return EMPTY_MCP_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    warn(`MCP 配置 ${path} 不是合法 JSON（${describe(error)}），本次不启用 MCP。`);
    return EMPTY_MCP_CONFIG;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`MCP 配置 ${path} 的顶层必须是一个对象，本次不启用 MCP。`);
    return EMPTY_MCP_CONFIG;
  }

  const record = raw as Record<string, unknown>;
  const serversValue = record.mcpServers;
  if (serversValue === undefined) {
    const unknown = Object.keys(record).filter((key) => key !== 'mcpServers');
    if (unknown.length > 0) {
      warn(`MCP 配置 ${path} 里有不认识的顶层键：${unknown.join('、')}（已忽略）。`);
    }
    return EMPTY_MCP_CONFIG;
  }
  if (serversValue === null || typeof serversValue !== 'object' || Array.isArray(serversValue)) {
    warn(`MCP 配置 ${path} 的 "mcpServers" 必须是一个对象，本次不启用 MCP。`);
    return EMPTY_MCP_CONFIG;
  }

  const knownTop = new Set(['mcpServers']);
  const unknown = Object.keys(record).filter((key) => !knownTop.has(key));
  if (unknown.length > 0) {
    warn(`MCP 配置 ${path} 里有不认识的顶层键：${unknown.join('、')}（已忽略）。`);
  }

  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const [name, value] of Object.entries(serversValue as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      warn(`MCP 配置 ${path} 里的服务名 ${JSON.stringify(name)} 不合法，已跳过（只允许字母、数字、_、-）。`);
      continue;
    }
    if (seen.has(name)) {
      warn(`MCP 配置 ${path} 里重复的服务名 ${name}，后者已跳过。`);
      continue;
    }
    const parsed = parseServer(name, value, path, warn);
    if (parsed !== undefined) {
      servers.push(parsed);
      seen.add(name);
    }
  }

  return { servers };
}

function parseServer(
  name: string,
  value: unknown,
  where: string,
  warn: (line: string) => void,
): McpServerConfig | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 不是一个对象，已跳过。`);
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== undefined && type !== 'stdio' && type !== 'http') {
    warn(`MCP 配置 ${where} 里的服务 ${name}.type 只能是 "stdio" 或 "http"，已跳过。`);
    return undefined;
  }

  const hasCommand = typeof record.command === 'string' && record.command.trim() !== '';
  const hasUrl = typeof record.url === 'string' && record.url.trim() !== '';
  if (hasCommand && hasUrl) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 同时给了 command 和 url，无法判断用哪种传输，已跳过。`);
    return undefined;
  }
  if (!hasCommand && !hasUrl) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 需要 command（stdio）或 url（http），已跳过。`);
    return undefined;
  }
  if (type === 'stdio' && !hasCommand) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 说是 stdio，却没有 command，已跳过。`);
    return undefined;
  }
  if (type === 'http' && !hasUrl) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 说是 http，却没有 url，已跳过。`);
    return undefined;
  }

  const timeoutMs = parseTimeout(record.timeoutMs, name, where, warn);

  if (hasCommand) {
    const command = String(record.command).trim();
    const args = stringArray(record.args, `${name}.args`, where, warn);
    if (args === undefined) return undefined;
    const env = stringRecord(record.env, `${name}.env`, where, warn);
    if (env === undefined) return undefined;

    let cwd: string | undefined;
    if (record.cwd !== undefined) {
      if (typeof record.cwd !== 'string' || record.cwd.trim() === '') {
        warn(`MCP 配置 ${where} 里的服务 ${name}.cwd 必须是非空字符串，已跳过。`);
        return undefined;
      }
      cwd = record.cwd;
    }

    warnUnknown(record, ['type', 'command', 'args', 'env', 'cwd', 'timeoutMs'], name, where, warn);
    return {
      name,
      transport: 'stdio',
      command,
      args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs,
    };
  }

  const urlText = String(record.url).trim();
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    warn(`MCP 配置 ${where} 里的服务 ${name}.url 不是合法 URL，已跳过。`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warn(`MCP 配置 ${where} 里的服务 ${name}.url 只能是 http 或 https，已跳过。`);
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    warn(`MCP 配置 ${where} 里的服务 ${name}.url 带了用户名或密码，已跳过；认证请放进 headers。`);
    return undefined;
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 使用明文 HTTP，建议只在可信内网使用。`);
  }

  const headers = stringRecord(record.headers, `${name}.headers`, where, warn);
  if (headers === undefined) return undefined;

  warnUnknown(record, ['type', 'url', 'headers', 'timeoutMs'], name, where, warn);
  return { name, transport: 'http', url: urlText, headers, timeoutMs };
}

function parseTimeout(
  value: unknown,
  name: string,
  where: string,
  warn: (line: string) => void,
): number {
  if (value === undefined) return DEFAULT_MCP_TIMEOUT_MS;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  warn(`MCP 配置 ${where} 里的服务 ${name}.timeoutMs 必须是正整数，按默认值处理。`);
  return DEFAULT_MCP_TIMEOUT_MS;
}

function stringArray(
  value: unknown,
  label: string,
  where: string,
  warn: (line: string) => void,
): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    warn(`MCP 配置 ${where} 里的 ${label} 必须是字符串数组，服务已跳过。`);
    return undefined;
  }
  return [...value];
}

function stringRecord(
  value: unknown,
  label: string,
  where: string,
  warn: (line: string) => void,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warn(`MCP 配置 ${where} 里的 ${label} 必须是字符串对象，服务已跳过。`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') {
      warn(`MCP 配置 ${where} 里的 ${label}.${key} 必须是字符串，服务已跳过。`);
      return undefined;
    }
    out[key] = item;
  }
  return out;
}

function warnUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  where: string,
  warn: (line: string) => void,
): void {
  const set = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !set.has(key));
  if (unknown.length > 0) {
    warn(`MCP 配置 ${where} 里的服务 ${name} 有不认识的字段：${unknown.join('、')}（已忽略）。`);
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw error;
  }
}
