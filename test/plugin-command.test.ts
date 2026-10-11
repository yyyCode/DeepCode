import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args';
import { runPluginCommand } from '../src/cli/plugin-command';

describe('parseArgs 的 plugin 子命令', () => {
  it('plugin list', () => {
    expect(parseArgs(['plugin', 'list'])).toEqual({ kind: 'plugin', sub: 'list' });
  });

  it('plugin validate <目录>', () => {
    expect(parseArgs(['plugin', 'validate', './plugins/todo'])).toEqual({
      kind: 'plugin',
      sub: 'validate',
      dir: './plugins/todo',
    });
  });

  it('光一个 plugin 打说明', () => {
    expect(parseArgs(['plugin'])).toEqual({ kind: 'plugin', sub: 'help' });
  });

  it('validate 少了目录也打说明', () => {
    expect(parseArgs(['plugin', 'validate'])).toEqual({ kind: 'plugin', sub: 'help' });
  });

  it('plugin add <名字> --from=<目录>', () => {
    expect(parseArgs(['plugin', 'add', 'todo', '--from=./market'])).toEqual({
      kind: 'plugin',
      sub: 'add',
      name: 'todo',
      from: './market',
    });
  });

  it('--from 出现在名字前面也行（它是以 - 开头的，不会把自己变成第一个非开关 token）', () => {
    expect(parseArgs(['plugin', 'add', '--from=./market', 'todo'])).toEqual({
      kind: 'plugin',
      sub: 'add',
      name: 'todo',
      from: './market',
    });
  });

  it('plugin add 少了 --from 就回落成打说明（不是一条死胡同：说明里写着怎么写）', () => {
    expect(parseArgs(['plugin', 'add', 'todo'])).toEqual({ kind: 'plugin', sub: 'help' });
  });

  it('plugin remove <名字>', () => {
    expect(parseArgs(['plugin', 'remove', 'todo'])).toEqual({
      kind: 'plugin',
      sub: 'remove',
      name: 'todo',
    });
  });

  it('plugin remove 少了名字也打说明', () => {
    expect(parseArgs(['plugin', 'remove'])).toEqual({ kind: 'plugin', sub: 'help' });
  });

  it('**其余一律照旧当提示词** —— "plugin" 这个词在提问里出现很正常', () => {
    expect(parseArgs(['plugin', '系统怎么写'])).toEqual({
      kind: 'prompt',
      text: 'plugin 系统怎么写',
      resume: { kind: 'none' },
      settings: undefined,
    });
    expect(parseArgs(['讲讲', 'plugin.json']).kind).toBe('prompt');
  });

  it('后面还有别的 token 时以第一个非开关 token 为准', () => {
    expect(parseArgs(['--resume', 'plugin', 'list'])).toEqual({ kind: 'plugin', sub: 'list' });
  });
});

async function world(): Promise<{ home: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'deepcode-plugincmd-'));
  return { home: join(base, 'home'), root: join(base, 'root') };
}

function collector() {
  const out: string[] = [];
  return { out, write: (line: string) => out.push(line) };
}

describe('plugin validate', () => {
  it('好清单：退出码 0，把清单里有什么打出来', async () => {
    const { home, root } = await world();
    const dir = join(root, 'plugins', 'todo');
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'todo', version: '0.1.0', uses: ['tool.call'] }),
    );
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node x.mjs' }] }] }),
    );

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'validate', dir },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    const text = sink.out.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('todo');
    // 用命令原文打出来，不执行 —— 这正是"装一个插件 = 信任它"那条边界的下限：
    // validate 至少让你**看见**它想跑什么。
    expect(text).toContain('node x.mjs');
  });

  it('坏清单：退出码 1，点名 E 编号', async () => {
    const { home, root } = await world();
    const dir = join(root, 'plugins', 'bad');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'BadName' }));

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'validate', dir },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
    expect(sink.out.join('\n')).toContain('E3');
  });

  it('目录不存在：说人话，退出码 1', async () => {
    const { home, root } = await world();
    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'validate', dir: join(root, 'nope') },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
    expect(sink.out.join('\n')).toContain('plugin.json');
  });
});

describe('plugin list', () => {
  it('列出装上的与跳过的，各带理由', async () => {
    const { home, root } = await world();
    const userPlugin = join(home, '.deepcode', 'plugins', 'ok');
    await mkdir(userPlugin, { recursive: true });
    await writeFile(join(userPlugin, 'plugin.json'), JSON.stringify({ name: 'ok', version: '0.1.0', uses: [] }));

    const projectPlugin = join(root, '.deepcode', 'plugins', 'needs-enable');
    await mkdir(projectPlugin, { recursive: true });
    await writeFile(
      join(projectPlugin, 'plugin.json'),
      JSON.stringify({ name: 'needs-enable', version: '0.1.0', uses: [] }),
    );

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'list' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    const text = sink.out.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('ok');
    expect(text).toContain('needs-enable');
    expect(text).toContain('plugins.enable');
  });
});

/** 一个自足的 marketplace：索引 + 一个带钩子的插件。不依赖仓库里的 plugins/ 内容。 */
async function market(base: string, source = './demo'): Promise<string> {
  const dir = join(base, 'market');
  await mkdir(join(dir, '.deepcode-plugin'), { recursive: true });
  await mkdir(join(dir, 'demo', 'hooks'), { recursive: true });
  await writeFile(
    join(dir, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '0.1.0', uses: ['tool.check'], hooks: './hooks/hooks.json' }),
  );
  await writeFile(
    join(dir, 'demo', 'hooks', 'hooks.json'),
    JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node demo-hook.mjs' }] }] }),
  );
  await writeFile(
    join(dir, '.deepcode-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'deepcode',
      description: '测试用',
      plugins: [{ name: 'demo', description: '演示', source }],
    }),
  );
  return dir;
}

