import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { cliPlugins } from '../src/cli/plugins';
import { createPalette } from '../src/cli/ansi';
import { renderPermissions } from '../src/cli/permissions-command';
import { createSessionGrants } from '../src/builtins/permissions';
import { createSessionChanges } from '../src/cli/changes';
import { createRenderer } from '../src/cli/render';
import { createEngine } from '../src/core/create';
import { modPlugins, scriptedProvider } from './harness';
import {
  DEFAULT_COMPACT,
  DEFAULT_TELEMETRY,
  EMPTY_SANDBOX,
  type ResolvedPolicy,
} from '../src/cli/settings';

const POLICY: ResolvedPolicy = {
  sources: [],
  policyRules: [],
  personalRules: [],
  sandbox: EMPTY_SANDBOX,
  compact: DEFAULT_COMPACT,
  telemetry: DEFAULT_TELEMETRY,
  plugins: { enable: [], enableByUser: [], deny: [] },
  instructions: [],
  gateway: {},
};

const THIRD: Plugin = { name: 'todo', uses: [], register: () => {} };

function bundle(overrides: Partial<Parameters<typeof cliPlugins>[0]> = {}) {
  return cliPlugins({
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
    // 这一组钉的是**转盘结构**（谁在外层、座位、豁免名单），内建 mod 的名册
    // 由下面那条真装的用例单独钉 —— 两边各管各的，谁也不假装覆盖了对方。
    mods: [],
    // 默认这一组钉的是**转盘结构**，内建 mod 一个都不在场 ——
    // 于是 `/diff` 由 CLI 自己应答（这正是没有 git 的那台机器上的形状）。
    // 真装的那两条用例会把它改成 `true`。
    paneLoaded: false,
    ...overrides,
  });
}

describe('转盘：谁在链上、坐在哪', () => {
  it('plugin-guard 排在最前，坐在 prepend', () => {
    const b = bundle();
    expect(b.plugins[0]?.name).toBe('plugin-guard');
    expect(b.seating['plugin-guard']).toBe('prepend');
  });

  it('发现来的插件排在最后，且被标成第三方', () => {
    const b = bundle({ discovered: [THIRD] });
    expect(b.plugins.at(-1)?.name).toBe('todo');
    expect(b.thirdParty).toEqual(['todo']);
  });

  it('没有发现到插件时 thirdParty 是空的 —— 第一方一个都不在名单里', () => {
    expect(bundle().thirdParty).toEqual([]);
  });

  it('deny 名单交给 guard 拿着，而不是自己判', () => {
    const b = bundle({ pluginDeny: [{ name: 'todo', source: 'policy' }] });
    // guard 收到了规则：它在注册面上是唯一一个带 plugin.register 的第一方插件。
    const guard = b.plugins[0];
    expect(guard?.uses).toContain('plugin.register');
  });
});

