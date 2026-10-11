// test/agent-boundary.test.ts
//
// P10 的两条边界：子代理**看得见哪些工具**、**能派多深**。
//
// 这两条用例是设计期两个探针转了正（设计 §2.1 → §6）：探针 A 实测"嵌套一层就把被扣掉的
// 面拿回来了"（外层 2 个、内层 8 个 = 会话全部），探针 B 实测"第三方插件直派递归到了 6 层、
// 13 次模型请求，而 Task 那条路径的上限是 3"。转正的意思是：**它们现在必须反过来成立** ——
// 下面每一条断言，都是 P10 之前会红的那一格。
import { describe, expect, it } from 'vitest';
import type { AgentSpec, AgentSpawnResult } from '../src/contract/agent';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { confirmPlugin } from '../src/builtins/confirm';
import { coreTools } from '../src/builtins/tools';
import { createEngine } from '../src/core/create';
import { runTurn, type LoopContext } from '../src/core/loop';
import { createSubagentsPlugin } from '../src/cli/subagents';

const agentSpec = (spec: Partial<AgentSpec> & { name: string }): AgentSpec => ({
  description: `${spec.name} 的描述`,
  prompt: `你是 ${spec.name}。`,
  ...spec,
});

const toolUse = (id: string, name: string, input: unknown = {}): StreamEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });
const say = (text: string): readonly StreamEvent[] => [{ type: 'text', text }, done('end_turn')];
/** 一轮里只要一个工具 —— 用来把递归一路接下去。 */
const callOnly = (id: string, name: string, input: unknown = {}): readonly StreamEvent[] => [
  toolUse(id, name, input),
  done('tool_use'),
];

/**
 * 挂一个真引擎，从**会话那一层**真跑一轮（`runTurn` 就是子代理内层跑的那一个）。
 *
 * 比 `agent-noun.test.ts` 的 mount 重：它会装上真工具（`coreTools`）、真准入（`confirmPlugin`）
 * 与真插件（`createSubagentsPlugin`），因为这两条边界只有穿过 `Task` 这个真工具才看得出来。
 */
async function mount(
  plugins: readonly Plugin[],
  script: (req: StreamRequest, n: number) => readonly StreamEvent[],
  thirdParty: readonly string[] = [],
) {
  const requests: StreamRequest[] = [];
  const provider: ModelProvider = {
    name: 'boundary',
    async *stream(req) {
      requests.push(req);
      // `n` 从 1 数起：第几次模型请求。脚本按它决定说哪一句。
      for (const event of script(req, requests.length)) yield event;
    },
  };
  const engine = await createEngine({
    plugins: [confirmPlugin, ...plugins, ...coreTools],
    thirdParty,
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });
  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $: engine.$,
    provider,
    signal: new AbortController().signal,
    dispatch: engine.dispatch,
    systemPrompt: '父级提示',
    turnIndex: 0,
  };
  await runTurn(ctx, messages);
  return { requests, messages };
}

/** 第 n 次模型请求看得见的工具名（`n` 从 1 数起）。 */
const faceAt = (requests: readonly StreamRequest[], n: number): string[] =>
  (requests[n - 1]?.tools ?? []).map((t) => t.name);

const subagents = (agents: readonly AgentSpec[]) =>
  createSubagentsPlugin({ agents, skills: [], baseSystemPrompt: '基础提示' });

/** 一路派 `Task(subagent_type: name)` 的脚本 —— 想派几层都行，最后一轮才说话。 */
const taskChain = (name: string, hops: number) => (_req: StreamRequest, n: number) =>
  n <= hops ? callOnly(`t${n}`, 'Task', { subagent_type: name, prompt: '再去看' }) : say('看完了');

/**
 * 数一数**真的开跑了**的派发。
 *
 * `agent.spawn` 只对"要开跑"的那一次派（深度超了的那次在它之前就返回），所以这份数
 * 就是"实际派出去几次" —— 它比"数工具调用"准：工具调用被拒了也照样有一次调用。
 */
