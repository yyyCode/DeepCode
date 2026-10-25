import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../../../src/contract/next';
import type { Plugin } from '../../../src/contract/plugin';
import { createEngine } from '../../../src/core/create';
import { createTelemetryPlugin } from '../index';
import { createTelemetrySink, type TelemetrySink } from '../sink';
import { telemetryPath, type TelemetryEntry } from '../rows';
import { cliPlugins } from '../../../src/cli/plugins';
import { createPalette } from '../../../src/cli/ansi';
import { createRenderer } from '../../../src/cli/render';
import { createSessionChanges } from '../../../src/cli/changes';
import { DEFAULT_MEMORY } from '../../../src/contract/memory';
import {
  DEFAULT_COMPACT,
  DEFAULT_TELEMETRY,
  EMPTY_SANDBOX,
  type ResolvedPolicy,
} from '../../../src/cli/settings';
import { modPlugins, scriptedProvider } from '../../../test/harness';

/**
 * 遥测插件的链上行为。
 *
 * 这里测的是**插件**（挂哪个事件、写哪些字段、动不动裁决），
 * 行协议与落盘分别归 `telemetry-rows.test.ts` / `telemetry-sink.test.ts`。
 * 用真的 `createEngine`：`$.telemetry` 是折叠出来的，假引擎测不到那条路。
 */

/** 一个只记账的 sink —— 收 `record`、数 `flush`。 */
function fakeSink() {
  const entries: TelemetryEntry[] = [];
  const counter = { flushes: 0 };
  const sink: TelemetrySink = {
    record: (entry) => void entries.push(entry),
    flush: async () => void (counter.flushes += 1),
    get stats() {
      return {
        written: entries.length,
        rejected: 0,
        lastReject: undefined,
        lastError: undefined,
        path: '/tmp/fake.jsonl',
      };
    },
  };
  return { sink, entries, counter };
}

type BuildOptions = {
  readonly enabled?: boolean;
  readonly sink?: TelemetrySink;
  /** 额外插件（测"没人挂它时"那条对照用）。 */
  readonly extra?: readonly Plugin[];
};

