import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyManagedGateway, type ResolvedSettings } from '../src/cli/config';
import { resolvePolicy, type ResolvedPolicy, type SettingsSource, type TextReader } from '../src/cli/settings';

/**
 * 出网位置只有托管层能钉（P5d，计划 Task 6）。
 *
 * 判据与 `sandbox.paths.allow` 那一段同形：**个人层写的东西会被整项丢掉并出声**。
 * 这条规矩要防的是"个人配置掀翻托管策略"里最锋利的一种 —— 策略还在，只是不再决定
 * 你连哪儿。所以断言钉在两个点上：托管层生效，且其余四层的写入**一个字都不生效**。
 */

const HOME = '/home/u';
const ROOT = '/proj';
const USER = join(HOME, '.deepcode', 'settings.json');
const PROJECT = join(ROOT, '.deepcode', 'settings.json');
const LOCAL = join(ROOT, '.deepcode', 'settings.local.json');
const FLAG = resolve('/tmp/flag.json');
const MANAGED = resolve('/managed/managed-settings.json');

function files(table: Record<string, string>): TextReader {
  return async (path) => table[path];
}

async function load(
  table: Record<string, string>,
  extra: Partial<Parameters<typeof resolvePolicy>[0]> = {},
): Promise<{ policy: ResolvedPolicy; warnings: string[] }> {
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

const block = (value: unknown): string => JSON.stringify({ gateway: value });

describe('gateway 段：只有托管层能钉', () => {
  it('托管层写 baseUrl + model → 两个都生效', async () => {
    const { policy, warnings } = await load({
      [MANAGED]: block({ baseUrl: 'https://gw.example.com', model: 'gw-model' }),
    });
    expect(policy.gateway).toEqual({ baseUrl: 'https://gw.example.com', model: 'gw-model' });
    // 正常路径一个字都不多说 —— 与"遥测关着时零输出"同一条口径。
    expect(warnings.filter((line) => line.includes('gateway'))).toEqual([]);
  });

  it('不是顶层未知键 —— 一份只写了 gateway 的托管设置不该被丢掉', async () => {
    const { warnings } = await load({ [MANAGED]: block({ baseUrl: 'https://gw.example.com' }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });

  it.each([
    ['user', USER],
    ['project', PROJECT],
    ['local', LOCAL],
    ['flag', FLAG],
  ])('%s 层写了 → 整项丢弃 + 出声（出网位置只有托管层能钉）', async (source, path) => {
    const { policy, warnings } = await load(
      { [path]: block({ baseUrl: 'https://evil.example.com' }) },
      { settingsPath: '/tmp/flag.json' },
    );
    expect(policy.gateway).toEqual({});
    expect(warnings.join('\n')).toContain('出网位置只有托管层能钉，这一份已丢弃');
    expect(warnings.join('\n')).toContain(source === 'flag' ? '[权限] flag 设置' : `[权限] ${source} 设置`);
  });

  it('个人层想覆盖托管层写的，一点用都没有（合并不看个人那四层）', async () => {
    const { policy } = await load({
      [MANAGED]: block({ baseUrl: 'https://gw.example.com' }),
      [USER]: block({ baseUrl: 'https://evil.example.com' }),
      [LOCAL]: block({ baseUrl: 'https://evil.example.com' }),
    });
    expect(policy.gateway).toEqual({ baseUrl: 'https://gw.example.com' });
  });

  it('形状不对 → 整块忽略并出声，不逐字段降级（半生效的网关比没生效更坏）', async () => {
    const { policy, warnings } = await load({ [MANAGED]: '{"gateway": "https://gw.example.com"}' });
    expect(policy.gateway).toEqual({});
    expect(warnings.join('\n')).toContain('gateway 块整块忽略');
  });

  it('空串 / 非字符串的子键被忽略并出声（空端点比没写更坏）', async () => {
    const { policy, warnings } = await load({
      [MANAGED]: block({ baseUrl: '   ', model: 42 }),
    });
    expect(policy.gateway).toEqual({});
    expect(warnings.join('\n')).toContain('gateway.baseUrl 不是非空字符串');
    expect(warnings.join('\n')).toContain('gateway.model 不是非空字符串');
  });

  it('不认识的子键只忽略那一个 + 出声', async () => {
    const { policy, warnings } = await load({
      [MANAGED]: block({ baseUrl: 'https://gw.example.com', timeout: 30 }),
    });
    expect(policy.gateway).toEqual({ baseUrl: 'https://gw.example.com' });
    expect(warnings.join('\n')).toContain('gateway 里有不认识的子键：timeout');
  });

  it('谁都没写 → {}', async () => {
    const { policy } = await load({});
    expect(policy.gateway).toEqual({});
  });
});

describe('applyManagedGateway：钉住的字段与"真的改了"的清单', () => {
  const base = (over: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
    apiKey: 'sk-test',
    model: 'claude-sonnet-5-5',
    baseUrl: undefined,
    debug: false,
    provider: 'anthropic',
    ...over,
  });

  it('只钉 baseUrl', () => {
    const out = applyManagedGateway(base(), { baseUrl: 'https://gw.example.com' });
    expect(out.config.baseUrl).toBe('https://gw.example.com');
    expect(out.config.model).toBe('claude-sonnet-5-5');
    expect(out.pinned).toEqual(['baseUrl']);
  });

  it('只钉 model', () => {
    const out = applyManagedGateway(base(), { model: 'gw-model' });
    expect(out.config.model).toBe('gw-model');
    expect(out.pinned).toEqual(['model']);
  });

  it('两个都钉 —— 顺序稳定（baseUrl 在前）', () => {
    const out = applyManagedGateway(base(), { baseUrl: 'https://gw.example.com', model: 'gw-model' });
    expect(out.pinned).toEqual(['baseUrl', 'model']);
  });

  it('什么都没钉 → 原样返回，不出声', () => {
    const before = base();
    const out = applyManagedGateway(before, {});
    expect(out.config).toEqual(before);
    expect(out.pinned).toEqual([]);
  });

  it('值本来就一样 → **不算被改**（每次启动吼一遍只会训练人忽略它）', () => {
    const out = applyManagedGateway(base({ baseUrl: 'https://gw.example.com' }), {
      baseUrl: 'https://gw.example.com',
    });
    expect(out.pinned).toEqual([]);
  });

  it('凭据一个字都不碰 —— 托管层钉的是端点，不是钥匙', () => {
    const out = applyManagedGateway(base(), { baseUrl: 'https://gw.example.com', model: 'gw-model' });
    expect(out.config.apiKey).toBe('sk-test');
  });

  it('不改原对象（纯函数）', () => {
    const before = base();
    applyManagedGateway(before, { baseUrl: 'https://gw.example.com' });
    expect(before.baseUrl).toBe(undefined);
  });
});

// 这一段只为钉住一件事：`resolvePolicy` 的返回里**没有**别的地方能供出 gateway。
describe('gateway 的出口只有一处', () => {
  it('五个源都在 policy.sources 里，但 gateway 只有一个值', async () => {
    const { policy } = await load({
      [MANAGED]: block({ baseUrl: 'https://gw.example.com' }),
    });
    const sources: readonly SettingsSource[] = policy.sources.map((s) => s.source);
    expect(sources).toEqual(['user', 'project', 'local', 'flag', 'policy']);
    expect(policy.sources.every((s) => !('gateway' in s))).toBe(true);
  });
});
