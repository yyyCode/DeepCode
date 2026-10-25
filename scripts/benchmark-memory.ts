import { pathToFileURL } from 'node:url';
import type { MemoryHeader } from '../src/contract/memory';
import { estimateTokens } from '../src/core/loop';
import {
  parseMemoryHeader,
  renderMemoryFile,
  renderMemoryIndex,
  renderMemoryPrompt,
  selectMemories,
  type MemoryDraft,
} from '../src/core/memory';

/**
 * 记忆系统的 benchmark（P12 §8）。
 *
 * 量的是**一次请求里记忆占多少 token**：
 * - 基线 = 把全部记忆正文一股脑塞进提示（没有索引、没有召回，最朴素的「记忆」实现）；
 * - 记忆 = 索引常驻 + 只注入命中的那几条（`renderMemoryPrompt` 的拼法）。
 *
 * ⚠️ 三条口径：
 * 1. token 数沿用 `estimateTokens` = `ceil(chars/4)` 的**估算**，中英混排会失真；
 *    两边同一条尺子，比值有意义，绝对值没有。
 * 2. 召回默认走**关键词**（`selectMemories`），不调用模型 —— 这个数在离线、零 API
 *    的前提下可重复。配了 `memory.recallModel` 的召回质量不在这里量。
 * 3. 命中率只看「期望的那条有没有进前 maxRecall」，不看排序 —— 关键词召回排序是
 *    确定性的（分高者先、同分新者先），排序好坏不是这一阶段的承诺。
 *
 * 跑法：`pnpm bench:memory`。测试里 import `runMemoryBenchmarks()` 断言之。
 */

const NOW = Date.parse('2026-10-20T00:00:00Z');
const MAX_RECALL = 5;

type Topic = {
  readonly name: string;
  readonly type: MemoryDraft['type'];
  readonly description: string;
  /** 正文的长度（字符）。内容本身不重要，重要的是「真实记忆不是一句话」。 */
  readonly chars: number;
  readonly queries: readonly string[];
};

const BODY = (name: string, chars: number): string =>
  `关于 ${name} 的结论与上下文。` + '这是记忆正文，记录当时为什么这样决定、踩过什么坑。'.repeat(
    Math.ceil(chars / 26),
  );

function draftOf(topic: Topic): MemoryDraft {
  if (topic.type === 'feedback') {
    return {
      name: topic.name,
      type: topic.type,
      description: topic.description,
      content:
        `${BODY(topic.name, topic.chars)}\n\n**Why:** 上一版没有这条约束，出过事故。\n\n` +
        '**How to apply:** 动手前先对照这条检查。',
    };
  }
  return {
    name: topic.name,
    type: topic.type,
    description: topic.description,
    content: BODY(topic.name, topic.chars),
  };
}

function headerOf(draft: MemoryDraft, modified: number): MemoryHeader {
  const text = renderMemoryFile(draft, modified);
  const parsed = parseMemoryHeader(`${draft.name}.md`, text, modified);
  if (parsed.header === undefined) {
    throw new Error(`benchmark 造的记忆解析失败：${draft.name} ${parsed.error ?? ''}`);
  }
  return parsed.header;
}

