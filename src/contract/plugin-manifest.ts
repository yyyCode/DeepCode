import {
  BRIDGED_EVENTS,
  DEFAULT_HOOK_TIMEOUT_S,
  MAX_HOOK_TIMEOUT_S,
  isBridged,
  isClassicEvent,
  parseMatcher,
  type ResolvedHookDef,
  type ResolvedHookGroup,
} from './classic';

/**
 * 插件清单与 `hooks.json` 的校验。
 *
 * **零 IO：** 所有读取都从 `PluginReader` 注入，于是这份判定能在没有文件系统的地方跑，
 * 也能被 `plugin validate` 与加载器**共用同一份实现** —— 出口标准二要求
 * "validate 能拦住坏清单"，而拦住它的必须是加载器也认的那条规则，不是另写一遍。
 *
 * 两级：E 是错误（装不上），W 是警告（装得上，但照这么写会不work 或本版本不认）。
 * 两者的区别必须一眼看得出来。
 */

export type Problem = {
  readonly level: 'error' | 'warn';
  /** 规则编号（`E3` / `W7`）。测试与输出都按它点名。 */
  readonly code: string;
  readonly message: string;
};

export type PluginManifest = {
  readonly name: string;
  /** 没写就是 `0.0.0`。 */
  readonly version: string;
  readonly description: string | undefined;
  readonly homepage: string | undefined;
  readonly author: string | undefined;
  /** 声明的扩展面。没写就是空数组 = 什么都不许注册。 */
  readonly uses: readonly string[];
  /** 声明过的路径字段 → 值。没声明的字段不在这里。 */
  readonly paths: Readonly<Record<string, readonly string[]>>;
};

/**
 * 相对插件目录的读取面。
 *
 * 两个方法都要，因为目录不可读成文本，而声明的路径既可能是文件也可能是目录。
 * 实现只在拿到**通过 `isSafeRelativePath` 的路径**之后才会被调用 —— 逃逸由校验器先拦下。
 */
export type PluginReader = {
  read(relative: string): Promise<string | undefined>;
  exists(relative: string): Promise<boolean>;
};

export type Validated = {
  readonly problems: readonly Problem[];
  /** 有没有 E 级问题。false = 装不上。 */
  readonly ok: boolean;
  /** 全绿时的归一清单。有 E 时是 undefined。 */
  readonly manifest: PluginManifest | undefined;
  /** 入口模块的相对路径。没声明就按顺序探测，都没有是 undefined。 */
  readonly entry: string | undefined;
  /** 归一后的钩子组：只留桥接事件，matcher 已展开，timeout 已给默认值。 */
  readonly hooks: readonly ResolvedHookGroup[];
};

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_NAME_LENGTH = 64;

/** `commands`/`agents`/`skills`/`mcpServers`：本版本只校验存在性，不加载（设计 §11 偏差 1）。 */
const NOT_LOADED_FIELDS = ['commands', 'agents', 'skills', 'mcpServers'] as const;

/** 目录里的约定部件 → 对应的清单字段。W8 用它点名。 */
const CONVENTION_DIRS = [
  ['./commands', 'commands'],
  ['./agents', 'agents'],
  ['./skills', 'skills'],
  ['./.mcp.json', 'mcpServers'],
] as const;

export const PATH_FIELDS = ['entry', 'hooks', 'commands', 'agents', 'skills', 'mcpServers'] as const;
export type PathField = (typeof PATH_FIELDS)[number];

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'uses',
  ...PATH_FIELDS,
]);

/** 入口模块的探测顺序。与 Node 的 ESM 解析习惯一致：.mjs 最先。 */
const DEFAULT_ENTRIES = ['./main.mjs', './main.js', './main.ts'] as const;
const DEFAULT_HOOKS_PATH = './hooks/hooks.json';

/**
 * 相对路径的四条硬规则：以 `./` 开头、不含 `..`、不含反斜杠、非空。
 *
 * `..` 是唯一能让清单逃出插件目录的写法，这条是本文件最要紧的校验。
 * 反斜杠一起禁，因为 Windows 上 `a\..\..\b` 会被 path 归一成逃逸路径 ——
 * 光禁 `..` 而放行反斜杠，等于在另一个平台上把这道闸门自己拆了。
 */
