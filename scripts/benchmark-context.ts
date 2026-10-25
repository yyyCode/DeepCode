import { pathToFileURL } from 'node:url';
import type { ContextLayerConfig } from '../src/contract/context-window';
import type { FsNoun } from '../src/contract/engine';
import type { Message, ModelProvider, ToolResult } from '../src/contract/model-provider';
import { createContextWindow } from '../src/cli/context-window';
import { collapseOld, requestTokens } from '../src/core/context-shaping';

/**
 * 五层压缩的 benchmark（P11 §8）。
 *
 * 量的是**请求那一刻端点看到多少 token**，不是"省了多少磁盘"。基线 = 只做第 5 层
 * （到阈值就全量摘要）；分层 = 第 1–4 层 + 兜底的第 5 层。两边用同一个 `atTokens`、
 * 同一批消息、同一段摘要正文。
 *
 * ⚠️ 三条口径：
 * 1. token 数是 `ceil(chars/4)` 的**估算**（`core/tokens.ts`），中英混排会失真；
 *    两边同一条尺子，所以比值有意义，绝对值没有。
 * 2. 第 4/5 层的摘要正文固定为一段短文本 —— 这里量的是**调用次数与请求体积**，
 *    不是摘要质量。真实摘要长度取决于模型。
 * 3. 系统提示与工具清单都按 0 算：两边相等，摊平不影响对比。
 *
 * 跑法：`pnpm bench`。测试里 import `runBenchmarks()`，断言分层不劣于基线。
 */

const SUMMARY = '（模拟摘要）目标、已改文件、结论、遗留问题。'.repeat(2);

const KEEP_TURNS = 6;

export type ScenarioTurn = { readonly tool: string; readonly chars: number };

export type BenchmarkScenario = {
  readonly name: string;
  readonly atTokens: number;
  readonly turns: readonly ScenarioTurn[];
};

const repeat = (count: number, make: (index: number) => ScenarioTurn): ScenarioTurn[] =>
  Array.from({ length: count }, (_, index) => make(index));

export const SCENARIOS: readonly BenchmarkScenario[] = [
  {
    name: 'huge-reads',
    atTokens: 30_000,
    turns: repeat(15, () => ({ tool: 'Read', chars: 80_000 })),
  },
  {
    name: 'long-session',
    atTokens: 30_000,
    turns: repeat(40, () => ({ tool: 'Bash', chars: 4_000 })),
  },
  {
    name: 'mixed',
    atTokens: 30_000,
    turns: repeat(30, (index) =>
      index % 5 === 0 ? { tool: 'Read', chars: 60_000 } : { tool: 'Bash', chars: 1_000 },
    ),
  },
];

export type StrategyResult = {
  /** 所有请求里最大的那一次（端点视角的峰值）。 */
  readonly peakTokens: number;
  readonly finalTokens: number;
  /** 第 5 层全量摘要的调用次数。 */
  readonly summaryCalls: number;
  /** 第 4 层折叠摘要的调用次数（只有分层策略有）。 */
  readonly collapseCalls: number;
  readonly externalized: number;
  /**
   * 第 2 / 3 层**命中的请求次数**，不是"砍掉的条数之和"。
   *
   * 投影是读时的：同一批老消息在下一次请求里还会被再排除一次。把每次请求的
   * `snippedMessages` 加起来会把同一批消息数好几遍（40 轮的长会话能加出 1 300+）。
   */
  readonly snipRequests: number;
  readonly microRequests: number;
};

export type BenchmarkRow = {
  readonly scenario: string;
  readonly atTokens: number;
  readonly baseline: StrategyResult;
  readonly layered: StrategyResult;
};

function memoryFs(): FsNoun {
  const files = new Map<string, string>();
  return {
    async read(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(dir) {
      return [...files.keys()].filter((path) => path.startsWith(dir));
    },
    async stat(path) {
      return { size: files.get(path)?.length ?? 0, isDirectory: false };
    },
  };
}

function summaryProvider(): ModelProvider {
  return {
    name: 'benchmark',
    async *stream() {
      yield { type: 'text', text: SUMMARY };
      yield { type: 'done', stopReason: 'stop' };
    },
  };
}

function turnMessages(index: number, turn: ScenarioTurn, result: ToolResult): Message[] {
  const id = `toolu_${index}`;
  return [
    { role: 'user', content: `第 ${index + 1} 轮：继续检查。` },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: turn.tool, input: { step: index } }],
    },
    { role: 'tool', results: [result] },
  ];
}

function rawResult(index: number, turn: ScenarioTurn): ToolResult {
  return { toolUseId: `toolu_${index}`, content: 'x'.repeat(turn.chars), isError: false };
}

