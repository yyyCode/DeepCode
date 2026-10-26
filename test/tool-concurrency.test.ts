import { describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamEvent, ToolResult } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import type { TurnReason } from '../src/contract/turn';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';

/**
 * 只读工具并发、写工具串行。
 *
 * 两个约束同时钉：
 * 1. **真的重叠**：两个 `readOnly: true` 的工具必须都在对方结束前开始 —— 不是"看起来快"。
 * 2. **位置不能乱**：`tool_use` 的顺序、`tool.result` 的顺序、回给模型的结果顺序，
 *    都必须与模型要的顺序一致，哪怕执行是反着完成的。
 */

type ToolDef = {
  readonly name: string;
  /** 默认 `false`：没声明的工具按"会写"处理，串行。 */
  readonly readOnly?: boolean;
  readonly run: (input: { readonly label?: string }) => Promise<string> | string;
};

type Started = {
  readonly turn: Promise<TurnReason>;
  readonly messages: Message[];
  readonly started: string[];
  readonly finished: string[];
  /** `tool.result` 收到的 toolUseId，按派发顺序。 */
  readonly observed: string[];
};

/** 一轮里模型要的几个工具：全部 `tool_use` 在前，最后一条 `done`。 */
function calls(
  ...uses: readonly (readonly [id: string, name: string, label: string])[]
): readonly StreamEvent[] {
  return [
    ...uses.map(([id, name, label]) => ({
      type: 'tool_use' as const,
      id,
      name,
      input: { label },
    })),
    { type: 'done', stopReason: 'tool_use' },
  ];
}

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate: () => boolean, budgetMs = 500): Promise<boolean> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= budgetMs) return false;
    await sleep(5);
  }
  return true;
}

async function start(
  defs: readonly ToolDef[],
  script: readonly (readonly StreamEvent[])[],
): Promise<Started> {
  const started: string[] = [];
  const finished: string[] = [];
  const observed: string[] = [];

  const tools: Plugin = {
    name: 'concurrent-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      for (const def of defs) {
        on('tool.describe', { tool: def.name }, () => ({
          description: `工具 ${def.name}`,
          inputSchema: {},
          ...(def.readOnly === true ? { readOnly: true } : {}),
        }));
        on('tool.call', { tool: def.name }, async (_$, e) => {
          const input = e.input as { readonly label?: string };
          const label = input.label ?? def.name;
          started.push(label);
          const value = await def.run(input);
          finished.push(label);
          return { value };
        });
      }
    },
  };
  const allow: Plugin = {
    name: 'allow-all',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };
  const spy: Plugin = {
    name: 'result-spy',
    uses: ['tool.result'],
    register(on) {
      on('tool.result', (_$, e, next) => {
        observed.push(e.toolUseId);
        return next(e);
      });
    },
  };

  let index = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async *stream() {
      const events = script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [tools, allow, spy],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const turn = runTurn(
    {
      $,
      provider,
      signal: new AbortController().signal,
      dispatch,
      systemPrompt: 's',
      turnIndex: 0,
    },
    messages,
  );

  return { turn, messages, started, finished, observed };
}

/** 一轮里那条 `tool` 消息的结果，按模型要的顺序。 */
function toolResults(messages: readonly Message[]): readonly ToolResult[] {
  const message = messages.find((one) => one.role === 'tool');
  return message?.role === 'tool' ? message.results : [];
}

