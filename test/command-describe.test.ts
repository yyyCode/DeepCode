import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import type { Message } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { createEngine } from '../src/core/create';
import { commandsPlugin } from '../src/builtins/commands';
import { createPermissionsCommand } from '../src/cli/permissions-command';
import { createSessionGrants } from '../src/builtins/permissions';
import { createSessionChanges } from '../src/cli/changes';
import { createSessionCommands, type CommandDescription } from '../src/cli/commands';
import { createPalette } from '../src/cli/ansi';
import type { ResolvedPolicy } from '../src/cli/settings';
import { createHarness, scriptedProvider, seat } from './harness';

/**
 * `command.describe` 转正（P4c-2）。
 *
 * ⚠️ 这一族此前**一个测试都没有** —— `/help` 这条斜杠命令的输出从来没被钉过
 * （`test/cli.test.ts` 里的 `help` 全是 `--help` 那个参数）。所以这里不只是"给新事件
 * 补用例"，也是把一条一直在裸奔的路径盖住。
 */

/**
 * 一个由注册面自答的 `command.list()`。
 *
 * 生产里就是这么实现的（`core/nouns/index.ts:67` 的
 * `registry.matcherValues('command.run', 'name')`）—— 照做，于是测试不用另抄一份名单，
 * `/help` 列出来的东西与注册面也永远一致。
 *
 * ⚠️ 用闭包延迟取 `h`：`createHarness` 要 engine，而 engine 要 `h.registry`。
 */
function registryEngine(logs: string[], notices: string[], tools: readonly string[] = []) {
  let h: ReturnType<typeof createHarness>;
  const engine = {
    ui: { log: (line: string) => logs.push(line), notice: (line: string) => notices.push(line) },
    command: { list: () => h.registry.matcherValues('command.run', 'name') },
    tool: { list: () => [...tools] },
  } as unknown as EngineInterface;
  return {
    engine,
    bind: (created: ReturnType<typeof createHarness>) => {
      h = created;
    },
  };
}

/** `/help` 那个注入点的生产实现（`main.ts` 里同一段），照抄来测真实行为。 */
function describer(h: ReturnType<typeof createHarness>) {
  return async (name: string): Promise<CommandDescription> => {
    try {
      const described = await h.dispatch('command.describe', { name }, CORE_ORIGIN);
      return 'hidden' in described
        ? { kind: 'hidden' }
        : {
            kind: 'described',
            description: described.description,
            ...(described.usage === undefined ? {} : { usage: described.usage }),
          };
    } catch {
      // core 那条 impl **抛**（"没注册描述"是故障，与 `tool.describe` 同形），
      // 在这里译成正常返回值，好让 `/help` 一边列名字一边提醒一声。
      return { kind: 'missing' };
    }
  };
}

const POLICY = {} as unknown as ResolvedPolicy;

/** 装齐三条来源：内建的 `/exit`、cli 侧四条、`/permissions`。 */
function full() {
  const logs: string[] = [];
  const notices: string[] = [];
  const { engine, bind } = registryEngine(logs, notices, ['Read', 'Write']);
  const h = createHarness({ engine });
  bind(h);

  const sessionPlugin: Plugin = createSessionCommands({
    changes: createSessionChanges(),
    messages: [] as Message[],
    root: process.cwd(),
    palette: createPalette(false),
    paneLoaded: false,
    compact: async () => {},
    describeCommand: (name) => describer(h)(name),
  });

  for (const plugin of [
    commandsPlugin,
    sessionPlugin,
    createPermissionsCommand({ policy: POLICY, palette: createPalette(false), grants: createSessionGrants() }),
  ]) {
    seat(h, plugin, 'builtin');
  }
  return { h, logs, notices };
}

/** 一条只会 run、没有 describe 的命令。 */
const BARE: Plugin = {
  name: 'bare',
  uses: ['command.run'],
  register(on) {
    on('command.run', { name: 'mystery' }, () => ({ handled: true }));
  },
};

describe('command.describe：每条命令都能自述', () => {
  it('注册面上每一条 command.run 都有对应的 command.describe', async () => {
    const { h } = full();
    const names = h.registry.matcherValues('command.run', 'name');
    expect(names.length).toBeGreaterThanOrEqual(6); // exit/help/diff/clear/compact/permissions

    for (const name of names) {
      const described = await h.dispatch('command.describe', { name }, CORE_ORIGIN);
      expect('description' in described, `/${name} 没有注册 describe`).toBe(true);
      const said = 'description' in described ? described.description : '';
      // 一句话，不是复述命令名 —— 后者等于没写。
      // ⚠️ 中文一个字就是一个 `.length`，最短的那条（"退出会话"）正好 4 ——
      // 门槛按汉字算，别按英文单词数去估。
      expect(said.length, `/${name} 的描述太短`).toBeGreaterThanOrEqual(4);
      expect(said).not.toBe(`/${name}`);
    }
  });
});

