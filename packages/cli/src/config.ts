import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROVIDER_KINDS, isProviderKind } from '@deepcode/providers';
import type { ProviderKind } from '@deepcode/contract/model-provider';
import type { GatewayConfig } from './settings';

/** 配置文件里认识的字段。写错的字段名会被点名，不会静默失效。 */
export type CliConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  debug?: boolean;
  provider?: ProviderKind;
};

const FIELD_TYPES: Record<keyof CliConfig, 'string' | 'boolean'> = {
  apiKey: 'string',
  model: 'string',
  baseUrl: 'string',
  debug: 'boolean',
  provider: 'string',
};

/** 没有任何配置时用的模型。写在这里是为了让"默认值是什么"只有一处。 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * 每个字段"谁都没配"时的生效值。只有这两个有默认 —— 其余没配就是没配，
 * `ResolvedSettings` 里也相应地是 `undefined`。
 */
const DEFAULTS: Partial<Record<keyof CliConfig, string>> = {
  model: DEFAULT_MODEL,
  provider: 'anthropic',
  debug: 'false',
};

/**
 * `config.set` 能写的键。**只有 `model`**（设计 §5.2）。
 *
 * `apiKey` 是凭据，`baseUrl` 决定你的请求发去哪 —— 这两个由一条命令替你写，
 * 是可以安静地把流量端掉的。想让它们改，自己开文件看一眼再改。
 */
export const WRITABLE_KEYS: readonly (keyof CliConfig)[] = ['model'];

/**
 * 这些前缀下的键永远拒绝，且要说清为什么 —— 它们属于 settings，不属于 config。
 *
 * `permissions` / `sandbox` / `plugins` 都直接决定"什么动作会被执行"。
 * 一个能在运行时改权限来源的入口，就是第二个自动放行开关（见 README 那句原话）。
 *
 * `gateway`（P5d）是同一族里最晚进来的一个：它不决定"什么动作会被执行"，而是决定
 * **这些动作发去哪**。它同样只有托管层能写，所以由命令行去改它既不生效、还会给出
 * 一句"不认识的字段"这种答错问题的错。
 */
export const FORBIDDEN_PREFIXES = ['permissions', 'sandbox', 'plugins', 'gateway'] as const;
export type ResolvedSettings = {
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  debug: boolean;
  provider: ProviderKind;
};

/** 每个字段认哪些环境变量名，按优先级排列。表只写一遍，取值和告警都从这里来。 */
const ENV_NAMES: ReadonlyArray<{
  field: keyof CliConfig;
  names: readonly string[];
  /** 值本身是凭据，告警里只敢说"不一致"，不能把内容打出来。 */
  secret?: boolean;
}> = [
  // 两套名字并存，因为兼容端点（DeepSeek 等）配的是 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
  // 这一组，而 Anthropic 官方 SDK 自己用 ANTHROPIC_API_KEY / DEEPCODE_MODEL。
  // 认证头不用跟着变：x-api-key 与 Authorization: Bearer 两边都收（实测过）。
  { field: 'apiKey', names: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], secret: true },
  { field: 'model', names: ['DEEPCODE_MODEL', 'ANTHROPIC_MODEL'] },
  { field: 'baseUrl', names: ['ANTHROPIC_BASE_URL'] },
  { field: 'provider', names: ['DEEPCODE_PROVIDER'] },
];

/**
 * `debug` 是唯一不进 `ENV_NAMES` 的字段：它是布尔，而那张表的语义是"取到字符串值赋给字段"，
 * 照走会把字符串 `"1"` 赋给一个 boolean。所以这里单独看有没有设。
 *
 * 抽成一个函数只为一件事：`resolveSettings` 与 `describeConfig` 必须对"谁算配了 debug"
 * 给出同一个答案，两处各写一遍 `Boolean(...)` 迟早会走岔。
 */
function debugFromEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(env.DEEPCODE_DEBUG);
}

