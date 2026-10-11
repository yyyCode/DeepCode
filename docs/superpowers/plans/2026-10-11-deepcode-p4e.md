# DeepCode P4e 工程化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「本地三条命令全绿」变成「CI 上也全绿」，并把 `plugins/` 的源码与 `.github/workflows` 自身的安全卫生纳入检查。

**Architecture:** 两个零依赖的 Node `.mjs` 检查器（扩一个、新写一个），一个 vitest 测试文件钉住它们，一条 GitHub Actions 流水线跑 `typecheck`/`lint`/`test`，最后删掉文档里「没有 CI」的说法。**一行运行时行为都不改。**

**Tech Stack:** GitHub Actions、Node ≥ 20、pnpm 10、vitest 2.1.9。**零新增依赖。**

**验收（按用户长期指令批量做）**

- **C1**（Task 1–3）：`pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿；两个检查器的反向验证各红一次。
- **C2**（Task 4–6）：推分支开 PR，两个 Node 版本的 job 都绿；三处文档口径改完。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `scripts/check-boundaries.mjs` | 修改 | 依赖边界：`src/` 按顶层目录；`plugins/` 只许 `node:` 与同插件目录内的相对路径 |
| `scripts/check-workflow-hardening.mjs` | 新建 | 工作流硬化：钉 SHA / 显式 `permissions:` / 禁 `pull_request_target` / checkout 不落凭据 |
| `test/tooling.test.ts` | 新建 | 两个检查器的正反用例（含"造一份违规样本必须真的红"） |
| `test/cli.test.ts` | 修改 | 追加：真跑 `bin` 对两个自带插件做 `plugin validate` |
| `.github/workflows/ci.yml` | 新建 | CI 本体 |
| `package.json` | 修改 | `lint` 串上第二个检查器 |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 修改 | 文档收口（含改掉官网里过时的用例数） |

---

## Task 1: `check-boundaries.mjs` —— 扩到 `plugins/`，并补两个洞

**Files:**
- Modify: `scripts/check-boundaries.mjs`（整文件替换）

**背景（写代码前先读）**：今天的脚本只 walk `src/` 下的 `.ts`。两个自带插件是 `plugins/*/*.mjs`，
于是它们**同时落在两套检查的缝里** —— tsc 不看 `.js`（`allowJs` 没开），这个脚本不看 `src/` 以外。
另外正则只认 `import ... from`，`export ... from` 能溜过去。

- [ ] **Step 1: 整文件替换**

```js
#!/usr/bin/env node
// 依赖边界检查。规则见设计文档 §2.1 与 P4e 设计 §3。
// 不用 ESLint：flat config 下 import/no-restricted-paths 支持不稳定，而这里要的只是"某目录不许 import"。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 仓库根：默认由脚本自身位置推出（`..` 就是仓库根）。
// 命令行也可以给一个 —— 那一条是为了让它**可被测试**：
// 一个只能对着真仓库跑的检查器，测试里造不出违规样本。
const ROOT_DIR = (process.argv[2] ?? new URL('..', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const SRC = join(ROOT_DIR, 'src');
const PLUGINS = join(ROOT_DIR, 'plugins');

// 每个目录允许 import 的 src 顶层目录白名单（'*' 表示不限）
const RULES = {
  contract: [],
  core: ['contract'],
  providers: ['contract'],
  builtins: ['contract'],
  cli: ['contract', 'core', 'providers', 'builtins'],
};

// `.mjs` / `.js` 也要看：`plugins/` 下的插件是 `.mjs`，在加上这一条之前，
// 它们同时落在 tsc（不开 allowJs，不看 js）与这个脚本（只看 ts）的缝里。
const SOURCE_EXT = ['.ts', '.mjs', '.js'];

// `export ... from '...'` 与 `import ... from '...'` 都算。
// 只认 import 的话，一句 `export * from '../core/x'` 能整个溜过去。
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

/** 相对仓库根、正斜杠的显示名。两端共用，免得两种写法漂开。 */
function shown(file) {
  return relative(ROOT_DIR, file).replace(/\\/g, '/');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SOURCE_EXT.some((ext) => p.endsWith(ext))) out.push(p);
  }
  return out;
}

