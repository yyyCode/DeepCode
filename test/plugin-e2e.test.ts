import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Plugin } from '@deepcode/contract/plugin';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { confirmPlugin } from '@deepcode/builtins/confirm';
import { coreTools } from '@deepcode/builtins/tools';
import { createEngine } from '@deepcode/core/create';
import { discoverPlugins, loadPlugins } from '@deepcode/cli/plugin-dir';
import { scriptedProvider } from './harness';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** 造一个工作目录，把仓库里的示例插件复制进用户级插件目录 —— 就是 README 里那条 cp。 */
async function worldWith(...names: readonly string[]): Promise<{ home: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'deepcode-e2e-'));
  const home = join(base, 'home');
  const root = join(base, 'root');
  // root 要真的建出来：它是钩子的 `cwd`（也是工作目录）。不建的话 spawn 直接
  // ENOENT —— 报出来的是 `spawn C:\Windows\system32\cmd.exe ENOENT`，
  // 看着像 shell 没了，实际上是工作目录不存在。
  await mkdir(root, { recursive: true });
  for (const name of names) {
    await cp(join(REPO, 'plugins', name), join(home, '.deepcode', 'plugins', name), { recursive: true });
  }
  return { home, root };
}

/** 递归列出 `dir` 下的所有文件（跳过 `node_modules`，那里没有我们要找的东西）。 */
async function walking(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, encoding: 'utf8' })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walking(full)));
    else out.push(full);
  }
  return out;
}

async function install(world: { home: string; root: string }, projectDir: string) {
  const found = await discoverPlugins({ ...world, enabled: [], warn: () => {} });
  expect(found.skipped).toEqual([]);
  return await loadPlugins(found.loaded, {
    projectDir,
    session: { id: 's1', transcriptPath: undefined },
    env: process.env,
    warn: () => {},
  });
}