/**
 * 环境变量与配置文件合到一处，优先级 `环境变量 > 配置文件`。
 *
 * 抽成纯函数而不是留在 main.ts 里，是因为"谁盖谁"这条规则正是最该被钉住的部分，
 * 而 main.ts 是个一跑就建 readline、连网的脚本，测不动。
 *
 * 环境变量顶掉配置文件时**要说一声**，但只在两边值确实不同的时候说。
 * 静默生效是最坏的：机器上残留的一个 `ANTHROPIC_BASE_URL`（比如以前配过某个中转站）
 * 会悄悄把你的请求发去别处，你只会收到一堆 401，完全看不出配置其实没生效。
 * 而两边值相同时（这是常态 —— 同一把 key 既在环境里也在配置里）没什么可提醒的，
 * 每次启动都吼一遍只会训练用户忽略它。
 *
 * 空字符串当作没给：`setx VAR ""` 留下的是空值而不是删除，若照收就会凭空顶掉配置文件。
 */
export function resolveSettings(
  env: Record<string, string | undefined>,
  config: CliConfig,
  warn: (line: string) => void = () => {},
): ResolvedSettings {
  const out: ResolvedSettings = {
    apiKey: undefined,
    model: DEFAULT_MODEL,
    baseUrl: undefined,
    debug: debugFromEnv(env) || config.debug === true,
    provider: 'anthropic',
  };

  for (const { field, names, secret } of ENV_NAMES) {
    const name = names.find((candidate) => (env[candidate] ?? '') !== '');
    const fromEnv = name === undefined ? undefined : env[name];
    const fromConfig = config[field];

    if (fromEnv === undefined) {
      if (fromConfig !== undefined) (out as Record<string, unknown>)[field] = fromConfig;
      continue;
    }

    if (fromConfig !== undefined && fromConfig !== fromEnv) {
      const shown = secret ? '两处内容不一致' : `环境给的是 ${fromEnv}，配置文件里是 ${fromConfig}`;
      warn(
        `环境变量 ${name} 顶掉了配置文件里的 ${field}（${shown}），配置文件这一项被忽略。` +
          `想让它生效，先清掉这个环境变量。`,
      );
    }
    (out as Record<string, unknown>)[field] = fromEnv;
  }

  // 校验放在最后：它是"环境变量 > 项目级 > 用户级"三口合流之后的唯一出口，
  // 放三处不如放一处。写错了直接抛 —— 静默退回 anthropic 会让用户拿着 openai 的端点
  // 发 anthropic 的请求，然后收到一个完全看不懂的 404。
  if (!isProviderKind(out.provider)) {
    throw new Error(
      `provider 只能是 ${PROVIDER_KINDS.join(' / ')}，现在给的是 "${String(out.provider)}"。` +
        '（来自环境变量 DEEPCODE_PROVIDER 或配置文件里的 provider）',
    );
  }
  assertModelShape(out.model);
  return out;
}

/**
 * 启动期只能查**形状**，查不了存在性 —— 那只有端点知道，而兼容端点的模型清单各不相同，
 * 硬编一张表只会拦住合法模型。存在性那一半交给 providers/http.ts 把 404 翻成人话（设计 §6）。
 */
function assertModelShape(model: string): void {
  if (model === '') {
    throw new Error('模型 id 是空的：检查配置文件里的 model，或环境变量 DEEPCODE_MODEL / ANTHROPIC_MODEL。');
  }
  if (/\s/.test(model)) {
    throw new Error(`模型 id ${JSON.stringify(model)} 里有空白字符，这不是一个合法的模型 id。`);
  }
}

export type LoadConfigDeps = {
  /** 用户主目录：用户级配置在 `<home>/.deepcode/config.json`。 */
  home: string;
  /** 会话根目录（= cwd）：项目级配置在 `<root>/.deepcode/config.json`。 */
  root: string;
  /** 未知字段、覆盖关系、项目级 apiKey 的告警出口。默认写 stderr。 */
  warn?: (line: string) => void;
  /** 测试替身：返回 undefined 表示文件不存在。默认真读磁盘。 */
  readText?: (path: string) => Promise<string | undefined>;
};

