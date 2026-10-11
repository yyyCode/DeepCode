import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
