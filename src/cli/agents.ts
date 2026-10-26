// src/cli/agents.ts
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentSpec } from '../contract/agent';
import { parseFrontmatter, readList, readScalar, type Frontmatter } from '../contract/frontmatter';
import { markdownFiles, rosterRoots, type RosterRoot } from './walkdir';

/**
 * 认得的 frontmatter 字段。**其余一律 warn + 忽略**，不让整个文件作废。
 *
 * 为什么不报错：参考实现的 agent 定义有 17 个字段，我们只实现六个。一份合法的、
 * 用着别的字段的 agent 文件应该还能装进来（少几个特性），而不是一个字都读不了。
 */
export const KNOWN_AGENT_FIELDS: readonly string[] = [
  'name',
  'description',
  'model',
  'tools',
  'disallowedTools',
  'maxTurns',
  'readOnly',
];

export type AgentRosterDeps = {
  /** 会话根目录，读 `<root>/.deepcode/agents/`。 */
  readonly root: string;
  /** 主目录，读 `~/.deepcode/agents/`。 */
  readonly home: string;
  /** **已装载**的插件（只算判为 loaded 的）。被 deny 的、没 enable 的不贡献名册。 */
  readonly plugins?: readonly { readonly name: string; readonly dir: string }[];
  /**
   * 开箱类型（P15）。**优先级最低**：三个来源都跑完之后才合并，同名文件已经占了名字
   * 就静默跳过 —— 覆盖一个内置类型是预期行为，为它打一条 warn 只是噪音。
   * 默认 `[]`：发现函数本身不认识具体产品名册（`main.ts` 显式传 `BUILTIN_AGENTS`）。
   */
  readonly builtins?: readonly AgentSpec[];
  readonly warn?: (line: string) => void;
};

/**
 * 读一遍三处根，得到一个按名字排好序的 agent 名册。
 *
 * **目录不存在是常态，安静**；目录在但读不了、文件坏掉、没有 `description`，
 * 都是一条 warn + 这一个文件不装 —— 与 `plugin-dir` 同一条：没有半个 agent。
 */
export async function discoverAgents(deps: AgentRosterDeps): Promise<readonly AgentSpec[]> {
  const warn = deps.warn ?? ((): void => {});
  /** 名字 → 来源说明。先放的赢。 */
  const claimed = new Map<string, string>();
  const agents: AgentSpec[] = [];

  const roots = rosterRoots({
    root: deps.root,
    home: deps.home,
    plugins: deps.plugins ?? [],
    sub: 'agents',
  });

  for (const root of roots) {
    for (const file of await markdownFiles(root.dir, 'agent 目录', warn)) {
      const path = join(root.dir, file);
      const spec = await readAgent(path, root, warn);
      if (spec === undefined) continue;

      const owner = claimed.get(spec.name);
      if (owner !== undefined) {
        // 落选的那份必须出声：静默丢弃会让人对着一个改了半天没反应的 agent 文件发呆。
        warn(`${path}：agent ${spec.name} 已由${owner}提供，这一份没用上。`);
        continue;
      }
      claimed.set(spec.name, describeOrigin(root));
      agents.push(spec);
    }
  }

  // 内置类型最后合并。同名不告状：覆盖一个内置类型是预期行为，与"两份用户文件撞名"
  // 不是同一件事 —— 后者永远出声（上面那条 warn）。
  for (const spec of deps.builtins ?? []) {
    if (claimed.has(spec.name)) continue;
    claimed.set(spec.name, '内置类型');
    agents.push(spec);
  }

  return agents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function describeOrigin(root: RosterRoot): string {
  if (root.origin === 'plugin') return `插件 ${root.namespace}`;
  return root.origin === 'project' ? '项目级目录' : '用户级目录';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读一个文件 → 一份 `AgentSpec`；任何一处不对就 warn + `undefined`（这一个不装）。 */
async function readAgent(
  path: string,
  root: RosterRoot,
  warn: (line: string) => void,
): Promise<AgentSpec | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    warn(`${path} 读不了（${describeError(error)}）—— 这个 agent 不装。`);
    return undefined;
  }

  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(text);
  } catch (error) {
    // frontmatter 用了不支持的语法：**不猜**，整个文件不装（设计 §3/§11）。
    warn(`${path}：frontmatter 坏掉（${describeError(error)}）—— 这个 agent 不装。`);
    return undefined;
  }

  for (const key of fm.fields.keys()) {
    if (!KNOWN_AGENT_FIELDS.includes(key)) warn(`${path}：不认识的字段 ${key}，忽略。`);
  }

  const declared = readScalar(fm, 'name');
  if (declared === undefined) {
    warn(`${path}：没写 name，用文件名兜底。`);
  }
  const local = declared ?? basename(path, '.md');
  // 插件级带命名空间前缀，与项目级/用户级结构上撞不上（设计 §4.1）。
  const name = root.namespace === undefined ? local : `${root.namespace}:${local}`;

  const description = readScalar(fm, 'description');
  if (description === undefined || description.trim() === '') {
    // 路由**全靠**这一行：没有它，这个 agent 永远不会被选中，装进来只是个看不见的摆设。
    warn(`${path}：没有 description —— 路由全靠它，这个 agent 不装。`);
    return undefined;
  }

  const model = readScalar(fm, 'model');
  const tools = readList(fm, 'tools');
  const disallowedTools = readList(fm, 'disallowedTools');
  const maxTurns = readPositiveInt(fm, 'maxTurns', path, warn);
  const readOnly = readBool(fm, 'readOnly', path, warn);
  if (readOnly === true && tools === undefined) {
    // 省略 tools = 继承父面（可能含 Write / Bash）。这时 readOnly 是自相矛盾的声明，
    // 丢掉标志而不是丢掉整个 agent：它仍然可以用 Task 串行派。
    warn(
      `${path}：readOnly: true 需要同时写 tools（省略 tools 会继承父级的全部工具，可能含写工具）—— 这个标志忽略，agent 仍可用 Task 派。`,
    );
  }

  // 可选字段一律用展开，不写 `tools: undefined`：省得依赖 exactOptionalPropertyTypes 关着。
  return {
    name,
    description,
    // 正文为空不是错误：插件那一侧会回落到会话的基础 system prompt（设计 §5.1）。
    prompt: fm.body.trim(),
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    // `inherit` 是缺省，与"没写"是同一种含义：用父级那个（参考实现 15 个 agent 里 8 个写它）。
    ...(model === undefined || model === 'inherit' ? {} : { model }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(readOnly === true && tools !== undefined ? { readOnly: true } : {}),
  };
}

/** `true` / `false` 两个值（大小写不敏感）；别的值 warn + 忽略。 */
function readBool(
  fm: Frontmatter,
  key: string,
  path: string,
  warn: (line: string) => void,
): boolean | undefined {
  const raw = readScalar(fm, key);
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  warn(`${path}：${key} 要是 true 或 false，读到 ${raw} —— 忽略这个字段。`);
  return undefined;
}

function readPositiveInt(
  fm: Frontmatter,
  key: string,
  path: string,
  warn: (line: string) => void,
): number | undefined {
  const raw = readScalar(fm, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    warn(`${path}：${key} 要是正整数，读到 ${raw} —— 忽略这个字段。`);
    return undefined;
  }
  return value;
}
