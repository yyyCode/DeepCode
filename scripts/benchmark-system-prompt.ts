import { pathToFileURL } from 'node:url';
import type { PromptEnvironment } from '../src/cli/prompt-text';
import { STATIC_PROMPT_SECTIONS } from '../src/cli/prompt-text';
import { assemblePrompt, type BuiltPrompt } from '../src/cli/system-prompt';
import { estimateTokens } from '../src/core/loop';

/**
 * 系统提示的 benchmark（P13 §8）。
 *
 * 量两件事：
 * 1. **静态段有多大**：它是每次请求都会带上的固定成本，按分节列出来；
 * 2. **静态/动态拆分值多少**：20 轮会话里，有前缀缓存与没有前缀缓存的
 *    「输入价折算 token 当量」差多少。
 *
 * ⚠️ 四条口径：
 * 1. token 沿用 `estimateTokens = ceil(chars/4)` 的估算，中英混排会失真；
 *    两边同一把尺子，比值有意义，绝对值没有。
 * 2. 缓存价格按 Anthropic 公开的倍数：写 1.25×、读 0.1×（5 分钟 TTL）。
 *    单位是「输入 token 价」，不是美元 —— 我们不知道用户配的是哪家端点、什么价。
 * 3. 只量**系统提示**。真实的缓存前缀还包括工具清单（tools → system → messages），
 *    工具那一份是稳定的，只会让命中收益**更大**，不会更小。
 * 4. 假设每一轮静态段都命中。真实命中还受 TTL、端点实现、请求间隔影响；
 *    这一点写进设计文档的偏差清单，不在这里假装。
 *
 * 跑法：`pnpm bench:prompt`。测试里 import `runSystemPromptBenchmarks()` 断言之。
 */

export const CACHE_TURNS = 20;
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

type ScenarioInput = {
  readonly name: string;
  readonly environment: PromptEnvironment;
  readonly instructionsChars: number;
  readonly offerChars: number;
};

const BASE_ENV: PromptEnvironment = {
  cwd: '/home/dev/small-service',
  gitRepo: true,
  platform: 'Linux',
  shell: 'bash',
  model: 'deepseek-chat',
  today: '2026-10-26',
};

const SCENARIOS: readonly ScenarioInput[] = [
  {
    name: 'small-service',
    environment: BASE_ENV,
    instructionsChars: 600,
    offerChars: 120,
  },
  {
    name: 'monorepo',
    environment: {
      ...BASE_ENV,
      cwd: '/home/dev/company-monorepo/packages/billing-service',
      model: 'claude-sonnet-5-5',
    },
    instructionsChars: 2_400,
    offerChars: 300,
  },
  {
    name: 'no-git',
    environment: {
      ...BASE_ENV,
      cwd: 'C:\\scratch\\one-off-task',
      gitRepo: false,
      platform: 'Windows',
      shell: 'cmd.exe',
    },
    instructionsChars: 0,
    offerChars: 0,
  },
];

