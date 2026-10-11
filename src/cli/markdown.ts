import type { Palette } from './ansi';
import { displayWidth } from './width';

/**
 * markdown 的一小块子集。**认哪些写在下面，其余一律原样输出。**
 *
 * 认出 | 认不出（原样输出）
 * --- | ---
 * `#` / `##` / `###` 标题 | 表格、HTML 标签、图片、脚注、任务列表的勾选框
 * `-` / `*` / `+` / `1.` 列表 | 嵌套引用块
 * 围栏代码块 ```lang | 链接的 URL（只留文字，不印 URL）
 * 行内 `` `code` ``、`**粗体**`、`*斜体*` | `> 引用` 的嵌套
 *
 * ⚠️ **硬规则：不认识的语法一个字都不许吃掉。**
 *
 * markdown 渲染最典型的 bug，是把代码里的 `a_b_c` 或 `2 * 3 * 4` 当成强调、
 * 把两个字符吃掉。对一个编码助手来说那是**改坏用户看到的代码** —— 用户会照着
 * 屏幕上那行去改文件，而屏幕上那行从来不是文件里的那行。
 *
 * 所以：强调的定界符必须成对、行内、且**紧贴非空白字符**（开定界符后面不能是空格，
 * 闭定界符前面不能是空格）。这一条就是让 `2 * 3 * 4` 全身而退的那一条，
 * 也是 CommonMark 左右侧翼规则的简化版。`_` 一律不当定界符 —— `a_b_c` 因此在
 * 结构上就不可能被认出来。代码块与行内码里的内容**逐字节原样**，不做任何替换。
 */

export type MarkdownOptions = {
  readonly palette: Palette;
  /** 折到几列。非 TTY 下调用方根本不建这个流（逐字节不变的直接后果）。 */
  readonly width: number;
};

export type MarkdownStream = {
  /** 喂一段增量，拿回**可以立刻写出去**的文本（可能为空）。 */
  push(delta: string): string;
  /** 把行缓冲里最后那半行交出来（没有换行时也要落笔）。 */
  flush(): string;
};

/** 围栏围到几层。今天只认 ```，不认 `~~~`（认不出来就原样输出）。 */
const FENCE = /^(\s*)```(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function createMarkdownStream(options: MarkdownOptions): MarkdownStream {
  const { palette, width } = options;

  // 行缓冲：只在 `\n` 处切。按 **code unit** 拼，**永不按长度切** ——
  // provider 按字节切块时一个多字节字符被切成两半是常态，按长度切会把它切坏。
  let buffer = '';
  // 围栏的状态跨行保持。未闭合就一直是代码块，闭合时补上右下的尾巴。
  let fence: string | undefined;
  // 上一个**真的落了笔**的行是不是空白。标题要上下留白，靠它决定上面那一行添不添。
  let lastBlank = true;
  // 标题下面那一段留白。**延迟到下一行真的来时再补** —— 立刻补的话，
  // 模型自己本来就跟了一个空行，屏幕上会多出一行空白来。
  let blankAfter = false;

  const emit = (line: string): string => {
    if (line === '') {
      lastBlank = true;
      blankAfter = false;
      return '\n';
    }
    const lead = blankAfter && !lastBlank ? '\n' : '';
    blankAfter = false;
    lastBlank = false;
    return `${lead}${line}\n`;
  };

  const renderLine = (line: string): string => {
    if (fence !== undefined) {
      const closing = FENCE.exec(line);
      if (closing !== null && (closing[2] ?? '').trim() === '') {
        fence = undefined;
        return emit(`${palette.dim('╰─')}`);
      }
      // 代码块**不折也不截**：保真优先。终端自己会折，折了不丢一个字节。
      return emit(`${palette.dim('│ ')}${line}`);
    }

    const opening = FENCE.exec(line);
    if (opening !== null) {
      fence = (opening[2] ?? '').trim();
      const label = fence === '' ? '' : ` ${palette.dim(fence)}`;
      return emit(`${palette.dim('╭─')}${label}`);
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      // `#` 本身**不落笔**：层级靠加粗与上下留白表达，一串 `##` 在终端里只是噪音。
      // （关掉色时标题就是一行单独成段的短句 —— 那正是 NO_COLOR 该有的样子。）
      const text = palette.bold(inline(heading[2] ?? '', palette));
      const rendered = `${lastBlank ? '' : '\n'}${emit(text)}`;
      blankAfter = true;
      return rendered;
    }

    const list = LIST.exec(line);
    if (list !== null) {
      const indent = list[1] ?? '';
      const marker = list[2] ?? '';
      return emit(`${indent}${palette.cyan(marker)} ${inline(list[3] ?? '', palette)}`);
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      return emit(palette.dim(`│ ${inline(quote[1] ?? '', palette)}`));
    }

    if (line === '') return emit('');

    // 普通段落：**先认行内语法，再按显示宽度折**。顺序不能反 —— 折了之后再认，
    // 一对 `**` 会被折行切成两半，于是那句粗体永远配不上对、定界符原地留在屏幕上。
    return wrap(inline(line, palette), width).map(emit).join('');
  };

  return {
    push(delta) {
      // 空增量：既不加进缓冲，也不产出。它连一个 code unit 都没有。
      if (delta === '') return '';
      buffer += delta;

      let out = '';
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        out += renderLine(line);
      }
      return out;
    },
    flush() {
      if (buffer === '') return '';
      const rest = buffer;
      buffer = '';
      // 半行也要落笔，但**不加换行**：这一段可能还有下文（模型下一个增量接着写）。
      // 加了换行的话，一句话会被硬拆成两行落进转录，回滚时再也合不回去。
      return renderLine(rest).replace(/\n$/, '');
    },
  };
}

