import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHarness, scriptedProvider, seat } from './harness';
import { parseArgs, readVersion } from '../src/cli/args';
import { createPalette } from '../src/cli/ansi';
import { createSessionChanges } from '../src/cli/changes';
import { createSessionCommands } from '../src/cli/commands';
import { createPermissionsCommand } from '../src/cli/permissions-command';
import { streamPlugin } from '../src/cli/stream';
import { cliPlugins } from '../src/cli/plugins';
import { createTurnSignals } from '../src/cli/turns';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import type { CoreImpls } from '../src/core/dispatch';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Renderer } from '../src/cli/render';
import { DEFAULT_COMPACT, EMPTY_SANDBOX, type ResolvedPolicy } from '../src/cli/settings';
import type { EventHook, Plugin } from '../src/contract/plugin';
import type { Rule } from '../src/contract/policy';
import type { EngineInterface } from '../src/contract/engine';
import type { Message } from '../src/contract/model-provider';

/** 假 renderer：只把 delta 攒起来，好在断言里看到模型到底说出了什么。 */
function spyRenderer(): { render: Renderer; written: () => string } {
  let pending = '';
  return {
    render: {
      print: () => {},
      notice: () => {},
      ask: async () => 'n',
      delta: (text) => {
        pending += text;
      },
      newline: () => {},
      thinking: () => {},
    },
    written: () => pending,
  };
}

const NO_PLUGINS = { enable: [], deny: [] } as const;
/** policy 级的 plugins 段：比 SourceInfo 里那个 `PluginsLayer` 多一个 enableByUser。 */
const NO_PLUGIN_POLICY = { ...NO_PLUGINS, enableByUser: [] } as const;
const NO_POLICY: ResolvedPolicy = {
  sources: [],
  policyRules: [],
  personalRules: [],
  sandbox: EMPTY_SANDBOX,
  compact: DEFAULT_COMPACT,
  plugins: NO_PLUGIN_POLICY,
};
/** 真实清单里的 confirm 会问 `$.ui.ask`，不给 engine 桩的话整条链会炸。 */
const NOOP_UI = {
  ui: { log: () => {}, notice: () => {}, ask: async () => 'n' },
} as Partial<EngineInterface>;

describe('cli-stream：模型说的话必须到终端上', () => {
  it('turn.step 的每个增量都送进 renderer.delta', async () => {
    const { render, written } = spyRenderer();
    const h = createHarness();
    const plugin = streamPlugin(render);
    plugin.register(((pattern: string, second: any, third?: any) => {
      if (third !== undefined) h.on('builtin', plugin.name, pattern, second, third as EventHook);
      else h.on('builtin', plugin.name, pattern, second as EventHook);
    }) as any);

    await h.dispatch('turn.step', { delta: '改' }, CORE_ORIGIN);
    await h.dispatch('turn.step', { delta: '好了' }, CORE_ORIGIN);

    expect(written()).toBe('改好了');
  });

  it('没有这条 hook 时，turn.step 静默走兜底 —— 这就是"CLI 不会说话"的原始 bug', async () => {
    // 反向钉住上面那条测试的必要性：内核（NOTIFICATION_EVENTS 的链尾兜底）
    // 只会返回空答复，一个字都不会画。所以文本出口必须由插件提供，
    // 而 C1/C2 那批测试断言的是事件链和文件内容，看不见终端上有没有字。
    const h = createHarness();
    const result = await h.dispatch('turn.step', { delta: '改' }, CORE_ORIGIN);
    expect(result).toEqual({});
  });
});

describe('cli-turns：Ctrl-C 只掐断当前 turn', () => {
  it('被中断之后，下一个 turn 拿到的是干净的 signal', () => {
    const turns = createTurnSignals();

    const first = turns.begin();
    expect(first.aborted).toBe(false);

    turns.onSigint(); // 用户按了 Ctrl-C
    expect(first.aborted).toBe(true); // 当前这个 turn 被掐断
    expect(turns.current().aborted).toBe(true);
    turns.end();

    const second = turns.begin(); // 用户接着往下问
    expect(second.aborted).toBe(false); // 不被上一次中断连坐
    expect(turns.current()).toBe(second);
    turns.end();
  });
});

