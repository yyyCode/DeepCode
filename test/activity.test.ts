import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Plugin } from '../src/contract/plugin';
import type { Message, ModelProvider, StreamEvent } from '../src/contract/model-provider';
import type { LoopContext } from '../src/core/loop';
import { runTurn } from '../src/core/loop';
import { createEngine } from '../src/core/create';
import { createPalette } from '../src/cli/ansi';
import { createRenderer, type Renderer } from '../src/cli/render';
import { createActivityPlugin } from '../src/cli/activity';
import { createSessionChanges, type SessionChanges } from '../src/cli/changes';
import { createTally, type Tally } from '../src/cli/tally';
import {
  MAX_LINES,
  actionLine,
  actionTarget,
  exitCodeOf,
  formatDuration,
  resultLines,
} from '../src/cli/result-view';

const plain = createPalette(false);

/** 一块假的 TTY：写进去的字节攒在这儿，好在断言里逐字看。 */
function fakeTty(columns = 80): { stream: NodeJS.WriteStream; text: () => string } {
  let text = '';
  const stream = {
    isTTY: true,
    columns,
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    on: () => stream,
  };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => text };
}

/**
 * 活动面**活着**的渲染器：不真的起定时器（注入一个空 ticker），
 * 于是每一帧都能逐字节断言，测试也不必等 90 毫秒。
 */
function liveRenderer(columns = 80): { render: Renderer; text: () => string } {
  const tty = fakeTty(columns);
  const render = createRenderer({
    stream: tty.stream,
    live: true,
    ticker: () => () => {},
    now: () => 0,
  });
  return { render, text: tty.text };
}

describe('result-view —— 纯函数', () => {
  it('耗时不满一秒不出现', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(999)).toBe('');
    expect(formatDuration(1000)).toBe(' · 1.0s');
    expect(formatDuration(3240)).toBe(' · 3.2s');
  });

  it('每个工具报自己的落点', () => {
    expect(actionTarget('Bash', { command: 'pnpm test' })).toBe('pnpm test');
    expect(actionTarget('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(actionTarget('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(actionTarget('Task', { subagent_type: 'explore', description: '找 X' })).toBe(
      'explore 找 X',
    );
    // 认不出来的输入退化成"没有落点"，而不是把 undefined 印到屏幕上。
    expect(actionTarget('Bash', {})).toBe('');
    expect(actionTarget('Bash', null)).toBe('');
  });

  it('退出码：成功的尾巴上、失败的头上各一句', () => {
    expect(exitCodeOf('hello\n[退出码 0]')).toBe(0);
    expect(exitCodeOf('ERROR: 命令以退出码 1 结束\nboom')).toBe(1);
    expect(exitCodeOf('ERROR: 命令以退出码 137 结束')).toBe(137);
    // ⚠️ 别从正文里随便捞一个数字 —— 那句 `[退出码 N]` 必须是**最后一行**。
    expect(exitCodeOf('看到 [退出码 3] 这几个字\n还有别的输出')).toBeUndefined();
    expect(exitCodeOf('没有退出码')).toBeUndefined();
  });

  it('摘要截到 6 行，尾部如实报还剩多少', () => {
    const output = Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join('\n');
    const lines = resultLines('Read', output, true, 0, plain);
    // 第 0 行是 `⎿ …`，其后 6 行正文，再一行 `… 还有 14 行`。
    expect(lines).toHaveLength(1 + MAX_LINES + 1);
    expect(lines[0]).toContain('20 行');
    expect(lines.at(-1)).toBe('     … 还有 14 行');
  });

  it('报错时 `ERROR:` 那一行提到最前 —— 那是用户最想先看到的', () => {
    const output = '第一行\n第二行\nERROR: 命令以退出码 1 结束\n第四行';
    const lines = resultLines('Bash', output, false, 0, plain);
    expect(lines[1]).toBe('     ERROR: 命令以退出码 1 结束');
    expect(lines[2]).toBe('     第一行');
  });

  it('动作行带上耗时；不满一秒时那一段不出现', () => {
    expect(actionLine('Bash', { command: 'ls' }, plain)).toBe('⏺ Bash  ls');
    expect(actionLine('Bash', { command: 'ls' }, plain, 3200)).toBe('⏺ Bash  ls · 3.2s');
  });
});

