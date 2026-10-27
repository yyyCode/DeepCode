import {
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MCP_TIMEOUT_MS,
  MAX_SERVER_NAME_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  type McpServerConfig,
  type McpServerOrigin,
} from '../contract/mcp';

/**
 * `mcpServers` 的形状校验、变量展开与工具名合法化。
 *
 * **纯函数、零 IO**：settings 层与插件 `.mcp.json` 读取层共用这一份判定，
 * 于是「什么样的配置能启动」只有一处答案。两处各写一遍的话，会出现
 * 「用户级说合法、插件里说非法」这种没法解释的状态。
 *
 * 处置的分寸与 `settings.ts` 的其它块一致：
 * - 会让这台 server **无法启动**的错误（命令空、args/env 形状不对）→ 整台跳过并点名；
 * - 不值钱、也不影响启动的字段（timeoutMs、未知字段）→ 用默认值/忽略，但要说一声。
 */

export type ParseMcpOptions = {
  readonly origin: McpServerOrigin;
  /** `origin === 'plugin'` 时的插件名，只用于警告文本。 */
  readonly plugin?: string;
  readonly env: Record<string, string | undefined>;
  /** 插件根目录等额外变量。与 `env` 同名时**额外变量赢**。 */
  readonly extraEnv?: Record<string, string>;
  /** 把相对路径 / `~` 解析成绝对路径。 */
  readonly resolvePath: (value: string) => string;
  readonly warn: (line: string) => void;
};

const SERVER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN_KEYS = new Set([
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'timeoutMs',
  'enabled',
]);

function where(options: ParseMcpOptions): string {
  return options.origin === 'plugin'
    ? `插件 ${options.plugin ?? '?'} 的 .mcp.json`
    : '用户级 settings.json 的 mcpServers';
}

/** 配置键能不能同时活成工具名里的一段。`-` 允许，工具名里会换成 `_`。 */
export function isMcpServerName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SERVER_NAME_LENGTH && SERVER_NAME_RE.test(name);
}

/** server 名在工具名里的那一段。`-` 是唯一需要替换的字符（正则已挡住其余）。 */
export function serverPrefix(name: string): string {
  return name.replace(/-/g, '_');
}

/** 展开 `${VAR}`。缺变量时返回缺的那个名字，不展开成空串。 */
export function expandVars(
  text: string,
  env: Record<string, string | undefined>,
  extraEnv: Record<string, string> = {},
): { value: string } | { missing: string } {
  const sources: Record<string, string | undefined> = { ...env, ...extraEnv };
  let missing: string | undefined;
  const value = text.replace(VAR_RE, (whole, name: string) => {
    const found = sources[name];
    if (found === undefined) {
      missing ??= name;
      return whole;
    }
    return found;
  });
  return missing === undefined ? { value } : { missing };
}

