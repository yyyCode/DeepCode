import { pathToFileURL } from 'node:url';
import type { Message, ModelProvider } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { createEngine } from '../src/core/create';
import { runTurn } from '../src/core/loop';
import { listTools, toolsChars } from '../src/core/tool-list';
import { estimateTokens } from '../src/core/tokens';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import {
  createPlanMode,
  createPlanModePlugin,
  planModePrompt,
} from '../src/builtins/plan';

/**
 * Agent 循环与计划模式的 benchmark（P14）。
 *
 * 量三件事：
 * 1. **循环没有额外的"思考"往返**：模型要 N 次工具，就只发 N+1 次模型请求；
 * 2. **计划模式把模型面的工具收窄多少**：可见工具数与工具 schema 的 token；
 * 3. **计划模式每轮多花多少提示**：计划提示 vs 少掉的工具 schema，按轮次算净账。
 *
 * ⚠️ 口径：
 * - token 仍是 `ceil(chars/4)`，中英混排会失真；同一把尺子，比值有意义，绝对值没有。
 * - 不调用模型，不需要 key。第一张表跑的是真的 `runTurn`，provider 是脚本。
 * - 计划模式的净账只算**系统提示 + 工具 schema**，不含对话历史、工具结果与缓存。
 * - 工具 schema 的 token 用 `toolSpecChars` 估算，不等于适配器真正发出的字节数。
 * - 计划模式隐藏哪些工具是当前策略（Read / Glob / Grep / Skill / ExitPlanMode），
 *   不是"所有未来的只读工具都会自动放行" —— 新工具要显式加进 `PLAN_ALLOWED`。
 *
 * 跑法：`pnpm bench:loop`。测试里 import `runAgentLoopBenchmarks()` 断言之。
 */

export type RoundTripRow = {
  readonly toolCalls: number;
  readonly requests: number;
  readonly executed: number;
  /** 模型请求数 −（工具调用数 + 最后那次收手请求）。应为 0。 */
  readonly extraRequests: number;
};

export type PlanTurnRow = {
  readonly turns: number;
  readonly baselineTokens: number;
  readonly planTokens: number;
  readonly promptTokens: number;
  readonly savedToolTokens: number;
  /** 计划模式 − 普通模式；负数 = 计划模式反而省。 */
  readonly deltaTokens: number;
};

export type AgentLoopBenchmarkResult = {
  readonly roundTrips: readonly RoundTripRow[];
  readonly plan: {
    readonly baselineTools: readonly string[];
    readonly planTools: readonly string[];
    readonly blockedTools: readonly string[];
    readonly baselineToolTokens: number;
    readonly planToolTokens: number;
    readonly planPromptChars: number;
    readonly planPromptTokens: number;
    readonly turns: readonly PlanTurnRow[];
  };
};

const providerStub: ModelProvider = {
  name: 'bench-stub',
  async *stream() {
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
};

async function benchRoundTrip(toolCalls: number): Promise<RoundTripRow> {
  let requests = 0;
  let executed = 0;
  let index = 0;
  const provider: ModelProvider = {
    name: 'bench-scripted',
    async *stream() {
      requests += 1;
      if (index < toolCalls) {
        index += 1;
        yield { type: 'tool_use', id: `u${index}`, name: 'Read', input: {} };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', text: '收工' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const tools: Plugin = {
    name: 'bench-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      on('tool.describe', { tool: 'Read' }, () => ({
        description: '读一个文件',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
      }));
      on('tool.call', { tool: 'Read' }, () => {
        executed += 1;
        return { value: 'ok' };
      });
    },
  };
  const allow: Plugin = {
    name: 'bench-allow',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: [tools, allow],
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 'bench', cwd: '/bench', root: '/bench' },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  await runTurn(
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

  return {
    toolCalls,
    requests,
    executed,
    extraRequests: requests - (toolCalls + 1),
  };
}