describe('render —— 活动区是借来的那一块', () => {
  it('settle 先把活动区抹掉，再把永久行写进转录', () => {
    const { render, text } = liveRenderer();
    render.activity(['⠋ 思考中…']);
    expect(text()).toContain('⠋ 思考中…');

    const mid = text();
    render.settle(['⏺ Read  a.ts', '  ⎿  24 行']);
    const after = text().slice(mid.length);
    // 抹掉那一屏：先回行首、清行，再回到第一行。
    expect(after.startsWith('\r\u001b[K\r')).toBe(true);
    expect(after).toContain('⏺ Read  a.ts\n  ⎿  24 行\n');
  });

  it('多行活动区抹得干净 —— 屏幕行数与账面必须严格相等', () => {
    const { render, text } = liveRenderer();
    render.activity(['一', '二', '三']);
    const mid = text();
    render.settle(['done']);
    const after = text().slice(mid.length);
    // 三行：清三次，中间下移两次，最后上移两行回到第一行。
    expect(after).toBe('\r\u001b[K\u001b[1B\u001b[K\u001b[1B\u001b[K\u001b[2A\rdone\n');
  });

  it('活动行超宽就截断 —— 折行会让上移的行数算错', () => {
    // 9 列：宽字符一个占 2 列，于是"这是一行"正好 8 列，第 9 列留给省略号。
    const { render, text } = liveRenderer(9);
    render.activity(['这是一行很长很长很长的活动文字']);
    expect(text()).toContain('这是一行…');
  });

  it('**非 TTY 下活动面一个字节都不产出** —— 管道输出与 P6a 之前逐字节相同', () => {
    const tty = fakeTty();
    const render = createRenderer({ stream: tty.stream, live: false } as never);
    render.activity(['⠋ 思考中…']);
    render.thinking();
    render.settle(['⏺ Bash  ls', '  ⎿  1 行']);
    expect(tty.text()).toBe('');
  });

  it('非 TTY 下 `print` / `notice` 照旧写字（那条路没有被活动面碰过）', () => {
    const tty = fakeTty();
    const render = createRenderer({ stream: tty.stream, live: false });
    render.print('模型说了一句话');
    expect(tty.text()).toBe('模型说了一句话\n');
  });
});

// ── 插件：挂到真实装配上，看屏幕上真出现了什么 ──

const activityPlugin = (
  render: Renderer,
  extra: { readonly changes?: SessionChanges; readonly tally?: Tally } = {},
): Plugin =>
  createActivityPlugin({
    render,
    palette: plain,
    changes: extra.changes ?? createSessionChanges(),
    tally: extra.tally ?? createTally(() => 0),
    now: () => 0,
  });

function toolPlugin(tool: string, value: string, seen: string[]): Plugin {
  return {
    name: 'test-tool',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      on('tool.describe', { tool }, () => ({ description: '测试工具', inputSchema: {} }));
      on('tool.call', { tool }, () => {
        seen.push(tool);
        return { value };
      });
    },
  };
}

function allowPlugin(): Plugin {
  return {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };
}

function denyPlugin(): Plugin {
  return {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'deny', rule: '沙箱不许' }) as const);
    },
  };
}

async function run(options: {
  plugins: readonly Plugin[];
  value: string;
  tool?: string;
  input?: unknown;
  render: Renderer;
  answer?: string;
}) {
  const tool = options.tool ?? 'Read';
  const called: string[] = [];
  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'tool_use', id: 'u1', name: tool, input: options.input ?? { file_path: 'a.ts' } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [...options.plugins, toolPlugin(tool, options.value, called)],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => options.answer ?? 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $,
    provider,
    signal: new AbortController().signal,
    dispatch,
    systemPrompt: 's',
    turnIndex: 0,
    maxHops: 1,
  };
  await runTurn(ctx, messages);
  return { called, messages };
}

