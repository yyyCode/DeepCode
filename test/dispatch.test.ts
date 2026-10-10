import { describe, expect, it } from 'vitest';
import { createHarness, scriptedProvider } from './harness';
import { createEngine } from '../src/core/create';
import { CORE_ORIGIN } from '../src/contract/next';
import { NotImplementedError } from '../src/core/errors';

const CALL = 'tool.call';
const args = { tool: 'Read', input: {}, toolUseId: 't1' };

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
});

describe('fail-closed', () => {
  it('tool.check 无人应答时，链尾返回 deny 而不是 allow', async () => {
    // 故意走真实的 createEngine，不借 harness 塞桩。
    // fail-closed 是 src/core/create.ts 里那条内核实现的属性，用测试自己提供的桩去测
    // 等于自问自答：把内核那条改成 allow，桩版本照样绿。这条是 MVP 唯一一条 fail-closed，
    // 也是 P2 全部安全性质的种子，必须真的钉在内核实现上。
    const built = await createEngine({
      plugins: [],
      signal: new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    const result = await built.dispatch('tool.check', { tool: 'Bash', input: {} }, CORE_ORIGIN);
    expect(result.decision).toBe('deny');
  });
});
