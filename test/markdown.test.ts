import { describe, expect, it } from 'vitest';
import { createPalette } from '../src/cli/ansi';
import { createMarkdownStream, inline, wrap } from '../src/cli/markdown';
import { createRenderer } from '../src/cli/render';
import { displayWidth } from '../src/cli/width';

const plain = createPalette(false);
const stream = (width = 80) => createMarkdownStream({ palette: plain, width });

/** 一整个输入当成一次增量喂进去（末尾再 flush），拿回落到屏幕上的东西。 */
function renderAll(text: string, width = 80): string {
  const md = stream(width);
  return md.push(text) + md.flush();
}

describe('markdown —— 不认识的语法一个字都不许吃掉', () => {
  // ⚠️ 这一组是**改坏用户看到的代码**的那一类 bug 的笼子。markdown 渲染最典型的坑，
  // 是把 `a_b_c` 或 `2 * 3 * 4` 当成强调、把两个字符吃掉 —— 而用户会照着屏幕上
  // 那行去改文件，屏幕上那行从来不是文件里的那行。
  const untouched = [
    'a_b_c',
    '2 * 3 * 4',
    '费用 * 2 * 3',
    '**',
    '***',
    'a * b',
    '| 表格 | 列 |',
    '|---|---|',
    '<div class="x">',
    '![图](a.png)',
    '#没有空格所以不是标题',
    '---',
    '1.不带空格的也不是列表',
  ];

  it.each(untouched)('行内：%s 原样通过', (text) => {
    expect(inline(text, plain)).toBe(text);
  });

  it.each(untouched)(`整行：%s 落笔后仍逐字节在里面`, (text) => {
    // 有些行会被当**块**处理（`---` 不是列表、`|…|` 原样、`#没有空格` 不是标题），
    // 所以这里断言的是"原文一字不少地还在"，而不是"整行完全等于原文"。
    const out = renderAll(`${text}\n`);
    expect(out).toContain(text);
  });

  it('行内码里的内容是逐字节原样的 —— 里面的强调、列表、标题都不认', () => {
    expect(inline('`a_b_c **x** # y`', plain)).toBe('a_b_c **x** # y');
  });

  it('未闭合的围栏不会吃掉里面的字符', () => {
    const out = renderAll('```ts\na_b_c **x**\n');
    // 认出来了 —— 于是有框线；但**内容一个字符都没少**。
    expect(out).toContain('╭─');
    expect(out).toContain('a_b_c **x**');
  });

  it('未闭合的 `**` 原样落笔，不会等到下一行去凑对', () => {
    const out = renderAll('**没闭合\n第二行**\n');
    expect(out).toContain('**没闭合');
    expect(out).toContain('第二行**');
  });
});

describe('markdown —— 认出来的那些', () => {
  it('标题：`#` 不落笔，层级靠加粗与上下留白', () => {
    // 挤在一起时才补上面那一行空白，而下面那一段留白**延迟到下一行真的来时**再补 ——
    // 否则模型自己跟的那个空行会让屏幕上多出一行。
    expect(renderAll('上面一句\n## 小标题\n下面一句\n')).toBe('上面一句\n\n小标题\n\n下面一句\n');
  });

  it('标题本来就上下有空白时，不再无中生有多加空行', () => {
    expect(renderAll('上面一句\n\n## 小标题\n\n下面一句\n')).toBe('上面一句\n\n小标题\n\n下面一句\n');
  });

  it('列表认，`*` 与 `1.` 都认', () => {
    expect(renderAll('- 一条\n')).toBe('- 一条\n');
    expect(renderAll('1. 第一条\n')).toBe('1. 第一条\n');
  });

  it('引用整行变暗（关掉色时就是原样）', () => {
    expect(renderAll('> 引用\n')).toBe('│ 引用\n');
  });

  it('围栏代码块：左边框 + 语言标签，闭合补右下角', () => {
    const out = renderAll('```ts\nconst a = 1;\n```\n');
    expect(out).toBe('╭─ ts\n│ const a = 1;\n╰─\n');
  });

  it('链接只留文字，URL 一个字都不印', () => {
    expect(inline('看 [设计文档](https://example.com/very/long/url) 那节', plain)).toBe(
      '看 设计文档 那节',
    );
  });

  it('粗体与斜体上色（开着色时才有转义串）', () => {
    const color = createPalette(true);
    expect(inline('**粗**', color)).toBe('\u001b[1m粗\u001b[0m');
    expect(inline('*斜*', color)).toBe('\u001b[3m斜\u001b[0m');
  });
});