/** 基线：不做 1–4 层，只在 `atTokens` 处全量摘要（第 5 层）。 */
async function baseline(scenario: BenchmarkScenario): Promise<StrategyResult> {
  let history: readonly Message[] = [];
  let peak = 0;
  let final = 0;
  let summaryCalls = 0;

  for (const [index, turn] of scenario.turns.entries()) {
    history = [...history, ...turnMessages(index, turn, rawResult(index, turn))];
    const tokens = requestTokens(0, 0, history);
    peak = Math.max(peak, tokens);
    final = tokens;

    if (tokens >= scenario.atTokens) {
      const collapsed = collapseOld(history, KEEP_TURNS, SUMMARY);
      if (collapsed !== undefined) {
        history = collapsed.messages;
        summaryCalls += 1;
      }
    }
  }

  return {
    peakTokens: peak,
    finalTokens: final,
    summaryCalls,
    collapseCalls: 0,
    externalized: 0,
    snipRequests: 0,
    microRequests: 0,
  };
}

/** 分层：第 1 层写时外置，第 2–4 层读时投影，第 5 层只在投影后仍然到线时兜底。 */
async function layered(
  scenario: BenchmarkScenario,
  layers?: Partial<ContextLayerConfig>,
): Promise<StrategyResult> {
  const cw = createContextWindow({
    home: 'C:/bench',
    cwd: 'F:/bench/demo',
    sessionId: 'benchmark',
    fs: memoryFs(),
    provider: summaryProvider(),
    config: {
      auto: false,
      atTokens: scenario.atTokens,
      keepTurns: KEEP_TURNS,
      ...(layers === undefined ? {} : { layers }),
    },
    warn: () => {},
  });

  let history: readonly Message[] = [];
  let peak = 0;
  let final = 0;
  let summaryCalls = 0;
  let collapseCalls = 0;
  let snipRequests = 0;
  let microRequests = 0;

  const signal = new AbortController().signal;

  for (const [index, turn] of scenario.turns.entries()) {
    const raw = rawResult(index, turn);
    const [absorbed] = await cw.absorbToolResults([raw], new Map([[raw.toolUseId, turn.tool]]));
    history = [...history, ...turnMessages(index, turn, absorbed ?? raw)];

    const projection = await cw.project(history, {
      systemChars: 0,
      toolChars: 0,
      signal,
      now: index * 10_000,
    });
    const tokens = projection.stats.tokensAfter;
    peak = Math.max(peak, tokens);
    final = tokens;
    if (projection.applied.includes('snip')) snipRequests += 1;
    if (projection.applied.includes('micro')) microRequests += 1;
    if (projection.applied.includes('collapse')) collapseCalls += 1;

    if (tokens >= scenario.atTokens) {
      const collapsed = collapseOld(history, KEEP_TURNS, SUMMARY);
      if (collapsed !== undefined) {
        history = collapsed.messages;
        summaryCalls += 1;
      }
    }
  }

  return {
    peakTokens: peak,
    finalTokens: final,
    summaryCalls,
    collapseCalls,
    externalized: cw.last()?.externalized ?? 0,
    snipRequests,
    microRequests,
  };
}

export async function runBenchmarks(): Promise<readonly BenchmarkRow[]> {
  const rows: BenchmarkRow[] = [];
  for (const scenario of SCENARIOS) {
    rows.push({
      scenario: scenario.name,
      atTokens: scenario.atTokens,
      baseline: await baseline(scenario),
      layered: await layered(scenario),
    });
  }
  return rows;
}

function num(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const percent = (baselineTokens: number, layeredTokens: number): string => {
  if (baselineTokens === 0) return '—';
  const drop = ((baselineTokens - layeredTokens) / baselineTokens) * 100;
  return `${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(1)}%`;
};

export function formatTable(rows: readonly BenchmarkRow[]): string {
  const head =
    '| 场景 | 阈值 | 基线峰值 | 分层峰值 | 降幅 | 第 5 层摘要（基线→分层） | 第 4 层折叠 | 外置 | 第 2 层命中 | 第 3 层命中 |\n' +
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const body = rows.map((row) => {
    const { baseline: b, layered: l } = row;
    return (
      `| ${row.scenario} | ${num(row.atTokens)} | ${num(b.peakTokens)} | ${num(l.peakTokens)} | ` +
      `${percent(b.peakTokens, l.peakTokens)} | ${b.summaryCalls} → ${l.summaryCalls} | ` +
      `${l.collapseCalls} | ${l.externalized} | ${l.snipRequests} | ${l.microRequests} |`
    );
  });
  return [head, ...body].join('\n');
}

async function main(): Promise<void> {
  const rows = await runBenchmarks();
  console.log('# 上下文分层 benchmark\n');
  console.log(formatTable(rows));
  console.log(
    '\n口径：token 数 = `ceil(chars/4)` 估算；系统提示与工具清单按 0 算；' +
      '第 4/5 层摘要用同一段固定短文本，量的是调用次数与请求体积，不是摘要质量。',
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
