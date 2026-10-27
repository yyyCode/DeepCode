import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { McpServerConfig, McpServerState, McpToolInfo } from '../contract/mcp';
import { parseMcpServers } from '../mcp/config';
import {
  connectMcpServer,
  type McpConnection,
  type McpConnectDeps,
  type McpConnectResult,
} from '../mcp/stdio-client';
import type { DiscoveredPlugin } from './plugin-dir';

/**
 * 会话期的 MCP 运行时：把「用户级配置 + 插件 `.mcp.json`」变成一组活着的连接。
 *
 * 这一层坐在 `mcp/`（只懂协议）与 `cli/`（只懂装配）之间。它**不做权限判定**，
 * 也不认识工具注册面 —— 连接结果交给 `mcp-plugin.ts` 变成普通 `Plugin`。
 *
 * 一台起不来的 server 只影响它自己：`states` 里如实写 `failed`，其余照常连接。
 * 会话启动不能因为一个可选的扩展点而失败。
 */

export type McpRuntime = {
  /** 与配置同序：用户级在前，插件在后。 */
  readonly states: readonly McpServerState[];
  /** 所有已连接 server 的工具，扁平一份。 */
  readonly tools: readonly McpToolInfo[];
  readonly hasServers: boolean;
  /** 按完整工具名调用。失败也返回 `ERROR: ...` 文本。 */
  call(name: string, input: unknown, signal?: AbortSignal): Promise<string>;
  /** 幂等。 */
  close(): Promise<void>;
};

export type StartMcpDeps = {
  readonly home: string;
  /** 会话根目录：用户级配置里相对 `cwd` 的基准。 */
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  /** 五层设置里只认用户层，`readMcpServers` 已经筛过。 */
  readonly userServers: readonly McpServerConfig[];
  /** 已发现的插件：读它们声明的 `mcpServers` 路径或根目录 `.mcp.json`。 */
  readonly plugins?: readonly DiscoveredPlugin[];
  readonly warn?: (line: string) => void;
  readonly debug?: (line: string) => void;
  /** 测试注入点。省略 = 真的 spawn。 */
  readonly connect?: (config: McpServerConfig, deps: McpConnectDeps) => Promise<McpConnectResult>;
  /** 插件 `.mcp.json` 的读取面。省略 = `node:fs/promises`。 */
  readonly readText?: (path: string) => Promise<string | undefined>;
  /** 只连接用户级（不读插件），`/mcp` 之外的单测用。 */
  readonly skipPluginServers?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * 读一个插件带来的 MCP 配置。
 *
 * - 清单声明了 `mcpServers` 路径 → 读声明的；没有 → 读根目录 `./.mcp.json`。
 * - 名字冲突不在这里判：与用户级的冲突要在合并时统一处理（用户级优先）。
 * - 文件形状兼容两种：`{ "mcpServers": { ... } }`（复刻对象的 `.mcp.json`）与直接一张表。
 *
 * 插件本身已经过 `plugins.enable` / 清单校验 / 入口 import 三道闸 —— 这里的配置
 * 与它的代码是同一份信任，不额外加闸。
 */
export async function loadPluginMcpServers(
  plugins: readonly DiscoveredPlugin[],
  deps: {
    readonly home: string;
    readonly env: Record<string, string | undefined>;
    readonly warn: (line: string) => void;
    readonly readText?: (path: string) => Promise<string | undefined>;
  },
): Promise<readonly McpServerConfig[]> {
  const readText = deps.readText ?? defaultReadText;
  const out: McpServerConfig[] = [];

  for (const plugin of plugins) {
    const declared = plugin.manifest.paths['mcpServers'];
    const relative = declared?.[0] ?? './.mcp.json';
    const path = join(plugin.dir, relative);

    let text: string | undefined;
    try {
      text = await readText(path);
    } catch (error) {
      deps.warn(`插件 ${plugin.name} 的 ${relative} 读不了（${messageOf(error)}）—— 它的 MCP server 不启动。`);
      continue;
    }
    // 没声明、也没有约定文件：这是绝大多数插件。安静地跳过。
    if (text === undefined) continue;

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      deps.warn(`插件 ${plugin.name} 的 ${relative} 不是合法 JSON（${messageOf(error)}）—— 整份跳过。`);
      continue;
    }

    const table = isObject(data) && 'mcpServers' in data ? data['mcpServers'] : data;
    out.push(
      ...parseMcpServers(table, {
        origin: 'plugin',
        plugin: plugin.name,
        env: deps.env,
        // 插件配置里的相对路径以插件目录为基准 —— 与 `${DEEPCODE_PLUGIN_ROOT}` 一致。
        extraEnv: { DEEPCODE_PLUGIN_ROOT: plugin.dir, CLAUDE_PLUGIN_ROOT: plugin.dir },
        resolvePath: (value) => resolvePluginPath(value, plugin.dir, deps.home),
        warn: deps.warn,
      }),
    );
  }

  return out;
}

