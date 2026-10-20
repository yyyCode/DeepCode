import type { Behavior, Rule } from './policy';
import { expandHome, slashes, squeeze } from './policy';

/**
 * 沙箱配置。**类型住 contract** —— `core/nouns/process.ts` 要读它，不能反过来依赖 `cli/`。
 *
 * 规则形状与权限规则**完全同一种**（`Rule`），于是匹配复用 `matchesRule`，不另写一套。
 */
export type SandboxConfig = {
  readonly enabled: boolean;
  /** 各层并集。任何来源都能往这儿加 —— 它只会让沙箱更严。 */
  readonly deny: readonly Rule[];
  /** 白名单。**只有托管层（`policy`）能设**；其余来源设了会被忽略并出声。 */
  readonly allow: readonly Rule[];
};

/**
 * 一条沙箱路径 → `Rule`。
 *
 * 这里**不调 `parseRule`**：设置文件里写的是裸路径（`/etc/**`），不是 `工具(参数)` 形式的规则，
 * `parseRule` 会因为 `工具名 "/etc/**" 不合法` 直接判错。但它归一用的是**同一组助手**，
 * 形状与 `parseRule('Write(/etc/**)', 'deny', home)` 逐字节相同 —— `test/sandbox.test.ts`
 * 里有一条断言把两者钉在一起。
 *
 * `tool` 恒为 `'Write'`：**文本分析分不出 `cat /x` 与 `rm /x`**，既然分不出就一律按写算 ——
 * 严的方向错好过松的方向错。
 */
export function sandboxRule(text: string, decision: Behavior, home: string): Rule {
  return {
    raw: text,
    tool: 'Write',
    content: slashes(squeeze(expandHome(text, home))).replace(/\/+/g, '/'),
    decision,
  };
}

/** 只看重定向符号的那几个 token：`>`、`>>`、`2>`、`1>>`、`<`。 */
const REDIRECT_ONLY = /^(?:\d*>>|\d*>|\d*<)+$/;
/** 挂在 token 头上的重定向符号：`>/tmp/x`、`2>/tmp/x`。 */
const REDIRECT_HEAD = /^(?:\d*>>|\d*>|\d*<)+/;

/**
 * 从一条 shell 命令里取出**可能被写到的**路径候选（原样 token：不解析、不展开 `~`、不归一斜杠）。
 *
 * ⚠️ **这是文本分析，不是 shell 解析器。** `x=/etc/passwd; rm $x`、`rm $(echo /etc/passwd)`、
 * `cd /etc && ...` 全都绕得过去。候选提取的规则一律朝**保守**方向偏（宁可多取不可漏取），
 * 因为漏取是 fail-open。它的准确率是"我们信这组 fixture"，不是"我们量过"。
 *
 * 取法：
 * 1. 按空白切 token，认单双引号（引号内的空白不切，引号本身剥掉）。
 * 2. 重定向目标一律算 —— `> out.txt` 里的 `out.txt` 是个纯词，但它就是要被写的地方。
 * 3. 第一个 token 是命令名：**带路径的**（`/usr/bin/rm`）算候选，裸名（`rm`）跳过。
 * 4. 旗标（`-` 开头）跳过；但**旗标里挂着的路径要拆出来**（`--out=/etc/x`）。
 * 5. 其余 token：含 `/` 或 `\`、或以 `~` 开头 → 候选。
 *    **纯词不算** —— `git commit -m "fix bug"` 里那些词解析成相对路径全是假的，
 *    而相对路径又要按 cwd 解析，假阳性会把正常命令全拒掉。
 */
export function candidatePaths(command: string): readonly string[] {
  const tokens = splitTokens(command);
  const out: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const prev = index === 0 ? undefined : tokens[index - 1]!;

    // 2. 上一个 token 是光秃秃的重定向符号 → 这个就是目标，无条件算。
    if (prev !== undefined && REDIRECT_ONLY.test(prev)) {
      out.push(token);
      continue;
    }
    if (index === 0) {
      // 3. 命令名：带路径的算候选（`/usr/bin/rm -rf /x` 里的前半截）。
      if (looksLikePath(token) || token.startsWith('~')) out.push(token);
      continue;
    }
    if (REDIRECT_ONLY.test(token)) continue; // 光秃秃的重定向符号本身不是路径

    // `>/tmp/o`、`2>/tmp/e`：把符号从 token 头上剥掉再判。
    const bare = token.replace(REDIRECT_HEAD, '');
    if (bare === '') continue;

    if (bare.startsWith('-')) {
      // 4. 旗标里挂着路径：`--out=/etc/x` 的值那一半才像路径，整串不像。
      const eq = bare.indexOf('=');
      const value = eq === -1 ? '' : bare.slice(eq + 1);
      if (value !== '' && (looksLikePath(value) || value.startsWith('~'))) out.push(value);
      continue;
    }

    if (looksLikePath(bare) || bare.startsWith('~')) out.push(bare);
  }

  return out;
}

function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('\\');
}

/**
 * 按空白切 token，认单双引号。**不做转义处理**（`\ ` 当普通反斜杠看）——
 * 与整个函数的定位一致：保守、够用、不假装是解析器。
 */
function splitTokens(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}
