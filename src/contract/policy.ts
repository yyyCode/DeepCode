/**
 * 权限规则的解析、匹配与优先级。
 *
 * 放在 `contract/` 是因为依赖边界规定 `builtins: ['contract']`，而 `permissions`
 * 与 `sec-default` 两个内建插件都要用它。`contract/tier.ts` 已经带了 `tierIndex`
 * 这种纯逻辑，是同一条先例：**零依赖、零 IO、纯函数**。
 *
 * 这个文件里没有任何一处知道"settings 从哪来"、"谁有权改规则" —— 那是 cli/settings.ts
 * 与两个插件的事。
 */

export type Behavior = 'allow' | 'ask' | 'deny';

export type Rule = {
  /** 规则原文，原样保留。deny 要按它"持有"，也按它回报给人。 */
  readonly raw: string;
  readonly tool: string;
  /**
   * 已归一化（空白折叠、分隔符统一、`~` 已展开）。`undefined` = 该工具的所有调用。
   * 归一在**解析时**做一次，匹配时只归一调用侧 —— 规则是启动期定下的，不该每次重算。
   */
  readonly content?: string;
  readonly decision: Behavior;
};

export type ParsedRule = Rule | { readonly error: string };

/** 一次工具调用。与 `tool.check` 的事件参数同形。 */
export type Call = { readonly tool: string; readonly input: unknown };

export type Verdict = { readonly decision: Behavior; readonly rule: string };

/** deny 最严，allow 最松。数字只用于比较，"谁赢"仍由 `evaluate` 的固定优先级决定。 */
export const LENIENCY: Readonly<Record<Behavior, number>> = { deny: 0, ask: 1, allow: 2 };

/** a 是否比 b 宽松。相等不算。 */
export function isLooser(a: Behavior, b: Behavior): boolean {
  return LENIENCY[a] > LENIENCY[b];
}

/**
 * 取 `file_path` 的工具。带参规则按路径 glob 匹配的就这三个。
 *
 * `Glob` / `Grep` 不在里面：它们的参数是 `pattern`（一个正则或文件名式），不是路径 ——
 * 拿路径 glob 去比一个正则，只会得到一条永远不命中的规则。
 */
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit']);

/** 工具名：字母开头，之后字母 / 数字 / 下划线。 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * 连续空白折成单空格、去首尾。规则侧与调用侧都要做，`git  push` 才等于 `git push`。
 *
 * **导出给沙箱用**（`contract/sandbox.ts` 的 `sandboxRule`）。P4b 那一道路径闸必须与
 * 权限链用**同一套**归一 —— 两套分叉的那天，症状是"同一条规则在权限链认、在沙箱不认"。
 */
export function squeeze(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 反斜杠统一成正斜杠，免得同一个路径因为写法不同而匹配不上。**导出给沙箱用**，理由同 `squeeze`。 */
export function slashes(text: string): string {
  return text.replace(/\\/g, '/');
}

/**
 * `~` → home，只在开头且后面跟着分隔符（或就是它自己）。
 *
 * 规则侧的 `~` 由调用方在解析时展开；**调用侧不展开** —— 模型给 `Read` 传 `~/.ssh/id_rsa`
 * 本来就该由 fs 名词去管，绕到这里来只会让匹配和真实行为对不上。
 *
 * 沙箱**调用侧要展开它**：权限链的调用侧不展开是刻意的（同上），而沙箱的候选来自命令行文本，
 * 跟 fs 名词隔了一整条工具链 —— 不展开的话一条 `~/.ssh/**` 的 deny 会**永远不命中**，
 * 安静地失效。
 */
export function expandHome(text: string, home: string): string {
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return home + text.slice(1);
  return text;
}

/**
 * 解析一条规则。五类坏输入返回 `{ error }`，**不抛** —— 调用方要把 error 连同
 * 原文报到人面前（见 cli/settings.ts），抛出去就没原文了。
 */
export function parseRule(text: string, decision: Behavior, home: string): ParsedRule {
  const raw = text;
  const trimmed = text.trim();
  if (trimmed === '') return { error: '规则是空的' };

  const open = trimmed.indexOf('(');
  if (open === -1) {
    if (trimmed.includes(')')) return { error: '括号不配对' };
    if (!TOOL_NAME_RE.test(trimmed)) return { error: `工具名 "${trimmed}" 不合法` };
    return { raw, tool: trimmed, decision };
  }

  if (!trimmed.endsWith(')')) return { error: '括号不配对' };

  const tool = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, -1).trim();

  if (!TOOL_NAME_RE.test(tool)) return { error: `工具名 "${tool}" 不合法` };
  if (content === '') return { error: '括号里是空的' };
  if (content.includes('(') || content.includes(')')) return { error: '括号不配对' };

  const normalized =
    tool === 'Bash'
      ? squeeze(content)
      : PATH_TOOLS.has(tool)
        ? slashes(squeeze(expandHome(content, home))).replace(/\/+/g, '/')
        : content;

  // `Bash(:*)` 与 `Bash` 同义（见 matchesBash），但**同义要同到隐藏工具那一处**：
  // `fullyDeniedTools` 认的是 `content === undefined`，若在这里留着 `':*'`，
  // `deny: ["Bash(:*)"]` 会拒绝掉全部 Bash、却仍把 Bash 摆在模型眼前。
  // 所以在解析期就归成同一个形状，而不是只在匹配时等价。
  if (tool === 'Bash' && normalized === ':*') return { raw, tool, decision };

  return { raw, tool, content: normalized, decision };
}

