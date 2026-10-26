// test/subagent-parallel.test.ts
import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '../src/contract/agent';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { confirmPlugin } from '../src/builtins/confirm';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import { BUILTIN_AGENTS } from '../src/cli/builtin-agents';
import { createSubagentsPlugin } from '../src/cli/subagents';

/**
 * P15：只读子代理的并发，与并发下的父面隔离。
 *
 * 这一套钉的是**结构**：
 * - `Explore` 声明了 `readOnly`，于是同一轮里连续的三个会真的重叠；
 * - `Task` 没声明，三个仍然排队 —— 并发不是派生的副产品；
 * - 两个并发子代理各自看到**自己的**父面与深度（`AsyncLocalStorage`，不是全局栈）；
 * - 文件可以写 `readOnly: true`，但内核不信它：面里混进写工具就拒。
 */

const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' },
];

const toolUse = (id: string, name: string, input: unknown = {}): StreamEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (stopReason = 'tool_use'): StreamEvent => ({ type: 'done', stopReason });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const agent = (spec: Partial<AgentSpec> & { name: string }): AgentSpec => ({
  description: `${spec.name} 的描述`,
  prompt: `你是 ${spec.name}。`,
  ...spec,
});

type Respond = (req: StreamRequest, n: number) => Promise<readonly StreamEvent[]> | readonly StreamEvent[];

