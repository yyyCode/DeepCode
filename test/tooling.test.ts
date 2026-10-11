import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 两个检查器都是 `.mjs`：`tsconfig.json` 的 include 是 ["src","test","scripts"]，
 * 它们连 tsc 都不经过 —— 所以这个文件是它们唯一的保障。
 *
 * 这里要防的是**假绿**：一个 walk 不到任何文件的检查器会打印「通过」。
 * 所以每一条「不红」的用例都配一条「必须真的红」的用例，且后者钉的是**具体判词**，
 * 不是"非空即过"。
 */

const exec = promisify(execFile);
const BOUNDARIES = resolve(process.cwd(), 'scripts', 'check-boundaries.mjs');
const HARDENING = resolve(process.cwd(), 'scripts', 'check-workflow-hardening.mjs');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-tooling-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 造一棵临时树，键是相对路径。返回它的根。 */
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(root, 't-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return dir;
}

/** 跑一个检查器，把退出码与两个流都收下来（非零码 execFile 会 reject）。 */
async function run(script: string, dir: string) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, dir]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** 一份**完全合规**的插件。各条违规用例在它之上只改一处。 */
const CLEAN_PLUGIN = {
  'plugins/p/plugin.json': '{ "name": "p", "version": "0.1.0" }',
  'plugins/p/util.mjs': 'export const helper = 1;\n',
  'plugins/p/main.mjs':
    "import { readFile } from 'node:fs/promises';\n" +
    "import { helper } from './util.mjs';\n" +
    'export default { register() {} };\n',
};