/**
 * 这条规则有没有可能真的命中。
 *
 * 只有 `Bash` 与三个路径工具的带参形式实现了参数匹配，其它工具带括号是我们**不支持**
 * 的写法。它必须吼一次（§7），否则写的人会以为自己在防一件其实没防的事。
 */
export function isSupported(rule: Rule): boolean {
  if (rule.content === undefined) return true;
  return rule.tool === 'Bash' || PATH_TOOLS.has(rule.tool);
}

export function matchesRule(rule: Rule, call: Call): boolean {
  if (rule.tool !== call.tool) return false;
  if (rule.content === undefined) return true;

  if (rule.tool === 'Bash') return matchesBash(rule.content, call.input);
  if (PATH_TOOLS.has(rule.tool)) return matchesPath(rule.content, call.input);
  // 不支持的带参规则：永不命中。加载时已经警告过一次，这里安静。
  return false;
}

/** 从工具入参里取一个字符串字段。取不到（缺、类型不对）就当不匹配，不抛。 */
function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `cmd` 精确；`cmd:*` 是**空白 token 边界上的前缀**。
 *
 * `:*` 必须按 token 边界解释，不能当普通通配符：当通配符的话，`Bash(git push:*)`
 * 会要求命令行里真有一个冒号，而 `git push origin main` 没有 —— 规则永远不命中，
 * 安静地失效。（`content` 已在 `parseRule` 里归一过了。）
 */
function matchesBash(content: string, input: unknown): boolean {
  const command = readString(input, 'command');
  if (command === undefined) return false;
  const normalized = squeeze(command);

  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim();
    // `Bash(:*)` 与 `Bash` 同义。parseRule 已把它归一成 `content: undefined`，
    // 所以正常路径走不到这里；留着是给手写的 Rule 字面量（测试、将来的插件）兜底。
    if (prefix === '') return true;
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === content;
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\?]/;

/** `*` 单段、`**` 跨段。输入是已归一（正斜杠）的绝对路径式模式。 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch !== '*') {
      out += GLOB_SPECIAL.test(ch) ? `\\${ch}` : ch;
      continue;
    }
    if (pattern[i + 1] === '*') {
      // `**/` 也吃零段：`a/**/b` 要能匹配 `a/b`。
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
      continue;
    }
    out += '[^/]*';
  }
  return new RegExp(`^${out}$`);
}

function matchesPath(pattern: string, input: unknown): boolean {
  const filePath = readString(input, 'file_path');
  if (filePath === undefined) return false;
  // 连续分隔符也折成一个 —— 与规则侧（见 parseRule）同一条归一。
  // 只折规则侧是最坏的非对称：模型给出 `/srv//a.txt` 时，规则 `/srv/a.txt` 安静地不命中，
  // deny 变成一次静默的 fail-open。
  // 空白则**不**折：真实路径里可以有两个连续空格（`a  b.txt` 是合法文件名），调用侧
  // 一折，一条指向 `/x/a  b.txt` 的规则就会连 `/x/a b.txt` 这个**别的文件**一起命中 ——
  // 越界比不命中更坏。规则侧折空白是计划里的既有行为，由 `规则路径里的连续空白也折叠` 钉着。
  return globToRegExp(pattern).test(slashes(filePath).replace(/\/+/g, '/'));
}

/**
 * 扫全部规则，各按行为分桶；**桶顺序固定 `deny → ask → allow`**，第一个非空的桶里
 * 取第一条命中的，返回 `{ decision, rule: 该条原文 }`。未命中返回 `undefined`。
 *
 * 为什么是固定优先级而不是"先到先得"：更严的永远赢，与全局 fail-closed 同方向，
 * 且结果与数组顺序无关 —— 重排一下配置文件不会换行为。
 *
 * 注意这与 `isLooser` **无关**：那个是 `sec-default` 衡量"下游相对策略放宽了多少"
 * 的尺子，不是规则之间的优先级规则。两者容易混为一谈。
 */
export function evaluate(rules: readonly Rule[], call: Call): Verdict | undefined {
  for (const decision of ['deny', 'ask', 'allow'] as const) {
    for (const rule of rules) {
      if (rule.decision === decision && matchesRule(rule, call)) {
        return { decision, rule: rule.raw };
      }
    }
  }
  return undefined;
}

/**
 * 被**整工具** deny 的工具名（去重，按首次出现序）。
 *
 * 只有不带括号的 deny 算。参数化 deny（`Bash(git push:*)`）绝不隐藏整个工具 ——
 * 为了拦一条命令就把整个 Bash 从模型眼前藏掉是灾难。
 */
export function fullyDeniedTools(rules: readonly Rule[]): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    if (rule.decision === 'deny' && rule.content === undefined) names.add(rule.tool);
  }
  return [...names];
}