describe('活动面插件 —— 一条会话上屏幕的东西', () => {
  it('工具跑完留下动作行 + 结果行，退出码与截断标记都在', async () => {
    const { render, text } = liveRenderer();
    const output = ['a', 'b', 'ERROR: 命令以退出码 1 结束', ...Array.from({ length: 12 }, (_, i) => `第 ${i} 行`)].join('\n');

    const { called } = await run({
      plugins: [activityPlugin(render), allowPlugin()],
      value: output,
      tool: 'Bash',
      input: { command: 'pnpm test' },
      render,
    });

    expect(called).toEqual(['Bash']);
    const screen = text();
    expect(screen).toContain('⏺ Bash  pnpm test');
    expect(screen).toContain('⎿');
    expect(screen).toContain('退出码 1');
    expect(screen).toContain('… 还有');
  });

  it('⚠️ 终端上印的是截断版，回喂模型的仍是全文（两个消费者两条口径）', async () => {
    const { render, text } = liveRenderer();
    const output = Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join('\n');

    const { messages } = await run({
      plugins: [activityPlugin(render), allowPlugin()],
      value: output,
      render,
    });

    // 模型那一侧：一个字都没少。
    const tool = messages.find((m) => m.role === 'tool');
    const content = tool?.role === 'tool' ? tool.results[0]?.content : undefined;
    expect(content).toBe(output);

    // 终端那一侧：第 7 行往后的正文没了，但**说了还剩多少**。
    const screen = text();
    expect(screen).toContain('第 5 行');
    expect(screen).not.toContain('第 6 行');
    expect(screen).toContain('… 还有 14 行');
  });

  it('被拒绝的工具也看得见 —— 今天它只回喂模型，终端上一片空白', async () => {
    const { render, text } = liveRenderer();
    const { called } = await run({
      plugins: [activityPlugin(render), denyPlugin()],
      value: 'ok',
      render,
    });

    expect(called).toEqual([]);
    expect(text()).toContain('⏺ Read  a.ts');
    expect(text()).toContain('已拒绝 —— 沙箱不许');
  });

  it('工具自己返回 deny 时，活动行仍然收得掉（不会留半行挂在那儿）', async () => {
    const { render, text } = liveRenderer();
    const deny: Plugin = {
      name: 'test-call-deny',
      uses: ['tool.call'],
      register(on) {
        on('tool.call', { tool: 'Read' }, () => ({ deny: '进程层拒绝' }));
      },
    };

    await run({ plugins: [activityPlugin(render), allowPlugin(), deny], value: 'ok', render });
    expect(text()).toContain('拒绝 —— 进程层拒绝');
  });

  it('管道里一个字节的界面噪声都没有', async () => {    const tty = fakeTty();
    // 默认 live = isTTY && TERM !== 'dumb' —— 这里给的就是一块真 TTY，但显式关掉活动面，
    // 走的正是管道那一支。
    const render = createRenderer({ stream: tty.stream, live: false });
    await run({
      plugins: [activityPlugin(render), allowPlugin()],
      value: 'ok',
      render,
    });
    expect(tty.text()).toBe('');
  });

  it('⚠️ 改完之后印 `+3`，**不是**工具自己那段正文', async () => {
    const { render, text } = liveRenderer();
    const changes = createSessionChanges();
    // 数字是从**会话改动表**读的（真跑的时候由 session-changes 插件记），
    // 所以这里先把那一条摆进去 —— 插件的职责只是把它印出来。
    changes.record({
      path: resolve('a.ts'),
      before: { kind: 'absent' },
      after: { kind: 'text', text: 'a\nb\nc' },
    });

    await run({
      plugins: [activityPlugin(render, { changes }), allowPlugin()],
      value: '已写入 3 行',
      tool: 'Write',
      input: { file_path: 'a.ts', content: 'a\nb\nc' },
      render,
    });

    const screen = text();
    expect(screen).toContain('⏺ Write  a.ts');
    expect(screen).toContain('  ⎿  +3');
    // "已写入 3 行"对用户没有信息量，**改了多少**才是这一格的意义。
    expect(screen).not.toContain('已写入 3 行');
  });

  it('一轮跑完落一行摘要；token 是估的就标 `（估）`，账也记在会话那份上', async () => {
    const { render, text } = liveRenderer();
    const tally = createTally(() => 0);

    await run({
      plugins: [activityPlugin(render, { tally }), allowPlugin()],
      value: 'ok',
      render,
    });

    const screen = text();
    expect(screen).toContain('本轮 1 次工具调用');
    // 假 provider 不报用量 → `turn.complete` 带 usageEstimated，不标就是报假账。
    expect(screen).toContain('（估）');
    // 同一本账：每轮摘要与退出摘要读的是**同一个** `tally`。
    expect(tally.toolCalls).toBe(1);
    expect(tally.tokens).toBeGreaterThan(0);
  });
});
