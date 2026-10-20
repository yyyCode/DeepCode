import { describe, expect, it } from 'vitest';
import type { Plugin } from '@deepcode/contract/plugin';
import type {
  Message,
  ModelProvider,
  StreamEvent,
  ToolResult,
} from '@deepcode/contract/model-provider';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { LoopContext } from '@deepcode/core/loop';
import { estimateTokens, runTurn } from '@deepcode/core/loop';
import { createEngine } from '@deepcode/core/create';
import { createHarness } from './harness';

/** 三个工具。`called` 记真正被应答的 `tool.call` —— 被拒的那次不该留下痕迹。 */
function toolPlugins(called: string[]): Plugin[] {
  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      for (const name of ['Read', 'Write', 'Task']) {
        on('tool.describe', { tool: name }, () => ({ description: `工具 ${name}`, inputSchema: {} }));
        on('tool.call', { tool: name }, () => {
          called.push(name);
          return { value: `ok:${name}` };
        });
      }
    },
  };
  // 一律放行：这一套里没有 confirm，测的是 loop 自己的过滤。
  const check: Plugin = {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };
  return [tools, check];
}

type RunOptions = {
  script: readonly (readonly StreamEvent[])[];
  tools?: readonly string[];
  maxHops?: number;
  model?: string;
};

async function run(options: RunOptions) {
  const called: string[] = [];
  const requests: { tools: string[]; model: string | undefined }[] = [];
  const texts: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(req) {
      requests.push({ tools: req.tools.map((t) => t.name), model: req.model });
      const events = options.script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: toolPlugins(called),
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Parameters<typeof runTurn>[1] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $,
    provider,
    signal: new AbortController().signal,
    dispatch,
    systemPrompt: 's',
    turnIndex: 0,
    ...(options.tools === undefined ? {} : { tools: new Set(options.tools) }),
    ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
    ...(options.model === undefined ? {} : { model: options.model }),
    onText: (text) => texts.push(text),
  };

  const stopReason = await runTurn(ctx, messages);
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
  const lastResult: ToolResult | undefined =
    lastTool?.role === 'tool' ? lastTool.results.at(-1) : undefined;

  return { stopReason, requests, called, texts, lastResult };
}

const callTool = (name: string): readonly StreamEvent[] => [
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' },
];

describe('LoopContext.tools —— 落点一：看不见', () => {
  it('给了清单，模型看到的就只有清单里的', async () => {
    const { requests } = await run({ script: [say('好')], tools: ['Read'] });
    expect(requests[0]?.tools).toEqual(['Read']);
  });

  it('没给清单就不筛 —— 会话主循环走的是这一支', async () => {
    const { requests } = await run({ script: [say('好')] });
    expect(requests[0]?.tools).toEqual(['Read', 'Write', 'Task']);
  });
});

describe('LoopContext.tools —— 落点二：够不着', () => {
  it('点名调用清单外的工具 → 拒，而且 tool.call 根本没被派发', async () => {
    const { called, lastResult } = await run({ script: [callTool('Write')], tools: ['Read'] });
    expect(lastResult?.isError).toBe(true);
    expect(lastResult?.content).toContain('不在本次的工具清单里');
    // 关键：不是"派了但插件拒了"，是**根本没走到插件**。
    expect(called).toEqual([]);
  });

  it('清单内的工具照常跑通 —— 证明上一条测的是过滤而不是"谁都不许用"', async () => {
    const { called, lastResult } = await run({ script: [callTool('Read')], tools: ['Read'] });
    expect(called).toEqual(['Read']);
    expect(lastResult?.isError).toBe(false);
  });
});

describe('maxHops 与 stopReason', () => {
  it('撞上上限时 stopReason 是 max_hops，不是 answer', async () => {
    // 每一轮都要工具，永远不自己收手 —— 每一轮都得备一份脚本，
    // 脚本跑完后的兜底是 end_turn（见 run 的 provider），会掩盖"撞墙"这条路径。
    const { stopReason } = await run({
      script: [callTool('Read'), callTool('Read')],
      maxHops: 2,
    });
    expect(stopReason).toBe('max_hops');
  });

  it('模型自己收手时是 answer —— 上一条测的是区分，不是"一律 max_hops"', async () => {
    const { stopReason } = await run({ script: [say('好')], maxHops: 2 });
    expect(stopReason).toBe('answer');
  });
});

describe('model 与 onText', () => {
  it('model 一路透传给 provider', async () => {
    const { requests } = await run({ script: [say('好')], model: 'haiku' });
    expect(requests[0]?.model).toBe('haiku');
  });

  it('不给 model 时就是 undefined —— 适配器据此用配置里那个（父级）', async () => {
    const { requests } = await run({ script: [say('好')] });
    expect(requests[0]?.model).toBeUndefined();
  });

  it('onText 每一轮调一次，给的是那一轮的话；空话不调', async () => {
    const { texts } = await run({ script: [callTool('Read'), say('收工')] });
    expect(texts).toEqual(['收工']);
  });
});

