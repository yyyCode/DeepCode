import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BATCH_SIZE, createTelemetrySink, type TelemetrySinkDeps } from '../src/cli/telemetry-sink';
import { telemetryPath } from '../src/cli/telemetry-rows';

const made: string[] = [];
afterEach(async () => {
  while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true });
});

const ENTRY = { kind: 'tool.result', fields: { tool: 'Bash', ok: true } } as const;

/** 一个把 IO 全接下来记账的 sink。`failWrite` 时 `append` 抛。 */
function spySink(over: Partial<TelemetrySinkDeps> = {}) {
  const mkdirs: string[] = [];
  const appends: Array<{ path: string; text: string }> = [];
  const warnings: string[] = [];
  const sink = createTelemetrySink({
    home: '/home/u',
    enabled: true,
    warn: (line) => warnings.push(line),
    mkdir: async (dir) => void mkdirs.push(dir),
    append: async (path, text) => void appends.push({ path, text }),
    now: () => new Date('2026-10-11T10:00:00.000Z'),
    ...over,
  });
  return { sink, mkdirs, appends, warnings };
}

describe('关着的时候：一个系统调用都不发', () => {
  it('记 100 条 → mkdir / append 都没被调到，written 是 0', async () => {
    // 注入两个**会抛**的实现：只要碰一下就炸，所以"没抛"本身就是断言。
    const boom = async () => {
      throw new Error('关掉的时候不该碰盘');
    };
    const sink = createTelemetrySink({
      home: '/home/u',
      enabled: false,
      warn: () => {},
      mkdir: boom,
      append: boom,
    });

    for (let i = 0; i < 100; i += 1) sink.record(ENTRY);
    await sink.flush();

    expect(sink.stats.written).toBe(0);
    expect(sink.stats.rejected).toBe(0);
    expect(sink.stats.lastError).toBeUndefined();
  });

  it('关着的时候连"这条不合格"都不判 —— 校验的那条路整个不走', async () => {
    const { sink } = spySink({ enabled: false });
    sink.record({ kind: '带 空 格' });
    await sink.flush();
    expect(sink.stats.rejected).toBe(0);
  });
});

describe('缓冲与成批落盘', () => {
  it(`记 ${BATCH_SIZE - 1} 条不落盘，第 ${BATCH_SIZE} 条落一整个批次`, async () => {
    const { sink, appends } = spySink();
    for (let i = 0; i < BATCH_SIZE - 1; i += 1) sink.record(ENTRY);
    // 冲是 `void flush()`（不 await）—— 让出一次微任务队列再看。
    await Promise.resolve();
    await Promise.resolve();
    expect(appends).toHaveLength(0);

    sink.record(ENTRY);
    await new Promise((r) => setImmediate(r));
    expect(appends).toHaveLength(1);
    expect(appends[0]!.text.split('\n').filter((l) => l !== '')).toHaveLength(BATCH_SIZE);
  });

  it('flush 把不足一批的那些也落掉', async () => {
    const { sink, appends } = spySink();
    sink.record(ENTRY);
    sink.record(ENTRY);
    await sink.flush();
    expect(appends).toHaveLength(1);
    expect(sink.stats.written).toBe(2);
  });

  it('空缓冲的 flush 一个字节都不写', async () => {
    const { sink, appends } = spySink();
    await sink.flush();
    expect(appends).toHaveLength(0);
  });

  it('mkdir 只在第一次真要写的时候调，之后不再调', async () => {
    const { sink, mkdirs, appends } = spySink();
    await sink.flush();
    expect(mkdirs).toHaveLength(0);

    sink.record(ENTRY);
    await sink.flush();
    sink.record(ENTRY);
    await sink.flush();
    // 期望值也用 join 算：跑测试的机器可能是 Windows。
    expect(mkdirs).toEqual([join('/home/u', '.deepcode')]);
    expect(appends).toHaveLength(2);
  });

  it('seq 逐条递增，at 取的是注入的时钟', async () => {
    const { sink, appends } = spySink();
    sink.record({ kind: 'a' });
    sink.record({ kind: 'b' });
    await sink.flush();
    const rows = appends[0]!.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((r) => [r.seq, r.kind, r.at])).toEqual([
      [1, 'a', '2026-10-11T10:00:00.000Z'],
      [2, 'b', '2026-10-11T10:00:00.000Z'],
    ]);
  });
});

