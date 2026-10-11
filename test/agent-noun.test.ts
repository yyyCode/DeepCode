// test/agent-noun.test.ts
import { describe, expect, it } from 'vitest';
import type { AgentSpawnResult } from '../src/contract/agent';
import type { Plugin } from '../src/contract/plugin';
import type { ModelProvider, StreamEvent } from '../src/contract/model-provider';
import { CORE_ORIGIN } from '../src/contract/next';
import { createEngine } from '../src/core/create';

/**
 * 断言这次派生**真的跑了**，并把它窄化到 `ok: true` 那一支（P10 之后结果是个联合：
 * 内核可以拒，见 `contract/agent.ts`）。不这么写的话每一处 `result.text` 都要手写一遍分支。
 */
function ran(result: AgentSpawnResult): Extract<AgentSpawnResult, { ok: true }> {
  if (!result.ok) throw new Error(`这次派生被内核拒了：${result.reason}`);
  return result;
}

const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' },
];

const callTool = (name: string): readonly StreamEvent[] => [
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

/** 一轮里既说话又要工具 —— 用来验"回传的是最后一段话"。 */
const sayAndCall = (text: string, name: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

type Seen = { tools: string[]; model: string | undefined; msgCount: number; first: string };

async function mount(script: readonly (readonly StreamEvent[])[]) {
  const seen: Seen[] = [];
  const calls: string[] = [];
  const observed: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(req) {
      seen.push({
        tools: req.tools.map((t) => t.name),
        model: req.model,
        msgCount: req.messages.length,
        first: JSON.stringify(req.messages[0]),
      });
      const events = script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      for (const name of ['Read', 'Write']) {
        on('tool.describe', { tool: name }, () => ({ description: `工具 ${name}`, inputSchema: {} }));
        on('tool.call', { tool: name }, () => {
          calls.push(name);
          return { value: `ok:${name}` };
        });
      }
    },
  };

  const check: Plugin = {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };

  // 观察者：静音与否只能从"事件到底有没有被派发"看出来。
  const observer: Plugin = {
    name: 'test-observer',
    uses: ['turn.start', 'turn.step', 'turn.complete', 'agent.spawn'],
    register(on) {
      for (const event of ['turn.start', 'turn.step', 'turn.complete', 'agent.spawn'] as const) {
        on(event, () => {
          observed.push(event);
          return {} as never;
        });
      }
    },
  };

  const engine = await createEngine({
    plugins: [tools, check, observer],
    provider,
    // 这条链里没有 confirm，所以子代理里的 Write 不必过 y/N。
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const spawn = (overrides: Partial<Parameters<typeof engine.$.agent.spawn>[0]> = {}) =>
    engine.$.agent.spawn({
      name: 'explorer',
      systemPrompt: '你是探索者',
      task: '看看这个',
      // P10：`tools` 改成了 `allow`（父面 ∩ allow），结果也成了联合（内核可以拒）。
      allow: ['Read'],
      ...overrides,
    });

  return { ...engine, seen, calls, observed, spawn };
}

describe('子代理：隔离', () => {
  it('第一次请求里只有任务本身 —— 父级的对话历史进不去', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.seen[0]?.msgCount).toBe(1);
    expect(m.seen[0]?.first).toContain('看看这个');
  });

  it('工具调用照常跑 —— 中间的工具结果留在子代理自己那本账里', async () => {
    const m = await mount([callTool('Read'), say('结论')]);
    const result = ran(await m.spawn());
    expect(m.calls).toEqual(['Read']);
    expect(m.seen.length).toBe(2);
    expect(result.text).toBe('结论');
  });
});

describe('子代理：静音', () => {
  it('吞掉 turn.step，但 turn.start / turn.complete / agent.spawn 照发', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.observed).toContain('turn.start');
    expect(m.observed).toContain('turn.complete');
    expect(m.observed).toContain('agent.spawn');
    // 屏幕那一侧：子代理说的话一个字节都不许流出去。
    expect(m.observed).not.toContain('turn.step');
  });

  it('tool.call 不被吞 —— /diff 的账不能丢', async () => {
    const m = await mount([callTool('Read'), say('结论')]);
    await m.spawn();
    expect(m.calls).toEqual(['Read']);
  });
});

describe('子代理：回传', () => {
  it('回传的是**最后一段**话，不是拼接', async () => {
    const m = await mount([sayAndCall('我看看', 'Read'), say('结论')]);
    const result = ran(await m.spawn());
    expect(result.text).toBe('结论');
  });

  it('末轮没说话时留的是上一轮那句 —— 空话不覆盖', async () => {
    // 第 2 轮只有工具调用、没有文本；第 3 轮才有话。
    const m = await mount([sayAndCall('我看看', 'Read'), callTool('Read'), say('结论')]);
    const result = ran(await m.spawn());
    expect(result.text).toBe('结论');
  });

  it('撞上限时 stopReason 是 max_hops，一路带回来', async () => {
    // 每一轮都要工具，永远不自己收手 —— 每一轮都得备一份脚本，脚本跑完后的兜底
    // 是 end_turn（见 mount 的 provider），会掩盖"撞墙"这条路径。
    const m = await mount([callTool('Read'), callTool('Read')]);
    const result = ran(await m.spawn({ maxHops: 2 }));
    expect(result.stopReason).toBe('max_hops');
    // `depth` 是 P10 加的：结果里带着"这是第几层"，与 `agent.spawn` 那条通知同一个数。
    expect(result.depth).toBe(1);
  });
});

describe('子代理：白名单与模型分层', () => {
  it('子代理只看得见清单里的工具（`allow` 是**求交**）', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ allow: ['Read'] });
    expect(m.seen[0]?.tools).toEqual(['Read']);
  });

  it('`allow` 里点名了父级这一轮看不见的东西 —— 拿不到，且不静默', async () => {
    // 父面（这一层）是 Read / Write（test-tools 注册的那两个）；点了名的 `Grep` 谁都没注册。
    const m = await mount([say('好')]);
    const result = ran(await m.spawn({ allow: ['Read', 'Grep'] }));
    expect(m.seen[0]?.tools).toEqual(['Read']);
    expect(result.text).toBe('好');
  });

  it('`deny` 在求交之后再减一道', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ allow: ['Read', 'Write'], deny: ['Write'] });
    expect(m.seen[0]?.tools).toEqual(['Read']);
  });

  it('`allow: []` = 一个工具都不给 —— 递归就是这么断掉的', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ allow: [] });
    expect(m.seen[0]?.tools).toEqual([]);
  });

  it('model 透传到 provider', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ model: 'haiku' });
    expect(m.seen[0]?.model).toBe('haiku');
  });

  it('不给 model 时是 undefined —— 适配器据此用配置里那个（= 父级）', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.seen[0]?.model).toBeUndefined();
  });
});

describe('内核的默认答复（不接插件的裸引擎）', () => {
  it('agent.offer 链尾无人应答 = 空清单', async () => {
    const engine = await createEngine({
      plugins: [],
      provider: { name: 'noop', async *stream() { /* 用不到 */ } },
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const offer = await engine.dispatch('agent.offer', {}, CORE_ORIGIN);
    expect(offer).toEqual({ agents: [], skills: [] });
  });

  it('skill.prompt 链尾无人应答 = **原文通过**（变换缝，不是闸）', async () => {
    const engine = await createEngine({
      plugins: [],
      provider: { name: 'noop', async *stream() { /* 用不到 */ } },
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const loaded = await engine.$.skill.load({ name: 'x', text: '原文' });
    expect(loaded.text).toBe('原文');
  });
});