describe('用量落到 turn.complete 上', () => {
  const ENGINE = {
    tool: { list: () => [] },
    logger: { debug: () => {}, warn: () => {} },
    ui: { log: () => {}, notice: () => {}, ask: async () => 'n' },
  } as unknown as EngineInterface;

  /** 跑一轮，把 `turn.complete` 的参数收下来。 */
  async function run(events: readonly StreamEvent[], system = '提示', text = '干活') {
    // `turn.stop` 是 loop 收手那一刻派的事件（P4d 新增）。手搭的 harness 是另一条
    // dispatcher 的路，拿不到 createEngine 的 coreImpls —— 漏了它的表现是这一轮
    // 走到最后抛 NotImplementedError，与断言本身无关。
    const h = createHarness({ engine: ENGINE, coreImpls: { 'turn.stop': () => ({}) as const } });
    const seen: {
      stopReason: string;
      inputTokens: number;
      outputTokens: number;
      usageEstimated?: boolean;
    }[] = [];
    // 注意 hook 的签名是 `($, e, next)` —— 第一个参数是引擎，事件在**第二个**。
    h.on('builtin', 'spy', 'turn.complete', (_$, e) => {
      seen.push(e as unknown as (typeof seen)[number]);
      return {};
    });

    const provider: ModelProvider = {
      name: 'stub',
      async *stream() {
        for (const event of events) yield event;
      },
    };
    const messages: Message[] = [{ role: 'user', content: text }];
    await runTurn(
      {
        $: ENGINE,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: system,
        turnIndex: 0,
      },
      messages,
    );
    return seen;
  }

  it('端点报了：原样填进去，且不带 `usageEstimated`', async () => {
    const seen = await run([
      // 先给一句正文：**一步什么都不产出现在是 `empty`**（P8 §3.3），那一轮会先被重提示
      // 一次、再空一次才收场，测到的就不是用量了。这条要的是"模型正常答了一句"。
      { type: 'text', text: '好' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
    // ⚠️ 这里断的是**产品语义**那一层（P8 起），不是端点原样透传的 `end_turn` ——
    // 步级 → 轮级的唯一一处翻译在 `core/loop.ts` 的 `reasonOf`。
    expect(seen).toEqual([{ stopReason: 'answer', inputTokens: 123, outputTokens: 45 }]);
  });

  it('端点没报：回落估计，并**标出来**', async () => {
    const seen = await run([{ type: 'text', text: '好' }, { type: 'done', stopReason: 'end_turn' }]);
    expect(seen).toEqual([
      {
        stopReason: 'answer',
        // 估计的输入量把这一轮刚说出去的那句话也算上 —— 下一跳它确实要再发一遍。
        inputTokens: estimateTokens('提示'.length + '干活'.length + '好'.length),
        outputTokens: 0,
        usageEstimated: true,
      },
    ]);
  });

  it('`onUsage` 收到同一份数据（自动压缩的触发信号从这儿走）', async () => {
    const h = createHarness({ engine: ENGINE, coreImpls: { 'turn.stop': () => ({}) as const } });
    h.on('builtin', 'spy', 'turn.complete', () => ({}));
    const got: unknown[] = [];
    const provider: ModelProvider = {
      name: 'stub',
      async *stream() {
        yield {
          type: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 9, outputTokens: 3 },
        } as const;
      },
    };

    await runTurn(
      {
        $: ENGINE,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: 's',
        turnIndex: 0,
        onUsage: (usage) => got.push(usage),
      },
      [{ role: 'user', content: '干活' }],
    );

    expect(got).toEqual([{ inputTokens: 9, outputTokens: 3, estimated: false }]);
  });
});

describe('onTools：账本吃的那一份，就是请求里真的带出去的那一份', () => {
  /** 跑一轮，把请求里的工具名与 `onTools` 收到的那一份都收下来。 */
  async function run() {
    const requests: string[][] = [];
    const reported: string[][] = [];
    const provider: ModelProvider = {
      name: 'scripted',
      async *stream(req) {
        requests.push(req.tools.map((tool) => tool.name));
        yield { type: 'text', text: '好' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const { $, dispatch } = await createEngine({
      plugins: toolPlugins([]),
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });

    await runTurn(
      {
        $,
        provider,
        signal: new AbortController().signal,
        dispatch,
        systemPrompt: 's',
        turnIndex: 0,
        onTools: (specs) => reported.push(specs.map((spec) => spec.name)),
      },
      [{ role: 'user', content: '干活' }],
    );
    return { requests, reported };
  }

  it('报出来的与发出去的是同一份（顺序也一样）', async () => {
    const { requests, reported } = await run();
    // ⚠️ 这一条钉的是"账本不会又算错了"：`/context` 报的个数必须与真实请求相等，
    // 否则它跟「上次实测」摆在一起比较时，比的还是两回事（P9 §2.1 探针 1）。
    expect(reported[0]).toEqual(requests[0]);
    expect(reported[0]).toEqual(['Read', 'Write', 'Task']);
  });

  it('一轮只报一次 —— 跳几跳都用同一份（清单是进 turn 时建的）', async () => {
    const calls: number[] = [];
    let n = 0;
    const provider: ModelProvider = {
      name: 'scripted',
      async *stream() {
        n += 1;
        if (n === 1) {
          yield { type: 'tool_use', id: 'u1', name: 'Read', input: {} } as const;
          yield { type: 'done', stopReason: 'tool_use' } as const;
          return;
        }
        yield { type: 'text', text: '收工' } as const;
        yield { type: 'done', stopReason: 'end_turn' } as const;
      },
    };
    const { $, dispatch } = await createEngine({
      plugins: toolPlugins([]),
      provider,
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    await runTurn(
      {
        $,
        provider,
        signal: new AbortController().signal,
        dispatch,
        systemPrompt: 's',
        turnIndex: 0,
        onTools: (specs) => calls.push(specs.length),
      },
      [{ role: 'user', content: '干活' }],
    );
    // ⚠️ 这条**不是**"跳了几跳就报几次"：上面那个 provider 第一跳要了个工具、
    // 第二跳才收工，真发出去两次请求，而 `onTools` 只响了一次 —— 清单在进 turn 时
    // 建一份，几跳共用（`loop.ts` 里那句话就在 while 外面）。
    // 账本要的正是"这一轮发出去的是哪一份"，不是"每一跳各是什么"。
    expect(calls).toEqual([3]);
  });
});
