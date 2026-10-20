// test/subagent.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpec } from '@deepcode/contract/agent';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '@deepcode/contract/model-provider';
import type { Plugin } from '@deepcode/contract/plugin';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { confirmPlugin } from '@deepcode/builtins/confirm';
import { coreTools } from '@deepcode/builtins/tools';
import { createEngine } from '@deepcode/core/create';
import { runTurn, type LoopContext } from '@deepcode/core/loop';
import { createSubagentsPlugin } from '@deepcode/cli/subagents';
import { streamPlugin } from '@deepcode/cli/stream';
import type { Renderer } from '@deepcode/cli/render';

let root = '';
let notesPath = '';

const FILE_TEXT = '这是子代理读到的文件内容。';

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
const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  done('end_turn'),
];
const callTask = (type: string, prompt = '去干活'): readonly StreamEvent[] => [
  toolUse('u_task', 'Task', { subagent_type: type, prompt }),
  done('tool_use'),
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-subagent-'));
  notesPath = join(root, 'notes.md');
  await writeFile(notesPath, FILE_TEXT);
});

type MountOptions = {
  agents: readonly AgentSpec[];
  script?: readonly (readonly StreamEvent[])[];
  /**
   * 第 n 次请求（从 1 数）该流什么。比 `script` 多拿得到 `req` ——
   * "把上一轮的工具结果原样复述出来"这种事，只有拿着 req 才写得出来（见 C2-5 第二条）。
   */
  response?: (req: StreamRequest, n: number) => readonly StreamEvent[];
  answer?: string;
  /** 在流之前跑：抛出去就是从 provider 里抛（测"子代理的 provider 炸了"）。 */
  before?: (req: StreamRequest, n: number) => void;
};