function depthWatcher(depths: number[]): Plugin {
  return {
    name: 'depth-watcher',
    uses: ['agent.spawn'],
    register(on) {
      on('agent.spawn', (_$, e, next) => {
        depths.push(e.depth);
        return next(e);
      });
    },
  };
}

describe('P10：面按"父级这一轮"算，不按"会话的全部"', () => {
  it('嵌套一层拿不回被扣掉的面 —— 内层继承的是外层那一轮的面', async () => {
    const agents = [
      agentSpec({ name: 'outer', tools: ['Read', 'Task'] }),
      agentSpec({ name: 'inner' }),
    ];
    const { requests } = await mount([subagents(agents)], (_req, n) =>
      n === 1
        ? callOnly('t1', 'Task', { subagent_type: 'outer', prompt: '去看' })
        : n === 2
          ? callOnly('t2', 'Task', { subagent_type: 'inner', prompt: '再去看' })
          : say('看完了'),
    );

    // 外层那一轮：Task 与 Read 两个（注册顺序：subagents 插件先于 coreTools）。
    expect(faceAt(requests, 2)).toEqual(['Task', 'Read']);
    // 内层那一轮：**一样是这两个**。P10 之前这里是 8 个 —— 会话注册过什么它就能看见什么。
    expect(faceAt(requests, 3)).toEqual(['Task', 'Read']);
    expect(faceAt(requests, 3)).not.toContain('Write');
    expect(faceAt(requests, 3)).not.toContain('Bash');
  });

  it('`allow` 是**求交**不是替换 —— 点名父级这一轮看不见的东西，拿不到', async () => {
    const agents = [
      agentSpec({ name: 'outer', tools: ['Read', 'Task'] }),
      // 点名要 Write：它在会话里是注册过的，但在**外层这一轮**的面之外。
      agentSpec({ name: 'inner', tools: ['Write'] }),
    ];
    const { requests } = await mount([subagents(agents)], (_req, n) =>
      n === 1
        ? callOnly('t1', 'Task', { subagent_type: 'outer', prompt: '去看' })
        : n === 2
          ? callOnly('t2', 'Task', { subagent_type: 'inner', prompt: '再去看' })
          : say('看完了'),
    );

    // 求交的结果是**空**：外层那一轮没有 Write，内层就要不到。替换语义下这里会是 ['Write']。
    expect(faceAt(requests, 3)).toEqual([]);
  });

  it('`allow: []` = 一个工具都不给 —— 递归就是这么断掉的', async () => {
    // 空的 `allow` 与"省略 `allow`"是两件事。写成 `req.allow ?? parent` 那种形状，
    // 空数组会被当成省略，于是"锁死一个叶子"变成"给它全部工具"。
    const agents = [agentSpec({ name: 'leaf', tools: [] })];
    const { requests } = await mount([subagents(agents)], taskChain('leaf', 1));

    expect(faceAt(requests, 1)).toContain('Task');
    expect(faceAt(requests, 2)).toEqual([]);
  });

  it('`deny` 在求交之后再减一道，且只减自己那一层', async () => {
    const agents = [agentSpec({ name: 'thin', tools: ['Read', 'Task'], disallowedTools: ['Read'] })];
    const { requests } = await mount([subagents(agents)], taskChain('thin', 1));

    expect(faceAt(requests, 2)).toEqual(['Task']);
    // 扣的是内层的面：父级这一轮照样两个都在。
    expect(faceAt(requests, 1)).toContain('Read');
  });
});

