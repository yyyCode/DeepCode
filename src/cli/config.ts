import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 配置文件里认识的字段。写错的字段名会被点名，不会静默失效。 */
export type CliConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  debug?: boolean;
};

const FIELD_TYPES: Record<keyof CliConfig, 'string' | 'boolean'> = {
  apiKey: 'string',
  model: 'string',
  baseUrl: 'string',
  debug: 'boolean',
};

/** 没有任何配置时用的模型。写在这里是为了让"默认值是什么"只有一处。 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export type ResolvedSettings = {
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  debug: boolean;
};

/**
 * 环境变量与配置文件合到一处，优先级 `环境变量 > 配置文件`。
 *
 * 每个变量都有两个名字，因为市面上的 Anthropic 兼容端点（DeepSeek 等）配的是
 * `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 这一组，而 Anthropic 官方 SDK 自己
 * 用的是 `ANTHROPIC_API_KEY`。两组都认，用户就不用为了换个后端再 export 一遍。
 * 认证头本身不用改：`x-api-key` 与 `Authorization: Bearer` 两边都收（实测过）。
 *
 * 抽成纯函数而不是留在 main.ts 里，是因为"谁盖谁"这条规则正是最该被钉住的部分，
 * 而 main.ts 是个一跑就建 readline、连网的脚本，测不动。
 */
export function resolveSettings(
  env: Record<string, string | undefined>,
  config: CliConfig,
): ResolvedSettings {
  return {
    apiKey: env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? config.apiKey,
    model: env.DEEPCODE_MODEL ?? env.ANTHROPIC_MODEL ?? config.model ?? DEFAULT_MODEL,
    baseUrl: env.ANTHROPIC_BASE_URL ?? config.baseUrl,
    debug: Boolean(env.DEEPCODE_DEBUG) || config.debug === true,
  };
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
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

async function readTextFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  return readFile(path, 'utf8');
}