async function mount(options: MountOptions) {
  const requests: StreamRequest[] = [];
  const describes: { tool: string; atRequest: number }[] = [];
  const toolCalls: string[] = [];
  const spawns: string[] = [];
  const deltas: string[] = [];
  const notices: string[] = [];
  const asks: string[] = [];

  const provider: ModelProvider = {
    name: 'test',
    async *stream(req) {
      requests.push(req);
      const n = requests.length;
      options.before?.(req, n);
      const events =
        options.response?.(req, n) ??
        options.script?.[n - 1] ??
        [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  /**
   * 观察者：**坐在 prepend** 才有用。
   *
   * 工具自己的 `tool.describe` / `tool.call` 都在 `builtin`，它们**直接应答、不调 next**，
   * 坐在它们里面的话一次都轮不到我。坐在最外层，看一笔、再交给下面。
   * 而且**必须 `return next(e)`** —— 什么都不返回会被 dispatch 当成 hook 失败
   * （core/dispatch.ts:95），链虽然照常往下走，但会多出"失败已跳过"的假警告。
   */
  const observer: Plugin = {
    name: 'test-observer',
    uses: ['tool.describe', 'tool.call', 'agent.spawn'],
    register(on) {
      on('tool.describe', (_$, e, next) => {
        describes.push({ tool: String(e.tool), atRequest: requests.length });
        return next(e);
      });
      on('tool.call', (_$, e, next) => {
        toolCalls.push(String(e.tool));
        return next(e);
      });
      on('agent.spawn', (_$, e, next) => {
        spawns.push(String(e.name));
        return next(e);
      });
    },
  };

  // streamPlugin 只用到 render.delta —— 一个只记 delta 的壳就够。
  const fakeRender = { delta: (text: string) => deltas.push(text) } as unknown as Renderer;

  const engine = await createEngine({
    plugins: [
      streamPlugin(fakeRender),
      confirmPlugin,
      createSubagentsPlugin({ agents: options.agents, skills: [], baseSystemPrompt: '基础提示' }),
      ...coreTools,
      observer,
    ],
    seating: { 'test-observer': 'prepend' },
    provider,
    ui: {
      print: () => {},
      notice: (line) => notices.push(line),
      ask: async (question) => {
        asks.push(question);
        return options.answer ?? 'y';
      },
    },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });

  /** 跑一个**父级** turn（走真的 loop，于是工具的返回值都留在 messages 里）。 */
  async function runParent(): Promise<{ messages: Message[]; stopReason: string }> {
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const ctx: LoopContext = {
      $: engine.$,
      provider,
      signal: new AbortController().signal,
      dispatch: engine.dispatch,
      systemPrompt: '父级提示',
      turnIndex: 0,
    };
    const stopReason = await runTurn(ctx, messages);
    return { messages, stopReason };
  }

  return { ...engine, requests, describes, toolCalls, spawns, deltas, notices, asks, runParent };
}

/**
 * 最后一条**工具结果**消息里的第 n 个内容。
 *
 * ⚠️ **别用 `messages.at(-1)`**：loop 在 `break` 之前还会 push 一条 assistant 消息
 * （没有文本时 `content` 是空数组，见 `core/loop.ts:130-139`），所以 turn 跑完之后
 * 最后一条**往往不是**工具消息。这里要的是"上一轮工具拿回了什么"，得往回找。
 * （这条是 T3 执行时实测出来的，原计划的写法三处用例全挂。）
 */
function resultAt(messages: readonly Message[], index = 0): string {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  if (last?.role !== 'tool') throw new Error('这一轮没有任何工具结果消息');
  return last.results[index]?.content ?? '';
}

describe('C2-5：白名单的两个落点', () => {
  it('看见的恰好是三个 —— 白名单把面缩了，模型那边也是三个', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read', 'Glob', 'Grep'] })],
      script: [callTask('explorer'), say('父级收工')],
    });
    await m.runParent();

    // 父级自己那一轮的 describe 发生在第一次请求**之前**（atRequest === 0）；
    // 子代理那一轮的 describe 发生在父级第一次请求**之后**（atRequest === 1）。
    //
    // ⚠️ P10 之后这里**不再数次数**（原来是"恰好三次"）。派一次子代理现在会算三遍工具面：
    // ① 内核先算"父级这一轮的面" —— 会话这一层没有白名单，于是那一次是**全量**的一遍
    //    （与会话主循环每一轮做的是同一件事，只是这里多算了一回）；
    // ② 求交之后再算"内层这一轮的面"；
    // ③ 内层自己的 `runTurn` 还要算一遍 —— 它要的是 specs，不只是名字。
    // 三遍都是设计之内。所以这一条钉的是**模型看见什么**，次数是实现细节 ——
    // 想钉次数的话，钉的是下面这一行。
    const inner = m.describes.filter((d) => d.atRequest === 1).map((d) => d.tool);
    expect(inner).toContain('Read');
    // 模型眼里恰好三个：白名单里那两个 + Read。
    expect(m.requests[1]?.tools.map((t) => t.name).sort()).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('点名清单外的工具 → 拒，理由里把可用的列了出来', async () => {
    const target = join(root, '不该出现.txt');
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read', 'Glob', 'Grep'] })],
      response: (req, n) => {
        if (n === 1) return callTask('explorer', '试着写个文件');
        if (n === 2) {
          // 子代理第一轮：同时点名一个允许的与一个越界的。
          return [
            toolUse('u1', 'Read', { file_path: notesPath }),
            toolUse('u2', 'Write', { file_path: target, content: 'x' }),
            done('tool_use'),
          ];
        }
        if (n === 3) {
          // 子代理第二轮：把上一轮的工具结果**原样复述出来**。
          // 这是穿透隔离的唯一一个窗口，而且是**子代理自己选的** —— 隔离没被破坏，
          // 父级能看见只是因为子代理把看到的东西报了上来。
          const last = req.messages.at(-1);
          const text =
            last?.role === 'tool' ? last.results.map((r) => r.content).join('\n---\n') : '';
          return say(text);
        }
        return [{ type: 'done', stopReason: 'end_turn' }];
      },
    });
    const { messages } = await m.runParent();

    const content = resultAt(messages);
    expect(content).toContain('不在本次的工具清单里');
    expect(content).toContain('可用：Read, Glob, Grep');
    // 它压根没走到 tool.call —— 落点二在权限链**之前**。
    expect(m.toolCalls).not.toContain('Write');
    // 而允许的那个真的跑了：文件内容原样在复述里。
    expect(content).toContain(FILE_TEXT);
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});

describe('C2-7：隔离', () => {
  it('父级只拿到子代理最后那句话，拿不到它读过的文件内容', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read'] })],
      script: [
        callTask('explorer', '读一下 notes.md'),
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('文件我读完了，结论是 X。'),
        say('父级收工'),
      ],
    });
    const { messages } = await m.runParent();

    const content = resultAt(messages);
    expect(content).toBe('文件我读完了，结论是 X。');
    // 中间的工具结果留在子代理自己那本账里，随它一起丢掉 —— 这就是"隔离"的全部含义。
    expect(content).not.toContain(FILE_TEXT);
  });
});