async function benchPlan(): Promise<AgentLoopBenchmarkResult['plan']> {
  const mode = createPlanMode({ now: () => 0 });
  const { $, dispatch } = await createEngine({
    plugins: [createPlanModePlugin(mode), ...coreTools, confirmPlugin],
    provider: providerStub,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 'bench', cwd: '/bench/project', root: '/bench/project' },
    env: {},
    signal: () => new AbortController().signal,
  });

  const before = await listTools({ $, dispatch });
  await mode.enter($);
  const after = await listTools({ $, dispatch });

  const baselineTools = before.specs.map((spec) => spec.name);
  const planTools = after.specs.map((spec) => spec.name);
  const blockedTools = baselineTools.filter((name) => !planTools.includes(name));
  const baselineToolTokens = estimateTokens(toolsChars(before.specs));
  const planToolTokens = estimateTokens(toolsChars(after.specs));
  const prompt = mode.prompt() ?? planModePrompt({ path: mode.path() ?? '', turns: 1 });
  const planPromptChars = prompt.length;
  const planPromptTokens = estimateTokens(planPromptChars);

  const turns: PlanTurnRow[] = [1, 5, 10, 20].map((count) => {
    let promptTokens = 0;
    for (let turn = 1; turn <= count; turn += 1) {
      promptTokens += estimateTokens(
        planModePrompt({ path: mode.path() ?? '', turns: turn }).length,
      );
    }
    const savedToolTokens = (baselineToolTokens - planToolTokens) * count;
    return {
      turns: count,
      baselineTokens: baselineToolTokens * count,
      planTokens: planToolTokens * count + promptTokens,
      promptTokens,
      savedToolTokens,
      deltaTokens: planToolTokens * count + promptTokens - baselineToolTokens * count,
    };
  });

  return {
    baselineTools,
    planTools,
    blockedTools,
    baselineToolTokens,
    planToolTokens,
    planPromptChars,
    planPromptTokens,
    turns,
  };
}

export async function runAgentLoopBenchmarks(): Promise<AgentLoopBenchmarkResult> {
  const roundTrips: RoundTripRow[] = [];
  for (const toolCalls of [0, 1, 3, 5, 10]) {
    roundTrips.push(await benchRoundTrip(toolCalls));
  }
  return { roundTrips, plan: await benchPlan() };
}

function num(count: number): string {
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${num(value)}`;
}

export function formatAgentLoopTables(result: AgentLoopBenchmarkResult): string {
  const roundHead =
    '| 工具调用 | 模型请求 | 工具执行 | 框架额外请求 |\n| ---: | ---: | ---: | ---: |';
  const roundBody = result.roundTrips.map(
    (row) =>
      `| ${row.toolCalls} | ${row.requests} | ${row.executed} | ${row.extraRequests} |`,
  );

  const surfaceHead = '| 阶段 | 可见工具 | 工具 schema token |\n| --- | ---: | ---: |';
  const surfaceBody = [
    `| 普通模式 | ${result.plan.baselineTools.length}（${result.plan.baselineTools.join(' / ')}） | ${num(result.plan.baselineToolTokens)} |`,
    `| 计划模式 | ${result.plan.planTools.length}（${result.plan.planTools.join(' / ')}） | ${num(result.plan.planToolTokens)} |`,
    `| 被藏起来 | ${result.plan.blockedTools.length}（${result.plan.blockedTools.join(' / ')}） | — |`,
  ];

  const planHead =
    '| 计划轮次 | 普通模式 | 计划模式 | 计划提示 | 工具 schema 节省 | 净变化（负 = 更省） |\n' +
    '| ---: | ---: | ---: | ---: | ---: | ---: |';
  const planBody = result.plan.turns.map(
    (row) =>
      `| ${row.turns} | ${num(row.baselineTokens)} | ${num(row.planTokens)} | ` +
      `${num(row.promptTokens)} | ${num(row.savedToolTokens)} | ${signed(row.deltaTokens)} |`,
  );

  return [
    '# Agent 循环 benchmark\n',
    '## Tool-Use Loop：工具调用与模型请求',
    [roundHead, ...roundBody].join('\n'),
    '\n## 计划模式的工具面',
    [surfaceHead, ...surfaceBody].join('\n'),
    `\n计划提示：${num(result.plan.planPromptChars)} 字符 / ${num(result.plan.planPromptTokens)} token（第 1 轮）。`,
    '\n## 计划模式的净账（工具 schema + 系统提示，不含对话历史）',
    [planHead, ...planBody].join('\n'),
  ].join('\n');
}

async function main(): Promise<void> {
  const result = await runAgentLoopBenchmarks();
  console.log(formatAgentLoopTables(result));
  console.log(
    '\n口径：token = `ceil(chars/4)` 估算；只算工具 schema 与计划提示，不含对话历史、' +
      '工具结果与缓存。Tool-Use Loop 那张表跑的是真的 `runTurn`（provider 是脚本），' +
      '「框架额外请求」按 `模型请求 − (工具调用 + 1)` 算，0 表示循环没有插入额外的思考轮。' +
      '计划模式的净账是**模型面**的账：隐藏写工具省下的 schema 与注入的计划提示相抵。',
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
