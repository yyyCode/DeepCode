import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@deepcode/contract/model-provider';
import type { Plugin } from '@deepcode/contract/plugin';
import { createEngine } from '@deepcode/core/create';
import { Registry } from '@deepcode/core/registry';
import { listTools, toolSpecChars, toolsChars } from '@deepcode/core/tool-list';
import { coreTools } from '@deepcode/builtins/tools';

const NO_MODEL: ModelProvider = {
  name: 'none',
  // 这一套里没有一次模型调用 —— `listTools` 只派发 tool.describe。
  // 真流一个的话，测试失败时会以"provider 坏了"的形状出现，掩盖真因。
  async *stream() {
    throw new Error('这个测试不该发请求');
  },
};

/** 三类工具各一个：正常的、没注册描述的（故障）、被规则隐藏的。 */
const fixture: Plugin = {
  name: 'fixture',
  uses: ['tool.describe', 'tool.call'],
  register(on) {
    on('tool.describe', { tool: 'Good' }, () => ({
      description: '好人',
      inputSchema: { type: 'object' },
    }));
    on('tool.call', { tool: 'Good' }, () => ({ value: 'ok' }));

    // 只注册 call，不注册 describe —— 模型永远看不到它。
    on('tool.call', { tool: 'Ghost' }, () => ({ value: 'ok' }));

    // describe 说"我不想露面"（权限规则整工具 deny 走的就是这一支）。
    on('tool.describe', { tool: 'Secret' }, () => ({ hidden: true }) as const);
    on('tool.call', { tool: 'Secret' }, () => ({ value: 'ok' }));
  },
};

async function engine(plugins: readonly Plugin[] = [fixture]) {
  return await createEngine({
    plugins,
    provider: NO_MODEL,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });
}

describe('C1-1：一份清单，两个部分', () => {
  it('能用的进 specs；不能用的进 skipped，逐个带原因', async () => {
    const { $, dispatch } = await engine();
    const listing = await listTools({ $, dispatch });

    expect(listing.specs.map((spec) => spec.name)).toEqual(['Good']);
    expect(listing.specs[0]?.description).toBe('好人');
    expect(listing.skipped).toEqual([
      // 注册顺序：fixture 的三条按 Good → Ghost → Secret 排。
      { name: 'Ghost', why: '没有注册描述（tool.describe 无人应答 —— 这是故障）' },
      { name: 'Secret', why: '被权限规则隐藏' },
    ]);
  });

  it('白名单外的是第三种原因 —— 措辞与故障那一句**不一样**', async () => {
    const { $, dispatch } = await engine();
    // 白名单把 Ghost 放进来、把 Good 挡在外面。
    const listing = await listTools({ $, dispatch, tools: new Set(['Ghost', 'Secret']) });

    expect(listing.specs).toEqual([]);
    expect(listing.skipped).toEqual([
      { name: 'Good', why: '不在本次的工具清单里' },
      { name: 'Ghost', why: '没有注册描述（tool.describe 无人应答 —— 这是故障）' },
      { name: 'Secret', why: '被权限规则隐藏' },
    ]);
    // ⚠️ 这条是本用例真正钉的东西：三种原因必须是三句不同的话。
    // 合成一句的话，"策略不让它露面"与"插件写漏了 describe"就分不开了，
    // 而后者是要去修的那种。
    const whys = listing.skipped.map((one) => one.why);
    expect(new Set(whys).size).toBe(whys.length);
  });
});

describe('C1-2：工具占多少字符', () => {
  it('名字 + 描述 + schema 的 JSON —— 三个部分都算', async () => {
    const { $, dispatch } = await engine();
    const { specs } = await listTools({ $, dispatch });
    const spec = specs[0]!;

    // 自己算一遍同一个式子，钉的是"三样都进了"，不是函数里那个数。
    const expected = 'Good'.length + '好人'.length + JSON.stringify(spec.inputSchema).length;
    expect(toolSpecChars(spec)).toBe(expected);
    expect(toolsChars(specs)).toBe(expected);
    // 空清单是 0，不是抛 —— 账本在"还没发过请求"那一支要吃它。
    expect(toolsChars([])).toBe(0);
  });
});

describe('C1-3：工具是谁的', () => {
  /** 两条注册挂在**同一个**工具名上：链上最外层那个才算"来源"。 */
  it('同一个名字有多个注册者时，报链上最外层那个', () => {
    const registry = new Registry();
    registry.register({ plugin: 'inner', tier: 'builtin', pattern: 'tool.call', matcher: { tool: 'X' }, hook: () => ({}) });
    registry.register({ plugin: 'outer', tier: 'prepend', pattern: 'tool.call', matcher: { tool: 'X' }, hook: () => ({}) });

    expect(registry.matcherOwner('tool.call', 'tool', 'X')).toBe('outer');
    // 没注册过这个取值 → undefined，不是猜一个。
    expect(registry.matcherOwner('tool.call', 'tool', 'Y')).toBeUndefined();
  });

  it('真引擎里：六个内建工具各自报得出作者，名字是从 tool.call 那里来的', async () => {
    const { $ } = await engine(coreTools);

    expect($.tool.origin('Read')).toBe('tool-read');
    expect($.tool.origin('Bash')).toBe('tool-bash');
    // 注册面（list）与"谁注册的"（origin）覆盖同一个集合。
    expect($.tool.list()).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
    expect($.tool.list().every((name) => $.tool.origin(name) !== undefined)).toBe(true);
    expect($.tool.origin('没这个工具')).toBeUndefined();
  });
});
