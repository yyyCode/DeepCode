import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { EngineInterface, FsNoun } from '@deepcode/contract/engine';
import type { EventHook } from '@deepcode/contract/plugin';
import { createFsNoun } from '@deepcode/core/nouns/fs';
import { createChangesPlugin, createSessionChanges, MAX_SNAPSHOT_BYTES } from '@deepcode/cli/changes';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-changes-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type CoreImpl = (e: any) => unknown;

/**
 * 一棵真临时目录 + 一个记 $ 的 harness。
 *
 * `tool.call` 的 coreImpl 就是"真的工具"：它真的写文件、返回 `{ value }`。
 * 它落在链尾（coreImpls 永远在 hooks 之后），所以会话改动插件的外层 hook
 * 天然把它包住 —— 这正是要验的顺序：读 before → 真工具写 → 读 after。
 *
 * fs 名词包了一层，`read` 记下每次调用：用例 6 靠它证明大文件根本没被读进来
 * （只断言 `kind === 'skipped'` 是证明不了这一点的）。
 */
function makeWorld(impl: CoreImpl) {
  const inner = createFsNoun();
  const reads: string[] = [];
  const fs: FsNoun = {
    ...inner,
    read: async (path) => {
      reads.push(path);
      return inner.read(path);
    },
  };

  const engine = {
    session: {
      id: () => 'changes',
      cwd: () => root,
      root: () => root,
      signal: () => new AbortController().signal,
    },
    fs,
    logger: { debug: () => {}, warn: () => {} },
  } as unknown as EngineInterface;

  const changes = createSessionChanges();
  const plugin = createChangesPlugin(changes);

  // engine 必须传进去：漏了它 createHarness 会退回空对象，hook 里的 `$.fs` 就是
  // undefined，快照全部落到 catch 分支变成 `skipped` —— 用例会以一种很误导的方式失败。
  const h = createHarness({ engine, coreImpls: { 'tool.call': impl } });

  // On → h.on 的适配，照 test/e2e.test.ts 的 buildWorld。
  plugin.register((pattern: string, second: any, third?: any) => {
    if (third !== undefined) {
      h.on('builtin', plugin.name, pattern, second as Record<string, unknown>, third as EventHook);
    } else {
      h.on('builtin', plugin.name, pattern, second as EventHook);
    }
  });

  return { h, engine, changes, reads };
}

function call(world: ReturnType<typeof makeWorld>, tool: string, input: unknown) {
  return world.h.dispatch('tool.call', { tool, input, toolUseId: 'x' }, CORE_ORIGIN);
}

/** 顶上 Write/Edit 工具：真写文件、返回成功。写入前 resolve 一下，容忍未归一的路径。 */
const writeImpl: CoreImpl = async (e) => {
  await writeFile(resolve(e.input.file_path), e.input.content, 'utf8');
  return { value: 'ok' };
};

