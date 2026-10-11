import { describe, expect, it } from 'vitest';
import { validateMarketplace, type MarketplaceDeps } from '../src/contract/marketplace';
import type { PluginReader } from '../src/contract/plugin-manifest';

/**
 * 一份内存里的 marketplace 现场：索引文本 + 若干「插件目录」。
 *
 * 全部在内存里，不碰盘 —— 这份校验器是纯逻辑，测试就该按纯逻辑测。
 * `read` 返回 undefined（而不是抛）是那个 reader 契约里「不存在是常态」的一半。
 */
type World = Record<string, Record<string, string>>;

function deps(index: string | undefined, world: World): MarketplaceDeps {
  return {
    async readIndex() {
      return index;
    },
    openPlugin(source: string): PluginReader {
      const files = world[source] ?? {};
      return {
        async read(relative) {
          return files[relative];
        },
        async exists(relative) {
          return files[relative] !== undefined;
        },
      };
    },
  };
}

/** 一份带入口模块的清单：不给入口也没有钩子的话会多一条 W9，好用例就不干净了。 */
// `uses` 必须把 tool 三件套凑齐：只有 describe + call 会被清单校验器的 W7 点一条
// 「call 却没有 check」，好用例照样不干净。三件都要，这才是一份无警告的清单。
const GOOD_MANIFEST = {
  name: 'todo',
  version: '0.1.0',
  uses: ['tool.describe', 'tool.call', 'tool.check'],
  entry: './main.mjs',
};
const GOOD_FILES = {
  'plugin.json': JSON.stringify(GOOD_MANIFEST),
  './main.mjs': 'export default { register() {} }',
};
const GOOD_WORLD: World = { './plugins/todo': GOOD_FILES };
const GOOD_INDEX = JSON.stringify({
  name: 'deepcode',
  description: 'DeepCode 自带的插件',
  plugins: [{ name: 'todo', description: '加一个 TodoWrite 工具', source: './plugins/todo' }],
});

/** 只改一个字段的索引，用来一条一条地钉判据。 */
function indexWith(entry: Record<string, unknown>): string {
  return JSON.stringify({ name: 'deepcode', plugins: [entry] });
}

