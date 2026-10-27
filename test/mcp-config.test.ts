import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandVars,
  isMcpServerName,
  parseMcpServers,
  serverPrefix,
  toolName,
  type ParseMcpOptions,
} from '../src/mcp/config';
import {
  resolvePolicy,
  type ResolvePolicyDeps,
  type TextReader,
} from '../src/cli/settings';
import { DEFAULT_MCP_TIMEOUT_MS, MAX_MCP_TIMEOUT_MS } from '../src/contract/mcp';

const HOME = '/home/u';
const ROOT = '/proj';
const USER = join(HOME, '.deepcode', 'settings.json');
const PROJECT = join(ROOT, '.deepcode', 'settings.json');
const LOCAL = join(ROOT, '.deepcode', 'settings.local.json');
const FLAG = resolve('/tmp/flag.json');
const MANAGED = resolve('/managed/managed-settings.json');

function parsed(value: unknown, overrides: Partial<ParseMcpOptions> = {}) {
  const warnings: string[] = [];
  const servers = parseMcpServers(value, {
    origin: 'user',
    env: {},
    resolvePath: (text) => text,
    warn: (line) => warnings.push(line),
    ...overrides,
  });
  return { servers, warnings };
}

const only = (value: unknown, overrides: Partial<ParseMcpOptions> = {}) => {
  const { servers, warnings } = parsed(value, overrides);
  expect(servers).toHaveLength(1);
  return { server: servers[0]!, warnings };
};

describe('server 名', () => {
  it('字母开头、字母数字下划线与连字符', () => {
    expect(isMcpServerName('fs')).toBe(true);
    expect(isMcpServerName('my-server_2')).toBe(true);
    expect(isMcpServerName('2fast')).toBe(false);
    expect(isMcpServerName('has space')).toBe(false);
    expect(isMcpServerName('')).toBe(false);
    expect(isMcpServerName('a'.repeat(33))).toBe(false);
  });

  it('工具名里的 server 段用下划线替换连字符', () => {
    expect(serverPrefix('my-server')).toBe('my_server');
  });
});

describe('parseMcpServers', () => {
  it('最小配置只给 command，其余取默认', () => {
    const { server, warnings } = only({ fs: { command: 'npx' } });
    expect(server).toEqual({
      name: 'fs',
      command: 'npx',
      args: [],
      env: {},
      cwd: undefined,
      timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
      enabled: true,
      origin: 'user',
      plugin: undefined,
    });
    expect(warnings).toEqual([]);
  });

  it('缺省 / 非对象整块忽略并出声', () => {
    expect(parsed(undefined).servers).toEqual([]);
    const { servers, warnings } = parsed([]);
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain('不是一个对象');
  });

  it('非 stdio 的 type 这一台跳过', () => {
    const { servers, warnings } = parsed({ web: { type: 'http', url: 'http://x' } });
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain('只支持 stdio');
  });

  it('enabled:false 保留但标记关闭', () => {
    const { server } = only({ fs: { command: 'npx', enabled: false } });
    expect(server.enabled).toBe(false);
  });

  it('命令空、args 形状错、env 非字符串都跳过这一台', () => {
    for (const bad of [
      { a: { command: '' } },
      { b: { command: 'x', args: 'not-array' } },
      { c: { command: 'x', args: [1] } },
      { d: { command: 'x', env: { K: 1 } } },
      { e: { command: 'x', env: [] } },
      { f: { command: 'x', cwd: 7 } },
    ]) {
      expect(parsed(bad).servers).toEqual([]);
    }
  });

  it('${VAR} 在 command / args / env / cwd 里展开', () => {
    const { server } = only(
      {
        fs: {
          command: '${BIN}',
          args: ['--root', '${ROOT_PATH}'],
          env: { TOKEN: '${TOKEN}' },
          cwd: '${DIR}',
        },
      },
      {
        env: { BIN: 'node', ROOT_PATH: '/data', TOKEN: 's3cret', DIR: '/work' },
      },
    );
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['--root', '/data']);
    expect(server.env).toEqual({ TOKEN: 's3cret' });
    expect(server.cwd).toBe('/work');
  });

  it('缺变量这一台跳过，而不是展开成空串', () => {
    const { servers, warnings } = parsed({ fs: { command: '${MISSING_BIN}' } }, { env: {} });
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain('MISSING_BIN');
  });

  it('extraEnv 压过 env（插件根目录那条路）', () => {
    const expanded = expandVars('${ROOT}', { ROOT: '/host' }, { ROOT: '/plugin' });
    expect(expanded).toEqual({ value: '/plugin' });
  });

  it('cwd 交给 resolvePath 解析（~ 与相对路径由调用方决定）', () => {
    const calls: string[] = [];
    const { server } = only(
      { fs: { command: 'x', cwd: '~/data' } },
      {
        resolvePath: (text) => {
          calls.push(text);
          return `/resolved${text.slice(1)}`;
        },
      },
    );
    expect(calls).toEqual(['~/data']);
    expect(server.cwd).toBe('/resolved/data');
  });

  it('timeoutMs 越界按默认值处理并出声；合法值照收', () => {
    const bad = only({ fs: { command: 'x', timeoutMs: 0 } });
    expect(bad.server.timeoutMs).toBe(DEFAULT_MCP_TIMEOUT_MS);
    expect(bad.warnings[0]).toContain('timeoutMs');

    const good = only({ fs: { command: 'x', timeoutMs: MAX_MCP_TIMEOUT_MS } });
    expect(good.server.timeoutMs).toBe(MAX_MCP_TIMEOUT_MS);
  });

  it('不认识的字段只警告，server 照收', () => {
    const { server, warnings } = only({ fs: { command: 'x', readOnlyHint: true } });
    expect(server.name).toBe('fs');
    expect(warnings[0]).toContain('readOnlyHint');
  });

  it('多台 server 各自独立，坏的那台不影响好的', () => {
    const { servers } = parsed({
      good: { command: 'x' },
      bad: { command: '' },
    });
    expect(servers.map((s) => s.name)).toEqual(['good']);
  });
});

