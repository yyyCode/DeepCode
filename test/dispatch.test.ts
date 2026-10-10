import { describe, expect, it } from 'vitest';
import { createHarness, scriptedProvider } from './harness';
import { createEngine } from '../src/core/create';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Plugin } from '../src/contract/plugin';
import { NotImplementedError } from '../src/core/errors';

const CALL = 'tool.call';
const args = { tool: 'Read', input: {}, toolUseId: 't1' };

/** 真实引擎，不借 harness 的桩 —— 用来钉内核实现本身的行为。 */
async function realEngine() {
  return createEngine({
    plugins: [],
    signal: () => new AbortController().signal,
    provider: scriptedProvider([]),
    ui: { print: () => {}, notice: () => {}, ask: async () => '' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
  });
}

describe('链语义', () => {
  it('按 tier 由外到内执行，内核在最内层', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const order: string[] = [];
    h.on('builtin', 'inner', CALL, async (_$, _e, next) => {
      order.push('builtin');
      return next(_e);
    });
    h.on('prepend', 'outer', CALL, async (_$, e, next) => {
      order.push('prepend');
      return next(e);
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(order).toEqual(['prepend', 'builtin']);
    expect(result).toEqual({ value: 'core' });
  });

  it('不调用 next 直接返回 = 结束链，内核不运行', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core-never-runs' }) },
    });
    h.on('builtin', 'short', CALL, async () => ({ value: 'short-circuit' }));

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'short-circuit' });
  });

  it('next({...e, field}) 改写下行，但不改自己的 e', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': (e: any) => ({ value: e.tool }) },
    });
    let seenByOuter: unknown;
    let seenByInner: unknown;

    h.on('builtin', 'inner', CALL, async (_$, e, next) => {
      seenByInner = e.tool;
      return next(e);
    });
    h.on('prepend', 'outer', CALL, async (_$, e, next) => {
      const rewritten = await next({ ...e, tool: 'Grep' });
      seenByOuter = e.tool;
      return rewritten;
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'Grep' });   // 改写下行生效
    expect(seenByOuter).toBe('Read');            // 自己的 e 没被改
    expect(seenByInner).toBe('Grep');            // 下层看到的是改写后的值
  });

  it('事件参数是深冻结的', async () => {
    const h = createHarness({ coreImpls: { 'tool.call': () => ({ value: 'ok' }) } });
    let frozen = false;
    h.on('builtin', 'probe', CALL, async (_$, e, next) => {
      frozen = Object.isFrozen(e);
      return next(e);
    });

    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(frozen).toBe(true);
  });

  it('hook 抛错被隔离：跳过它、下层照跑、按插件名上报一次', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'survived' }) },
    });
    h.on('prepend', 'boom', CALL, async () => {
      throw new Error('炸了');
    });
    h.on('builtin', 'ok', CALL, async (_$, e, next) => next(e));

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'survived' });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('boom');

    // 同一个 (事件, 插件) 只警告一次
    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(h.warnings).toHaveLength(1);
  });

  it('hook 什么都不返回 = 失败，被当作抛错处理', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'survived' }) },
    });
    h.on('builtin', 'silent', CALL, (async () => undefined) as any);

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'survived' });
    expect(h.warnings[0]).toContain('undefined');
  });

  it('next.to(tier) 只向下跳，跳过中间层，直达内核', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const visited: string[] = [];

    // 座位从外到内：user → append → builtin → core(内核实现)
    // user 层直接跳到内核，append 与 builtin 都不该被运行。
    h.on('user', 'usr', CALL, async (_$, _e, next) => {
      visited.push('usr');
      return next.to(_e, 'core');
    });
    h.on('append', 'app', CALL, async (_$, _e, next) => {
      visited.push('app');
      return next(_e);
    });
    h.on('builtin', 'bi', CALL, async (_$, _e, next) => {
      visited.push('bi');
      return next(_e);
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'core' }); // 确实落到了内核
    expect(visited).toEqual(['usr']);          // append 与 builtin 被跳过
  });

  it('座位表：插件被装在表里指定的 tier 上，不是插件自己说的地方', async () => {
    const probe: Plugin = {
      name: 'probe',
      uses: [],
      register(on) {
        on('tool.check', async (_$, _e, next) => next(_e));
      },
    };

    const built = await createEngine({
      plugins: [probe],
      seating: { probe: 'prepend' },
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    expect(built.registry.hooksFor('tool.check', {}).map((r) => r.tier)).toEqual(['prepend']);
  });

  it('座位表没列到的插件坐 builtin —— 既有装配一行都不用改', async () => {
    const probe: Plugin = {
      name: 'probe',
      uses: [],
      register(on) {
        on('tool.check', async (_$, _e, next) => next(_e));
      },
    };

    const built = await createEngine({
      plugins: [probe],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    expect(built.registry.hooksFor('tool.check', {}).map((r) => r.tier)).toEqual(['builtin']);
  });

  it('next.signal / origin / budget / is 都挂上了', async () => {
    const controller = new AbortController();
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'x' }) },
      signal: controller.signal,
    });
    let snapshot: any;
    h.on('builtin', 'probe', CALL, async (_$, e, next) => {
      snapshot = {
        signal: next.signal === controller.signal,
        event: next.event,
        plugin: next.origin.plugin,
        tier: next.origin.tier,
        ms: next.budget.ms,
        isCall: next.is('tool.*'),
        isOther: next.is('ui.*'),
      };
      return next(e);
    });

    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(snapshot).toEqual({
      signal: true,
      event: CALL,
      plugin: 'probe',
      tier: 'builtin',
      ms: 10_000,
      isCall: true,
      isOther: false,
    });
  });

  it('skipPlugin 跳过发起者自己，避免自递归', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const visits: string[] = [];
    h.on('builtin', 'self-dispatch', CALL, async (_$, e, next) => {
      visits.push('direct');
      // 模拟 hook 通过 $ 再发起一次同事件调用：应当跳过它自己
      const nested = await h.dispatch(CALL, e, CORE_ORIGIN, 'self-dispatch');
      visits.push('nested');
      return nested;
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'core' });
    expect(visits).toEqual(['direct', 'nested']); // 嵌套那次没再进 self-dispatch
  });

  it('matcher 只对匹配的输入生效', async () => {
    const h = createHarness({ coreImpls: { 'tool.call': () => ({ deny: 'unknown tool' }) } });
    h.on('builtin', 'read-tool', CALL, { tool: 'Read' }, async () => ({ value: 'read-ran' }));

    expect(await h.dispatch(CALL, args, CORE_ORIGIN)).toEqual({ value: 'read-ran' });
    expect(await h.dispatch(CALL, { ...args, tool: 'Bash' }, CORE_ORIGIN)).toEqual({
      deny: 'unknown tool',
    });
  });

  it('落到未实现的事件抛 NotImplementedError', async () => {
    const h = createHarness();
    await expect(h.dispatch('agent.spawn', {}, CORE_ORIGIN)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('ui.* 已声明但未实现：落到它仍然抛 NotImplementedError', async () => {
    const h = createHarness();
    // { tree: { type: 'root' } } 能编译过，本身就是对 ui.render 精确类型的断言 ——
    // 收窄前它是 Record<string, unknown>，任何形状都收，这条测试就失去意义。
    await expect(
      h.dispatch('ui.render', { tree: { type: 'root' } }, CORE_ORIGIN),
    ).rejects.toBeInstanceOf(NotImplementedError);
    // 顺带钉住 message 格式（见 src/core/errors.ts 的 constructor）。
    await expect(
      h.dispatch('ui.render', { tree: { type: 'root' } }, CORE_ORIGIN),
    ).rejects.toThrow('event not implemented in MVP: ui.render');
  });
});

describe('座位算法：同 tier 内按插件分组', () => {
  it('同一插件晚注册的 hook 仍然排回自己那一组，不插到别人后面', async () => {
    const h = createHarness();
    const order: string[] = [];
    // alpha 先装载，beta 后装载；alpha 的第二个 hook 在 beta 之后才注册。
    h.on('builtin', 'alpha', 'turn.start', async (_$, e, next) => {
      order.push('alpha-1');
      return next(e);
    });
    h.on('builtin', 'beta', 'turn.start', async (_$, e, next) => {
      order.push('beta');
      return next(e);
    });
    h.on('builtin', 'alpha', 'turn.start', async (_$, e, next) => {
      order.push('alpha-2');
      return next(e);
    });

    // turn.start 是通知事件，链尾兜底返回 {}，不需要 coreImpls 兜。
    await h.dispatch('turn.start', { index: 0 }, CORE_ORIGIN);
    // 老的 (tier, seq) 排序会给出 ['alpha-1', 'beta', 'alpha-2'] —— alpha-2 插到了 beta 后面。
    expect(order).toEqual(['alpha-1', 'alpha-2', 'beta']);
  });

  it('tier 比插件顺序更权威：晚装载的 user 层仍在外层', async () => {
    const h = createHarness();
    const order: string[] = [];
    h.on('user', 'late', 'turn.start', async (_$, e, next) => {
      order.push('user');
      return next(e);
    });
    h.on('builtin', 'early', 'turn.start', async (_$, e, next) => {
      order.push('builtin');
      return next(e);
    });

    await h.dispatch('turn.start', { index: 0 }, CORE_ORIGIN);
    expect(order).toEqual(['user', 'builtin']);
  });
});

describe('fail-closed', () => {
  it('tool.check 无人应答时，链尾返回 deny 而不是 allow', async () => {
    // 故意走真实的 createEngine，不借 harness 塞桩。
    // fail-closed 是 src/core/create.ts 里那条内核实现的属性，用测试自己提供的桩去测
    // 等于自问自答：把内核那条改成 allow，桩版本照样绿。这条是 MVP 唯一一条 fail-closed，
    // 也是 P2 全部安全性质的种子，必须真的钉在内核实现上。
    const built = await realEngine();

    const result = await built.dispatch('tool.check', { tool: 'Bash', input: {} }, CORE_ORIGIN);
    expect(result.decision).toBe('deny');
  });
});

describe('生命周期事件的内核 no-op', () => {
  // 这不是凑数是覆盖。这些事件在 MVP 里没有插件会应答，内核若也不给实现，
  // dispatch 就会抛 NotImplementedError —— 而 loop 的第一行是 turn.start、
  // CLI 的第一行是 session.start。曾经真实断在这里：产品一开口就崩，
  // 而 typecheck 与 C1 全绿，只有手动端到端才发现。
  const lifecycle: ReadonlyArray<readonly [string, unknown]> = [
    ['session.start', { sessionId: 's1', cwd: '.', root: '.' }],
    ['session.end', { reason: 'exit' }],
    ['turn.start', { index: 0 }],
    ['turn.step', { delta: 'hi' }],
    ['turn.complete', { stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 }],
  ];

  it('五个生命周期事件都能 dispatch，且不抛', async () => {
    const built = await realEngine();
    for (const [event, args] of lifecycle) {
      await expect((built.dispatch as any)(event, args, CORE_ORIGIN)).resolves.toEqual({});
    }
  });

  it('没有内核实现的裸 dispatcher 也能 dispatch 通知事件', async () => {
    // 上面那条走的是 createEngine，而它的 coreImpls 里曾经真的列着这五条 ——
    // 于是内核这条路全绿，另一条路（E2E 用的 harness，coreImpls 只给了 tool.*）
    // 一开口就崩。这条钉的是"保证写在 dispatch 链尾"，不依赖任何调用方记得补。
    const h = createHarness();
    await expect(h.dispatch('turn.start', { index: 0 }, CORE_ORIGIN)).resolves.toEqual({});
  });

  it('真正未实现的事件仍然抛 NotImplementedError', async () => {
    // 上面那条的另一半：no-op 只针对生命周期事件，
    // NotImplementedError 必须继续为那 27 个真未实现的事件保留意义。
    const built = await realEngine();
    await expect(
      (built.dispatch as any)('agent.spawn', {}, CORE_ORIGIN),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('调试轨迹（DEEPCODE_DEBUG 打开后能看到的那条线）', () => {
  it('每个非流式事件留一行，写清被谁应答', async () => {
    // 这条线是"链语义看不见"的唯一补救：没有它，DEEPCODE_DEBUG 就只是个
    // 什么都不干的开关（logger.debug 此前一个调用者都没有）。
    const h = createHarness({ coreImpls: { [CALL]: () => ({ value: 'core' }) } });
    h.on('builtin', 'answerer', CALL, () => ({ value: 'builtin' }));

    await h.dispatch(CALL, args, CORE_ORIGIN);

    expect(h.debugLines).toHaveLength(1);
    expect(h.debugLines[0]).toContain(CALL);
    expect(h.debugLines[0]).toContain('answerer@builtin');
  });

  it('被跳过的故障 hook 也在行里标出来', async () => {
    const h = createHarness({ coreImpls: { [CALL]: () => ({ value: 'core' }) } });
    h.on('builtin', 'bad', CALL, () => {
      throw new Error('炸了');
    });

    await h.dispatch(CALL, args, CORE_ORIGIN);

    expect(h.debugLines[0]).toContain('bad@builtin(跳过)');
  });

  it('流式事件不打轨迹 —— turn.step 每段文本一次，打出来就是刷屏', async () => {
    const h = createHarness();
    h.on('builtin', 'listener', 'turn.step', () => ({}) as any);

    await h.dispatch('turn.step', { delta: '字' }, CORE_ORIGIN);

    expect(h.debugLines).toEqual([]);
  });

  it('链尾没人应答时那行带着错误，现场不丢', async () => {
    const h = createHarness();

    await expect(h.dispatch('agent.spawn', {} as any, CORE_ORIGIN)).rejects.toBeInstanceOf(
      NotImplementedError,
    );

    expect(h.debugLines.join('\n')).toContain('agent.spawn');
    expect(h.debugLines.join('\n')).toContain('✗');
  });
});