describe('只读工具并发', () => {
  it('两个声明 readOnly 的工具同时开始，而不是排队', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const { turn, messages, started } = await start(
      [
        { name: 'Read', readOnly: true, run: async () => { await gateA.promise; return 'A'; } },
        { name: 'Glob', readOnly: true, run: async () => { await gateB.promise; return 'B'; } },
      ],
      [calls(['a', 'Read', 'a'], ['b', 'Glob', 'b'])],
    );

    // 串行实现里第二个永远等不到：第一个正卡在 A 的闸上。
    const concurrent = await waitFor(() => started.length === 2);
    gateA.resolve();
    gateB.resolve();
    await turn;

    expect(concurrent).toBe(true);
    expect(toolResults(messages).map((result) => result.content)).toEqual(['A', 'B']);
  });

  it('没声明 readOnly 的工具照旧串行', async () => {
    const gate = deferred();
    const { turn, started } = await start(
      [
        { name: 'First', run: async () => { await gate.promise; return '1'; } },
        { name: 'Second', run: () => '2' },
      ],
      [calls(['a', 'First', 'a'], ['b', 'Second', 'b'])],
    );

    expect(await waitFor(() => started.length === 1)).toBe(true);
    await sleep(50);
    // 第一个还卡着，第二个要是已经开始了，说明"没声明"被当成了只读。
    expect(started).toEqual(['a']);
    gate.resolve();
    await turn;
    expect(started).toEqual(['a', 'b']);
  });
});

describe('写工具是屏障', () => {
  it('写工具排在前后两段只读之间：前一段跑完才轮到它，它跑完才轮到后一段', async () => {
    const log: string[] = [];
    const timed =
      (label: string) =>
      async (): Promise<string> => {
        log.push(`start:${label}`);
        await sleep(5);
        log.push(`end:${label}`);
        return label;
      };
    const { turn } = await start(
      [
        { name: 'Read', readOnly: true, run: timed('a') },
        { name: 'Write', run: timed('w') },
        { name: 'Glob', readOnly: true, run: timed('b') },
      ],
      [calls(['a', 'Read', 'a'], ['w', 'Write', 'w'], ['b', 'Glob', 'b'])],
    );

    await turn;

    expect(log).toEqual(['start:a', 'end:a', 'start:w', 'end:w', 'start:b', 'end:b']);
  });

  it('写工具要等前面整批只读都结束，不跟它们抢跑', async () => {
    const log: string[] = [];
    const timed =
      (label: string) =>
      async (): Promise<string> => {
        log.push(`start:${label}`);
        await sleep(5);
        log.push(`end:${label}`);
        return label;
      };
    const { turn } = await start(
      [
        { name: 'Read', readOnly: true, run: timed('a') },
        { name: 'Glob', readOnly: true, run: timed('b') },
        { name: 'Write', run: timed('w') },
      ],
      [calls(['a', 'Read', 'a'], ['b', 'Glob', 'b'], ['w', 'Write', 'w'])],
    );

    await turn;

    const firstEnd = log.findIndex((line) => line.startsWith('end:'));
    expect(log.slice(0, firstEnd).sort()).toEqual(['start:a', 'start:b']);
    expect(log.indexOf('start:w')).toBeGreaterThan(log.lastIndexOf('end:'));
  });
});

describe('顺序不随完成顺序变', () => {
  it('后发先至时，结果与 tool.result 仍按模型要的顺序', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const { turn, messages, started, finished, observed } = await start(
      [
        {
          name: 'Read',
          readOnly: true,
          run: async (input) => {
            if (input.label === 'a') {
              await gateA.promise;
              return 'A-content';
            }
            await gateB.promise;
            return 'B-content';
          },
        },
      ],
      [calls(['a', 'Read', 'a'], ['b', 'Read', 'b'])],
    );

    // 两个都真的开始之后再放闸，才谈得上"反着完成"。
    expect(await waitFor(() => started.length === 2)).toBe(true);
    gateB.resolve();
    expect(await waitFor(() => finished.includes('b'))).toBe(true);
    gateA.resolve();
    await turn;

    // b 先完成 —— 这段断言证明"反着完成"真的发生了，下面的顺序才有意义。
    expect(finished).toEqual(['b', 'a']);
    expect(toolResults(messages).map((result) => result.content)).toEqual(['A-content', 'B-content']);
    expect(observed).toEqual(['a', 'b']);
  });
});
