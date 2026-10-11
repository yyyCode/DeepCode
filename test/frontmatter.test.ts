import { describe, expect, it } from 'vitest';
import { parseFrontmatter, readList, readScalar } from '../src/contract/frontmatter';

/** 拼一份带 frontmatter 的文档。`head` 里可以用 \n 写多行。 */
const doc = (head: string, body = '正文'): string => `---\n${head}\n---\n${body}`;

describe('parseFrontmatter', () => {
  it('裸标量、注释与空行', () => {
    const fm = parseFrontmatter(doc('# 这是注释\nname: code-explorer\n\ndescription: 探索代码库'));
    expect(readScalar(fm, 'name')).toBe('code-explorer');
    expect(readScalar(fm, 'description')).toBe('探索代码库');
  });

  it('双引号标量认 \\n 与 \\" 转义', () => {
    const fm = parseFrontmatter(doc('description: "第一行\\n第二行说 \\"你好\\""'));
    expect(readScalar(fm, 'description')).toBe('第一行\n第二行说 "你好"');
  });

  it('JSON 数组写法', () => {
    const fm = parseFrontmatter(doc('tools: ["Read", "Grep"]'));
    expect(readList(fm, 'tools')).toEqual(['Read', 'Grep']);
  });

  it('逗号串写法', () => {
    const fm = parseFrontmatter(doc('tools: Glob, Grep, Read'));
    expect(readList(fm, 'tools')).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('没加引号的方括号写法也认', () => {
    const fm = parseFrontmatter(doc('tools: [Read, Grep]'));
    expect(readList(fm, 'tools')).toEqual(['Read', 'Grep']);
  });

  // 这一条是 §3 末段那个分工的钉子：逗号切分**不能**长在通用解析器里。
  // 参考实现里的 description 常含逗号，一刀切下去会把一句描述变成数组。
  it('description 里的逗号不会被切成数组', () => {
    const fm = parseFrontmatter(
      doc('description: review code for adherence to guidelines, style guides, and best practices'),
    );
    expect(readScalar(fm, 'description')).toBe(
      'review code for adherence to guidelines, style guides, and best practices',
    );
  });

  it('body 原样取出，且不含紧邻结束标记的那个换行', () => {
    const fm = parseFrontmatter(doc('name: x', '你是审查者。\n\n规则：只说问题。'));
    expect(fm.body).toBe('你是审查者。\n\n规则：只说问题。');
  });

  it('readList 对不存在的字段返回 undefined（不是空数组）', () => {
    const fm = parseFrontmatter(doc('name: x'));
    expect(readList(fm, 'tools')).toBeUndefined();
  });

  it('没有 frontmatter → 抛', () => {
    expect(() => parseFrontmatter('# 只有正文\nname: x')).toThrow(/缺少 frontmatter/);
  });

  it('没有结束的 --- → 抛', () => {
    expect(() => parseFrontmatter('---\nname: x\n正文')).toThrow(/没有结束/);
  });

  it('多行标量 → 抛，且消息里带行号', () => {
    expect(() => parseFrontmatter(doc('name: x\ndescription: |\n  很长的一段'))).toThrow(/第 3 行/);
  });

  it('重复键 → 抛', () => {
    expect(() => parseFrontmatter(doc('name: x\nname: y'))).toThrow(/重复/);
  });

  it('引号没闭合 → 抛', () => {
    expect(() => parseFrontmatter(doc('name: "x'))).toThrow(/引号/);
  });
});
