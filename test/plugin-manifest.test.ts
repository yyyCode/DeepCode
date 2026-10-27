import { describe, expect, it } from 'vitest';
import { BRIDGED_EVENTS } from '../src/contract/classic';
import {
  isSafeRelativePath,
  validatePlugin,
  type PluginReader,
  type Problem,
} from '../src/contract/plugin-manifest';

/**
 * 一张 相对路径 → 内容 的表，外加一张"存在的路径"的集合。
 * 没列在 files 里的路径 = 读不到；只有列在 dirs 里的才 exists。
 */
function reader(files: Record<string, string>, dirs: readonly string[] = []): PluginReader {
  return {
    read: async (relative) => files[relative],
    exists: async (relative) => relative in files || dirs.includes(relative),
  };
}

const GOOD = JSON.stringify({
  name: 'secret-guard',
  version: '0.1.0',
  description: '拦住把密钥写进仓库',
  uses: ['tool.check'],
});

const HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node guard.mjs', timeout: 5 }] }],
  },
});

function codes(problems: readonly Problem[], level: 'error' | 'warn'): string[] {
  return problems.filter((p) => p.level === level).map((p) => p.code);
}

async function run(files: Record<string, string>, dirs: readonly string[] = []) {
  return validatePlugin('plugins/x', reader(files, dirs));
}

describe('路径的四条硬规则', () => {
  it.each(['./hooks/hooks.json', './main.mjs', './a/b/c.md'])('放行 %j', (value) => {
    expect(isSafeRelativePath(value)).toBe(true);
  });

  it.each([
    'hooks/hooks.json', // 少了 ./ —— 只被"必须以 ./ 开头"这一条拦下
    '/etc/passwd', // 绝对路径
    '../shared/hooks.json', // 逃出插件目录
    './a/../../b', // 同样逃出去，只是绕了一下 —— 只被"不含 .."这一条拦下
    '.\\hooks', // 反斜杠在 Windows 上会被归一成路径分隔符
    './a\\..\\..\\b',
    './hooks\\hooks.json', // 只被"不含反斜杠"这一条拦下：有 ./、没有 ..
  ])('拦下 %j', (value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });
});

describe('一份好清单', () => {
  it('全绿，且归一后的清单拿得到', async () => {
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': HOOKS });
    expect(result.ok).toBe(true);
    expect(codes(result.problems, 'error')).toEqual([]);
    expect(result.manifest?.name).toBe('secret-guard');
    expect(result.manifest?.version).toBe('0.1.0');
    expect(result.manifest?.uses).toEqual(['tool.check']);
  });

  it('钩子被归一：matcher 拆开、超时换算成毫秒', async () => {
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': HOOKS });
    expect(result.hooks).toEqual([
      {
        event: 'PreToolUse',
        tools: ['Write', 'Edit'],
        hooks: [{ command: 'node guard.mjs', timeoutMs: 5000 }],
      },
    ]);
  });

  it('不写 timeout 就是 10 秒', async () => {
    const hooks = JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
    });
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': hooks });
    expect(result.hooks[0]?.hooks[0]?.timeoutMs).toBe(10_000);
    // 没写 matcher = 对所有工具生效
    expect(result.hooks[0]?.tools).toBeUndefined();
  });
});

describe('E 级：装不上', () => {
  it('E2 没有 plugin.json', async () => {
    const result = await run({});
    expect(result.ok).toBe(false);
    expect(codes(result.problems, 'error')).toEqual(['E2']);
  });

  it('E2 不是合法 JSON', async () => {
    const result = await run({ 'plugin.json': '{ 坏' });
    expect(codes(result.problems, 'error')).toEqual(['E2']);
  });

  it.each([
    ['', '空'],
    ['Secret_Guard', '下划线'],
    ['Secret-Guard', '大写'],
    ['-guard', '开头是横线'],
    ['guard-', '结尾是横线'],
    ['guard--x', '连续横线'],
    ['1guard', '数字开头'],
  ])('E3 name %j 不是 kebab-case（%s）', async (name) => {
    const result = await run({ 'plugin.json': JSON.stringify({ name }) });
    expect(codes(result.problems, 'error')).toContain('E3');
  });

  it('E3 缺 name', async () => {
    const result = await run({ 'plugin.json': '{}' });
    expect(codes(result.problems, 'error')).toContain('E3');
  });

  it('E4 version 不是 semver', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', version: 'v1' }) });
    expect(codes(result.problems, 'error')).toEqual(['E4']);
  });

  it('E5 description 不是字符串 / author 是数字', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', description: 3, author: 7 }),
    });
    expect(codes(result.problems, 'error')).toEqual(['E5', 'E5']);
  });

  it('E6 路径逃出插件目录（这是本文件最要紧的一条）', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', hooks: '../shared/hooks.json' }),
    });
    expect(codes(result.problems, 'error')).toContain('E6');
    expect(result.problems.find((p) => p.code === 'E6')?.message).toContain('../shared/hooks.json');
  });

  it('E7 uses 里有非字符串', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', uses: ['a', 3] }) });
    expect(codes(result.problems, 'error')).toEqual(['E7']);
  });

  it('E8 声明的目录不存在', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', commands: './commands' }) });
    expect(codes(result.problems, 'error')).toEqual(['E8']);
  });

  it('E8 声明的 hooks 不存在', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', hooks: './nope.json' }) });
    expect(codes(result.problems, 'error')).toEqual(['E8']);
  });

  it('E9 hooks.json 不是合法 JSON', async () => {
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': '坏' });
    expect(codes(result.problems, 'error')).toEqual(['E9']);
  });

  it('E10 事件名不在 33 个里', async () => {
    const hooks = JSON.stringify({ NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }] });
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': hooks });
    expect(codes(result.problems, 'error')).toEqual(['E10']);
  });

  it('E11 hooks 分组形状不对', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({ PreToolUse: [{ matcher: 'Write' }] }),
    });
    expect(codes(result.problems, 'error')).toEqual(['E11']);
  });

  it('E13 缺 command', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command' }] }] }),
    });
    expect(codes(result.problems, 'error')).toEqual(['E13']);
  });

  it.each([[0], [-1], [1.5], [301], ['10']])('E14 timeout %j 不在 1..300', async (timeout) => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({
        PreToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout }] }],
      }),
    });
    expect(codes(result.problems, 'error')).toEqual(['E14']);
  });
});

