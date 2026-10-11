import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isSupported, parseRule, type Behavior, type Rule } from '../contract/policy';
import { isPluginName } from '../contract/plugin-manifest';

/**
 * 权限设置的五个来源，低 → 高。数组顺序就是 `/permissions` 的输出顺序。
 *
 * 这一层**刻意没有环境变量来源**：`config.json` 有，是因为"别把 key 写进文件"
 * 是真需求；权限不一样 —— 一个环境变量就能改掉权限，等于在规则引擎上开了个后门。
 * 托管策略必须来自文件。见设计 §4.4。
 */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const;
export type SettingsSource = (typeof SETTINGS_SOURCES)[number];

/** 一条插件规则：名字 + 它来自哪一层。`/permissions` 要把来源标出来。 */
export type PluginRule = {
  readonly name: string;
  readonly source: SettingsSource;
};

/** 一层设置里收下的插件名字。 */
export type PluginsLayer = {
  readonly enable: readonly string[];
  readonly deny: readonly string[];
};

const EMPTY_PLUGINS: PluginsLayer = { enable: [], deny: [] };

/**
 * `plugins.enable` 认哪几层。
 *
 * 少了 `user`：用户级目录本来就自动装载，写 enable 是没用的。
 * 少了 `policy`：托管策略写 enable 会变成"组织替你打开一个插件" ——
 * 托管策略只该能收紧，不该能替你打开东西（设计 §3）。
 */
export const PLUGIN_ENABLE_SOURCES = ['project', 'local', 'flag'] as const;

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
  /** 这一层收下的插件名字。`/permissions` 按层标出来。 */
  readonly plugins: PluginsLayer;
};

export type ResolvedPolicy = {
  readonly sources: readonly SourceInfo[];
  /** **只**来自 policy 源。给 sec-default。 */
  readonly policyRules: readonly Rule[];
  /** 其余四源的并集。给 permissions。 */
  readonly personalRules: readonly Rule[];
  /**
   * 五层合并后的插件名单，带来源。
   *
   * `enable` 只来自 project / local / flag；`deny` 来自五层并集 ——
   * 它只能关掉东西，永远不可能放宽，于是"谁写的"对结果毫无影响。
   */
  readonly plugins: { readonly enable: readonly PluginRule[]; readonly deny: readonly PluginRule[] };
};

/**
 * 读一个文本文件。两种失败必须分得开：
 * - 返回 `undefined` = 文件**不存在**（正常，绝大多数机器没有托管文件）
 * - **抛** = 文件存在但读不了（权限、是个目录、编码）—— 这一条是设计里唯一的 fail-open，要吼
 */
export type TextReader = (path: string) => Promise<string | undefined>;

export const defaultTextReader: TextReader = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // 只有"不存在"算正常（绝大多数机器没有托管文件）。
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    // 其余一律抛出去。
    // ⚠️ 这里曾经是 `if (!existsSync(path)) return undefined` —— 一个把自己的承诺反过来的
    // 短路：existsSync 在"文件在、但 stat 过来被拒"时也返回 false，于是 EACCES 这类
    // "存在但读不了"被伪装成"没这个文件"，整层静默作废。而这是托管策略所在的层 ——
    // 恰恰是设计里最不能安静的那一层。
    throw error;
  }
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
  const pluginsBySource = new Map<SettingsSource, PluginsLayer>();

  for (const layer of layers) {
    const read = await readLayer(layer, deps.home, warn, readText);
    sources.push(read.info);
    bySource.set(layer.source, read.rules);
    pluginsBySource.set(layer.source, read.plugins);
  }

  const withSource = (source: SettingsSource, names: readonly string[]): readonly PluginRule[] =>
    names.map((name) => ({ name, source }));

  return {
    sources,
    // policy 源 vs. 其余全部 —— 在固定优先级下这是唯一承重的划分（设计 §4.3）。
    policyRules: bySource.get('policy') ?? [],
    personalRules: SETTINGS_SOURCES.filter((s) => s !== 'policy').flatMap((s) => bySource.get(s) ?? []),
    plugins: {
      enable: dedupe(
        PLUGIN_ENABLE_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.enable ?? []),
        ),
      ),
      deny: dedupe(
        SETTINGS_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.deny ?? []),
        ),
      ),
    },
  };
}

/** 按名字去重，保留先出现的那个来源。合并语义是并集，留谁都不改行为，只影响 /permissions 的显示。 */
function dedupe(rules: readonly PluginRule[]): readonly PluginRule[] {
  const seen = new Set<string>();
  const out: PluginRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    out.push(rule);
  }
  return out;
}