export function isSafeRelativePath(value: string): boolean {
  return value.startsWith('./') && !value.includes('..') && !value.includes('\\');
}

/**
 * 合法插件名。
 *
 * 导出它是因为 `settings.json` 的 `plugins.enable` 也要用同一个判定 ——
 * 两处各写一份正则的话，会出现"清单说这个名字合法、设置说非法"这种没法解释的状态。
 */
export function isPluginName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_RE.test(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validatePlugin(label: string, read: PluginReader): Promise<Validated> {
  const problems: Problem[] = [];
  const err = (code: string, text: string): void => {
    problems.push({ level: 'error', code, message: text });
  };
  const warn = (code: string, text: string): void => {
    problems.push({ level: 'warn', code, message: text });
  };

  const giveUp = (): Validated => ({
    problems,
    ok: false,
    manifest: undefined,
    entry: undefined,
    hooks: [],
  });

  // ── E2 清单读得到、是好 JSON、顶层是对象 ──
  let text: string | undefined;
  try {
    text = await read.read('plugin.json');
  } catch (error) {
    err('E2', `${label} 里的 plugin.json 读不了：${message(error)}`);
    return giveUp();
  }
  if (text === undefined) {
    err('E2', `${label} 里没有 plugin.json`);
    return giveUp();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    err('E2', `plugin.json 不是合法 JSON：${message(error)}`);
    return giveUp();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('E2', 'plugin.json 顶层不是一个对象');
    return giveUp();
  }
  const record = raw as Record<string, unknown>;

  // ── E3 name ──
  const rawName = record.name;
  let name: string | undefined;
  if (typeof rawName !== 'string') {
    err('E3', '缺少 name（必填，字符串）');
  } else if (!isPluginName(rawName)) {
    err('E3', `name ${JSON.stringify(rawName)} 不是 kebab-case（要求 ${String(NAME_RE)}）`);
  } else {
    name = rawName;
  }

  // ── E4 version ──
  const rawVersion = record.version;
  if (rawVersion !== undefined && (typeof rawVersion !== 'string' || !VERSION_RE.test(rawVersion))) {
    err('E4', `version ${JSON.stringify(rawVersion)} 不是 semver`);
  }

  // ── W1 未知顶层字段 ──
  // 只警告不致命：清单比引擎活得久，一个只在 P4 有意义的字段不该让插件装不上。
  const unknown = Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0) {
    warn('W1', `未识别的清单字段：${unknown.join('、')}（本版本忽略）`);
  }

  // ── E5 展示字段 ──
  for (const field of ['description', 'homepage'] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== 'string') err('E5', `${field} 必须是字符串`);
  }
  const rawAuthor = record.author;
  if (
    rawAuthor !== undefined &&
    typeof rawAuthor !== 'string' &&
    (typeof rawAuthor !== 'object' || rawAuthor === null || Array.isArray(rawAuthor))
  ) {
    err('E5', 'author 必须是字符串或对象');
  }

  // ── E6 + E8 路径字段 ──
  const paths: Record<string, readonly string[]> = {};
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;

    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
    if (values === undefined || values.some((item) => typeof item !== 'string')) {
      err('E6', `${field} 必须是字符串或字符串数组`);
      continue;
    }
    const list = values as string[];

    const unsafe = list.find((item) => !isSafeRelativePath(item));
    if (unsafe !== undefined) {
      err(
        'E6',
        `${field} 的路径必须是相对的、以 ./ 开头、不含 .. 与反斜杠，实际是 ${JSON.stringify(unsafe)}`,
      );
      continue;
    }

    for (const item of list) {
      if (!(await read.exists(item))) err('E8', `${field} 指向的 ${item} 不存在`);
    }
    paths[field] = list;
  }

  // ── E7 uses ──
  const rawUses = record.uses;
  let uses: readonly string[] = [];
  if (rawUses !== undefined) {
    if (!Array.isArray(rawUses) || rawUses.some((item) => typeof item !== 'string')) {
      err('E7', 'uses 必须是字符串数组');
    } else {
      uses = rawUses as string[];
    }
  }

  // ── W8 约定目录：没声明但有，或声明了但本版本不加载 ──
  for (const [dir, field] of CONVENTION_DIRS) {
    if (paths[field] === undefined && (await read.exists(dir))) {
      warn('W8', `有 ${dir}，但清单没在 ${field} 里声明它 —— 本版本不加载`);
    }
  }
  for (const field of NOT_LOADED_FIELDS) {
    if (paths[field] !== undefined) {
      warn('W8', `${field} 在本版本不加载（P4 的组件面），这一项只做了存在性校验`);
    }
  }

  // ── 入口模块：声明优先，否则按固定顺序探测 ──
  let entry = paths.entry?.[0];
  if (entry === undefined) {
    for (const candidate of DEFAULT_ENTRIES) {
      if (await read.exists(candidate)) {
        entry = candidate;
        break;
      }
    }
  }

  // ── 钩子 ──
  const hooksPath = paths.hooks?.[0] ?? DEFAULT_HOOKS_PATH;
  let hooks: readonly ResolvedHookGroup[] = [];
  try {
    const hooksText = await read.read(hooksPath);
    if (hooksText !== undefined) hooks = resolveHooks(hooksText, uses, err, warn);
  } catch (error) {
    // 读不了 ≠ 不存在。前者要吼（可能是有意藏起来的东西），后者是常态。
    err('E9', `${hooksPath} 读不了：${message(error)}`);
  }

  // ── W6/W7 这两条不查格式，查的是"照这么写会不work" ──
  const covers = (pattern: string): boolean =>
    uses.some(
      (item) => item === '*' || item === pattern || (item.endsWith('.*') && pattern.startsWith(item.slice(0, -1))),
    );
  if (covers('tool.describe') && !covers('tool.call')) {
    warn('W6', 'uses 里有 tool.describe 却没有 tool.call —— 描述了一个不会执行的工具');
  }
  if (covers('tool.call') && !covers('tool.check')) {
    warn('W7', 'uses 里有 tool.call 却没有 tool.check —— 这个工具会被 confirm 当未知工具拒掉');
  }

  // ── W9 装了什么都不做 ──
  // 按**归一之后**的钩子数判，不是按 hooks.json 里的条目数：一份只写了
  // prompt 钩子的清单（W4）确实什么都不会跑，那句"装上什么都不做"就是它此刻的真话。
  if (entry === undefined && hooks.length === 0) {
    warn('W9', '既没有入口模块、也没有可跑的钩子 —— 这个插件装上什么都不做');
  }

  const ok = !problems.some((problem) => problem.level === 'error');
  return {
    problems,
    ok,
    manifest: ok && name !== undefined
      ? {
          name,
          version: typeof rawVersion === 'string' ? rawVersion : '0.0.0',
          description: typeof record.description === 'string' ? record.description : undefined,
          homepage: typeof record.homepage === 'string' ? record.homepage : undefined,
          author: typeof rawAuthor === 'string' ? rawAuthor : undefined,
          uses,
          paths,
        }
      : undefined,
    entry,
    hooks,
  };
}

