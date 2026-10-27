import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, McpServerState, McpToolInfo } from '../src/contract/mcp';
import type { McpConnection, McpConnectResult } from '../src/mcp/stdio-client';
import type { DiscoveredPlugin } from '../src/cli/plugin-dir';
import type { Rule } from '../src/contract/policy';
import type { PluginManifest } from '../src/contract/plugin-manifest';
import { CORE_ORIGIN } from '../src/contract/next';
import { createEngine } from '../src/core/create';
import { listTools } from '../src/core/tool-list';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { createPermissionsPlugin, createSessionGrants } from '../src/builtins/permissions';
import { createPlanMode, createPlanModePlugin } from '../src/builtins/plan';
import { createMcpPlugin, formatMcpStates } from '../src/cli/mcp-plugin';
import {
  loadPluginMcpServers,
  startMcp,
  type McpRuntime,
  type StartMcpDeps,
} from '../src/cli/mcp-runtime';
import type { ModelProvider } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';

const ROOT = resolve('/proj');
const HOME = resolve('/home/u');
const PLUGIN_DIR = join(ROOT, 'plugins', 'demo');

function toolInfo(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    server: 'fake',
    serverPrefix: 'fake',
    name: 'mcp__fake__echo',
    tool: 'echo',
    description: '回显参数',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    ...overrides,
  };
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'fake',
    command: 'node',
    args: ['server.mjs'],
    env: {},
    cwd: undefined,
    timeoutMs: 60_000,
    enabled: true,
    origin: 'user',
    plugin: undefined,
    ...overrides,
  };
}

function fakeConnection(cfg: McpServerConfig, tools: readonly McpToolInfo[], onClose?: () => void): McpConnection {
  return {
    config: cfg,
    protocolVersion: '2025-06-18',
    tools,
    async call(raw, input) {
      return `called:${raw}:${JSON.stringify(input)}`;
    },
    async close() {
      onClose?.();
    },
    get dead() {
      return false;
    },
  };
}

function okConnection(cfg: McpServerConfig, tools: readonly McpToolInfo[]): McpConnectResult {
  return { ok: true, connection: fakeConnection(cfg, tools) };
}

async function start(overrides: Partial<StartMcpDeps> = {}) {
  const warnings: string[] = [];
  const runtime = await startMcp({
    home: HOME,
    root: ROOT,
    env: {},
    userServers: [],
    warn: (line) => warnings.push(line),
    skipPluginServers: true,
    ...overrides,
  });
  return { runtime, warnings };
}

// ── 运行时：合并、连接、状态 ────────────────────────────────────────

