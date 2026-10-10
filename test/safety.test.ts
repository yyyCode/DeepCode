import type { Interface } from 'node:readline';
import { describe, expect, it, vi } from 'vitest';
import { createHarness } from './harness';
import { createPromptSink } from '../src/cli/prompt';
import { createProcessNoun } from '../src/core/nouns/process';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import { editTool } from '../src/builtins/tools/edit';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface, ModelProvider } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';

/**
 * spawn 的替身。断言"没有起进程"必须看这个，而不是看命令有没有留下副作用：
 * 副作用是靠 kill 抢在命令执行之前的竞态，跑得快就漏 —— 那种断言是看运气，不是看代码。
 */
const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(() => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  })),
}));
vi.mock('node:child_process', () => ({ spawn: spawnSpy }));

/** 够用的 readline 替身：question 永不回答，close 由测试手动触发。 */
function fakeRl(): { rl: Interface; emitClose: () => void } {
  let closeHandlers: Array<() => void> = [];
  const rl = {
    once: (event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb);
    },
    off: (event: string, cb: () => void) => {
      if (event === 'close') closeHandlers = closeHandlers.filter((h) => h !== cb);
    },
    question: () => {
      /* 模拟"用户一直没回答" */
    },
    close: () => {},
  } as unknown as Interface;
  return { rl, emitClose: () => closeHandlers.forEach((h) => h()) };
}

/** 把插件的 on 接到 harness 上（matcher 形式也支持）。 */
function registerInto(h: ReturnType<typeof createHarness>, plugin: { name: string; register: any }): void {
  plugin.register((pattern: string, second: any, third?: any) => {
    if (third !== undefined) h.on('builtin', plugin.name, pattern, second, third as EventHook);
    else h.on('builtin', plugin.name, pattern, second as EventHook);
  });
}

describe('确认提示必须能被叫醒（否则会话挂死）', () => {
  it('Ctrl-C 掐断 turn 时，ask 立刻按拒绝收场', async () => {
    const { rl } = fakeRl();
    const controller = new AbortController();
    const sink = createPromptSink(rl, { signalOf: () => controller.signal, interactive: true });

    const pending = sink.ask('执行 Edit? (y/N) ');
    controller.abort();

    // 曾经的写法是裸的 `new Promise(resolve => rl.question(q, resolve))`：
    // signal 被 abort 了，而 rl.question 的回调永远不来 —— 这个 await 挂住整个会话，
    // 连 repl 的 turns.end() 都跑不到，busy 永远停在 true。
    await expect(pending).resolves.toBe('n');
  });

  it('提问之前 turn 就已经中断 —— 同样不放行', async () => {
    const { rl } = fakeRl();
    const controller = new AbortController();
    controller.abort();
    const sink = createPromptSink(rl, { signalOf: () => controller.signal, interactive: true });

    // 已 abort 的 signal 不会补发 abort 事件，所以这一条走的是显式的 aborted 检查。
    await expect(sink.ask('执行 Bash? (y/N) ')).resolves.toBe('n');
  });

  it('Ctrl-D 关掉 readline 时也收场成拒绝', async () => {
    const { rl, emitClose } = fakeRl();
    const sink = createPromptSink(rl, {
      signalOf: () => new AbortController().signal,
      interactive: true,
    });

    const pending = sink.ask('执行 Write? (y/N) ');
    emitClose();

    await expect(pending).resolves.toBe('n');
  });

  it('非交互环境（管道 / CI）默认拒绝', async () => {
    const { rl } = fakeRl();
    const sink = createPromptSink(rl, {
      signalOf: () => new AbortController().signal,
      interactive: false,
    });

    await expect(sink.ask('执行 Bash? (y/N) ')).resolves.toBe('n');
  });
});

describe('中断过的 turn 不许再起命令', () => {
  it('signal 已经 abort 时，连进程都不起', async () => {
    spawnSpy.mockClear();
    const controller = new AbortController();
    controller.abort();

    const result = await createProcessNoun().run('echo hi > ran.txt', {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('用户中断');
    // 关键断言。之前在确认提示上按 Ctrl-C 之后再答 y，命令会一无所知地照跑完 ——
    // 那是确认路径上的 fail-open。注意"事后 kill"不算数：它要跟命令赛跑，
    // 快命令会先跑完。真正的合同是**不 spawn**。
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('Edit 不许在校验与写入之间被改过的文件上写坏内容', () => {
  it('第二次读不到 old_string 时报错，一个字节都不写', async () => {
    // 第一次读有 old_string（校验通过），第二次读没有了（文件被外部改过）。
    // 旧代码会对 indexOf 的 -1 直接做 slice 算术，把文件内容搅乱写回去。
    const reads = ['const a = 1;\n', 'const a = 2;\n'];
    const writes: string[] = [];
    let readCount = 0;

    const engine = {
      fs: {
        read: async () => reads[Math.min(readCount++, reads.length - 1)]!,
        write: async (_path: string, content: string) => {
          writes.push(content);
        },
      },
      store: { set: async () => {} },
    } as unknown as EngineInterface;

    const h = createHarness({
      engine,
      coreImpls: { 'tool.call': () => ({ deny: 'unknown tool' }) },
    });
    registerInto(h, editTool);

    const result: any = await h.dispatch(
      'tool.call',
      {
        tool: 'Edit',
        input: { file_path: 'x.ts', old_string: 'const a = 1;', new_string: 'const a = 9;' },
        toolUseId: 't1',
      },
      CORE_ORIGIN,
    );

    expect(String(result.value)).toContain('ERROR');
    expect(writes).toHaveLength(0);
  });
});

describe('被中断的 turn 不退避重试', () => {
  it('返回 interrupted，不睡那一秒、也不报"本 turn 失败"', async () => {
    const notices: string[] = [];
    const controller = new AbortController();
    const provider: ModelProvider = {
      name: 'aborting',
      async *stream() {
        controller.abort(); // 用户按了 Ctrl-C
        throw new Error('aborted');
      },
    };

    const built = await createEngine({
      plugins: [],
      provider,
      ui: { print: () => {}, notice: (line) => notices.push(line), ask: async () => 'n' },
      sessionInfo: { id: 's', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => controller.signal,
    });

    const startedAt = Date.now();
    const reason = await runTurn(
      {
        $: built.$,
        provider,
        signal: controller.signal,
        dispatch: built.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      [{ role: 'user', content: '在吗' }],
    );
    const elapsed = Date.now() - startedAt;

    expect(reason).toBe('interrupted');
    expect(elapsed).toBeLessThan(900); // 没走 provider 出错的那一秒退避
    expect(notices.join('\n')).toContain('中断');
    expect(notices.join('\n')).not.toContain('本 turn 失败');
  });
});
