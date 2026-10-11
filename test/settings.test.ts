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

// `readText` 留在里面：传了它就盖掉上面那张路径表 ——
// "托管设置自己读得动、它点名要的那份读不动"这种用例只能这么造。
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

describe('沙箱块', () => {
  const block = (json: unknown): string => JSON.stringify({ sandbox: json });

  it('默认：关着，规则一条都没有', async () => {
    const { policy } = await load({});
    expect(policy.sandbox).toEqual({ enabled: false, deny: [], allow: [] });
  });

  it('`deny` 各层取并集，`allow` 只认托管层', async () => {
    const { policy, warnings } = await load({
      [USER]: block({ enabled: true, paths: { deny: ['~/.ssh/**'], allow: ['/home/u/**'] } }),
      [MANAGED]: block({ paths: { deny: ['/etc/**'], allow: ['/srv/**'] } }),
    });

    expect(policy.sandbox.enabled).toBe(true);
    expect(policy.sandbox.deny.map((rule) => rule.raw)).toEqual(['~/.ssh/**', '/etc/**']);
    expect(policy.sandbox.allow.map((rule) => rule.raw)).toEqual(['/srv/**']);
    // 丢掉必须有声 —— 静默丢掉一份白名单比拒收更坏。
    expect(warnings.join('\n')).toContain('白名单只有托管层能设');
  });

  it('`enabled` 是各层的**或** —— 个人能开，但关不掉托管开的闸', async () => {
    const opened = await load({ [USER]: block({ enabled: true }) });
    expect(opened.policy.sandbox.enabled).toBe(true);

    const forced = await load({
      [USER]: block({ enabled: false }),
      [MANAGED]: block({ enabled: true }),
    });
    expect(forced.policy.sandbox.enabled).toBe(true);
  });

  it('相对路径的规则被拒收并出声（判定的候选一律是绝对路径）', async () => {
    const { policy, warnings } = await load({
      [USER]: block({ enabled: true, paths: { deny: ['out.txt'] } }),
    });
    expect(policy.sandbox.deny).toEqual([]);
    expect(warnings.join('\n')).toContain('不是绝对路径');
  });

  it('形状写坏：**整块忽略** + 警告，不猜一个更严的', async () => {
    const { policy, warnings } = await load({ [USER]: block({ enabled: 'yes' }) });
    expect(policy.sandbox).toEqual({ enabled: false, deny: [], allow: [] });
    expect(warnings.join('\n')).toContain('sandbox 块整块忽略');

    const broken = await load({ [USER]: block({ paths: { deny: 'x' } }) });
    expect(broken.policy.sandbox.deny).toEqual([]);
    expect(broken.warnings.join('\n')).toContain('sandbox 块整块忽略');
  });

  it('`sandbox` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [USER]: block({ enabled: true }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });

  it('规则用 `~` 与反斜杠写，归一后与权限链同形', async () => {
    const { policy } = await load({
      [USER]: block({ enabled: true, paths: { deny: ['~\\SSH\\**'] } }),
    });
    expect(policy.sandbox.deny[0]?.content).toBe(`${HOME}/SSH/**`.replace(/\\/g, '/'));
  });
});

describe('压缩块', () => {
  const block = (json: unknown): string => JSON.stringify({ compact: json });

  it('默认：自动关、阈值 100_000、保留 6 轮', async () => {
    const { policy } = await load({});
    expect(policy.compact).toEqual({ auto: false, atTokens: 100_000, keepTurns: 6 });
  });

  it('后读到的覆盖先读到的（user → project → local → flag → policy）', async () => {
    const { policy } = await load({
      [USER]: block({ auto: false, keepTurns: 10 }),
      [PROJECT]: block({ keepTurns: 4, atTokens: 5_000 }),
    });
    expect(policy.compact).toEqual({ auto: false, atTokens: 5_000, keepTurns: 4 });
  });

  it('字段级降级：类型不对只用默认值 + 出声，不整块丢', async () => {
    const { policy, warnings } = await load({
      [USER]: block({ auto: 'true', atTokens: 0, keepTurns: 1.5 }),
    });
    expect(policy.compact).toEqual({ auto: false, atTokens: 100_000, keepTurns: 6 });
    expect(warnings.join('\n')).toContain('compact.auto 不是布尔值');
    expect(warnings.join('\n')).toContain('compact.atTokens 不是正整数');
    expect(warnings.join('\n')).toContain('compact.keepTurns 不是正整数');
  });

  it('`compact` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [USER]: block({ auto: true }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });
});

describe('遥测开关', () => {
  const block = (json: unknown): string => JSON.stringify({ telemetry: json });

  it('谁都没写 → 关，且 why 说得清是"没有哪一层说要开"', async () => {
    const { policy } = await load({});
    expect(policy.telemetry).toEqual({ enabled: false, why: '默认关（没有哪一层说要开）' });
  });

  it('用户层 true → 开', async () => {
    const { policy } = await load({ [USER]: block({ enabled: true }) });
    expect(policy.telemetry).toEqual({ enabled: true, why: '用户层开了' });
  });

  it('**托管层能一句话把它关掉**，压过用户层的 true', async () => {
    const { policy } = await load({
      [USER]: block({ enabled: true }),
      [MANAGED]: block({ enabled: false }),
    });
    expect(policy.telemetry.enabled).toBe(false);
    expect(policy.telemetry.why).toContain('托管层');
  });

  it('托管层写 true 也开不起来 —— 它管不了你开不开', async () => {
    const { policy } = await load({ [MANAGED]: block({ enabled: true }) });
    expect(policy.telemetry).toEqual({ enabled: false, why: '默认关（没有哪一层说要开）' });
  });

  it.each([
    ['project', PROJECT],
    ['local', LOCAL],
    ['flag', FLAG],
  ])('%s 层写 true → 丢掉 + 出声（别人仓库的一份文件不该替你按下开关）', async (_name, path) => {
    const { policy, warnings } = await load(
      { [path]: block({ enabled: true }) },
      { settingsPath: '/tmp/flag.json' },
    );
    expect(policy.telemetry.enabled).toBe(false);
    expect(warnings.join('\n')).toContain('只有用户层能开遥测');
  });

  it('telemetry 不是对象 → 整块忽略 + 出声', async () => {
    const { policy, warnings } = await load({ [USER]: block(true) });
    expect(policy.telemetry.enabled).toBe(false);
    expect(warnings.join('\n')).toContain('telemetry 块整块忽略');
  });

  it('enabled 不是布尔 → 按没写处理 + 出声（不是整块忽略这一层）', async () => {
    const { policy, warnings } = await load({ [USER]: block({ enabled: 'true' }) });
    expect(policy.telemetry.enabled).toBe(false);
    expect(warnings.join('\n')).toContain('telemetry.enabled 不是布尔值');
  });

  it('类型写错时不该连坐成"你这一层不算数" —— 那两句话说的是两件事', async () => {
    // project 层写了 `enabled: "yes"`，警告里只该有"类型不对"这一句：
    // 说成"只有用户层能开"会让人以为把值写对了就能生效。
    const { warnings } = await load({ [PROJECT]: block({ enabled: 'yes' }) });
    expect(warnings.join('\n')).toContain('不是布尔值');
    expect(warnings.join('\n')).not.toContain('只有用户层能开遥测');
  });

  it('不认识的子键只警告，开关照常生效', async () => {
    const { policy, warnings } = await load({ [USER]: block({ enabled: true, endpoint: 'x' }) });
    expect(policy.telemetry.enabled).toBe(true);
    expect(warnings.join('\n')).toContain('不认识的子键');
  });

  it('`telemetry` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [USER]: block({ enabled: true }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });
});

/**
 * P5b：托管层下发指令。
 *
 * 这一段的判据只有一条，但那条是全部：**只有托管层能写**。
 * 其余四层写了要"被忽略并告知已丢弃" —— 这就是设计 §4.2 那句
 * "把 managed 那一份写进个人规则里想覆盖它"的落法，与 `sandbox.paths.allow`
 * （只有托管层能设）、`telemetry`（只有用户层能开）同一条规矩。
 */
describe('instructions 段：只有托管层能下发', () => {
  const MANAGED_INSTRUCTION_FILE = resolve('/managed/policy.md');
  const block = (value: unknown): string => JSON.stringify({ instructions: value });

  it('托管层写 text + files → 收下两条，text 在前、files 按给的顺序，label 是出处', async () => {
    const { policy, warnings } = await load({
      [MANAGED]: block({ text: '组织的话', files: [MANAGED_INSTRUCTION_FILE] }),
      [MANAGED_INSTRUCTION_FILE]: '文件里的话',
    });

    expect(policy.instructions).toEqual([
      { label: `${MANAGED} 内嵌的 instructions.text`, text: '组织的话' },
      { label: MANAGED_INSTRUCTION_FILE, text: '文件里的话' },
    ]);
    // 正常路径上一个字都不多说 —— 与"遥测关着的时候零输出"同一条口径。
    expect(warnings).toEqual([]);
  });

  it('`instructions` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [MANAGED]: block({ text: 'x' }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });

  it('其余四层写了 → 整项丢弃 + 出声（判词点明只有托管层能下发）', async () => {
    for (const path of [USER, PROJECT, LOCAL]) {
      const { policy, warnings } = await load({ [path]: block({ text: '个人想覆盖的话' }) });
      expect(policy.instructions).toEqual([]);
      expect(warnings.join('\n')).toContain('只有托管层能下发指令');
      expect(warnings.join('\n')).toContain('这一份已丢弃');
    }
    // flag 层（`--settings=`）也一起钉住：它同样只是"个人"的另一种写法。
    const flag = await load({ [FLAG]: block({ text: 'x' }) }, { settingsPath: FLAG });
    expect(flag.policy.instructions).toEqual([]);
    expect(flag.warnings.join('\n')).toContain('只有托管层能下发指令');
  });

  it('一份**只写了 instructions**、没有 permissions 的托管设置照样收得下', async () => {
    // 早期 return 那个坑：`plugins` / `sandbox` / `telemetry` 都在它之前解析过，
    // 这一块也必须在之前。而"组织只下发了一段话"恰恰是最典型的那一种托管设置。
    const { policy } = await load({ [MANAGED]: block({ text: '只有这一段的托管文件' }) });
    expect(policy.instructions).toHaveLength(1);
    expect(policy.instructions[0]?.text).toBe('只有这一段的托管文件');
  });

  it('点名要的文件不存在 → 出声（含那个路径）、跳过这一段，别的照收', async () => {
    const missing = resolve('/managed/nope.md');
    const { policy, warnings } = await load({
      [MANAGED]: block({ text: '照收的话', files: [missing] }),
    });
    expect(policy.instructions).toEqual([
      { label: `${MANAGED} 内嵌的 instructions.text`, text: '照收的话' },
    ]);
    expect(warnings.join('\n')).toContain(missing);
    expect(warnings.join('\n')).toContain('不存在');
  });

  it('点名要的文件读不动（抛）→ 出声、跳过，resolvePolicy 照旧返回', async () => {
    // 与 `defaultTextReader` 那条 fail-open 同一个方向：**吼一声，但照旧往下走**。
    // 一行配错的托管配置不该让 CLI 起不来。
    const locked = resolve('/managed/locked.md');
    const settings = block({ files: [locked] });
    const { policy, warnings } = await load(
      { [MANAGED]: settings },
      {
        // 托管设置文件自己读得动，**它点名要的那份**读不动。
        readText: async (path) => {
          if (path === MANAGED) return settings;
          if (path === locked) throw new Error('EACCES: 读不动');
          return undefined;
        },
      },
    );
    expect(policy.instructions).toEqual([]);
    expect(warnings.join('\n')).toContain('读不了');
    expect(warnings.join('\n')).toContain('EACCES');
  });

  it('text 空串 / 不是字符串 → 忽略并出声；files 不是字符串数组 → 整项忽略', async () => {
    const empty = await load({ [MANAGED]: block({ text: '   ' }) });
    expect(empty.policy.instructions).toEqual([]);
    expect(empty.warnings.join('\n')).toContain('是空的');

    const wrongType = await load({ [MANAGED]: block({ text: 42 }) });
    expect(wrongType.policy.instructions).toEqual([]);
    expect(wrongType.warnings.join('\n')).toContain('不是字符串');

    const badFiles = await load({ [MANAGED]: block({ text: '留着', files: 'a.md' }) });
    expect(badFiles.policy.instructions).toEqual([
      { label: `${MANAGED} 内嵌的 instructions.text`, text: '留着' },
    ]);
    expect(badFiles.warnings.join('\n')).toContain('不是字符串数组');

    const badItem = await load({ [MANAGED]: block({ files: ['a.md', 7] }) });
    expect(badItem.policy.instructions).toEqual([]);
    expect(badItem.warnings.join('\n')).toContain('不是字符串数组');
  });

  it('instructions 块不是一个对象 / 有不认识的子键 → 整块忽略 + 出声', async () => {
    const notObject = await load({ [MANAGED]: block([1, 2]) });
    expect(notObject.policy.instructions).toEqual([]);
    expect(notObject.warnings.join('\n')).toContain('instructions 块整块忽略');

    const unknownKey = await load({ [MANAGED]: block({ text: 'x', 语气: '严厉' }) });
    expect(unknownKey.policy.instructions).toHaveLength(1);
    expect(unknownKey.warnings.join('\n')).toContain('不认识的子键');
  });
});
