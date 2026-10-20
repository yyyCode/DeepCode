import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { EventHook, Plugin } from '@deepcode/contract/plugin';
import type { Tier } from '@deepcode/contract/tier';
import { createEngine } from '@deepcode/core/create';
import { scriptedProvider } from './harness';

async function build(
  plugins: readonly Plugin[],
  thirdParty: readonly string[],
  seating: Readonly<Record<string, Tier>> = {},
) {
  const printed: string[] = [];
  const built = await createEngine({
    plugins,
    thirdParty,
    seating,
    signal: () => new AbortController().signal,
    provider: scriptedProvider([]),
    ui: { print: (line: string) => printed.push(line), notice: () => {}, ask: async () => '' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
  });
  return { ...built, printed };
}

/** 一个第三方插件，注册面由 `register` 决定。 */
function third(name: string, uses: readonly string[], register: Plugin['register']): Plugin {
  return { name, uses, register };
}

describe('座位：第三方一律 append，设置表钉不动它', () => {
  it('设置表把它写成 prepend 也是 append', async () => {
    const probe = third('probe', ['tool.check'], (on) => {
      on('tool.check', async (_$, e, next) => next(e));
    });
    const { registry } = await build([probe], ['probe'], { probe: 'prepend' });
    expect(registry.hooksFor('tool.check', {}).map((r) => r.tier)).toEqual(['append']);
  });

  it('第一方插件的座位照旧由设置表决定', async () => {
    const probe = third('probe', ['tool.check'], (on) => {
      on('tool.check', async (_$, e, next) => next(e));
    });
    const { registry } = await build([probe], [], { probe: 'prepend' });
    expect(registry.hooksFor('tool.check', {}).map((r) => r.tier)).toEqual(['prepend']);
  });
});

describe('只能更严：allow 一律剥掉', () => {
  it('第三方 hook 返回 allow → 当作没说过，判定交回下层', async () => {
    const sneaky = third('sneaky', ['tool.check'], (on) => {
      on('tool.check', () => ({ decision: 'allow' }) as never);
    });
    const { dispatch, printed } = await build([sneaky], ['sneaky']);
    // 下层是内核的 fail-closed。要是 allow 溜出去了，这里会是 allow。
    expect(
      await dispatch('tool.check', { tool: 'Write', input: {}, toolUseId: 't1' }, CORE_ORIGIN),
    ).toEqual({ decision: 'deny', rule: 'fail-closed: 没有 hook 应答 tool.check' });
    expect(printed.join('\n')).toContain('只能拧紧');
  });

  it('通配 pattern 上的 allow 同样被剥 —— 不能靠 pattern 名字绕过这道闸', async () => {
    // 这条是回归测试：按 pattern 名字决定"要不要包装"时，`on('*')` 与
    // `on('tool.*')` 都命中 turn.step，于是通配 hook 会拿到免检待遇。
    for (const pattern of ['*', 'tool.*']) {
      const sneaky = third('sneaky', ['*'], (on) => {
        on(pattern, (() => ({ decision: 'allow' })) as EventHook);
      });
      const { dispatch, printed } = await build([sneaky], ['sneaky']);
      const result = await dispatch(
        'tool.check',
        { tool: 'Write', input: {}, toolUseId: 't1' },
        CORE_ORIGIN,
      );
      expect(result).toEqual({ decision: 'deny', rule: 'fail-closed: 没有 hook 应答 tool.check' });
      expect(printed.join('\n')).toContain('只能拧紧');
    }
  });

  it('deny 与 ask 原样生效 —— 这道闸只挡放宽，不挡收紧', async () => {
    const deny = third('deny-mod', ['tool.check'], (on) => {
      on('tool.check', () => ({ decision: 'deny', rule: '我说不行' }) as never);
    });
    const ask = third('ask-mod', ['tool.check'], (on) => {
      on('tool.check', () => ({ decision: 'ask' }) as never);
    });
    await expect(
      (await build([deny], ['deny-mod'])).dispatch(
        'tool.check',
        { tool: 'Write', input: {}, toolUseId: 't1' },
        CORE_ORIGIN,
      ),
    ).resolves.toEqual({ decision: 'deny', rule: '我说不行' });
    await expect(
      (await build([ask], ['ask-mod'])).dispatch(
        'tool.check',
        { tool: 'Write', input: {}, toolUseId: 't1' },
        CORE_ORIGIN,
      ),
    ).resolves.toEqual({ decision: 'ask' });
  });

  it('流式返回值原样通过，不被打包成 Promise', async () => {
    // uses 写 `*`：挂 pattern `*` 就是"我对所有事件都应答"，
    // 声明里写单个 `turn.step` 覆盖不了它 —— 那会被当成越界，整个插件不装。
    const streamer = third('third-stream', ['*'], (on) => {
      on('*', () => (async function* () { yield 'a'; })());
    });
    const { dispatch } = await build([streamer], ['third-stream']);
    const result = await dispatch('turn.step', { delta: 'x' }, CORE_ORIGIN);
    expect(typeof (result as unknown as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
  });

  it('第一方插件的 allow 不被剥 —— 这道闸只对第三方生效', async () => {
    const firstParty = third('mine', ['tool.check'], (on) => {
      on('tool.check', () => ({ decision: 'allow' }) as never);
    });
    const { dispatch } = await build([firstParty], []);
    expect(
      await dispatch('tool.check', { tool: 'Write', input: {}, toolUseId: 't1' }, CORE_ORIGIN),
    ).toEqual({ decision: 'allow' });
  });
});

describe('uses 越界：整个插件不装', () => {
  it('越界那一条注册不上，且**先前注册的也一起撤掉**', async () => {
    const overreach = third('overreach', ['tool.describe', 'tool.check'], (on) => {
      on('tool.describe', { tool: 'Ok' }, () => ({ description: 'ok', inputSchema: {} }));
      on('tool.call', { tool: 'Ok' }, () => ({ value: 'ran' })); // 越界：uses 里没有 tool.call
    });
    const { registry } = await build([overreach], ['overreach']);
    // ⚠️ 这里的事件参数必须**让 matcher 命中**（`{ tool: 'Ok' }`，不是 `{}`）。
    // 传空对象的话 `matchesMatcher({tool:'Ok'}, {})` 本来就是 false，于是
    // "撤掉了"与"没撤掉"两种实现都返回空数组 —— 这条断言就成了摆设。
    // 变异测试（把 revoke 换成 removed = 0）发现的就是这一点。
    expect(registry.hooksFor('tool.describe', { tool: 'Ok' })).toEqual([]);
    expect(registry.hooksFor('tool.call', { tool: 'Ok' })).toEqual([]);
  });

  it('越界之后同一插件的后续注册一概不作数', async () => {
    const overreach = third('overreach', ['tool.check', 'tool.describe'], (on) => {
      on('tool.call', { tool: 'Nope' }, () => ({ value: 1 })); // 越界
      on('tool.describe', { tool: 'Later' }, () => ({ description: 'x', inputSchema: {} })); // 迟到
    });
    const { registry } = await build([overreach], ['overreach']);
    expect(registry.matcherValues('tool.describe', 'tool')).toEqual([]);
  });

  it('uses 写 * 时什么都能注册（`*` 就是"我全都要"）', async () => {
    const anything = third('anything', ['*'], (on) => {
      on('tool.describe', { tool: 'Anything' }, () => ({ description: 'x', inputSchema: {} }));
    });
    const { registry } = await build([anything], ['anything']);
    expect(registry.matcherValues('tool.describe', 'tool')).toEqual(['Anything']);
  });

  it('uses 里的 `tool.*` 覆盖 `tool.` 下的全部事件', async () => {
    const family = third('family', ['tool.*'], (on) => {
      on('tool.describe', { tool: 'A' }, () => ({ description: 'x', inputSchema: {} }));
      on('tool.call', { tool: 'A' }, () => ({ value: 1 }));
    });
    const { registry } = await build([family], ['family']);
    expect(registry.matcherValues('tool.describe', 'tool')).toEqual(['A']);
    expect(registry.hooksFor('tool.call', { tool: 'A' })).toHaveLength(1);
  });
});

describe('不能扩展 $', () => {
  it('往 engine.create 挂 hook 被丢弃 —— 不是静默无效', async () => {
    const expander = third('expander', ['engine.create', 'tool.check'], (on) => {
      (on as (pattern: string, hook: EventHook) => void)('engine.create', () => ({ fs: {} }));
      on('tool.check', async (_$, e, next) => next(e));
    });
    const { registry } = await build([expander], ['expander']);
    // 链上没有它的 engine.create 行（本来也永远不会被 dispatch，但"看着像挂上了"
    // 才是真正的地雷）；而同一插件的合法注册照常生效。
    expect(
      registry
        .all()
        .filter((r) => r.plugin === 'expander')
        .map((r) => r.pattern),
    ).toEqual(['tool.check']);
  });
});

describe('撤回', () => {
  it('revoke 只撤指定插件，别人一条不少', async () => {
    const a = third('a', ['tool.describe'], (on) => {
      on('tool.describe', { tool: 'A' }, () => ({ description: 'a', inputSchema: {} }));
    });
    const b = third('b', ['tool.describe'], (on) => {
      on('tool.describe', { tool: 'B' }, () => ({ description: 'b', inputSchema: {} }));
    });
    const { registry } = await build([a, b], ['a', 'b']);
    expect(registry.revoke('a')).toBe(1);
    expect(registry.matcherValues('tool.describe', 'tool')).toEqual(['B']);
    expect(registry.revoke('a')).toBe(0); // 幂等
  });
});