const ZH_TOPICS: readonly Topic[] = [
  { name: 'db-isolation', type: 'feedback', description: '集成测试的数据库隔离策略', chars: 900, queries: ['数据库隔离怎么做'] },
  { name: 'prettier', type: 'feedback', description: '格式化统一用 prettier', chars: 800, queries: ['格式化用 prettier 吗'] },
  { name: 'release-date', type: 'project', description: '版本发布必须在周五之前完成', chars: 700, queries: ['版本发布时间'] },
  { name: 'grafana', type: 'reference', description: '监控看板在 grafana 的 deepcode 面板', chars: 600, queries: ['监控看板在哪'] },
  { name: 'no-barrel', type: 'feedback', description: '不要用 barrel 文件聚合导出', chars: 850, queries: ['能不能用 barrel 文件'] },
  { name: 'pnpm-only', type: 'feedback', description: '依赖安装只用 pnpm 不用 npm', chars: 780, queries: ['依赖安装用 pnpm 还是 npm'] },
  { name: 'error-shape', type: 'project', description: '错误统一是 {ok,error} 形状', chars: 950, queries: ['错误返回什么形状'] },
  { name: 'typescript-strict', type: 'user', description: '用户偏好 TypeScript strict 全开', chars: 640, queries: ['typescript strict 要不要开'] },
  { name: 'e2e-slow', type: 'project', description: '端到端测试很慢，跑之前先问', chars: 720, queries: ['端到端测试很慢怎么办'] },
  { name: 'changelog', type: 'reference', description: '变更记录写在 CHANGELOG 的对应阶段', chars: 680, queries: ['变更记录写哪里'] },
  { name: 'sqlite-wal', type: 'feedback', description: 'SQLite 必须开启 WAL 模式', chars: 740, queries: ['sqlite 要开 WAL 吗'] },
  { name: 'ci-windows', type: 'project', description: 'CI 只在 Windows 上跑一次', chars: 660, queries: ['CI 跑 windows 吗'] },
  { name: 'env-file', type: 'reference', description: '环境变量样例在 .env.example', chars: 620, queries: ['环境变量样例在哪'] },
  { name: 'commit-style', type: 'feedback', description: '提交信息用中文动词开头', chars: 700, queries: ['提交信息怎么写'] },
  { name: 'api-version', type: 'project', description: '接口版本号走路径前缀 /v2', chars: 760, queries: ['接口版本号怎么放'] },
  { name: 'mock-ban', type: 'feedback', description: '测试禁止 mock 时间与随机数', chars: 820, queries: ['测试可以 mock 时间吗'] },
  { name: 'bundle-size', type: 'project', description: '前端包体积上限是 200KB', chars: 690, queries: ['前端包体积上限'] },
  { name: 'log-format', type: 'feedback', description: '日志必须是单行 JSON', chars: 800, queries: ['日志格式要求'] },
  { name: 'retry-policy', type: 'project', description: '网络请求最多重试三次', chars: 710, queries: ['网络请求重试几次'] },
  { name: 'docs-lean', type: 'feedback', description: '文档只讲怎么用不讲实现', chars: 860, queries: ['文档该写什么'] },
  { name: 'cache-key', type: 'project', description: '缓存键统一带项目前缀', chars: 650, queries: ['缓存键怎么起'] },
  { name: 'review-batch', type: 'feedback', description: '验收批量做不要逐个任务卡', chars: 780, queries: ['验收要逐个做吗'] },
  { name: 'go-vet', type: 'reference', description: 'Go 服务在 go-vet 看板', chars: 600, queries: ['go 服务看板在哪'] },
  { name: 'date-absolute', type: 'feedback', description: '日期一律写绝对日期', chars: 720, queries: ['日期怎么写'] },
  { name: 'hook-budget', type: 'project', description: '钩子时间预算是十秒', chars: 680, queries: ['钩子时间预算多少'] },
  { name: 'fail-open', type: 'project', description: '辅助功能一律 fail-open', chars: 840, queries: ['辅助功能失败怎么办'] },
  { name: 'sharding', type: 'reference', description: '分片规则文档在 docs/sharding', chars: 630, queries: ['分片规则文档在哪'] },
  { name: 'icon-style', type: 'feedback', description: '图标统一用线性风格', chars: 700, queries: ['图标用什么风格'] },
  { name: 'deepseek-key', type: 'reference', description: 'DeepSeek 的 key 在配置文件的 apiKey', chars: 640, queries: ['deepseek 的 key 在哪'] },
  { name: 'no-global-state', type: 'feedback', description: '不要引入全局可变状态', chars: 900, queries: ['能不能有全局可变状态'] },
];