describe('cli 装配：真实内核 + CLI 插件清单', () => {
  it('模型的文本会走到 renderer 上（钉住 main.ts 用的那份清单）', async () => {
    // 这条是"CLI 不会说话"那个 bug 的回归测试：走真实 createEngine、真实 runTurn、
    // 以及 main.ts 真正装载的那份插件清单，断言文本确实出现在渲染器上。
    // 光有 cli-stream 的单测挡不住"清单里少装了它"。
    const { render, written } = spyRenderer();
    const provider = scriptedProvider([
      [{ type: 'text', text: '你好' }, { type: 'done', stopReason: 'end_turn' }],
    ]);

    const bundle = cliPlugins({
      render,
      changes: createSessionChanges(),
      messages: [],
      root: process.cwd(),
      palette: createPalette(false),
      policy: NO_POLICY,
      home: process.cwd(),
      agents: [],
      skills: [],
      baseSystemPrompt: '基础提示',
    });

    const built = await createEngine({
      plugins: bundle.plugins,
      seating: bundle.seating,
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
      sessionInfo: { id: 'cli-test', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });

    const messages: Message[] = [{ role: 'user', content: '打个招呼' }];
    await runTurn(
      {
        $: built.$,
        provider,
        signal: new AbortController().signal,
        dispatch: built.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(written()).toBe('你好');
  });

  it('cliPlugins 的座位表：sec-default 在 prepend，permissions 在 user', () => {
    const bundle = cliPlugins({
      render: spyRenderer().render,
      changes: createSessionChanges(),
      messages: [],
      root: process.cwd(),
      palette: createPalette(false),
      policy: NO_POLICY,
      home: process.cwd(),
      agents: [],
      skills: [],
      baseSystemPrompt: '基础提示',
    });

    expect(bundle.seating).toEqual({
      'plugin-guard': 'prepend',
      'sec-default': 'prepend',
      permissions: 'user',
    });
  });
});

describe('cliPlugins：清单的顺序契约与应答者（问注册面，不问下标）', () => {
  /**
   * 把 cliPlugins() 的产物按它自己的座位表装进 harness。
   *
   * 早先这里把一切都装在 'builtin' —— P2 之后那不再反映真实座位（sec-default 在
   * prepend、permissions 在 user），而"座位没生效"正是本轮最该被钉住的东西。
   */
  function registered(
    policy: ResolvedPolicy = NO_POLICY,
    engine: Partial<EngineInterface> = NOOP_UI,
    coreImpls: CoreImpls = {},
  ) {
    const { render } = spyRenderer();
    const bundle = cliPlugins({
      render,
      changes: createSessionChanges(),
      messages: [],
      root: process.cwd(),
      palette: createPalette(false),
      policy,
      home: process.cwd(),
      agents: [],
      skills: [],
      baseSystemPrompt: '基础提示',
    });

    const h = createHarness({ engine, coreImpls });
    for (const plugin of bundle.plugins) {
      seat(h, plugin, bundle.seating[plugin.name] ?? 'builtin');
    }
    return h;
  }

  it('session-changes 必须排在 tool-write / tool-edit 之前 —— 顺序即契约', () => {
    // 反向钉住 plugins.ts 里 createChangesPlugin 与 ...coreTools 那两行的**先后**。
    // 同 tier 内先装载者在外层，而 session-changes 要在工具自己的 hook 跑之前抢到文件的
    // "原样"。调个个儿之后它落进 coreTools 之后，next 回来时文件已经写完，before 成了
    // after 的副本，/diff 永远空白 —— 而 typecheck / lint / 全量测试全都照常通过。
    // 这里问注册面拿 hooksFor 的顺序，不碰数组下标：重排清单里任何无关的一项都不会误伤。
    const h = registered();

    for (const [tool, plugin] of [
      ['Write', 'tool-write'],
      ['Edit', 'tool-edit'],
    ] as const) {
      const order = h.registry.hooksFor('tool.call', { tool }).map((r) => r.plugin);
      const changesAt = order.indexOf('session-changes');
      const toolAt = order.indexOf(plugin);
      expect(changesAt).toBeGreaterThanOrEqual(0); // 它确实应答了这个工具
      expect(toolAt).toBeGreaterThanOrEqual(0); // 工具也确实应答了
      expect(changesAt).toBeLessThan(toolAt); // 且在外层
    }
  });

  it('/diff 与 /clear 都有应答者（漏装的话命令静默失效）', () => {
    // 同类"插件漏装"的静默失效：清单里少了 createSessionCommands，/diff、/clear 就没人应答，
    // command.run 走 core 兜底返回 handled:false，人肉点命令才会发现 ——
    // 而 typecheck / lint / 其余测试全绿。这里同样问注册面，把两个名字钉死。
    const h = registered();
    const responders = (name: string) =>
      h.registry.hooksFor('command.run', { name }).map((r) => r.plugin);

    expect(responders('diff')).toContain('session-commands');
    expect(responders('clear')).toContain('session-commands');
  });

  it('真实装配下 tool.check 的应答顺序：prepend → user → builtin', () => {
    const h = registered();
    expect(h.registry.hooksFor('tool.check', {}).map((r) => [r.plugin, r.tier])).toEqual([
      ['sec-default', 'prepend'],
      ['permissions', 'user'],
      ['confirm', 'builtin'],
    ]);
  });

  it('托管 deny 压过个人 allow —— 端到端一遍（出口标准 1）', async () => {
    // 链上走三步：confirm 对 Bash 给 ask → 个人规则 allow: ["Bash"] 把它放宽成 allow
    // → sec-default 拿托管策略的 deny 压回去。个人规则掀不翻托管 deny。
    //
    // 这条直接 dispatch tool.check、**不经过 loop**；而"用户按 y"那一步是 loop 干的
    // （拿到 ask 裁决后才去问，见 core/loop.ts），confirm 自己从不问人 —— 所以这里
    // 压根没有"用户一路按 y"这回事，引擎用默认的 NOOP_UI（ask → 'n'）。
    // （原稿那句"引擎换成什么都答 y"是错的：那个 ask 桩一次都不会被走到。）
    // "就算按 y 也压不住"由 C3 的真终端手工验收第 2 步覆盖。
    const h = registered(
      {
        sources: [],
        policyRules: [
          { raw: 'Bash(git push:*)', tool: 'Bash', content: 'git push:*', decision: 'deny' },
        ],
        personalRules: [{ raw: 'Bash', tool: 'Bash', decision: 'allow' }],
        sandbox: EMPTY_SANDBOX,
        compact: DEFAULT_COMPACT,
        plugins: NO_PLUGIN_POLICY,
      },
      NOOP_UI,
      // 真实内核的 tool.check 兜底是 fail-closed 的 deny，这里照抄一份：
      // 链尾不论走到哪，答案都只可能来自 confirm 或规则，不会来自一个空实现。
      { 'tool.check': () => ({ decision: 'deny', rule: 'fail-closed' }) as const },
    );

    expect(
      await h.dispatch(
        'tool.check',
        { tool: 'Bash', input: { command: 'git push origin main' }, toolUseId: 'tu_1' },
        CORE_ORIGIN,
      ),
    ).toEqual({ decision: 'deny', rule: 'Bash(git push:*)' });
  });
});

describe('cli 参数：开关不能被当成话发给模型', () => {
  it('--help / -h 是看用法', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('--version / -V 是看版本（不是 -v，那个字母留给 verbose）', () => {
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-V'])).toEqual({ kind: 'version' });
  });

  it('没认出来的 argv 原样拼成提示词 —— 这才是主要用法', () => {
    expect(parseArgs(['给', 'utils.ts', '加个时区'])).toEqual({
      kind: 'prompt',
      text: '给 utils.ts 加个时区',
      resume: { kind: 'none' },
    });
    expect(parseArgs([])).toEqual({ kind: 'prompt', text: '', resume: { kind: 'none' } });
  });

  it('--resume（无值）接上当前目录最近一次会话', () => {
    expect(parseArgs(['--resume'])).toEqual({
      kind: 'prompt',
      text: '',
      resume: { kind: 'latest' },
    });
  });

  it('--resume=<id> 接上指定会话', () => {
    const action = parseArgs(['--resume=abc']);
    expect(action).toEqual({ kind: 'prompt', text: '', resume: { kind: 'id', id: 'abc' } });
  });

  it('--resume= 空值退化成 latest', () => {
    expect(parseArgs(['--resume='])).toEqual({
      kind: 'prompt',
      text: '',
      resume: { kind: 'latest' },
    });
  });

  it('--resume 后面的裸 token 是提示词，不是 id（只认等号形态）', () => {
    // 反向钉住：写成"--resume 后面跟一个裸 token"的话，
    // `deepcode --resume 继续修` 里那句话到底是 id 还是提示词就分不开了。
    const action = parseArgs(['--resume', '继续修测试']);
    if (action.kind !== 'prompt') throw new Error('expected prompt');
    expect(action.text).toBe('继续修测试');
    expect(action.resume.kind).toBe('latest');
  });

  it('--resume 开关本身不进提示词', () => {
    const action = parseArgs(['把', '--resume', '这个', '改了']);
    if (action.kind !== 'prompt') throw new Error('expected prompt');
    expect(action.text).toBe('把 这个 改了');
  });

  it('--settings=<路径> 被认出来，并从提示词里摘掉', () => {
    expect(parseArgs(['--settings=/etc/x.json', '改一下 X'])).toEqual({
      kind: 'prompt',
      text: '改一下 X',
      resume: { kind: 'none' },
      settings: '/etc/x.json',
    });
  });

  it('裸 --settings 是普通提示词文本，不是开关', () => {
    expect(parseArgs(['--settings', 'foo'])).toEqual({
      kind: 'prompt',
      text: '--settings foo',
      resume: { kind: 'none' },
      settings: undefined,
    });
  });

  it('--settings= 空值等于没给', () => {
    expect(parseArgs(['--settings='])).toEqual({
      kind: 'prompt',
      text: '',
      resume: { kind: 'none' },
      settings: undefined,
    });
  });

  it('--help 优先于 --resume', () => {
    expect(parseArgs(['--help', '--resume'])).toEqual({ kind: 'help' });
  });

  it('两个开关同时给时，先给用法', () => {
    expect(parseArgs(['--version', '--help'])).toEqual({ kind: 'help' });
  });

  it('readVersion 报的是 package.json 里那个号', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('真跑一遍 bin：没有 key、没有配置时，--help 也该只打用法', async () => {
    // 反向钉住这个 bug：开关若又漏成提示词，这一步会走进"要 key"的分支，
    // 以非零码退出（execFile 会 reject），测试就红了。
    // 把 HOME/USERPROFILE 指到不存在的目录，顺便保证它**不会**真的去调模型 ——
    // 免得哪天这个开关真的坏了，测试却替你花掉一次 API 调用。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: resolve(process.cwd(), 'no', 'such', 'home'),
      HOME: resolve(process.cwd(), 'no', 'such', 'home'),
    };
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_BASE_URL',
      'DEEPCODE_MODEL',
      'DEEPCODE_DEBUG',
    ]) {
      delete env[name];
    }

    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve(process.cwd(), 'bin', 'deepcode.mjs'), '--help'],
      { cwd: process.cwd(), env },
    );

    expect(stdout).toContain('用法');
    expect(stdout).toContain('/exit');
  }, 60_000);

  it('真跑一遍 bin：没有可接的会话时 --resume 非零退出并说清楚', async () => {
    // 端到端钉住 --resume 的**顺序**：它必须发生在"缺 key"之后、建引擎之前。
    // 所以这里给一个假的 API key —— 否则会先报缺 key，就走不到"找会话"这一步，
    // 这条测试也就测不到它想测的东西。
    const home = mkdtempSync(join(tmpdir(), 'deepcode-resume-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-resume-test',
      };
      // 清掉会改变配置解析的变量（假 key 留着，见上）。
      for (const name of [
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_BASE_URL',
        'DEEPCODE_MODEL',
        'DEEPCODE_DEBUG',
        'DEEPCODE_PROVIDER',
      ]) {
        delete env[name];
      }

      let code = 0;
      const { stderr } = await promisify(execFile)(
        process.execPath,
        [resolve(process.cwd(), 'bin', 'deepcode.mjs'), '--resume'],
        { cwd: process.cwd(), env },
      ).catch((error: any) => {
        code = error.code ?? 1;
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      });

      // 空 home 里没有会话 → 非零退出，并列出"能接的"（含找不到时找的是哪个目录）。
      expect(code).not.toBe(0);
      expect(stderr).toContain('可以接上的会话');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('cli 命令：/diff 与 /clear', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** 真临时目录 + 真 SessionChanges + 把消息收进 logs 的假 $。 */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'deepcode-cmd-'));
    roots.push(root);

    const changes = createSessionChanges();
    const messages: Message[] = [];
    const logs: string[] = [];
    const engine = {
      ui: { log: (line: string) => logs.push(line), notice: () => {}, ask: async () => 'n' },
    };
    const h = createHarness({ engine });

    // 照 streamPlugin 那条测试的写法把插件挂进 harness 的注册面。
    const plugin: Plugin = createSessionCommands({
      changes,
      messages,
      root,
      palette: createPalette(false),
    });
    plugin.register(((pattern: string, second: any, third?: any) => {
      if (third !== undefined) h.on('builtin', plugin.name, pattern, second, third as EventHook);
      else h.on('builtin', plugin.name, pattern, second as EventHook);
    }) as any);

    return { root, changes, messages, logs, h };
  }

  const run = (h: ReturnType<typeof setup>['h'], name: string) =>
    h.dispatch('command.run', { name, args: [] }, CORE_ORIGIN);

  it('没有改动过时，/diff 明说"还没有改动过文件"', async () => {
    const { h, logs } = setup();
    const result = await run(h, 'diff');
    expect(result).toEqual({ handled: true });
    expect(logs.join('\n')).toContain('还没有改动过文件');
  });

  it('新建文件带内容改动 → 输出 unified diff（+++ b/ 与新行）', async () => {
    const { h, changes, root, logs } = setup();
    changes.record({
      path: join(root, 'a.ts'),
      before: { kind: 'absent' },
      after: { kind: 'text', text: 'const a = 1;\n' },
    });

    expect(await run(h, 'diff')).toEqual({ handled: true });
    const out = logs.join('\n');
    expect(out).toContain('+++ b/');
    expect(out).toContain('\n+const a = 1;');
  });

  it('写了一遍但一字未变 → "没有净改动"，不打空 diff', async () => {
    const { h, changes, root, logs } = setup();
    changes.record({
      path: join(root, 'b.ts'),
      before: { kind: 'text', text: 'same\n' },
      after: { kind: 'text', text: 'same\n' },
    });

    await run(h, 'diff');
    expect(logs.join('\n')).toContain('没有净改动');
  });

  it('内容 skipped → 说清"未记录内容"而不是假装没改', async () => {
    const { h, changes, root, logs } = setup();
    changes.record({
      path: join(root, 'huge.bin'),
      before: { kind: 'text', text: 'x' },
      after: { kind: 'skipped', why: '文件太大' },
    });

    await run(h, 'diff');
    expect(logs.join('\n')).toContain('未记录内容');
  });

  it('/clear 就地清空 messages（同一个数组引用）并回 handled', async () => {
    const { h, messages, logs } = setup();
    messages.push({ role: 'user', content: '一' });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: '二' }] });
    messages.push({ role: 'user', content: '三' });

    const result = await run(h, 'clear');

    expect(result).toEqual({ handled: true });
    expect(messages.length).toBe(0); // 清的是 REPL 手里那个同一个引用
    expect(logs.join('\n')).toContain('已清空上下文');
  });
});

