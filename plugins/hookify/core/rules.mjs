/**
 * hookify 的纯逻辑：解析一份规则文件、对一次事件求值。
 *
 * 没有 IO —— 读文件、读 stdin、写 stdout 全在 hooks/hook.mjs 里。
 * 这样拆是为了让"规则说什么、命中什么"能被单独看、单独想。
 *
 * 判定词汇是**逐事件**的：只有这个事件上兑现得了的动作才允许写。
 * 两个方向同一条道理：`allow` 是错的（第三方插件返回的 allow 一律被丢弃，
 * src/cli/classic-hooks.ts），而 `deny` 写在 PostToolUse 上同样是错的 —— 工具已经跑完了。
 * 允许写一条兑现不了的规则，只会让人以为它生效了。
 */

/** 一条规则说不清自己想干什么时抛这个 —— 调用方按 fail-closed 处理。 */
export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
  }
}

const OPERATORS = ['matches', 'contains', 'equals', 'starts_with', 'ends_with'];
const OPERATOR_SET = new Set(OPERATORS);
const KNOWN_KEYS = new Set([
  'name',
  'event',
  'tool',
  'field',
  'operator',
  'pattern',
  'decision',
  'message',
]);
const REQUIRED = ['name', 'field', 'operator', 'pattern', 'message'];

/**
 * 规则文件能写在哪个事件上。**导出是必要的**：`hooks/hook.mjs` 也按这张表分派，
 * 各写一份的话，多支持一个事件就会变成"解析认、脚本不认"（那个钩子会 die 掉）。
 */
export const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];
const EVENT_SET = new Set(EVENTS);

/**
 * 逐事件词表：**只有这个事件上能兑现的动作才允许写**。
 *
 * `notify` 是我们自己的词（参考实现的 hookify 只有 deny/ask），含义是"往模型那边补一段话"，
 * 落到 `additionalContext` 上。它是 PostToolUse / UserPromptSubmit 上唯一兑现得了的动作。
 *
 * `Stop` 上继续用 `deny`（"不允许停止"本来就是一次拒绝），不另发明一个词。
 *
 * `why` 是拒绝理由的后半句，**逐事件写**：一句"放之四事件皆准"的话在这儿一定是错的
 * —— `Stop` 上被拒的词不是 `deny` 而是 `allow`/`ask`/`notify`，说成"工具已经跑完了"
 * 就变成了一条误导人的报错。
 */
const DECISIONS_BY_EVENT = {
  PreToolUse: {
    allowed: ['deny', 'ask'],
    why: 'allow 是表达不出来的：第三方插件只能拧紧不能拧松，一条放行规则在这里只会是空头承诺。',
  },
  PostToolUse: {
    allowed: ['notify'],
    why: '工具已经跑完了，"拒绝"在这个点上兑现不了 —— 这里能做的只有往模型那边补一段话（notify）。',
  },
  UserPromptSubmit: {
    allowed: ['notify'],
    why: '提示词已经要进去了，"拒绝"在这个点上兑现不了 —— 这里能做的只有往模型那边补一段话（notify）。',
  },
  Stop: {
    allowed: ['deny'],
    why: '这里只有"允不允许收手"一个落点：既没有"先问一次"，也没有地方说话。',
  },
};

/** 省略 `decision` 时的默认值：只有一个选择，或有多个时那个更保守的。 */
const DEFAULT_DECISION = {
  PreToolUse: 'deny',
  PostToolUse: 'notify',
  UserPromptSubmit: 'notify',
  Stop: 'deny',
};

// 逐事件的 `field` 取值处（PreToolUse 是 `tool_input`、PostToolUse 是 `tool_response`
// ——我们桥成 `{ok, output}`、UserPromptSubmit 是 `{prompt}`、Stop 是 `{last_assistant_message}`）
// **有意不在这儿再写一份常量**：取值处只有 hooks/hook.mjs 那一个三元表达式，
// 再放一张表在这儿就会有两份可以走岔的真相，而没有任何一行代码会去对它们。
// README 里那张表是给人看的，测试钉的是 hook.mjs 的实际行为。

/** `key: value` 一行一条。值去掉一层配对的引号，好让 pattern 里写 `:` 或 `#` 成为可能。 */
function parseFrontmatter(text, source) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at === -1) {
      throw new RuleError(`${source}: frontmatter 里这一行不是 key: value —— ${trimmed}`);
    }
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

/**
 * 解析一份规则文件。返回 `{ rule, warnings }`。
 *
 * **说不清想干什么的**（缺字段、算子不认识、正则编译不过、decision 是 allow）→ 抛 RuleError。
 * **多说了什么**（不认识的 frontmatter 字段）→ 只告警。
 *
 * 这两条不一样，是故意的：给 frontmatter 加一个新字段不该让**所有**规则文件一起失效 ——
 * 那是把"未知"当成"错误"，代价与收益不成比例。而缺一个必填字段是真的没法求值。
 */
