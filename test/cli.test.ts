import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHarness, scriptedProvider } from './harness';
import { parseArgs, readVersion } from '../src/cli/args';
import { streamPlugin } from '../src/cli/stream';
import { cliPlugins } from '../src/cli/plugins';
import { createTurnSignals } from '../src/cli/turns';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Renderer } from '../src/cli/render';
import type { EventHook } from '../src/contract/plugin';
import type { Message } from '../src/contract/model-provider';

/** 假 renderer：只把 delta 攒起来，好在断言里看到模型到底说出了什么。 */
function spyRenderer(): { render: Renderer; written: () => string } {
  let pending = '';
  return {
    render: {
      print: () => {},
      notice: () => {},
      ask: async () => 'n',
      delta: (text) => {
        pending += text;
      },
      newline: () => {},
    },
    written: () => pending,
  };
}

describe('cli-stream：模型说的话必须到终端上', () => {
  it('turn.step 的每个增量都送进 renderer.delta', async () => {
    const { render, written } = spyRenderer();
    const h = createHarness();
    const plugin = streamPlugin(render);
    plugin.register(((pattern: string, second: any, third?: any) => {
      if (third !== undefined) h.on('builtin', plugin.name, pattern, second, third as EventHook);
      else h.on('builtin', plugin.name, pattern, second as EventHook);
    }) as any);

    await h.dispatch('turn.step', { delta: '改' }, CORE_ORIGIN);
    await h.dispatch('turn.step', { delta: '好了' }, CORE_ORIGIN);

    expect(written()).toBe('改好了');
  });

  it('没有这条 hook 时，turn.step 静默走兜底 —— 这就是"CLI 不会说话"的原始 bug', async () => {
    // 反向钉住上面那条测试的必要性：内核（NOTIFICATION_EVENTS 的链尾兜底）
    // 只会返回空答复，一个字都不会画。所以文本出口必须由插件提供，
    // 而 C1/C2 那批测试断言的是事件链和文件内容，看不见终端上有没有字。
    const h = createHarness();
    const result = await h.dispatch('turn.step', { delta: '改' }, CORE_ORIGIN);
    expect(result).toEqual({});
  });
});

describe('cli-turns：Ctrl-C 只掐断当前 turn', () => {
  it('被中断之后，下一个 turn 拿到的是干净的 signal', () => {
    const turns = createTurnSignals();

    const first = turns.begin();
    expect(first.aborted).toBe(false);

    turns.onSigint(); // 用户按了 Ctrl-C
    expect(first.aborted).toBe(true); // 当前这个 turn 被掐断
    expect(turns.current().aborted).toBe(true);
    turns.end();

    const second = turns.begin(); // 用户接着往下问
    expect(second.aborted).toBe(false); // 不被上一次中断连坐
    expect(turns.current()).toBe(second);
    turns.end();
  });
});

describe('cli 装配：真实内核 + CLI 插件清单', () => {
  it('模型的文本会走到 renderer 上（钉住 main.ts 用的那份清单）', async () => {
    // 这条是"CLI 不会说话"那个 bug 的回归测试：走真实 createEngine、真实 runTurn、
    // 以及 main.ts 真正装载的那份插件清单，断言文本确实出现在渲染器上。
    // 光有 cli-stream 的单测挡不住"清单里少装了它"。
    const { render, written } = spyRenderer();
    const provider = scriptedProvider([
      [{ type: 'text', text: '你好' }, { type: 'done', stopReason: 'end_turn' }],
    ]);

    const built = await createEngine({
      plugins: cliPlugins(render),
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
      sessionInfo: { id: 'cli-test', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });

    const messages: Message[] = [{ role: 'user', content: '打个招呼' }];
    await runTurn(
      {
        $: built.$,
        provider,
        signal: new AbortController().signal,
        dispatch: built.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(written()).toBe('你好');
  });
});

describe('cli 参数：开关不能被当成话发给模型', () => {
  it('--help / -h 是看用法', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('--version / -V 是看版本（不是 -v，那个字母留给 verbose）', () => {
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-V'])).toEqual({ kind: 'version' });
  });

  it('没认出来的 argv 原样拼成提示词 —— 这才是主要用法', () => {
    expect(parseArgs(['给', 'utils.ts', '加个时区'])).toEqual({
      kind: 'prompt',
      text: '给 utils.ts 加个时区',
      resume: { kind: 'none' },
    });
    expect(parseArgs([])).toEqual({ kind: 'prompt', text: '', resume: { kind: 'none' } });
  });

  it('--resume（无值）接上当前目录最近一次会话', () => {
    expect(parseArgs(['--resume'])).toEqual({
      kind: 'prompt',
      text: '',
      resume: { kind: 'latest' },
    });
  });

  it('--resume=<id> 接上指定会话', () => {
    const action = parseArgs(['--resume=abc']);
    expect(action).toEqual({ kind: 'prompt', text: '', resume: { kind: 'id', id: 'abc' } });
  });

  it('--resume= 空值退化成 latest', () => {
    expect(parseArgs(['--resume='])).toEqual({
      kind: 'prompt',
      text: '',
      resume: { kind: 'latest' },
    });
  });

  it('--resume 后面的裸 token 是提示词，不是 id（只认等号形态）', () => {
    // 反向钉住：写成"--resume 后面跟一个裸 token"的话，
    // `deepcode --resume 继续修` 里那句话到底是 id 还是提示词就分不开了。
    const action = parseArgs(['--resume', '继续修测试']);
    if (action.kind !== 'prompt') throw new Error('expected prompt');
    expect(action.text).toBe('继续修测试');
    expect(action.resume.kind).toBe('latest');
  });

  it('--resume 开关本身不进提示词', () => {
    const action = parseArgs(['把', '--resume', '这个', '改了']);
    if (action.kind !== 'prompt') throw new Error('expected prompt');
    expect(action.text).toBe('把 这个 改了');
  });

  it('--help 优先于 --resume', () => {
    expect(parseArgs(['--help', '--resume'])).toEqual({ kind: 'help' });
  });

  it('两个开关同时给时，先给用法', () => {
    expect(parseArgs(['--version', '--help'])).toEqual({ kind: 'help' });
  });

  it('readVersion 报的是 package.json 里那个号', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('真跑一遍 bin：没有 key、没有配置时，--help 也该只打用法', async () => {
    // 反向钉住这个 bug：开关若又漏成提示词，这一步会走进"要 key"的分支，
    // 以非零码退出（execFile 会 reject），测试就红了。
    // 把 HOME/USERPROFILE 指到不存在的目录，顺便保证它**不会**真的去调模型 ——
    // 免得哪天这个开关真的坏了，测试却替你花掉一次 API 调用。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: resolve(process.cwd(), 'no', 'such', 'home'),
      HOME: resolve(process.cwd(), 'no', 'such', 'home'),
    };
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_BASE_URL',
      'DEEPCODE_MODEL',
      'DEEPCODE_DEBUG',
    ]) {
      delete env[name];
    }

    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve(process.cwd(), 'bin', 'deepcode.mjs'), '--help'],
      { cwd: process.cwd(), env },
    );

    expect(stdout).toContain('用法');
    expect(stdout).toContain('/exit');
  }, 60_000);
});
