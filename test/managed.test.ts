import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGED_ENV, readManagedSettings, type ManagedRun } from '../src/cli/managed';
import { parsePlist } from '../src/cli/managed-plist';
import { parseRegistryQuery } from '../src/cli/managed-registry';
import { resolvePolicy, type ResolvedPolicy, type TextReader } from '../src/cli/settings';

/**
 * 托管推送的三条通道（P5d）。
 *
 * 判据来自 P5 总纲 §6.1：**三个通道各给一份夹具（不是真机）→ 解析出来的策略与文件通道
 * 逐字节相同**。—— 所以这个文件里没有一台真 Mac，也没有一台入域的 Windows。
 * "这台机器是哪个平台"在这里只是一个参数（`platform`），命令执行器是注入的（`run`）。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'managed');

const JSON_TEXT = await readFile(join(FIXTURES, 'policy.json'), 'utf8');
const PLIST_TEXT = await readFile(join(FIXTURES, 'policy.plist.xml'), 'utf8');
const REG_TEXT = await readFile(join(FIXTURES, 'policy.reg.txt'), 'utf8');

/** 那条"同一份策略"长什么样 —— 三份夹具都得给出它。 */
const POLICY = {
  permissions: { deny: ['Bash(git push:*)'] },
  telemetry: { enabled: false },
  instructions: { text: '所有改动都要跑测试', files: ['/etc/deepcode/policy.md'] },
};

/** 一条命令执行器：把某个程序名映射到一段夹具输出。别的程序一律"没有"。 */
function runner(table: Record<string, string>): ManagedRun {
  return async (file) => table[file];
}

const NO_RUN: ManagedRun = async () => undefined;

describe('parsePlist：macOS 托管偏好域', () => {
  it('三份夹具说的是同一件事', () => {
    expect(parsePlist(PLIST_TEXT)).toEqual(POLICY);
    expect(parseRegistryQuery(REG_TEXT)).toEqual(POLICY);
    expect(JSON.parse(JSON_TEXT)).toEqual(POLICY);
  });

  it('整数、真假、空串、实体与 <plist> 外壳之外的顶层值', () => {
    expect(parsePlist('<integer>42</integer>')).toBe(42);
    expect(parsePlist('<real>0.5</real>')).toBe(0.5);
    expect(parsePlist('<true/>')).toBe(true);
    expect(parsePlist('<string></string>')).toBe('');
    expect(parsePlist('<string/>')).toBe('');
    // `&amp;` 要**最后**解 —— 反过来的话 `&amp;lt;` 会被解成一个 `<`。
    expect(parsePlist('<string>a&amp;lt;b&lt;c</string>')).toBe('a&lt;b<c');
  });

  it('切了一半的 <dict> 抛错，不是安静地少读一块', () => {
    const half = PLIST_TEXT.replace('</dict>\n</plist>', '</plist>');
    expect(() => parsePlist(half)).toThrow(/dict/);
  });

  it('不认识的标签抛错', () => {
    expect(() => parsePlist('<plist><weird/></plist>')).toThrow(/不认识的标签/);
  });

  it('dict 里重复的键抛错 —— 两份策略抢同一个键，安静地取一个最坏', () => {
    expect(() => parsePlist('<dict><key>a</key><string>x</string><key>a</key><string>y</string></dict>'))
      .toThrow(/重复的键/);
  });
});

describe('parseRegistryQuery：Windows 注册表', () => {
  it('没有那个键 → undefined，不是空对象', () => {
    // 真机上 `reg query` 找不到键时是"非零退出 + 一句中文提示"；这里给出的是
    // "只有键名行"那种更宽松的输入，它同样必须是 undefined。
    expect(parseRegistryQuery('HKEY_LOCAL_MACHINE\\SOFTWARE\\DeepCode\n')).toBe(undefined);
    expect(parseRegistryQuery('')).toBe(undefined);
  });

  it('类型映射：DWORD 是数、多字符串是数组、SZ 的 true/false 是布尔', () => {
    const out = parseRegistryQuery(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\DeepCode',
        '    a.count    REG_DWORD    0x1f',
        '    a.ratio    REG_QWORD    7',
        '    b.list    REG_MULTI_SZ    x\\0y',
        '    c.flag    REG_SZ    TRUE',
      ].join('\n'),
    );
    expect(out).toEqual({ a: { count: 31, ratio: 7 }, b: { list: ['x', 'y'] }, c: { flag: true } });
  });

  it('同名多行（老版 reg query 打多字符串的样子）合成一个数组', () => {
    const out = parseRegistryQuery(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\DeepCode',
        '    permissions.deny    REG_MULTI_SZ    a',
        '    permissions.deny    REG_MULTI_SZ    b',
      ].join('\n'),
    );
    expect(out).toEqual({ permissions: { deny: ['a', 'b'] } });
  });

  it('标量与路径抢同一个键 → 抛错', () => {
    const text = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\DeepCode',
      '    sandbox    REG_SZ    yes',
      '    sandbox.enabled    REG_DWORD    1',
    ].join('\n');
    expect(() => parseRegistryQuery(text)).toThrow(/抢同一个键/);
  });

  it('读不懂的一行 → 抛错，不悄悄跳过', () => {
    expect(() => parseRegistryQuery('HKEY_LOCAL_MACHINE\\SOFTWARE\\DeepCode\n    乱七八糟一行\n')).toThrow(
      /读不懂/,
    );
  });
});