export function parseRule(text, source) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    throw new RuleError(`${source}: 规则文件必须以一段 --- frontmatter 开头`);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new RuleError(`${source}: frontmatter 没有闭合的 ---`);

  const fm = parseFrontmatter(lines.slice(1, end).join('\n'), source);
  const body = lines.slice(end + 1).join('\n').trim();

  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${source}: 不认识的字段 "${key}"，已忽略`);
  }
  for (const key of REQUIRED) {
    if (fm[key] === undefined || fm[key] === '') {
      throw new RuleError(`${source}: 缺少必填字段 "${key}"`);
    }
  }
  if (!OPERATOR_SET.has(fm.operator)) {
    throw new RuleError(
      `${source}: 不认识的 operator "${fm.operator}"（支持 ${OPERATORS.join(' / ')}）`,
    );
  }
  const event = fm.event ?? 'PreToolUse';
  if (!EVENT_SET.has(event)) {
    throw new RuleError(`${source}: 不认识的 event "${event}"（支持 ${EVENTS.join(' / ')}）`);
  }
  const { allowed, why } = DECISIONS_BY_EVENT[event];
  const decision = fm.decision ?? DEFAULT_DECISION[event];
  if (!allowed.includes(decision)) {
    throw new RuleError(
      `${source}: 在 ${event} 上写了 decision "${decision}" —— 这个事件上能表达的是 ${allowed.join(' / ')}。${why}`,
    );
  }
  if (fm.operator === 'matches') {
    try {
      new RegExp(fm.pattern);
    } catch (error) {
      throw new RuleError(`${source}: pattern 不是合法的正则：${String(error)}`);
    }
  }

  return {
    rule: {
      name: fm.name,
      // 省略 event = PreToolUse（既有规则文件一个字都不用改）。
      event,
      // 省略 tool = 对所有工具生效（与 hooks.json 的 matcher 同一套语义）。
      tool: fm.tool,
      field: fm.field,
      operator: fm.operator,
      pattern: fm.pattern,
      decision,
      message: fm.message,
      body,
      source,
    },
    warnings,
  };
}

/** matcher：精确名 / `A|B` / `*` / 省略 = 全部。 */
function toolMatches(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  return matcher
    .split('|')
    .map((name) => name.trim())
    .some((name) => name === tool);
}

function test(operator, haystack, pattern) {
  switch (operator) {
    case 'matches':
      return new RegExp(pattern).test(haystack);
    case 'contains':
      return haystack.includes(pattern);
    case 'equals':
      return haystack === pattern;
    case 'starts_with':
      return haystack.startsWith(pattern);
    case 'ends_with':
      return haystack.endsWith(pattern);
    default:
      // parseRule 已经挡掉；真走到这儿说明上面漏了一种算子。当作不匹配，别抛 ——
      // 抛出去会变成整个钩子的 fail，一条规则认识的算子少写了不该让所有工具停摆。
      return false;
  }
}

/**
 * 对一次事件求值。返回 `{ decision, reason }`，或 `undefined`（没意见）。
 *
 * `subject` 是**这个事件给规则看的那个对象**（逐事件一张表，见 README）：
 * PreToolUse 是 `tool_input`、PostToolUse 是 `tool_response`（我们桥成 `{ok, output}`）、
 * UserPromptSubmit 是 `{prompt}`、Stop 是 `{last_assistant_message}`。
 * 它由调用方（`hooks/hook.mjs`）按事件挑好再传进来 —— 这个文件不认识 `hook_event_name`。
 *
 * 只跑 `rule.event === event` 的规则 —— 但**所有**规则文件照旧全部解析，
 * 于是一条写坏了的规则在任何事件上都会让钩子失败（而不是"平时没事，用到才炸"）。
 *
 * 命中里只要有 deny 就是 deny，否则只要有 ask 就是 ask —— 与权限引擎的
 * `deny > ask > allow` 同一条方向，重排规则文件不会换结果。PostToolUse / UserPromptSubmit
 * 上只有 notify，"几个 notify 撞在一起"就是几句理由全列出来。
 *
 * `field` **只取字符串**：键不存在、值不是字符串（数组、对象、数字）→ 这一条不匹配，
 * 不是错误。写规则最常踩的就是"我以为是字符串"。
 */
export function evaluate(rules, event, subject, toolName) {
  const hits = [];
  for (const rule of rules) {
    if (rule.event !== event) continue;
    // 工具名只有 PreToolUse 有。别的三个事件上写了 `tool` 的规则**不命中** ——
    // 那是一条兑现不了的筛选条件，静默放过它会让它看起来生效了。
    if (event === 'PreToolUse') {
      if (!toolMatches(rule.tool, toolName)) continue;
    } else if (rule.tool !== undefined && rule.tool !== '') {
      continue;
    }
    const value = subject !== null && typeof subject === 'object' ? subject[rule.field] : undefined;
    if (typeof value !== 'string') continue;
    if (!test(rule.operator, value, rule.pattern)) continue;
    hits.push(rule);
  }
  if (hits.length === 0) return undefined;

  const decision = hits.some((rule) => rule.decision === 'deny')
    ? 'deny'
    : hits.some((rule) => rule.decision === 'ask')
      ? 'ask'
      : 'notify';
  // 理由只列与最终判定同向的那几条：列上被 deny 盖过的 ask 只会让人以为自己还有得选。
  const decisive = hits.filter((rule) => rule.decision === decision);
  const lines = decisive.map((rule) => `[${rule.name}] ${rule.message}`);
  for (const rule of decisive) {
    if (rule.body !== '') lines.push(`  ${rule.body}`);
  }
  return { decision, reason: lines.join('\n') };
}
