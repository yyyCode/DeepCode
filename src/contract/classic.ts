/**
 * Classic hooks 的契约：事件名、`hooks.json` 的形状、以及我们**真正桥接**的那三个事件。
 *
 * 三样东西放一个文件，是因为它们必须一起改：加一个桥接事件 = 白名单里加一条 + 映射表里加一条。
 * 白名单有 33 个而映射只有 3 个，这个不对称本身就是信息（设计 §5.1）—— 它是"参考实现有 33 个事件、
 * 我们只找到 3 个着陆点"的如实呈现，不是没做完。
 */

/**
 * classic hooks 的 33 个事件名。
 *
 * ⚠️ **这不是 33 个引擎事件。** 引擎事件目录在 `events.ts`（39 个声明 / 19 个实现）。
 * classic 事件是**另一份目录**：它们从 `hooks.json` 里读进来，落到我们已有的钩子点上。
 * 为它们各造一个引擎事件是白造 —— 没人会 dispatch 一个叫 `classic.PreToolUse` 的东西。
 * 见设计 §11 偏差 1。
 */
export const CLASSIC_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
] as const;

export type ClassicEvent = (typeof CLASSIC_EVENTS)[number];

const CLASSIC_SET: ReadonlySet<string> = new Set(CLASSIC_EVENTS);

export function isClassicEvent(name: string): name is ClassicEvent {
  return CLASSIC_SET.has(name);
}

/**
 * 桥接表：classic 事件 → 我们已有的钩子点。
 *
 * 只有三个，因为**只有这三个已经有着陆点**。`PostToolUse` 要一个 `tool.result` 事件、
 * `Stop` 与 `UserPromptSubmit` 要一条能携带文本的通道 —— 都得动事件目录或 prompt 组装面，
 * 排在 P4（设计 §11 偏差 2）。
 */
export const BRIDGED_EVENTS = {
  PreToolUse: 'tool.check',
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
} as const;

export type BridgedEvent = keyof typeof BRIDGED_EVENTS;

const BRIDGED_SET: ReadonlySet<string> = new Set(Object.keys(BRIDGED_EVENTS));

export function isBridged(name: string): name is BridgedEvent {
  return BRIDGED_SET.has(name);
}

/** `hooks.json` 里的一个钩子定义。未知字段原样留着 —— 校验器要点名"未识别的字段"。 */
export type HookDef = {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly timeout?: unknown;
  readonly [key: string]: unknown;
};

/** 一个 matcher 组：一个 matcher + 一组钩子（组内串行）。 */
export type HookGroup = {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
};

/** 一份 `hooks.json` 的正文：事件名 → matcher 组数组。 */
export type HookConfig = Readonly<Record<string, unknown>>;

/** 归一之后的一个钩子：命令原文 + 毫秒超时。 */
export type ResolvedHookDef = {
  readonly command: string;
  readonly timeoutMs: number;
};

/**
 * 归一之后的一个 matcher 组。
 *
 * `tools === undefined` 表示"对所有工具生效"（matcher 是 `*` 或没写）。
 * 正则形态的组**不会**出现在这里 —— 它在校验期就被跳过并警告了（设计 §5.3）。
 */
export type ResolvedHookGroup = {
  readonly event: BridgedEvent;
  readonly tools: readonly string[] | undefined;
  readonly hooks: readonly ResolvedHookDef[];
};

/**
 * 钩子超时的默认值与上限（秒）。
 *
 * 参考实现的默认值是 60 秒，那是给"可能做一次 LLM 调用"的钩子留的余量。
 * 我们桥的三个事件里，`PreToolUse` 是**同步挡在每一次工具调用前面**的 ——
 * 一个手滑的钩子把 CLI 冻住一分钟是用户敌意。收紧到 10 秒，见设计 §11 偏差 4。
 */
export const DEFAULT_HOOK_TIMEOUT_S = 10;
export const MAX_HOOK_TIMEOUT_S = 300;

/**
 * classic matcher 的三档：`*`（全部）、精确名或 `A|B`（拆开）、以及正则形态（不支持）。
 *
 * 判断用**字符集**而不是"试着编译成正则"：`Delete` 也能编译成正则，可它是个工具名。
 * 允许的字符集是 `[A-Za-z0-9_|]`，这之外的任何字符（`.` `*` `^` `(` …）一律当正则形态。
 * `*` 单独先判掉 —— 它是最常见的那个"全部"，且 `*` 本身也是正则元字符。
 *
 * 判成 `'regex'` 之后是**跳过**这一整组，不是"当精确名比对"：一条本意只覆盖
 * `mcp__.*__delete.*` 的规则若被放大到所有工具，那是**放宽**，方向不对的降级不做。
 */
export function parseMatcher(matcher: string): '*' | readonly string[] | 'regex' {
  const trimmed = matcher.trim();
  if (trimmed === '*') return '*';
  // 先把 `|` 两侧的空白抹平，再判字符集：`Write | Edit` 是列表，而 `a b` 不是 ——
  // 后者中间那个空格不挨着任何分隔符，于是它留在字符串里被字符集挡下，判成正则形态。
  const collapsed = trimmed.replace(/\s*\|\s*/g, '|');
  if (!/^[A-Za-z0-9_|]+$/.test(collapsed)) return 'regex';
  const names = collapsed.split('|').filter((name) => name !== '');
  // 空数组会被下游读成"只对零个工具生效"—— 那是个安静的失效。判成 regex 至少会吼一声。
  return names.length === 0 ? 'regex' : names;
}
