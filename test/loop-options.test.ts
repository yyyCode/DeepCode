import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import type { ModelProvider, StreamEvent, ToolResult } from '../src/contract/model-provider';
import type { LoopContext } from '../src/core/loop';
import { runTurn } from '../src/core/loop';
import { createEngine } from '../src/core/create';

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
  it('撞上上限时 stopReason 是 max_hops，不是 end_turn', async () => {
    // 每一轮都要工具，永远不自己收手 —— 每一轮都得备一份脚本，
    // 脚本跑完后的兜底是 end_turn（见 run 的 provider），会掩盖"撞墙"这条路径。
    const { stopReason } = await run({
      script: [callTool('Read'), callTool('Read')],
      maxHops: 2,
    });
    expect(stopReason).toBe('max_hops');
  });

  it('模型自己收手时是 end_turn —— 上一条测的是区分，不是"一律 max_hops"', async () => {
    const { stopReason } = await run({ script: [say('好')], maxHops: 2 });
    expect(stopReason).toBe('end_turn');
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