/** 造一段稳定的中文正文；内容不重要，字符数才是这一阶段要量的东西。 */
function filler(chars: number): string {
  if (chars <= 0) return '';
  const unit = '项目约定：先看现状再动手，改动保持最小，验证结果如实报告。\n';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

export type SectionRow = {
  readonly name: string;
  readonly chars: number;
  readonly tokens: number;
};

export type ScenarioRow = {
  readonly name: string;
  readonly staticChars: number;
  readonly dynamicChars: number;
  readonly staticTokens: number;
  readonly dynamicTokens: number;
  readonly totalTokens: number;
  /** 静态段占整段提示的比例（0–1）。 */
  readonly staticShare: number;
  readonly staticText: string;
};

export type CacheRow = {
  readonly name: string;
  readonly baselineUnits: number;
  readonly cachedUnits: number;
  readonly savedUnits: number;
  /** 省下的比例（0–1）。 */
  readonly savings: number;
  /** 第几轮开始，累计成本低于完全不缓存。 */
  readonly breakEvenTurn: number;
};

export type SystemPromptBenchmarkResult = {
  readonly sections: readonly SectionRow[];
  readonly staticChars: number;
  readonly staticTokens: number;
  readonly scenarios: readonly ScenarioRow[];
  readonly staticStable: boolean;
  readonly cache: {
    readonly turns: number;
    readonly writeMultiplier: number;
    readonly readMultiplier: number;
    readonly rows: readonly CacheRow[];
  };
};

function builtOf(input: ScenarioInput): BuiltPrompt {
  return assemblePrompt({
    environment: input.environment,
    sections:
      input.instructionsChars === 0
        ? []
        : [{ name: 'instructions', text: filler(input.instructionsChars) }],
    offer: filler(input.offerChars),
  });
}

/**
 * 一次会话的输入价当量。
 *
 * 无缓存：每轮都为静态段付 1×。
 * 有缓存：第 1 轮为静态段付写价 1.25×；之后每一轮付读价 0.1×。
 * 动态段永远付 1× —— 它本来就不进缓存。
 */
export function sessionCost(
  staticTokens: number,
  dynamicTokens: number,
  turns: number,
): { readonly baseline: number; readonly cached: number; readonly breakEvenTurn: number } {
  const baselinePerTurn = staticTokens + dynamicTokens;
  const cachedFirst = staticTokens * CACHE_WRITE_MULTIPLIER + dynamicTokens;
  const cachedAfter = staticTokens * CACHE_READ_MULTIPLIER + dynamicTokens;

  let baseline = 0;
  let cached = 0;
  let breakEvenTurn = turns + 1;
  for (let turn = 1; turn <= turns; turn++) {
    baseline += baselinePerTurn;
    cached += turn === 1 ? cachedFirst : cachedAfter;
    if (turn < breakEvenTurn && cached <= baseline) breakEvenTurn = turn;
  }
  return { baseline, cached, breakEvenTurn };
}

export function runSystemPromptBenchmarks(): SystemPromptBenchmarkResult {
  const staticText = STATIC_PROMPT_SECTIONS.map((section) => section.text).join('\n\n');
  const staticChars = staticText.length;
  const staticTokens = estimateTokens(staticChars);

  const sections: SectionRow[] = STATIC_PROMPT_SECTIONS.map((section) => ({
    name: section.name,
    chars: section.text.length,
    tokens: estimateTokens(section.text.length),
  }));

  const scenarios: ScenarioRow[] = SCENARIOS.map((input) => {
    const built = builtOf(input);
    const totalTokens = estimateTokens(built.text.length);
    return {
      name: input.name,
      staticChars: built.staticText.length,
      dynamicChars: built.dynamicText.length,
      staticTokens: estimateTokens(built.staticText.length),
      dynamicTokens: estimateTokens(built.dynamicText.length),
      totalTokens,
      staticShare: totalTokens === 0 ? 0 : estimateTokens(built.staticText.length) / totalTokens,
      staticText: built.staticText,
    };
  });

  const rows: CacheRow[] = scenarios.map((row) => {
    const cost = sessionCost(row.staticTokens, row.dynamicTokens, CACHE_TURNS);
    return {
      name: row.name,
      baselineUnits: cost.baseline,
      cachedUnits: cost.cached,
      savedUnits: cost.baseline - cost.cached,
      savings: cost.baseline === 0 ? 0 : (cost.baseline - cost.cached) / cost.baseline,
      breakEvenTurn: cost.breakEvenTurn,
    };
  });

  return {
    sections,
    staticChars,
    staticTokens,
    scenarios,
    staticStable: scenarios.every((row) => row.staticText === scenarios[0]?.staticText),
    cache: {
      turns: CACHE_TURNS,
      writeMultiplier: CACHE_WRITE_MULTIPLIER,
      readMultiplier: CACHE_READ_MULTIPLIER,
      rows,
    },
  };
}

function num(count: number): string {
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatSystemPromptTables(result: SystemPromptBenchmarkResult): string {
  const sectionHead = '| 分节 | 字符 | token |\n| --- | ---: | ---: |';
  const sectionBody = result.sections.map(
    (row) => `| ${row.name} | ${num(row.chars)} | ${num(row.tokens)} |`,
  );
  const sectionTable = [
    sectionHead,
    ...sectionBody,
    `| **静态合计** | **${num(result.staticChars)}** | **${num(result.staticTokens)}** |`,
  ].join('\n');

  const splitHead =
    '| 场景 | 静态 | 动态 | 静态占比 | 合计 |\n| --- | ---: | ---: | ---: | ---: |';
  const splitBody = result.scenarios.map(
    (row) =>
      `| ${row.name} | ${num(row.staticTokens)} token | ${num(row.dynamicTokens)} token | ` +
      `${percent(row.staticShare)} | ${num(row.totalTokens)} token |`,
  );
  const splitTable = [splitHead, ...splitBody].join('\n');

  const cacheHead =
    `| 场景 | 无缓存 ${result.cache.turns} 轮 | 有缓存 ${result.cache.turns} 轮 | 省下 | 降幅 | 回本 |\n` +
    '| --- | ---: | ---: | ---: | ---: | ---: |';
  const cacheBody = result.cache.rows.map(
    (row) =>
      `| ${row.name} | ${num(row.baselineUnits)} | ${num(row.cachedUnits)} | ` +
      `${num(row.savedUnits)} | ${percent(row.savings)} | 第 ${row.breakEvenTurn} 轮 |`,
  );
  const cacheTable = [cacheHead, ...cacheBody].join('\n');

  return [
    '# 系统提示 benchmark\n',
    '## 静态分节（每次请求都带）',
    sectionTable,
    '\n## 静态/动态拆分（三个项目）',
    splitTable,
    `\n## ${result.cache.turns} 轮会话的缓存账（写 ${result.cache.writeMultiplier}× / 读 ${result.cache.readMultiplier}×）`,
    cacheTable,
  ].join('\n');
}

function main(): void {
  const result = runSystemPromptBenchmarks();
  console.log(formatSystemPromptTables(result));
  console.log(
    '\n口径：token = `ceil(chars/4)` 估算；缓存价格按输入 token 价折算（写 1.25×、读 0.1×，' +
      '5 分钟 TTL）；只量系统提示，工具清单也在同一条缓存前缀上，只会让收益更大；' +
      '假设每轮都命中 —— 这是上限，真实命中还受 TTL、请求间隔与端点最小可缓存长度影响。',
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
