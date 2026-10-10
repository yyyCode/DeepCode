import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defaultManagedPath,
  defaultTextReader,
  resolvePolicy,
  type ResolvedPolicy,
  type ResolvePolicyDeps,
  type SettingsSource,
  type TextReader,
} from '../src/cli/settings';

const HOME = '/home/u';
const ROOT = '/proj';
// 期望值也用 join/resolve 算：跑测试的机器可能是 Windows，硬写正斜杠会红。
const USER = join(HOME, '.deepcode', 'settings.json');
const PROJECT = join(ROOT, '.deepcode', 'settings.json');
const LOCAL = join(ROOT, '.deepcode', 'settings.local.json');
const FLAG = resolve('/tmp/flag.json');
const MANAGED = resolve('/managed/managed-settings.json');

/** 一张路径 → 内容的表。没列到的路径 = 文件不存在（返回 undefined）。 */
function files(table: Record<string, string>): TextReader {
  return async (path) => table[path];
}

type LoadOptions = Omit<ResolvePolicyDeps, 'home' | 'root' | 'managedPath' | 'warn' | 'readText'>;

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

const info = (policy: ResolvedPolicy, source: SettingsSource) =>
  policy.sources.find((s) => s.source === source);

describe('五层来源', () => {
  it('五个源各自的路径与状态', async () => {
    const { policy } = await load({
      [USER]: '{"permissions":{"allow":["Read"]}}',
      [LOCAL]: '{"permissions":{"deny":["Bash(git push:*)"]}}',
    });

    expect(policy.sources.map((s) => [s.source, s.path, s.state])).toEqual([
      ['user', USER, 'ok'],
      ['project', PROJECT, 'missing'],
      ['local', LOCAL, 'ok'],
      ['flag', undefined, 'missing'],
      ['policy', MANAGED, 'missing'],
    ]);
  });

  it('--settings=<路径> 让 flag 层活起来，相对路径按 cwd 解析', async () => {
    const { policy } = await load({ [FLAG]: '{"permissions":{"deny":["WebSearch"]}}' }, {
      settingsPath: '/tmp/flag.json',
    });

    expect(info(policy, 'flag')).toMatchObject({ path: FLAG, state: 'ok' });
    expect(info(policy, 'flag')?.counts.deny).toBe(1);
  });

  it('policyRules 只来自 policy，personalRules 是其余四源的并集', async () => {
    const { policy } = await load(
      {
        [USER]: '{"permissions":{"allow":["Read"]}}',
        [PROJECT]: '{"permissions":{"ask":["Bash"]}}',
        [LOCAL]: '{"permissions":{"deny":["WebSearch"]}}',
        [FLAG]: '{"permissions":{"allow":["Glob"]}}',
        [MANAGED]: '{"permissions":{"deny":["Bash(git push:*)"]}}',
      },
      { settingsPath: '/tmp/flag.json' },
    );

    expect(policy.policyRules.map((r) => r.raw)).toEqual(['Bash(git push:*)']);
    expect(policy.personalRules.map((r) => r.raw).sort()).toEqual(['Bash', 'Glob', 'Read', 'WebSearch']);
  });

  it('缺 permissions 键 = 那一层为空，不算坏', async () => {
    const { policy, warnings } = await load({ [USER]: '{"别的":1}' });
    expect(info(policy, 'user')?.state).toBe('ok');
    expect(info(policy, 'user')?.counts).toEqual({ allow: 0, ask: 0, deny: 0 });
    expect(warnings.join('\n')).toContain('别的');
  });
});

describe('坏输入：每一类的去向', () => {
  it('文件不存在 = 那一层为空，一个字都不吭', async () => {
    const { policy, warnings } = await load({});
    expect(warnings).toEqual([]);
    expect(policy.personalRules).toEqual([]);
    expect(policy.policyRules).toEqual([]);
  });

  it('JSON 语法错 → 点名警告 + 跳过该文件，其余层照常', async () => {
    const { policy, warnings } = await load({
      [USER]: '{ 这不是 json',
      [LOCAL]: '{"permissions":{"deny":["Bash"]}}',
    });

    expect(info(policy, 'user')?.state).toBe('broken');
    expect(warnings.join('\n')).toContain(USER);
    expect(policy.personalRules.map((r) => r.raw)).toEqual(['Bash']);
  });

  it('顶层不是对象 → broken', async () => {
    const { policy } = await load({ [USER]: '[1,2,3]' });
    expect(info(policy, 'user')?.state).toBe('broken');
  });

  it('permissions 不是对象 → broken', async () => {
    const { policy } = await load({ [USER]: '{"permissions":"Bash"}' });
    expect(info(policy, 'user')?.state).toBe('broken');
    expect(policy.personalRules).toEqual([]);
  });

  it('permissions.deny 不是数组 → 整份文件跳过，不能只丢一半', async () => {
    const { policy, warnings } = await load({
      [USER]: '{"permissions":{"allow":["Read"],"deny":"Bash"}}',
    });

    expect(info(policy, 'user')?.state).toBe('broken');
    // 同一份文件里那三条本来好好的 allow 也一并作废：类型不对说明写的人
    // 以为它生效了，只丢一半的话他会看到"文件读进去了"，然后以为没报错的在管事。
    expect(info(policy, 'user')?.counts.allow).toBe(0);
    expect(policy.personalRules).toEqual([]);
    expect(warnings.join('\n')).toContain('permissions.deny');
  });

  it('元素不是字符串 → 整份文件跳过', async () => {
    const { policy, warnings } = await load({ [USER]: '{"permissions":{"deny":["Bash",7]}}' });
    expect(info(policy, 'user')?.state).toBe('broken');
    expect(warnings.join('\n')).toContain('permissions.deny[1]');
  });

  it('单条规则解析失败 → 该条不生效，其余照常，警告带原文与原因', async () => {
    const { policy, warnings } = await load({
      [USER]: '{"permissions":{"deny":["Bash(git push","WebSearch"]}}',
    });

    expect(info(policy, 'user')?.state).toBe('ok');
    expect(info(policy, 'user')?.counts.deny).toBe(1);
    expect(policy.personalRules.map((r) => r.raw)).toEqual(['WebSearch']);
    expect(info(policy, 'user')?.problems.join('\n')).toContain('Bash(git push');
    expect(warnings.join('\n')).toContain('Bash(git push');
  });

  it('其它工具带括号的规则：警告一次、不生效（它永远也命中不了）', async () => {
    const { policy, warnings } = await load({ [USER]: '{"permissions":{"deny":["Grep(rm -rf)"]}}' });

    expect(info(policy, 'user')?.state).toBe('ok');
    expect(info(policy, 'user')?.counts.deny).toBe(0);
    expect(policy.personalRules).toEqual([]);
    expect(warnings.join('\n')).toContain('Grep(rm -rf)');
  });

  it('不认识的顶层键只警告，不致命', async () => {
    const { policy, warnings } = await load({ [USER]: '{"hooks":{},"permissions":{"allow":["Read"]}}' });
    expect(info(policy, 'user')?.state).toBe('ok');
    expect(policy.personalRules.map((r) => r.raw)).toEqual(['Read']);
    expect(warnings.join('\n')).toContain('hooks');
  });
});