function resolvePluginPath(value: string, dir: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  if (isAbsolute(value)) return value;
  return resolve(dir, value);
}

/**
 * 汇总配置、并行连接、给出可调用的快照。
 *
 * `enabled: false` 的 server 不进连接池，但在 `states` 里留一行 `disabled` ——
 * 「配了但关着」与「根本没有」在 `/mcp` 里必须看得出区别。
 */
export async function startMcp(deps: StartMcpDeps): Promise<McpRuntime> {
  const warn = deps.warn ?? (() => {});
  const debug = deps.debug ?? (() => {});
  const connect = deps.connect ?? connectMcpServer;

  const pluginServers = deps.skipPluginServers
    ? []
    : await loadPluginMcpServers(deps.plugins ?? [], {
        home: deps.home,
        env: deps.env,
        warn,
        ...(deps.readText === undefined ? {} : { readText: deps.readText }),
      });

  // 用户级优先：同名插件 server 跳过并点名。两份都是用户自己的配置，
  // 但只有用户级是「直接写的」，插件那份是随插件带来的 —— 直接写的赢。
  const claimed = new Map<string, string>();
  const configs: McpServerConfig[] = [];
  for (const config of deps.userServers) {
    if (claimed.has(config.name)) {
      warn(`MCP server「${config.name}」在用户级配置里重复出现，后一条已跳过。`);
      continue;
    }
    claimed.set(config.name, '用户级配置');
    configs.push(config);
  }
  for (const config of pluginServers) {
    const owner = config.plugin === undefined ? '插件' : `插件 ${config.plugin}`;
    const holder = claimed.get(config.name);
    if (holder !== undefined) {
      warn(`MCP server「${config.name}」来自${owner}，与${holder}重名 —— 插件这一台跳过（用户级优先）。`);
      continue;
    }
    claimed.set(config.name, owner);
    configs.push(config);
  }

  const connections = new Map<string, McpConnection>();
  const byTool = new Map<string, { readonly connection: McpConnection; readonly tool: McpToolInfo }>();
  const states: McpServerState[] = [];
  const tools: McpToolInfo[] = [];

  const results = await Promise.all(
    configs.map(async (config) => {
      if (!config.enabled) {
        return { config, result: { ok: false, reason: '已禁用（enabled: false）' } as const };
      }
      const result = await connect(config, {
        env: deps.env,
        ...(deps.warn === undefined ? {} : { warn: deps.warn }),
        ...(deps.debug === undefined ? {} : { debug: deps.debug }),
      });
      return { config, result };
    }),
  );

  for (const { config, result } of results) {
    if (!config.enabled) {
      states.push({ name: config.name, status: { kind: 'disabled' }, tools: [] });
      continue;
    }
    if (!result.ok) {
      states.push({ name: config.name, status: { kind: 'failed', reason: result.reason }, tools: [] });
      warn(`⚠️ MCP server「${config.name}」连接失败：${result.reason}（这台的工具不可用，其余照常）`);
      continue;
    }

    const connection = result.connection;
    connections.set(config.name, connection);
    for (const tool of connection.tools) {
      byTool.set(tool.name, { connection, tool });
      tools.push(tool);
    }
    states.push({
      name: config.name,
      status: {
        kind: 'connected',
        tools: connection.tools.length,
        protocolVersion: connection.protocolVersion,
      },
      tools: connection.tools,
    });
  }

  const connectedCount = states.filter((state) => state.status.kind === 'connected').length;
  if (configs.length > 0) {
    debug(`[mcp] ${connectedCount}/${configs.length} 台 server 已连接，工具 ${tools.length} 个`);
  }

  let closing: Promise<void> | undefined;

  return {
    states,
    tools,
    hasServers: configs.length > 0,
    async call(name, input, signal) {
      const hit = byTool.get(name);
      if (hit === undefined) return `ERROR: 未知的 MCP 工具：${name}`;
      return hit.connection.call(
        hit.tool.tool,
        input,
        signal === undefined ? {} : { signal },
      );
    },
    close() {
      closing ??= Promise.all([...connections.values()].map((connection) => connection.close())).then(
        () => undefined,
      );
      return closing;
    },
  };
}
