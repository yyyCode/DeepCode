/**
 * 最小 frontmatter 解析器。纯函数、零 IO、零依赖 —— contract/ 的边界不破。
 *
 * 为什么不装个 yaml：零运行时依赖是这个项目的既有承诺（package.json 里只有
 * devDependencies），为十来个标量字段破这个戒不值得。
 *
 * 认识的就这些：
 *   key: value                裸标量
 *   key: "带 \n 转义"          双引号标量（认 \n \" \\，其余转义原样保留）
 *   key: ["a", "b"]           JSON 数组
 *   key: [a, b]               没加引号的方括号（交给 readList 按逗号切）
 *   # 注释 / 空行              忽略
 *
 * 不认识的一律**抛**（带行号）：多行标量（`|` `>`）、嵌套映射、锚点别名、重复键、
 * 没有冒号的行、引号没闭合。猜一个可能猜错的值，比明说"这一行读不懂"坏得多。
 *
 * ⚠️ 逗号切分**不在这儿**（见 readList）：这个解析器不知道哪个字段是列表，
 * 而 description 常含逗号 —— 在这儿切会把一句描述毁成数组。
 */

export type FrontmatterField = string | readonly string[];

export type Frontmatter = {
  readonly fields: ReadonlyMap<string, FrontmatterField>;
  /** frontmatter 之后的部分，原样（只去掉紧跟结束标记的那一个换行）。 */
  readonly body: string;
};

export function parseFrontmatter(text: string): Frontmatter {
  // CRLF 先归一：Windows 上写出来的文件每一行都带 \r，不归一的话键值尾部会留一个回车。
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('缺少 frontmatter（文件必须以一行 `---` 开头）');
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) throw new Error('frontmatter 没有结束的 `---`');

  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');

  const fields = new Map<string, FrontmatterField>();
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 2; // 第 1 行是那个 `---`
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`第 ${lineNo} 行不是 key: value —— ${line}`);
    const key = line.slice(0, colon).trim();
    if (key === '') throw new Error(`第 ${lineNo} 行没有键名`);
    // 重复键：后一个可能是有意覆盖，也可能是复制粘贴留下的 —— 两种都该被人看见。
    if (fields.has(key)) throw new Error(`第 ${lineNo} 行：键 ${key} 重复了`);

    const value = line.slice(colon + 1).trim();
    if (value === '') {
      fields.set(key, '');
      continue;
    }
    if (value.startsWith('|') || value.startsWith('>')) {
      throw new Error(`第 ${lineNo} 行：不支持多行标量（${value[0]}），请写成一行`);
    }
    fields.set(key, toField(value, lineNo));
  }
  return { fields, body };
}

/** 标量、双引号标量，或（合法 JSON 的）字符串数组。其余原样留着给 readList。 */
function toField(value: string, lineNo: number): FrontmatterField {
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed as readonly string[];
      }
    } catch {
      // 不是合法 JSON —— 大概率是 `[Read, Grep]` 这种没加引号的写法。
      // **不在这里报错**：交给 readList 按逗号切（切分归"知道这是列表"的那一方）。
    }
  }
  return unquote(value, lineNo);
}

function unquote(value: string, lineNo: number): string {
  if (!value.startsWith('"')) return value;
  if (value.length < 2 || !value.endsWith('"')) {
    throw new Error(`第 ${lineNo} 行：引号没有闭合 —— ${value}`);
  }
  const inner = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) throw new Error(`第 ${lineNo} 行：结尾的反斜杠没有内容可转义`);
    i++;
    if (next === 'n') out += '\n';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    // 不认识的转义原样保留：少猜一处，少错一处。
    else out += next;
  }
  return out;
}

/** 取一个字符串字段。字段不存在、或它其实是个数组 → undefined。 */
export function readScalar(fm: Frontmatter, key: string): string | undefined {
  const value = fm.fields.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 取一个列表字段。两种写法都认（设计 §3）：
 *   `tools: ["Read", "Grep"]`  （解析器已经变成数组）
 *   `tools: Read, Grep`        （这里按逗号切）
 *   `tools: [Read, Grep]`      （同上，方括号先剥掉）
 *
 * 字段不存在 → `undefined`，**不是空数组**：调用方靠这个区分"没写"与"写了个空的"，
 * 而这两件事在白名单上的含义完全相反（省略 = 继承全部，空 = 一个都不许用）。
 */
export function readList(fm: Frontmatter, key: string): readonly string[] | undefined {
  const value = fm.fields.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter((item) => item !== '');
}
