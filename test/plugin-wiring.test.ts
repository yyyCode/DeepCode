import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { cliPlugins } from '../src/cli/plugins';
import { createPalette } from '../src/cli/ansi';
import { renderPermissions } from '../src/cli/permissions-command';
import { createSessionChanges } from '../src/cli/changes';
import { createRenderer } from '../src/cli/render';
import { createEngine } from '../src/core/create';
import { scriptedProvider } from './harness';
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
    agents: [],
    skills: [],
    baseSystemPrompt: '基础提示',
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
      const b = bundle({ root, home });
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
    );
    expect(text).toContain('todo');
    expect(text).toContain('[project]');
    expect(text).toContain('evil');
    expect(text).toContain('[policy]');
  });

  it('一条都没有时不打这一节（别给空白加标题）', () => {
    expect(renderPermissions(POLICY, createPalette())).not.toContain('插件');
  });
});
