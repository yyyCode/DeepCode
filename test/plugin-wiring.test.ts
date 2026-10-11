import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import { cliPlugins } from '../src/cli/plugins';
import { createPalette } from '../src/cli/ansi';
import { renderPermissions } from '../src/cli/permissions-command';
import { createSessionChanges } from '../src/cli/changes';
import { createRenderer } from '../src/cli/render';
import type { ResolvedPolicy } from '../src/cli/settings';

const POLICY: ResolvedPolicy = {
  sources: [],
  policyRules: [],
  personalRules: [],
  plugins: { enable: [], deny: [] },
};

const THIRD: Plugin = { name: 'todo', uses: [], register: () => {} };

function bundle(overrides: Partial<Parameters<typeof cliPlugins>[0]> = {}) {
  return cliPlugins({
    render: createRenderer(),
    changes: createSessionChanges(),
    messages: [],
    root: process.cwd(),
    palette: createPalette(),
    policy: POLICY,
    home: '/home/u',
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

describe('/permissions 里看得见插件名单', () => {
  it('enable 与 deny 都列出来，带来源层', () => {
    const text = renderPermissions(
      {
        ...POLICY,
        plugins: {
          enable: [{ name: 'todo', source: 'project' }],
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
