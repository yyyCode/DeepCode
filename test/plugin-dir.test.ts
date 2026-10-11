import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { discoverPlugins, installPlugins } from '../src/cli/plugin-dir';
import { createHarness, seat } from './harness';

/**
 * 不带 `name`：目录名就是默认的插件名。带上一个固定名字的话，
 * 「按名字排序」「同名项目级赢」这些断言测的就不是目录结构了。
 */
const MANIFEST = JSON.stringify({ version: '0.1.0', uses: ['tool.describe', 'tool.call'] });

/** 造一个"家目录 + 工作目录"的临时现场，两个 .deepcode/plugins 各自一份。 */
async function makeWorld(): Promise<{ home: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'deepcode-plugins-'));
  const home = join(base, 'home');
  const root = join(base, 'root');
  // 这两个目录要真的存在：它们是钩子的 cwd。不建的话 `spawn` 会因为 cwd 不存在而
  // 直接 error —— 插件"装了但一条都没跑"，而理由看起来像钩子自己的问题。
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { home, root };
}

async function putPlugin(
  where: 'home' | 'root',
  world: { home: string; root: string },
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(world[where], '.deepcode', 'plugins', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', ...JSON.parse(files['plugin.json'] ?? '{}') }),
  );
  for (const [relative, content] of Object.entries(files)) {
    if (relative === 'plugin.json') continue;
    await mkdir(join(dir, relative, '..'), { recursive: true });
    await writeFile(join(dir, relative), content);
  }
  return dir;
}

/** 与 putPlugin 同形，只是落在 `~/.deepcode/installed/`。 */
async function putInstalled(
  world: { home: string },
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(world.home, '.deepcode', 'installed', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', ...JSON.parse(files['plugin.json'] ?? '{}') }),
  );
  for (const [relative, content] of Object.entries(files)) {
    if (relative === 'plugin.json') continue;
    await mkdir(join(dir, relative, '..'), { recursive: true });
    await writeFile(join(dir, relative), content);
  }
  return dir;
}

const NO_WARN = (): void => {};

describe('发现', () => {
  it('用户级自动装载，不需要任何设置', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded.map((p) => p.name)).toEqual(['todo']);
    expect(found.loaded[0]?.origin).toBe('user');
  });

  it('项目级不显式启用就不装，且理由说得清怎么写', async () => {
    const world = await makeWorld();
    await putPlugin('root', world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.name).toBe('todo');
    expect(found.skipped[0]?.reason).toContain('plugins.enable');
  });

  it('显式启用之后装得上', async () => {
    const world = await makeWorld();
    await putPlugin('root', world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: ['todo'], warn: NO_WARN });
    expect(found.loaded.map((p) => [p.name, p.origin])).toEqual([['todo', 'project']]);
  });

  it('同名时项目级的赢，用户级那份被点名丢掉', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', { 'plugin.json': MANIFEST });
    await putPlugin('root', world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: ['todo'], warn: NO_WARN });
    expect(found.loaded.map((p) => p.origin)).toEqual(['project']);
    expect(found.skipped[0]?.reason).toContain('同名');
  });

  it('坏清单不装，理由是第一条 E（不是一堆内部细节）', async () => {
    const world = await makeWorld();
    // 名字里带下划线与大写 —— E3 专门拦这个。目录名本身是合法的 'bad'，
    // 所以这里必须**显式**写一个坏名字，不能指望目录名。
    await putPlugin('home', world, 'bad', {
      'plugin.json': JSON.stringify({ name: 'Bad_Name', version: '0.1.0' }),
    });
    const lines: string[] = [];
    const found = await discoverPlugins({ ...world, enabled: [], warn: (l) => lines.push(l) });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.reason).toContain('E3');
    expect(lines.join('\n')).toContain('E3');
  });

  it('钩子被归一后带出来', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'guard', {
      'plugin.json': JSON.stringify({ name: 'guard', version: '0.1.0', uses: ['tool.check'] }),
      'hooks/hooks.json': JSON.stringify({
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node g.mjs' }] }],
      }),
    });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded[0]?.hooks).toEqual([
      {
        event: 'PreToolUse',
        tools: ['Write'],
        hooks: [{ command: 'node g.mjs', timeoutMs: 10_000 }],
      },
    ]);
  });

  it('两个目录都不存在时是空结果，不是错误', async () => {
    const world = await makeWorld();
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found).toEqual({ loaded: [], skipped: [] });
  });

  it('顺序按名字排，不按目录枚举顺序', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'zeta', { 'plugin.json': MANIFEST });
    await putPlugin('home', world, 'alpha', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded.map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });

  it('发现阶段**一个字的代码都不执行** —— 列清单与跑插件是两件事', async () => {
    const world = await makeWorld();
    const dir = await putPlugin('home', world, 'sneaky', {
      'plugin.json': JSON.stringify({ name: 'sneaky', version: '0.1.0', uses: [] }),
      // 入口一被 import 就会写这个文件。发现阶段不该有它。
      'main.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(world.home, 'EXECUTED'))}, 'oops');\n`,
    });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded[0]?.entry).toBe('./main.mjs');
    await expect(readFile(join(world.home, 'EXECUTED'), 'utf8')).rejects.toThrow();
    expect(dir).toContain('sneaky');
  });

  it('落点里的一律不装载，除非给了 enabledInstalled —— 默认值必须是"什么都不开"', async () => {
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
    expect(found.skipped[0]?.reason).toContain('用户级设置');
    // 这一句是承重的那半：理由必须点明"项目级写同一个名字不算数"，
    // 否则人会照着它去改 project 那份，然后还是不动。
    expect(found.skipped[0]?.reason).toContain('项目级设置里写同一个名字不算数');
  });

  it('给了 enabledInstalled 就装载，origin 是 installed', async () => {
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({
      ...world,
      enabled: [],
      enabledInstalled: ['todo'],
      warn: NO_WARN,
    });
    expect(found.loaded.map((p) => [p.name, p.origin])).toEqual([['todo', 'installed']]);
  });

  it('**项目级名单管不着落点** —— enable 里写了同一个名字，落点那份照样不装', async () => {
    // 决策 3 的单元级可执行形式。反过来（enabledInstalled 能点亮项目级）不存在：
    // 项目级那份只看 deps.enabled。
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: ['todo'], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
  });

  it('同名时 user 赢过 installed —— 更直接的那个来源赢', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', { 'plugin.json': MANIFEST });
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({
      ...world,
      enabled: [],
      enabledInstalled: ['todo'],
      warn: NO_WARN,
    });
    expect(found.loaded.map((p) => [p.name, p.origin])).toEqual([['todo', 'user']]);
    expect(found.skipped[0]?.reason).toContain('同名插件');
  });

  it('落点里的坏清单照旧是"跳过的"，与启不启用无关', async () => {
    const world = await makeWorld();
    // putInstalled 与 putPlugin 同形：`plugin.json` 这一项是**文本**（要 JSON.parse），
    // 不是对象 —— 计划里写的 `{ name: 'BadName' } as never` 会让 JSON.parse 吃到
    // "[object Object]" 当场抛，测试连现场都建不起来。
    await putInstalled(world, 'bad', { 'plugin.json': JSON.stringify({ name: 'BadName' }) });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
    expect(found.skipped[0]?.reason).toContain('E3');
  });
});

