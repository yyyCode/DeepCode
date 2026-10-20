// test/skills.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from '@deepcode/cli/skills';

let root = '';
let home = '';

/** 往 `<base>/.deepcode/skills/<dir>/SKILL.md` 写一个技能。 */
async function put(base: string, dirName: string, content: string): Promise<string> {
  const dir = join(base, '.deepcode', 'skills', dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content);
  return dir;
}

const doc = (head: string, body = '正文：这个项目怎么写文档。'): string =>
  `---\n${head}\n---\n${body}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-skills-'));
  home = await mkdtemp(join(tmpdir(), 'deepcode-skills-home-'));
});

describe('技能名册', () => {
  it('读进来：name / description / body / dir', async () => {
    const dir = await put(root, 'design-notes', doc('name: design-notes\ndescription: 本项目的设计口径'));
    const skills = await discoverSkills({ root, home });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('design-notes');
    expect(skills[0]?.description).toBe('本项目的设计口径');
    expect(skills[0]?.body).toBe('正文：这个项目怎么写文档。');
    // dir 是承重的：第三层靠它 + 模型自己的 Read（设计 §10.1）。
    expect(skills[0]?.dir).toBe(dir);
  });

  it('没写 name → 用目录名兜底 + warn', async () => {
    const warns: string[] = [];
    await put(root, 'design-notes', doc('description: d'));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills[0]?.name).toBe('design-notes');
    expect(warns.some((l) => l.includes('兜底'))).toBe(true);
  });

  it('目录里没有 SKILL.md → warn + 不装，别的技能不受牵连', async () => {
    const warns: string[] = [];
    await mkdir(join(root, '.deepcode', 'skills', 'empty'), { recursive: true });
    await put(root, 'good', doc('name: good\ndescription: d'));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(warns.some((l) => l.includes('SKILL.md'))).toBe(true);
  });

  it('description 超 500 → 截断到 500 + warn', async () => {
    const warns: string[] = [];
    const long = 'x'.repeat(600);
    await put(root, 'big', doc(`name: big\ndescription: ${long}`));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills[0]?.description).toHaveLength(500);
    expect(warns.some((l) => l.includes('截断'))).toBe(true);
  });

  it('没有 description → warn + 不装', async () => {
    const warns: string[] = [];
    await put(root, 'a', doc('name: a'));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills).toHaveLength(0);
    expect(warns.some((l) => l.includes('description'))).toBe(true);
  });

  it('正文是空的 → warn + 仍然装', async () => {
    const warns: string[] = [];
    await put(root, 'a', doc('name: a\ndescription: d', ''));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills).toHaveLength(1);
    expect(warns.some((l) => l.includes('空的'))).toBe(true);
  });

  it('frontmatter 坏掉 → warn + 不装', async () => {
    const warns: string[] = [];
    await put(root, 'bad', 'name: bad\n没有 frontmatter 标记');
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills).toHaveLength(0);
    expect(warns.some((l) => l.includes('frontmatter'))).toBe(true);
  });

  it('目录不存在 → 安静', async () => {
    const warns: string[] = [];
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills).toHaveLength(0);
    expect(warns).toEqual([]);
  });

  it('项目级赢用户级，落选那份出声', async () => {
    const warns: string[] = [];
    await put(root, 'a', doc('name: a\ndescription: 项目级'));
    await put(home, 'a', doc('name: a\ndescription: 用户级'));
    const skills = await discoverSkills({ root, home, warn: (l) => warns.push(l) });
    expect(skills[0]?.description).toBe('项目级');
    expect(warns.some((l) => l.includes('项目级目录提供'))).toBe(true);
  });

  it('插件级带命名空间前缀', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'deepcode-plugin-'));
    await mkdir(join(pluginDir, 'skills', 'notes'), { recursive: true });
    await writeFile(join(pluginDir, 'skills', 'notes', 'SKILL.md'), doc('name: notes\ndescription: d'));

    const skills = await discoverSkills({
      root,
      home,
      plugins: [{ name: 'toolkit', dir: pluginDir }],
    });
    expect(skills.map((s) => s.name)).toEqual(['toolkit:notes']);
  });
});