describe('指令文件真的是从链上来的', () => {
  it('装配清单里有一个 instructions，读到的 AGENTS.md 经 prompt.section 交出来', async () => {
    // 这条测的是**装配**而不是插件本身（插件自己的用例在 prompt-section.test.ts）：
    // 拔掉 cli/plugins.ts 里那一行，指令文件就不再进系统提示 —— 那正是 P4d 把这段
    // 从 main.ts 的 loadInstructions 搬进事件的全部意义，也必须是可测的意义。
    const root = await mkdtemp(join(tmpdir(), 'deepcode-wiring-'));
    const home = await mkdtemp(join(tmpdir(), 'deepcode-wiring-home-'));
    try {
      await writeFile(join(root, 'AGENTS.md'), '这个项目只用 pnpm。', 'utf8');
      // `mods` 要按这条用例自己的 root / home 真装一次 —— 指令文件的路径就从它来。
      const b = bundle({ root, home, mods: await modPlugins({ root, home }), paneLoaded: true });
      expect(b.plugins.map((plugin) => plugin.name)).toContain('instructions');

      const { dispatch } = await createEngine({
        plugins: b.plugins,
        thirdParty: b.thirdParty,
        seating: b.seating as never,
        signal: () => new AbortController().signal,
        provider: scriptedProvider([]),
        ui: { print: () => {}, notice: () => {}, ask: async () => '' },
        sessionInfo: { id: 's1', cwd: root, root },
        env: {},
      });
      const result = await dispatch('prompt.section', {}, CORE_ORIGIN);
      const text = result.sections.map((section) => section.text).join('\n');
      expect(text).toContain('这个项目只用 pnpm。');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('托管下发的指令走 `ModDeps` 进来，一路到 prompt.section', async () => {
    // P5b：`main.ts` 把 `policy.instructions` 塞进 `ModDeps`，`agents-md` 那个 mod
    // 把它拼在最后。这条钉的是**那条路是通的** —— 少接一根线，托管下发就静默失效，
    // 而除了这一条，没有任何东西会红。
    const root = await mkdtemp(join(tmpdir(), 'deepcode-wiring-managed-'));
    const home = await mkdtemp(join(tmpdir(), 'deepcode-wiring-managed-home-'));
    try {
      const b = bundle({
        root,
        home,
        mods: await modPlugins({
          root,
          home,
          managedInstructions: [{ label: '/etc/deepcode/policy.md', text: '组织下发的口令：Zx9' }],
        }),
        paneLoaded: true,
      });

      const { dispatch } = await createEngine({
        plugins: b.plugins,
        thirdParty: b.thirdParty,
        seating: b.seating as never,
        signal: () => new AbortController().signal,
        provider: scriptedProvider([]),
        ui: { print: () => {}, notice: () => {}, ask: async () => '' },
        sessionInfo: { id: 's1', cwd: root, root },
        env: {},
      });
      const result = await dispatch('prompt.section', {}, CORE_ORIGIN);
      const text = result.sections.map((section) => section.text).join('\n');
      expect(text).toContain('组织下发的口令：Zx9');
      expect(text).toContain('/etc/deepcode/policy.md');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('第一方名单不会漂', () => {
  it('托管策略点名**任何一个**第一方插件，guard 都忽略它', async () => {
    // 计划里这条写的是"只能手工验"。手工验过之后发现它**能**被测 —— 见 C3 执行记录：
    // 把 `firstParty: names` 改写成硬编码的 `['sec-default']` 之后，`plugin-wiring` 与
    // `plugin-guard` 两个文件 10 条全绿（名单漂了的时候测试恰好是绿的），但真的拿
    // `permissions` 去注册就会当场被拒 —— 也就是承重墙被一份写死的名单拆了。
    // 逐一点名每一个第一方插件就把这个性质钉住了：名单一旦漂，没被写进死名单的那个当场红。
    const firstParty = bundle().plugins.map((plugin) => plugin.name);
    for (const name of firstParty) {
      const b = bundle({ pluginDeny: [{ name, source: 'policy' }] });
      const { dispatch } = await createEngine({
        plugins: b.plugins,
        thirdParty: b.thirdParty,
        seating: b.seating as never,
        signal: () => new AbortController().signal,
        provider: scriptedProvider([]),
        ui: { print: () => {}, notice: () => {}, ask: async () => '' },
        sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
        env: {},
      });
      const verdict = await dispatch(
        'plugin.register',
        { name, tier: 'user', uses: [] },
        CORE_ORIGIN,
      );
      expect(verdict, `${name} 是 CLI 自带的插件，不该被托管策略关掉`).not.toHaveProperty('refuse');
    }
  });

  it('反过来：点名一个不在名单里的，照样拒 —— 证明上一条测的是豁免而不是"谁都不拦"', async () => {
    const b = bundle({ pluginDeny: [{ name: 'evil', source: 'policy' }] });
    const { dispatch } = await createEngine({
      plugins: b.plugins,
      thirdParty: b.thirdParty,
      seating: b.seating as never,
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });
    const verdict = await dispatch('plugin.register', { name: 'evil', tier: 'user', uses: [] }, CORE_ORIGIN);
    expect(verdict).toHaveProperty('refuse');
  });
});

describe('/permissions 里看得见插件名单', () => {
  it('enable 与 deny 都列出来，带来源层', () => {
    const text = renderPermissions(
      {
        ...POLICY,
        plugins: {
          enable: [{ name: 'todo', source: 'project' }],
          enableByUser: [],
          deny: [{ name: 'evil', source: 'policy' }],
        },
      },
      createPalette(),
      createSessionGrants(),
    );
    expect(text).toContain('todo');
    expect(text).toContain('[project]');
    expect(text).toContain('evil');
    expect(text).toContain('[policy]');
  });

  it('一条都没有时不打这一节（别给空白加标题）', () => {
    expect(renderPermissions(POLICY, createPalette(), createSessionGrants())).not.toContain('插件');
  });
});

describe('内建 mod：真的装进来了，且是第一方', () => {
  it('四个内建 mod 的插件都在清单里，且一个都不在第三方名单里', async () => {
    // P5a 之后内建 mod 从 `loadMods` 进来（`main.ts` 那条路），这条用例走的就是它。
    // 钉两件事：
    // 1. 名字真的在 —— 少一个就是一次静默失效（`/telemetry` 没人应答、指令文件不进提示）；
    // 2. 都不在 `thirdParty` 里 —— 第一方豁免成立，否则一份个人配置里的
    //    `plugins.deny: ["sec-default"]` 就能把权限模型的承重墙拆了（P2 的 C3 实测过）。
    const mods = await modPlugins();
    const b = bundle({ mods, paneLoaded: true });

    for (const name of ['sec-default', 'instructions', 'agents-md', 'telemetry', 'diff-pane']) {
      expect(b.plugins.map((plugin) => plugin.name)).toContain(name);
      expect(b.thirdParty).not.toContain(name);
    }
  });

  it('sec-default 仍坐 prepend，且排在 plugin-guard 之后', async () => {
    // 归位到 mods/ 是**纯物理移动**，这条钉住它没有顺手改掉座位。
    // 它是权限模型那一侧的承重墙，P2 的 C3 变异测试专门验过这一条。
    const b = bundle({ mods: await modPlugins(), paneLoaded: true });
    expect(b.plugins[0]?.name).toBe('plugin-guard');
    expect(b.plugins[1]?.name).toBe('sec-default');
    expect(b.seating['sec-default']).toBe('prepend');
  });
});