describe('startMcp', () => {
  it('连上的 server 进 states + tools，调用按完整名转发', async () => {
    const tool = toolInfo();
    const { runtime } = await start({
      userServers: [config()],
      connect: async (cfg) => okConnection(cfg, [tool]),
    });

    expect(runtime.hasServers).toBe(true);
    expect(runtime.states).toEqual([
      {
        name: 'fake',
        status: { kind: 'connected', tools: 1, protocolVersion: '2025-06-18' },
        tools: [tool],
      },
    ]);
    expect(runtime.tools).toEqual([tool]);
    await expect(runtime.call(tool.name, { text: 'hi' })).resolves.toBe(
      'called:echo:{"text":"hi"}',
    );
    await expect(runtime.call('mcp__nope__x', {})).resolves.toContain('未知的 MCP 工具');
    await runtime.close();
  });

  it('enabled:false 不连接，在 states 里留一行 disabled', async () => {
    const connect = vi.fn(async (cfg: McpServerConfig) => okConnection(cfg, []));
    const { runtime } = await start({
      userServers: [config({ enabled: false })],
      connect,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(runtime.states).toEqual([{ name: 'fake', status: { kind: 'disabled' }, tools: [] }]);
    expect(runtime.hasServers).toBe(true);
  });

  it('一台连不上不影响别的，失败原因如实报', async () => {
    const { runtime, warnings } = await start({
      userServers: [config({ name: 'bad' }), config({ name: 'good' })],
      connect: async (cfg) =>
        cfg.name === 'bad'
          ? { ok: false, reason: 'spawn node ENOENT' }
          : okConnection(cfg, [toolInfo({ server: 'good', name: 'mcp__good__echo' })]),
    });

    expect(runtime.states[0]).toEqual({
      name: 'bad',
      status: { kind: 'failed', reason: 'spawn node ENOENT' },
      tools: [],
    });
    expect(runtime.states[1]?.status.kind).toBe('connected');
    expect(warnings.some((line) => line.includes('bad') && line.includes('ENOENT'))).toBe(true);
    await runtime.close();
  });

  it('插件 server 与用户级同名：插件那台跳过并点名', async () => {
    const plugin = pluginFixture();
    const connect = vi.fn(async (cfg: McpServerConfig) => okConnection(cfg, []));

    const warnings: string[] = [];
    const runtime = await startMcp({
      home: HOME,
      root: ROOT,
      env: {},
      userServers: [config()],
      plugins: [plugin],
      warn: (line) => warnings.push(line),
      connect,
      readText: async () =>
        JSON.stringify({ mcpServers: { fake: { command: 'node', args: ['plugin.mjs'] } } }),
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(warnings.some((line) => line.includes('重名') && line.includes('用户级优先'))).toBe(true);
    expect(runtime.states.map((state) => state.name)).toEqual(['fake']);
    await runtime.close();
  });

  it('close 幂等：每台 connection 只关一次', async () => {
    const closes: string[] = [];
    const { runtime } = await start({
      userServers: [config({ name: 'a' }), config({ name: 'b' })],
      connect: async (cfg) => ({
        ok: true,
        connection: fakeConnection(cfg, [], () => closes.push(cfg.name)),
      }),
    });
    await runtime.close();
    await runtime.close();
    expect(closes.sort()).toEqual(['a', 'b']);
  });
});

// ── 插件 .mcp.json ────────────────────────────────────────────────

function pluginFixture(
  manifestPaths: Readonly<Record<string, readonly string[]>> = {},
): DiscoveredPlugin {
  const manifest: PluginManifest = {
    name: 'demo',
    version: '1.0.0',
    description: undefined,
    homepage: undefined,
    author: undefined,
    uses: [],
    paths: manifestPaths,
  };
  return {
    name: 'demo',
    dir: PLUGIN_DIR,
    origin: 'user',
    manifest,
    entry: undefined,
    hooks: [],
  };
}

describe('loadPluginMcpServers', () => {
  it('没声明路径时读根目录 .mcp.json', async () => {
    const seen: string[] = [];
    const servers = await loadPluginMcpServers([pluginFixture()], {
      home: HOME,
      env: {},
      warn: () => {},
      readText: async (path) => {
        seen.push(path);
        return JSON.stringify({ mcpServers: { fs: { command: 'npx' } } });
      },
    });
    expect(seen).toEqual([join(PLUGIN_DIR, '.mcp.json')]);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'fs', origin: 'plugin', plugin: 'demo' });
  });

  it('声明了路径就读声明的；${DEEPCODE_PLUGIN_ROOT} 展开成插件目录', async () => {
    const servers = await loadPluginMcpServers(
      [pluginFixture({ mcpServers: ['./mcp/config.json'] })],
      {
        home: HOME,
        env: {},
        warn: () => {},
        readText: async () =>
          JSON.stringify({
            mcpServers: {
              fs: { command: 'node', args: ['${DEEPCODE_PLUGIN_ROOT}/s.mjs'], cwd: '.' },
            },
          }),
      },
    );
    // args 是不透明字符串，只做变量展开、不做路径归一 —— 与 command 同一条。
    expect(servers[0]?.args).toEqual([`${PLUGIN_DIR}/s.mjs`]);
    expect(servers[0]?.cwd).toBe(PLUGIN_DIR);
  });

  it('${CLAUDE_PLUGIN_ROOT} 也认；缺变量那一台跳过', async () => {
    const warnings: string[] = [];
    const servers = await loadPluginMcpServers([pluginFixture()], {
      home: HOME,
      env: {},
      warn: (line) => warnings.push(line),
      readText: async () =>
        JSON.stringify({
          mcpServers: {
            good: { command: '${CLAUDE_PLUGIN_ROOT}/bin' },
            bad: { command: '${NOT_DEFINED}' },
          },
        }),
    });
    expect(servers.map((server) => server.name)).toEqual(['good']);
    expect(servers[0]?.command).toBe(`${PLUGIN_DIR}/bin`);
    expect(warnings.some((line) => line.includes('NOT_DEFINED'))).toBe(true);
  });

  it('坏 JSON 整份跳过并警告；没有文件安静跳过', async () => {
    const warnings: string[] = [];
    const servers = await loadPluginMcpServers([pluginFixture(), pluginFixture()], {
      home: HOME,
      env: {},
      warn: (line) => warnings.push(line),
      readText: async () => '{',
    });
    const absent = await loadPluginMcpServers([pluginFixture()], {
      home: HOME,
      env: {},
      warn: (line) => warnings.push(line),
      readText: async () => undefined,
    });
    expect(servers).toEqual([]);
    expect(absent).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('demo');
  });
});

// ── 插件面：注册、权限、/mcp ────────────────────────────────────────

const provider: ModelProvider = {
  name: 'stub',
  async *stream() {
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
};

function fakeRuntime(tools: readonly McpToolInfo[], states: readonly McpServerState[], hasServers = true): McpRuntime {
  return {
    states,
    tools,
    hasServers,
    async call(name, input) {
      return `runtime:${name}:${JSON.stringify(input)}`;
    },
    async close() {},
  };
}

async function engine(plugins: readonly Plugin[]) {
  const prints: string[] = [];
  const { $, dispatch } = await createEngine({
    plugins: [...plugins],
    provider,
    ui: {
      print: (line) => prints.push(line),
      notice: () => {},
      ask: async () => 'y',
    },
    sessionInfo: { id: 's1', cwd: ROOT, root: ROOT },
    env: {},
    signal: () => new AbortController().signal,
  });
  return { $, dispatch, prints };
}

function permissionRules(...rules: Rule[]): Plugin {
  return createPermissionsPlugin({ rules, grants: createSessionGrants() });
}

const connectedState: McpServerState = {
  name: 'fake',
  status: { kind: 'connected', tools: 1, protocolVersion: '2025-06-18' },
  tools: [toolInfo()],
};

describe('createMcpPlugin', () => {
  it('工具进模型清单，描述带 [MCP server] 前缀', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const world = await engine([plugin, confirmPlugin]);

    const listing = await listTools({ $: world.$, dispatch: world.dispatch });
    const spec = listing.specs.find((item) => item.name === 'mcp__fake__echo');
    expect(spec?.description).toBe('[MCP fake] 回显参数');

    // 没有 readOnly 声明 = 按会写处理（同一轮串行）。
    const described = await world.dispatch(
      'tool.describe',
      { tool: 'mcp__fake__echo' },
      CORE_ORIGIN,
    );
    expect(described).not.toHaveProperty('readOnly');
  });

  it('没有描述的 server 也有一句人话', async () => {
    const plugin = createMcpPlugin(
      fakeRuntime([toolInfo({ description: '' })], [connectedState]),
    );
    const world = await engine([plugin, confirmPlugin]);
    const described = await world.dispatch('tool.describe', { tool: 'mcp__fake__echo' }, CORE_ORIGIN);
    expect(described).toMatchObject({
      description: '[MCP fake] echo（服务器没有提供描述）',
    });
  });

  it('默认每次询问，而且 confirm 不会把它当未知工具拒掉', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const world = await engine([permissionRules(), plugin, confirmPlugin]);
    const verdict = await world.dispatch(
      'tool.check',
      { tool: 'mcp__fake__echo', input: {}, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(verdict).toEqual({ decision: 'ask', rule: 'MCP 工具：fake/echo' });
  });

  it('permissions allow 能把 ask 变成 allow', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const world = await engine([
      permissionRules({ raw: 'mcp__fake__echo', tool: 'mcp__fake__echo', decision: 'allow' }),
      plugin,
      confirmPlugin,
    ]);
    const verdict = await world.dispatch(
      'tool.check',
      { tool: 'mcp__fake__echo', input: {}, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(verdict.decision).toBe('allow');
  });

  it('整工具 deny 让工具从清单里消失，并拒绝调用', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const world = await engine([
      permissionRules({ raw: 'mcp__fake__echo', tool: 'mcp__fake__echo', decision: 'deny' }),
      plugin,
      confirmPlugin,
    ]);

    const listing = await listTools({ $: world.$, dispatch: world.dispatch });
    expect(listing.specs.map((spec) => spec.name)).not.toContain('mcp__fake__echo');

    const verdict = await world.dispatch(
      'tool.check',
      { tool: 'mcp__fake__echo', input: {}, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(verdict.decision).toBe('deny');
  });

  it('tool.call 把运行时返回的文本原样交给模型', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const world = await engine([plugin, confirmPlugin]);
    const result = await world.dispatch(
      'tool.call',
      { tool: 'mcp__fake__echo', input: { text: 'hi' }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(result).toEqual({ value: 'runtime:mcp__fake__echo:{"text":"hi"}' });
  });

  it('计划模式下不可见（没有 readOnly 声明 = 按会写处理）', async () => {
    const plugin = createMcpPlugin(fakeRuntime([toolInfo()], [connectedState]));
    const mode = createPlanMode({ now: () => 1 });
    const world = await engine([createPlanModePlugin(mode), plugin, confirmPlugin, ...coreTools]);

    const before = await listTools({ $: world.$, dispatch: world.dispatch });
    expect(before.specs.map((spec) => spec.name)).toContain('mcp__fake__echo');

    await world.dispatch(
      'tool.call',
      { tool: 'EnterPlanMode', input: {}, toolUseId: 'enter' },
      CORE_ORIGIN,
    );
    const during = await listTools({ $: world.$, dispatch: world.dispatch });
    expect(during.specs.map((spec) => spec.name)).not.toContain('mcp__fake__echo');
  });

  it('/mcp 逐台列出状态与工具', async () => {
    const plugin = createMcpPlugin(
      fakeRuntime(
        [toolInfo()],
        [
          connectedState,
          { name: 'old', status: { kind: 'failed', reason: 'spawn npx ENOENT' }, tools: [] },
          { name: 'off', status: { kind: 'disabled' }, tools: [] },
        ],
      ),
    );
    const world = await engine([plugin]);
    const result = await world.dispatch(
      'command.run',
      { name: 'mcp', args: [] },
      CORE_ORIGIN,
    );
    expect(result).toEqual({ handled: true });
    const text = world.prints.join('\n');
    expect(text).toContain('mcp servers');
    expect(text).toContain('fake');
    expect(text).toContain('connected  1 tools');
    expect(text).toContain('mcp__fake__echo');
    expect(text).toContain('spawn npx ENOENT');
    expect(text).toContain('disabled');
    expect(text).toContain('下个会话生效');
  });
});

describe('formatMcpStates', () => {
  it('没有配置时给出用户级配置的提示', () => {
    const lines = formatMcpStates([], false);
    expect(lines.join('\n')).toContain('~/.deepcode/settings.json');
    expect(lines.join('\n')).toContain('项目级');
  });
});