const EN_TOPICS: readonly Topic[] = [
  { name: 'esm-only', type: 'feedback', description: 'package is ESM only; never add CJS output', chars: 820, queries: ['should we output CJS build'] },
  { name: 'lockfile', type: 'project', description: 'lockfile changes require a dedicated PR', chars: 700, queries: ['how to change the lockfile'] },
  { name: 'node-version', type: 'project', description: 'Node baseline is 20 LTS', chars: 660, queries: ['which Node version do we support'] },
  { name: 'sentry', type: 'reference', description: 'production errors land in sentry project deepcode', chars: 620, queries: ['where do production errors go'] },
  { name: 'feature-flag', type: 'reference', description: 'feature flags live in launchdarkly', chars: 640, queries: ['where are feature flags'] },
  { name: 'timeout', type: 'project', description: 'provider calls abort after 8s timeout', chars: 720, queries: ['what is the provider timeout'] },
  { name: 'coverage', type: 'feedback', description: 'never lower coverage below 80 percent', chars: 780, queries: ['what is the coverage floor'] },
  { name: 'changelog-en', type: 'reference', description: 'release notes are generated from changelog', chars: 680, queries: ['where are release notes generated'] },
  { name: 'db-migration', type: 'project', description: 'migrations run before deploy, never during', chars: 760, queries: ['when do migrations run'] },
  { name: 'no-any', type: 'feedback', description: 'never use any; prefer unknown', chars: 800, queries: ['is any allowed in typescript'] },
];

const ALL_TOPICS: readonly Topic[] = [...ZH_TOPICS, ...EN_TOPICS];

/** 250 条：同一个主题反复被记下来（真实记忆目录最常见的膨胀方式）。 */
const BIG_TOPICS: readonly Topic[] = Array.from({ length: 250 }, (_, index) => {
  const base = ALL_TOPICS[index % ALL_TOPICS.length]!;
  return { ...base, name: `${base.name}-${index}` };
});

export type RecallRow = {
  readonly query: string;
  readonly expected: string;
  readonly hit: boolean;
  /** 关键词召回给出的前 N 条（名字）。 */
  readonly picked: readonly string[];
};

export type StrategyTokens = {
  /** 一次请求里全部记忆都进提示。 */
  readonly baselineTokens: number;
  /** 索引 + 召回正文。 */
  readonly tokens: number;
  readonly indexTokens: number;
  readonly recallTokens: number;
};

export type BenchmarkRow = {
  readonly scenario: string;
  readonly memories: number;
  readonly queries: number;
  readonly hits: number;
  readonly baseline: StrategyTokens;
  readonly indexed: StrategyTokens;
  /** 索引是否被行数上限截断（大目录场景才有意义）。 */
  readonly indexTruncated: boolean;
  readonly indexLines: number;
};

function headers(topics: readonly Topic[]): readonly MemoryHeader[] {
  return topics.map((topic, index) => headerOf(draftOf(topic), NOW - index * 3_600_000));
}

function measure(
  all: readonly MemoryHeader[],
  bodies: readonly string[],
  query: string,
): { readonly baseline: StrategyTokens; readonly indexed: StrategyTokens; readonly picked: readonly string[] } {
  const index = renderMemoryIndex(all);
  const picked = selectMemories(all, query, MAX_RECALL);
  const byName = new Map(all.map((header, position) => [header.name, bodies[position] ?? '']));
  const recalled = picked.map((header) => ({ header, body: byName.get(header.name) ?? '' }));
  const prompt = renderMemoryPrompt({
    indexText: index.text,
    total: all.length,
    broken: 0,
    recalled,
    now: NOW,
    recallMode: 'keyword',
  });

  const baselineChars = bodies.reduce((total, body) => total + body.length, 0);
  return {
    baseline: {
      baselineTokens: estimateTokens(baselineChars),
      tokens: estimateTokens(baselineChars),
      indexTokens: 0,
      recallTokens: 0,
    },
    indexed: {
      baselineTokens: estimateTokens(baselineChars),
      tokens: estimateTokens(prompt.length),
      indexTokens: estimateTokens(index.text.length),
      recallTokens: estimateTokens(
        recalled.reduce((total, item) => total + item.body.length, 0),
      ),
    },
    picked: picked.map((header) => header.name),
  };
}