describe('托管策略：本设计唯一一条真正的 fail-open', () => {
  it('存在但读不了 → 大声警告 + policy 层为空', async () => {
    const warnings: string[] = [];
    const policy = await resolvePolicy({
      home: HOME,
      root: ROOT,
      managedPath: MANAGED,
      readText: async (path) => {
        if (path === MANAGED) throw new Error('EACCES: permission denied');
        return undefined;
      },
      warn: (line) => warnings.push(line),
    });

    expect(info(policy, 'policy')).toMatchObject({ state: 'broken' });
    expect(policy.policyRules).toEqual([]);
    expect(warnings.join('\n')).toContain(MANAGED);
    expect(warnings.join('\n')).toContain('⚠️');
  });

  it('解析失败同样：空 policy + 警告', async () => {
    const { policy, warnings } = await load({ [MANAGED]: '{ 坏' });
    expect(info(policy, 'policy')?.state).toBe('broken');
    expect(policy.policyRules).toEqual([]);
    expect(warnings.join('\n')).toContain(MANAGED);
  });

  it('不存在 → 静默为空，一个字都不吭', async () => {
    const { policy, warnings } = await load({});
    expect(info(policy, 'policy')?.state).toBe('missing');
    expect(warnings).toEqual([]);
  });
});

describe('defaultTextReader：真实 IO 的那条分界线', () => {
  // 上面每个用例都注入了假的 readText，所以这一小段真实实现此前一直没人碰过。
  //
  // ⚠️ 老实说：这三条**钉不住**那次修改。它曾经写成 `if (!existsSync(path)) return undefined`，
  // 而出问题的那类输入是"文件在、stat 却被拒"（EACCES / ELOOP）—— existsSync 把它报成
  // "没这个文件"，于是"存在但读不了必须吼出来"这条承诺被反转，整层静默作废。
  // 这类路径没法在 Windows 上可移植地造出来（符号链接要管理员权限），所以改法是
  // "按构造正确"而不是"按测试正确"：直接 readFile、只认 ENOENT。
  // 留着这几条是为了锁住契约的两个方向 —— 它们将来会挡住把实现改回"猜文件在不在"的手。
  it('真的存在且可读 → 返回内容', async () => {
    expect(await defaultTextReader(fileURLToPath(import.meta.url))).toContain('defaultTextReader');
  });

  it('不存在 → undefined，这是正常情形（绝大多数机器没有托管文件）', async () => {
    const missing = join(process.cwd(), '肯定没有这个目录', 'settings.json');
    expect(await defaultTextReader(missing)).toBe(undefined);
  });

  it('存在但是个目录 → 抛，而不是伪装成"没这个文件"', async () => {
    // 读目录在 POSIX 与 Windows 上都是 EISDIR。断言宽松到只要求"抛"，不钉错误码。
    await expect(defaultTextReader(process.cwd())).rejects.toThrow();
  });
});

describe('defaultManagedPath', () => {
  it('Windows 用 %ProgramFiles%\\DeepCode\\managed-settings.json', () => {
    expect(defaultManagedPath({ ProgramFiles: 'D:\\Apps' }, 'win32')).toBe(
      join('D:\\Apps', 'DeepCode', 'managed-settings.json'),
    );
  });

  it('Windows 没有 %ProgramFiles% 时退回 C:\\Program Files', () => {
    expect(defaultManagedPath({}, 'win32')).toContain('DeepCode');
  });

  it('其它平台 /etc/deepcode/managed-settings.json', () => {
    expect(defaultManagedPath({}, 'linux')).toBe('/etc/deepcode/managed-settings.json');
  });
});