describe('markdown —— 折行按显示宽度，不按字符数', () => {
  it('中文一行折出来的每一段都不超过宽度', () => {
    const text = '这是一段很长的中文说明文字'.repeat(4);
    for (const width of [20, 60, 80]) {
      const lines = wrap(text, width);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('窄屏下中文标题与代码块的框线都不越界', () => {
    const source = ['## 一个中文小标题用来撑宽度', '', '```ts', 'const a = 1;', '```', ''].join('\n');
    for (const width of [60, 80, 120]) {
      const out = renderAll(source, width);
      for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('折行保留缩进 —— 列表项的续行不会回到第一列去', () => {
    const lines = wrap('  - 一条很长很长很长很长很长的中文列表项', 14);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith('  ')).toBe(true);
  });
});

describe('渲染器 —— 内容面挂在哪条路上', () => {
  function tty(columns = 80): { stream: NodeJS.WriteStream; text: () => string } {
    let text = '';
    const stream = {
      isTTY: true,
      columns,
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
      on: () => stream,
    };
    return { stream: stream as unknown as NodeJS.WriteStream, text: () => text };
  }

  it('TTY 里模型的话过一遍 markdown', () => {
    const out = tty();
    const render = createRenderer({ stream: out.stream, live: true, palette: plain });
    render.delta('看 `parse.ts` 里的 **空串分支**\n');
    expect(out.text()).toBe('看 parse.ts 里的 空串分支\n');
  });

  it('**非 TTY 下逐字节原样** —— markdown 会改字节，管道里那些都是污染', () => {
    const out = tty();
    const render = createRenderer({ stream: out.stream, live: false });
    render.delta('看 `parse.ts` 里的 **空串分支**\n');
    expect(out.text()).toBe('看 `parse.ts` 里的 **空串分支**\n');
  });

  it('折行按终端宽度走', () => {
    const out = tty(20);
    const render = createRenderer({ stream: out.stream, live: true, palette: plain });
    render.delta('这是一段很长很长的中文说明文字\n');
    for (const line of out.text().split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(20);
  });

  it('半句话在 newline() 时落笔 —— 不然它会掉到下一行永久行的后面去', () => {
    const out = tty();
    const render = createRenderer({ stream: out.stream, live: true, palette: plain });
    render.delta('说到一半');
    expect(out.text()).toBe('');
    render.settle(['⏺ Read  a.ts']);
    // 半句话先落地，紧跟着才是工具那两行 —— 顺序不能反。
    expect(out.text()).toBe('说到一半\n⏺ Read  a.ts\n');
  });
});

describe('markdown —— 流式：一个字符一块与整段一次，逐字节相同', () => {
  it('带未闭合代码块的那一段', () => {
    const source = '# 标题\n\n一段话里有 `code` 与 **粗体**。\n\n```ts\nconst a = 1;\nconst b = 2;\n';

    const whole = renderAll(source);

    const md = stream();
    let drip = '';
    for (const char of source) drip += md.push(char);
    drip += md.flush();

    expect(drip).toBe(whole);
  });

  it('半行不落笔 —— 没等到换行就什么都不输出', () => {
    const md = stream();
    expect(md.push('我先看看')).toBe('');
    expect(md.flush()).toBe('我先看看');
  });

  it('多字节字符被切成两半也拼得回来（按 code unit 拼，永不按长度切）', () => {
    const source = '这是一句话\n';
    const bytes = Buffer.from(source, 'utf8');

    const md = stream();
    let out = '';
    // 按**字节**切块 —— provider 干的就是这件事，一个汉字会被切成三块。
    for (const byte of bytes) out += md.push(Buffer.from([byte]).toString('latin1'));
    out += md.flush();

    // 上面那一步把字节当 latin1 拼回来了，所以比的是**字节**。
    expect(Buffer.from(out, 'latin1').toString('utf8')).toBe(source);
  });
});
