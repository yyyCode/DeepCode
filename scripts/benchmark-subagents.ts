import { pathToFileURL } from 'node:url';
import type { AgentSpec } from '../src/contract/agent';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import { estimateTokens } from '../src/core/tokens';
import { confirmPlugin } from '../src/builtins/confirm';
import { BUILTIN_AGENTS } from '../src/cli/builtin-agents';
import { createSubagentsPlugin } from '../src/cli/subagents';

/**
 * 子代理 benchmark（P15）。
 *
 * 量四件事：
 * 1. **隔离**：同一个 60 000 字符的工具结果，父级直接读 vs 派 `explore` 读，
 *    父级消息的字符/估算 token 差多少；
 * 2. **并发**：一轮里三个独立探索，`Explore`（声明 readOnly）vs `Task`（串行）
 *    的峰值并发与墙钟；
 * 3. **开箱名册**：三个内置类型的 tools / readOnly / 提示字符；
 * 4. **fail-closed**：文件声明 `readOnly: true` 但面里混进 `Write`，内核拒得下来吗。
 *
 * ⚠️ 口径：
 * - 不调用真模型、不需要 key。跑的是真的 `runTurn`，provider 是脚本。
 * - token 仍是 `ceil(chars/4)`，中英混排会失真；同一把尺子，比值有意义，绝对值没有。
 * - 隔离表只算**父级 messages**（含工具结果），不含系统提示与工具 schema；
 *   子代理自己的转录随它一起丢掉，不计入父级。
 * - 并发表用 `sleep` 模拟一次探索耗时，墙钟包含框架开销；峰值并发是同时活着的
 *   子代理请求数。断言方向是结构（3 vs 1、并发更短），不是绝对毫秒。
 *
 * 跑法：`pnpm bench:subagent`。测试里 import `runSubagentBenchmarks()` 断言之。
 */

export type IsolationRow = {
  readonly mode: 'inline' | 'delegated';
  readonly parentChars: number;
  readonly parentTokens: number;
  readonly requests: number;
};

export type ConcurrencyRow = {
  readonly tool: 'Explore' | 'Task';
  readonly calls: number;
  readonly peak: number;
  readonly wallMs: number;
};

export type BuiltinRow = {
  readonly name: string;
  readonly tools: readonly string[] | undefined;
  readonly readOnly: boolean;
  readonly maxTurns: number | undefined;
  readonly promptChars: number;
};

export type GuardRow = {
  readonly name: string;
  readonly denied: boolean;
  readonly reason: string;
  readonly childRequests: number;
};

export type SubagentBenchmarkResult = {
  readonly isolation: {
    readonly inline: IsolationRow;
    readonly delegated: IsolationRow;
    /** 委派后父级字符 / 直接读的父级字符。越小越省。 */
    readonly ratio: number;
  };
  readonly concurrency: readonly ConcurrencyRow[];
  readonly builtins: readonly BuiltinRow[];
  readonly guard: GuardRow;
};

const BIG = 'x'.repeat(60_000);
const SUMMARY = `读完了，结论是 X。${'要点。'.repeat(40)}`;
const CHILD_DELAY_MS = 40;

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

function textOf(req: StreamRequest): string {
  const first = req.messages[0];
  return first !== undefined && first.role !== 'tool' && typeof first.content === 'string'
    ? first.content
    : '';
}

function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) total += result.content.length;
    } else {
      total +=
        typeof message.content === 'string'
          ? message.content.length
          : JSON.stringify(message.content).length;
    }
  }
  return total;
}

/** 读工具（只读）+ 一个写工具：前者给大结果，后者只用来验 fail-closed。 */
const toolsPlugin: Plugin = {
  name: 'bench-tools',
  uses: ['tool.describe', 'tool.call'],
  register(on) {
    for (const name of ['Read', 'Glob', 'Grep']) {
      on('tool.describe', { tool: name }, () => ({
        description: `工具 ${name}`,
        inputSchema: { type: 'object', properties: { big: { type: 'boolean' } } },
        readOnly: true,
      }));
      on('tool.call', { tool: name }, (_$, e) => {
        const input = (e.input ?? {}) as { readonly big?: boolean };
        return { value: input.big === true ? BIG : `${name} ok` };
      });
    }
    on('tool.describe', { tool: 'Write' }, () => ({
      description: '写一个文件',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
    }));
    on('tool.call', { tool: 'Write' }, () => ({ value: 'written' }));
  },
};

