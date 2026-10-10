import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isSupported, parseRule, type Behavior, type Rule } from '../contract/policy';

/**
 * 权限设置的五个来源，低 → 高。数组顺序就是 `/permissions` 的输出顺序。
 *
 * 这一层**刻意没有环境变量来源**：`config.json` 有，是因为"别把 key 写进文件"
 * 是真需求；权限不一样 —— 一个环境变量就能改掉权限，等于在规则引擎上开了个后门。
 * 托管策略必须来自文件。见设计 §4.4。
 */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const;
export type SettingsSource = (typeof SETTINGS_SOURCES)[number];

export type SourceInfo = {
  readonly source: SettingsSource;
  /** 这一层实际读的路径。`flag` 没给 `--settings=` 时是 undefined。 */
  readonly path: string | undefined;
  readonly state: 'missing' | 'ok' | 'broken';
  /** `state === 'broken'` 时的原因，直接给人看。 */
  readonly error?: string;
  readonly counts: { allow: number; ask: number; deny: number };
  /** 逐条规则的问题（含原文与原因）。有问题不等于整个文件坏掉。 */
  readonly problems: readonly string[];
  /** 这一层真正收下的规则。/permissions 要用它标出每条规则来自哪一层。 */
  readonly rules: readonly Rule[];
};

export type ResolvedPolicy = {
  readonly sources: readonly SourceInfo[];
  /** **只**来自 policy 源。给 sec-default。 */
  readonly policyRules: readonly Rule[];
  /** 其余四源的并集。给 permissions。 */
  readonly personalRules: readonly Rule[];
};

/**
 * 读一个文本文件。两种失败必须分得开：
 * - 返回 `undefined` = 文件**不存在**（正常，绝大多数机器没有托管文件）
 * - **抛** = 文件存在但读不了（权限、是个目录、编码）—— 这一条是设计里唯一的 fail-open，要吼
 */
export type TextReader = (path: string) => Promise<string | undefined>;

export const defaultTextReader: TextReader = async (path) => {
  if (!existsSync(path)) return undefined;
  // 目录也会过 existsSync，于是 readFile 抛 EISDIR —— 正好落进"存在但读不了"。
  return readFile(path, 'utf8');
};

/** 托管策略文件的位置。`env` 与 `platform` 可注入，测试才不必碰系统目录。 */
export function defaultManagedPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    const base = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
    return join(base, 'DeepCode', 'managed-settings.json');
  }
  return '/etc/deepcode/managed-settings.json';
}

export type ResolvePolicyDeps = {
  readonly home: string;
  readonly root: string;
  /** `--settings=<路径>` 的取值。相对路径按 cwd 解析，与 `--resume=<id>` 同一个规矩。 */
  readonly settingsPath?: string;
  /** 覆盖托管文件位置（`DEEPCODE_MANAGED_SETTINGS` 从这进）。 */
  readonly managedPath?: string;
  readonly warn?: (line: string) => void;
  readonly readText?: TextReader;
};

const EMPTY_COUNTS = { allow: 0, ask: 0, deny: 0 } as const;

function label(source: SettingsSource): string {
  return source === 'policy' ? '⚠️ 托管策略' : `[权限] ${source} 设置`;
}

type Layer = { readonly source: SettingsSource; readonly path: string | undefined };

export async function resolvePolicy(deps: ResolvePolicyDeps): Promise<ResolvedPolicy> {
  const warn = deps.warn ?? (() => {});
  const readText = deps.readText ?? defaultTextReader;

  const layers: readonly Layer[] = [
    { source: 'user', path: join(deps.home, '.deepcode', 'settings.json') },
    { source: 'project', path: join(deps.root, '.deepcode', 'settings.json') },
    { source: 'local', path: join(deps.root, '.deepcode', 'settings.local.json') },
    {
      source: 'flag',
      path: deps.settingsPath === undefined ? undefined : resolve(deps.settingsPath),
    },
    { source: 'policy', path: deps.managedPath ?? defaultManagedPath() },
  ];

  const sources: SourceInfo[] = [];
  const bySource = new Map<SettingsSource, readonly Rule[]>();

  for (const layer of layers) {
    const read = await readLayer(layer, deps.home, warn, readText);
    sources.push(read.info);
    bySource.set(layer.source, read.rules);
  }

  return {
    sources,
    // policy 源 vs. 其余全部 —— 在固定优先级下这是唯一承重的划分（设计 §4.3）。
    policyRules: bySource.get('policy') ?? [],
    personalRules: SETTINGS_SOURCES.filter((s) => s !== 'policy').flatMap((s) => bySource.get(s) ?? []),
  };
}