/**
 * 把一份 `hooks.json` 归一成"要跑什么"。
 *
 * `uses` 传进来只有一个用途：**W10** —— 钩子桥到的那个引擎事件没在 `uses` 里声明。
 * 这个插件在装载期会被整个撤掉（§4.3 按事件名查越界），而装载期的失败是
 * "插件看起来装了、实际一条都没生效"，最难查。所以在校验期就点名。
 */
function resolveHooks(
  text: string,
  uses: readonly string[],
  err: (code: string, message: string) => void,
  warn: (code: string, message: string) => void,
): readonly ResolvedHookGroup[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    err('E9', `hooks.json 不是合法 JSON：${message(error)}`);
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('E9', 'hooks.json 顶层不是一个对象');
    return [];
  }

  const record = raw as Record<string, unknown>;
  // 两种形态都收：带包装的（插件的 `{description, hooks}`）与不带的（设置的 `{事件: [...]}`）。
  // 参考实现里这两种格式都真实存在，收下它俩的成本是一个 typeof。
  const body =
    typeof record.hooks === 'object' && record.hooks !== null && !Array.isArray(record.hooks)
      ? (record.hooks as Record<string, unknown>)
      : record;

  const out: ResolvedHookGroup[] = [];

  for (const [event, value] of Object.entries(body)) {
    if (event === 'description' && body === record) {
      // 直接形态里出现 description：多半是照着包装形态抄漏了一层。点名，别静默。
      warn('W1', 'hooks.json 里有 description 却没有外层 hooks 包装 —— 这一项被忽略');
      continue;
    }
    if (!isClassicEvent(event)) {
      err('E10', `hooks.json 里的 ${JSON.stringify(event)} 不是 classic 事件名（共 33 个）`);
      continue;
    }
    if (!isBridged(event)) {
      warn(
        'W3',
        `${event} 本版本不跑（只桥接了 PreToolUse / SessionStart / SessionEnd），这一节被跳过`,
      );
      continue;
    }
    // 桥得到 → 这个事件会去 `uses` 里查越界。查不到就撤掉**整个插件**，
    // 而那听起来像"装上了"—— 所以在这里就说破（W10，spec §2.3）。
    const bridged = BRIDGED_EVENTS[event];
    const declared =
      uses.includes(bridged) ||
      uses.includes('*') ||
      (bridged.startsWith('tool.') && uses.includes('tool.*'));
    if (!declared) {
      warn(
        'W10',
        `hooks.json 里有 ${event}，要桥到 ${bridged}，但清单的 uses 里没有声明它 —— ` +
          `装载时这个插件会被整个撤掉，请把 ${bridged} 加进 uses`,
      );
    }
    if (!Array.isArray(value)) {
      err('E11', `${event} 的值必须是数组`);
      continue;
    }

    for (const [index, group] of value.entries()) {
      if (typeof group !== 'object' || group === null || Array.isArray(group)) {
        err('E11', `${event}[${index}] 不是一个对象`);
        continue;
      }
      const entry = group as Record<string, unknown>;

      const defs = entry.hooks;
      if (!Array.isArray(defs) || defs.length === 0) {
        err('E11', `${event}[${index}].hooks 必须是非空数组`);
        continue;
      }

      // matcher：`*` 或没写 = 对所有工具生效；其余走 parseMatcher 的三档。
      let tools: readonly string[] | undefined;
      const matcher = entry.matcher;
      if (matcher !== undefined) {
        if (typeof matcher !== 'string') {
          err('E11', `${event}[${index}].matcher 必须是字符串`);
          continue;
        }
        const parsed = parseMatcher(matcher);
        if (parsed === 'regex') {
          warn(
            'W5',
            `${event} 的 matcher ${JSON.stringify(matcher)} 是正则形态，本版本不支持 —— 这一整组被跳过（不放大到所有工具）`,
          );
          continue;
        }
        tools = parsed === '*' ? undefined : parsed;
      }

      const resolved: ResolvedHookDef[] = [];
      for (const [defIndex, def] of defs.entries()) {
        const where = `${event}[${index}].hooks[${defIndex}]`;
        if (typeof def !== 'object' || def === null || Array.isArray(def)) {
          err('E11', `${where} 不是一个对象`);
          continue;
        }
        const item = def as Record<string, unknown>;

        const strayKeys = Object.keys(item).filter(
          (key) => key !== 'type' && key !== 'command' && key !== 'timeout',
        );
        if (strayKeys.length > 0) {
          warn('W2', `${where} 有未识别的字段：${strayKeys.join('、')}（本版本忽略）`);
        }

        if (item.type !== undefined && item.type !== 'command') {
          warn('W4', `${where} 的 type 是 ${JSON.stringify(item.type)}，本版本只支持 command 型 —— 跳过`);
          continue;
        }
        if (typeof item.command !== 'string' || item.command.trim() === '') {
          err('E13', `${where} 缺少 command（非空字符串）`);
          continue;
        }

        let timeoutMs = DEFAULT_HOOK_TIMEOUT_S * 1000;
        if (item.timeout !== undefined) {
          const seconds = item.timeout;
          if (
            typeof seconds !== 'number' ||
            !Number.isInteger(seconds) ||
            seconds < 1 ||
            seconds > MAX_HOOK_TIMEOUT_S
          ) {
            err(
              'E14',
              `${where} 的 timeout 必须是 1..${MAX_HOOK_TIMEOUT_S} 的整数（秒），实际是 ${JSON.stringify(seconds)}`,
            );
            continue;
          }
          timeoutMs = seconds * 1000;
        }

        resolved.push({ command: item.command, timeoutMs });
      }

      if (resolved.length > 0) out.push({ event, tools, hooks: resolved });
    }
  }

  return out;
}