describe('出口标准一：不改引擎的插件扩展出新能力', () => {
  it('todo 插件加出来的工具能被调用，真的落盘', async () => {
    const world = await worldWith('todo');
    const installed = await install(world, world.root);
    expect(installed.map((p) => p.name)).toEqual(['todo']);

    const { dispatch, $, registry } = await createEngine({
      plugins: installed,
      thirdParty: ['todo'],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });

    // 模型看得见的工具清单是从**注册面**反推的 —— 这就是"多了一个工具"。
    expect($.tool.list()).toContain('TodoWrite');

    const result = await dispatch(
      'tool.call',
      { tool: 'TodoWrite', input: { item: '改一下 README' }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(result).toEqual({ value: '已记下：改一下 README' });
    expect(await readFile(join(world.root, '.deepcode-todo.md'), 'utf8')).toContain('- [ ] 改一下 README');

    // 而且坐在 append，不在任何人的外面。
    expect(registry.hooksFor('tool.call', { tool: 'TodoWrite' }).map((r) => r.tier)).toEqual(['append']);
  });

  it('**准入链也要走通** —— 插件自己应答 tool.check，不然 confirm 会当未知工具拒掉', async () => {
    // 这条是这次唯一走**完整**准入链的断言，也是"插件加的工具真的能用"的分界线：
    // 直接 dispatch tool.call 只能证明钩子写对了，证明不了这个工具**够得着** ——
    // 而真实链里 `confirm` 坐在 builtin 且不调 next，它不认识的工具会被当场拒绝，
    // 链根本到不了 append 上的插件。
    const world = await worldWith('todo');
    const installed = await install(world, world.root);
    // 把真实的第一方链摆进来：coreTools 给 Write/Edit/Bash 的定义，confirm 坐 builtin。
    const { dispatch, registry } = await createEngine({
      plugins: [...coreTools, confirmPlugin, ...installed],
      thirdParty: ['todo'],
      seating: { confirm: 'builtin' },
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });

    const verdict = await dispatch(
      'tool.check',
      { tool: 'TodoWrite', input: { item: 'x' }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(verdict).toEqual({ decision: 'ask', rule: '插件工具：TodoWrite' });

    // 而且它答得比 confirm 更早：链上 todo（append）在 confirm（builtin）**外面**，
    // 这正是设计 §6 推出来的座位。要是它坐到 builtin 或更里，这条断言会先变红，
    // 而上面那条裁决也永远不会来自它。
    const held = registry.hooksFor('tool.check', { tool: 'TodoWrite' });
    expect(held.map((r) => [r.plugin, r.tier])).toEqual([
      ['todo', 'append'],
      ['confirm', 'builtin'],
    ]);
  });

  it('同一个工具，把插件那条注册拿掉就真的够不着 —— 证明上一条测的是真路径', async () => {
    // 反向验证：没有 tool.check 那条注册时，confirm 会把它当未知工具拒掉。
    // 这一条不靠改实现，靠**改输入**（换成一份不注册 tool.check 的同名插件），
    // 于是它同时钉住了"为什么那一行必须有"。
    const bare: Plugin = {
      name: 'todo',
      uses: ['tool.describe', 'tool.call', 'tool.check'],
      register(on) {
        on('tool.describe', { tool: 'TodoWrite' }, () => ({ description: 'x', inputSchema: {} }));
        on('tool.call', { tool: 'TodoWrite' }, () => ({ value: 'ran' }));
      },
    };
    const { dispatch } = await createEngine({
      plugins: [...coreTools, confirmPlugin, bare],
      thirdParty: ['todo'],
      seating: { confirm: 'builtin' },
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    const verdict = await dispatch(
      'tool.check',
      { tool: 'TodoWrite', input: { item: 'x' }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(verdict).toEqual({ decision: 'deny', rule: '未知工具 TodoWrite，不在确认器的白名单里' });
  });

  it('插件给的是垃圾输入时它自己拒绝，不是崩掉', async () => {
    const world = await worldWith('todo');
    const installed = await install(world, world.root);
    const { dispatch } = await createEngine({
      plugins: installed,
      thirdParty: ['todo'],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });
    const result = await dispatch('tool.call', { tool: 'TodoWrite', input: {}, toolUseId: 't1' }, CORE_ORIGIN);
    expect(result).toEqual({ deny: 'TodoWrite 需要 item（非空字符串）' });
  });
});

describe('「不改引擎」的字面证明', () => {
  it('packages/ 里一个字的 secret-guard / TodoWrite 都没有', async () => {
    // 出口标准一那句话的**字面**证明。设计 §10 要求有这条断言（计划里漏了）：
    // 上面那些用例证明的是"装上去能用"，这一条证明的是"内核压根没为它们改过一行" ——
    // 两句话不是一回事，缺了后一句这个出口标准就只是自证。
    const hits: string[] = [];
    for (const file of await walking(join(REPO, 'packages'))) {
      const text = await readFile(file, 'utf8');
      if (/secret-guard|TodoWrite|hookify/.test(text)) hits.push(relative(REPO, file));
    }
    expect(hits).toEqual([]);
  });
});

describe('出口标准三：classic 钩子的 exit 2 真的拦得住', () => {
  async function check(content: string) {
    const world = await worldWith('secret-guard');
    const installed = await install(world, world.root);
    const { dispatch } = await createEngine({
      plugins: installed,
      thirdParty: ['secret-guard'],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });
    return await dispatch(
      'tool.check',
      { tool: 'Write', input: { file_path: 'a.ts', content }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
  }

  it('内容里有密钥 → deny，理由是钩子给的', async () => {
    const result = await check('const key = "sk-ant-abcdefghijklmnopqrstuvwx";\n');
    expect(result.decision).toBe('deny');
    expect(result.rule).toContain('secret-guard');
    expect(result.rule).toContain('Anthropic key');
  });

  it('内容干净 → 钩子一个字不说，判定交回下层（这里是链尾的 fail-closed）', async () => {
    const result = await check('export const add = (a: number, b: number) => a + b;\n');
    expect(result).toEqual({ decision: 'deny', rule: 'fail-closed: 没有 hook 应答 tool.check' });
  });

  it('Bash 不在 matcher 里，钩子不跑', async () => {
    const world = await worldWith('secret-guard');
    const installed = await install(world, world.root);
    const { dispatch } = await createEngine({
      plugins: installed,
      thirdParty: ['secret-guard'],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });
    const result = await dispatch(
      'tool.check',
      { tool: 'Bash', input: { command: 'echo sk-ant-abcdefghijklmnopqrstuvwx' }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(result.rule).toBe('fail-closed: 没有 hook 应答 tool.check');
  });
});

describe('hookify：一份规则文件就是一个 hook，真链路走一遍', () => {
  const KEY = 'AKIAIOSFODNN7EXAMPLE';

  const RULE = `---
name: no-aws-keys
tool: Write|Edit
field: content
operator: matches
pattern: AKIA[0-9A-Z]{16}
decision: deny
message: 文件里出现了形似 AWS access key 的东西
---

要写就先把 key 换成占位符。
`;

  /** 装好 hookify，规则文件按需放进 `<root>/.deepcode/`。 */
  async function engine(rules: Record<string, string>) {
    const world = await worldWith('hookify');
    if (Object.keys(rules).length > 0) {
      await mkdir(join(world.root, '.deepcode'), { recursive: true });
      for (const [name, text] of Object.entries(rules)) {
        await writeFile(join(world.root, '.deepcode', name), text);
      }
    }
    const installed = await install(world, world.root);
    expect(installed.map((p) => p.name)).toEqual(['hookify']);
    const { dispatch } = await createEngine({
      plugins: installed,
      thirdParty: ['hookify'],
      signal: () => new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: world.root, root: world.root },
      env: {},
    });
    return dispatch;
  }

  function write(dispatch: Awaited<ReturnType<typeof engine>>, content: string) {
    return dispatch(
      'tool.check',
      { tool: 'Write', input: { file_path: 'a.ts', content }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
  }

  it('真规则文件拦下真 Write —— 整条链：hooks.json → 脚本 → 规则文件 → deny', async () => {
    const dispatch = await engine({ 'hookify.no-keys.local.md': RULE });
    const result = await write(dispatch, `const k = "${KEY}";\n`);
    expect(result.decision).toBe('deny');
    expect(result.rule).toContain('hookify');
    expect(result.rule).toContain('no-aws-keys');
    expect(result.rule).toContain('占位符');
  });

  it('**没有规则文件时同样的 Write 能过** —— 防"hookify 一装上就什么都不让写"', async () => {
    const dispatch = await engine({});
    // 钩子一个字不说，判定交回下层（这里没有 confirm，落在链尾的 fail-closed）。
    expect(await write(dispatch, `const k = "${KEY}";\n`)).toEqual({
      decision: 'deny',
      rule: 'fail-closed: 没有 hook 应答 tool.check',
    });
  });

  it('规则里的 tool 决定它管不管这次调用 —— Bash 不在 Write|Edit 里', async () => {
    const dispatch = await engine({ 'hookify.no-keys.local.md': RULE });
    // 钩子**跑了**（hooks.json 不写 matcher，对所有工具生效），是脚本按 tool_name 分流的。
    const result = await dispatch(
      'tool.check',
      { tool: 'Bash', input: { command: `echo ${KEY}` }, toolUseId: 't1' },
      CORE_ORIGIN,
    );
    expect(result.rule).toBe('fail-closed: 没有 hook 应答 tool.check');
  });

  it('规则文件写坏了 → deny（fail-closed，不是静默放行）', async () => {
    const dispatch = await engine({ 'hookify.bad.local.md': '这一行不是 frontmatter\n' });
    const result = await write(dispatch, '随便什么内容');
    expect(result.decision).toBe('deny');
    // 理由要说清是哪个文件 —— 否则用户面对"全都不让写了"根本不知道去改哪个。
    expect(result.rule).toContain('hookify');
    expect(result.rule).toContain('hookify.bad.local.md');
  });

  it('decision: allow 是规则文件的错误 → deny，且点名 allow', async () => {
    const allow = RULE.replace('decision: deny', 'decision: allow');
    const dispatch = await engine({ 'hookify.bad.local.md': allow });
    const result = await write(dispatch, '随便什么内容');
    expect(result.decision).toBe('deny');
    expect(result.rule).toContain('allow');
  });
});