type LayerRead = { readonly info: SourceInfo; readonly rules: readonly Rule[] };

async function readLayer(
  layer: Layer,
  home: string,
  warn: (line: string) => void,
  readText: TextReader,
): Promise<LayerRead> {
  const where = layer.path;

  if (where === undefined) {
    return { info: base(layer, 'missing', undefined, [], []), rules: [] };
  }

  const broken = (error: string): LayerRead => {
    warn(`${label(layer.source)} ${where} ${error} —— 这一层按空处理。`);
    return { info: base(layer, 'broken', error, [], []), rules: [] };
  };

  let text: string | undefined;
  try {
    text = await readText(where);
  } catch (error) {
    return broken(`读不了（${error instanceof Error ? error.message : String(error)}）`);
  }
  // 不存在 = 静默为空。绝大多数机器没有托管文件，为此吼一声只会训练人无视警告。
  if (text === undefined) return { info: base(layer, 'missing', undefined, [], []), rules: [] };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return broken(`JSON 语法错（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return broken('顶层不是一个对象');
  }

  const record = data as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => key !== 'permissions');
  if (unknown.length > 0) {
    // 未知键只警告、不致命：将来加顶层键（hooks、env）时，旧版本读新文件不该整份失效。
    warn(`${label(layer.source)} ${where} 里有不认识的顶层键：${unknown.join('、')}（已忽略）。`);
  }

  const raw = record.permissions;
  if (raw === undefined) return { info: base(layer, 'ok', undefined, [], []), rules: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return broken('permissions 不是一个对象');
  }

  const perms = raw as Record<string, unknown>;
  const counts = { allow: 0, ask: 0, deny: 0 };
  const problems: string[] = [];
  const rules: Rule[] = [];

  for (const key of ['allow', 'ask', 'deny'] as const) {
    const value = perms[key];
    if (value === undefined) continue;

    if (!Array.isArray(value)) return broken(`permissions.${key} 不是数组`);

    const bad = value.findIndex((item) => typeof item !== 'string');
    // 整份文件作废，而不是只丢这一条：类型不对说明写的人以为它生效了。
    // 只丢一半的话，他会看到"文件被读进去了"，然后以为没报错的那几行在管事。
    if (bad !== -1) return broken(`permissions.${key}[${bad}] 不是字符串`);

    for (const text_ of value as string[]) {
      const parsed = parseRule(text_, key, home);
      if ('error' in parsed) {
        // 唯一一处"坏了就等于没写"：方向是**不收紧**，所以必须吼，不能安静。
        problems.push(`${key}: ${JSON.stringify(text_)} —— ${parsed.error}`);
        continue;
      }
      if (!isSupported(parsed)) {
        problems.push(
          `${key}: ${JSON.stringify(text_)} —— ${parsed.tool} 的参数匹配不支持，这条永远不会命中`,
        );
        continue;
      }
      rules.push(parsed);
      counts[key] += 1;
    }
  }

  for (const problem of problems) {
    warn(`${label(layer.source)} ${where} 这条不生效 —— ${problem}`);
  }

  return { info: base(layer, 'ok', undefined, problems, rules), rules };
}

function base(
  layer: Layer,
  state: SourceInfo['state'],
  error: string | undefined,
  problems: readonly string[],
  rules: readonly Rule[],
): SourceInfo {
  const counts: Record<Behavior, number> = { ...EMPTY_COUNTS };
  for (const rule of rules) counts[rule.decision] += 1;
  return { source: layer.source, path: layer.path, state, ...(error === undefined ? {} : { error }), counts, problems, rules };
}