const problems = [];

// ── src/：按顶层目录定规则 ────────────────────────────────────────────
// `existsSync` 这一守是必要的：git 不跟踪空目录，新克隆里可能没有 src/，
// 不守就会以 ENOENT 崩掉，而不是"检查通过"。
if (existsSync(SRC)) {
  for (const file of walk(SRC)) {
    const area = relative(SRC, file).replace(/\\/g, '/').split('/')[0];
    const allowed = RULES[area];
    if (!allowed) continue;

    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 只查相对导入
      const rel = relative(SRC, join(file, '..', spec)).replace(/\\/g, '/');
      if (rel.startsWith('..')) {
        // 相对导入逃出 src/ 几乎总是相对路径层级写错了 —— 比如
        // src/builtins/confirm.ts（比 tools/ 高一层）用了 tools/ 才该用的
        // '../../contract/plugin'，实际解析成 <repo>/contract/plugin。
        problems.push(
          `${shown(file)}: import ${spec} 逃出了 src/（多半是相对路径层级写错）`,
        );
        continue;
      }
      const targetArea = rel.split('/')[0];
      if (targetArea === area) continue; // 同目录内部不算越界
      if (!allowed.includes(targetArea)) {
        problems.push(
          `${shown(file)}: 不允许 import ${targetArea}/（只允许 ${allowed.join(', ') || '无'}）`,
        );
      }
    }
  }
}