describe('readManagedSettings：通道表', () => {
  it('三个通道给出**同一段** JSON 文本（不是"深比较相等"）', async () => {
    const viaRegistry = await readManagedSettings({
      env: {},
      platform: 'win32',
      run: runner({ reg: REG_TEXT }),
      readText: async () => undefined,
    });
    const viaPlist = await readManagedSettings({
      env: {},
      platform: 'darwin',
      run: runner({ defaults: PLIST_TEXT }),
      readText: async () => undefined,
    });

    expect(viaRegistry?.where).toContain('注册表');
    expect(viaPlist?.where).toContain('偏好域');
    // ⚠️ 这两条是**字面**同一条字符串 —— 归一发生在文本层（见 managed.ts 顶部那段）。
    // 文件通道给的是原文，不重新序列化（那份文本可能是缩进过的，也可能语法就是错的，
    // 而"语法错"必须留给 readLayer 去吼）。所以这里比的是两个"解析过再序列化"的通道，
    // 文件通道的一致性由下面那条端到端的断言盖住。
    expect(viaRegistry?.text).toBe(viaPlist?.text);
    expect(JSON.parse(viaRegistry?.text ?? '')).toEqual(POLICY);
  });

  it(`${MANAGED_ENV} 压过平台通道`, async () => {
    const found = await readManagedSettings({
      env: { [MANAGED_ENV]: '/managed/override.json' },
      platform: 'win32',
      run: runner({ reg: REG_TEXT }),
      readText: async (path) => (path === '/managed/override.json' ? JSON_TEXT : undefined),
    });
    expect(found?.where).toContain(MANAGED_ENV);
    expect(JSON.parse(found?.text ?? '')).toEqual(POLICY);
  });

  it('没有配 MDM 的机器 → undefined（三条通道都空）', async () => {
    const found = await readManagedSettings({
      env: {},
      platform: 'win32',
      run: NO_RUN,
      readText: async () => undefined,
    });
    expect(found).toBe(undefined);
  });

  it('给了 path 就**只**读它，不落到通道表', async () => {
    const found = await readManagedSettings({
      path: '/only/this.json',
      env: { [MANAGED_ENV]: '/ignored.json' },
      platform: 'win32',
      run: runner({ reg: REG_TEXT }),
      readText: async (p) => (p === '/only/this.json' ? JSON_TEXT : undefined),
    });
    expect(found?.where).toBe('/only/this.json');
  });
});

describe('三通道进 resolvePolicy：策略逐项相同', () => {
  const HOME = '/home/u';
  const ROOT = '/proj';

  /** 一张"路径 → 内容"的表。没列到的路径 = 文件不存在。 */
  const files = (table: Record<string, string>): TextReader => async (path) => table[path];

  const policyLayer = (policy: ResolvedPolicy) => policy.sources.find((s) => s.source === 'policy');

  async function viaPlatform(platform: string, run: ManagedRun): Promise<ResolvedPolicy> {
    return resolvePolicy({ home: HOME, root: ROOT, env: {}, platform, run, readText: files({}) });
  }

  it('注册表 / 偏好域 / 文件：收下的规则、计数、遥测、指令全都一样', async () => {
    const registry = await viaPlatform('win32', runner({ reg: REG_TEXT }));
    const plist = await viaPlatform('darwin', runner({ defaults: PLIST_TEXT }));
    const file = await resolvePolicy({
      home: HOME,
      root: ROOT,
      env: {},
      // Linux/兜底那条：平台通道都没有 → 读默认文件。
      platform: 'linux',
      run: NO_RUN,
      readText: files({ '/etc/deepcode/managed-settings.json': JSON_TEXT }),
    });

    // 三份在**内容**上必须一模一样。`where` 不同 —— 那正是我们想看见的区别。
    const shape = (policy: ResolvedPolicy) => ({
      rules: policy.policyRules,
      counts: policyLayer(policy)?.counts,
      state: policyLayer(policy)?.state,
      telemetry: policy.telemetry,
      instructions: policy.instructions.map((item) => item.text),
      sandbox: policy.sandbox,
    });
    expect(shape(registry)).toEqual(shape(file));
    expect(shape(plist)).toEqual(shape(file));

    expect(policyLayer(registry)?.path).toContain('注册表');
    expect(policyLayer(plist)?.path).toContain('偏好域');
    expect(policyLayer(file)?.path).toBe('/etc/deepcode/managed-settings.json');

    // 顺带钉住那条规则真的进来了（不是"三份都空"也算相等）。
    expect(registry.policyRules.some((rule) => rule.decision === 'deny')).toBe(true);
    expect(registry.telemetry).toEqual({ enabled: false, why: expect.any(String) });
  });

  it('托管那一层读得动但读不懂 → 吼一声、按空处理、照旧启动（唯一的 fail-open）', async () => {
    const warnings: string[] = [];
    const policy = await resolvePolicy({
      home: HOME,
      root: ROOT,
      env: {},
      platform: 'win32',
      run: runner({ reg: '    乱七八糟一行' }),
      readText: files({}),
      warn: (line) => warnings.push(line),
    });

    // 解析器的异常在 `managed.ts` 里**原样抛出去**（那里不许安静地当它是空的），
    // 由 `resolvePolicy` 接住 —— 一行配错的托管策略绝不能把 CLI 弄得起不来。
    expect(policyLayer(policy)?.state).toBe('broken');
    expect(policy.policyRules).toEqual([]);
    expect(warnings.join('\n')).toContain('读不懂');
    expect(warnings.join('\n')).toContain('⚠️');
  });
});
