import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPluginName } from '@deepcode/contract/plugin-manifest';
import { resolvePolicy } from '@deepcode/cli/settings';

const HOME = '/home/u';
const ROOT = '/w';

/** 一张 路径 → 内容 的表。没列到的路径 = 不存在。 */
function reader(files: Record<string, string>) {
  return async (path: string): Promise<string | undefined> => files[path];
}

// 期望值用 join 算，不硬写正斜杠：`resolvePolicy` 内部是 join，跑测试的机器是
// Windows 时拼出来是反斜杠，硬写的表会全部查不中（表现是"一遍静默"，很难看出来）。
const PATHS = {
  user: join(HOME, '.deepcode', 'settings.json'),
  project: join(ROOT, '.deepcode', 'settings.json'),
  local: join(ROOT, '.deepcode', 'settings.local.json'),
} as const;

async function run(files: Record<string, string>, managed?: string) {
  const warnings: string[] = [];
  const policy = await resolvePolicy({
    home: HOME,
    root: ROOT,
    managedPath: managed ?? '/nonexistent/managed.json',
    readText: reader(files),
    warn: (line) => warnings.push(line),
  });
  return { policy, warnings: warnings.join('\n') };
}

describe('isPluginName', () => {
  it.each(['todo', 'secret-guard', 'a1-b2'])('%j 合法', (name) => {
    expect(isPluginName(name)).toBe(true);
  });
  it.each(['', 'Todo', 'a_b', '-a', 'a-', 'x'.repeat(65)])('%j 非法', (name) => {
    expect(isPluginName(name)).toBe(false);
  });
});

describe('plugins 的五层合并', () => {
  it('deny 取五层并集 —— 不看来源优先级，它只能关掉东西', async () => {
    const { policy } = await run(
      {
        [PATHS.user]: JSON.stringify({ plugins: { deny: ['a'] } }),
        [PATHS.local]: JSON.stringify({ plugins: { deny: ['b'] } }),
      },
      '/managed.json',
    );
    // 托管文件读不到（readText 返回 undefined）→ 那一层是 missing，不参与。
    expect(policy.plugins.deny.map((r) => [r.name, r.source])).toEqual([
      ['a', 'user'],
      ['b', 'local'],
    ]);
  });

  it('enable 只认 project / local / flag', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['from-project'] } }),
      [PATHS.local]: JSON.stringify({ plugins: { enable: ['from-local'] } }),
    });
    expect(policy.plugins.enable.map((r) => [r.name, r.source])).toEqual([
      ['from-project', 'project'],
      ['from-local', 'local'],
    ]);
  });

  it('user 层写 enable 不生效，且出声', async () => {
    const { policy, warnings } = await run({
      [PATHS.user]: JSON.stringify({ plugins: { enable: ['nope'] } }),
    });
    expect(policy.plugins.enable).toEqual([]);
    expect(warnings).toContain('plugins.enable 不认 user 层');
  });

  it('policy 层写 enable 也不生效，且出声 —— 托管策略只该能收紧，不该替你打开插件', async () => {
    // 这条与上一条共用一个 `if`，但**只有上一条被测过**：C3 的变异（把那个分支整个
    // 抹掉）只让 user 那条变红，policy 这一支原先是零覆盖的 —— 而它守的是设计 §3
    // 里另一条独立的保证，不是 user 那条的附赠品。
    const { policy, warnings } = await run(
      { '/managed.json': JSON.stringify({ plugins: { enable: ['nope'] } }) },
      '/managed.json',
    );
    expect(policy.plugins.enable).toEqual([]);
    expect(warnings).toContain('plugins.enable 不认托管层');
  });

  it('同名在两层都启用时只留一条（合并语义是并集，留谁都不改行为）', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['todo'] } }),
      [PATHS.local]: JSON.stringify({ plugins: { enable: ['todo'] } }),
    });
    expect(policy.plugins.enable.length).toBe(1);
  });

  it('名字不是 kebab-case 的单条不生效，且出声（方向是不收紧，所以必须吼）', async () => {
    const { policy, warnings } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['BadName', 'todo'] } }),
    });
    expect(policy.plugins.enable.map((r) => r.name)).toEqual(['todo']);
    expect(warnings).toContain('BadName');
  });

  it('顶层加了 plugins 之后不再报"不认识的顶层键"', async () => {
    const { warnings } = await run({ [PATHS.project]: JSON.stringify({ plugins: {} }) });
    expect(warnings).toBe('');
  });

  it('只有 plugins 没有 permissions 的文件照常解析（早期 return 那个坑）', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['todo'] } }),
    });
    expect(policy.plugins.enable.map((r) => r.name)).toEqual(['todo']);
  });

  it('plugins 不是对象 / enable 不是数组 → 整层作废', async () => {
    const a = await run({ [PATHS.project]: JSON.stringify({ plugins: 3 }) });
    expect(a.policy.plugins.enable).toEqual([]);
    expect(a.warnings).toContain('plugins 不是一个对象');

    const b = await run({ [PATHS.project]: JSON.stringify({ plugins: { enable: 'todo' } }) });
    expect(b.warnings).toContain('plugins.enable 不是数组');
  });

  it('plugins 里不认识的子键只警告', async () => {
    const { warnings } = await run({ [PATHS.project]: JSON.stringify({ plugins: { enabl: ['x'] } }) });
    expect(warnings).toContain('不认识');
  });

  it('user 层的 enable 虽然不进 enable，但会进 enableByUser —— 落点只认这一层', async () => {
    const { policy } = await run({
      [PATHS.user]: JSON.stringify({ plugins: { enable: ['installed-one'] } }),
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['from-project'] } }),
    });
    expect(policy.plugins.enable.map((r) => r.name)).toEqual(['from-project']);
    expect(policy.plugins.enableByUser).toEqual(['installed-one']);
  });

  it('用户层没写就是空 —— 默认什么都不开', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['todo'] } }),
    });
    expect(policy.plugins.enableByUser).toEqual([]);
  });

  it('enableByUser 只取用户层：项目级写的名字不在里面', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['from-project'] } }),
      [PATHS.local]: JSON.stringify({ plugins: { enable: ['from-local'] } }),
    });
    expect(policy.plugins.enableByUser).toEqual([]);
  });
});
