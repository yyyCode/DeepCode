/**
 * 最小 XML plist 读取器（P5d）—— 只够读托管偏好域。
 *
 * **为什么自己写**：macOS 上读托管偏好域，最省事的做法是 shell 出去让
 * `plutil -convert json` 或 `defaults` 代劳。那也把"能不能读托管策略"绑到了另一个
 * 外部程序的版本与行为上 —— 而 `git` 那件事已经交过一次学费：外部程序的缺席必须是
 * **可测的**（见 `mods/diff/backend.ts` 的探针机制），不是在生产里才暴露。
 * 这个解析器是个纯函数，夹具一喂就完事。
 *
 * **它读不了什么**（写进 README，不藏着）：
 * - 二进制 plist（`bplist00`）—— 托管偏好域用 XML 落盘，真遇到再说；
 * - `<date>` 的时间戳语义（当字符串原样给）与 `<data>` 的 base64 解码（同上）；
 * - 属性（`<string xml:space="preserve">` 之类）—— 读得到标签，属性直接忽略。
 *
 * **它不许安静地吞东西**：不认识的标签、对不上的闭合、标签外面冒出来的文本，
 * 一律抛错。安静地少读一个 `<dict>` 等于安静地丢掉一段组织下发的策略 ——
 * 那是这个项目最想防的失败形状。
 */

type Token =
  | { readonly kind: 'open'; readonly name: string; readonly selfClosing: boolean }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string };

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;

/**
 * 剥掉 XML 序言：`<?xml ...?>`、注释、DTD。
 *
 * DOCTYPE 那一条要特别小心：它可能带一段 `[ ... ]` 内部子集，里面还有 `>`（实体声明）。
 * 只找第一个 `>` 会从中间截断，剩下的残渣会被当成标签 —— 所以带方括号时要一直吃到 `]` 之后的那个 `>`。
 */
