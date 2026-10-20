import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { EngineInterface } from '@deepcode/contract/engine';
import {
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_TOOL_NAME,
  allocateVisibleToolNames,
  connectMcpHost,
  createMcpPlugin,
  loadMcpConfig,
  mcpConfigPath,
  visibleToolName,
  type McpConfig,
  type McpHost,
  type McpToolInfo,
} from '@deepcode/mcp';
import { createHarness, seat } from './harness';

const HOME = '/home/u';
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

function fakeHost(overrides: Partial<McpHost> = {}): McpHost {
  return {
    tools: [
      {
        server: 'srv',
        name: 'echo',
        visibleName: 'mcp__srv__echo',
        description: '回显',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
    call: async () => ({ text: 'ok', isError: false }),
    close: async () => {},
    killSync: () => {},
    ...overrides,
  };
}

/** 装一个 MCP 插件；链尾的 tool.check 故意说 deny，用来证明 MCP 的 ask 没往下走。 */
function mountPlugin(host: McpHost, controller = new AbortController()) {
  const engine = {
    session: {
      id: () => 's1',
      cwd: () => process.cwd(),
      root: () => process.cwd(),
      signal: () => controller.signal,
    },
  } as unknown as Partial<EngineInterface>;
  const h = createHarness({
    engine,
    coreImpls: {
      'tool.check': () => ({ decision: 'deny', rule: 'fell-through' }) as const,
    },
  });
  seat(h, createMcpPlugin(host), 'builtin');
  return { h, controller };
}

describe('loadMcpConfig：用户级配置', () => {
  it('只读 ~/.deepcode/mcp.json，解析两种传输并补默认超时', async () => {
    let readPath = '';
    const config = await loadMcpConfig({
      home: HOME,
      readText: async (path) => {
        readPath = path;
        return JSON.stringify({
          mcpServers: {
            fs: { command: 'node', args: ['server.mjs'], env: { ROOT: '/tmp' }, timeoutMs: 1234 },
            web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
          },
        });
      },
    });

    expect(readPath).toBe(mcpConfigPath(HOME));
    expect(config.servers).toEqual([
      {
        name: 'fs',
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { ROOT: '/tmp' },
        timeoutMs: 1234,
      },
      {
        name: 'web',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
      },
    ]);
  });

  it('文件不存在 = 没有配置，不报警', async () => {
    const warnings: string[] = [];
    const config = await loadMcpConfig({
      home: HOME,
      readText: async () => undefined,
      warn: (line) => warnings.push(line),
    });
    expect(config.servers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('坏 JSON 整份作废，但会出声', async () => {
    const warnings: string[] = [];
    const config = await loadMcpConfig({
      home: HOME,
      readText: async () => '{ nope',
      warn: (line) => warnings.push(line),
    });
    expect(config.servers).toEqual([]);
    expect(warnings.join('\n')).toContain('不是合法 JSON');
  });

  it('单条配错只跳过那一条：command+url、缺传输、坏服务名、坏超时', async () => {
    const warnings: string[] = [];
    const config = await loadMcpConfig({
      home: HOME,
      readText: async () =>
        JSON.stringify({
          mcpServers: {
            both: { command: 'node', url: 'https://example.com/mcp' },
            none: {},
            'bad name': { command: 'node' },
            slow: { command: 'node', timeoutMs: 0 },
          },
        }),
      warn: (line) => warnings.push(line),
    });

    expect(config.servers).toEqual([
      {
        name: 'slow',
        transport: 'stdio',
        command: 'node',
        args: [],
        env: {},
        timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
      },
    ]);
    expect(warnings).toHaveLength(4);
  });
});

describe('工具名：确定性、合法、不撞名', () => {
  it('非法字符换成下划线，前后缀一眼能认出来', () => {
    expect(visibleToolName('my server', 'do.thing')).toBe('mcp__my_server__do_thing');
  });

  it('超长名字截到 64，且每次算出来一样', () => {
    const name = visibleToolName('s', 'x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(visibleToolName('s', 'x'.repeat(200))).toBe(name);
  });

  it('清洗后撞名的两条各自得到不同的名字', () => {
    const names = allocateVisibleToolNames([
      { server: 's', name: 'a.b' },
      { server: 's', name: 'a b' },
    ]);
    expect(names[0]).toBe('mcp__s__a_b');
    expect(names[1]).not.toBe(names[0]);
    expect(names[1]?.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(allocateVisibleToolNames([
      { server: 's', name: 'a.b' },
      { server: 's', name: 'a b' },
    ])).toEqual(names);
  });
});

describe('createMcpPlugin：三条精确 hook', () => {
  it('describe 原样给出 server 的描述与参数表', async () => {
    const { h } = mountPlugin(fakeHost());
    expect(
      await h.dispatch('tool.describe', { tool: 'mcp__srv__echo' }, CORE_ORIGIN),
    ).toEqual({
      description: '回显',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
  });

  it('check 直接 ask，不调 next —— 否则链尾（或 confirm）会把它判死', async () => {
    const { h } = mountPlugin(fakeHost());
    expect(
      await h.dispatch(
        'tool.check',
        { tool: 'mcp__srv__echo', input: { text: 'hi' }, toolUseId: 'tu_1' },
        CORE_ORIGIN,
      ),
    ).toEqual({ decision: 'ask', rule: 'MCP 工具 srv/echo' });
  });

  it('call 把参数原样交给 host，正文原样交回模型', async () => {
    let seen: unknown;
    const { h } = mountPlugin(
      fakeHost({
        call: async (_visible, input) => {
          seen = input;
          return { text: 'echo:hi', isError: false };
        },
      }),
    );

    expect(
      await h.dispatch(
        'tool.call',
        { tool: 'mcp__srv__echo', input: { text: 'hi' }, toolUseId: 'tu_1' },
        CORE_ORIGIN,
      ),
    ).toEqual({ value: 'echo:hi' });
    expect(seen).toEqual({ text: 'hi' });
  });

  it('host 抛错变成 ERROR: 正文 —— 模型看得见，turn 不炸', async () => {
    const { h } = mountPlugin(
      fakeHost({
        call: async () => {
          throw new Error('server down');
        },
      }),
    );

    expect(
      await h.dispatch(
        'tool.call',
        { tool: 'mcp__srv__echo', input: {}, toolUseId: 'tu_1' },
        CORE_ORIGIN,
      ),
    ).toEqual({ value: 'ERROR: MCP 工具 srv/echo 调用失败：server down' });
  });

  it('signal 已经掐断时报「已取消」，不把取消装成调用失败', async () => {
    const controller = new AbortController();
    const { h } = mountPlugin(
      fakeHost({
        call: async () => {
          controller.abort();
          throw new Error('aborted');
        },
      }),
      controller,
    );

    expect(
      await h.dispatch(
        'tool.call',
        { tool: 'mcp__srv__echo', input: {}, toolUseId: 'tu_1' },
        CORE_ORIGIN,
      ),
    ).toEqual({ value: 'ERROR: 已取消' });
  });
});

describe('connectMcpHost：真的连一个子进程', () => {
  it('列工具、调用、错误标记、结构化兜底、关闭，以及坏服务不连坐', async () => {
    const warnings: string[] = [];
    const config: McpConfig = {
      servers: [
        {
          name: 'fake',
          transport: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
          env: {},
          timeoutMs: 10_000,
        },
        {
          name: 'gone',
          transport: 'stdio',
          command: 'definitely-not-a-real-command-xyz',
          args: [],
          env: {},
          timeoutMs: 5_000,
        },
      ],
    };

    const host = await connectMcpHost(config, { warn: (line) => warnings.push(line) });
    try {
      expect(host.tools.map((tool: McpToolInfo) => tool.visibleName)).toEqual([
        'mcp__fake__echo',
        'mcp__fake__fail',
        'mcp__fake__structured',
      ]);
      expect(warnings.some((line) => line.includes('gone') && line.includes('启动失败'))).toBe(true);

      expect(await host.call('mcp__fake__echo', { text: 'hi' })).toEqual({
        text: 'echo:hi',
        isError: false,
      });

      expect(await host.call('mcp__fake__fail', {})).toEqual({
        text: 'ERROR: boom',
        isError: true,
      });

      const structured = await host.call('mcp__fake__structured', {});
      expect(structured.isError).toBe(false);
      expect(structured.text).toContain('"answer": 42');

      await expect(host.call('mcp__fake__missing', {})).rejects.toThrow('未知的 MCP 工具');
    } finally {
      await host.close();
    }

    await expect(host.call('mcp__fake__echo', { text: 'hi' })).rejects.toThrow('MCP 已经关闭');
  });
});