type LayerRead = {
  readonly info: SourceInfo;
  readonly rules: readonly Rule[];
  readonly plugins: PluginsLayer;
};

async function readLayer(
  layer: Layer,
  home: string,
  warn: (line: string) => void,
  readText: TextReader,
): Promise<LayerRead> {
  const where = layer.path;

  if (where === undefined) {
    return { info: base(layer, 'missing', undefined, [], []), rules: [], plugins: EMPTY_PLUGINS };
  }

  const broken = (error: string): LayerRead => {
    warn(`${label(layer.source)} ${where} ${error} —— 这一层按空处理。`);
    return { info: base(layer, 'broken', error, [], []), rules: [], plugins: EMPTY_PLUGINS };
  };

  let text: string | undefined;
  try {
    text = await readText(where);
  } catch (error) {
    return broken(`读不了（${error instanceof Error ? error.message : String(error)}）`);
  }
  // 不存在 = 静默为空。绝大多数机器没有托管文件，为此吼一声只会训练人无视警告。
  if (text === undefined) {
    return { info: base(layer, 'missing', undefined, [], []), rules: [], plugins: EMPTY_PLUGINS };
  }

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

  const unknown = Object.keys(record).filter((key) => key !== 'permissions' && key !== 'plugins');
  if (unknown.length > 0) {
    // 未知键只警告、不致命：将来加顶层键（hooks、env）时，旧版本读新文件不该整份失效。
    warn(`${label(layer.source)} ${where} 里有不认识的顶层键：${unknown.join('、')}（已忽略）。`);
  }

  const raw = record.permissions;

  // ⚠️ plugins 必须在 permissions 的早期 return **之前**解析。写成"先 permissions、
  // 没有就 return"的话，一份只有 plugins 段（没有 permissions）的设置会把名单丢掉 ——
  // 而那正是最典型的一份"我只想启个插件"的设置文件。
  const plugins = readPlugins(record.plugins, layer, where, warn);
  if ('broken' in plugins) return broken(plugins.broken);

  if (raw === undefined) {
    return {
      info: base(layer, 'ok', undefined, [], [], plugins.value),
      rules: [],
      plugins: plugins.value,
    };
  }
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

  return {
    info: base(layer, 'ok', undefined, problems, rules, plugins.value),
    rules,
    plugins: plugins.value,
  };
}

/**
 * 解析一层的 `plugins` 段。
 *
 * 形状错的处置与 `permissions` 完全一致：**整份废掉这一层**，不是丢掉坏的那一项 ——
 * 类型不对说明写的人以为它生效了，只丢一半的话他会看到"文件被读进去了"。
 * 名字格式不对则是单条不生效（方向是不收紧），但必须吼。
 */
function readPlugins(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): { readonly value: PluginsLayer } | { readonly broken: string } {
  if (value === undefined) return { value: EMPTY_PLUGINS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { broken: 'plugins 不是一个对象' };
  }

  const record = value as Record<string, unknown>;
  const out: { enable: string[]; deny: string[] } = { enable: [], deny: [] };

  for (const key of ['enable', 'deny'] as const) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { broken: `plugins.${key} 不是数组` };

    const bad = list.findIndex((item) => typeof item !== 'string');
    if (bad !== -1) return { broken: `plugins.${key}[${bad}] 不是字符串` };

    for (const name of list as string[]) {
      if (!isPluginName(name)) {
        warn(
          `${label(layer.source)} ${where} 这条不生效 —— plugins.${key}: ${JSON.stringify(name)} 不是 kebab-case 的插件名。`,
        );
        continue;
      }
      if (key === 'enable' && !PLUGIN_ENABLE_SOURCES.includes(layer.source as never)) {
        warn(
          layer.source === 'user'
            ? `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认 user 层（用户级插件本来就自动装载）。`
            : `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认托管层（托管策略只该能收紧，不该替你打开一个插件）。`,
        );
        continue;
      }
      out[key].push(name);
    }
  }

  const unknown = Object.keys(record).filter((key) => key !== 'enable' && key !== 'deny');
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 plugins 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return { value: out };
}

function base(
  layer: Layer,
  state: SourceInfo['state'],
  error: string | undefined,
  problems: readonly string[],
  rules: readonly Rule[],
  plugins: PluginsLayer = EMPTY_PLUGINS,
): SourceInfo {
  const counts: Record<Behavior, number> = { ...EMPTY_COUNTS };
  for (const rule of rules) counts[rule.decision] += 1;
  return { source: layer.source, path: layer.path, state, ...(error === undefined ? {} : { error }), counts, problems, rules, plugins };
}