const allowPlugin: Plugin = {
  name: 'bench-allow',
  uses: ['tool.check'],
  register(on) {
    on('tool.check', () => ({ decision: 'allow' }) as const);
  },
};

type World = {
  readonly messages: Message[];
  readonly requests: StreamRequest[];
  readonly spawns: string[];
  readonly wallMs: number;
};

async function runWorld(options: {
  readonly agents: readonly AgentSpec[];
  readonly respond: (req: StreamRequest, n: number) => Promise<readonly StreamEvent[]> | readonly StreamEvent[];
}): Promise<World> {
  const requests: StreamRequest[] = [];
  const spawns: string[] = [];

  const provider: ModelProvider = {
    name: 'bench-scripted',
    async *stream(req) {
      requests.push(req);
      const events = await options.respond(req, requests.length);
      for (const event of events) yield event;
    },
  };

  const observer: Plugin = {
    name: 'bench-spawn-observer',
    uses: ['agent.spawn'],
    register(on) {
      on('agent.spawn', (_$, e, next) => {
        spawns.push(e.name);
        return next(e);
      });
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [
      createSubagentsPlugin({
        agents: options.agents,
        skills: [],
        baseSystemPrompt: '基础提示',
      }),
      confirmPlugin,
      toolsPlugin,
      allowPlugin,
      observer,
    ],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 'bench', cwd: '/bench', root: '/bench' },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const started = performance.now();
  await runTurn(
    {
      $,
      provider,
      signal: new AbortController().signal,
      dispatch,
      systemPrompt: '父级提示',
      turnIndex: 0,
    },
    messages,
  );
  return { messages, requests, spawns, wallMs: performance.now() - started };
}

async function isolationRow(mode: 'inline' | 'delegated'): Promise<IsolationRow> {
  const delegated = mode === 'delegated';
  const world = await runWorld({
    agents: BUILTIN_AGENTS,
    respond: (req, n) => {
      if (!delegated) {
        if (n === 1) return [toolUse('read', 'Read', { big: true }), done()];
        return say('收工');
      }
      if (n === 1) {
        return [toolUse('explore', 'Explore', { prompt: '读那个大文件并总结' }), done()];
      }
      if (textOf(req) === '读那个大文件并总结') {
        if (n === 2) return [toolUse('read', 'Read', { big: true }), done()];
        return say(SUMMARY);
      }
      return say('收工');
    },
  });
  const parentChars = messageChars(world.messages);
  return {
    mode,
    parentChars,
    parentTokens: estimateTokens(parentChars),
    requests: world.requests.length,
  };
}

async function concurrencyRow(tool: 'Explore' | 'Task'): Promise<ConcurrencyRow> {
  let active = 0;
  let peak = 0;
  const labels = ['A', 'B', 'C'];
  const world = await runWorld({
    agents: BUILTIN_AGENTS,
    respond: async (req, n) => {
      if (n === 1) {
        return [
          ...labels.map((label) =>
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
        await sleep(CHILD_DELAY_MS);
        active -= 1;
        return say(`结论 ${textOf(req).slice(5)}`);
      }
      return say('收工');
    },
  });
  return { tool, calls: labels.length, peak, wallMs: Math.round(world.wallMs) };
}

async function guardRow(): Promise<GuardRow> {
  const requests: StreamRequest[] = [];
  const provider: ModelProvider = {
    name: 'bench-guard',
    async *stream(req) {
      requests.push(req);
      for (const event of say('不该跑到这里')) yield event;
    },
  };
  const { $ } = await createEngine({
    plugins: [toolsPlugin, allowPlugin],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 'bench', cwd: '/bench', root: '/bench' },
    env: {},
    signal: () => new AbortController().signal,
  });

  const result = await $.agent.spawn({
    name: 'liar',
    systemPrompt: '你只读',
    task: '写个文件',
    allow: ['Read', 'Write'],
    readOnly: true,
  });
  return {
    name: 'liar',
    denied: !result.ok,
    reason: result.ok ? '' : result.reason,
    childRequests: requests.length,
  };
}

export async function runSubagentBenchmarks(): Promise<SubagentBenchmarkResult> {
  const inline = await isolationRow('inline');
  const delegated = await isolationRow('delegated');
  return {
    isolation: {
      inline,
      delegated,
      ratio: delegated.parentChars / inline.parentChars,
    },
    concurrency: [await concurrencyRow('Explore'), await concurrencyRow('Task')],
    // 与名册实际的排序一致（`discoverAgents` 按名字排），这样表里读到的顺序就是
    // 模型在系统提示里看到的顺序。
    builtins: [...BUILTIN_AGENTS]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((spec) => ({
        name: spec.name,
        tools: spec.tools,
        readOnly: spec.readOnly === true,
        maxTurns: spec.maxTurns,
        promptChars: spec.prompt.length,
      })),
    guard: await guardRow(),
  };
}

function num(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatSubagentTables(result: SubagentBenchmarkResult): string {
  const isolationHead =
    '| 模式 | 父级 messages 字符 | 父级 token（估） | 模型请求 |\n| --- | ---: | ---: | ---: |';
  const isolationBody = [result.isolation.inline, result.isolation.delegated].map(
    (row) =>
      `| ${row.mode === 'inline' ? '父级直接读' : '派 explore 读'} | ${num(row.parentChars)} | ` +
      `${num(row.parentTokens)} | ${row.requests} |`,
  );

  const concurrencyHead =
    '| 入口 | 调用 | 峰值并发 | 墙钟 |\n| --- | ---: | ---: | ---: |';
  const concurrencyBody = result.concurrency.map(
    (row) =>
      `| ${row.tool} | ${row.calls} | ${row.peak} | ${num(row.wallMs)} ms |`,
  );

  const builtinHead =
    '| 名字 | tools | 只读 | maxTurns | 提示字符 |\n| --- | --- | --- | ---: | ---: |';
  const builtinBody = result.builtins.map(
    (row) =>
      `| ${row.name} | ${row.tools === undefined ? '（继承父面）' : row.tools.join(' / ')} | ` +
      `${row.readOnly ? '是' : '否'} | ${row.maxTurns ?? '—'} | ${num(row.promptChars)} |`,
  );

  const guardHead = '| agent | 结果 | 子代理请求 | 理由 |\n| --- | --- | ---: | --- |';
  const guardBody =
    `| ${result.guard.name} | ${result.guard.denied ? '拒绝' : '放行'} | ` +
    `${result.guard.childRequests} | ${result.guard.reason} |`;

  return [
    '# 子代理 benchmark（P15）\n',
    '## 隔离：父级上下文',
    [isolationHead, ...isolationBody].join('\n'),
    `\n委派后父级字符是直接读的 ${(result.isolation.ratio * 100).toFixed(1)}%。`,
    '\n## 并发：三个独立探索',
    [concurrencyHead, ...concurrencyBody].join('\n'),
    '\n## 内置名册',
    [builtinHead, ...builtinBody].join('\n'),
    '\n## fail-closed：谎报 readOnly 的 agent',
    [guardHead, guardBody].join('\n'),
  ].join('\n');
}

async function main(): Promise<void> {
  const result = await runSubagentBenchmarks();
  console.log(formatSubagentTables(result));
  console.log(
    '\n口径：token = `ceil(chars/4)` 估算；隔离表只算父级 messages，不含系统提示与工具 schema。' +
      `并发表用 ${CHILD_DELAY_MS}ms 模拟一次探索，墙钟含框架开销；` +
      'Explore 的 readOnly 声明让同一轮里连续的调用并发，Task 没声明所以串行。' +
      'fail-closed 那一行跑的是真的内核验证：文件可以写 readOnly: true，面里混进 Write 就拒。',
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
