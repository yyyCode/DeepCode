import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { createEngine } from '@deepcode/core/create';
import { readTool } from '@deepcode/builtins/tools/read';
import { createAgentsMdPlugin } from '../nested';
import { scriptedProvider } from '../../../test/harness';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-agentsmd-'));
  outside = await mkdtemp(join(tmpdir(), 'deepcode-outside-'));

  await writeFile(join(root, 'AGENTS.md'), '根约定（已在 system prompt 里）', 'utf8');
  await writeFile(join(root, 'CLAUDE.md'), '根约定之二', 'utf8');
  await mkdir(join(root, 'sub', 'deep'), { recursive: true });
  await writeFile(join(root, 'sub', 'AGENTS.md'), 'SUB 层约定', 'utf8');
  await writeFile(join(root, 'sub', 'deep', 'CLAUDE.md'), 'DEEP 层约定', 'utf8');
  await writeFile(join(root, 'sub', 'a.ts'), 'const a = 1;\n', 'utf8');
  await writeFile(join(root, 'sub', 'deep', 'b.ts'), 'const b = 2;\n', 'utf8');
  await writeFile(join(outside, 'c.ts'), 'const c = 3;\n', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** 真引擎：真 Read 工具 + 真 fs 名词。`agents-md` 排在前面 —— 同 tier 内先装载者在外层。 */
async function build() {
  return createEngine({
    plugins: [createAgentsMdPlugin({ root }), readTool],
    provider: scriptedProvider([]),
    ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });
}

async function read(file: string): Promise<string> {
  const built = await build();
  const result = await built.dispatch(
    'tool.call',
    { tool: 'Read', input: { file_path: file }, toolUseId: 'tu_1' },
    CORE_ORIGIN,
  );
  return 'value' in result ? String(result.value) : JSON.stringify(result);
}

describe('嵌套目录约定', () => {
  it('C3-14 读子目录里的文件：中间那一层的约定被附上', async () => {
    const out = await read(join(root, 'sub', 'a.ts'));
    expect(out).toContain('SUB 层约定');
    expect(out).toContain(`以下是 ${join(root, 'sub')} 的目录约定（AGENTS.md）：`);
    expect(out).toContain('1\tconst a = 1;'); // 正文还在
  });

  it('两层都带上，从 root 下面一层开始', async () => {
    const out = await read(join(root, 'sub', 'deep', 'b.ts'));
    expect(out).toContain('SUB 层约定');
    expect(out).toContain('DEEP 层约定');
  });

  it('C3-16 root 与用户层那两份**不重附**（它们已经在 system prompt 里）', async () => {
    const out = await read(join(root, 'sub', 'a.ts'));
    expect(out).not.toContain('根约定（已在 system prompt 里）');
    expect(out).not.toContain('根约定之二');
  });

  it('根目录下的文件：什么都不附（root 那份在 system prompt 里）', async () => {
    const out = await read(join(root, 'sub', 'a.ts'));
    const atRoot = await read(join(root, 'AGENTS.md'));
    expect(out).toContain('以下是'); // 先确认这一组用例真的会附（否则下面那句是空转）
    expect(atRoot).not.toContain('以下是');
  });

  it('C3-15 同一个文件第二次读**不重附**', async () => {
    const built = await build();
    const args = { tool: 'Read', input: { file_path: join(root, 'sub', 'a.ts') }, toolUseId: 'tu_1' };

    const once = await built.dispatch('tool.call', args, CORE_ORIGIN);
    const twice = await built.dispatch('tool.call', args, CORE_ORIGIN);
    const first = 'value' in once ? String(once.value) : '';
    const second = 'value' in twice ? String(twice.value) : '';

    expect(first).toContain('SUB 层约定');
    expect(second).not.toContain('SUB 层约定');
  });

  it('C3-17 读 root 之外的文件：不触发', async () => {
    const out = await read(join(outside, 'c.ts'));
    expect(out).not.toContain('层约定');
    expect(out).toContain('1\tconst c = 3;');
  });

  it('读失败（文件不存在）：不追加，照样是 ERROR', async () => {
    const out = await read(join(root, 'sub', '没有这个文件.ts'));
    expect(out.startsWith('ERROR:')).toBe(true);
    expect(out).not.toContain('SUB 层约定');
  });
});

describe('P7 §3.4 压缩边界上重装（"记忆越压越糊"的那一半）', () => {
  // `root` 要等 `beforeAll` 才落地，所以这里**每次现取**，不能在模块顶层建好。
  const args = () => ({
    tool: 'Read',
    input: { file_path: join(root, 'sub', 'a.ts') },
    toolUseId: 'tu_1',
  });

  const body = async (built: Awaited<ReturnType<typeof build>>): Promise<string> => {
    const result = await built.dispatch('tool.call', args(), CORE_ORIGIN);
    return 'value' in result ? String(result.value) : '';
  };

  it('压缩之后同一个文件**重新**附一遍：压缩丢的是对话，不是文件', async () => {
    const built = await build();
    expect(await body(built)).toContain('SUB 层约定');

    // 压缩是**纯通知**（派在改之前）：它自己不改上下文，这里要的只是去重表被清掉。
    await built.dispatch('session.compact', { trigger: 'auto', tokensBefore: 1_000 }, CORE_ORIGIN);

    // 没有这一条：附过的文件**永远不会再附**，模型丢了约定还不知道自己丢了 ——
    // 因为上面那段约定已经不在上下文里了（它跟着被压掉的消息一起没了）。
    expect(await body(built)).toContain('SUB 层约定');
  });

  it('没压缩时去重照旧：表不是被"顺手删了"，是被事件清的', async () => {
    const built = await build();
    expect(await body(built)).toContain('SUB 层约定');
    expect(await body(built)).not.toContain('SUB 层约定'); // C3-15 在同一个实例上仍然成立
  });
});
