import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import { createConfigCommand, renderEntries } from '../src/cli/config-command';
import { createEngine } from '../src/core/create';
import { createHarness, scriptedProvider, seat } from './harness';

/**
 * `config-command`：`/config` 命令 + `config.describe` / `config.set` 两个事件的应答者。
 *
 * ⚠️ 这里**用真磁盘**，不给假磁盘替身 —— 插件只把 `home` 递进去，注入点根本没有
 * （那是它该有的性质：谁也用命令改不到别处的配置）。真落盘顺带把
 * "文件真的变了 / 真的没被动"钉成端到端的事实，而不是"我传进去的假写入器收到了什么"。
 */

const KEY = 'sk-ant-api03-abcdefghijklmn';

/** 一个用户级目录 + 一个**空**的根目录（根目录要有自己的临时位置，免得读到本仓库的 .deepcode）。 */
async function world(userConfig?: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), 'deepcode-cfg-home-'));
  const root = await mkdtemp(join(tmpdir(), 'deepcode-cfg-root-'));
  if (userConfig !== undefined) {
    await mkdir(join(home, '.deepcode'), { recursive: true });
    await writeFile(join(home, '.deepcode', 'config.json'), JSON.stringify(userConfig));
  }

  const logs: string[] = [];
  const engine = { ui: { log: (line: string) => logs.push(line) } } as unknown as EngineInterface;
  const h = createHarness({ engine });
  const plugin = createConfigCommand({ home, root, env: {} });
  seat(h, plugin, 'builtin');

  const file = join(home, '.deepcode', 'config.json');
  const read = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

  return {
    h,
    logs,
    plugin,
    file,
    read,
    async cleanup() {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('config.describe：真插件走一遍', () => {
  it('entries 非空、含 model，且没有任何一条带着完整的 apiKey', async () => {
    const w = await world({ model: 'claude-opus-5-5', apiKey: KEY });
    try {
      const { entries } = await w.h.dispatch('config.describe', {}, CORE_ORIGIN);

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.map((e) => e.key)).toContain('model');
      expect(entries.find((e) => e.key === 'model')?.value).toBe('claude-opus-5-5');
      expect(entries.find((e) => e.key === 'model')?.writable).toBe(true);

      // 打码是这个事件的承重部分：它会被打在一个用户天天看的清单里。
      const apiKey = entries.find((e) => e.key === 'apiKey');
      expect(apiKey?.value).not.toContain('abcdefghijklmn');
      expect(JSON.stringify(entries)).not.toContain(KEY);
    } finally {
      await w.cleanup();
    }
  });

  it('链尾没人应答时是**空清单**（能力方向的 fail-closed，不是抛）', async () => {
    // 空引擎上没有这个事件的应答者，coreImpls 那条兜底给 `{entries: []}`。
    const { dispatch } = await createEngine({
      plugins: [],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    expect(await dispatch('config.describe', {}, CORE_ORIGIN)).toEqual({ entries: [] });
    // 同一个引擎上，config.set 那条兜底走**反方向** —— 拒绝，不静默成功。
    expect(await dispatch('config.set', { key: 'model', value: 'x' }, CORE_ORIGIN)).toEqual({
      ok: false,
      error: 'fail-closed: 没有 hook 应答 config.set',
    });
  });
});

describe('config.set：能改的与改不动的', () => {
  it('写 model → ok: true，磁盘上的文件真的变了', async () => {
    const w = await world({ apiKey: KEY, model: '旧的' });
    try {
      expect(await w.h.dispatch('config.set', { key: 'model', value: 'claude-opus-5-5' }, CORE_ORIGIN)).toEqual(
        { ok: true, path: w.file },
      );

      expect(await w.read()).toEqual({ apiKey: KEY, model: 'claude-opus-5-5' });
    } finally {
      await w.cleanup();
    }
  });

  it('写 baseUrl → ok: false，错误里点得到 baseUrl，而且文件一个字节没动', async () => {
    const w = await world({ model: '旧的' });
    try {
      const before = await readFile(w.file, 'utf8');
      const verdict = await w.h.dispatch('config.set', { key: 'baseUrl', value: 'https://x.example' }, CORE_ORIGIN);

      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.error).toContain('baseUrl');
      expect(await readFile(w.file, 'utf8')).toBe(before);
    } finally {
      await w.cleanup();
    }
  });

  it('写 permissions.allow → 拒，理由是它是**设置**不是连接配置', async () => {
    const w = await world({ model: '旧的' });
    try {
      const verdict = await w.h.dispatch(
        'config.set',
        { key: 'permissions.allow', value: 'Bash' },
        CORE_ORIGIN,
      );

      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.error).toContain('permissions.allow');
      expect(verdict.error).toContain('设置');
      expect(await w.read()).toEqual({ model: '旧的' });
    } finally {
      await w.cleanup();
    }
  });
});

describe('/config：一屏清单', () => {
  it('ui.log 收到的那一屏里有 model 与「可改」两个字', async () => {
    const w = await world({ model: 'claude-opus-5-5' });
    try {
      expect(await w.h.dispatch('command.run', { name: 'config', args: [] }, CORE_ORIGIN)).toEqual({
        handled: true,
      });
      const screen = w.logs.join('\n');
      expect(screen).toContain('model');
      expect(screen).toContain('可改');
      expect(screen).toContain('claude-opus-5-5');
      // 不可写的那几行**不带**这个标记 —— 带上了就等于说"这也能改"。
      expect(screen.split('\n').find((line) => line.includes('apiKey'))).not.toContain('可改');
    } finally {
      await w.cleanup();
    }
  });

  it('空清单要说出来，不能只打一个标题（那与"什么都没配"长得一样）', () => {
    const screen = renderEntries([]);
    expect(screen).toContain('没有 hook 应答');
    expect(screen).not.toContain('连接配置：\n');
  });
});

describe('uses：注册了的事件一个都不能漏', () => {
  it('插件实际注册的每个事件都在 uses 里', () => {
    // ⚠️ 第一方插件**不受**装载期那道核（`core/third-party.ts` 只核第三方名单），
    // 所以漏一个 `uses` 一声不响 —— 而 `uses` 是给人看的"这个插件碰了哪些事件"。
    // 这条把那份自述和实际注册面对起来钉。
    const h = createHarness();
    const plugin = createConfigCommand({ home: '/h', root: '/r', env: {} });
    seat(h, plugin, 'builtin');

    const registered = h.registry.all().map((reg) => reg.pattern);
    expect(registered.length).toBeGreaterThan(0);
    for (const pattern of registered) {
      expect(plugin.uses, `注册了 ${pattern} 却没写进 uses`).toContain(pattern);
    }
  });
});