export type MemoryBenchmarkResult = {
  readonly rows: readonly BenchmarkRow[];
  readonly recallRows: readonly RecallRow[];
};

function scenario(
  name: string,
  topics: readonly Topic[],
  queries: readonly string[],
): { readonly row: BenchmarkRow; readonly recallRows: readonly RecallRow[] } {
  const all = headers(topics);
  const bodies = topics.map((topic) => draftOf(topic).content);
  const results = queries.map((query) => {
    const expected = topics.find((topic) => topic.queries.includes(query))?.name ?? '';
    return { query, expected, ...measure(all, bodies, query) };
  });
  const hits = results.filter((result) => result.picked.includes(result.expected)).length;
  const index = renderMemoryIndex(all);
  const first = results[0]!;

  return {
    row: {
      scenario: name,
      memories: all.length,
      queries: queries.length,
      hits,
      baseline: first.baseline,
      indexed: {
        ...first.indexed,
        // 索引只有一份，场景里各次查询都带着它；用第一次的口径代表这一场景。
        indexTokens: estimateTokens(index.text.length),
      },
      indexTruncated: index.truncated,
      indexLines: index.lines,
    },
    recallRows: results.map((result) => ({
      query: result.query,
      expected: result.expected,
      hit: result.picked.includes(result.expected),
      picked: result.picked,
    })),
  };
}

export async function runMemoryBenchmarks(): Promise<MemoryBenchmarkResult> {
  const recallQueries = ZH_TOPICS.slice(0, 8)
    .concat(EN_TOPICS.slice(0, 4))
    .flatMap((topic) => topic.queries);
  const mixedQueries = ZH_TOPICS.slice(0, 4)
    .concat(EN_TOPICS.slice(0, 4))
    .flatMap((topic) => topic.queries);

  const small = scenario('recall-40', ALL_TOPICS, recallQueries);
  const big = scenario('large-index', BIG_TOPICS, recallQueries);
  const mixed = scenario('mixed-language', ALL_TOPICS, mixedQueries);

  return { rows: [small.row, big.row, mixed.row], recallRows: small.recallRows };
}

function num(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function percent(baseline: number, indexed: number): string {
  if (baseline === 0) return '—';
  const drop = ((baseline - indexed) / baseline) * 100;
  return `${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(1)}%`;
}

export function formatMemoryTable(result: MemoryBenchmarkResult): string {
  const head =
    '| 场景 | 记忆条数 | 基线（全量正文） | 记忆（索引 + 召回） | 降幅 | 命中 | 索引行数 |\n' +
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
  const body = result.rows.map(
    (row) =>
      `| ${row.scenario} | ${row.memories} | ${num(row.baseline.baselineTokens)} token | ` +
      `${num(row.indexed.tokens)} token（索引 ${num(row.indexed.indexTokens)} + 召回 ${num(row.indexed.recallTokens)}） | ` +
      `${percent(row.baseline.baselineTokens, row.indexed.tokens)} | ${row.hits}/${row.queries} | ` +
      `${row.indexLines}${row.indexTruncated ? '（已截断）' : ''} |`,
  );
  return [head, ...body].join('\n');
}

async function main(): Promise<void> {
  const result = await runMemoryBenchmarks();
  console.log('# 记忆系统 benchmark\n');
  console.log(formatMemoryTable(result));
  console.log(
    '\n口径：token = `ceil(chars/4)` 估算；召回走关键词（离线、零 API）；' +
      '命中 = 期望的那条进了前 5，不看排序。',
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