/** 与 world() 同形，但多一个自己那份 home —— `add` 会往那儿写。 */
async function addWorld(): Promise<{ home: string; root: string; market: string }> {
  const base = await mkdtemp(join(tmpdir(), 'deepcode-add-'));
  const home = join(base, 'home');
  const root = join(base, 'root');
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { home, root, market: await market(base) };
}

async function add(deps: { home: string; root: string }, from: string, name = 'demo') {
  const sink = collector();
  const code = await runPluginCommand({
    action: { kind: 'plugin', sub: 'add', name, from },
    home: deps.home,
    root: deps.root,
    enabled: [],
    enabledByUser: [],
    out: sink.write,
    err: sink.write,
  });
  return { code, text: sink.out.join('\n') };
}

async function list(deps: { home: string; root: string }, enabledByUser: readonly string[] = []) {
  const sink = collector();
  const code = await runPluginCommand({
    action: { kind: 'plugin', sub: 'list' },
    home: deps.home,
    root: deps.root,
    enabled: [],
    enabledByUser,
    out: sink.write,
    err: sink.write,
  });
  return { code, text: sink.out.join('\n') };
}

describe('plugin add / remove', () => {
  it('装：文件真的落进落点，报告里有钩子命令原文与「它不会跑」那句话', async () => {
    const { home, root, market: from } = await addWorld();
    const { code, text } = await add({ home, root }, from);

    expect(code).toBe(0);
    // 装之前你能看见的全部 —— 这是「装一个插件 = 信任它」那条边界的下限。
    expect(text).toContain('node demo-hook.mjs');
    expect(text).toContain(join(home, '.deepcode', 'installed', 'demo'));
    expect(text).toContain('它现在**不会跑**');
    expect(text).toContain('用户级');

    const manifest = await readFile(join(home, '.deepcode', 'installed', 'demo', 'plugin.json'), 'utf8');
    expect(manifest).toContain('demo');
    const hooks = await readFile(
      join(home, '.deepcode', 'installed', 'demo', 'hooks', 'hooks.json'),
      'utf8',
    );
    expect(hooks).toContain('demo-hook.mjs');
  });

  // ⚠️ 下面两条断言的是 `plugin list` 的**第三节**（"装进来的"那一段）—— 那是 Task 5 的
  // `renderList` 才渲染的，Task 4 里它还只有"装上来的 / 跳过的"两节。所以这两条现在按
  // `.skip` 挂着，Task 5 装上第三节之后去掉 `.skip` 即可（计划把这两条排在 Task 4 是排错了位置）。
  it.skip('没启用的落点插件在 list 里单独一节，且不是"跳过"那种错', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);
    const { text } = await list({ home, root });
    expect(text).toContain('装进来的（1）');
    expect(text).toContain('未启用');
    expect(text).toContain('用户级设置');
  });

  it.skip('启用了之后它出现在「装上的」里，标着已启用', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);
    const { text } = await list({ home, root }, ['demo']);
    expect(text).toContain('装上的（1）');
    expect(text).toContain('已启用');
    // 每一份插件在输出里只出现一节 —— 第三节是"跳过的"，落点那两份都不该落进去。
    expect(text).toContain('跳过的（0）');
  });

  it('索引里没有这个名字：非零码，并列出有的名字', async () => {
    const { home, root, market: from } = await addWorld();
    const { code, text } = await add({ home, root }, from, 'typo');
    expect(code).toBe(1);
    expect(text).toContain('没有 "typo"');
    expect(text).toContain('demo');
  });

  it('索引本身坏（source 是 ../x）：非零码，且**落点里什么都没多出来**', async () => {
    const { home, root } = await addWorld();
    const base = await mkdtemp(join(tmpdir(), 'deepcode-bad-'));
    const from = await market(base, '../outside');

    const { code, text } = await add({ home, root }, from);
    expect(code).toBe(1);
    expect(text).toContain('M5');
    // 承重的那半：中止发生在写盘之前。
    await expect(stat(join(home, '.deepcode', 'installed'))).rejects.toThrow();
  });

  it('目标已存在就拒绝，并告诉对方先 remove —— 不覆盖', async () => {
    const { home, root, market: from } = await addWorld();
    expect((await add({ home, root }, from)).code).toBe(0);

    const again = await add({ home, root }, from);
    expect(again.code).toBe(1);
    expect(again.text).toContain('已经在了');
    expect(again.text).toContain('plugin remove demo');
  });

  it('remove 删掉落点那一份，并提醒设置里那一行', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: 'demo' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    const text = sink.out.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('已删掉');
    expect(text).toContain('plugins.enable');
    await expect(stat(join(home, '.deepcode', 'installed', 'demo'))).rejects.toThrow();
  });

  it('remove 一个不存在的不算成功', async () => {
    const { home, root } = await addWorld();
    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: 'nope' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
  });

  it('remove 一个名字不合法的**不碰任何路径**（名字直接参与拼路径）', async () => {
    const { home, root } = await addWorld();
    // 造一个"如果拼接不受控就会被删掉"的受害者。
    const victim = join(home, '.deepcode', 'installed', 'x');
    await mkdir(victim, { recursive: true });

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: '../installed/x' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
    expect(sink.out.join('\n')).toContain('kebab-case');
    // 受害者还在。
    await expect(stat(victim)).resolves.toBeDefined();
  });
});