/**
 * 行内：行内码、粗体、斜体、链接。**从左到右扫一遍**，认不出来的字符原样搬走。
 *
 * 这里不写正则的 `replace` 链：那种写法一旦某条规则没匹配上，字符就在原地
 * —— 而"原地"与"被吃掉"只差一个 `[^` 写错。手写扫描器每一步都明确知道
 * 自己前进了几个 code unit。
 */
export function inline(text: string, palette: Palette): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (char === '`') {
      const close = text.indexOf('`', i + 1);
      // 行内码要求：闭合符在同一行、内容非空。认不出就把这个反引号原样搬走。
      if (close > i + 1) {
        out += palette.cyan(text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      out += char;
      i += 1;
      continue;
    }

    if (char === '*') {
      const run = text.startsWith('**', i) ? 2 : 1;
      const close = emphasisClose(text, i + run, run);
      if (close >= 0) {
        const inner = text.slice(i + run, close);
        const rendered = inline(inner, palette);
        out += run === 2 ? palette.bold(rendered) : palette.italic(rendered);
        i = close + run;
        continue;
      }
      // 认不出来：这两个字符（或一个）**原样搬走**，一个都不吃。
      out += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (char === '[' && text[i - 1] !== '!') {
      const matched = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (matched !== null) {
        // 只留文字，不印 URL —— 终端里一条长 URL 折成三行毫无用处。
        out += inline(matched[1] ?? '', palette);
        i += matched[0].length;
        continue;
      }
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * 找配对的闭定界符，找不到返回 -1。
 *
 * 两道门（CommonMark 左右侧翼规则的简化版）：
 * - 开定界符**后面不能是空白** —— `2 * 3 * 4` 的 `*` 后面是空格，当场出局；
 * - 闭定界符**前面不能是空白** —— `a ** b` 不成立。
 *
 * 再加上"闭合符必须在同一行"（`text` 就是一行），于是跨行的那一对永远不会被配对。
 */
function emphasisClose(text: string, from: number, run: number): number {
  const after = text[from];
  if (after === undefined || /\s/.test(after)) return -1;

  const needle = '*'.repeat(run);
  for (let at = from; at < text.length; ) {
    const found = text.indexOf(needle, at);
    if (found < 0) return -1;
    // 闭定界符前面必须是非空白，而且里面得真有东西。
    const before = text[found - 1];
    if (found > from && before !== undefined && !/\s/.test(before)) {
      // `***` 这种：让 `**` 那条先配对，单 `*` 不抢。
      if (run === 1 && text.slice(found, found + 2) === '**') {
        at = found + 2;
        continue;
      }
      return found;
    }
    at = found + run;
  }
  return -1;
}

/**
 * 折到 `width` 列。**中文算 2 列**（见 `width.ts`），按显示宽度而不是字符数。
 *
 * 断点只有两处：空格处，以及任意一个宽字符之前 —— 中文没有空格，不断在宽字符前
 * 等于整段中文一行都折不了。单个"词"本身超宽（一条长路径、一个长 URL）时
 * 只能硬断，但那种情况本来就少，硬断比整行溢出到屏幕外面好。
 */
export function wrap(line: string, width: number): string[] {
  if (width <= 0 || displayWidth(line) <= width) return [line];

  const indent = /^\s*/.exec(line)?.[0] ?? '';
  const indentWidth = displayWidth(indent);
  const body = line.slice(indent.length);

  const out: string[] = [];
  let current = '';
  let currentWidth = 0;
  let spaceAt = -1;

  const push = (): void => {
    out.push(indent + current);
    current = '';
    currentWidth = 0;
    spaceAt = -1;
  };

  for (const char of body) {
    const charWidth = displayWidth(char);
    const limit = width - indentWidth;

    if (currentWidth + charWidth > limit && current !== '') {
      if (spaceAt >= 0) {
        const rest = current.slice(spaceAt + 1);
        current = current.slice(0, spaceAt);
        push();
        current = rest;
        currentWidth = displayWidth(rest);
        // 续行里的断点要重新认一遍，否则 `rest` 后面那一截只能硬断。
        spaceAt = rest.lastIndexOf(' ');
      } else {
        push();
      }
    }

    if (char === ' ') spaceAt = current.length;
    current += char;
    currentWidth += charWidth;
  }

  if (current !== '') out.push(indent + current);
  return out.length === 0 ? [''] : out;
}