/**
 * 两层配置文件，就近覆盖：用户级打底，项目级盖在它上面。
 * 调用方之后再让 `process.env` 覆盖两者 —— 优先级 `环境变量 > 项目级 > 用户级`。
 *
 * 文件不存在是常态（安静跳过）；文件存在却读不动或解析不了则**抛**，并带上路径。
 * 静默退回默认值是最坏的一种坏：用户以为配置生效了，实际在用默认值，
 * 而且没有任何地方会告诉他 —— 和之前修掉的"Grep 静默跳过点文件"是同一类问题。
 */
export async function loadConfig(deps: LoadConfigDeps): Promise<CliConfig> {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const readText = deps.readText ?? readTextFile;

  const layers: ReadonlyArray<{ path: string; label: string }> = [
    { path: join(deps.home, '.deepcode', 'config.json'), label: '用户级' },
    { path: join(deps.root, '.deepcode', 'config.json'), label: '项目级' },
  ];

  let merged: CliConfig = {};
  for (const { path, label } of layers) {
    const text = await readText(path);
    if (text === undefined) continue;

    const parsed = parseLayer(text, path, label, warn);
    // 项目级的 apiKey 就是"key 被提交进仓库"那条路。用户选了允许，但不能一声不吭。
    if (label === '项目级' && parsed.apiKey !== undefined) {
      warn(
        `注意：项目级配置文件 ${path} 里带了 apiKey。这个文件很容易被一起提交进仓库 —— ` +
          '确认它已在 .gitignore 里，或者把 key 挪到用户级配置 / 环境变量。',
      );
    }
    merged = { ...merged, ...parsed };
  }

  return merged;
}