describe('P10：深度上限装在内核里，所有路径共用同一个数', () => {
  it('**插件直派**那条路径也受限 —— 与 Task 那条一样停在 3 层', async () => {
    const results: AgentSpawnResult[] = [];
    const depths: number[] = [];
    // 被拒之后不再潜：否则第 3 层的模型会一遍遍地要 Dive（脚本只认次数，认不出"刚被拒"），
    // 而这个用例要的是"第一次被拒"那一刻的形状。
    let refused = false;
    const diver: Plugin = {
      name: 'diver',
      uses: ['tool.call', 'tool.describe', 'tool.check', 'agent'],
      register(on) {
        on('tool.describe', { tool: 'Dive' }, () => ({ description: '潜一层', inputSchema: {} }));
        // 第三方不能答 `allow`（会被剥掉），只能 `ask` —— 本仓库 `plugins/todo/main.mjs` 的先例。
        on('tool.check', { tool: 'Dive' }, () => ({ decision: 'ask', rule: '插件工具：Dive' }) as const);
        on('tool.call', { tool: 'Dive' }, async ($) => {
          if (refused) return { value: '不再潜了' };
          const result = await $.agent.spawn({
            name: 'diver',
            systemPrompt: '继续潜',
            task: '继续潜',
            allow: ['Dive'],
          });
          if (!result.ok) refused = true;
          results.push(result);
          return { value: result.ok ? result.text : `ERROR: ${result.reason}` };
        });
      },
    };

    const { requests } = await mount(
      [diver, depthWatcher(depths)],
      // 一路只要 Dive、永不自己收手：没有上限的话它就一直潜。
      (_req, n) => (n <= 4 ? callOnly(`d${n}`, 'Dive') : say('到底了')),
      ['diver'],
    );

    // 开跑了的只有三次 —— 第 4 层那次内核当场就拒了，一次模型请求都没发生。
    expect(depths).toEqual([1, 2, 3]);

    // 被拒的那一次照样有结果可读（结果类型从平坦结构变成了联合：见 `contract/agent.ts`）。
    const denied = results.filter((r) => !r.ok);
    expect(denied).toHaveLength(1);
    // 拒绝理由带**名字链**与上限，与 P10 之前 Task 那条路径上的措辞一字不差。
    expect(denied[0]).toEqual({
      ok: false,
      reason: '嵌套太深了（diver → diver → diver → diver，上限 3 层）',
    });
    expect(results.filter((r) => r.ok).map((r) => (r.ok ? r.depth : 0)).sort()).toEqual([1, 2, 3]);

    // 8 次模型请求 = 四次循环各两轮（要 Dive 一轮、拿到结果后收手一轮）。
    // P10 之前这里潜到了 6 层、13 次请求 —— 保险丝装在 `cli/subagents.ts` 里，
    // 插件直派那条路径根本不经过它。
    expect(requests.length).toBe(8);
  });

  it('Task 那条路径：第四层被拒，理由原样进模型看得见的账本', async () => {
    const depths: number[] = [];
    const agents = [agentSpec({ name: 'rec', tools: ['Read', 'Task'] })];
    const { requests } = await mount(
      [subagents(agents), depthWatcher(depths)],
      // 前四轮都在派：第 4 层那次要的 Task 会被拒，被拒之后模型才收手。
      taskChain('rec', 4),
    );

    expect(depths).toEqual([1, 2, 3]);
    // 第 5 次请求发生在第 3 层：它带着那条拒绝理由（模型看到的账本里原文如此）。
    expect(requests.length).toBe(8);
    expect(JSON.stringify(requests[4]?.messages)).toContain(
      '嵌套太深了（rec → rec → rec → rec，上限 3 层）',
    );
  });

  it('`agent.spawn` 通知里的 depth 与结果里的 depth 是同一个数', async () => {
    // `depth` 是那个"可观测的出口"：没有它，"所有路径共用同一个数"只能读代码去验（设计 §3.5）。
    const depths: number[] = [];
    const agents = [agentSpec({ name: 'a', tools: ['Read', 'Task'] }), agentSpec({ name: 'b' })];
    const { requests } = await mount(
      [subagents(agents), depthWatcher(depths)],
      (_req, n) =>
        n === 1
          ? callOnly('t1', 'Task', { subagent_type: 'a', prompt: '去看' })
          : n === 2
            ? callOnly('t2', 'Task', { subagent_type: 'b', prompt: '再去看' })
            : say('看完了'),
    );

    expect(depths).toEqual([1, 2]);
    // 内层那一轮的面是外层那一轮的面（两个 Task 都在白名单里），所以这一层也派得动。
    expect(faceAt(requests, 3)).toEqual(['Task', 'Read']);
  });
});