async function build(over: BuildOptions = {}) {
  const out: string[] = [];
  const warnings: string[] = [];
  const plugin = createTelemetryPlugin({
    home: '/home/u',
    policy: { enabled: over.enabled ?? true, why: '用户层开了' },
    sessionId: 's1',
    warn: (line) => warnings.push(line),
    ...(over.sink === undefined ? {} : { sink: over.sink }),
  });
  const built = await createEngine({
    plugins: [plugin, ...(over.extra ?? [])],
    thirdParty: [],
    seating: {},
    signal: () => new AbortController().signal,
    provider: scriptedProvider([]),
    ui: { print: (line) => void out.push(line), notice: () => {}, ask: async () => '' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
  });
  return { ...built, out, warnings };
}

/** 六个事件全走一遍。返回之后 sink 里应当有六条。 */
async function driveAllEvents(dispatch: Awaited<ReturnType<typeof build>>['dispatch']): Promise<void> {
  await dispatch('session.start', { sessionId: 's1', cwd: '/w', root: '/w' }, CORE_ORIGIN);
  await dispatch(
    'turn.complete',
    { stopReason: 'answer', inputTokens: 12, outputTokens: 34, usageEstimated: true },
    CORE_ORIGIN,
  );
  await dispatch(
    'tool.result',
    { tool: 'Bash', input: { command: 'ls' }, toolUseId: 't1', ok: true, output: 'a\nb' },
    CORE_ORIGIN,
  );
  await dispatch('session.compact', { trigger: 'auto', tokensBefore: 900 }, CORE_ORIGIN);
  await dispatch('agent.spawn', { name: 'scout', task: '看看仓库', depth: 2 }, CORE_ORIGIN);
  await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
}

describe('$.telemetry —— 折叠出来的名词', () => {
  it('真引擎的 $ 上有它，六个事件之外的东西一样没少', async () => {
    const { $ } = await build();
    expect(typeof $.telemetry.log).toBe('function');
    // 折叠是**叠加**不是替换：core 那几个名词还在（`{...await next(e), ...}` 的顺序错一处
    // 就会把内核名词整片盖掉，那种事在真引擎上才看得出来）。
    expect(typeof $.ui.log).toBe('function');
    expect(typeof $.session.id()).toBe('string');
  });

  it('log 一路走到 sink —— 折叠出来的那个 log 就是插件手里的 write', async () => {
    const fake = fakeSink();
    const { $ } = await build({ sink: fake.sink });
    $.telemetry.log({ kind: 'manual.probe' });
    expect(fake.entries).toEqual([{ kind: 'manual.probe' }]);
  });
});

describe('六个事件各记一行', () => {
  it('字段与事件参数对得上', async () => {
    const fake = fakeSink();
    const { dispatch } = await build({ sink: fake.sink });
    await driveAllEvents(dispatch);

    expect(fake.entries.map((entry) => [entry.kind, entry.fields])).toEqual([
      ['session.start', { session: 's1' }],
      [
        'turn.complete',
        { stop_reason: 'answer', input_tokens: 12, output_tokens: 34, estimated: true },
      ],
      ['tool.result', { tool: 'Bash', ok: true }],
      ['session.compact', { trigger: 'auto', tokens_before: 900 }],
      // P10：多一列 `depth` —— 一次递归在遥测里从此看得出层数（在此之前嵌套的与
      // 顶层的一模一样，只有名字）。
      ['agent.spawn', { agent: 'scout', depth: 2 }],
      ['session.end', { reason: 'exit' }],
    ]);
  });

  it('usageEstimated 省略时 estimated 是 false 而不是 undefined（行协议里没有 undefined）', async () => {
    const fake = fakeSink();
    const { dispatch } = await build({ sink: fake.sink });
    await dispatch('turn.complete', { stopReason: 'answer', inputTokens: 1, outputTokens: 2 }, CORE_ORIGIN);
    expect(fake.entries[0]?.fields).toEqual({
      stop_reason: 'answer',
      input_tokens: 1,
      output_tokens: 2,
      estimated: false,
    });
  });

  it('session.end 之后 flush 被调过（不冲盘的话最后几行要等下一批）', async () => {
    const fake = fakeSink();
    const { dispatch } = await build({ sink: fake.sink });
    expect(fake.counter.flushes).toBe(0);
    await driveAllEvents(dispatch);
    expect(fake.counter.flushes).toBe(1);
  });

  it('记了就一路记到底 —— flush 之前也不会丢（记录是同步进缓冲的）', async () => {
    const fake = fakeSink();
    const { dispatch } = await build({ sink: fake.sink });
    await dispatch('session.start', { sessionId: 's1', cwd: '/w', root: '/w' }, CORE_ORIGIN);
    // 还没到 session.end，sink 里就已经有了。
    expect(fake.entries).toHaveLength(1);
  });
});

describe('它是个读者，不是链上的一环', () => {
  it('tool.result 的返回值与没人挂它时**逐字节**相同', async () => {
    const fake = fakeSink();
    const args = { tool: 'Bash', input: { command: 'ls' }, toolUseId: 't1', ok: true, output: 'x' };

    const withTelemetry = await build({ sink: fake.sink });
    const bare = await createEngine({
      plugins: [],
      thirdParty: [],
      seating: {},
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    const a = await withTelemetry.dispatch('tool.result', args, CORE_ORIGIN);
    const b = await bare.dispatch('tool.result', args, CORE_ORIGIN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // 而且确实是那个空结果 —— 不然"两边一样"可能只是两边**都**错了。
    expect(JSON.stringify(a)).toBe('{}');
    // 记了账，但没改账。
    expect(fake.entries).toHaveLength(1);
  });

  it('挂在 tool.result 而不是 tool.check 上 —— 记录行为的东西不进裁决路径', async () => {
    const { registry } = await build();
    const onCheck = registry.hooksFor('tool.check', {}).map((hook) => hook.plugin);
    expect(onCheck).not.toContain('telemetry');
    expect(registry.hooksFor('tool.result', {}).map((hook) => hook.plugin)).toContain('telemetry');
  });
});

describe('关着的时候', () => {
  it('六个事件照样各调一次 record，但一个系统调用都不发、一行都不算数', async () => {
    const boom = async () => {
      throw new Error('关掉的时候不该碰盘');
    };
    const warnings: string[] = [];
    const real = createTelemetrySink({
      home: '/home/u',
      enabled: false,
      warn: (line) => void warnings.push(line),
      mkdir: boom,
      append: boom,
    });
    let records = 0;
    // 包一层只为数调用次数：**真** sink 收，`written` 才是真的有意义的那个数。
    const sink: TelemetrySink = {
      record: (entry) => {
        records += 1;
        real.record(entry);
      },
      flush: () => real.flush(),
      get stats() {
        return real.stats;
      },
    };

    const { dispatch } = await build({ enabled: false, sink });
    await driveAllEvents(dispatch);

    expect(records).toBe(6);
    expect(real.stats.written).toBe(0);
    expect(real.stats.rejected).toBe(0);
    expect(real.stats.lastError).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('/telemetry', () => {
  it('打得出开关、why、路径、行数', async () => {
    const fake = fakeSink();
    const { dispatch, out } = await build({ sink: fake.sink });
    await dispatch('session.start', { sessionId: 's1', cwd: '/w', root: '/w' }, CORE_ORIGIN);

    const result = await dispatch('command.run', { name: 'telemetry', args: [] }, CORE_ORIGIN);

    expect(result).toEqual({ handled: true });
    const text = out.join('\n');
    expect(text).toContain('遥测：开');
    expect(text).toContain('用户层开了');
    expect(text).toContain('/tmp/fake.jsonl');
    expect(text).toContain('记了 1 行');
    // 开着的时候不该再教人怎么开。
    expect(text).not.toContain('打开：');
  });

  it('关着的时候直说关，并把**唯一**能开的那个地方写清楚', async () => {
    const sink = createTelemetrySink({ home: '/home/u', enabled: false, warn: () => {} });
    const { dispatch, out } = await build({ enabled: false, sink });
    await dispatch('command.run', { name: 'telemetry', args: [] }, CORE_ORIGIN);

    const text = out.join('\n');
    expect(text).toContain('遥测：关');
    expect(text).toContain(telemetryPath('/home/u'));
    expect(text).toContain('用户级');
    expect(text).toContain('别人仓库的一份文件不该替你按下开关');
  });

  it('丢了行的时候把那一条的理由也报出来（丢是看得见的，不是静默）', async () => {
    const sink = createTelemetrySink({
      home: '/home/u',
      enabled: true,
      warn: () => {},
      mkdir: async () => {},
      append: async () => {},
    });
    const { $, dispatch, out } = await build({ sink });
    $.telemetry.log({ kind: '带 空 格' });
    await dispatch('command.run', { name: 'telemetry', args: [] }, CORE_ORIGIN);

    const text = out.join('\n');
    expect(text).toContain('丢了 1 条');
    expect(text).toContain('kind');
  });
});

describe('装配级', () => {
  const POLICY: ResolvedPolicy = {
    sources: [],
    policyRules: [],
    personalRules: [],
    sandbox: EMPTY_SANDBOX,
    compact: DEFAULT_COMPACT,
    memory: DEFAULT_MEMORY,
    telemetry: DEFAULT_TELEMETRY,
    plugins: { enable: [], enableByUser: [], deny: [] },
    instructions: [],
    gateway: {},
  };

  it('cliPlugins 的清单里有 telemetry，且它是第一方（不在第三方名单里）', async () => {
    const bundle = cliPlugins({
      mods: await modPlugins(),
      paneLoaded: true,
      render: createRenderer(),
      changes: createSessionChanges(),
      messages: [],
      root: process.cwd(),
      palette: createPalette(),
      env: {},
      policy: POLICY,
      home: '/home/u',
      sessionId: 's1',
      warn: () => {},
      agents: [],
      skills: [],
      baseSystemPrompt: '基础提示',
    });
    expect(bundle.plugins.map((plugin) => plugin.name)).toContain('telemetry');
    expect(bundle.thirdParty).not.toContain('telemetry');
    // 座位不用特殊给：它不裁决任何动作，默认的 builtin 就够。
    expect(bundle.seating.telemetry).toBeUndefined();
  });

  it('默认设置下它装配出来就是关着的 —— 没人按下开关就不该有遥测', async () => {
    // 与上一个用例同一条装配路径，只是拿 `DEFAULT_TELEMETRY` 去建引擎：
    // 关着的时候这个插件在链上存在，但一个系统调用都不发。
    const bundle = cliPlugins({
      mods: await modPlugins(),
      paneLoaded: true,
      render: createRenderer(),
      changes: createSessionChanges(),
      messages: [],
      root: process.cwd(),
      palette: createPalette(),
      env: {},
      policy: POLICY,
      home: '/home/u',
      sessionId: 's1',
      warn: () => {},
      agents: [],
      skills: [],
      baseSystemPrompt: '基础提示',
    });
    const telemetry = bundle.plugins.find((plugin) => plugin.name === 'telemetry');
    expect(telemetry?.uses).toContain('tool.result');
    expect(DEFAULT_TELEMETRY.enabled).toBe(false);
  });
});