describe('装载', () => {
  it('入口模块注册的 hook 真的挂到了链上', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', {
      'plugin.json': JSON.stringify({
        name: 'todo',
        version: '0.1.0',
        uses: ['tool.describe', 'tool.call'],
      }),
      'main.mjs': `export default {
        register(on) {
          on('tool.describe', { tool: 'TodoWrite' }, () => ({ description: '记一条待办', inputSchema: {} }));
        },
      };\n`,
    });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    const installed = await installPlugins(found.loaded, {
      projectDir: world.root,
      session: { id: 's1', transcriptPath: undefined },
      env: process.env,
      warn: NO_WARN,
    });

    expect(installed.map((p) => p.name)).toEqual(['todo']);
    expect(installed[0]?.uses).toEqual(['tool.describe', 'tool.call']);

    const h = createHarness();
    seat(h, installed[0]!, 'append');
    expect(h.registry.matcherValues('tool.describe', 'tool')).toEqual(['TodoWrite']);
  });

  it('入口里自述的名字与清单不一致时以清单为准，并点名', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', {
      'plugin.json': JSON.stringify({ name: 'todo', version: '0.1.0', uses: [] }),
      'main.mjs': `export default { name: 'i-am-root', register() {} };\n`,
    });
    const lines: string[] = [];
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    const installed = await installPlugins(found.loaded, {
      projectDir: world.root,
      session: { id: 's1', transcriptPath: undefined },
      env: process.env,
      warn: (l) => lines.push(l),
    });
    expect(installed[0]?.name).toBe('todo');
    expect(lines.join('\n')).toContain('以清单为准');
  });

  it('入口 import 就炸 → 整个插件不装（没有半个插件）', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'boom', {
      'plugin.json': JSON.stringify({ name: 'boom', version: '0.1.0', uses: ['tool.call'] }),
      'main.mjs': `throw new Error('装不上');\n`,
    });
    const lines: string[] = [];
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    const installed = await installPlugins(found.loaded, {
      projectDir: world.root,
      session: { id: 's1', transcriptPath: undefined },
      env: process.env,
      warn: (l) => lines.push(l),
    });
    expect(installed).toEqual([]);
    expect(lines.join('\n')).toContain('整个插件不装');
  });

  it('没有默认导出 / 没有 register → 不装', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'nope', {
      'plugin.json': JSON.stringify({ name: 'nope', version: '0.1.0', uses: [] }),
      'main.mjs': `export const register = () => {};\n`,
    });
    const lines: string[] = [];
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    const installed = await installPlugins(found.loaded, {
      projectDir: world.root,
      session: { id: 's1', transcriptPath: undefined },
      env: process.env,
      warn: (l) => lines.push(l),
    });
    expect(installed).toEqual([]);
    expect(lines.join('\n')).toContain('默认导出');
  });

  it('只有 hooks.json 的插件也装得上，且钩子挂在自己的名字下', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'guard', {
      'plugin.json': JSON.stringify({ name: 'guard', version: '0.1.0', uses: ['session.start'] }),
      'hooks/hooks.json': JSON.stringify({
        SessionStart: [{ hooks: [{ type: 'command', command: 'node -v' }] }],
      }),
    });
    const lines: string[] = [];
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    const installed = await installPlugins(found.loaded, {
      projectDir: world.root,
      session: { id: 's1', transcriptPath: undefined },
      env: process.env,
      warn: NO_WARN,
    });

    const h = createHarness({
      engine: { ui: { log: (l: string) => lines.push(l), notice: NO_WARN, ask: async () => '' } },
    });
    seat(h, installed[0]!, 'append');
    await h.dispatch(
      'session.start',
      { sessionId: 's1', cwd: world.root, root: world.root },
      CORE_ORIGIN,
    );
    // `node -v` 的输出会被人看到 —— 说明钩子确实跑了，且是以这个插件的名字。
    expect(lines.join('\n')).toContain('v');
    expect(h.registry.hooksFor('session.start', {}).map((r) => r.plugin)).toEqual(['guard']);
  });
});