describe('C2-8：静音', () => {
  it('子代理的话不写屏幕，但它调的工具照常派发', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read'] })],
      script: [
        callTask('explorer'),
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('子代理的私语'),
        say('父级的收工语'),
      ],
    });
    await m.runParent();

    const screen = m.deltas.join('');
    expect(screen).toContain('父级的收工语');
    // 静音静的是**屏幕**。子代理的文本一个字节都没到渲染器上。
    expect(screen).not.toContain('子代理的私语');
    // 但事实照发：它调的工具真的跑了（/diff 的账不能丢）。
    expect(m.toolCalls).toContain('Read');
    expect(m.toolCalls).toContain('Task');
  });
});

describe('C2-9：tools: [] 断掉递归', () => {
  it('空白名单的 agent 连 Task 都看不见', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'lonely', tools: [] })],
      script: [callTask('lonely'), say('父级收工')],
    });
    await m.runParent();
    expect(m.requests[1]?.tools).toEqual([]);
  });
});

describe('C2-10：深度保险丝', () => {
  it('三层派得下去，第四层被拒', async () => {
    const m = await mount({
      // 省略 tools = 继承全部，于是它有 Task —— 深度是白名单的推论，保险丝只兜底次数。
      agents: [agentSpec({ name: 'recursor' })],
      script: [
        callTask('recursor'),
        callTask('recursor'),
        callTask('recursor'),
        callTask('recursor'), // 第 4 次：stack.length === 3，被拒
        say('够深了'),
        say('回'),
        say('回'),
        say('收工'),
      ],
    });
    const { stopReason } = await m.runParent();

    expect(m.spawns).toEqual(['recursor', 'recursor', 'recursor']);
    expect(m.notices.filter((line) => line.startsWith('派子代理'))).toHaveLength(3);
    // 父级没有被这件事绊倒。
    expect(stopReason).toBe('answer');
  });
});

