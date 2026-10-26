// test/agents.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAgents } from '../src/cli/agents';
import { BUILTIN_AGENTS } from '../src/cli/builtin-agents';

let root = '';
let home = '';

/** 往 `<base>/.deepcode/agents/<file>` 写一个文件。 */
async function put(base: string, file: string, content: string): Promise<void> {
  const dir = join(base, '.deepcode', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}

const doc = (head: string, body = '你是探索者。'): string => `---\n${head}\n---\n${body}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-agents-'));
  home = await mkdtemp(join(tmpdir(), 'deepcode-agents-home-'));
});

afterEach(() => {
  home = '';
});

describe('agent 名册：基本解析', () => {
  it('项目级 agent 读进来，正文是 prompt', async () => {
    await put(root, 'explorer.md', doc('name: explorer\ndescription: 深入探索代码库', '你是探索者。\n\n只说结论。'));
    const agents = await discoverAgents({ root, home });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('explorer');
    expect(agents[0]?.description).toBe('深入探索代码库');
    expect(agents[0]?.prompt).toBe('你是探索者。\n\n只说结论。');
  });

  it('tools 的两种写法：逗号串与 JSON 数组', async () => {
    await put(root, 'a.md', doc('name: a\ndescription: d\ntools: Read, Grep'));
    await put(root, 'b.md', doc('name: b\ndescription: d\ntools: ["Glob", "Bash"]'));
    const agents = await discoverAgents({ root, home });
    expect(agents.find((a) => a.name === 'a')?.tools).toEqual(['Read', 'Grep']);
    expect(agents.find((a) => a.name === 'b')?.tools).toEqual(['Glob', 'Bash']);
  });

  // 这两条是一对：**"没写"与"写了个空的"含义完全相反**（省略 = 继承全部，空 = 一个都不许用），
  // 所以 readList 在字段不存在时返回 undefined，这里必须原样保住这个区别。
  it('省略 tools → 字段是 undefined（= 继承父级全部）', async () => {
    await put(root, 'a.md', doc('name: a\ndescription: d'));
    const agents = await discoverAgents({ root, home });
    expect(agents[0]?.tools).toBeUndefined();
  });

  it('tools: [] → 空数组（= 一个工具都不许用）', async () => {
    await put(root, 'a.md', doc('name: a\ndescription: d\ntools: []'));
    const agents = await discoverAgents({ root, home });
    expect(agents[0]?.tools).toEqual([]);
  });

  it('disallowedTools 读进来；model 的 inherit 与省略同义', async () => {
    await put(root, 'a.md', doc('name: a\ndescription: d\ndisallowedTools: Bash\nmodel: inherit'));
    await put(root, 'b.md', doc('name: b\ndescription: d\nmodel: haiku'));
    const agents = await discoverAgents({ root, home });
    expect(agents.find((a) => a.name === 'a')?.disallowedTools).toEqual(['Bash']);
    expect(agents.find((a) => a.name === 'a')?.model).toBeUndefined();
    expect(agents.find((a) => a.name === 'b')?.model).toBe('haiku');
  });

  it('maxTurns 要是正整数，坏值忽略', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: d\nmaxTurns: 3'));
    await put(root, 'b.md', doc('name: b\ndescription: d\nmaxTurns: 很多'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents.find((a) => a.name === 'a')?.maxTurns).toBe(3);
    expect(agents.find((a) => a.name === 'b')?.maxTurns).toBeUndefined();
    expect(warns.some((l) => l.includes('maxTurns'))).toBe(true);
  });
});

describe('agent 名册：坏文件不牵连别人', () => {
  it('不认识的字段 → warn + 照样装进来', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: d\ncolor: blue'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents).toHaveLength(1);
    expect(warns.some((l) => l.includes('color'))).toBe(true);
  });

  it('没有 description → warn + 不装（它永远不会被路由到）', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents).toHaveLength(0);
    expect(warns.some((l) => l.includes('description'))).toBe(true);
  });

  it('frontmatter 坏掉 → warn + 不装，旁边的文件不受牵连', async () => {
    const warns: string[] = [];
    await put(root, 'bad.md', 'name: bad\n没有 frontmatter 标记');
    await put(root, 'good.md', doc('name: good\ndescription: d'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents.map((a) => a.name)).toEqual(['good']);
    expect(warns.some((l) => l.includes('frontmatter'))).toBe(true);
  });

  it('没写 name → 用文件名兜底 + warn', async () => {
    const warns: string[] = [];
    await put(root, 'explorer.md', doc('description: d'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents[0]?.name).toBe('explorer');
    expect(warns.some((l) => l.includes('兜底'))).toBe(true);
  });

  it('目录不存在 → 安静（没有一条 warn）', async () => {
    const warns: string[] = [];
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents).toHaveLength(0);
    expect(warns).toEqual([]);
  });
});

describe('agent 名册：三个来源', () => {
  it('项目级与用户级同名 → 项目级赢，落选那份出声', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: 项目级'));
    await put(home, 'a.md', doc('name: a\ndescription: 用户级'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.description).toBe('项目级');
    expect(warns.some((l) => l.includes('项目级目录提供'))).toBe(true);
  });

  it('插件级带命名空间前缀', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'deepcode-plugin-'));
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(join(pluginDir, 'agents', 'reviewer.md'), doc('name: reviewer\ndescription: d'));

    const agents = await discoverAgents({
      root,
      home,
      plugins: [{ name: 'pr-toolkit', dir: pluginDir }],
    });
    expect(agents.map((a) => a.name)).toEqual(['pr-toolkit:reviewer']);
  });

  it('home 兜底成 root 时两个目录重合，不会读两遍也不会互相顶掉', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: d'));
    const agents = await discoverAgents({ root, home: root, warn: (l) => warns.push(l) });
    expect(agents).toHaveLength(1);
    expect(warns.filter((l) => l.includes('提供'))).toEqual([]);
  });
});

describe('agent 名册：只读声明', () => {
  it('readOnly: true 与 tools 一起读进来', async () => {
    await put(root, 'a.md', doc('name: a\ndescription: d\ntools: Read, Grep\nreadOnly: true'));
    const agents = await discoverAgents({ root, home });
    expect(agents[0]?.readOnly).toBe(true);
    expect(agents[0]?.tools).toEqual(['Read', 'Grep']);
  });

  it('readOnly: true 但没写 tools → 忽略标志并 warn（它会继承父级的写工具）', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: d\nreadOnly: true'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents[0]?.readOnly).toBeUndefined();
    expect(warns.some((l) => l.includes('readOnly') && l.includes('tools'))).toBe(true);
  });

  it('readOnly 不是 true / false → 忽略并 warn', async () => {
    const warns: string[] = [];
    await put(root, 'a.md', doc('name: a\ndescription: d\ntools: Read\nreadOnly: 也许'));
    const agents = await discoverAgents({ root, home, warn: (l) => warns.push(l) });
    expect(agents[0]?.readOnly).toBeUndefined();
    expect(warns.some((l) => l.includes('readOnly'))).toBe(true);
  });
});

describe('agent 名册：内置类型', () => {
  it('三个开箱类型就在，且 explore / plan 是只读的', async () => {
    const agents = await discoverAgents({ root, home, builtins: BUILTIN_AGENTS });
    expect(agents.map((agent) => agent.name)).toEqual(['explore', 'general-purpose', 'plan']);
    expect(agents.find((agent) => agent.name === 'explore')?.readOnly).toBe(true);
    expect(agents.find((agent) => agent.name === 'plan')?.readOnly).toBe(true);
    expect(agents.find((agent) => agent.name === 'general-purpose')?.readOnly).toBeUndefined();
    expect(agents.find((agent) => agent.name === 'general-purpose')?.tools).toBeUndefined();
  });

  it('项目级同名文件覆盖内置类型：文件赢，且不告状', async () => {
    const warns: string[] = [];
    await put(root, 'explore.md', doc('name: explore\ndescription: 项目自己的探索者\ntools: Read'));
    const agents = await discoverAgents({
      root,
      home,
      builtins: BUILTIN_AGENTS,
      warn: (l) => warns.push(l),
    });
    expect(agents.find((agent) => agent.name === 'explore')?.description).toBe('项目自己的探索者');
    expect(warns.filter((l) => l.includes('提供'))).toEqual([]);
  });
});