describe('本会话改动记录（tool.call 外层快照）', () => {
  it('新建文件：before 为 absent，after 是写入后的内容', async () => {
    const target = join(root, 'new.txt');
    const world = makeWorld(writeImpl);

    await call(world, 'Write', { file_path: target, content: 'hello\n' });

    expect(world.changes.size()).toBe(1);
    const change = world.changes.list()[0]!;
    expect(change.path).toBe(resolve(target));
    expect(change.before).toEqual({ kind: 'absent' });
    expect(change.after).toEqual({ kind: 'text', text: 'hello\n' });
  });

  it('修改已有文件：before 与 after 都是改动前后的真实内容', async () => {
    const target = join(root, 'edit.txt');
    await writeFile(target, 'old\n', 'utf8');
    const world = makeWorld(writeImpl);

    await call(world, 'Write', { file_path: target, content: 'new\n' });

    const change = world.changes.list()[0]!;
    expect(change.before).toEqual({ kind: 'text', text: 'old\n' });
    expect(change.after).toEqual({ kind: 'text', text: 'new\n' });
  });

  it('同一文件改两次：合并成一条，before 是最初的、after 是最后的', async () => {
    const target = join(root, 'twice.txt');
    await writeFile(target, 'v0', 'utf8');
    const world = makeWorld(writeImpl);

    await call(world, 'Write', { file_path: target, content: 'v1' });
    await call(world, 'Write', { file_path: target, content: 'v2' });

    expect(world.changes.size()).toBe(1);
    const change = world.changes.list()[0]!;
    expect(change.before).toEqual({ kind: 'text', text: 'v0' });
    expect(change.after).toEqual({ kind: 'text', text: 'v2' });
  });

  it('工具返回 ERROR: 前缀：不记录', async () => {
    const world = makeWorld(() => ({ value: 'ERROR: 覆盖已有文件前必须先 Read' }));

    await call(world, 'Write', { file_path: join(root, 'err.txt'), content: 'x' });

    expect(world.changes.size()).toBe(0);
  });

  it('工具返回 deny：不记录（工具根本没执行）', async () => {
    const world = makeWorld(() => ({ deny: '未知工具 Nope' }));

    await call(world, 'Write', { file_path: join(root, 'deny.txt'), content: 'x' });

    expect(world.changes.size()).toBe(0);
  });

  it('工具返回值不是对象：不记录', async () => {
    const world = makeWorld(() => 'boom');

    await call(world, 'Write', { file_path: join(root, 'nonobj.txt'), content: 'x' });

    expect(world.changes.size()).toBe(0);
  });

  it('超过 MAX_SNAPSHOT_BYTES：skipped，且没有把内容读进内存', async () => {
    const target = join(root, 'big.bin');
    // 刚好超限：内容的字节数 = MAX_SNAPSHOT_BYTES + 1。
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
    await writeFile(target, big, 'utf8');

    // 真工具也写一份超限内容，好让 before 与 after 两边都是 skipped。
    const world = makeWorld(async (e) => {
      await writeFile(resolve(e.input.file_path), big, 'utf8');
      return { value: 'ok' };
    });

    await call(world, 'Write', { file_path: target, content: big });

    expect(world.changes.size()).toBe(1);
    const change = world.changes.list()[0]!;
    expect(change.before.kind).toBe('skipped');
    expect(change.after.kind).toBe('skipped');
    // `kind === 'skipped'` 只证明分类对了；下面这条才证明内容没被读进来 ——
    // 如果实现是先读再判大小，这里就会看见 text 字段。
    expect('text' in change.before).toBe(false);
    expect('text' in change.after).toBe(false);
    // 而且 fs.read 压根没被调用过 —— 内存里从未有过这份内容。
    expect(world.reads).not.toContain(resolve(target));
  });

  it('路径归一：未归一的 ./ 写法与绝对路径指向同一文件时合并成一条', async () => {
    const target = join(root, 'norm.txt');
    // 故意不归一：混用分隔符 + `./`。resolve() 后与 target 同一路径。
    const messy = `${root}/./norm.txt`;
    expect(messy).not.toBe(target);

    const world = makeWorld(writeImpl);
    await call(world, 'Write', { file_path: target, content: 'first' });
    await call(world, 'Write', { file_path: messy, content: 'second' });

    expect(world.changes.size()).toBe(1);
    const change = world.changes.list()[0]!;
    expect(change.path).toBe(resolve(target));
    expect(change.before).toEqual({ kind: 'absent' });
    expect(change.after).toEqual({ kind: 'text', text: 'second' });
  });

  it('Edit 也挂了外层 hook', async () => {
    const target = join(root, 'edit-tool.txt');
    await writeFile(target, 'a\n', 'utf8');
    const world = makeWorld(writeImpl);

    await call(world, 'Edit', { file_path: target, content: 'b\n' });

    expect(world.changes.size()).toBe(1);
    const change = world.changes.list()[0]!;
    expect(change.before).toEqual({ kind: 'text', text: 'a\n' });
    expect(change.after).toEqual({ kind: 'text', text: 'b\n' });
  });
});