function parseLayer(
  text: string,
  path: string,
  label: string,
  warn: (line: string) => void,
): CliConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}配置文件 ${path} 不是合法 JSON：${String(error)}`);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}配置文件 ${path} 的顶层必须是一个对象，例如 {"model": "claude-sonnet-5-5"}`);
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(key in FIELD_TYPES)) {
      warn(
        `${label}配置文件 ${path} 里有不认识的字段 "${key}"，已忽略。` +
          `认识的字段：${Object.keys(FIELD_TYPES).join(' / ')}`,
      );
    }
  }

  const out: CliConfig = {};
  for (const key of Object.keys(FIELD_TYPES) as Array<keyof CliConfig>) {
    const value = record[key];
    if (value === undefined) continue;
    const expected = FIELD_TYPES[key];
    if (typeof value !== expected) {
      throw new Error(`${label}配置文件 ${path} 的 "${key}" 应该是 ${expected}，实际给的是 ${typeof value}`);
    }
    if (key === 'provider' && !isProviderKind(String(value))) {
      throw new Error(
        `${label}配置文件 ${path} 的 "provider" 只能是 ${PROVIDER_KINDS.join(' / ')}，` +
          `实际给的是 ${JSON.stringify(value)}`,
      );
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

async function readTextFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  return readFile(path, 'utf8');
}

/**
 * 给人看的凭据。空 → 显式说「没配」：`""` 与「配了但打码」必须看得出区别，
 * 否则你会对着一个空字符串猜半天（设计 §0 决策 8）。
 *
 * 短值不吐头部：`slice(0, 6)` 对一把 4 位的值等于原样打出来，那就不叫打码了。
 */
export function maskSecret(value: string | undefined): string {
  if (value === undefined || value === '') return '（没配）';
  const head = value.length > 6 ? `${value.slice(0, 6)}…` : '';
  return `${head}（共 ${value.length} 位）`;
}

export type ConfigEntry = {
  readonly key: string;
  readonly value: string;
  readonly source: 'env' | 'user' | 'project' | 'default';
  readonly writable: boolean;
};

export type DescribeConfigDeps = {
  env: Record<string, string | undefined>;
  /** 用户主目录：用户级配置在 `<home>/.deepcode/config.json`。 */
  home: string;
  /** 会话根目录（= cwd）：项目级配置在 `<root>/.deepcode/config.json`。 */
  root: string;
  /** 未知字段的告警出口（来自 parseLayer）。默认不出声。 */
  warn?: (line: string) => void;
  /** 测试替身：返回 undefined 表示文件不存在。默认真读磁盘。 */
  readText?: (path: string) => Promise<string | undefined>;
};

/**
 * 生效配置的清单，**带来源**。与 `resolveSettings` 共用同一张 `ENV_NAMES`、同一份 `DEFAULTS`
 * 与同一条优先级（环境变量 > 项目级 > 用户级 > 默认），但多报一个 source ——
 * 那正是这个事件存在的理由。
 *
 * 一个键同时来自环境与文件时**只报 env**，不再把文件里的值列一遍：
 * 那正是 `resolveSettings` 那条告警要防的「你以为配置生效了」。
 *
 * 文件也走同一个 `parseLayer`：**坏文件照样抛**，不在这里假装没看见 —— 悄悄吞掉解析失败，
 * 会让 `deepcode config list` 打出一份看着正常、实际不是生效值的清单。
 */
export async function describeConfig(deps: DescribeConfigDeps): Promise<ConfigEntry[]> {
  const readText = deps.readText ?? readTextFile;
  const warn = deps.warn ?? (() => {});
  const layers: ReadonlyArray<{ path: string; label: 'user' | 'project'; name: string }> = [
    { path: join(deps.home, '.deepcode', 'config.json'), label: 'user', name: '用户级' },
    { path: join(deps.root, '.deepcode', 'config.json'), label: 'project', name: '项目级' },
  ];

  // 项目级盖用户级，与 loadConfig 同一个方向。
  const fromFile = new Map<keyof CliConfig, { value: unknown; source: 'user' | 'project' }>();
  for (const { path, label, name } of layers) {
    const text = await readText(path);
    if (text === undefined) continue;
    const parsed = parseLayer(text, path, name, warn);
    for (const [key, value] of Object.entries(parsed) as Array<[keyof CliConfig, unknown]>) {
      fromFile.set(key, { value, source: label });
    }
  }

  const entries: ConfigEntry[] = [];
  for (const key of Object.keys(FIELD_TYPES) as Array<keyof CliConfig>) {
    const envName = ENV_NAMES.find((e) => e.field === key)?.names.find(
      (name) => (deps.env[name] ?? '') !== '',
    );
    const file = fromFile.get(key);

    let value: unknown;
    let source: ConfigEntry['source'];
    if (key === 'debug' && debugFromEnv(deps.env)) {
      // 与 resolveSettings 里那条 `debugFromEnv(env) || ...` 对上（见上面那个函数的注释）。
      value = true;
      source = 'env';
    } else if (envName !== undefined) {
      value = deps.env[envName];
      source = 'env';
    } else if (file !== undefined) {
      value = file.value;
      source = file.source;
    } else {
      value = DEFAULTS[key];
      source = 'default';
    }

    const shown =
      key === 'apiKey'
        ? maskSecret(typeof value === 'string' ? value : undefined)
        : value === undefined
          ? '（没配）'
          : String(value);
    entries.push({ key, value: shown, source, writable: WRITABLE_KEYS.includes(key) });
  }
  return entries;
}

export type SetConfigDeps = {
  /** 只写用户级 —— 项目级那个文件是仓库的，写它正是「key 跟着仓库走」那条路。 */
  home: string;
  key: string;
  value: string;
  /** 测试替身：返回 undefined 表示文件不存在。默认真读磁盘。 */
  readText?: (path: string) => Promise<string | undefined>;
  /** 测试替身。默认真写盘（原子 + 0600）。 */
  writeJson?: (path: string, json: string) => Promise<void>;
};

export type SetConfigResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/**
 * 改**用户级** `~/.deepcode/config.json` 里的一个键（设计 §5.3）。
 *
 * 三条边界，缺一不可：
 * - 只写用户级：项目级那个文件是仓库的，写它正是「key 跟着仓库走」那条路；
 * - 读-改-写：不能留一个「只写了 model、把 apiKey 抹了」的出口；
 * - 原子 + 0600：一次中断留下的是半个 JSON，而 `parseLayer` 会把它当坏文件抛。
 *
 * 拒绝的顺序是有意的：**先问"这是不是设置"，再问"在不在可写清单里"**。
 * 反过来的话，`permissions.allow` 会拿到一句"不在可写清单里（能写的只有 model）"——
 * 对是对，但答错了问题：它被拒的真正理由是那个前缀整个不许由命令去动。
 */
export async function setConfigValue(deps: SetConfigDeps): Promise<SetConfigResult> {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (deps.key === prefix || deps.key.startsWith(`${prefix}.`) || deps.key.startsWith(`${prefix}:`)) {
      return {
        ok: false,
        error:
          `"${deps.key}" 属于 ${prefix}.*，那是**设置**不是连接配置 —— ` +
          `改权限 / 沙箱 / 插件名单请直接编辑设置文件。一个能在运行时改权限来源的入口，` +
          `就是第二个自动放行开关。`,
      };
    }
  }

  if (!WRITABLE_KEYS.includes(deps.key as keyof CliConfig)) {
    return {
      ok: false,
      error:
        `"${deps.key}" 不在可写清单里。能写的只有：${WRITABLE_KEYS.join(' / ')}。` +
        `（apiKey 是凭据、baseUrl 决定请求发去哪 —— 这两个要自己开文件改。）`,
    };
  }

  if (deps.key === 'model') {
    try {
      assertModelShape(deps.value);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const path = join(deps.home, '.deepcode', 'config.json');
  const readText = deps.readText ?? readTextFile;
  const existing = await readText(path);

  let record: Record<string, unknown> = {};
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      return { ok: false, error: `现有的 ${path} 不是合法 JSON，改它之前先修它：${String(error)}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `现有的 ${path} 顶层不是对象，改它之前先修它。` };
    }
    // 展开而不是重建：不认识的键也要原样留着。这是「读-改-写」里的那个"改"。
    record = { ...(parsed as Record<string, unknown>) };
  }
  record[deps.key] = deps.value;

  const write = deps.writeJson ?? writeJsonAtomic;
  try {
    await write(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: `写 ${path} 失败：${String(error)}` };
  }
  return { ok: true, path };
}

/**
 * 托管层把出网位置钉死（P5d）。
 *
 * 与 `sandbox.paths.allow`（白名单只有托管层能设）、`instructions`（只有托管层能下发）
 * 同一条规矩 —— 只不过这里钉的是**请求发去哪**：组织把所有人指到自己的网关上，
 * 员工绕不过去。能改的只有"发给谁"（凭据），那是 `apiKey`，这里一个字都不碰。
 *
 * 纯函数，不碰 `main.ts` 的装配：这条规则值得被单独钉住，而 `main.ts` 是个
 * 一跑就建 readline、连网的脚本。
 *
 * `pinned` 只报**值真的变了**的字段 —— 与 `resolveSettings` 里那条环境变量覆盖告警
 * 同一个口径（两边值相同时每次启动吼一遍，只会训练人忽略它）。
 */
export function applyManagedGateway(
  config: ResolvedSettings,
  gateway: GatewayConfig,
): { readonly config: ResolvedSettings; readonly pinned: readonly string[] } {
  const pinned: string[] = [];
  const out = { ...config };

  if (gateway.baseUrl !== undefined && out.baseUrl !== gateway.baseUrl) {
    out.baseUrl = gateway.baseUrl;
    pinned.push('baseUrl');
  }
  if (gateway.model !== undefined && out.model !== gateway.model) {
    out.model = gateway.model;
    pinned.push('model');
  }

  return { config: out, pinned };
}

/**
 * 写临时文件再 `rename` —— 与 P4c-1 的落盘同一条（那份设计 §5）。
 *
 * 0600 是因为这个文件里有 `apiKey`：它躺在用户主目录下，但没必要让同机其他账号读到。
 * `rename` 是原子的，所以任何时刻盘上要么是旧的完整文件、要么是新的完整文件 ——
 * 半截 JSON 会被 `parseLayer` 当坏文件**抛**，那等于下次启动直接起不来。
 */
async function writeJsonAtomic(path: string, json: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, json, { mode: 0o600 });
  await rename(tmp, path);
}