describe('W 级：装得上，但照这么写会不work', () => {
  it('W1 未识别的顶层字段点名', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', icon: 'x.png' }) });
    expect(result.ok).toBe(true);
    expect(result.problems.find((p) => p.code === 'W1')?.message).toContain('icon');
  });

  it('W2 未识别的 HookDef 字段点名', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'x', asyncRewake: true, if: 'Bash(git:*)' }] },
        ],
      }),
    });
    const w2 = result.problems.find((p) => p.code === 'W2');
    expect(w2?.message).toContain('asyncRewake');
    expect(w2?.message).toContain('if');
    // 未知字段不影响它装得上，也不影响它仍然被归一
    expect(result.hooks.length).toBe(1);
  });

  it('W3 未桥接的 27 个事件被点名，且不进归一结果', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({
        // 用 PostToolUseFailure 而不是 PostToolUse：后者从 P4d 起是**桥接**的，
        // 拿它当反例会让这条测试测到 W10（uses 里没声明）而不是 W3。
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'x' }] }],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.hooks).toEqual([]);
    expect(result.problems.find((p) => p.code === 'W3')?.message).toContain('PostToolUseFailure');
  });

  it('W3 那句"只桥接了 …"**跟着桥接表走**，不是抄死的一份名单', async () => {
    // 抄死的那一份在 P4d 加了三个事件之后会继续说"只桥接了三个"。这条断言要的是：
    // 文案里出现的是表里的**全部六个**名字 —— 少一个都说明有人又抄了一份。
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'x' }] }],
      }),
    });
    const message = result.problems.find((p) => p.code === 'W3')?.message ?? '';
    for (const name of Object.keys(BRIDGED_EVENTS)) {
      expect(message, `${name} 应当在 W3 的名单里`).toContain(name);
    }
    expect(Object.keys(BRIDGED_EVENTS)).toHaveLength(6);
  });

  it('W4 type: prompt 被跳过并点名', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'prompt', command: 'x' }] }] }),
    });
    // 被跳过之后这个插件确实什么都不做，所以 W9 也响 —— 两条都对，不互相抵销。
    expect(codes(result.problems, 'warn')).toEqual(['W4', 'W9']);
    expect(result.hooks).toEqual([]);
  });

  it('W5 正则 matcher 跳过整组（不是放大到所有工具）', async () => {
    const result = await run({
      'plugin.json': GOOD,
      './hooks/hooks.json': JSON.stringify({
        PreToolUse: [
          { matcher: 'mcp__.*__delete.*', hooks: [{ type: 'command', command: 'x' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'y' }] },
        ],
      }),
    });
    expect(codes(result.problems, 'warn')).toContain('W5');
    // 关键：被跳过的那组**没有**退化成 tools: undefined（那会作用到所有工具）
    expect(result.hooks.length).toBe(1);
    expect(result.hooks[0]?.tools).toEqual(['Write']);
  });

  it('W6 描述了工具却不会执行它', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', uses: ['tool.describe'] }),
    });
    expect(codes(result.problems, 'warn')).toEqual(['W6', 'W9']);
  });

  it('W7 会执行工具却没人管确认 —— 会被 confirm 当未知工具拒掉', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', uses: ['tool.call', 'tool.describe'] }),
    });
    expect(codes(result.problems, 'warn')).toEqual(['W7', 'W9']);
  });

  it('uses 写 * 时 W6/W7 都不响', async () => {
    const result = await run({ 'plugin.json': JSON.stringify({ name: 'x', uses: ['*'] }) });
    // 只剩 W9：这份清单没入口也没钩子，与 uses 无关，那一句仍然该说。
    expect(codes(result.problems, 'warn')).toEqual(['W9']);
  });

  it('W8 有约定目录却没声明 / 声明了但本版本不加载', async () => {
    const undeclared = await run({ 'plugin.json': GOOD }, ['./commands']);
    expect(undeclared.problems.find((p) => p.code === 'W8')?.message).toContain('./commands');

    const declared = await run(
      {
        'plugin.json': JSON.stringify({ name: 'x', commands: './commands' }),
        './commands/a.md': '---\n',
      },
      ['./commands'],
    );
    expect(declared.problems.find((p) => p.code === 'W8')?.message).toContain('不加载');
  });

  it('.mcp.json 不再是 W8：没声明照读，声明了也不再判「不加载」', async () => {
    const undeclared = await run({ 'plugin.json': GOOD, './.mcp.json': '{}' }, ['./.mcp.json']);
    expect(undeclared.problems.filter((p) => p.code === 'W8')).toEqual([]);

    const declared = await run({
      'plugin.json': JSON.stringify({ name: 'x', mcpServers: './conf/mcp.json' }),
      './conf/mcp.json': '{}',
    });
    // 声明成路径仍然只是「存在性校验」的一部分，但不再有那条「本版本不加载」。
    expect(codes(declared.problems, 'error')).toEqual([]);
    expect(declared.problems.filter((p) => p.code === 'W8')).toEqual([]);
  });

  it('W9 既没入口也没钩子', async () => {
    const result = await run({ 'plugin.json': GOOD });
    expect(codes(result.problems, 'warn')).toEqual(['W9']);
  });

  it('W10 钩子桥到的事件没在 uses 里声明 —— 装载时会整个撤掉，所以校验期就说破', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', uses: [] }),
      './hooks/hooks.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    });
    expect(result.problems.find((p) => p.code === 'W10')?.message).toContain('tool.check');
    // 是警告不是错误：清单本身没毛病，只是一装就会失效。
    expect(result.ok).toBe(true);
  });

  it('W10 认声明形态：精确名与 `*` 都不响', async () => {
    const hooks = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    for (const uses of [['session.start'], ['*'], ['tool.check', 'session.start']]) {
      const result = await run({
        'plugin.json': JSON.stringify({ name: 'x', uses }),
        './hooks/hooks.json': hooks,
      });
      expect(codes(result.problems, 'warn')).not.toContain('W10');
    }
  });

  it('W10 对 tool.* 通配也认 —— PreToolUse 桥到 tool.check', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', uses: ['tool.*'] }),
      './hooks/hooks.json': HOOKS,
    });
    expect(codes(result.problems, 'warn')).not.toContain('W10');
  });
});