describe('不合格的记录', () => {
  it('不落盘、计数、**只在第一次**喊一声', async () => {
    const { sink, appends, warnings } = spySink();
    sink.record({ kind: '带 空 格' });
    sink.record({ kind: '另一个 坏 的' });
    sink.record({ kind: '还 有 一 个' });
    await sink.flush();

    expect(appends).toHaveLength(0);
    expect(sink.stats.rejected).toBe(3);
    expect(sink.stats.lastReject).toContain('kind');
    expect(warnings).toHaveLength(1);
  });

  it('一条坏的不会带坏同一批里好的', async () => {
    const { sink, appends } = spySink();
    sink.record(ENTRY);
    sink.record({ kind: 'bad kind' });
    sink.record(ENTRY);
    await sink.flush();
    const rows = appends[0]!.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe('写失败：只喊一次，会话照常', () => {
  it('append 抛 → lastError 记下、warn 一次；后续 record 不抛也不重试', async () => {
    let calls = 0;
    const { sink, warnings } = spySink({
      append: async () => {
        calls += 1;
        throw new Error('EACCES');
      },
    });

    sink.record(ENTRY);
    await sink.flush();
    sink.record(ENTRY);
    await sink.flush();
    sink.record(ENTRY);
    await sink.flush();

    expect(calls).toBe(3); // 每次都试了，但都不重试**已经清掉**的那一批
    expect(sink.stats.written).toBe(0);
    expect(sink.stats.lastError).toContain('EACCES');
    expect(warnings).toHaveLength(1);
  });

  it('mkdir 炸了也不抛出去，只是记下来', async () => {
    const { sink, warnings } = spySink({
      mkdir: async () => {
        throw new Error('EROFS');
      },
    });
    sink.record(ENTRY);
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.stats.lastError).toContain('EROFS');
    expect(warnings).toHaveLength(1);
  });

  it('失败之后来的记录不会把缓冲堵死（坏掉的是盘，不是链）', async () => {
    let failing = true;
    const texts: string[] = [];
    const { sink } = spySink({
      append: async (_path, text) => {
        if (failing) throw new Error('EACCES');
        texts.push(text);
      },
    });
    sink.record(ENTRY);
    await sink.flush();
    failing = false;
    sink.record(ENTRY);
    await sink.flush();
    expect(texts).toHaveLength(1);
    expect(sink.stats.written).toBe(1);
  });
});

describe('真文件', () => {
  it('能写进临时目录，内容逐行读得回来', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepcode-telemetry-'));
    made.push(home);

    const sink = createTelemetrySink({ home, enabled: true, warn: () => {} });
    sink.record({ kind: 'session.start', fields: { session: 's1' } });
    sink.record({ kind: 'tool.result', fields: { tool: 'Bash', ok: false } });
    await sink.flush();

    const text = await readFile(telemetryPath(home), 'utf8');
    const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((r) => r.kind)).toEqual(['session.start', 'tool.result']);
    expect(rows[1].fields).toEqual({ tool: 'Bash', ok: false });
    expect(sink.stats.written).toBe(2);
  });

  it('POSIX 上文件是 0600（Windows 跳过 —— 那里的 mode 基本不生效）', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'deepcode-telemetry-'));
    made.push(home);

    const sink = createTelemetrySink({ home, enabled: true, warn: () => {} });
    sink.record(ENTRY);
    await sink.flush();

    const info = await stat(telemetryPath(home));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('关着的时候那个文件压根不存在', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepcode-telemetry-'));
    made.push(home);

    const sink = createTelemetrySink({ home, enabled: false, warn: () => {} });
    sink.record(ENTRY);
    await sink.flush();
    await expect(stat(telemetryPath(home))).rejects.toThrow();
  });
});