function hash8(text: string): string {
  // FNV-1a 32 位。只用于截断后的去重后缀，不需要抗碰撞。
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 把 server 报的原始工具名变成模型/权限规则看到的完整名。
 *
 * 规则（设计 §5.1）：
 * - 非 `[A-Za-z0-9_]` 换成 `_`；
 * - 首字符不是字母时前缀 `t_`（权限规则的工具名正则要求字母开头）；
 * - 整串超过 64 字符 → 截断工具段并加 8 位原文哈希；
 * - 同一 server 内重名 → `_2` / `_3`。
 */
export function toolName(server: string, raw: string, used: Set<string>): string {
  const head = `mcp__${serverPrefix(server)}__`;
  let segment = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (segment === '') segment = 'tool';
  if (!/^[A-Za-z]/.test(segment)) segment = `t_${segment}`;

  const maxSegment = Math.max(1, MAX_TOOL_NAME_LENGTH - head.length);
  if (segment.length > maxSegment) {
    const suffix = `_${hash8(raw)}`;
    segment = `${segment.slice(0, Math.max(1, maxSegment - suffix.length))}${suffix}`;
  }

  let candidate = `${head}${segment}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  for (let index = 2; ; index++) {
    const suffix = `_${index}`;
    const room = Math.max(1, MAX_TOOL_NAME_LENGTH - head.length - suffix.length);
    const next = `${head}${segment.slice(0, room)}${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
}

export function parseMcpServers(value: unknown, options: ParseMcpOptions): readonly McpServerConfig[] {
  const label = where(options);
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    options.warn(`${label} 不是一个对象，整块忽略。`);
    return [];
  }

  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const prefix = `${label}.${name}`;

    if (!isMcpServerName(name)) {
      options.warn(
        `${prefix} 的 server 名不合法 —— 要字母开头、只含字母数字下划线与连字符、不超过 ${MAX_SERVER_NAME_LENGTH} 字符，这一台跳过。`,
      );
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      options.warn(`${prefix} 不是一个对象，这一台跳过。`);
      continue;
    }
    const record = raw as Record<string, unknown>;

    const type = record['type'];
    if (type !== undefined && type !== 'stdio') {
      options.warn(`${prefix} 的 type 是 ${JSON.stringify(type)} —— 本版本只支持 stdio，这一台跳过。`);
      continue;
    }

    const enabled = record['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      options.warn(`${prefix} 的 enabled 不是布尔值，这一台跳过。`);
      continue;
    }

    const rawCommand = record['command'];
    if (typeof rawCommand !== 'string' || rawCommand.trim() === '') {
      options.warn(`${prefix} 缺少 command（非空字符串），这一台跳过。`);
      continue;
    }
    const command = expandVars(rawCommand, options.env, options.extraEnv);
    if ('missing' in command) {
      options.warn(`${prefix} 的 command 引用了未定义的环境变量 \${${command.missing}}，这一台跳过。`);
      continue;
    }

    const rawArgs = record['args'];
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((item) => typeof item !== 'string'))) {
      options.warn(`${prefix} 的 args 不是字符串数组，这一台跳过。`);
      continue;
    }
    const args: string[] = [];
    let missingArg: string | undefined;
    for (const item of (rawArgs as string[] | undefined) ?? []) {
      const expanded = expandVars(item, options.env, options.extraEnv);
      if ('missing' in expanded) {
        missingArg ??= expanded.missing;
        continue;
      }
      args.push(expanded.value);
    }
    if (missingArg !== undefined) {
      options.warn(`${prefix} 的 args 引用了未定义的环境变量 \${${missingArg}}，这一台跳过。`);
      continue;
    }

    const rawEnv = record['env'];
    if (rawEnv !== undefined && (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv))) {
      options.warn(`${prefix} 的 env 不是对象，这一台跳过。`);
      continue;
    }
    const env: Record<string, string> = {};
    let missingEnv: string | undefined;
    let badEnv: string | undefined;
    for (const [key, item] of Object.entries((rawEnv as Record<string, unknown> | undefined) ?? {})) {
      if (typeof item !== 'string') {
        badEnv ??= key;
        continue;
      }
      const expanded = expandVars(item, options.env, options.extraEnv);
      if ('missing' in expanded) {
        missingEnv ??= expanded.missing;
        continue;
      }
      env[key] = expanded.value;
    }
    if (badEnv !== undefined) {
      options.warn(`${prefix} 的 env.${badEnv} 不是字符串，这一台跳过。`);
      continue;
    }
    if (missingEnv !== undefined) {
      options.warn(`${prefix} 的 env 引用了未定义的环境变量 \${${missingEnv}}，这一台跳过。`);
      continue;
    }

    const rawCwd = record['cwd'];
    if (rawCwd !== undefined && typeof rawCwd !== 'string') {
      options.warn(`${prefix} 的 cwd 不是字符串，这一台跳过。`);
      continue;
    }
    let cwd: string | undefined;
    if (typeof rawCwd === 'string') {
      const expanded = expandVars(rawCwd, options.env, options.extraEnv);
      if ('missing' in expanded) {
        options.warn(`${prefix} 的 cwd 引用了未定义的环境变量 \${${expanded.missing}}，这一台跳过。`);
        continue;
      }
      cwd = options.resolvePath(expanded.value);
    }

    let timeoutMs = DEFAULT_MCP_TIMEOUT_MS;
    const rawTimeout = record['timeoutMs'];
    if (rawTimeout !== undefined) {
      if (
        typeof rawTimeout === 'number' &&
        Number.isInteger(rawTimeout) &&
        rawTimeout > 0 &&
        rawTimeout <= MAX_MCP_TIMEOUT_MS
      ) {
        timeoutMs = rawTimeout;
      } else {
        options.warn(
          `${prefix} 的 timeoutMs 必须是 1..${MAX_MCP_TIMEOUT_MS} 的整数，按默认值 ${DEFAULT_MCP_TIMEOUT_MS} 处理。`,
        );
      }
    }

    const unknown = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      options.warn(`${prefix} 里有不认识的字段：${unknown.join('、')}（已忽略）。`);
    }

    out.push({
      name,
      command: command.value.trim(),
      args,
      env,
      cwd,
      timeoutMs,
      enabled: enabled !== false,
      origin: options.origin,
      plugin: options.plugin,
    });
  }

  return out;
}