// ── plugins/：插件是"陌生人" ─────────────────────────────────────────
// 只许 `node:` 内建，或停在**自己那个插件目录里**的相对路径。
// 裸包名会解析到**宿主的** node_modules —— 那是隐式耦合，插件独立分发那天必炸。
if (existsSync(PLUGINS)) {
  for (const file of walk(PLUGINS)) {
    const owner = relative(PLUGINS, file).replace(/\\/g, '/').split('/')[0];

    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue; // 内建，允许
      if (!spec.startsWith('.')) {
        problems.push(`${shown(file)}: 不允许裸包名 ${spec}（插件不该依赖宿主的依赖树）`);
        continue;
      }
      const target = relative(PLUGINS, join(file, '..', spec)).replace(/\\/g, '/');
      if (target.startsWith('..')) {
        problems.push(
          `${shown(file)}: import ${spec} 逃出了 plugins/（插件只通过 hook 契约与引擎说话）`,
        );
        continue;
      }
      const targetOwner = target.split('/')[0];
      if (targetOwner !== owner) {
        problems.push(`${shown(file)}: import ${spec} 跨到了 plugins/${targetOwner}/`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('依赖边界违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
if (!existsSync(SRC) && !existsSync(PLUGINS)) {
  console.log('依赖边界检查通过（src/ 与 plugins/ 都不存在）');
} else {
  console.log('依赖边界检查通过');
}
```

- [ ] **Step 2: 跑一遍，确认行为不变**

Run: `pnpm lint`
Expected: `依赖边界检查通过`

- [ ] **Step 3: 反向验证（插件越界必须红）**

```bash
mkdir -p /tmp/bx/plugins/p && printf "import x from '../../src/core/engine';\n" > /tmp/bx/plugins/p/main.mjs
node scripts/check-boundaries.mjs /tmp/bx
```
Expected: 退出码 1，stderr 含 `plugins/p/main.mjs: import ../../src/core/engine 逃出了 plugins/`

- [ ] **Step 4: 反向验证（裸包名必须红）**

```bash
printf "import 'fs-extra';\n" > /tmp/bx/plugins/p/main.mjs
node scripts/check-boundaries.mjs /tmp/bx
```
Expected: 退出码 1，stderr 含 `不允许裸包名 fs-extra`

- [ ] **Step 5: 反向验证（`export ... from` 必须红）**

```bash
printf "export * from '../../src/core/x';\n" > /tmp/bx/plugins/p/main.mjs
node scripts/check-boundaries.mjs /tmp/bx
```
Expected: 退出码 1

- [ ] **Step 6: 清理**

```bash
rm -rf /tmp/bx
```

- [ ] **Step 7: 提交**

```bash
git add scripts/check-boundaries.mjs
git commit -m "feat(lint): 依赖边界扩到 plugins/，并补上 export-from 与 .mjs 两个洞"
```

---

## Task 2: `check-workflow-hardening.mjs`（新）

**Files:**
- Create: `scripts/check-workflow-hardening.mjs`

- [ ] **Step 1: 写脚本**

```js
#!/usr/bin/env node
// 工作流硬化检查。四条规则见 P4e 设计 §2.1。
//
// ⚠️ 这是**文本扫描**，不是 YAML 解析器 —— 零运行时依赖是仓库的既有底线，
// 为四条规则引一个解析器不值。它看不见：动态拼出来的 `uses:`、YAML 锚点/复用块里的引用、
// job 之间的包含关系。**它是尽力而为的护栏，不是完备证明**（参考实现对自家那个 python
// 校验器说的也是同一句话）。这个边界写进了 README，不藏着。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT_DIR = (process.argv[2] ?? new URL('..', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const WORKFLOWS = join(ROOT_DIR, '.github', 'workflows');

const SHA_RE = /^[0-9a-f]{40}$/;
// 一行里最多一个 `uses:`，所以不用 /g —— 带 /g 的 test() 会自己推进 lastIndex，是个陷阱。
const USES_RE = /(?:^|\s)uses\s*:\s*['"]?([^'"\s]+)['"]?/;
const CHECKOUT_RE = /(?:^|\s)uses\s*:\s*['"]?actions\/checkout@/;
const CREDENTIALS_RE = /(?:^|\s)persist-credentials\s*:\s*['"]?false/;

/** 剥掉行尾注释。`#` 前必须是行首或空白 —— 免得把值里的 `#` 当成注释。 */
function stripComment(line) {
  const hit = /(^|\s)#/.exec(line);
  return hit === null ? line : line.slice(0, hit.index + hit[1].length);
}

const problems = [];

// 没有工作流不是错误（新克隆、或还没上前就本地跑一口）—— 与 check-boundaries 对缺失目录的处理同形。
if (!existsSync(WORKFLOWS)) {
  console.log('工作流硬化检查通过（没有工作流）');
  process.exit(0);
}

for (const name of readdirSync(WORKFLOWS)) {
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
  const file = join(WORKFLOWS, name);
  const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map(stripComment);

  // H2：必须有显式的顶层 `permissions:`。
  // 顶层是**每个 job 的上限**，所以缺省最危险 —— 缺省 = 仓库默认 token 权限。
  if (!lines.some((line) => /^permissions\s*:/.test(line))) {
    problems.push(`${rel}: 缺顶层 permissions:（缺省 = 仓库默认 token 权限，太大）`);
  }

  // H3：禁 pull_request_target。它给不可信 PR 的代码一个带写 token 与 secrets 的上下文。
  lines.forEach((line, i) => {
    if (/^\s*pull_request_target\s*:/.test(line)) {
      problems.push(
        `${rel}:${i + 1}: 禁 pull_request_target（给不可信 PR 的代码写 token 与 secrets）`,
      );
    }
  });

  // 按 `- ` 把文件切成 step。`on: push: branches: - main` 这类内联列表也会被切开，
  // 但它们不含 `uses:`，对下面两条规则无害；代价是行号指向这一段的第一行。
  const steps = [];
  let current = [];
  lines.forEach((line, i) => {
    if (/^\s*-\s/.test(line) && current.length > 0) {
      steps.push(current);
      current = [];
    }
    current.push({ line, i });
  });
  if (current.length > 0) steps.push(current);

  for (const step of steps) {
    const first = step[0];
    if (first === undefined) continue;
    const body = step.map((s) => s.line).join('\n');

    // H4：checkout 必须 persist-credentials: false。
    // 否则 token 被写进 .git/config，后面任意一个 step 都能拿去推东西。
    if (CHECKOUT_RE.test(body) && !CREDENTIALS_RE.test(body)) {
      problems.push(`${rel}:${first.i + 1}: actions/checkout 没写 persist-credentials: false`);
    }

    // H1：第三方 action 必须钉 40 位 commit SHA。tag 会被上游重指 —— CI 的头号供应链风险。
    // `./` 开头的本地复合动作豁免（它就在这个仓库里，跟着 commit 一起被审）。
    for (const { line, i } of step) {
      const hit = USES_RE.exec(line);
      if (hit === null) continue;
      const spec = hit[1];
      if (spec.startsWith('./')) continue;
      const at = spec.lastIndexOf('@');
      const ref = at === -1 ? '' : spec.slice(at + 1);
      if (!SHA_RE.test(ref)) {
        problems.push(`${rel}:${i + 1}: ${spec} 没钉 commit SHA（tag 会被上游重指）`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('工作流硬化违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('工作流硬化检查通过');
```

- [ ] **Step 2: 在真仓库上跑一遍（此时还没有工作流）**

Run: `node scripts/check-workflow-hardening.mjs`
Expected: `工作流硬化检查通过（没有工作流）`，退出码 0

- [ ] **Step 3: 反向验证四条规则各红一次**

```bash
mkdir -p /tmp/hd/.github/workflows
cat > /tmp/hd/.github/workflows/ok.yml <<'YAML'
name: x
on: [push]
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          persist-credentials: false
      - run: echo hi
YAML
node scripts/check-workflow-hardening.mjs /tmp/hd   # 期望：通过，退出码 0
```

再逐条改坏（每改一条跑一次，期望退出码 1 且判词对得上）：

| 改法 | 期望判词 |
| --- | --- |
| 删掉 `permissions:` 两行 | `缺顶层 permissions:` |
| `actions/checkout@fbc6...` 改成 `actions/checkout@v5` | `没钉 commit SHA` |
| `on: [push]` 改成 `on: [push, pull_request_target]` 后**换成多行** `on:\n  pull_request_target:` | `禁 pull_request_target` |
| 删掉 `with:` 与 `persist-credentials: false` 两行 | `没写 persist-credentials: false` |

```bash
rm -rf /tmp/hd
```

- [ ] **Step 4: 提交**

```bash
git add scripts/check-workflow-hardening.mjs
git commit -m "feat(lint): 新增工作流硬化检查（钉 SHA / 显式 permissions / 禁 pull_request_target / checkout 不落凭据）"
```

---

## Task 3: `lint` 串联 + `test/tooling.test.ts`

**Files:**
- Modify: `package.json:12`
- Create: `test/tooling.test.ts`

- [ ] **Step 1: `lint` 串上第二个检查器**

```json
    "lint": "node scripts/check-boundaries.mjs && node scripts/check-workflow-hardening.mjs"
```

理由：只在 CI 里跑的校验器是最容易漂的那种 —— 本地与 CI 必须同一条命令。

- [ ] **Step 2: 写测试**

```ts
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
 * 所以每一条「不红」的用例都配一条「必须真的红」的用例。
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

/** 一份**完全合规**的插件树。各条违规用例在它之上只改一处。 */
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
  it('干净工作流 → 通过（注释行不算数）', async () => {
    const dir = await tree({ '.github/workflows/ci.yml': cleanWorkflow() });
    const { code, stdout } = await run(HARDENING, dir);
    expect(code).toBe(0);
    expect(stdout).toContain('工作流硬化检查通过');
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

  it('pull_request_target → 红', async () => {
    const dir = await tree({
      '.github/workflows/ci.yml': cleanWorkflow().replace('on: [push]', 'on:\n  pull_request_target:'),
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
```

> **注意**：断言一律钉**具体判词**，不写成"非空即过"。这一轮防的就是摆设断言。

- [ ] **Step 3: 跑测试**

Run: `pnpm test test/tooling.test.ts`
Expected: 全绿（初写时若有断言字符串对不上，按真实输出改**断言**，不改判词）

- [ ] **Step 4: 提交**

```bash
git add package.json test/tooling.test.ts
git commit -m "test(lint): 两个检查器的正反用例，lint 串上工作流硬化"
```

---

## ══ 检查点 C1 ══

- [ ] `pnpm typecheck` ✓
- [ ] `pnpm lint` ✓（两行「通过」）
- [ ] `pnpm test` ✓ —— 记录**文件数与用例数**（后面文档要用）

---

## Task 4: `plugin validate` 进流水线（还 P3 欠的那一格）

**Files:**
- Modify: `test/cli.test.ts`（文件末尾追加）

**背景**：`mvp-design.md:424` 自己承认「校验器进 CI」这格没做。`src/cli/main.ts:88` 的子命令分支
在处理**读配置、要 key 之前**，所以 `plugin validate` 在没 key 的干净环境里是条正经命令。
输出形状（`src/cli/plugin-command.ts:73-77`）：第一行 `插件目录 <绝对路径>`，第二行 `清单没问题`。

- [ ] **Step 1: 追加用例**

```ts
describe('真跑一遍 bin：自带插件的清单都过 validate', () => {
  // 与上面 --help 那条同一个用意：清掉会改变配置解析的变量，
  // 顺便**再钉一遍顺序** —— plugin 子命令必须发生在"要 key"之前，
  // 否则下面两步会在干净环境（CI）里报"缺少 API key"，而不是校验清单。
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'DEEPCODE_MODEL',
    'DEEPCODE_PROVIDER',
  ]) {
    delete env[name];
  }

  for (const dir of ['./plugins/todo', './plugins/secret-guard']) {
    it(`${dir} 的清单没问题`, async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [resolve(process.cwd(), 'bin', 'deepcode.mjs'), 'plugin', 'validate', dir],
        { cwd: process.cwd(), env },
      );

      expect(stdout).toContain('插件目录');
      expect(stdout).toContain('清单没问题');
      // 这一句是防"空转"的：validate 必须真的读了那个目录，
      // 而不是因为路径写错落到别处、恰好也没报错。
      expect(stdout).toContain(resolve(process.cwd(), dir));
    }, 60_000);
  }
});
```

- [ ] **Step 2: 跑这两个用例**

Run: `pnpm test test/cli.test.ts`
Expected: 全绿

- [x] **Step 3: 反向验证（这一条必须是"真的跑了"）**

临时把 `plugins/todo/plugin.json` 的 `entry` 改成 `"../main.mjs"`，跑一次 → 该用例必须**红**
（`validate` 报 E6、退出码 1、`execFile` reject）。确认后 `git checkout --` 把文件改回来。

> **计划本身的错（执行时逮到）**：这一条原本写的是"把 `version` 删掉"。
> 但 `version` 在 `src/contract/plugin-manifest.ts:179` 是**可选**的（E4 只在字段存在时才判格式），
> 删掉它 `validate` 照样通过、用例照样绿 —— 拿它做反向验证，红不出来只能说明**变异选错了**，
> 不说明断言是摆设。改选 `entry` 越界（E6）：这条是本文件最要紧的校验（`..` 是唯一能把清单
> 带出插件目录的写法），也确实红了。

- [ ] **Step 4: 提交**

```bash
git add test/cli.test.ts
git commit -m "test(cli): 真跑 bin 校验两个自带插件 —— 还 P3 欠的「校验器进 CI」"
```

---

## Task 5: `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写工作流**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# 顶层的 permissions: 是每个 job 的上限。不写 = 仓库默认 token 权限，比这里需要的多得多。
permissions:
  contents: read

jobs:
  check:
    name: check (node ${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        # `engines: { node: ">=20" }` 是一句**没人验过的话**。20 是声明的地板，
        # 22 是开发机（Windows）实际在跑的 —— 两个都过一遍，这句话才是事实。
        node: ['20', '22']
    steps:
      # v5
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          # 不落凭据：否则 token 被写进 .git/config，后面任意一个 step 都能拿去推东西。
          persist-credentials: false

      # v4（本机 pnpm 10.33.0，pnpm-lock.yaml 是 lockfileVersion 9.0，pnpm 10 读得了）
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: 10

      # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

三个 action 全部钉 **40 位 commit SHA**（tag 会被上游重指），紧邻注释写版本号方便升级。
**这一步不需要任何 secret** —— 测试全是桩。

- [ ] **Step 2: 自检（让 Task 2 那个检查器检查它自己）**

Run: `pnpm lint`
Expected: `依赖边界检查通过` + `工作流硬化检查通过`（**这一次不再是「没有工作流」**）

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions 跑 typecheck/lint/test，动作钉 SHA，最小 permissions"
```

---

## Task 6: 文档收口

**Files:**
- Modify: `README.md`、`docs/项目简介.md`、`site/index.html`

- [ ] **Step 1: `README.md` 的「开发」一节（:451 起）**

`pnpm lint` 那行与 `pnpm test` 那行的数都要改，并在代码块下补一段实话：

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 两个检查：依赖边界 + 工作流硬化
pnpm test        # 测试，<C1 实测的> 个文件 <C1 实测的> 个用例
pnpm dev         # 免去 bin 转手，直接跑 tsx（cwd 是本仓库）
```

代码块下加：

```markdown
三条命令在 [GitHub Actions](.github/workflows/ci.yml) 上也跑（Node 20 与 22 两个版本）。
CI 不需要任何密钥 —— 测试全是桩：假 `fetch`、临时目录。

> ⚠️ **工作流硬化检查是文本扫描，不是 YAML 解析器。** 它认不出动态拼出来的 `uses:`、
> 写在 YAML 锚点里的引用、以及 job 之间的包含关系。它是尽力而为的护栏，不是完备证明 ——
> 新工作流仍要人看一眼。
```

- [ ] **Step 2: `README.md` 的设计文档列表（:460 起）**

在 P3 设计那条后面加一行：

```markdown
- P4e 设计（CI 与工程化）：[`docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md)
```

- [ ] **Step 3: `docs/项目简介.md:98`**

把 `- **没有 CI、没有 LICENSE**。前者在设计里排到 MVP 之后，后者是未指定许可证（保留所有权利）。`
改成 `- **没有 LICENSE**（未指定许可证 / 保留所有权利）。`
（`git grep -n "没有 CI"` 先确认它还在那一行；若行号漂了按内容定位。）

- [ ] **Step 4: `site/index.html` 的工程质量段（:342-359）**

三处改动：

1. `<b>523</b>` → `<b><C1 实测的></b>`，`39 个测试文件` → `<C1 实测的文件数> 个测试文件`
   （**523 是过时数** —— README 与官网在 P4b 那一轮就没对齐，这次一并修正）
2. `pnpm lint（依赖边界）` → `pnpm lint（依赖边界 + 工作流硬化）`
3. 那张「**0** CI 流水线」的限制卡换成一张真卡片：

```html
    <article class="card card--stat">
      <b>2</b>
      <p>个 Node 版本（20 / 22）在 <a href="https://github.com/yyyCode/DeepCode/actions">GitHub Actions</a>
        上跑这三条命令。动作钉 commit SHA，<code>permissions: contents: read</code>，不需要任何密钥。</p>
    </article>
```

- [ ] **Step 5: `site/index.html` 的路线图（:398-403）**

P4 那张卡目前只写了 P4a。改成：

```html
      <div class="road__head"><span class="pill">进行中</span><h3>P4 组合面</h3></div>
      <p><strong>P4a / P4b / P4e 已落地</strong>：<code>Task</code> / <code>Skill</code> 两个工具与
        <code>agent.offer</code> 进系统提示；会话压缩、<code>Bash</code> 沙箱、嵌套 <code>AGENTS.md</code>；
        CI 与两个检查器。P4 还剩 P4c（marketplace / hookify）与 P4d（多 surface）。</p>
```

- [ ] **Step 6: 全仓扫一遍残留口径**

Run: `git grep -n "没有 CI"` 与 `git grep -n "523"`
Expected: 都无输出（`docs/superpowers/` 下的历史计划文件若命中，那是记录，不改）

- [ ] **Step 7: 提交**

```bash
git add README.md docs/项目简介.md site/index.html
git commit -m "docs: 删掉「没有 CI」这条限制，同步用例数与官网路线图"
```

---

## ══ 检查点 C2 ══

- [x] `pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm test` ✓（40 个文件 609 个用例）
- [x] 推分支、开 PR —— [#4](https://github.com/yyyCode/DeepCode/pull/4)
- [x] 两个 Node 版本的 job 都绿（**只能在推上去之后才算数**）——
      `check (node 20)` 与 `check (node 22)` 各 20s 全绿
- [x] 若 Linux 上红了 …… —— **没红**，见上表第四行

C2 实测（`gh run view --job=<id> --log` 逐步骤核过，不是只看那个绿勾）：

| | node 20 | node 22 |
| --- | --- | --- |
| 八个 step 的结论 | 全 success | 全 success |
| `pnpm lint` 输出 | 依赖边界检查通过 / 工作流硬化检查通过 | 同左 |
| `pnpm test` | 40 个文件 609 个用例 | 40 个文件 609 个用例 |
| pnpm | 10.34.6（本机 10.33.0） | 10.34.6 |

**20 秒跑完一整轮**这件事本身回查过：不是因为哪个 step 被跳过，而是这个仓库只有
4 个 devDependencies、没有 native 构建。逐 step 的 `conclusion` 与日志里的判词都点过了。

**一条非阻塞的观察**：运行器报 `Node.js 20 is deprecated`，指的是
`actions/setup-node` / `pnpm/action-setup` 这两个 action **自身**跑在 Node 20 上被强制升级到 24 ——
不是我们的 matrix（我们的 matrix 是 20 / 22，两个都真跑到了）。修法是升那两个 action 的版本
（即换 SHA），不阻塞本轮，留给下次例行升级。

---

## 与预登记的对照（执行时回来填）

| 预登记 | 实际 |
| --- | --- |
| 补 `export ... from` 不会误伤（只有 `contract/index.ts` 六行同级 re-export） | **成立**。真仓库 `pnpm lint` 通过，六行同级 re-export 全部落在 src 区域规则内，没有一条被新正则误伤。 |
| 两个自带插件 `import` 数为 0，所以 plugins 规则在真仓库上必然过 | **成立**（`find plugins -name '*.mjs'` → 只有 `todo/main.mjs` 与 `secret-guard/scan.mjs`，两个都零 import）。所以 plugins 规则在真仓库上是**绿的但没被真正行使** —— 它被行使的地方是 `test/tooling.test.ts` 的六棵临时树，以及写这条规则时的反向验证。 |
| `pnpm lint` 串第二个检查器后，输出仍含「依赖边界检查通过」 | **成立**（`依赖边界检查通过` + `工作流硬化检查通过`）。 |
| Linux 上测试套件可能露出 Windows-only 假设 | **没露出来**。PR [#4](https://github.com/yyyCode/DeepCode/pull/4) 两个 leg 都绿，且 **Linux 上同样是 40 个文件 / 609 个用例** —— 数与 Windows 本机逐个相同，说明没有一条用例在 Linux 上被跳过（跳过的会少）。预登记里担心的那种"平台假设"（临时目录、路径分隔符、`chmod 0600`、行尾）这一轮都没咬人。 |