describe('C2-11：全权不等于免确认', () => {
  it('省略 tools 的子代理写文件，confirm 照样弹 y/N', async () => {
    const target = join(root, 'out.txt');
    const m = await mount({
      agents: [agentSpec({ name: 'writer' })],
      answer: 'n',
      script: [
        callTask('writer', '写个文件'),
        [toolUse('u1', 'Write', { file_path: target, content: 'hi' }), done('tool_use')],
        say('结束'),
        say('父级收工'),
      ],
    });
    await m.runParent();

    // 先钉住前提：写文件的是**子代理**，不是父级。少了这一条，`Task` 一旦被拒，
    // 父级会自己把脚本里那个 Write 执行掉 —— 下面两条照样绿，测的却不是子代理了。
    expect(m.spawns).toEqual(['writer']);
    // "全权"指的是工具面，不是免确认：Write 走的是同一条 tool.check 链。
    expect(m.asks).toHaveLength(1);
    expect(m.asks[0]).toContain('Write');
    // 用户在那个提示上按了 n → 文件不该存在。
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});

describe('C2-12：模型分层', () => {
  it('spec 的 model 送到 provider；没写就是 undefined（= 父级那个）', async () => {
    const m = await mount({
      // `model: inherit` 在 agents.ts 里已经变成"字段不存在"（Task 7 钉着那一步），
      // 所以这里那一条直接省略字段。
      agents: [agentSpec({ name: 'smart', model: 'haiku' }), agentSpec({ name: 'plain' })],
      script: [
        callTask('smart'),
        say('子'),
        say('父'),
        callTask('plain'),
        say('子'),
        say('父'),
      ],
    });
    await m.runParent();
    await m.runParent();

    expect(m.requests[1]?.model).toBe('haiku');
    expect(m.requests[4]?.model).toBeUndefined();
    // 父级自己那两轮也都不是 haiku。
    expect(m.requests[0]?.model).toBeUndefined();
  });
});

describe('C2-13：子代理失败不炸父级', () => {
  it('撞 max_hops → 变成本次 tool.call 的错误结果，父级继续', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'stuck', maxTurns: 1 })],
      script: [
        callTask('stuck'),
        // 子代理唯一那一跳就要工具 —— 跳用完就撞上限。
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('父级继续了'),
      ],
    });
    const { messages, stopReason } = await m.runParent();

    expect(resultAt(messages)).toContain('未正常结束（max_hops）');
    expect(stopReason).toBe('answer');
  });

  it('provider 抛异常 → 同样变成错误结果', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'boom' })],
      // 两次都抛：loop 会退避重试一次（`loop.ts` 的那条），所以 n=2 与 n=3 都得炸。
      // 这条用例会实打实花掉那 1 秒 —— 值的：它是 'error' 这一支唯一的端到端证明。
      before: (_req, n) => {
        if (n === 2 || n === 3) throw new Error('provider 炸了');
      },
      // 按请求号点单，不写 `script`：父级的第二次请求是**第 4 次**（中间两次炸的都是子代理），
      // 而 script 是按请次下标取的 —— 写数组会让人以为第 2 段是给父级的。
      // ⚠️ 改之前父级那一跳落到兜底的空响应上（一句正文都没有），靠"空响应也算答完了"
      // 才绿；P8 之后空步是 `empty`，于是这条用例的**意图**（父级照常收工）才第一次被真的测到。
      response: (_req, n) => (n === 1 ? callTask('boom') : say('父级继续了')),
    });
    const { messages, stopReason } = await m.runParent();

    expect(resultAt(messages)).toContain('未正常结束（error）');
    expect(stopReason).toBe('answer');
  });

  it('P8：只写了一半的子代理（被长度上限截断）不能被当成完整答复', async () => {
    // 子代理那一步先给正文、再报 `max_tokens`。它自己会续写，但脚本里每一跳都被截断，
    // 于是它在 MAX_CONTINUATIONS 用尽之后以 `truncated` 收场。
    const half = (text: string): readonly StreamEvent[] => [
      { type: 'text', text },
      done('max_tokens'),
    ];
    const m = await mount({
      agents: [agentSpec({ name: 'half' })],
      script: [
        callTask('half'),
        half('前半截'),
        half('后半截'),
        half('再半截'),
        half('还半截'),
        say('父级收工'),
      ],
    });
    const { messages, stopReason } = await m.runParent();

    // 这就是 P8 要修的那个真 bug：`truncated` 以前不在黑名单里，半截答复被原样交回父级。
    expect(resultAt(messages)).toContain('未正常结束（truncated）');
    // 说"它没做完"的同时，那半截内容也照带回去 —— 父级两样都要。
    expect(resultAt(messages)).toContain('前半截');
    // 理由一路传到 CLI 那一层，通知里看得见。（P10 给这一行加了层数：嵌套一次之后
    // "回来了"的是哪一层，屏幕上要认得出。设计 §5 记了这条措辞变化。）
    expect(m.notices).toContain('子代理 half 回来了（truncated，第 1 层）');
    expect(stopReason).toBe('answer');
  });
});
