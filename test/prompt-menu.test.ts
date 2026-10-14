import { EventEmitter } from 'node:events';
import type { Interface, Key } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { createPromptSink } from '../src/cli/prompt';
import type { AskOptions } from '../src/contract/engine';

/**
 * 确认菜单（上下键 + 回车）这一屏。
 *
 * 替身只造两样真东西才有的能力：`setRawMode` 与 `keypress`。菜单本来只为真 TTY 而开，
 * 而这两样正是它依赖的全部 —— 把它们造出来，屏幕账目、监听来往、fail-closed 的落点
 * 就都能逐字节断言，不必去挂一个真 pty。
 */

/** 后端循环用的三个答案：放行一次 / 本会话总是 / 拒绝。 */
const CHOICES: AskOptions = {
  choices: [
    { value: 'y', label: '允许这一次' },
    { value: 'a', label: '本次会话总是允许' },
    { value: 'n', label: '拒绝' },
  ],
  fallback: 'n',
};

type FakeInput = EventEmitter & {
  setRawMode(mode: boolean): void;
  resume(): FakeInput;
};

function world(): {
  sink: ReturnType<typeof createPromptSink>;
  stream: FakeInput;
  rl: Interface;
  rawModes: boolean[];
  abort: () => void;
  text: () => string;
  press: (chunk: string | undefined, key: string, ctrl?: boolean) => void;
} {
  const chunks: string[] = [];
  const out = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const stream = new EventEmitter() as FakeInput;
  stream.setRawMode = () => {};
  stream.resume = () => stream;

  const rawModes: boolean[] = [];
  stream.setRawMode = (mode) => rawModes.push(mode);

  const events = new EventEmitter();
  (events as unknown as { input: FakeInput }).input = stream;
  const rl = events as unknown as Interface;

  const controller = new AbortController();
  const sink = createPromptSink(rl, {
    signalOf: () => controller.signal,
    interactive: true,
    out,
  });

  return {
    sink,
    stream,
    rl,
    rawModes,
    abort: () => controller.abort(),
    text: () => chunks.join(''),
    press: (chunk, name, ctrl = false) =>
      stream.emit('keypress', chunk, { name, ctrl, meta: false, shift: false } as Key),
  };
}

/** 此刻屏幕上高亮的那一项 —— 从最后一次重画里取（每一帧只有一个 ❯）。 */
function highlighted(text: string): string | undefined {
  const rows = text.split('\n').filter((line) => line.includes('❯'));
  return rows.at(-1)?.replace('\u001b[K', '').replace('❯ ', '');
}

describe('确认菜单：上下键选、回车定', () => {
  it('第一个选项就是回车那一个 —— 回车即放行这一次，并落成一行永久行', async () => {
    const w = world();
    const pending = w.sink.ask('执行 Bash?', CHOICES);

    expect(w.text()).toContain('⏸ 执行 Bash?');
    expect(highlighted(w.text())).toBe('允许这一次');

    w.press(undefined, 'return');

    await expect(pending).resolves.toBe('y');
    // 那一屏收掉之后留下的是"问了什么、人挑了什么"，不是三行还没擦掉的菜单。
    expect(w.text().endsWith('⏸ 执行 Bash?  允许这一次\n')).toBe(true);
    // 进了 raw 模式又出来，一步不多。
    expect(w.rawModes).toEqual([true, false]);
  });

  it('下键把光标移过去，回车选中移过去的那一项', async () => {
    const w = world();
    const pending = w.sink.ask('执行 Edit?', CHOICES);

    w.press(undefined, 'down');
    expect(highlighted(w.text())).toBe('本次会话总是允许');
    w.press(undefined, 'down');
    expect(highlighted(w.text())).toBe('拒绝');
    // 到头会绕回第一项 —— 越界不是"没反应"，那样用户会以为键盘坏了。
    w.press(undefined, 'down');
    expect(highlighted(w.text())).toBe('允许这一次');
    // 上键同理，反着绕。
    w.press(undefined, 'up');
    expect(highlighted(w.text())).toBe('拒绝');

    w.press(undefined, 'return');
    await expect(pending).resolves.toBe('n');
  });

  it('直接按选项的 value（y / a / n）＝选中它 —— 旧手感还在', async () => {
    const w = world();
    const pending = w.sink.ask('执行 Write?', CHOICES);
    w.press('a', 'a');
    await expect(pending).resolves.toBe('a');
  });
});

