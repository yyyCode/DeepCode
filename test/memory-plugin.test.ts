import { describe, expect, it } from 'vitest';
import type { EngineInterface, FsNoun } from '../src/contract/engine';
import type { Message, ModelProvider, StreamRequest } from '../src/contract/model-provider';
import type { EventHook, On, Plugin } from '../src/contract/plugin';
import type { MemoryConfig } from '../src/contract/memory';
import { DEFAULT_MEMORY } from '../src/contract/memory';
import { createMemoryPlugin, createMemoryStore, memoryDir } from '../src/cli/memory';
import { createHarness } from './harness';

/**
 * 记忆的磁盘侧与插件面（P12）。
 *
 * 这里用的是一个内存 fs（真 fs 会把测试写进用户主目录），但**目录语义与真的一样**：
 * `list(dir)` 只回 basename，`stat` 带 mtime，缺目录抛 ENOENT。
 */

function enoent(path: string): Error {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

type World = {
  readonly fs: FsNoun;
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  /** 当前时间。save 写文件时记进 mtime。 */
  now: number;
};

const norm = (path: string): string => path.replace(/\\/g, '/');
const fileAt = (world: World, path: string): string | undefined => world.files.get(norm(path));
const put = (world: World, path: string, content: string): void => {
  world.files.set(norm(path), content);
};
const fileExists = (world: World, path: string): boolean => world.files.has(norm(path));

function fakeWorld(): World {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>();
  // 真 fs 认两种分隔符；内存 Map 不认。统一成 `/` 再比对，否则 `join()` 出来的
  // 反斜杠路径与测试手写的正斜杠路径会变成两个不同的文件。
  const key = (path: string): string => path.replace(/\\/g, '/');
  const world: World = {
    now: Date.parse('2026-10-20T00:00:00Z'),
    files,
    dirs,
    fs: {
      async read(path) {
        const content = files.get(key(path));
        if (content === undefined) throw enoent(path);
        return content;
      },
      async write(path, content) {
        files.set(key(path), content);
        mtimes.set(key(path), world.now);
      },
      async exists(path) {
        return files.has(key(path)) || dirs.has(key(path));
      },
      async list(dir) {
        const base = key(dir);
        if (!dirs.has(base)) {
          const inside = [...files.keys()].some((path) => path.startsWith(`${base}/`));
          if (!inside) throw enoent(dir);
        }
        const names = new Set<string>();
        for (const path of files.keys()) {
          if (!path.startsWith(`${base}/`)) continue;
          const rest = path.slice(base.length + 1);
          if (!rest.includes('/')) names.add(rest);
        }
        return [...names];
      },
      async stat(path) {
        if (dirs.has(key(path))) return { size: 0, isDirectory: true, mtimeMs: 0 };
        const content = files.get(key(path));
        if (content === undefined) throw enoent(path);
        return { size: content.length, isDirectory: false, mtimeMs: mtimes.get(key(path)) ?? 0 };
      },
    },
  };
  return world;
}

function storeDeps(world: World, config: MemoryConfig = DEFAULT_MEMORY) {
  return {
    home: 'C:/home',
    root: 'F:/work/demo',
    config,
    warn: () => {},
    ensureDir: async (dir: string) => {
      world.dirs.add(dir);
    },
    removeFile: async (path: string) => {
      world.files.delete(norm(path));
    },
  };
}

const draft = {
  name: 'no-mock-db',
  type: 'feedback' as const,
  description: '集成测试必须使用真实数据库',
  content: '不要 mock 数据库。\n\n**Why:** 上一版 mock 掩盖了事务隔离问题。\n\n**How to apply:** 测试里用 docker compose 起 Postgres。',
};

function memoryFile(name: string, type: string, description: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\ntype: ${type}\n---\n\n正文 ${name}\n`;
}

describe('存储：扫描、读写、索引重建', () => {
  it('save 写文件并重建 MEMORY.md；再存同名是更新', async () => {
    const world = fakeWorld();
    const store = createMemoryStore(storeDeps(world));

    const first = await store.save(world.fs, draft, world.now);
    expect(first.updated).toBe(false);
    expect(norm(first.path)).toBe(`${norm(store.dir)}/no-mock-db.md`);
    const text = fileAt(world, first.path) ?? '';
    expect(text).toContain('type: feedback');
    expect(text).toContain('**Why:**');

    const index = fileAt(world, `${store.dir}/MEMORY.md`) ?? '';
    expect(index).toContain('[feedback] [no-mock-db](no-mock-db.md) — 集成测试必须使用真实数据库');

    world.now += 1_000;
    const second = await store.save(world.fs, { ...draft, description: '改过的描述' }, world.now);
    expect(second.updated).toBe(true);
    expect(fileAt(world, `${store.dir}/MEMORY.md`)).toContain('改过的描述');
  });

  it('缺目录 = 没有记忆，不报错；坏文件计数但不进索引', async () => {
    const world = fakeWorld();
    const store = createMemoryStore(storeDeps(world));
    expect(await store.scan(world.fs)).toEqual({ headers: [], broken: 0 });

    world.dirs.add(store.dir);
    put(world, `${store.dir}/good.md`, memoryFile('good', 'user', '写 Go 的'));
    put(world, `${store.dir}/bad.md`, '没有 frontmatter');
    put(world, `${store.dir}/MEMORY.md`, '索引不算记忆');

    const scanned = await store.scan(world.fs);
    expect(scanned.headers.map((header) => header.name)).toEqual(['good']);
    expect(scanned.broken).toBe(1);
  });

  it('扫描只读前 30 行：正文里塞的第二个 frontmatter 骗不了它', async () => {
    const world = fakeWorld();
    const store = createMemoryStore(storeDeps(world));
    world.dirs.add(store.dir);
    const body = Array.from({ length: 40 }, (_, index) => `第 ${index} 行`).join('\n');
    put(
      world,
      `${store.dir}/long.md`,
      `---\nname: long\ndescription: 长正文\ntype: project\n---\n\n${body}\n---\ntype: user\n`,
    );
    const scanned = await store.scan(world.fs);
    expect(scanned.headers[0]?.type).toBe('project');
  });

  it('read / forget 都挡路径穿越，forget 之后索引跟着少一条', async () => {
    const world = fakeWorld();
    const store = createMemoryStore(storeDeps(world));
    await store.save(world.fs, draft, world.now);

    await expect(store.read(world.fs, '../secret')).rejects.toThrow('name 只允许');
    await expect(store.forget(world.fs, 'a/b')).rejects.toThrow('name 只允许');

    const read = await store.read(world.fs, 'no-mock-db');
    expect(read).toContain('**Why:**');

    const removed = await store.forget(world.fs, 'no-mock-db');
    expect(removed.path).toContain('no-mock-db.md');
    expect(fileExists(world, removed.path)).toBe(false);
    expect(fileAt(world, `${store.dir}/MEMORY.md`)?.includes('no-mock-db')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 插件面
// ─────────────────────────────────────────────────────────────

type HarnessWorld = World & {
  readonly logs: string[];
  readonly warnings: string[];
  readonly modelCalls: StreamRequest[];
};

function harnessWorld(options: {
  readonly config?: MemoryConfig;
  readonly reply?: string;
  readonly modelThrows?: boolean;
  readonly listThrows?: boolean;
} = {}): {
  plugin: ReturnType<typeof createMemoryPlugin>;
  engine: EngineInterface;
  world: HarnessWorld;
} {
  const base = fakeWorld();
  const logs: string[] = [];
  const warnings: string[] = [];
  const modelCalls: StreamRequest[] = [];
  const world: HarnessWorld = { ...base, logs, warnings, modelCalls };

  const provider: ModelProvider = {
    name: 'selector',
    async *stream(request) {
      modelCalls.push(request);
      if (options.modelThrows === true) throw new Error('上游 500');
      yield { type: 'text', text: options.reply ?? '[]' };
      yield { type: 'done', stopReason: 'stop' };
    },
  };

  const fs: FsNoun = {
    ...base.fs,
    async list(dir) {
      if (options.listThrows === true) throw new Error('EACCES: 读不了');
      return base.fs.list(dir);
    },
  };

  const plugin = createMemoryPlugin({
    ...storeDeps(world, options.config ?? { ...DEFAULT_MEMORY, recallModel: 'cheap' }),
    warn: (line) => warnings.push(line),
  });

  const engine: EngineInterface = {
    fs,
    model: { stream: (request: StreamRequest) => provider.stream(request) },
    clock: { now: () => world.now },
    ui: { log: (line: string) => logs.push(line), notice: () => {}, ask: async () => '' },
  } as unknown as EngineInterface;

  return { plugin, engine, world };
}

/** 把插件的 `on` 装进 harness：harness 要 tier，插件不要。 */
function mount(
  plugin: Plugin,
  harness: ReturnType<typeof createHarness>,
): void {
  const on = (pattern: string, third?: unknown, fourth?: unknown): void => {
    const hook = (typeof third === 'function' ? third : fourth) as EventHook;
    const matcher =
      typeof third === 'function' ? undefined : (third as Record<string, unknown> | undefined);
    if (matcher === undefined) harness.on('builtin', plugin.name, pattern, hook);
    else harness.on('builtin', plugin.name, pattern, matcher, hook);
  };
  plugin.register(on as unknown as On);
}

const CORE = {
  'prompt.submit': () => ({ handled: false }) as const,
  'prompt.section': () => ({ sections: [] }) as const,
  'tool.call': () => ({ deny: 'unknown tool' }) as const,
  'command.run': () => ({ handled: false }) as const,
};

function setup(
  options: {
    readonly config?: MemoryConfig;
    readonly reply?: string;
    readonly modelThrows?: boolean;
    readonly listThrows?: boolean;
    readonly seed?: boolean;
    readonly extra?: Plugin;
  } = {},
): {
  dispatch: ReturnType<typeof createHarness>['dispatch'];
  world: HarnessWorld;
  plugin: ReturnType<typeof createMemoryPlugin>;
  messages: Message[];
} {
  const { plugin, engine, world } = harnessWorld(options);
  const messages: Message[] = [];

  const harness = createHarness({
    coreImpls: CORE,
    engine: {
      ...engine,
      // 小模型召回要经过 `$.model.stream`；这里直接从 engine 上读。
      ui: {
        log: (line: string) => messages.push({ role: 'user', content: line }),
        notice: () => {},
        ask: async () => '',
      },
    } as unknown as EngineInterface,
  });
  mount(plugin, harness);
  if (options.extra !== undefined) mount(options.extra, harness);
  if (options.seed === true) {
    world.dirs.add(plugin.dir);
    put(
      world,
      `${plugin.dir}/no-mock-db.md`,
      memoryFile('no-mock-db', 'feedback', '集成测试必须使用真实数据库'),
    );
  }
  return { dispatch: harness.dispatch, world, plugin, messages };
}

describe('插件：注入与召回', () => {
  it('没有记忆时一个字都不注入，且别人的节原样带出去', async () => {
    const other: Plugin = {
      name: 'other',
      uses: ['prompt.section'],
      register(on) {
        on('prompt.section', () => ({ sections: [{ name: 'agents', text: 'AGENTS 正文' }] }));
      },
    };
    const { dispatch } = setup({ extra: other });
    await dispatch('prompt.submit', { text: '你好' }, { plugin: 'test', tier: 'builtin' });
    const result = await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });
    expect(result.sections).toEqual([{ name: 'agents', text: 'AGENTS 正文' }]);
  });

  it('有关键词命中时注入索引 + 那一条正文，并记进 stats', async () => {
    const { dispatch, plugin } = setup({ seed: true, config: { enabled: true, maxRecall: 5 } });
    await dispatch('prompt.submit', { text: '数据库测试要怎么起？' }, { plugin: 'test', tier: 'builtin' });
    const result = await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });

    expect(result.sections).toHaveLength(1);
    const text = result.sections[0]?.text ?? '';
    expect(text).toContain('### 索引');
    expect(text).toContain('no-mock-db');
    expect(text).toContain('正文 no-mock-db');
    expect(text).toContain('### 本次召回（1 条，关键词）');

    const stats = plugin.stats();
    expect(stats?.count).toBe(1);
    expect(stats?.recalled).toEqual(['no-mock-db']);
    expect(stats?.recallMode).toBe('keyword');
  });

  it('配了小模型就用它选；模型说 [] 就不召回', async () => {
    const { dispatch, plugin, world } = setup({ seed: true, reply: '["no-mock-db.md"]' });
    await dispatch('prompt.submit', { text: '今天天气怎么样' }, { plugin: 'test', tier: 'builtin' });
    const result = await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });

    expect(world.modelCalls).toHaveLength(1);
    expect(world.modelCalls[0]?.model).toBe('cheap');
    expect(result.sections[0]?.text).toContain('正文 no-mock-db');
    expect(plugin.stats()?.recallMode).toBe('model');
  });

  it('小模型挂了就回落关键词，只出声一次', async () => {
    const { dispatch, plugin, world } = setup({ seed: true, modelThrows: true });
    await dispatch('prompt.submit', { text: '数据库' }, { plugin: 'test', tier: 'builtin' });
    await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });
    await dispatch('prompt.submit', { text: '数据库' }, { plugin: 'test', tier: 'builtin' });
    await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });

    expect(plugin.stats()?.recallMode).toBe('keyword');
    expect(world.warnings.filter((line) => line.includes('回落'))).toHaveLength(1);
  });

  it('目录读不了时 fail-open：这一轮没有记忆，不抛', async () => {
    const { dispatch, world } = setup({ seed: true, listThrows: true });
    await dispatch('prompt.submit', { text: '数据库' }, { plugin: 'test', tier: 'builtin' });
    const result = await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });
    expect(result.sections).toEqual([]);
    expect(world.warnings.join('\n')).toContain('记忆扫描失败');
  });

  it('enabled: false 时整块不装：不注入、不注册工具与命令', async () => {
    const { dispatch, plugin } = setup({
      seed: true,
      config: { enabled: false, maxRecall: 5 },
    });
    await dispatch('prompt.submit', { text: '数据库' }, { plugin: 'test', tier: 'builtin' });
    const section = await dispatch('prompt.section', {}, { plugin: 'test', tier: 'builtin' });
    expect(section.sections).toEqual([]);
    expect(plugin.stats()).toBeUndefined();
  });
});

describe('插件：Memory 工具与 /memory', () => {
  it('save 落盘；feedback 缺 Why/How 被拒，且不会写任何文件', async () => {
    const { dispatch, world } = setup();
    const rejected = await dispatch(
      'tool.call',
      {
        tool: 'Memory',
        toolUseId: 't0',
        input: { action: 'save', name: 'x', type: 'feedback', description: 'd', content: '只有结论' },
      },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(String((rejected as { value: unknown }).value)).toContain('ERROR:');
    expect(String((rejected as { value: unknown }).value)).toContain('**Why:**');
    expect(world.files.size).toBe(0);

    const saved = await dispatch(
      'tool.call',
      { tool: 'Memory', toolUseId: 't1', input: { action: 'save', ...draft } },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(String((saved as { value: unknown }).value)).toContain('已写入记忆 no-mock-db');
    expect([...world.files.keys()].some((path) => path.endsWith('MEMORY.md'))).toBe(true);
  });

  it('read 带回正文；forget 删掉；未知 action 报错', async () => {
    const { dispatch } = setup({ seed: true });

    const read = await dispatch(
      'tool.call',
      { tool: 'Memory', toolUseId: 't1', input: { action: 'read', name: 'no-mock-db' } },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(String((read as { value: unknown }).value)).toContain('正文 no-mock-db');

    const removed = await dispatch(
      'tool.call',
      { tool: 'Memory', toolUseId: 't1', input: { action: 'forget', name: 'no-mock-db' } },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(String((removed as { value: unknown }).value)).toContain('已删除记忆');

    const unknown = await dispatch(
      'tool.call',
      { tool: 'Memory', toolUseId: 't1', input: { action: 'rename', name: 'x' } },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(String((unknown as { value: unknown }).value)).toContain('action 必须是');
  });

  it('/memory 列清单，/memory <name> 打正文', async () => {
    const { dispatch, messages } = setup({ seed: true });

    await dispatch('command.run', { name: 'memory', args: [] }, { plugin: 'test', tier: 'builtin' });
    expect(messages.map((message) => message.role === 'user' ? message.content : '').join('\n'))
      .toContain('[feedback] no-mock-db — 集成测试必须使用真实数据库');

    await dispatch(
      'command.run',
      { name: 'memory', args: ['no-mock-db'] },
      { plugin: 'test', tier: 'builtin' },
    );
    expect(messages.map((message) => (message.role === 'user' ? message.content : '')).join('\n'))
      .toContain('正文 no-mock-db');
  });
});

describe('目录位置', () => {
  it('记忆按项目 slug 分桶，与转录落在同一个项目目录下', () => {
    const dir = memoryDir('C:/home', 'F:/work/demo');
    // 分隔符交给平台：Windows 是 \，POSIX 是 / —— 断言按路径段比，不钉死某一种。
    expect(dir.split(/[\\/]/)).toEqual([
      'C:',
      'home',
      '.deepcode',
      'projects',
      'F--work-demo',
      'memory',
    ]);
  });
});
