import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness';
import { coreTools } from '../src/builtins/tools';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';
import { createFsNoun } from '../src/core/nouns/fs';
import { createProcessNoun } from '../src/core/nouns/process';
import { createStoreNoun } from '../src/core/nouns/store';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeHarness() {
  // engine 必须先建好再交给 createHarness —— 它是 hook 里 $ 的来源。
  // 漏传的话 createHarness 会退回 NOOP_ENGINE（空对象），此时
  // `$.fs.read(...)` 会抛 TypeError，被 dispatch 的故障隔离吞掉，
  // 最后落到内核的 { deny: 'unknown tool' } —— 于是每个工具测试都"失败"，
  // 但看起来像工具坏了，其实是 harness 没接上。直接用真实的名词实现，
  // 只有 session 是桩。
  const engine = {
    session: { id: () => 'test', cwd: () => root, root: () => root, signal: () => new AbortController().signal },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    ui: { log: () => {}, notice: () => {}, ask: async () => 'n' },
    logger: { debug: () => {}, warn: () => {} },
    // 真实内核的 $.tool.list() 是注册面上 `tool.call` 的 matcher 取值（见 nouns/index.ts）。
    // 桩这里不能写成 coreTools.map(p => p.name) —— 那是插件名（'tool-read'），
    // 不是工具名（'Read'）。写错的话 describeTools 会拿插件名去查 tool.describe，
    // 六个工具全部落到 catch 分支被静默略去，E2E 表面上照样绿。
    tool: { list: () => ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] },
    command: { list: () => [] },
    model: { stream: async function* () {} },
  } as unknown as EngineInterface;

  const h = createHarness({
    engine,
    coreImpls: {
      'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),
      'tool.describe': () => {
        throw new Error('no description');
      },
    },
  });

  for (const plugin of coreTools) {
    plugin.register((pattern: string, second: any, third?: any) => {
      // 显式分支而不是展开数组：h.on 是重载函数，
      // 用 `...args` 展开会让 TS 无法选定重载。
      if (third !== undefined) {
        h.on('builtin', plugin.name, pattern, second as Record<string, unknown>, third as EventHook);
      } else {
        h.on('builtin', plugin.name, pattern, second as EventHook);
      }
    });
  }

  return { h, engine };
}

async function call(world: ReturnType<typeof makeHarness>, tool: string, input: unknown) {
  return world.h.dispatch('tool.call', { tool, input, toolUseId: 'x' }, CORE_ORIGIN);
}

describe('六个核心工具', () => {
  it('Write 与 Read 往返', async () => {
    const ctx = makeHarness();
    const target = join(root, 'a.txt');

    await call(ctx, 'Write', { file_path: target, content: 'hello\nworld' });
    const result = await call(ctx, 'Read', { file_path: target });
    expect((result as any).value).toContain('1\thello');
    expect((result as any).value).toContain('2\tworld');
  });

  it('Write 拒绝覆盖没读过的已有文件', async () => {
    const ctx = makeHarness();
    const target = join(root, 'b.txt');
    await writeFile(target, 'original', 'utf8');

    const result = await call(ctx, 'Write', { file_path: target, content: 'overwritten' });
    expect((result as any).value).toContain('已存在');
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('Edit 精确替换', async () => {
    const ctx = makeHarness();
    const target = join(root, 'c.ts');
    await writeFile(target, 'const a = 1;\nconst b = 2;\n', 'utf8');
    await call(ctx, 'Read', { file_path: target });

    await call(ctx, 'Edit', { file_path: target, old_string: 'const a = 1;', new_string: 'const a = 9;' });
    expect(await readFile(target, 'utf8')).toBe('const a = 9;\nconst b = 2;\n');
  });

  it('Edit 在 old_string 不唯一时拒绝', async () => {
    const ctx = makeHarness();
    const target = join(root, 'd.ts');
    await writeFile(target, 'x();\nx();\n', 'utf8');
    await call(ctx, 'Read', { file_path: target });

    const result = await call(ctx, 'Edit', { file_path: target, old_string: 'x();', new_string: 'y();' });
    expect((result as any).value).toContain('不唯一');
    expect(await readFile(target, 'utf8')).toBe('x();\nx();\n');
  });

  it('Bash 返回 stdout 与退出码', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Bash', { command: 'echo hi' });
    expect((result as any).value).toContain('hi');
    expect((result as any).value).toContain('退出码 0');
  });

  it('Bash 命令失败时返回 value 而不是抛错', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Bash', { command: 'exit 3' });
    expect((result as any).value).toContain('退出码 3');
  });

  it('Glob 按模式找到文件', async () => {
    const ctx = makeHarness();
    await writeFile(join(root, 'e.ts'), '', 'utf8');
    const result = await call(ctx, 'Glob', { pattern: '*.ts' });
    expect((result as any).value).toContain('e.ts');
  });

  it('Grep 返回 路径:行号: 内容', async () => {
    const ctx = makeHarness();
    await writeFile(join(root, 'f.ts'), 'const needle = 1;\n', 'utf8');
    const result = await call(ctx, 'Grep', { pattern: 'needle' });
    expect((result as any).value).toMatch(/f\.ts:1:.*needle/);
  });

  it('未知工具被拒绝而不是放行', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Nope', {});
    expect((result as any).deny).toContain('unknown tool');
  });
});