describe('入口模块的探测', () => {
  it('不声明 entry 就按 main.mjs / main.js / main.ts 顺序探测', async () => {
    const result = await run({ 'plugin.json': GOOD, './main.js': '' });
    expect(result.entry).toBe('./main.js');
  });

  it('main.mjs 优先于 main.js', async () => {
    const result = await run({ 'plugin.json': GOOD, './main.mjs': '', './main.js': '' });
    expect(result.entry).toBe('./main.mjs');
  });

  it('声明了就用声明的，不去探测', async () => {
    const result = await run({
      'plugin.json': JSON.stringify({ name: 'x', entry: './start.mjs' }),
      './start.mjs': '',
      './main.mjs': '',
    });
    expect(result.entry).toBe('./start.mjs');
  });

  it('一个都没有就是"没有入口"，不是错误', async () => {
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': HOOKS });
    expect(result.entry).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe('两种 hooks.json 形态都收', () => {
  it('带包装的（插件格式）', async () => {
    const wrapped = JSON.stringify({
      description: 'x',
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }] },
    });
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': wrapped });
    expect(result.hooks.length).toBe(1);
  });

  it('不带的（设置格式）', async () => {
    const direct = JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }] });
    const result = await run({ 'plugin.json': GOOD, './hooks/hooks.json': direct });
    expect(result.hooks.length).toBe(1);
  });
});

describe('读不了的文件不会被当成不存在', () => {
  it('read 抛错时报 E2，不把异常抛给调用方', async () => {
    const throwing: PluginReader = {
      read: async () => {
        throw new Error('EACCES');
      },
      exists: async () => true,
    };
    const result = await validatePlugin('plugins/x', throwing);
    expect(result.ok).toBe(false);
    expect(result.problems.find((p) => p.code === 'E2')?.message).toContain('EACCES');
  });
});