describe('check-boundaries：plugins/', () => {
  it('干净：node: 内建 + 同插件目录内的相对路径 → 通过', async () => {
    const dir = await tree(CLEAN_PLUGIN);
    const { code, stdout } = await run(BOUNDARIES, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('依赖边界检查通过');
  });

  it('插件 import 引擎内部 → 红（"逃出了 plugins/"）', async () => {
    const dir = await tree({
      ...CLEAN_PLUGIN,
      'plugins/p/main.mjs': "import x from '../../src/core/engine';\n",
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('plugins/p/main.mjs');
    expect(stderr).toContain('逃出了 plugins/');
  });

  it('插件用裸包名 → 红（那会解析到宿主的 node_modules）', async () => {
    const dir = await tree({ ...CLEAN_PLUGIN, 'plugins/p/main.mjs': "import 'fs-extra';\n" });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('不允许裸包名 fs-extra');
  });

  it('副作用式导入（没有 from）也算 —— 这一种是反向验证逼出来的', async () => {
    // `import '../../src/core/engine';` 没有 `from`，只认 `... from '...'` 的正则会整个放过它，
    // 而"插件把引擎模块拉进来"最顺手的写法恰好就是这个。
    const dir = await tree({
      ...CLEAN_PLUGIN,
      'plugins/p/main.mjs': "import '../../src/core/engine';\n",
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('逃出了 plugins/');
  });

  it('插件跨到另一个插件目录 → 红', async () => {
    const dir = await tree({
      ...CLEAN_PLUGIN,
      'plugins/p/main.mjs': "import x from '../q/util.mjs';\n",
      'plugins/q/util.mjs': 'export const y = 1;\n',
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('跨到了 plugins/q/');
  });

  it('`export ... from` 也算 import —— 只认 import 的话这一条会溜过去', async () => {
    const dir = await tree({
      ...CLEAN_PLUGIN,
      'plugins/p/util.mjs': "export * from '../../src/core/x';\n",
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('逃出了 plugins/');
  });

  it('src/ 的既有规则仍然拦得住（改了共享代码，钉一下没捅到别人）', async () => {
    const dir = await tree({
      'src/contract/a.ts': "import { b } from '../core/b';\nexport const a = 1;\n",
      'src/core/b.ts': 'export const b = 1;\n',
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('src/contract/a.ts');
    expect(stderr).toContain('不允许 import core/');
  });

  it('src/ 与 plugins/ 都不存在 → 说清楚是通过，不是崩掉', async () => {
    const dir = await tree({ 'README.md': '# 空壳\n' });
    const { code, stdout } = await run(BOUNDARIES, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('都不存在');
  });
});

/** 一份**完全合规**的工作流。 */
function cleanWorkflow(): string {
  return [
    'name: x',
    'on: [push]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      # v5',
    '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    '        with:',
    '          persist-credentials: false',
    '      - run: echo hi',
    '',
  ].join('\n');
}

describe('check-workflow-hardening', () => {
  it('干净工作流 → 通过', async () => {
    const dir = await tree({ '.github/workflows/ci.yml': cleanWorkflow() });
    const { code, stdout } = await run(HARDENING, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('工作流硬化检查通过');
  });

  it('注释掉的 uses: 不误报 —— 剥注释这一条不能省', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace(
        '      - run: echo hi',
        '      # - uses: someone/thing@v1\n      - run: echo hi',
      ),
    });
    const { code } = await run(HARDENING, dir);
    expect(code).toBe(0);
  });

  it('没有工作流目录 → 通过，并说明是"没有"而不是"都合规"', async () => {
    const dir = await tree({ 'README.md': '# 空壳\n' });
    const { code, stdout } = await run(HARDENING, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('没有工作流');
  });

  it('缺顶层 permissions: → 红', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace('permissions:\n  contents: read\n', ''),
    });
    const { code, stderr } = await run(HARDENING, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('缺顶层 permissions:');
  });

  it('action 没钉 commit SHA → 红', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace(
        'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
        'actions/checkout@v5',
      ),
    });
    const { code, stderr } = await run(HARDENING, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('没钉 commit SHA');
    expect(stderr).toContain('actions/checkout@v5');
  });

  it('pull_request_target → 红', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace(
        'on: [push]',
        'on:\n  pull_request_target:',
      ),
    });
    const { code, stderr } = await run(HARDENING, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('禁 pull_request_target');
  });

  it('checkout 没写 persist-credentials: false → 红', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace(
        '        with:\n          persist-credentials: false\n',
        '',
      ),
    });
    const { code, stderr } = await run(HARDENING, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('persist-credentials');
  });
});

/**
 * `mods/` 那一支（P5a 加）。
 *
 * 这条规则是 README 那句"内建与第三方走同一条接口"从口号变成强制的那一步 ——
 * 所以它必须**真的拦得住**：每条"不红"的用例都配一条"必须红"的，且后者钉具体判词。
 */
const CLEAN_MOD = {
  'mods/t/index.ts':
    "import { join } from 'node:path';\n" +
    "import type { Plugin } from '../../src/contract/plugin';\n" +
    "export const x = join('a', 'b');\n" +
    'export type P = Plugin;\n',
};

describe('check-boundaries：mods/', () => {
  it('干净：node: + 契约 + 自身目录 → 通过', async () => {
    const dir = await tree(CLEAN_MOD);
    const { code, stdout } = await run(BOUNDARIES, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('依赖边界检查通过');
  });

  it('mod import 引擎实现（src/core）→ 红，判词点名"只许 import src/contract"', async () => {
    const dir = await tree({
      ...CLEAN_MOD,
      'mods/t/index.ts': "import { dispatch } from '../../src/core/dispatch';\n",
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('mod 只许 import src/contract/');
  });

  it('mod import 裸包名 → 红', async () => {
    const dir = await tree({
      ...CLEAN_MOD,
      'mods/t/index.ts': "import { describe } from 'vitest';\n",
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('不允许裸包名');
  });

  it('mod 跨到另一个 mod → 红', async () => {
    const dir = await tree({
      ...CLEAN_MOD,
      'mods/t/index.ts': "import { x } from '../u/index';\n",
      'mods/u/index.ts': 'export const x = 1;\n',
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('跨到了 mods/u/');
  });

  it('**测试豁免**：mod 的测试 import src/core → 通过（测试本来就要用真引擎）', async () => {
    const dir = await tree({
      ...CLEAN_MOD,
      'mods/t/test/x.test.ts':
        "import { describe } from 'vitest';\n" +
        "import { createEngine } from '../../../src/core/create';\n" +
        'export const y = [describe, createEngine];\n',
    });
    const { code, stdout } = await run(BOUNDARIES, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('依赖边界检查通过');
  });
});

describe('check-boundaries：src/cli → mods/ 这条单向依赖', () => {
  it('cli/ 可以 import 内建 mod → 通过', async () => {
    const dir = await tree({
      'src/cli/mods.ts': "import { spec } from '../../mods/t/index';\nexport const s = spec;\n",
      'mods/t/index.ts': 'export const spec = 1;\n',
    });
    const { code, stdout } = await run(BOUNDARIES, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('依赖边界检查通过');
  });

  it('内核（core/）import 内建 mod → 红：内核不认识 mod', async () => {
    const dir = await tree({
      'src/core/x.ts': "import { spec } from '../../mods/t/index';\nexport const s = spec;\n",
      'mods/t/index.ts': 'export const spec = 1;\n',
    });
    const { code, stderr } = await run(BOUNDARIES, dir);
    expect(code).toBe(1);
    expect(stderr).toContain('只有 cli/ 可以 import 内建 mod');
  });
});
