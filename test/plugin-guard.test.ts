import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { createPluginGuardPlugin } from '../src/builtins/plugin-guard';
import { createHarness, seat } from './harness';

function mount(deny: readonly { name: string; source: string }[], firstParty: readonly string[]) {
  const lines: string[] = [];
  const h = createHarness({
    engine: {
      ui: {
        log: (line: string) => lines.push(line),
        notice: () => {},
        ask: async () => '',
      },
    },
    coreImpls: { 'plugin.register': () => ({ allow: true }) as const },
  });
  seat(h, createPluginGuardPlugin({ deny, firstParty }), 'prepend');
  return { h, lines };
}

const ask = (name: string) => ({ name, tier: 'append' as const, uses: [] as readonly string[] });

describe('准入闸门', () => {
  it('名单里没有的，放行', async () => {
    const { h } = mount([], []);
    expect(await h.dispatch('plugin.register', ask('todo'), CORE_ORIGIN)).toEqual({ allow: true });
  });

  it('名单里有的，拒绝，并说清规则来自哪一层', async () => {
    const { h } = mount([{ name: 'todo', source: 'policy' }], []);
    const verdict = await h.dispatch('plugin.register', ask('todo'), CORE_ORIGIN);
    expect(verdict).toEqual({ refuse: expect.stringContaining('policy') });
  });

  it('点名第一方插件时忽略并出声 —— 一条 deny 不能变成自毁开关', async () => {
    const { h, lines } = mount([{ name: 'sec-default', source: 'policy' }], ['sec-default']);
    expect(await h.dispatch('plugin.register', ask('sec-default'), CORE_ORIGIN)).toEqual({
      allow: true,
    });
    expect(lines.join('\n')).toContain('忽略');
  });

  it('第一方名单是"只有点名的才豁免"，不是"凡第一方都豁免"', async () => {
    // 反过来也要成立：第三方插件即使名字没在 deny 里也照常放行，deny 才拦得住。
    const { h } = mount([{ name: 'todo', source: 'user' }], ['sec-default']);
    expect(await h.dispatch('plugin.register', ask('todo'), CORE_ORIGIN)).toEqual({
      refuse: expect.stringContaining('user'),
    });
  });
});
