/**
 * 显示宽度：一段文字在终端里占几列。
 *
 * **只分三档**：宽（2 列）/ 窄（1 列）/ 零宽。不做完整 Unicode 表 —— 代价已经在
 * P6 设计 §4.3 登记过：emoji 的 ZWJ 序列、变体选择符、以及区间外的少数宽字符会
 * 算错一列。算错一列的后果是一个框线歪一格，为此引一张完整表（或一个依赖）不划算。
 *
 * 它服务的是"活动区的每一行都必须**恰好**占一行"这条硬要求：终端里一行折了行，
 * 屏幕上的行数就与我们的账面不符，`\u001b[<n>A` 上移几行立刻算错，活动区会一路
 * 往上啃掉已经落地的正文。所以宁可截断，绝不能溢出。
 */

/** 宽字符：占 2 列。区间取 EastAsianWidth 的 W/F 里最常见的那些。 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首扩展、康熙部首、CJK 符号与标点
  [0x3041, 0x33ff], // 平假名 / 片假名 / 注音 / 中日韩兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f], // 谚文扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排标点
  [0xfe30, 0xfe6f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 常见 emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // CJK 扩展 B 及以后
  [0x30000, 0x3fffd],
];

/** 零宽：组合附加符、零宽空格与方向标记、变体选择符、BOM。 */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** 生成 SGR 序列的转义串（`\u001b[1m` 这种）。测宽度时要跳过它。 */
const SGR = /\u001b\[[0-9;]*m/g;

export function displayWidth(text: string): number {
  let width = 0;
  // 转义序列不占列：着色之后的活动行照样得按可见宽度截断。
  const plain = text.replace(SGR, '');
  for (const char of plain) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (inRanges(cp, ZERO)) continue;
    width += inRanges(cp, WIDE) ? 2 : 1;
  }
  return width;
}

/**
 * 截到 `width` 列以内。**超了就补一个 `…`** —— 截断必须是看得见的，
 * 悄悄少几个字与"这一段本来就只有这么长"长得一模一样，那是两回事。
 */
export function fitTo(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;

  // 留一列给省略号本身。
  const budget = width - 1;
  let used = 0;
  let cut = '';
  let sawSgr = false;
  for (let i = 0; i < text.length; ) {
    // 转义序列：整段搬走，且要记下"这段文字是有颜色的"（截断之后得补重置，
    // 否则颜色会顺着漏到后面已经落地的那几行上去）。
    if (text[i] === '\u001b') {
      SGR.lastIndex = i;
      const matched = SGR.exec(text);
      if (matched !== null && matched.index === i) {
        cut += matched[0];
        sawSgr = true;
        i += matched[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const char = String.fromCodePoint(cp);
    const w = inRanges(cp, ZERO) ? 0 : inRanges(cp, WIDE) ? 2 : 1;
    if (used + w > budget) break;
    cut += char;
    used += w;
    i += char.length;
  }
  return sawSgr ? `${cut}…\u001b[0m` : `${cut}…`;
}

/**
 * 活动区可用的列数。**拿不到就当 80** —— 这不是在猜，是给一个不会崩的默认：
 * 有些终端（尤其 Windows 上）即使 stdin/stdout 是 TTY 也不报 `columns`。
 *
 * 非 TTY 下根本不该调它：活动面在非 TTY 下整个是 no-op（见 `render.ts`）。
 */
export function activityWidth(columns: number | undefined): number {
  return columns !== undefined && columns > 0 ? columns : 80;
}
