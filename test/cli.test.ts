import { describe, expect, it } from 'vitest';
import { createHarness, scriptedProvider } from './harness';
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
