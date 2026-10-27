import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../src/contract/mcp';
import {
  connectMcpServer,
  renderCallResult,
  windowsQuote,
  type McpConnection,
} from '../src/mcp/stdio-client';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

function config(overrides: Partial<McpServerConfig> = {}, mode = 'normal'): McpServerConfig {
  return {
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    env: { FAKE_MCP_MODE: mode },
    cwd: undefined,
    timeoutMs: 5_000,
    enabled: true,
    origin: 'user',
    plugin: undefined,
    ...overrides,
  };
}

const opened: McpConnection[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
});

async function start(cfg = config(), deps: { env?: Record<string, string | undefined> } = {}) {
  const debugLines: string[] = [];
  const warnings: string[] = [];
  const result = await connectMcpServer(cfg, {
    debug: (line) => debugLines.push(line),
    warn: (line) => warnings.push(line),
    ...deps,
  });
  if (result.ok) opened.push(result.connection);
  return { result, debugLines, warnings };
}

async function connected(cfg = config(), deps: { env?: Record<string, string | undefined> } = {}) {
  const started = await start(cfg, deps);
  if (!started.result.ok) throw new Error(`连不上：${started.result.reason}`);
  return { connection: started.result.connection, ...started };
}

async function waitFor(check: () => boolean, ms = 1_500): Promise<boolean> {
  const from = Date.now();
  while (Date.now() - from < ms) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('connectMcpServer', () => {
  it('握手成功，工具名合法化后带前缀', async () => {
    const { connection } = await connected();
    expect(connection.protocolVersion).toBe('2025-06-18');
    expect(connection.tools.map((tool) => tool.name)).toContain('mcp__fake__echo');
    expect(connection.tools.map((tool) => tool.name)).toContain('mcp__fake__bad_name_v2');
    const echo = connection.tools.find((tool) => tool.tool === 'echo');
    expect(echo).toMatchObject({ server: 'fake', description: '回显参数' });
  });

  it('按 nextCursor 翻页，工具不丢', async () => {
    const { connection } = await connected(config({}, 'paginated'));
    expect(connection.tools.length).toBe(9);
    expect(connection.tools.map((tool) => tool.name)).toContain('mcp__fake__crash');
  });

  it('server 不声明 tools 能力时照样连接，工具为空', async () => {
    const { result } = await start(config({}, 'no-tools'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connection.tools).toEqual([]);
  });

  it('未知协议版本只警告，不拒绝连接', async () => {
    const { result, warnings } = await start(config(), {
      env: { ...process.env, FAKE_MCP_VERSION: '2030-01-01' },
    });
    expect(result.ok).toBe(true);
    expect(warnings.some((line) => line.includes('2030-01-01'))).toBe(true);
  });

  it('命令起不来返回 failed，不抛', async () => {
    const { result } = await start(config({ command: 'definitely-not-a-real-command-xyz' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/无法启动|进程退出/);
  });

  it('启不来的 server 把 stderr 末段带进 reason', async () => {
    const { result } = await start(config({}, 'exit-early'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('启动即退出');
  });

  it('enabled:false 不启动', async () => {
    const { result } = await start(config({ enabled: false }));
    expect(result).toEqual({ ok: false, reason: '已禁用（enabled: false）' });
  });

  it('非法 JSON 行只警告一次，连接照常', async () => {
    const { connection, warnings } = await connected(config({}, 'bad-json'));
    expect(connection.tools.length).toBeGreaterThan(0);
    expect(warnings.filter((line) => line.includes('非法 JSON-RPC 行'))).toHaveLength(1);
  });
});

describe('tools/call 结果', () => {
  it('文本原样返回', async () => {
    const { connection } = await connected();
    await expect(connection.call('echo', { text: 'hi' })).resolves.toBe('echo:{"text":"hi"}');
  });

  it('isError 加 ERROR 前缀', async () => {
    const { connection } = await connected();
    await expect(connection.call('fail', {})).resolves.toBe('ERROR: boom');
  });

  it('resource / 图片 / 未知类型按设计转换', async () => {
    const { connection } = await connected();
    await expect(connection.call('mixed', {})).resolves.toBe(
      [
        'hello',
        'file body',
        '[资源 file:///b.bin（base64，已省略）]',
        '[image image/png，已省略 base64]',
        '[audio audio/wav，已省略 base64]',
        '{"type":"weird","foo":1}',
      ].join('\n'),
    );
  });

  it('没有 content 时用 structuredContent', async () => {
    const { connection } = await connected();
    await expect(connection.call('structured', {})).resolves.toBe('{"ok":true,"n":2}');
  });

  it('空结果给一句人话', async () => {
    const { connection } = await connected();
    await expect(connection.call('empty', {})).resolves.toBe('(MCP server 返回了空结果)');
  });

  it('JSON-RPC 错误变成 ERROR 文本，不抛', async () => {
    const { connection } = await connected();
    const text = await connection.call('error', {});
    expect(text).toContain('ERROR: MCP fake/error 调用失败：');
    expect(text).toContain('tool exploded');
  });

  it('arguments 不是对象直接拒绝', async () => {
    const { connection } = await connected();
    await expect(connection.call('echo', [])).resolves.toContain('arguments 必须是对象');
    await expect(connection.call('echo', null)).resolves.toContain('arguments 必须是对象');
  });

  it('超时返回 ERROR 并给 server 发 notifications/cancelled', async () => {
    const { connection, debugLines } = await connected();
    const text = await connection.call('slow', { ms: 1_000 }, { timeoutMs: 60 });
    expect(text).toContain('请求超时（60ms）');
    expect(await waitFor(() => debugLines.some((line) => line.includes('cancelled:') && line.endsWith(':timeout')))).toBe(true);
  });

  it('中断返回「已中断」并发 cancelled user', async () => {
    const { connection, debugLines } = await connected();
    const controller = new AbortController();
    const pending = connection.call('slow', { ms: 5_000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).resolves.toContain('已中断');
    expect(await waitFor(() => debugLines.some((line) => line.includes('cancelled:') && line.endsWith(':user')))).toBe(true);
  });

  it('调用中进程退出：ERROR 且 dead', async () => {
    const { connection } = await connected(config({}, 'crash-on-call'));
    const text = await connection.call('echo', {});
    expect(text).toContain('ERROR: MCP fake/echo 调用失败：');
    expect(text).toContain('进程退出');
    expect(await waitFor(() => connection.dead)).toBe(true);
  });
});

describe('close', () => {
  it('幂等，关闭后调用直接失败', async () => {
    const { connection } = await connected();
    await connection.close();
    await connection.close();
    expect(connection.dead).toBe(true);
    await expect(connection.call('echo', {})).resolves.toContain('连接已关闭');
  });
});

describe('renderCallResult', () => {
  it('非对象结果也能给出文本', () => {
    expect(renderCallResult('plain')).toBe('(MCP server 返回了空结果)');
    expect(renderCallResult(null)).toBe('(MCP server 返回了空结果)');
  });
});

describe('windowsQuote', () => {
  it('普通参数不加引号，含空白或元字符的包起来', () => {
    expect(windowsQuote('npx')).toBe('npx');
    expect(windowsQuote('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
    expect(windowsQuote('a&b')).toBe('"a&b"');
    expect(windowsQuote('')).toBe('""');
  });
});