describe('cli 命令：/permissions 把生效的权限摊开', () => {
  /** 手搓一份快照 —— /permissions 的输出要可确定，所以这里不读文件。 */
  function fixturePolicy(): ResolvedPolicy {
    const deny = (text: string, tool: string, content?: string): Rule => ({
      raw: text,
      tool,
      decision: 'deny',
      ...(content === undefined ? {} : { content }),
    });
    return {
      sources: [
        { source: 'user', path: 'C:\\Users\\x\\.deepcode\\settings.json', state: 'ok',
          counts: { allow: 1, ask: 0, deny: 0 },
          problems: [], rules: [{ raw: 'Read', tool: 'Read', decision: 'allow' }], plugins: NO_PLUGINS },
        { source: 'project', path: 'F:\\p\\.deepcode\\settings.json', state: 'missing',
          counts: { allow: 0, ask: 0, deny: 0 }, problems: [], rules: [], plugins: NO_PLUGINS },
        { source: 'local', path: 'F:\\p\\.deepcode\\settings.local.json', state: 'ok',
          counts: { allow: 0, ask: 0, deny: 1 },
          problems: ['deny: "Bash(git push" —— 括号不配对'],
          rules: [deny('Bash(git push:*)', 'Bash', 'git push:*')], plugins: NO_PLUGINS },
        { source: 'flag', path: undefined, state: 'missing',
          counts: { allow: 0, ask: 0, deny: 0 }, problems: [], rules: [], plugins: NO_PLUGINS },
        { source: 'policy', path: 'C:\\Program Files\\DeepCode\\managed-settings.json', state: 'ok',
          counts: { allow: 0, ask: 0, deny: 2 },
          problems: [], rules: [deny('Bash(git push:*)', 'Bash', 'git push:*'), deny('WebSearch', 'WebSearch')], plugins: NO_PLUGINS },
      ],
      policyRules: [deny('Bash(git push:*)', 'Bash', 'git push:*'), deny('WebSearch', 'WebSearch')],
      personalRules: [
        { raw: 'Read', tool: 'Read', decision: 'allow' },
        deny('Bash(git push:*)', 'Bash', 'git push:*'),
      ],
      sandbox: EMPTY_SANDBOX,
      compact: DEFAULT_COMPACT,
      plugins: NO_PLUGIN_POLICY,
    };
  }

  it('/permissions 打出五层、规则来源、隐藏的工具与坏规则', async () => {
    const lines: string[] = [];
    const engine = { ui: { log: (line: string) => lines.push(line) } } as unknown as EngineInterface;
    const h = createHarness({ engine });
    seat(h, createPermissionsCommand({ policy: fixturePolicy(), palette: createPalette(false) }), 'builtin');

    expect(await h.dispatch('command.run', { name: 'permissions', args: [] }, CORE_ORIGIN)).toEqual({ handled: true });

    const out = lines.join('\n');
    expect(out).toContain('权限来源（低 → 高）');
    expect(out).toContain('C:\\Program Files\\DeepCode\\managed-settings.json'); // 托管文件的真实路径
    expect(out).toContain('← 托管');
    expect(out).toContain('--settings 未给');
    expect(out).toContain('生效规则');
    expect(out).toContain('[policy]');                       // 每条规则的来源
    expect(out).toContain('隐藏的工具');
    expect(out).toContain('WebSearch');
    expect(out).toContain('有问题、未生效的规则');
    expect(out).toContain('括号不配对');
  });

  it('/permissions 在没有任何规则时说清楚"都在走最小确认"', async () => {
    const lines: string[] = [];
    const engine = { ui: { log: (line: string) => lines.push(line) } } as unknown as EngineInterface;
    const h = createHarness({ engine });
    const empty: ResolvedPolicy = {
      sources: [],
      policyRules: [],
      personalRules: [],
      sandbox: EMPTY_SANDBOX,
      compact: DEFAULT_COMPACT,
      plugins: NO_PLUGIN_POLICY,
    };
    seat(h, createPermissionsCommand({ policy: empty, palette: createPalette(false) }), 'builtin');

    await h.dispatch('command.run', { name: 'permissions', args: [] }, CORE_ORIGIN);

    const out = lines.join('\n');
    expect(out).toContain('一条都没有');
    expect(out).not.toContain('隐藏的工具');
    expect(out).not.toContain('有问题');
  });
});

describe('真跑一遍 bin：自带插件的清单都过 validate', () => {
  // 与上面 --help 那条同一个用意：清掉会改变配置解析的变量，
  // 顺便**再钉一遍顺序** —— plugin 子命令必须发生在"要 key"之前，
  // 否则下面两步会在干净环境（CI）里报"缺少 API key"，而不是校验清单。
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'DEEPCODE_MODEL',
    'DEEPCODE_PROVIDER',
  ]) {
    delete env[name];
  }

  // 这两个目录是**仓库自己发出的插件**，也就是 P3 出口标准里那两条演示用的。
  // 它们此前从没被任何检查跑过 —— 这正是「校验器进 CI」那一格欠着的意思。
  for (const dir of ['./plugins/todo', './plugins/secret-guard']) {
    it(`${dir} 的清单没问题`, async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [resolve(process.cwd(), 'bin', 'deepcode.mjs'), 'plugin', 'validate', dir],
        { cwd: process.cwd(), env },
      );

      expect(stdout).toContain('清单没问题');
      // 这一句是防"空转"的：validate 必须真的读了那个目录，
      // 而不是因为路径写错落到别处、恰好也没报错。
      expect(stdout).toContain(resolve(process.cwd(), dir));
    }, 60_000);
  }
});