describe('validateMarketplace', () => {
  it('一份好索引全绿，条目里带的是**已归一**的清单', async () => {
    const result = await validateMarketplace('/repo', deps(GOOD_INDEX, GOOD_WORLD));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    const entry = result.entries?.[0];
    expect(entry?.name).toBe('todo');
    expect(entry?.description).toBe('加一个 TodoWrite 工具');
    expect(entry?.source).toBe('./plugins/todo');
    // 归一之后才有 version（清单里没写就是 0.0.0）、uses、paths —— 这是「不必再校验一次」的意思。
    expect(entry?.manifest.version).toBe('0.1.0');
    expect(entry?.manifest.uses).toEqual(['tool.describe', 'tool.call', 'tool.check']);
    expect(entry?.manifest.paths.entry).toEqual(['./main.mjs']);
  });

  it('M1 索引根本不存在', async () => {
    const result = await validateMarketplace('/repo', deps(undefined, {}));
    expect(result.ok).toBe(false);
    expect(result.entries).toBeUndefined();
    expect(result.problems).toEqual([
      {
        level: 'error',
        code: 'M1',
        message: expect.stringContaining('.deepcode-plugin/marketplace.json'),
      },
    ]);
  });

  it('M1 不是合法 JSON', async () => {
    const result = await validateMarketplace('/repo', deps('{ "name": ', {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M1']);
    expect(result.problems[0]?.message).toContain('不是合法 JSON');
  });

  it('M1 顶层是数组（是个对象之外的一切）', async () => {
    const result = await validateMarketplace('/repo', deps('[]', {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M1' });
    expect(result.problems[0]?.message).toContain('顶层不是一个对象');
  });

  it('M2 name 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ plugins: [] }), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M2' });
    expect(result.problems[0]?.message).toContain('缺少 name');
  });

  it('M2 name 不是 kebab-case', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'DeepCode', plugins: [] }), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M2' });
    expect(result.problems[0]?.message).toContain('kebab-case');
  });

  it('M3 plugins 不是数组', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'x', plugins: {} }), {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M3']);
    expect(result.problems[0]?.message).toContain('必须是数组');
  });

  it('M3 plugins 是空数组', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'x', plugins: [] }), {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M3']);
    expect(result.problems[0]?.message).toContain('空的');
  });

  it('M4 条目不是对象', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith('nope' as never), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('不是一个对象');
  });

  it('M4 条目 name 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith({ source: './plugins/todo' }), GOOD_WORLD));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('缺少 name');
  });

  it('M4 条目 name 不是 kebab-case', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'Todo', source: './plugins/todo' }), GOOD_WORLD),
    );
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('kebab-case');
  });

  it('M4 名字在本索引内重复', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      plugins: [
        { name: 'todo', source: './plugins/todo' },
        { name: 'todo', source: './plugins/todo' },
      ],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('M4');
    expect(result.problems.some((p) => p.message.includes('重名'))).toBe(true);
  });

  it('M5 source 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith({ name: 'todo' }), GOOD_WORLD));
    const m5 = result.problems.find((p) => p.code === 'M5');
    expect(m5?.level).toBe('error');
    expect(m5?.message).toContain('./');
  });

  it('M5 source 逃出索引根（`../x`）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: '../outside' }), GOOD_WORLD),
    );
    const m5 = result.problems.find((p) => p.code === 'M5');
    expect(m5?.level).toBe('error');
    expect(m5?.message).toContain('不含 .. 与反斜杠');
    expect(result.entries).toBeUndefined();
  });

  it('M5 source 用反斜杠（Windows 上会被归一成逃逸路径）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: '.\\plugins\\todo' }), GOOD_WORLD),
    );
    expect(result.problems.map((p) => p.code)).toContain('M5');
  });

  it('M6 直接吃 validatePlugin 的结论 —— source 指向的目录根本不存在不需要单独一条规则', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/gone' }), GOOD_WORLD),
    );
    const e2 = result.problems.find((p) => p.code === 'E2');
    expect(e2?.level).toBe('error');
    // 理由文案里必须带 source 路径，否则人不知道是哪一条。
    expect(e2?.message).toContain('./plugins/gone');
    expect(result.ok).toBe(false);
  });

  it('M6 清单坏了（E3 名字）时也带 source 路径', async () => {
    const bad: World = { './plugins/bad': { 'plugin.json': JSON.stringify({ name: 'BadName' }) } };
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'bad', source: './plugins/bad' }), bad),
    );
    const e3 = result.problems.find((p) => p.code === 'E3');
    expect(e3?.level).toBe('error');
    expect(e3?.message).toContain('./plugins/bad');
  });

  it('M7 description 写了就要是字符串（顶层）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/todo' }).replace('"plugins"', '"description":3,"plugins"'), GOOD_WORLD),
    );
    expect(result.problems.find((p) => p.code === 'M7')?.level).toBe('error');
  });

  it('M7 description 写了就要是字符串（条目）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', description: 3, source: './plugins/todo' }), GOOD_WORLD),
    );
    expect(result.problems.find((p) => p.code === 'M7')?.message).toContain('plugins[0].description');
  });

  it('M8 索引名字与清单名字不一致 —— 静默的就是这一条', async () => {
    const other: World = {
      './plugins/todo': {
        'plugin.json': JSON.stringify({ ...GOOD_MANIFEST, name: 'todo-write' }),
        './main.mjs': GOOD_FILES['./main.mjs'],
      },
    };
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/todo' }), other),
    );
    const m8 = result.problems.find((p) => p.code === 'M8');
    expect(m8?.level).toBe('error');
    // 这句理由要说出后果：照 list 写 plugins.enable 会静默不生效。
    expect(m8?.message).toContain('plugins.enable');
    expect(result.entries).toBeUndefined();
  });

  it('W1 未识别的字段只警告，不影响可用', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      category: 'tools',
      plugins: [{ name: 'todo', source: './plugins/todo', version: '0.2.0' }],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    const w1 = result.problems.filter((p) => p.code === 'W1');
    expect(w1.every((p) => p.level === 'warn')).toBe(true);
    expect(w1.map((p) => p.message).join('\n')).toContain('category');
    expect(w1.map((p) => p.message).join('\n')).toContain('version');
  });

  it('多条目：坏的那一条不连累好的，但整份索引仍然不可用', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      plugins: [
        { name: 'todo', source: './plugins/todo' },
        { name: 'gone', source: './plugins/gone' },
      ],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(false);
    // entries 在 ok=false 时一律 undefined —— 半个可用清单比没有更危险。
    expect(result.entries).toBeUndefined();
  });
});