function stripProlog(xml: string): string {
  let out = xml.replace(/<\?[\s\S]*?\?>/g, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  for (;;) {
    const at = out.indexOf('<!');
    if (at === -1) break;
    const bracket = out.indexOf('[', at);
    const gt = out.indexOf('>', at);
    if (gt === -1) break;
    // 方括号在 `>` 之前 → 这一段是带内部子集的 DTD，结束时点要往后找。
    const end = bracket !== -1 && bracket < gt ? out.indexOf(']>', bracket) : -1;
    const stop = end === -1 ? gt : out.indexOf('>', end);
    if (stop === -1) break;
    out = out.slice(0, at) + out.slice(stop + 1);
  }
  return out;
}

function tokenize(xml: string): readonly Token[] {
  const src = stripProlog(xml);
  const tokens: Token[] = [];
  let last = 0;

  TAG_RE.lastIndex = 0;
  for (let hit = TAG_RE.exec(src); hit !== null; hit = TAG_RE.exec(src)) {
    const between = src.slice(last, hit.index).trim();
    if (between !== '') tokens.push({ kind: 'text', text: between });
    last = hit.index + hit[0].length;

    const name = hit[2];
    if (name === undefined) continue;
    if (hit[1] === '/') tokens.push({ kind: 'close', name });
    else tokens.push({ kind: 'open', name, selfClosing: hit[4] === '/' });
  }

  const tail = src.slice(last).trim();
  if (tail !== '') tokens.push({ kind: 'text', text: tail });
  return tokens;
}

/**
 * XML 实体。`&amp;` **最后**解 —— 反过来的话 `&amp;lt;` 会被解成 `<`，
 * 而它本意是一个字面量的 `&lt;`。
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 读"一段文本 + 配对的闭合标签"。`<string></string>` 与 `<string/>` 都算空串。 */
function textThenClose(
  tokens: readonly Token[],
  at: number,
  name: string,
): readonly [string, number] {
  let text = '';
  let cursor = at;
  const token = tokens[cursor];
  if (token !== undefined && token.kind === 'text') {
    text = token.text;
    cursor += 1;
  }
  const close = tokens[cursor];
  if (close === undefined || close.kind !== 'close' || close.name !== name) {
    throw new Error(`plist: <${name}> 没有配上 </${name}>`);
  }
  return [decodeEntities(text), cursor + 1];
}

function parseArray(tokens: readonly Token[], at: number): readonly [unknown[], number] {
  const out: unknown[] = [];
  let cursor = at;
  for (;;) {
    const token = tokens[cursor];
    if (token === undefined) throw new Error('plist: <array> 没有配上 </array>');
    if (token.kind === 'close') {
      if (token.name !== 'array') throw new Error(`plist: array 里撞上了 </${token.name}>`);
      return [out, cursor + 1];
    }
    const [value, next] = parseValue(tokens, cursor);
    out.push(value);
    cursor = next;
  }
}

function parseDict(tokens: readonly Token[], at: number): readonly [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let cursor = at;
  for (;;) {
    const token = tokens[cursor];
    if (token === undefined) throw new Error('plist: <dict> 没有配上 </dict>');
    if (token.kind === 'close') {
      if (token.name !== 'dict') throw new Error(`plist: dict 里撞上了 </${token.name}>`);
      return [out, cursor + 1];
    }
    if (token.kind !== 'open' || token.name !== 'key') {
      const found = token.kind === 'open' ? `<${token.name}>` : `文本「${token.text}」`;
      throw new Error(`plist: dict 里出现了不是 <key> 的东西（${found}）`);
    }
    const [rawKey, afterKey] = token.selfClosing
      ? (['', cursor + 1] as const)
      : textThenClose(tokens, cursor + 1, 'key');
    // 重复的键**抛错**而不是后写覆盖：两份策略在抢同一个键，安静地取一个最坏。
    // 与 `parseRegistryQuery` 里"路径抢键"那条同一条口径。
    if (Object.hasOwn(out, rawKey)) throw new Error(`plist: dict 里出现了重复的键「${rawKey}」`);

    const [value, next] = parseValue(tokens, afterKey);
    out[rawKey] = value;
    cursor = next;
  }
}

function parseValue(tokens: readonly Token[], at: number): readonly [unknown, number] {
  const token = tokens[at];
  if (token === undefined) throw new Error('plist: 内容在读完之前就结束了');
  if (token.kind === 'text') throw new Error(`plist: 标签外面出现了文本「${token.text}」`);
  if (token.kind === 'close') throw new Error(`plist: 撞上了意外的 </${token.name}>`);

  const { name } = token;
  const KNOWN = new Set(['string', 'data', 'date', 'integer', 'real', 'array', 'dict', 'true', 'false']);
  // 认不认识**先判**：不然 `<weird/>` 会先撞上"自闭合不合法"，报出一句让人往错方向查的话。
  if (!KNOWN.has(name)) throw new Error(`plist: 不认识的标签 <${name}>`);

  if (name === 'true' || name === 'false') {
    if (!token.selfClosing) throw new Error(`plist: <${name}> 该是自闭合的`);
    return [name === 'true', at + 1];
  }
  if (token.selfClosing) {
    if (name === 'string' || name === 'data' || name === 'date') return ['', at + 1];
    throw new Error(`plist: <${name}/> 这种自闭合的写法不合法`);
  }

  switch (name) {
    case 'string':
    case 'data':
    case 'date':
      return textThenClose(tokens, at + 1, name);
    case 'integer': {
      const [text, next] = textThenClose(tokens, at + 1, name);
      const value = Number.parseInt(text, 10);
      if (Number.isNaN(value)) throw new Error(`plist: <integer>${text}</integer> 不是一个整数`);
      return [value, next];
    }
    case 'real': {
      const [text, next] = textThenClose(tokens, at + 1, name);
      const value = Number.parseFloat(text);
      if (Number.isNaN(value)) throw new Error(`plist: <real>${text}</real> 不是一个数`);
      return [value, next];
    }
    case 'array':
      return parseArray(tokens, at + 1);
    case 'dict':
      return parseDict(tokens, at + 1);
    default:
      throw new Error(`plist: 不认识的标签 <${name}>`);
  }
}

/**
 * 读一份 XML plist，给出等价于 `JSON.parse` 的那个值。
 *
 * 顶层允许带 `<plist>` 外壳（`defaults export` 的输出就是这样），也允许直接给一个值。
 */
export function parsePlist(xml: string): unknown {
  const tokens = tokenize(xml);
  const head = tokens[0];
  if (head === undefined) throw new Error('plist: 里面什么都没有');
  if (head.kind === 'text') throw new Error(`plist: 标签外面出现了文本「${head.text}」`);

  const wrapped = head.kind === 'open' && head.name === 'plist';
  const [value, next] = parseValue(tokens, wrapped ? 1 : 0);

  if (wrapped) {
    const close = tokens[next];
    if (close === undefined || close.kind !== 'close' || close.name !== 'plist') {
      throw new Error('plist: <plist> 没有配上 </plist>');
    }
    const extra = tokens[next + 1];
    if (extra !== undefined) throw new Error(`plist: </plist> 之后还有内容（<${extra.kind === 'text' ? extra.text : extra.name}>）`);
    return value;
  }

  const extra = tokens[next];
  if (extra !== undefined) {
    throw new Error(`plist: 顶层值之后还有内容（<${extra.kind === 'text' ? extra.text : extra.name}>）`);
  }
  return value;
}