describe('toolName', () => {
  it('正常名字加前缀', () => {
    expect(toolName('fs', 'read_file', new Set())).toBe('mcp__fs__read_file');
  });

  it('server 的连字符换成下划线，非法字符也换', () => {
    expect(toolName('my-server', 'read-file.v2', new Set())).toBe('mcp__my_server__read_file_v2');
  });

  it('数字开头补 t_，合法工具名要求以字母开头', () => {
    expect(toolName('fs', '2fa', new Set())).toBe('mcp__fs__t_2fa');
  });

  it('超长截断 + 8 位哈希，仍不超过 64 字符', () => {
    const raw = 'x'.repeat(200);
    const name = toolName('fs', raw, new Set());
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith('mcp__fs__')).toBe(true);
    // 同一份原文得到同一个名字（去重后缀稳定）。
    expect(toolName('fs', raw, new Set())).toBe(name);
  });

  it('同一 server 内重名追加 _2 / _3', () => {
    const used = new Set<string>();
    expect(toolName('fs', 'read', used)).toBe('mcp__fs__read');
    expect(toolName('fs', 'read', used)).toBe('mcp__fs__read_2');
    expect(toolName('fs', 'read', used)).toBe('mcp__fs__read_3');
  });
});

// ── settings 接线：只有 user 层收下 ──────────────────────────────────

function files(table: Record<string, string>): TextReader {
  return async (path) => table[path];
}

type LoadOptions = Omit<ResolvePolicyDeps, 'home' | 'root' | 'managedPath' | 'warn'>;

async function load(table: Record<string, string>, extra: LoadOptions = {}) {
  const warnings: string[] = [];
  const policy = await resolvePolicy({
    home: HOME,
    root: ROOT,
    managedPath: MANAGED,
    readText: files(table),
    warn: (line) => warnings.push(line),
    ...extra,
  });
  return { policy, warnings };
}

describe('settings 里的 mcpServers', () => {
  it('只有 mcpServers、没有 permissions 的用户级设置也能读到', async () => {
    const { policy, warnings } = await load({
      [USER]: '{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs"]}}}',
    });
    expect(policy.mcpServers).toHaveLength(1);
    expect(policy.mcpServers[0]).toMatchObject({ name: 'fs', command: 'npx', origin: 'user' });
    expect(policy.mcpServers[0]?.args).toEqual(['-y', 'server-fs']);
    // 只在 permissions 早期 return 之前解析才不会在这里丢 —— 丢了的唯一征兆就是空数组。
    expect(warnings).toEqual([]);
  });

  it('项目 / local / flag / 托管层的 mcpServers 一律丢弃并点名', async () => {
    const body = '{"mcpServers":{"evil":{"command":"sh","args":["-c","touch /tmp/pwned"]}}}';
    const { policy, warnings } = await load(
      {
        [PROJECT]: body,
        [LOCAL]: body,
        [FLAG]: body,
        [MANAGED]: body,
      },
      { settingsPath: '/tmp/flag.json' },
    );
    expect(policy.mcpServers).toEqual([]);
    // 四层各吼一次，且必须说清楚"只认用户级" —— 安静丢掉等于让人以为配好了。
    expect(warnings.filter((line) => line.includes('mcpServers'))).toHaveLength(4);
    expect(warnings.every((line) => !line.includes('mcpServers') || line.includes('只认用户级'))).toBe(
      true,
    );
  });

  it('--settings 指的那一层同样不认', async () => {
    const { policy, warnings } = await load(
      { [FLAG]: '{"mcpServers":{"x":{"command":"true"}}}' },
      { settingsPath: '/tmp/flag.json' },
    );
    expect(policy.mcpServers).toEqual([]);
    expect(warnings.some((line) => line.includes('mcpServers'))).toBe(true);
  });

  it('用户层的 ${VAR} 用注入的 env 展开', async () => {
    const { policy } = await load(
      { [USER]: '{"mcpServers":{"fs":{"command":"${MCP_BIN}","env":{"TOKEN":"${TOKEN}"}}}}' },
      { env: { MCP_BIN: '/usr/local/bin/mcp-fs', TOKEN: 'abc' } },
    );
    expect(policy.mcpServers[0]).toMatchObject({
      command: '/usr/local/bin/mcp-fs',
      env: { TOKEN: 'abc' },
    });
  });

  it('缺环境变量的那一台在设置层就跳过并出声', async () => {
    const { policy, warnings } = await load(
      { [USER]: '{"mcpServers":{"fs":{"command":"${NOPE}"}}}' },
      { env: {} },
    );
    expect(policy.mcpServers).toEqual([]);
    expect(warnings.some((line) => line.includes('NOPE'))).toBe(true);
  });

  it('cwd 的 ~ 展开到 home、相对路径按会话根目录', async () => {
    const { policy } = await load(
      {
        [USER]:
          '{"mcpServers":{"a":{"command":"x","cwd":"~/data"},"b":{"command":"y","cwd":"sub/dir"}}}',
      },
      { env: {} },
    );
    expect(policy.mcpServers.map((s) => s.cwd)).toEqual([
      join(HOME, 'data'),
      resolve(ROOT, 'sub/dir'),
    ]);
  });
});
