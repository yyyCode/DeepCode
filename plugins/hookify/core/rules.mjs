/**
 * hookify 的纯逻辑：解析一份规则文件、对一次工具调用求值。
 *
 * 没有 IO —— 读文件、读 stdin、写 stdout 全在 hooks/pretooluse.mjs 里。
 * 这样拆是为了让"规则说什么、命中什么"能被单独看、单独想。
 *
 * 判定词汇只有 deny / ask：写 allow 是**错误**，不是静默降级。
 * 参考实现的 hookify 允许 allow，但它读的是参考实现的钩子协议；在我们的框架里
 * 第三方插件返回的 allow 一律被丢弃（src/cli/classic-hooks.ts:83-92），
 * 于是"支持 allow"只会让人写出一条看起来生效、其实什么都不做的规则。
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
const DECISIONS = new Set(['deny', 'ask']);
const KNOWN_KEYS = new Set(['name', 'tool', 'field', 'operator', 'pattern', 'decision', 'message']);
const REQUIRED = ['name', 'field', 'operator', 'pattern', 'message'];

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
  const decision = fm.decision ?? 'deny';
  if (!DECISIONS.has(decision)) {
    throw new RuleError(
      `${source}: decision 只能是 deny / ask，给的是 "${decision}"。` +
        `allow 是表达不出来的 —— 第三方插件只能拧紧不能拧松，一条放行规则在这里只会是空头承诺。`,
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
 * 对一次工具调用求值。返回 `{ decision, reason }`，或 `undefined`（没意见）。
 *
 * 命中里只要有 deny 就是 deny，否则只要有 ask 就是 ask —— 与权限引擎的
 * `deny > ask > allow` 同一条方向，重排规则文件不会换结果。
 *
 * `field` **只取字符串**：键不存在、值不是字符串（数组、对象、数字）→ 这一条不匹配，
 * 不是错误。写规则最常踩的就是"我以为是字符串"。
 */
export function evaluate(rules, toolName, input) {
  const hits = [];
  for (const rule of rules) {
    if (!toolMatches(rule.tool, toolName)) continue;
    const value = input !== null && typeof input === 'object' ? input[rule.field] : undefined;
    if (typeof value !== 'string') continue;
    if (!test(rule.operator, value, rule.pattern)) continue;
    hits.push(rule);
  }
  if (hits.length === 0) return undefined;

  const decision = hits.some((rule) => rule.decision === 'deny') ? 'deny' : 'ask';
  // 理由只列与最终判定同向的那几条：列上被 deny 盖过的 ask 只会让人以为自己还有得选。
  const decisive = hits.filter((rule) => rule.decision === decision);
  const lines = decisive.map((rule) => `[${rule.name}] ${rule.message}`);
  for (const rule of decisive) {
    if (rule.body !== '') lines.push(`  ${rule.body}`);
  }
  return { decision, reason: lines.join('\n') };
}