describe('菜单的收场：一律 fail-closed', () => {
  it('Esc 与 Ctrl-D 都是取消：回 fallback，那一屏擦干净、不留永久行', async () => {
    for (const name of ['escape', 'd']) {
      const w = world();
      const pending = w.sink.ask('执行 Bash?', CHOICES);
      w.press(undefined, name, name === 'd');
      await expect(pending).resolves.toBe('n');
      // 1 行问题 + 3 个选项，上移 4 行、清到屏幕底为止，之后什么都没有。
      expect(w.text().endsWith('\u001b[4A\r\u001b[0J')).toBe(true);
    }
  });

  it('Ctrl-C：既按 fallback 收场，又把整个 turn 掐断', async () => {
    const w = world();
    let sigint = 0;
    w.rl.on('SIGINT', () => {
      sigint += 1;
    });

    const pending = w.sink.ask('执行 Bash?', CHOICES);
    w.press(undefined, 'c', true);

    await expect(pending).resolves.toBe('n');
    // raw 模式下终端自己不再产生 SIGINT，这一步得我们自己补上 ——
    // 少了它，^C 就只是"拒了这一次"，而用户按的是"停下"。
    expect(sigint).toBe(1);
  });

  it('turn 被掐断（signal abort）时按 fallback 收场，而不是挂在那儿', async () => {
    const w = world();
    const pending = w.sink.ask('执行 Bash?', CHOICES);
    w.abort();

    await expect(pending).resolves.toBe('n');
    expect(w.rawModes).toEqual([true, false]);
  });

  it('非交互环境（管道 / CI）不画菜单，直接回 fallback', async () => {
    const w = world();
    const sink = createPromptSink(w.rl, {
      signalOf: () => new AbortController().signal,
      interactive: false,
    });
    await expect(sink.ask('执行 Bash?', CHOICES)).resolves.toBe('n');
    // 一个字节都不落笔 —— 管道里多一行都是污染。
    expect(w.text()).toBe('');
  });
});

describe('菜单期间 readline 自己的按键处理被让开', () => {
  it('摘掉又原样装回：菜单里的按键不落到 readline 手里，收场后按键照旧归它', async () => {
    const w = world();
    const seen: string[] = [];
    // 冒充 readline 挂上来的那一个：真实现里它会翻历史、会把字母回显进行缓冲。
    const readlineKeys = (chunk: string): void => {
      seen.push(chunk);
    };
    w.stream.on('keypress', readlineKeys);

    const pending = w.sink.ask('执行 Bash?', CHOICES);
    expect(w.stream.listeners('keypress')).not.toContain(readlineKeys);

    w.press(undefined, 'down');
    expect(seen).toEqual([]); // 上下键没有同时被两边各处理一遍

    w.press(undefined, 'return');
    await expect(pending).resolves.toBe('a'); // 光标已经移到第二项上了

    expect(w.stream.listeners('keypress')).toContain(readlineKeys);
    w.press('x', 'x');
    expect(seen).toEqual(['x']); // 装回去的那一个又能收到按键了
  });
});

describe('输入面撑不起菜单时退回逐行问', () => {
  it('没有 setRawMode 就不开菜单，选项摊在提示语里，答案照旧认 y / a / n', async () => {
    const events = new EventEmitter();
    let query = '';
    let answer: (line: string) => void = () => {};
    (events as unknown as { input: unknown }).input = new EventEmitter();
    (events as unknown as { question: (q: string, cb: (line: string) => void) => void }).question = (
      q,
      cb,
    ) => {
      query = q;
      answer = cb;
    };

    const sink = createPromptSink(events as unknown as Interface, {
      signalOf: () => new AbortController().signal,
      interactive: true,
    });

    const pending = sink.ask('执行 Bash?', CHOICES);
    // 摊平的是**值**不是文案：内核照旧只认 y / a / n。
    expect(query).toContain('y=允许这一次');
    expect(query).toContain('n=拒绝');
    answer('a');
    await expect(pending).resolves.toBe('a');
  });
});