async function mount(options: {
  readonly agents?: readonly AgentSpec[];
  readonly respond: Respond;
}) {
  const requests: StreamRequest[] = [];
  const spawns: { name: string; depth: number; task: string }[] = [];
  const notices: string[] = [];
  const asks: string[] = [];

  const provider: ModelProvider = {
    name: 'test',
    async *stream(req) {
      requests.push(req);
      const events = await options.respond(req, requests.length);
      for (const event of events) yield event;
    },
  };

  // 三个只读工具 + 一个写工具：内核据此算面，也据此决定谁可以并发。
  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.describe', 'tool.call'],
    register(on) {
      for (const name of ['Read', 'Glob', 'Grep']) {
        on('tool.describe', { tool: name }, () => ({
          description: `工具 ${name}`,
          inputSchema: {},
          readOnly: true,
        }));
        on('tool.call', { tool: name }, (_$, e) => {
          const input = (e.input ?? {}) as { readonly label?: string };
          return { value: `${name}:${input.label ?? ''}` };
        });
      }
      on('tool.describe', { tool: 'Write' }, () => ({
        description: '写文件',
        inputSchema: {},
      }));
      on('tool.call', { tool: 'Write' }, () => ({ value: 'written' }));
    },
  };

  const allow: Plugin = {
    name: 'allow-all',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };

  const observer: Plugin = {
    name: 'spawn-observer',
    uses: ['agent.spawn'],
    register(on) {
      on('agent.spawn', (_$, e, next) => {
        spawns.push({ name: e.name, depth: e.depth, task: e.task });
        return next(e);
      });
    },
  };

  const engine = await createEngine({
    plugins: [
      createSubagentsPlugin({
        agents: options.agents ?? BUILTIN_AGENTS,
        skills: [],
        baseSystemPrompt: '基础提示',
      }),
      confirmPlugin,
      tools,
      allow,
      observer,
    ],
    provider,
    ui: {
      print: () => {},
      notice: (line) => notices.push(line),
      ask: async (question) => {
        asks.push(question);
        return 'y';
      },
    },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  async function runParent(): Promise<{ messages: Message[]; stopReason: string }> {
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const stopReason = await runTurn(
      {
        $: engine.$,
        provider,
        signal: new AbortController().signal,
        dispatch: engine.dispatch,
        systemPrompt: '父级提示',
        turnIndex: 0,
      },
      messages,
    );
    return { messages, stopReason };
  }

  return { ...engine, requests, spawns, notices, asks, runParent };
}

/** 这一轮里最后一个工具结果。 */
function resultAt(messages: readonly Message[], index = 0): string {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  if (last?.role !== 'tool') throw new Error('这一轮没有任何工具结果消息');
  return last.results[index]?.content ?? '';
}

function textOf(req: StreamRequest): string {
  const first = req.messages[0];
  return first !== undefined && first.role !== 'tool' && typeof first.content === 'string'
    ? first.content
    : '';
}

describe('Explore：只读面与并发', () => {
  it('默认派内置 explore；子代理只看得到 Read / Glob / Grep', async () => {
    const m = await mount({
      respond: (req, n) => {
        if (n === 1) {
          return [
            toolUse('e1', 'Explore', { prompt: '看看 a' }),
            done(),
          ];
        }
        if (textOf(req) === '看看 a') return say('结论 A');
        return say('收工');
      },
    });
    const { messages } = await m.runParent();

    // 子代理那一轮的请求里，工具面被内置 explore 的 `tools` 收到三个只读工具。
    const child = m.requests[1];
    expect(child).toBeDefined();
    expect(child!.tools.map((tool) => tool.name).sort()).toEqual(['Glob', 'Grep', 'Read']);
    // 父级拿到的只有子代理那句话，没有工具结果。
    expect(resultAt(messages)).toBe('结论 A');
    expect(m.spawns.map((spawn) => spawn.name)).toEqual(['explore']);
    expect(m.spawns[0]?.depth).toBe(1);
  });

  it('同一轮里三个 Explore 真的重叠；三个 Task 仍然排队', async () => {
    async function peakOf(tool: 'Explore' | 'Task'): Promise<number> {
      let active = 0;
      let peak = 0;
      const m = await mount({
        respond: async (req, n) => {
          if (n === 1) {
            return [
              ...['A', 'B', 'C'].map((label) =>
                toolUse(`u-${label}`, tool, {
                  subagent_type: 'explore',
                  prompt: `task-${label}`,
                }),
              ),
              done(),
            ];
          }
          if (textOf(req).startsWith('task-')) {
            active += 1;
            peak = Math.max(peak, active);
            await sleep(20);
            active -= 1;
            return say(`结论 ${textOf(req).slice(5)}`);
          }
          return say('收工');
        },
      });
      await m.runParent();
      return peak;
    }

    expect(await peakOf('Explore')).toBe(3);
    // Task 没有声明 readOnly —— 并发是 Explore 的声明换来的，不是派生的默认。
    expect(await peakOf('Task')).toBe(1);
  });
});

describe('并发下的父面：AsyncLocalStorage', () => {
  it('两个并发子代理各自拿自己的父面，嵌套的面不会互相污染', async () => {
    const m = await mount({
      agents: [
        agent({ name: 'wide-a', tools: ['Read', 'Explore'], readOnly: true }),
        agent({ name: 'wide-b', tools: ['Glob', 'Explore'], readOnly: true }),
        agent({ name: 'deep', tools: ['Read', 'Glob'], readOnly: true }),
      ],
      respond: (req, n) => {
        if (n === 1) {
          return [
            toolUse('a', 'Explore', { subagent_type: 'wide-a', prompt: 'A' }),
            toolUse('b', 'Explore', { subagent_type: 'wide-b', prompt: 'B' }),
            done(),
          ];
        }
        const content = textOf(req);
        // 子代理的第一跳才派孙代理；拿到结果后的下一跳要收手，否则会一直派到 max_hops。
        if ((content === 'A' || content === 'B') && req.messages.length === 1) {
          return [
            toolUse(`n-${content}`, 'Explore', {
              subagent_type: 'deep',
              prompt: `nested-${content}`,
            }),
            done(),
          ];
        }
        if ((content === 'A' || content === 'B') && req.messages.length > 1) {
          return say(`child-${content}-done`);
        }
        if (content.startsWith('nested-')) return say(`done-${content}`);
        return say('收工');
      },
    });
    await m.runParent();

    const grandchild = (label: string): string[] => {
      const request = m.requests.find((req) => textOf(req) === `nested-${label}`);
      if (request === undefined) throw new Error(`没有找到 ${label} 的孙代理请求`);
      return request.tools.map((tool) => tool.name).sort();
    };

    // wide-a 的面是 Read + Explore，deep 只许 Read / Glob ⇒ 求交只剩 Read；
    // wide-b 同一条规则 ⇒ 只剩 Glob。全局栈在并发下会把这两个面交错。
    expect(grandchild('A')).toEqual(['Read']);
    expect(grandchild('B')).toEqual(['Glob']);

    // 深度也各算各的：两次第 1 层、两次第 2 层。
    const depths = m.spawns.map((spawn) => spawn.depth).sort();
    expect(depths).toEqual([1, 1, 2, 2]);
  });
});

describe('只读声明：内核不信文件', () => {
  it('声明 readOnly 但面里混进 Write → 内核拒绝，且不派 agent.spawn 事件', async () => {
    const m = await mount({
      agents: [],
      respond: () => say('不该跑到这里'),
    });

    const result = await m.$.agent.spawn({
      name: 'liar',
      systemPrompt: '你只读',
      task: '写个文件',
      allow: ['Read', 'Write'],
      readOnly: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Write');
      expect(result.reason).toContain('Task');
    }
    // 事件派在验证之后：屏幕上不会出现一行“派子代理 liar”却永远不回来。
    expect(m.spawns).toEqual([]);
    expect(m.requests).toEqual([]);
  });

  it('Explore 拒绝没有声明 readOnly 的 agent —— 写任务要走 Task', async () => {
    const m = await mount({ agents: BUILTIN_AGENTS, respond: () => say('收工') });

    const result = await m.dispatch(
      'tool.call',
      {
        tool: 'Explore',
        input: { subagent_type: 'general-purpose', prompt: '改个文件' },
        toolUseId: 'u1',
      },
      CORE_ORIGIN,
    );

    expect('deny' in result).toBe(true);
    if ('deny' in result) {
      expect(result.deny).toContain('general-purpose');
      expect(result.deny).toContain('Task');
    }
    expect(m.spawns).toEqual([]);
  });
});