describe('/help：从一列名字变成名字加一句话', () => {
  it('输出里既有命令名，也有它那句话', async () => {
    const { h, logs } = full();
    expect(await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN)).toEqual({
      handled: true,
    });
    const out = logs.join('\n');
    expect(out).toContain('可用命令：');
    expect(out).toContain('/help');
    expect(out).toContain('列出可用的命令与工具');
    expect(out).toContain('/diff');
    expect(out).toContain('unified diff');
    expect(out).toContain('可用工具：Read  Write');
  });

  it('命令清单来自注册面 —— 多注册一条，/help 就多列一条', async () => {
    const extra: Plugin = {
      name: 'extra',
      uses: ['command.run', 'command.describe'],
      register(on) {
        on('command.run', { name: 'greet' }, () => ({ handled: true }));
        on('command.describe', { name: 'greet' }, () => ({ description: '打个招呼' }));
      },
    };
    const { h, logs } = full();
    seat(h, extra, 'builtin');
    await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN);
    expect(logs.join('\n')).toContain('/greet　打个招呼');
  });
});

describe('/help：三种 describe 结果分得开', () => {
  it('**没注册 describe** → 不炸，列裸名字，而且 notice 一声', async () => {
    // 关键：不能因为"忘了写 describe"就**不列这条命令** —— 那是这一族里最坏的失败方式
    // （命令存在，`/help` 里却找不到它）。与 `describeTools` 那条"故障要 warn"同一分寸。
    const { h, logs, notices } = full();
    seat(h, BARE, 'builtin');

    await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN);
    const out = logs.join('\n');
    expect(out).toContain('/mystery'); // 列出来了
    expect(out).not.toContain('/mystery　'); // 但后面没有那句话
    expect(notices.join('\n')).toContain('/mystery');
    expect(notices.join('\n')).toContain('没有注册 describe');
  });

  it('**hidden: true** → 列都不列（与上面那条是相反的处置）', async () => {
    const shy: Plugin = {
      name: 'shy',
      uses: ['command.run', 'command.describe'],
      register(on) {
        on('command.run', { name: 'secret' }, () => ({ handled: true }));
        on('command.describe', { name: 'secret' }, () => ({ hidden: true }) as const);
      },
    };
    const { h, logs, notices } = full();
    seat(h, shy, 'builtin');

    await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN);
    expect(logs.join('\n')).not.toContain('/secret');
    // 隐身是**主动**的，不是故障 —— 一个字都不该提醒。两条一起才说明"分得开"。
    expect(notices.join('\n')).not.toContain('secret');
  });

  it('usage 有就接在描述后面', async () => {
    const withUsage: Plugin = {
      name: 'with-usage',
      uses: ['command.run', 'command.describe'],
      register(on) {
        on('command.run', { name: 'foo' }, () => ({ handled: true }));
        on(
          'command.describe',
          { name: 'foo' },
          () => ({ description: '做点事', usage: 'foo <名字>' }) as const,
        );
      },
    };
    const { h, logs } = full();
    seat(h, withUsage, 'builtin');
    await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN);
    expect(logs.join('\n')).toContain('/foo　做点事　foo <名字>');
  });

  it('CLI 没注入 describer 时退化成裸名字，不炸', async () => {
    const logs: string[] = [];
    const notices: string[] = [];
    const { engine, bind } = registryEngine(logs, notices);
    const h = createHarness({ engine });
    bind(h);
    // 不给 describeCommand —— CLI 侧漏装时的形状。
    seat(
      h,
      createSessionCommands({
        changes: createSessionChanges(),
        messages: [] as Message[],
        root: process.cwd(),
        palette: createPalette(false),
        paneLoaded: false,
      }),
      'builtin',
    );

    expect(await h.dispatch('command.run', { name: 'help', args: [] }, CORE_ORIGIN)).toEqual({
      handled: true,
    });
    expect(logs.join('\n')).toContain('/help');
  });
});

describe('core 那一条：没注册描述就抛（不是给个空字符串）', () => {
  const engine = () =>
    createEngine({
      plugins: [],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

  it('真引擎上问一条没注册的命令 → 抛', async () => {
    // 与 `tool.describe` 同形（`src/core/create.ts:90-92`）。返回 `{description: ''}`
    // 会让"忘了写 describe"这件事彻底静默 —— 消费方就再也没有兜底的由头了。
    const lonely: Plugin = {
      name: 'lonely',
      uses: ['command.run'],
      register(on) {
        on('command.run', { name: 'orphan' }, () => ({ handled: true }));
      },
    };
    const { dispatch } = await createEngine({
      plugins: [lonely],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    await expect(dispatch('command.describe', { name: 'orphan' }, CORE_ORIGIN)).rejects.toThrow(
      /no description registered for command: orphan/,
    );
  });

  it('真引擎上问一条注册过的 → 拿到描述（上面那条不是把什么都抛了）', async () => {
    const { dispatch } = await createEngine({
      plugins: [commandsPlugin],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    expect(await dispatch('command.describe', { name: 'exit' }, CORE_ORIGIN)).toEqual({
      description: '退出会话',
    });
    // 而没注册的那条照样抛 —— 一条抛、一条不抛，说明走的是"有人应答"这条真路径。
    await expect(dispatch('command.describe', { name: 'nope' }, CORE_ORIGIN)).rejects.toThrow();
  });

  it('空引擎上什么都不注册时也抛（不是静默给个空清单）', async () => {
    const { dispatch } = await engine();
    await expect(dispatch('command.describe', { name: 'x' }, CORE_ORIGIN)).rejects.toThrow();
  });
});
