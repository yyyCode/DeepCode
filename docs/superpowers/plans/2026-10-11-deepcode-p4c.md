# DeepCode P4c-1（marketplace 与安装）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给插件系统补上「装进来」这一步 —— 从一份**本地索引**把插件拷进一个**不自动装载**的落点，
而能开这道闸的只有用户自己。

**Architecture:** 新增一个零 IO 的纯校验器 `src/contract/marketplace.ts`（`M1`–`M8` / `W1`，
读取一律注入，与 `plugin-manifest.ts` 同形）；发现层加第三个 origin `installed`，
闸门名单只认**用户层**（`ResolvedPolicy.plugins.enableByUser`，与既有的
`PLUGIN_ENABLE_SOURCES` 分家）；落盘先写**落点的兄弟目录**再 `rename`（原子）。

**Tech Stack:** TypeScript（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、
Node ≥ 20、vitest、零运行时依赖。

**依据：** [`docs/superpowers/specs/2026-10-11-deepcode-p4c-design.md`](../specs/2026-10-11-deepcode-p4c-design.md)

**验收口径（用户长期指令）：** 任务级只跑 `pnpm typecheck`；测试按检查点批量做（C1 / C2），
不逐任务卡。任务之间连续执行，不要停下来问。

---

## 文件结构

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/contract/marketplace.ts` | **新建** | 索引 schema + 纯校验（`M1`–`M8` / `W1`）。零 IO，`root` 只用于组标签 |
| `test/marketplace.test.ts` | **新建** | 上面那个校验器的正反用例 |
| `src/cli/plugin-install.ts` | **新建** | **唯一**往 `~/.deepcode/installed/` 写东西的地方：目标已存在就拒、暂存 + `rename`、失败清残骸 |
| `.deepcode-plugin/marketplace.json` | **新建** | 仓库自己当一份 marketplace，列 `secret-guard` 与 `todo` |
| `src/cli/plugin-dir.ts` | 改 | `INSTALLED_DIR` / `STAGING_DIR`、第三个 origin、闸门与两种理由、`enabledInstalled?`、改名 |
| `src/cli/plugin-command.ts` | 改 | `add` / `remove` 分支、`list` 第三节、`PLUGIN_HELP` |
| `src/cli/args.ts` | 改 | `add` / `remove` 子命令、`--from=`、`HELP_TEXT` 的插件段 |
| `src/cli/settings.ts` | 改 | `enableByUser`、`readPlugins` 对 user 层的处置、`PLUGIN_ENABLE_SOURCES` 的注释 |
| `src/cli/main.ts` | 改 | 两处接线（`enabledInstalled`、`enabledByUser`）+ 改名后的 import |
| `src/core/create.ts` | 改 | `:22` 注释里的函数名 |
| `test/plugin-dir.test.ts` / `test/plugin-command.test.ts` / `test/settings-plugins.test.ts` / `test/cli.test.ts` / `test/plugin-wiring.test.ts` / `test/plugin-e2e.test.ts` | 改 | 新增用例 + 改名 + `ResolvedPolicy` 字面量补字段 |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 改 | 收口 |

**顺序上的一个约束（不满足会中途红）：** `ResolvedPolicy.plugins.enableByUser` 是**必填**字段，
加上它的一瞬间 `test/cli.test.ts` 与 `test/plugin-wiring.test.ts` 里的 `ResolvedPolicy` 字面量
就过不了 `tsc`。所以 Task 2 的 Step 1 必须**同时**改 `settings.ts` 与那两个测试文件，
再跑 typecheck。

---

## Task 1：索引校验器（`M1`–`M8` / `W1`）

**Files:**
- Create: `src/contract/marketplace.ts`
- Test: `test/marketplace.test.ts`

判据的权威定义在 spec §2.2 的表里。这一条与 `plugin-manifest.ts` 同形：纯逻辑、读取注入，
所以它能在没有文件系统的地方跑，也能被 `plugin add` 与将来的消费者**共用同一份实现**。

**为什么必须注入而不能自己拼路径：** `scripts/check-boundaries.mjs:18-24` 的规则表里
`contract: []` —— `contract/` 不许 import `src/` 下任何顶层目录。而「把某个 `source` 打开成
一个插件目录」要用 `cli/plugin-dir.ts:73` 的 `dirReader`。同目录内的相对 import 不算越界
（`check-boundaries.mjs:89` `if (targetArea === area) continue`），所以
`./plugin-manifest` 是合法的，`../cli/plugin-dir` 不是。

- [ ] **Step 1: 写失败的测试**

新建 `test/marketplace.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { validateMarketplace, type MarketplaceDeps } from '../src/contract/marketplace';
import type { PluginReader } from '../src/contract/plugin-manifest';

/**
 * 一份内存里的 marketplace 现场：索引文本 + 若干「插件目录」。
 *
 * 全部在内存里，不碰盘 —— 这份校验器是纯逻辑，测试就该按纯逻辑测。
 * `read` 返回 undefined（而不是抛）是那个 reader 契约里「不存在是常态」的一半。
 */
type World = Record<string, Record<string, string>>;

function deps(index: string | undefined, world: World): MarketplaceDeps {
  return {
    async readIndex() {
      return index;
    },
    openPlugin(source: string): PluginReader {
      const files = world[source] ?? {};
      return {
        async read(relative) {
          return files[relative];
        },
        async exists(relative) {
          return files[relative] !== undefined;
        },
      };
    },
  };
}

/** 一份带入口模块的清单：不给入口也没有钩子的话会多一条 W9，好用例就不干净了。 */
// ⚠️ `uses` 必须把 tool 三件套凑齐。只写 describe + call 的话，M6 委托给
// `validatePlugin` 时会从那边带回一条 **W7**（`plugin-manifest.ts:286`：
// 「uses 里有 tool.call 却没有 tool.check」），好用例照样不干净 —— 这是写计划时
// 漏掉的一处，执行时才炸出来。三件都要，这才是一份无警告的清单。
const GOOD_MANIFEST = {
  name: 'todo',
  version: '0.1.0',
  uses: ['tool.describe', 'tool.call', 'tool.check'],
  entry: './main.mjs',
};
const GOOD_FILES = {
  'plugin.json': JSON.stringify(GOOD_MANIFEST),
  './main.mjs': 'export default { register() {} }',
};
const GOOD_WORLD: World = { './plugins/todo': GOOD_FILES };
const GOOD_INDEX = JSON.stringify({
  name: 'deepcode',
  description: 'DeepCode 自带的插件',
  plugins: [{ name: 'todo', description: '加一个 TodoWrite 工具', source: './plugins/todo' }],
});

/** 只改一个字段的索引，用来一条一条地钉判据。 */
function indexWith(entry: Record<string, unknown>): string {
  return JSON.stringify({ name: 'deepcode', plugins: [entry] });
}

describe('validateMarketplace', () => {
  it('一份好索引全绿，条目里带的是**已归一**的清单', async () => {
    const result = await validateMarketplace('/repo', deps(GOOD_INDEX, GOOD_WORLD));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    const entry = result.entries?.[0];
    expect(entry?.name).toBe('todo');
    expect(entry?.description).toBe('加一个 TodoWrite 工具');
    expect(entry?.source).toBe('./plugins/todo');
    // 归一之后才有 version（清单里没写就是 0.0.0）、uses、paths —— 这是「不必再校验一次」的意思。
    expect(entry?.manifest.version).toBe('0.1.0');
    expect(entry?.manifest.uses).toEqual(['tool.describe', 'tool.call', 'tool.check']);
    expect(entry?.manifest.paths.entry).toEqual(['./main.mjs']);
  });

  it('M1 索引根本不存在', async () => {
    const result = await validateMarketplace('/repo', deps(undefined, {}));
    expect(result.ok).toBe(false);
    expect(result.entries).toBeUndefined();
    expect(result.problems).toEqual([
      {
        level: 'error',
        code: 'M1',
        message: expect.stringContaining('.deepcode-plugin/marketplace.json'),
      },
    ]);
  });

  it('M1 不是合法 JSON', async () => {
    const result = await validateMarketplace('/repo', deps('{ "name": ', {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M1']);
    expect(result.problems[0]?.message).toContain('不是合法 JSON');
  });

  it('M1 顶层是数组（是个对象之外的一切）', async () => {
    const result = await validateMarketplace('/repo', deps('[]', {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M1' });
    expect(result.problems[0]?.message).toContain('顶层不是一个对象');
  });

  it('M2 name 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ plugins: [] }), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M2' });
    expect(result.problems[0]?.message).toContain('缺少 name');
  });

  it('M2 name 不是 kebab-case', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'DeepCode', plugins: [] }), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M2' });
    expect(result.problems[0]?.message).toContain('kebab-case');
  });

  it('M3 plugins 不是数组', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'x', plugins: {} }), {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M3']);
    expect(result.problems[0]?.message).toContain('必须是数组');
  });

  it('M3 plugins 是空数组', async () => {
    const result = await validateMarketplace('/repo', deps(JSON.stringify({ name: 'x', plugins: [] }), {}));
    expect(result.problems.map((p) => p.code)).toEqual(['M3']);
    expect(result.problems[0]?.message).toContain('空的');
  });

  it('M4 条目不是对象', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith('nope' as never), {}));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('不是一个对象');
  });

  it('M4 条目 name 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith({ source: './plugins/todo' }), GOOD_WORLD));
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('缺少 name');
  });

  it('M4 条目 name 不是 kebab-case', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'Todo', source: './plugins/todo' }), GOOD_WORLD),
    );
    expect(result.problems[0]).toMatchObject({ level: 'error', code: 'M4' });
    expect(result.problems[0]?.message).toContain('kebab-case');
  });

  it('M4 名字在本索引内重复', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      plugins: [
        { name: 'todo', source: './plugins/todo' },
        { name: 'todo', source: './plugins/todo' },
      ],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('M4');
    expect(result.problems.some((p) => p.message.includes('重名'))).toBe(true);
  });

  it('M5 source 缺失', async () => {
    const result = await validateMarketplace('/repo', deps(indexWith({ name: 'todo' }), GOOD_WORLD));
    const m5 = result.problems.find((p) => p.code === 'M5');
    expect(m5?.level).toBe('error');
    expect(m5?.message).toContain('./');
  });

  it('M5 source 逃出索引根（`../x`）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: '../outside' }), GOOD_WORLD),
    );
    const m5 = result.problems.find((p) => p.code === 'M5');
    expect(m5?.level).toBe('error');
    expect(m5?.message).toContain('不含 .. 与反斜杠');
    expect(result.entries).toBeUndefined();
  });

  it('M5 source 用反斜杠（Windows 上会被归一成逃逸路径）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: '.\\plugins\\todo' }), GOOD_WORLD),
    );
    expect(result.problems.map((p) => p.code)).toContain('M5');
  });

  it('M6 直接吃 validatePlugin 的结论 —— source 指向的目录根本不存在不需要单独一条规则', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/gone' }), GOOD_WORLD),
    );
    const e2 = result.problems.find((p) => p.code === 'E2');
    expect(e2?.level).toBe('error');
    // 理由文案里必须带 source 路径，否则人不知道是哪一条。
    expect(e2?.message).toContain('./plugins/gone');
    expect(result.ok).toBe(false);
  });

  it('M6 清单坏了（E3 名字）时也带 source 路径', async () => {
    const bad: World = { './plugins/bad': { 'plugin.json': JSON.stringify({ name: 'BadName' }) } };
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'bad', source: './plugins/bad' }), bad),
    );
    const e3 = result.problems.find((p) => p.code === 'E3');
    expect(e3?.level).toBe('error');
    expect(e3?.message).toContain('./plugins/bad');
  });

  it('M7 description 写了就要是字符串（顶层）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/todo' }).replace('"plugins"', '"description":3,"plugins"'), GOOD_WORLD),
    );
    expect(result.problems.find((p) => p.code === 'M7')?.level).toBe('error');
  });

  it('M7 description 写了就要是字符串（条目）', async () => {
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', description: 3, source: './plugins/todo' }), GOOD_WORLD),
    );
    expect(result.problems.find((p) => p.code === 'M7')?.message).toContain('plugins[0].description');
  });

  it('M8 索引名字与清单名字不一致 —— 静默的就是这一条', async () => {
    const other: World = {
      './plugins/todo': {
        'plugin.json': JSON.stringify({ ...GOOD_MANIFEST, name: 'todo-write' }),
        './main.mjs': GOOD_FILES['./main.mjs'],
      },
    };
    const result = await validateMarketplace(
      '/repo',
      deps(indexWith({ name: 'todo', source: './plugins/todo' }), other),
    );
    const m8 = result.problems.find((p) => p.code === 'M8');
    expect(m8?.level).toBe('error');
    // 这句理由要说出后果：照 list 写 plugins.enable 会静默不生效。
    expect(m8?.message).toContain('plugins.enable');
    expect(result.entries).toBeUndefined();
  });

  it('W1 未识别的字段只警告，不影响可用', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      category: 'tools',
      plugins: [{ name: 'todo', source: './plugins/todo', version: '0.2.0' }],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    const w1 = result.problems.filter((p) => p.code === 'W1');
    expect(w1.every((p) => p.level === 'warn')).toBe(true);
    expect(w1.map((p) => p.message).join('\n')).toContain('category');
    expect(w1.map((p) => p.message).join('\n')).toContain('version');
  });

  it('多条目：坏的那一条不连累好的，但整份索引仍然不可用', async () => {
    const index = JSON.stringify({
      name: 'deepcode',
      plugins: [
        { name: 'todo', source: './plugins/todo' },
        { name: 'gone', source: './plugins/gone' },
      ],
    });
    const result = await validateMarketplace('/repo', deps(index, GOOD_WORLD));
    expect(result.ok).toBe(false);
    // entries 在 ok=false 时一律 undefined —— 半个可用清单比没有更危险。
    expect(result.entries).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑一遍，确认它红**

Run: `pnpm exec vitest run test/marketplace.test.ts`
Expected: FAIL —— `Failed to load url ../src/contract/marketplace`（这是 vite 的措辞，
与「解析不了这个 import」是同一个失败类别）。

- [ ] **Step 3: 写实现**

新建 `src/contract/marketplace.ts`：

```ts
import {
  isPluginName,
  isSafeRelativePath,
  validatePlugin,
  type PluginManifest,
  type PluginReader,
  type Problem,
} from './plugin-manifest';

/**
 * marketplace 索引（`<根>/.deepcode-plugin/marketplace.json`）的校验。
 *
 * **与 `plugin-manifest.ts` 同形**：纯逻辑，读取一律注入 —— 于是它能在没有文件系统的地方跑，
 * 也能被 `plugin add` 与将来的消费者**共用同一份实现**。
 *
 * 注入形状是被依赖边界逼出来的：`scripts/check-boundaries.mjs` 里 `contract: []`，
 * 这份文件不许 import `src/` 下任何顶层目录。而「把某个 source 打开成一个插件目录」要用
 * `cli/plugin-dir.ts` 的 `dirReader` —— 所以只能收一个工厂，不能自己拼路径。
 *
 * 判据两级，与清单校验同一种分法：`M` 是错误（这份索引不可用），`W` 是警告（可用，但说出来）。
 * 第六七条（`M6`）不另写规则，直接吃 `validatePlugin` 的结论 —— 「共用同一份实现」就是这意思。
 * 顺带一个收益：「source 指向的目录不存在」不需要单独的规则，那份校验器的 `E2` 已经覆盖了，
 * 而且措辞在那个场景下恰好是对的。
 */

export type MarketplaceDeps = {
  /** 读索引本身。**读不到返回 undefined**（不存在是常态，不是错）。 */
  readonly readIndex: () => Promise<string | undefined>;
  /** 把某个 source 打开成一个插件目录读取面，交给 `validatePlugin` 用。 */
  readonly openPlugin: (source: string) => PluginReader;
};

export type MarketplaceEntry = {
  readonly name: string;
  readonly description: string | undefined;
  /** 通过 `isSafeRelativePath` 的原始写法，如 `./plugins/todo`。 */
  readonly source: string;
  /** 那份清单**归一之后**的形状 —— `plugin add` 要拿它打报告，不必再校验一次。 */
  readonly manifest: PluginManifest;
};

export type ValidatedMarketplace = {
  readonly problems: readonly Problem[];
  /** 有没有 E 级问题。false = 这份索引不可用。 */
  readonly ok: boolean;
  /** 全绿时的条目表（名字已与清单核对过）。有 E 时是 undefined。 */
  readonly entries: readonly MarketplaceEntry[] | undefined;
};

const KNOWN_TOP: ReadonlySet<string> = new Set(['name', 'description', 'plugins']);
const KNOWN_ENTRY: ReadonlySet<string> = new Set(['name', 'description', 'source']);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `root` 只用来组给人看的标签，**不用于拼路径** —— 拼路径是注入方的活。
 * 路径那一半写在这儿是要紧的：`plugin add --from=<目录>` 的索引就在那个位置，
 * 而报错里不写全路径，人就不知道自己刚才指了哪儿。
 */
export async function validateMarketplace(
  root: string,
  deps: MarketplaceDeps,
): Promise<ValidatedMarketplace> {
  const at = `${root} 下的 .deepcode-plugin/marketplace.json`;
  const problems: Problem[] = [];
  const err = (code: string, text: string): void => {
    problems.push({ level: 'error', code, message: text });
  };
  const warn = (code: string, text: string): void => {
    problems.push({ level: 'warn', code, message: text });
  };
  const giveUp = (): ValidatedMarketplace => ({ problems, ok: false, entries: undefined });

  // ── M1 读得到、是好 JSON、顶层是对象 ──
  let text: string | undefined;
  try {
    text = await deps.readIndex();
  } catch (error) {
    err('M1', `${at} 读不了：${message(error)}`);
    return giveUp();
  }
  if (text === undefined) {
    err('M1', `${at} 不存在`);
    return giveUp();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    err('M1', `${at} 不是合法 JSON：${message(error)}`);
    return giveUp();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('M1', `${at} 的顶层不是一个对象`);
    return giveUp();
  }
  const record = raw as Record<string, unknown>;

  // ── M2 name ──
  const rawName = record.name;
  if (typeof rawName !== 'string') {
    err('M2', `${at} 缺少 name（必填，字符串）`);
  } else if (!isPluginName(rawName)) {
    err('M2', `${at} 的 name ${JSON.stringify(rawName)} 不是 kebab-case`);
  }

  // ── M7 description（顶层） ──
  if (record.description !== undefined && typeof record.description !== 'string') {
    err('M7', `${at} 的 description 必须是字符串`);
  }

  // ── W1 未知顶层字段 ──
  const unknownTop = Object.keys(record).filter((key) => !KNOWN_TOP.has(key));
  if (unknownTop.length > 0) {
    warn('W1', `${at} 有未识别的顶层字段：${unknownTop.join('、')}（本版本忽略）`);
  }

  // ── M3 plugins ──
  const list = record.plugins;
  if (!Array.isArray(list)) {
    err('M3', `${at} 的 plugins 必须是数组`);
    return giveUp();
  }
  if (list.length === 0) {
    err('M3', `${at} 的 plugins 是空的 —— 一份没有条目的索引没有意义`);
    return giveUp();
  }

  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();

  for (const [index, item] of list.entries()) {
    const where = `plugins[${index}]`;

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err('M4', `${at} 的 ${where} 不是一个对象`);
      continue;
    }
    const entry = item as Record<string, unknown>;

    // ── M4 name ──
    const rawEntryName = entry.name;
    let name: string | undefined;
    if (typeof rawEntryName !== 'string') {
      err('M4', `${at} 的 ${where} 缺少 name（必填，字符串）`);
    } else if (!isPluginName(rawEntryName)) {
      err('M4', `${at} 的 ${where}.name ${JSON.stringify(rawEntryName)} 不是 kebab-case`);
    } else if (seen.has(rawEntryName)) {
      err('M4', `${at} 的 ${where}.name ${JSON.stringify(rawEntryName)} 与前面某一条重名 —— 一个索引里名字必须唯一`);
    } else {
      name = rawEntryName;
      seen.add(rawEntryName);
    }

    // ── M7 description（条目） ──
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      err('M7', `${at} 的 ${where}.description 必须是字符串`);
    }

    // ── W1 未知条目字段 ──
    const unknownEntry = Object.keys(entry).filter((key) => !KNOWN_ENTRY.has(key));
    if (unknownEntry.length > 0) {
      warn('W1', `${at} 的 ${where} 有未识别的字段：${unknownEntry.join('、')}（本版本忽略）`);
    }

    // ── M5 source ──
    // 与清单校验用**同一条** `isSafeRelativePath`：读索引不该另立一套。
    const source = entry.source;
    if (typeof source !== 'string' || !isSafeRelativePath(source)) {
      err(
        'M5',
        `${at} 的 ${where}.source 必须是相对的、以 ./ 开头、不含 .. 与反斜杠，实际是 ${JSON.stringify(source)}`,
      );
      continue;
    }

    // ── M6 直接调既有的 validatePlugin ──
    // 挂上标签是因为 E 编号属于那份清单，而报错得让人知道是哪一条索引条目里的事。
    const validated = await validatePlugin(`${where}（${source}）`, deps.openPlugin(source));
    for (const problem of validated.problems) {
      problems.push({
        level: problem.level,
        code: problem.code,
        message: `${where}（${source}）里的清单：${problem.message}`,
      });
    }

    if (!validated.ok || validated.manifest === undefined) continue;
    const manifest = validated.manifest;
    if (name === undefined) continue;

    // ── M8 索引名字与清单名字必须一致 ──
    // 不一致是**静默**的：你照着 `plugin list` 打印的名字写 plugins.enable，
    // 然后插件不生效，没有一条报错解释为什么。
    if (manifest.name !== name) {
      err(
        'M8',
        `${at} 的 ${where}.name 是 ${JSON.stringify(name)}，而 ${source} 里那份清单的 name 是 ` +
          `${JSON.stringify(manifest.name)} —— 两者必须一致，否则照 list 写 plugins.enable 会静默不生效`,
      );
      continue;
    }

    entries.push({
      name,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      source,
      manifest,
    });
  }

  const ok = !problems.some((problem) => problem.level === 'error');
  // 有 E 就一个条目都不给：半个可用清单比没有更危险。
  return { problems, ok, entries: ok ? entries : undefined };
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `pnpm exec vitest run test/marketplace.test.ts`
Expected: PASS，`Tests  22 passed`（计划初稿写 21，是自己数错了；实际 22）。

- [ ] **Step 5: 依赖边界不能破**

Run: `pnpm lint`
Expected: `依赖边界检查通过` + `工作流硬化检查通过`（`contract/marketplace.ts` 只 import 同目录的
`./plugin-manifest`，同目录内不算越界）。

- [ ] **Step 6: 提交**

```bash
git add src/contract/marketplace.ts test/marketplace.test.ts
git commit -m "feat(p4c): marketplace 索引的纯校验器（M1–M8 / W1）"
```

---

## Task 2：落点与发现层（第三个 origin + 只有用户层能开闸）

**Files:**
- Modify: `src/cli/settings.ts`（`enableByUser`、`readPlugins` 对 user 层的处置、注释）
- Modify: `src/cli/plugin-dir.ts`（`INSTALLED_DIR` / `STAGING_DIR`、`PluginOrigin`、`roots`、闸门、`DiscoverDeps.enabledInstalled?`）
- Modify: `src/cli/main.ts:205-210`
- Test: `test/plugin-dir.test.ts`、`test/settings-plugins.test.ts`、`test/cli.test.ts`、`test/plugin-wiring.test.ts`

- [ ] **Step 1: `settings.ts` —— 加 `enableByUser`，并让 user 层的 enable 真的被收下**

**先看清楚一个坑：** 今天 `readPlugins`（`settings.ts:440-447`）在 user 层写 `enable` 时会
**`continue`** —— 那个名字根本没进这一层的 `PluginsLayer.enable`。而 `pluginsBySource`
（`:183-191`）拿到的就是这个值。所以只加一行 `enableByUser: pluginsBySource.get('user')?.enable`
会**永远得到空数组**，且是静默的。必须同时改那一处。

**(a)** `settings.ts:102`，`ResolvedPolicy.plugins` 加一个字段：

```ts
  /**
   * 五层合并后的插件名单，带来源。
   *
   * `enable` 只来自 project / local / flag；`deny` 来自五层并集 ——
   * 它只能关掉东西，永远不可能放宽，于是"谁写的"对结果毫无影响。
   *
   * `enableByUser` 是**唯一**认用户层的一处，而它只管落点
   * `~/.deepcode/installed/`（设计 §0 决策 3）。这个不对称不是疏漏：
   * 把落点并进上面那个名单，别人仓库里的 settings.json 就能按名字点亮你全局装的东西。
   */
  readonly plugins: {
    readonly enable: readonly PluginRule[];
    readonly enableByUser: readonly string[];
    readonly deny: readonly PluginRule[];
  };
```

**(b)** `settings.ts:230-241` 的 `return` 里，`plugins` 加一行：

```ts
    plugins: {
      enable: dedupe(
        PLUGIN_ENABLE_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.enable ?? []),
        ),
      ),
      // 用户层**不经** PLUGIN_ENABLE_SOURCES，直接取那一层读到的名字。
      // 它只喂落点，不会让 ~/.deepcode/plugins/ 里的东西被启用 —— 上面那个 flatMap
      // 只看 PLUGIN_ENABLE_SOURCES，所以这条路径改不了那里的行为。
      // 去重是因为它是给 discoverPlugins 的 includes 用的：重复项无害，但显示会难看。
      enableByUser: [...new Set(pluginsBySource.get('user')?.enable ?? [])],
      deny: dedupe(
        SETTINGS_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.deny ?? []),
        ),
      ),
    },
```

**(c)** `settings.ts:440-447` 的 `readPlugins` —— 把这段**原样**（`settings.ts:440-447`）：

```ts
      if (key === 'enable' && !PLUGIN_ENABLE_SOURCES.includes(layer.source as never)) {
        warn(
          layer.source === 'user'
            ? `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认 user 层（用户级插件本来就自动装载）。`
            : `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认托管层（托管策略只该能收紧，不该替你打开一个插件）。`,
        );
        continue;
      }
      out[key].push(name);
```

换成：

```ts
      // ⚠️ 托管层照旧丢掉，user 层**必须收下** —— 两条路从这一轮起不一样了。
      // user 层的 enable 是落点唯一的开关（设计 §0 决策 3），所以这个名字得落到本层的
      // `enable` 里，好让 `enableByUser` 取得到它。它仍然进不了**合并后**的
      // `plugins.enable`：那一步只走 PLUGIN_ENABLE_SOURCES（settings.ts:230-241）。
      // 改之前这里是一句"不认识就 continue"，于是"收下"这件事在代码里根本不存在 ——
      // 直接加 enableByUser 会**静默得到空数组**，而且测试也发现不了。
      if (key === 'enable' && layer.source === 'policy') {
        warn(
          `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认托管层（托管策略只该能收紧，不该替你打开一个插件）。`,
        );
        continue;
      }
      if (key === 'enable' && layer.source === 'user') {
        warn(
          `${label(layer.source)} ${where} 的用户级这一条对自动装载目录不生效 —— ` +
            `plugins.enable 不认 user 层的 ~/.deepcode/plugins/（用户级插件本来就自动装载）；` +
            `它唯一管用的是落点 ~/.deepcode/installed/：那里的插件只认这一层。`,
        );
      }
      out[key].push(name);
```

（既有测试 `test/settings-plugins.test.ts:75` 断言 `toContain('plugins.enable 不认 user 层')` ——
新文案里仍含这串字，所以那条**不用改**。`PLUGIN_ENABLE_SOURCES` 这个常量也还要留着：
`resolvePolicy` 的 `flatMap` 仍在用它。）

**(d)** `settings.ts:31-38` 的常量注释加一句，否则下一个人会把这个不对称当 bug 修掉：

```ts
/**
 * `plugins.enable` 认哪几层。
 *
 * 少了 `user`：用户级目录本来就自动装载，写 enable 是没用的。
 * 少了 `policy`：托管策略写 enable 会变成"组织替你打开一个插件" ——
 * 托管策略只该能收紧，不该能替你打开东西（设计 §3）。
 *
 * ⚠️ **落点（`~/.deepcode/installed/`）是唯一的例外**：那一层只认用户层的 enable，
 * 走的是 `ResolvedPolicy.plugins.enableByUser`，不经这个常量（P4c 设计 §0 决策 3）。
 * 所以 user 层的 enable 名字**会被读进来**，只是不进这里合并出的那个名单 ——
 * 看起来像 bug，不是 bug。
 */
```

**(e)** 补**三**个测试到 `test/settings-plugins.test.ts` 的 `plugins 的五层合并` describe 末尾：

```ts
  it('user 层的 enable 虽然不进 enable，但会进 enableByUser —— 落点只认这一层', async () => {
    const { policy } = await run({
      [PATHS.user]: JSON.stringify({ plugins: { enable: ['installed-one'] } }),
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['from-project'] } }),
    });
    expect(policy.plugins.enable.map((r) => r.name)).toEqual(['from-project']);
    expect(policy.plugins.enableByUser).toEqual(['installed-one']);
  });

  it('用户层没写就是空 —— 默认什么都不开', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['todo'] } }),
    });
    expect(policy.plugins.enableByUser).toEqual([]);
  });

  it('enableByUser 只取用户层：项目级写的名字不在里面', async () => {
    const { policy } = await run({
      [PATHS.project]: JSON.stringify({ plugins: { enable: ['from-project'] } }),
      [PATHS.local]: JSON.stringify({ plugins: { enable: ['from-local'] } }),
    });
    expect(policy.plugins.enableByUser).toEqual([]);
  });
```

**(f)** `enableByUser` 是必填字段，两个测试文件的 `ResolvedPolicy` 字面量现在过不了 `tsc`：

- `test/plugin-wiring.test.ts:19` 的 `plugins: { enable: [], deny: [] }` → 加 `enableByUser: []`；
  同文件 `:116` 那个 spread 覆盖里的 `plugins: { enable: [...], deny: [...] }` 也加 `enableByUser: []`。
- `test/cli.test.ts`：在 `:45` 的 `const NO_PLUGINS = ...` **下面**加一行

```ts
/** policy 级的 plugins 段：比 SourceInfo 里那个 `PluginsLayer` 多一个 enableByUser。 */
const NO_PLUGIN_POLICY = { ...NO_PLUGINS, enableByUser: [] } as const;
```

  然后把**policy 级**的**四**处 `plugins: NO_PLUGINS` 换成 `plugins: NO_PLUGIN_POLICY`：

  | 行 | 在哪儿 |
  | --- | --- |
  | `:52` | `const NO_POLICY: ResolvedPolicy` 的字面量 |
  | `:268` | 那条 fail-closed 测试里传给 `registered({...})` 的字面量 |
  | `:584` | `fixturePolicy(): ResolvedPolicy` 的 return |
  | `:619` | `const empty: ResolvedPolicy` |

  ⚠️ **`:268` 这一处容易漏** —— 它不在 `NO_POLICY` 附近，而在一个测试体中间，
  但它进的是 `registered(policy: ResolvedPolicy = NO_POLICY, …)`（`:183`），
  所以形状要求与另外三处**完全一样**。（计划初稿只点了三处，是逐行核源码时补上的第四条。）

  ⚠️ `fixturePolicy` 里 `sources: [...]` 那五处 `plugins: NO_PLUGINS`（`:564`、`:566`、`:570`、
  `:572`、`:575`）**不动** —— 那是 `SourceInfo.plugins`，形状是 `PluginsLayer`，没有那个字段。

Run: `grep -c "plugins: NO_PLUGINS" test/cli.test.ts`
Expected: 改之前 **9** 处；改完 **5** 处，且这 5 处全落在 `:564`–`:575` 那段 `sources: [...]` 里
（`grep -n "plugins: NO_PLUGINS" test/cli.test.ts` 逐行核一遍）。

- [ ] **Step 2: typecheck 这一关先过**

Run: `pnpm typecheck`
Expected: 无输出、退出码 0。

- [ ] **Step 3: `plugin-dir.ts` —— 第三个 origin**

**(a)** `:26` 的类型加一个成员（**追加**，不改既有两个成员的顺序）：

```ts
export type PluginOrigin = 'user' | 'project' | 'installed';
```

**(b)** `:65` 旁边的两个常量：

```ts
/**
 * 用户自己放插件的目录。项目级与用户级共用这个相对路径。
 */
const USER_DIR = ['.deepcode', 'plugins'] as const;

/**
 * 落点：`plugin add` 装进来的地方。
 *
 * 它与 `USER_DIR` 只差一个词，但语义完全不同 —— **不参与自动装载**：
 * 这个目录里的插件要**用户级**设置显式 `plugins.enable` 才跑（设计 §0 决策 2）。
 * 常量名与 origin 名相同是特意选的：读代码时两个词指同一件事，不用在脑子里做映射。
 */
export const INSTALLED_DIR = ['.deepcode', 'installed'] as const;

/**
 * 落盘的暂存目录。
 *
 * **它必须是落点的兄弟节点**（同在 `~/.deepcode/` 下），不能放进落点里 ——
 * `subdirectories()`（`walkdir.ts:38-49`）的过滤条件**只有 `entry.isDirectory()`，
 * 没有任何名字规则**：不排点开头、不排 `.tmp`、什么都不排。所以落点里的任何临时目录
 * 在拷贝窗口内都会被 `plugin list` 当成一个坏插件扫出来。
 * 选这儿还因为它与落点**同一个文件系统**（都在 `~/.deepcode/` 下），
 * 于是 `rename` 是真原子动作；换成系统临时目录就退化成跨设备的拷贝，那还不如不原子。
 */
export const STAGING_DIR = ['.deepcode', '.installed-staging'] as const;
```

**(c)** 头部 `:11-24` 那段注释在「两段，不是一个函数」之后补一句（它今天只说两个目录）：

```
 * ⚠️ 目录有**三个来源**，不是两个：项目级、用户级，以及 `plugin add` 装进来的落点。
 * 三者的闸门不一样：项目级要 `plugins.enable`、用户级自动装载、落点要**用户级的**
 * `plugins.enable`（`enabledInstalled`）。前两者的语义自 P3 起一个字没改。
```

**(d)** `DiscoverDeps`（`:53-63`）加一个可选字段：

```ts
export type DiscoverDeps = {
  readonly home: string;
  readonly root: string;
  /**
   * 项目级目录里哪几个被显式启用了（来自五层合并后的 `plugins.enable`）。
   * **用户级不受它管**：用户级一律自动装载 —— 那是"我自己装的插件"，
   * 与"这个仓库要求我装什么"是两件事（设计 §3）。
   */
  readonly enabled: readonly string[];
  /**
   * 装进来的那一层（落点）要哪几个名字启用。**只认用户层**，理由见设计 §0 决策 3：
   * 把落点并进同一个名单，别人仓库里的 settings.json 就能按名字点亮你全局装着的插件。
   *
   * 可选而不是必填，两个理由：默认值 fail-closed（不给 = 一个都不开），
   * 以及既有十几处 `{ ...world, enabled: [] }` 的调用点不用全改。
   */
  readonly enabledInstalled?: readonly string[];
  readonly warn?: (line: string) => void;
};
```

**(e)** `roots`（`:98-113`）加第三个来源，并把顺序写清楚：

```ts
export async function discoverPlugins(deps: DiscoverDeps): Promise<Discovery> {
  const warn = deps.warn ?? (() => {});
  const enabledInstalled = deps.enabledInstalled ?? [];
  const projectDir = join(deps.root, ...USER_DIR);
  const userDir = join(deps.home, ...USER_DIR);
  const installedDir = join(deps.home, ...INSTALLED_DIR);

  // 顺序：project > user > installed。既有两级的相对顺序与语义一个字不改；
  // 中介最多的那个来源排最后 —— 同名冲突时，更**直接**的那个赢
  // （下面 `claimed` 那张表在做这件事，语义照旧）。
  //
  // 落点与前两者不会撞路径：`INSTALLED_DIR` 与 `USER_DIR` 是两个目录名，
  // 所以这里不需要去重。
  const roots: readonly { origin: PluginOrigin; dir: string }[] = [
    ...(resolve(projectDir) === resolve(userDir)
      ? // home 兜底成 root 时两个目录是同一个（main.ts 的 home 默认值）。那种情况下
        // 按用户级算：它本来就是"我自己装的那个目录"，没有"这个仓库要求"可言。
        [{ origin: 'user', dir: userDir } as const]
      : [
          { origin: 'project', dir: projectDir } as const,
          { origin: 'user', dir: userDir } as const,
        ]),
    // 落点永远单独一个来源。它跟谁都不共目录，闸门也是另一份名单。
    { origin: 'installed', dir: installedDir },
  ];
```

**(f)** 闸门（`:142-150`）从 `origin === 'project'` 扩成 `origin !== 'user'`，
**两种理由分开写** —— 两种情况的解法不同，写同一句就是让人照着做却做不成：

```ts
      const manifest = validated.manifest;
      // user 级不受任何名单管；其余两级各有一份：项目级那份来自五层合并的
      // `plugins.enable`，落点那份只认**用户层**设置（设计 §0 决策 3）。
      const enabledNames = origin === 'installed' ? enabledInstalled : deps.enabled;
      if (origin !== 'user' && !enabledNames.includes(manifest.name)) {
        skipped.push({
          dir: pluginDir,
          origin,
          name: manifest.name,
          reason:
            origin === 'project'
              ? `项目级插件要显式启用：在 .deepcode/settings.json 里写 plugins.enable: ["${manifest.name}"]`
              : `装进来的插件只能由用户级设置启用：在 ~/.deepcode/settings.json 里写 plugins.enable: ["${manifest.name}"]（项目级设置里写同一个名字不算数）`,
        });
        continue;
      }
```

- [ ] **Step 4: `main.ts` 接线**

`:205-210` 那一处加一行：

```ts
  const found = await discoverPlugins({
    home,
    root,
    enabled: policy.plugins.enable.map((rule) => rule.name),
    // 落点只认用户层的名单 —— 与上面那行**不是同一个东西**，别合并（设计 §0 决策 3）。
    enabledInstalled: policy.plugins.enableByUser,
    warn: (line) => process.stderr.write(`${line}\n`),
  });
```

（`:103` 那处 `pluginPolicy.plugins.enable.map(...)` **不动** —— 那是给 `plugin list` 的项目级用的。
`plugin list` 要显示落点的启用状态，那一处会在 Task 5 加 `enabledByUser`。）

- [ ] **Step 5: 发现层的测试**

**(a)** `test/plugin-dir.test.ts`，在 `:45` 的 `putPlugin` 之后加一个同形的落点版本：

```ts
/** 与 putPlugin 同形，只是落在 `~/.deepcode/installed/`。 */
async function putInstalled(
  world: { home: string },
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(world.home, '.deepcode', 'installed', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', ...JSON.parse(files['plugin.json'] ?? '{}') }),
  );
  for (const [relative, content] of Object.entries(files)) {
    if (relative === 'plugin.json') continue;
    await mkdir(join(dir, relative, '..'), { recursive: true });
    await writeFile(join(dir, relative), content);
  }
  return dir;
}
```

**(b)** 在「发现」describe 末尾加四类（spec §8 C1 点名的三类 + 决策 3 的可执行形式）：

```ts
  it('落点里的一律不装载，除非给了 enabledInstalled —— 默认值必须是"什么都不开"', async () => {
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
    expect(found.skipped[0]?.reason).toContain('用户级设置');
    // 这一句是承重的那半：理由必须点明"项目级写同一个名字不算数"，
    // 否则人会照着它去改 project 那份，然后还是不动。
    expect(found.skipped[0]?.reason).toContain('项目级设置里写同一个名字不算数');
  });

  it('给了 enabledInstalled 就装载，origin 是 installed', async () => {
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({
      ...world,
      enabled: [],
      enabledInstalled: ['todo'],
      warn: NO_WARN,
    });
    expect(found.loaded.map((p) => [p.name, p.origin])).toEqual([['todo', 'installed']]);
  });

  it('**项目级名单管不着落点** —— enable 里写了同一个名字，落点那份照样不装', async () => {
    // 决策 3 的单元级可执行形式。反过来（enabledInstalled 能点亮项目级）不存在：
    // 项目级那份只看 deps.enabled。
    const world = await makeWorld();
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({ ...world, enabled: ['todo'], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
  });

  it('同名时 user 赢过 installed —— 更直接的那个来源赢', async () => {
    const world = await makeWorld();
    await putPlugin('home', world, 'todo', { 'plugin.json': MANIFEST });
    await putInstalled(world, 'todo', { 'plugin.json': MANIFEST });
    const found = await discoverPlugins({
      ...world,
      enabled: [],
      enabledInstalled: ['todo'],
      warn: NO_WARN,
    });
    expect(found.loaded.map((p) => [p.name, p.origin])).toEqual([['todo', 'user']]);
    expect(found.skipped[0]?.reason).toContain('同名插件');
  });

  it('落点里的坏清单照旧是"跳过的"，与启不启用无关', async () => {
    const world = await makeWorld();
    // ⚠️ 这里是 **JSON 文本**，不是对象 —— `putInstalled` 与 `putPlugin` 一样会
    // `JSON.parse(files['plugin.json'])`，给对象的话 `JSON.parse` 先把它字符串化成
    // `"[object Object]"` 再抛 SyntaxError，测试会死在搭现场而不是断言上。
    await putInstalled(world, 'bad', { 'plugin.json': JSON.stringify({ name: 'BadName' }) });
    const found = await discoverPlugins({ ...world, enabled: [], warn: NO_WARN });
    expect(found.loaded).toEqual([]);
    expect(found.skipped[0]?.origin).toBe('installed');
    expect(found.skipped[0]?.reason).toContain('E3');
  });
```

**(c)** 一条**不写**的测试，与理由（写进计划是为了下一个人不再加一遍）：
`plugins.deny` 对装进来的插件是否生效，**不需要新测试**。守门器按名字匹配、与 origin 无关，
`test/plugin-guard.test.ts:25-31` 钉住「按名字比」、`:44-51` 钉住「第一方名单是"只有点名的才豁免"，
不是"凡第一方都豁免"」—— 后者喂的正是 `{ name: 'todo', source: 'user' }` 这种非第一方名字。
落点里的插件走同一条路（`main.ts:249` → `cli/plugins.ts` 的 `discovered` → 排在 `firstParty` 之后），
且**未启用时压根到不了那里**（上面五条测试里它就是 `skipped`）。再加一条只能是重复。

- [ ] **Step 6: typecheck + 那三个文件的测试**

Run: `pnpm typecheck`
Expected: 退出码 0。

Run: `pnpm exec vitest run test/plugin-dir.test.ts test/settings-plugins.test.ts test/plugin-guard.test.ts`
Expected: PASS。**既有用例一条都不改地全绿** —— 那是「既有两级的语义一个字不改」的可执行形式。

- [ ] **Step 7: 提交**

```bash
git add src/cli/settings.ts src/cli/plugin-dir.ts src/cli/main.ts \
        test/plugin-dir.test.ts test/settings-plugins.test.ts test/cli.test.ts test/plugin-wiring.test.ts
git commit -m "feat(p4c): 落点作为第三个来源，闸门只认用户层设置"
```

---

## Task 3：改名 `installPlugins` → `loadPlugins`（纯机械，零行为变化）

**Files:**
- Modify: `src/cli/plugin-dir.ts`、`src/cli/main.ts`、`src/core/create.ts`（注释）、
  `test/plugin-dir.test.ts`、`test/plugin-e2e.test.ts`

**为什么改：** 这个代码库里「install」马上会有两个意思，而它们的差别恰好是**代码有没有开始跑**：
`installPlugins` 干的是装载（import 入口模块），新的 CLI 动词 `add` 干的是安装（拷文件）。
这是最不该含混的一处。

- [ ] **Step 1: 先看清要改哪些地方（不改代码）**

Run:
```bash
grep -rn "installPlugins" src/ test/
```
Expected: **恰好 14 处**（计划初稿写「10 处」，但那串枚举本身就有 14 个，是写错了），
按文件分布：`src/cli/main.ts` 2、`src/cli/plugin-dir.ts` 3、`src/core/create.ts` 1、
`test/plugin-dir.test.ts` 6、`test/plugin-e2e.test.ts` 2。

⚠️ **行号会漂，别照着数行**：Task 2 往 `plugin-dir.ts` 里插了约 50 行
（`INSTALLED_DIR` / `STAGING_DIR` / 新闸门），所以本任务的行号相对计划初稿整体后移
（函数声明 `:199` → `:250`，`main.ts` 的调用 `:211` → `:213`，
`plugin-dir.test.ts` 的五处调用各后移约 80 行）。`grep -rn` 会告诉你真实位置，
按**符号**找而不是按行号找。

（`docs/superpowers/plans/2026-10-11-deepcode-p3.md` 与 `p4a.md` 里的命中是**历史记录，不改**。）

- [ ] **Step 2: 改**

`src/cli/plugin-dir.ts:199`：

```ts
export async function loadPlugins(
  discovered: readonly DiscoveredPlugin[],
  deps: InstallDeps,
): Promise<readonly Plugin[]> {
```

同文件 `:16` 与 `:21` 的两处注释：

```
 * - `loadPlugins` **装载**（import 入口模块，代码从这里开始跑）
```
```
 * ⚠️ 而 `loadPlugins` 里的那一行 `import` 就是"装一个插件 = 信任它"的全部。
```

并在 `:12` 的文件头补一句划清界线（下一节就会有人把 `plugin add` 当成它）：

```
 * 注意"装载"与"安装"是两件事：这个文件只做**装载**（把已经在目录里的搬进内存）。
 * 把文件从 marketplace 拷进落点的是 `plugin-install.ts` —— 安装（P4c）。
```

`src/cli/main.ts:20`：

```ts
import { discoverPlugins, loadPlugins } from './plugin-dir';
```

`src/cli/main.ts:211`：

```ts
  const thirdParty = await loadPlugins(found.loaded, {
```

`src/core/create.ts:22` 注释里的 `installPlugins` → `loadPlugins`。

`test/plugin-dir.test.ts:6` 的 import 与 `:159`、`:182`、`:200`、`:218`、`:238` 五处调用；
`test/plugin-e2e.test.ts:11` 的 import 与 `:46` 的调用。

- [ ] **Step 3: 验证「零行为变化」**

Run: `grep -rn "installPlugins" src/ test/`
Expected: 无输出。

Run: `pnpm typecheck`
Expected: 退出码 0。

Run: `pnpm exec vitest run test/plugin-dir.test.ts test/plugin-e2e.test.ts test/plugin-wiring.test.ts`
Expected: PASS（改的是名字，行为一个字没动 —— 所以这几条必须与改之前一样绿）。

- [ ] **Step 4: 提交**

```bash
git add src/cli/plugin-dir.ts src/cli/main.ts src/core/create.ts test/plugin-dir.test.ts test/plugin-e2e.test.ts
git commit -m "refactor(p4c): installPlugins → loadPlugins，把装载与安装分开"
```

---

## ══ 检查点 C1 ══

- [ ] `pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm test` ✓（记下文件数与用例数，Task 7 要用）
      —— **实测：41 个文件 / 639 个用例**（基线 40 / 609，增量 = 22 + 5 + 3）
- [ ] 逐条核 spec §8 的 C1：
  - `test/marketplace.test.ts` 里每条判据至少一正一反，反向那条**钉具体判词**（不是「非空即过」）。
    核法：`grep -o "'M[1-8]'" test/marketplace.test.ts | sort -u`
    —— 预期输出 **七**条：`M1 M2 M3 M4 M5 M7 M8`。
    ⚠️ **`M6` 不会出现，这是对的**：它按设计**没有自己的编号**，而是把 `validatePlugin` 的
    结论（`E2`/`E3`…）原样转发上去，所以文件里不可能有 `'M6'` 这个字面量。
    要核 M6 就看那两条用例的名字 —— 「M6 直接吃 validatePlugin 的结论」与
    「M6 清单坏了（E3 名字）时也带 source 路径」。（计划初稿写的「应输出八条」是错的。）
  - `test/plugin-dir.test.ts` 的既有用例**行为一条不改**（改的是名字，不是断言）。
    核法分两步，别用跨多个提交的区间 —— 那会把 Task 3 的改名churn 一起算进来：
    ① `git show <Task 2 的提交> -- test/plugin-dir.test.ts | grep -c "^-[^-]"` → **0**；
    ② `git diff <Task 2 之前的提交>..HEAD -- test/plugin-dir.test.ts | grep "^-[^-]"` 里
       删掉的每一行都必须只含 `installPlugins` → `loadPlugins` 这一处改名，没有别的。
  - `pnpm lint` 两句判词都在。
- [ ] 提交已推上去（或至少本地干净）：`git status --short` 无输出

---

## Task 4：`plugin add` / `plugin remove`

**Files:**
- Create: `src/cli/plugin-install.ts`
- Modify: `src/cli/args.ts`（`StartupAction`、`parsePluginCommand`）
- Modify: `src/cli/plugin-command.ts`（`add` / `remove` 两个分支 + 读索引的辅助）
- Test: `test/plugin-command.test.ts`

- [ ] **Step 1: 写 `src/cli/plugin-install.ts`**

```ts
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isPluginName } from '../contract/plugin-manifest';
import { INSTALLED_DIR, STAGING_DIR } from './plugin-dir';

/**
 * 把一份插件从 marketplace 拷进落点。
 *
 * **这个文件是唯一往 `~/.deepcode/installed/` 写东西的地方**（唯一一条 `rm -rf` 也是）。
 * 所以三条约束都收在这里，不散到调用方去：
 *
 * 1. **名字先过 `isPluginName`**。名字直接参与拼路径 —— 不守这一条的话，
 *    `plugin remove ../../x` 就是一条删除任意目录的命令。
 * 2. **目标已存在一律拒绝**。覆盖掉的到底是什么不容易看，而多一个 `--force`
 *    就是多一条需要人判断的歧义；先 `remove` 是显式的，也是一步就能做完的。
 * 3. **先写暂存、再 `rename`**。中断（Ctrl-C、磁盘满、权限失败）不许留下半个插件目录 ——
 *    那半个下次会被发现层当成一个坏插件报出来，而到那时没人知道它是从哪来的。
 *    暂存目录是**落点的兄弟节点**，理由见 `plugin-dir.ts` 的 `STAGING_DIR`。
 */

export type LandResult =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly error: string };

/** 落点的绝对路径。`remove` 与它共用同一个算式 —— 两处各写一遍就会漂。 */
export function installedPath(home: string, name: string): string {
  return join(home, ...INSTALLED_DIR, name);
}

export async function landPlugin(
  home: string,
  name: string,
  sourceDir: string,
): Promise<LandResult> {
  if (!isPluginName(name)) {
    return { ok: false, error: `${JSON.stringify(name)} 不是合法的插件名（kebab-case），没有碰任何路径。` };
  }

  const target = installedPath(home, name);
  if (await exists(target)) {
    return { ok: false, error: `${target} 已经在了 —— 先 deepcode plugin remove ${name}，再装。` };
  }

  const staging = join(home, ...STAGING_DIR, name);
  // 上一次崩在半路留下的暂存目录要清掉：不清的话 cp 会往里面摞东西，
  // 而摞出来的东西看起来完全正常 —— 那是最坏的一种"装上了"。
  await rm(staging, { recursive: true, force: true });

  try {
    await mkdir(join(home, ...STAGING_DIR), { recursive: true });
    // dereference: false —— 符号链接原样拷，不跟随。不做额外处理，理由是插件本来就是
    // "以你的身份跑的代码"：它读得到的东西你本来也读得到，跟随链接换不来任何新权限。
    await cp(sourceDir, staging, { recursive: true, dereference: false });
    await mkdir(join(home, ...INSTALLED_DIR), { recursive: true });
    // 暂存与落点是兄弟节点（同一个文件系统）→ 这是真原子动作。
    await rename(staging, target);
  } catch (error) {
    // 失败不许留残骸。
    await rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      error: `${target} 没装上（${error instanceof Error ? error.message : String(error)}）—— 落点里没有留下任何东西。`,
    };
  }

  return { ok: true, dir: target };
}

export async function removePlugin(home: string, name: string): Promise<LandResult> {
  if (!isPluginName(name)) {
    return { ok: false, error: `${JSON.stringify(name)} 不是合法的插件名（kebab-case），没有碰任何路径。` };
  }

  const target = installedPath(home, name);
  if (!(await exists(target))) {
    return { ok: false, error: `${target} 里没有这个插件 —— 落点里没有 ${JSON.stringify(name)} 这个名字。` };
  }

  await rm(target, { recursive: true, force: true });
  return { ok: true, dir: target };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: `args.ts` —— 两个子命令 + `--from=`**

**(a)** `:13-19` 的 `StartupAction` 加两个变体：

```ts
export type StartupAction =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'plugin'; sub: 'help' }
  | { kind: 'plugin'; sub: 'list' }
  | { kind: 'plugin'; sub: 'validate'; dir: string }
  | { kind: 'plugin'; sub: 'add'; name: string; from: string }
  | { kind: 'plugin'; sub: 'remove'; name: string }
  | { kind: 'prompt'; text: string; resume: ResumeTarget; settings: string | undefined };
```

**(b)** `:29` 下面加一个常量：

```ts
/** 与 `--settings=` 同一条理由：它指向一个目录，裸写没法跟位置参数区分开。 */
const FROM = '--from';
```

**(c)** `parsePluginCommand`（`:87-99`）扩两个词：

```ts
function parsePluginCommand(argv: readonly string[]): StartupAction | undefined {
  const first = argv.findIndex((arg) => !arg.startsWith('-'));
  if (first === -1 || argv[first] !== 'plugin') return undefined;

  const sub = argv[first + 1];
  if (sub === undefined) return { kind: 'plugin', sub: 'help' };
  if (sub === 'list') return { kind: 'plugin', sub: 'list' };
  if (sub === 'validate') {
    const dir = argv[first + 2];
    return dir === undefined ? { kind: 'plugin', sub: 'help' } : { kind: 'plugin', sub: 'validate', dir };
  }
  if (sub === 'add') {
    // `--from` 只认等号形态（`--from=<目录>`），先例是 `--resume=` 与 `--settings=`。
    // 它**可以出现在任意位置**：下面这行只看第一个非开关 token 定子命令，
    // 而 `--from=…` 以 `-` 开头，不会把自己变成那个 token。
    // ⚠️ 名字不能写成 `argv[first + 2]`：`--from=…` 写在名字前面时，那个位置
    // 正是 `--from=…` 自己，被 `startsWith('-')` 一挡就回落成 help 了。
    // 名字的定义是"子命令之后第一个不是开关的 token"，所以要对后面整段找。
    const name = argv.slice(first + 2).find((arg) => !arg.startsWith('-'));
    const from = argv.find((arg) => arg.startsWith(`${FROM}=`))?.slice(FROM.length + 1).trim();
    if (name === undefined || from === undefined || from === '') {
      // 少了名字或 `--from` 就打说明 —— 与 `validate` 少了目录同一种处置。
      // 说明里写着这两个参数怎么写，所以这不是一条死胡同。
      return { kind: 'plugin', sub: 'help' };
    }
    return { kind: 'plugin', sub: 'add', name, from };
  }
  if (sub === 'remove') {
    const name = argv[first + 2];
    if (name === undefined || name.startsWith('-')) return { kind: 'plugin', sub: 'help' };
    return { kind: 'plugin', sub: 'remove', name };
  }
  return undefined;
}
```

- [ ] **Step 3: `plugin-command.ts` —— 两个分支**

**(a)** 顶部 import 补上：

```ts
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { validateMarketplace, type MarketplaceEntry } from '../contract/marketplace';
import type { PluginManifest, Problem } from '../contract/plugin-manifest';
import { validatePlugin, isPluginName } from '../contract/plugin-manifest';
import type { StartupAction } from './args';
import { dirReader, discoverPlugins, type Discovery } from './plugin-dir';
import { landPlugin, removePlugin } from './plugin-install';
```

（`import type` 与值 import 分开写，是这个仓库既有文件的写法。）

**(b)** `runPluginCommand`（`:33-53`）加两个分支。**`add` / `remove` 要排在末尾那个
validate 分支之前**（那个分支是 fallback，它读 `deps.action.dir`，只对 `validate` 成立）：

```ts
export async function runPluginCommand(deps: PluginCommandDeps): Promise<number> {
  if (deps.action.sub === 'help') {
    deps.out(PLUGIN_HELP);
    return 0;
  }
  if (deps.action.sub === 'list') {
    const found = await discoverPlugins({
      home: deps.home,
      root: deps.root,
      enabled: deps.enabled,
      enabledInstalled: deps.enabledByUser,
      warn: deps.err,
    });
    deps.out(renderList(found, deps.home, deps.root));
    return 0;
  }
  if (deps.action.sub === 'add') {
    return await runAdd(deps, deps.action.name, deps.action.from);
  }
  if (deps.action.sub === 'remove') {
    const result = await removePlugin(deps.home, deps.action.name);
    if (!result.ok) {
      deps.err(result.error);
      return 1;
    }
    deps.out(`已删掉 ${result.dir}。`);
    // 把话说全：名字可能还挂在设置里，而那一行现在指向一个不存在的东西。
    deps.out(
      `若这个名字还在用户级设置的 plugins.enable 里，那一行现在指向一个不存在的东西 —— 顺手删掉它。`,
    );
    return 0;
  }

  const dir = resolve(deps.action.dir);
  const validated = await validatePlugin(dir, dirReader(dir));
  deps.out(renderValidate(dir, validated));
  return validated.ok ? 0 : 1;
}
```

> ⚠️ 这一段同时把 `enabledByUser` 加进了 `list` 的依赖（Task 5 要用的第三节），
> 所以 `PluginCommandDeps` 这一轮就要加字段，`test/plugin-command.test.ts` 的四个调用点也要补。

**(c)** `PluginCommandDeps`（`:22-30`）加字段：

```ts
export type PluginCommandDeps = {
  readonly action: PluginAction;
  readonly home: string;
  readonly root: string;
  /** 五层合并后的 `plugins.enable`（只有项目级的发现需要它）。 */
  readonly enabled: readonly string[];
  /** 只有**用户层**的名单 —— 落点只认这一层（设计 §0 决策 3）。 */
  readonly enabledByUser: readonly string[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};
```

**(d)** `add` 的实现，加在 `runPluginCommand` 之后：

```ts
/**
 * `plugin add` 的六步（设计 §4.2）。**顺序是要紧的**：任何 E 级问题都在写盘之前中止，
 * 而且一个字节都不写。
 */
async function runAdd(deps: PluginCommandDeps, name: string, from: string): Promise<number> {
  const marketDir = resolve(from);
  const indexLabel = `${marketDir} 下的 .deepcode-plugin/marketplace.json`;

  const index = await validateMarketplace(marketDir, {
    async readIndex() {
      // 与 settings.ts 的默认 reader 同一条区分：不存在返回 undefined 是常态，
      // 存在但读不了要抛 —— 后者可能是有人故意藏了个读不了的东西。
      try {
        return await readFile(join(marketDir, '.deepcode-plugin', 'marketplace.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    openPlugin: (source) => dirReader(join(marketDir, source)),
  });

  if (!index.ok || index.entries === undefined) {
    deps.err(`这份索引用不了：${indexLabel}`);
    for (const line of renderProblems(index.problems)) deps.err(line);
    return 1;
  }

  const entry = index.entries.find((item) => item.name === name);
  if (entry === undefined) {
    // 一次 typo 教会你有哪些可选 —— 于是不需要单独的 `plugin search`（YAGNI）。
    deps.err(`这份索引里没有 ${JSON.stringify(name)}。有的名字：`);
    for (const item of index.entries) deps.err(`  ${item.name.padEnd(24)} ${item.source}`);
    return 1;
  }

  return await installEntry(deps, marketDir, entry);
}

async function installEntry(
  deps: PluginCommandDeps,
  marketDir: string,
  entry: MarketplaceEntry,
): Promise<number> {
  const sourceDir = join(marketDir, entry.source);
  // 再校验一次 source 指向的那个目录，**为的是拿到 entry / hooks** ——
  // `MarketplaceEntry` 只带归一后的 manifest，而下面那一屏要打的是钩子命令的**原文**。
  const validated = await validatePlugin(sourceDir, dirReader(sourceDir));
  deps.out(renderValidate(sourceDir, validated));
  if (!validated.ok) {
    deps.err(`这份插件有问题，没有装 —— 落点里一个字节都没写。`);
    return 1;
  }

  const landed = await landPlugin(deps.home, entry.name, sourceDir);
  if (!landed.ok) {
    deps.err(landed.error);
    return 1;
  }

  deps.out(`装到了 ${landed.dir}。`);
  // **不替用户改设置**（设计 §0 决策 9）：一条命令替你把代码放行，
  // 与项目禁掉 `--yes` 是同一条理由 —— 谁加自动放行开关谁就是在开倒车。
  deps.out(
    `它现在**不会跑**。要它跑，在用户级 ~/.deepcode/settings.json 里写：` +
      `{"plugins": {"enable": ["${entry.name}"]}}`,
  );
  deps.out(`（项目级设置里写同一个名字不算数 —— 否则一个克隆下来的仓库就能点亮你全局装着的插件。）`);
  return 0;
}
```

> `isPluginName` 那一处 import 在 `plugin-command.ts` 里其实用不上（名字的合法性
> `validateMarketplace` 已经查过，而 `landPlugin` / `removePlugin` 自己也守）。
> **如果 `pnpm lint` 或 `tsc` 因为未使用的 import 报错，就把它从 import 里删掉** ——
> 用 lint 的结论说话，不要预先猜。

- [ ] **Step 4: `test/plugin-command.test.ts` —— 补依赖字段 + 新用例**

**(a)** 四个既有调用点（`:69`、`:92`、`:107`、`:135`）的依赖对象里加 `enabledByUser: [],`
（`plugin validate` 那三处用不到它，但类型是必填的；`list` 那处要的正是它）。

**(b)** 在 `parseArgs 的 plugin 子命令` describe 里加：

```ts
  it('plugin add <名字> --from=<目录>', () => {
    expect(parseArgs(['plugin', 'add', 'todo', '--from=./market'])).toEqual({
      kind: 'plugin',
      sub: 'add',
      name: 'todo',
      from: './market',
    });
  });

  it('--from 出现在名字前面也行（它是以 - 开头的，不会把自己变成第一个非开关 token）', () => {
    expect(parseArgs(['plugin', 'add', '--from=./market', 'todo'])).toEqual({
      kind: 'plugin',
      sub: 'add',
      name: 'todo',
      from: './market',
    });
  });

  it('plugin add 少了 --from 就回落成打说明（不是一条死胡同：说明里写着怎么写）', () => {
    expect(parseArgs(['plugin', 'add', 'todo'])).toEqual({ kind: 'plugin', sub: 'help' });
  });

  it('plugin remove <名字>', () => {
    expect(parseArgs(['plugin', 'remove', 'todo'])).toEqual({
      kind: 'plugin',
      sub: 'remove',
      name: 'todo',
    });
  });

  it('plugin remove 少了名字也打说明', () => {
    expect(parseArgs(['plugin', 'remove'])).toEqual({ kind: 'plugin', sub: 'help' });
  });
```

**(c)** 文件末尾加一个 describe。**每个用例自己的临时 HOME**（不是共享一个，也不是真实 HOME）：

```ts
/** 一个自足的 marketplace：索引 + 一个带钩子的插件。不依赖仓库里的 plugins/ 内容。 */
async function market(base: string, source = './demo'): Promise<string> {
  const dir = join(base, 'market');
  await mkdir(join(dir, '.deepcode-plugin'), { recursive: true });
  await mkdir(join(dir, 'demo', 'hooks'), { recursive: true });
  await writeFile(
    join(dir, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '0.1.0', uses: ['tool.check'], hooks: './hooks/hooks.json' }),
  );
  await writeFile(
    join(dir, 'demo', 'hooks', 'hooks.json'),
    JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node demo-hook.mjs' }] }] }),
  );
  await writeFile(
    join(dir, '.deepcode-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'deepcode',
      description: '测试用',
      plugins: [{ name: 'demo', description: '演示', source }],
    }),
  );
  return dir;
}

/** 与 world() 同形，但多一个自己那份 home —— `add` 会往那儿写。 */
async function addWorld(): Promise<{ home: string; root: string; market: string }> {
  const base = await mkdtemp(join(tmpdir(), 'deepcode-add-'));
  const home = join(base, 'home');
  const root = join(base, 'root');
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { home, root, market: await market(base) };
}

async function add(deps: { home: string; root: string }, from: string, name = 'demo') {
  const sink = collector();
  const code = await runPluginCommand({
    action: { kind: 'plugin', sub: 'add', name, from },
    home: deps.home,
    root: deps.root,
    enabled: [],
    enabledByUser: [],
    out: sink.write,
    err: sink.write,
  });
  return { code, text: sink.out.join('\n') };
}

async function list(deps: { home: string; root: string }, enabledByUser: readonly string[] = []) {
  const sink = collector();
  const code = await runPluginCommand({
    action: { kind: 'plugin', sub: 'list' },
    home: deps.home,
    root: deps.root,
    enabled: [],
    enabledByUser,
    out: sink.write,
    err: sink.write,
  });
  return { code, text: sink.out.join('\n') };
}

describe('plugin add / remove', () => {
  it('装：文件真的落进落点，报告里有钩子命令原文与「它不会跑」那句话', async () => {
    const { home, root, market: from } = await addWorld();
    const { code, text } = await add({ home, root }, from);

    expect(code).toBe(0);
    // 装之前你能看见的全部 —— 这是「装一个插件 = 信任它」那条边界的下限。
    expect(text).toContain('node demo-hook.mjs');
    expect(text).toContain(join(home, '.deepcode', 'installed', 'demo'));
    expect(text).toContain('它现在**不会跑**');
    expect(text).toContain('用户级');

    const manifest = await readFile(join(home, '.deepcode', 'installed', 'demo', 'plugin.json'), 'utf8');
    expect(manifest).toContain('demo');
    const hooks = await readFile(
      join(home, '.deepcode', 'installed', 'demo', 'hooks', 'hooks.json'),
      'utf8',
    );
    expect(hooks).toContain('demo-hook.mjs');
  });

  // ⚠️ 这两条断言的是 **Task 5 才有的** `renderList` 第三节
  // （`装进来的（1）` / `未启用` / `已启用` / `装上的（0）`）。Task 4 里 `renderList`
  // 还没有那一节，所以执行时把它们写成 `it.skip(...)`，**并在 Task 5 做完之后把 `.skip` 摘掉**。
  //
  // 编在 Task 4 里是计划的排布失误（早了一个任务）。但**不许长期留着 skip** ——
  // 一条永远不跑的用例与一条永远不红的断言是同一种摆设，只是换了件衣服。
  // C2 有一条检查专门盯它：`grep -n "it.skip" test/plugin-command.test.ts` 必须无输出。
  it.skip('没启用的落点插件在 list 里单独一节，且不是"跳过"那种错', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);
    const { text } = await list({ home, root });
    expect(text).toContain('装进来的（1）');
    expect(text).toContain('未启用');
    expect(text).toContain('用户级设置');
  });

  it.skip('启用了之后它**留在**「装进来的」里，标着已启用 —— 位置不随开关跳', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);
    const { text } = await list({ home, root }, ['demo']);
    // ⚠️ 「装进来的」回答的是"我装过什么"，那个答案不该随开没开它而改变（设计 §4.4
    // 说的「逐条标启用与否」—— 只有启用的那条也留在这一节，那句话才有意义）。
    // 计划初稿这条断言写的是 `装上的（1）`，与同一段 `renderList` 的代码对不上：
    // 代码按 §4.4 把 installed-loaded 也放在「装进来的」。**代码是对的，断言写错了。**
    expect(text).toContain('装进来的（1）');
    expect(text).toContain('已启用');
    // 它不落进「装上的」—— 那一节是自动/手工放进插件目录的那些。
    expect(text).toContain('装上的（0）');
    expect(text).toContain('跳过的（0）');
  });

  it('索引里没有这个名字：非零码，并列出有的名字', async () => {
    const { home, root, market: from } = await addWorld();
    const { code, text } = await add({ home, root }, from, 'typo');
    expect(code).toBe(1);
    expect(text).toContain('没有 "typo"');
    expect(text).toContain('demo');
  });

  it('索引本身坏（source 是 ../x）：非零码，且**落点里什么都没多出来**', async () => {
    const { home, root } = await addWorld();
    const base = await mkdtemp(join(tmpdir(), 'deepcode-bad-'));
    const from = await market(base, '../outside');

    const { code, text } = await add({ home, root }, from);
    expect(code).toBe(1);
    expect(text).toContain('M5');
    // 承重的那半：中止发生在写盘之前。
    await expect(stat(join(home, '.deepcode', 'installed'))).rejects.toThrow();
  });

  it('目标已存在就拒绝，并告诉对方先 remove —— 不覆盖', async () => {
    const { home, root, market: from } = await addWorld();
    expect((await add({ home, root }, from)).code).toBe(0);

    const again = await add({ home, root }, from);
    expect(again.code).toBe(1);
    expect(again.text).toContain('已经在了');
    expect(again.text).toContain('plugin remove demo');
  });

  it('remove 删掉落点那一份，并提醒设置里那一行', async () => {
    const { home, root, market: from } = await addWorld();
    await add({ home, root }, from);

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: 'demo' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    const text = sink.out.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('已删掉');
    expect(text).toContain('plugins.enable');
    await expect(stat(join(home, '.deepcode', 'installed', 'demo'))).rejects.toThrow();
  });

  it('remove 一个不存在的不算成功', async () => {
    const { home, root } = await addWorld();
    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: 'nope' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
  });

  it('remove 一个名字不合法的**不碰任何路径**（名字直接参与拼路径）', async () => {
    const { home, root } = await addWorld();
    // 造一个"如果拼接不受控就会被删掉"的受害者。
    const victim = join(home, '.deepcode', 'installed', 'x');
    await mkdir(victim, { recursive: true });

    const sink = collector();
    const code = await runPluginCommand({
      action: { kind: 'plugin', sub: 'remove', name: '../installed/x' },
      home,
      root,
      enabled: [],
      enabledByUser: [],
      out: sink.write,
      err: sink.write,
    });
    expect(code).toBe(1);
    expect(sink.out.join('\n')).toContain('kebab-case');
    // 受害者还在。
    await expect(stat(victim)).resolves.toBeDefined();
  });
});
```

**(d)** 文件顶部的 import 补：`stat`（`node:fs/promises`）、`tmpdir`（`node:os`）、`rmSync` 不需要，
`readFile` 已经在。

- [ ] **Step 5: 跑**

Run: `pnpm typecheck`
Expected: 退出码 0。

Run: `pnpm exec vitest run test/plugin-command.test.ts`
Expected: PASS。

- [ ] **Step 6: 手跑一遍真的，看 stderr 干不干净**

**这一步要看的第二件事，比第一件重要：** stderr 干不干净。

`fs.cp` 直到 Node **22.3.0** 才转正，所以在这台机器上（22.19.0）不打警告，
而在 CI 的 **20.x** job 上会打一条 `ExperimentalWarning` —— 本地绿、CI 红的经典陷阱。
Task 5 里那条断言已经按这个事实写成了「滤掉已知噪音之后再要求干净」，
这一步是现场确认它确实长那样（本机应该看不到那条警告，看到了更说明滤得对）。

```bash
tmp=$(mktemp -d) && mkdir -p "$tmp/market/.deepcode-plugin" "$tmp/market/demo" \
  && printf '{"name":"demo","version":"0.1.0","uses":[]}' > "$tmp/market/demo/plugin.json" \
  && printf '{"name":"m","plugins":[{"name":"demo","source":"./demo"}]}' > "$tmp/market/.deepcode-plugin/marketplace.json" \
  && USERPROFILE="$tmp/home" HOME="$tmp/home" node bin/deepcode.mjs plugin add demo --from="$tmp/market"; echo "exit=$?"
```

Expected: 报告里含 `装到了 …/home/.deepcode/installed/demo` 与「它现在**不会跑**」，
`exit=0`。**stderr 是空的** —— 计划初稿说「stderr 里除了一条 W9 之外没有别的」，
这是写错了：W9 由 `validatePlugin` → `renderValidate` → `deps.out` 出去，走的是
**stdout**，所以 stderr 比预想的还干净（本机 22.19.0 实测：stdout 有那段报告，
stderr 一个字都没有，没有 `ExperimentalWarning`）。

- [ ] **Step 7: 提交**

```bash
git add src/cli/plugin-install.ts src/cli/args.ts src/cli/plugin-command.ts \
        src/cli/main.ts test/plugin-command.test.ts
git commit -m "feat(p4c): plugin add / remove —— 落盘原子，目标已存在就拒绝"
```

⚠️ **`src/cli/main.ts` 也在里面**，计划初稿漏了它：`PluginCommandDeps.enabledByUser`
在这一步变成必填，而 `main.ts` 里那个 `runPluginCommand(...)` 调用（`main.ts:99`）
立刻编译不过。补 `enabledByUser: pluginPolicy.plugins.enableByUser` —— 与
`:210` 喂给 `enabledInstalled` 的**是同一份名单**，两个入口必须一致。
（Task 5 Step 4 里那次看似要做的编辑，到这里其实已经做完了；那一处改成**核一遍**。）

---

## Task 5：`plugin list` 第三节、help、仓库自带的 marketplace

**Files:**
- Modify: `src/cli/plugin-command.ts`（`renderList`、`PLUGIN_HELP`）
- Modify: `src/cli/args.ts`（`HELP_TEXT` 的插件段）
- Modify: `src/cli/main.ts`（`plugin` 分支传 `enabledByUser`）
- Create: `.deepcode-plugin/marketplace.json`
- Test: `test/cli.test.ts`

- [ ] **Step 1: `renderList` 加第三节，来源标签认三个 origin**

      ⚠️ **做完这一节之后，把 `test/plugin-command.test.ts` 里两处 `it.skip` 的 `.skip` 摘掉**
      （`没启用的落点插件在 list 里单独一节`、`启用了之后它留在「装进来的」里`，Task 4 埋在那儿
      因为它们要的正是你现在写的这一节）。摘掉之后这两条必须**真绿**；如果绿不了，
      说明第三节的行为与那两条的断言对不上，先弄明白是哪边错。
      一条永远 `skip` 的用例与一条永远不红的断言是同一种摆设。

把 `plugin-command.ts:88-114` 的 `renderList` 整个换掉，并加一个 `originLabel`：

```ts
/**
 * 来源标签。落点那条**必须**带全路径读起来才不混（设计 §7.2）：
 * `installed` 与 `user` 在字面上都是"装上的"，而它们一个自动装载、一个不自动装载。
 */
function originLabel(origin: PluginOrigin): string {
  if (origin === 'user') return '用户级';
  if (origin === 'project') return '项目级';
  return '装进来的';
}

function describeLoaded(plugin: DiscoveredPlugin): string {
  const parts = [plugin.manifest.version, originLabel(plugin.origin)];
  if (plugin.entry !== undefined) parts.push(`入口 ${plugin.entry}`);
  if (plugin.hooks.length > 0) {
    parts.push(`钩子 ${plugin.hooks.map((group) => group.event).join('、')}`);
  }
  return parts.join(' · ');
}

function renderList(found: Discovery, home: string, root: string): string {
  // 落点单独一节，而不是并进「跳过的」：**"装了但还没启用"是一个正常状态，不是错误** ——
  // 混进错误列表会让人觉得装坏了（设计 §4.4）。
  const installedLoaded = found.loaded.filter((plugin) => plugin.origin === 'installed');
  const installedSkipped = found.skipped.filter((plugin) => plugin.origin === 'installed');
  const otherLoaded = found.loaded.filter((plugin) => plugin.origin !== 'installed');
  const otherSkipped = found.skipped.filter((plugin) => plugin.origin !== 'installed');

  const lines: string[] = [
    '插件目录',
    `  ${join(root, '.deepcode', 'plugins')}（项目级，要在设置里 plugins.enable）`,
    `  ${join(home, '.deepcode', 'plugins')}（用户级，自动装载）`,
    `  ${join(home, ...INSTALLED_DIR)}（落点，plugin add 装在这儿，只有用户级设置能启用）`,
  ];

  lines.push('', `装上的（${otherLoaded.length}）`);
  if (otherLoaded.length === 0) lines.push('  （一个都没有）');
  for (const plugin of otherLoaded) {
    lines.push(`  ${plugin.name.padEnd(24)} ${describeLoaded(plugin)}`);
    if (plugin.manifest.description !== undefined) {
      lines.push(`  ${' '.repeat(24)} ${plugin.manifest.description}`);
    }
  }

  lines.push('', `装进来的（${installedLoaded.length + installedSkipped.length}）`);
  if (installedLoaded.length + installedSkipped.length === 0) lines.push('  （一个都没有）');
  for (const plugin of installedLoaded) {
    lines.push(`  ${plugin.name.padEnd(24)} ${describeLoaded(plugin)} · 已启用`);
    if (plugin.manifest.description !== undefined) {
      lines.push(`  ${' '.repeat(24)} ${plugin.manifest.description}`);
    }
  }
  for (const plugin of installedSkipped) {
    // 清单坏了的点不了名 —— 那时候理由就不是"没启用"，照原样打。
    const who = plugin.name ?? '（清单坏了）';
    const why = plugin.name === undefined ? plugin.reason : `未启用 —— ${plugin.reason}`;
    lines.push(`  ${who.padEnd(24)} ${why}`);
    lines.push(`  ${' '.repeat(24)} ${plugin.dir}`);
  }

  lines.push('', `跳过的（${otherSkipped.length}）`);
  if (otherSkipped.length === 0) lines.push('  （没有）');
  for (const plugin of otherSkipped) {
    lines.push(`  ${(plugin.name ?? '（清单坏了）').padEnd(24)} ${plugin.reason}`);
    lines.push(`  ${' '.repeat(24)} ${plugin.dir}`);
  }

  lines.push('', '这份命令没有执行任何插件的代码 —— 只读了文件。');
  return lines.join('\n');
}
```

文件顶部 import 补 `join` 到 `node:path` 那一行、`INSTALLED_DIR` 与
`type DiscoveredPlugin` / `type PluginOrigin` 从 `./plugin-dir` 进来。

- [ ] **Step 2: `PLUGIN_HELP` 换掉**

```ts
export const PLUGIN_HELP = `deepcode plugin —— 插件

  deepcode plugin list                        列出装上的 / 装进来的 / 跳过的，各带理由
  deepcode plugin validate <目录>              只校验一份清单，不执行任何代码
  deepcode plugin add <名字> --from=<目录>     从一份本地索引装进来（**不启用**）
  deepcode plugin remove <名字>                从落点删掉

装在哪
  用户级 ~/.deepcode/plugins/<名字>/plugin.json         自动装载
  项目级 <工作目录>/.deepcode/plugins/<名字>/plugin.json   要在设置里 plugins.enable 之后才装
  落点   ~/.deepcode/installed/<名字>/                  plugin add 装在这儿

装 ≠ 启用
  plugin add 只把文件放好，不放行任何东西。要它跑，得在**用户级**
  ~/.deepcode/settings.json 里写 plugins.enable: ["<名字>"]。
  **项目级设置里写同一个名字不算数** —— 否则一个克隆下来的仓库就能按名字
  点亮你全局装着的插件。这条命令也不会替你改设置。

marketplace 就是一份本地目录：<目录>/.deepcode-plugin/marketplace.json 列出若干条目，
每条一个 name 与一个相对 source（指向该目录下的一个插件目录）。没有网络、没有签名、
没有版本与升级 —— 要更新就是 remove 之后再 add。

一份插件至少要有 plugin.json（name 必填），可以再带一个入口模块（main.mjs）与
一份 hooks/hooks.json。清单里的路径必须是相对的、以 ./ 开头、不含 ..。
`;
```

- [ ] **Step 3: `args.ts` 的 `HELP_TEXT` 插件段（`:130-136`）**

```ts
插件
  用户级 ~/.deepcode/plugins/<名字>/plugin.json        自动装载
  项目级 <工作目录>/.deepcode/plugins/<名字>/plugin.json  要在设置里 plugins.enable 之后才装
  落点   ~/.deepcode/installed/<名字>/                 plugin add 装在这儿，只有用户级设置能启用
  deepcode plugin list             列出装上的 / 装进来的 / 跳过的，各带理由
  deepcode plugin validate <目录>  只校验一份清单，不执行任何代码
  deepcode plugin add <名字> --from=<目录>  从一份本地索引装进来（装了不等于启用）
  deepcode plugin remove <名字>    从落点删掉
  第三方插件只能拧紧不能拧松：它的判定要么拦下、要么往下交，放行一律忽略。
```

- [ ] **Step 4: `main.ts` 的 plugin 分支 —— 核一遍，这一步在 Task 4 已经做完了**

（`PluginCommandDeps.enabledByUser` 变成必填是在 Task 4，所以 `main.ts:105` 那处
早就在那一轮补上了，否则 `tsc` 过不去。这里只**确认**它有，且传的是
`pluginPolicy.plugins.enableByUser`。要看到的形状是：）

`:99-106`：

```ts
    process.exitCode = await runPluginCommand({
      action,
      home,
      root,
      enabled: pluginPolicy.plugins.enable.map((rule) => rule.name),
      // list 要把落点的启用状态标出来 —— 那一层只认用户层（设计 §0 决策 3）。
      enabledByUser: pluginPolicy.plugins.enableByUser,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
```

- [ ] **Step 5: 仓库自己当一份 marketplace**

新建 `.deepcode-plugin/marketplace.json`：

```json
{
  "name": "deepcode",
  "description": "DeepCode 仓库自带的插件",
  "plugins": [
    {
      "name": "secret-guard",
      "description": "写文件之前扫一眼内容里有没有密钥形状的东西 —— 一个只会拧紧的插件",
      "source": "./plugins/secret-guard"
    },
    {
      "name": "todo",
      "description": "加一个 TodoWrite 工具 —— 演示一个不改引擎的新能力",
      "source": "./plugins/todo"
    }
  ]
}
```

（条目按名字字典序 —— 与发现层的装载顺序同一个方向。`source` 指向仓库里既有那两个插件目录，
它们的 `plugin.json` 里 `name` 分别是 `secret-guard` 与 `todo`，所以 `M8` 在真仓库上是满足的。）

- [ ] **Step 6: 这个点目录对既有的三条命令零影响**

Run: `pnpm typecheck && pnpm lint`
Expected: 都通过。`check-boundaries.mjs` 只看 `src/` 与 `plugins/`，`tsc` 的
`include` 是 `["src","test","scripts"]` —— 都与 `.deepcode-plugin/` 无关。

- [ ] **Step 7: `test/cli.test.ts` 的端到端 describe**

**(a)** 顶部 import 补 `mkdirSync`、`readFileSync`、`writeFileSync`（`node:fs` 那一行）
与 `Promisify` 之外的东西不用动。

**(b)** 文件末尾（现在最后那个 describe 之后）加：

```ts
describe('真跑一遍 bin：plugin add / remove 与落点（装 ≠ 启用）', () => {
  // 与上面那几条同一个用意：清掉会改变配置解析的变量，顺便再钉一遍顺序 ——
  // plugin 子命令必须发生在"要 key"之前，否则在干净环境（CI）里会报"缺少 API key"，
  // 而不是装机。**全程零密钥。**
  const BIN = resolve(process.cwd(), 'bin', 'deepcode.mjs');

  function cleanEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'DEEPCODE_MODEL',
      'DEEPCODE_PROVIDER',
      'DEEPCODE_MANAGED_SETTINGS',
      'DEEPCODE_DEBUG',
    ]) {
      delete env[name];
    }
    return env;
  }

  /**
   * 一个自足的 marketplace：索引 + 一个带钩子的插件。
   * **不依赖仓库里的 `plugins/` 内容** —— 那两目录有自己的测试，而这条要测的是装机流程。
   */
  function fixtureMarket(base: string, source = './demo'): string {
    const dir = join(base, 'market');
    mkdirSync(join(dir, 'demo', 'hooks'), { recursive: true });
    mkdirSync(join(dir, '.deepcode-plugin'), { recursive: true });
    writeFileSync(
      join(dir, 'demo', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '0.1.0', uses: ['tool.check'], hooks: './hooks/hooks.json' }),
    );
    writeFileSync(
      join(dir, 'demo', 'hooks', 'hooks.json'),
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node demo-hook.mjs' }] }] }),
    );
    writeFileSync(
      join(dir, '.deepcode-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'deepcode',
        description: '测试用',
        plugins: [{ name: 'demo', description: '演示', source }],
      }),
    );
    return dir;
  }

  async function run(
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    let code = 0;
    const result = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd, env }).catch(
      (error: any) => {
        code = error.code ?? 1;
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      },
    );
    return { code, stdout: result.stdout as string, stderr: result.stderr as string };
  }

  /**
   * 滤掉 Node 自己那两条与本次行为无关的输出。
   *
   * `fs.cp` 在 22.3.0 之前是实验性 API，第一次用到就打一条 `ExperimentalWarning`
   * 外加一行 `Use \`node --trace-warnings ...\` to show where the warning was created`。
   * 那不是这个项目的问题 —— 但它会出现在 stderr 里，而 CI 矩阵里有 20.x。
   * 所以"stderr 干不干净"这件事得先减掉这段已知噪音再谈。
   */
  function noise(stderr: string): string {
    return stderr
      .split('\n')
      .filter((line) => !line.includes('ExperimentalWarning'))
      .filter((line) => !line.includes('--trace-warnings'))
      .join('\n')
      .trim();
  }

  /** 每个用例自己的临时 HOME 与临时工作目录 —— `add` 会往 HOME 里写。 */
  function scene(): { base: string; home: string; root: string } {
    const base = mkdtempSync(join(tmpdir(), 'deepcode-market-'));
    const home = join(base, 'home');
    const root = join(base, 'root');
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    return { base, home, root };
  }

  it('装：报告里有钩子命令原文、文件落进落点、没启用就不装载', async () => {
    const { base, home, root } = scene();
    try {
      const from = fixtureMarket(base);
      const env = cleanEnv(home);

      const added = await run(['plugin', 'add', 'demo', `--from=${from}`], root, env);
      expect(added.code).toBe(0);
      // 装之前你能看见的全部。
      expect(added.stdout).toContain('node demo-hook.mjs');
      // ⚠️ **不能**写成 `expect(added.stderr).not.toContain('ExperimentalWarning')`。
      // `fs.cp` 直到 Node 22.3.0 才转正，整条 20.x 上都会打那条实验性警告，
      // 而 CI 矩阵里就有 20 —— 那么写会在本地绿、**只在 CI 红**，是最坏的一种失败。
      // 改成：把已知噪音滤掉之后要求 stderr **干净**。20 与 22 上都成立，
      // 而且仍然逮得住真正的杂音（下面没滤掉的东西一条都不许有）。
      expect(noise(added.stderr)).toBe('');

      const landed = join(home, '.deepcode', 'installed', 'demo');
      expect(readFileSync(join(landed, 'plugin.json'), 'utf8')).toContain('demo');
      expect(readFileSync(join(landed, 'hooks', 'hooks.json'), 'utf8')).toContain('demo-hook.mjs');

      const listed = await run(['plugin', 'list'], root, env);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain('装进来的（1）');
      expect(listed.stdout).toContain('未启用');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('用户级设置里写了它才装载；**项目级写同一个名字不算数**', async () => {
    const { base, home, root } = scene();
    try {
      const from = fixtureMarket(base);
      const env = cleanEnv(home);
      expect((await run(['plugin', 'add', 'demo', `--from=${from}`], root, env)).code).toBe(0);

      // ① 项目级写同一个名字 —— **必须仍然不装载**。这是决策 3 的可执行形式，
      //    也是这一轮唯一一个"不做就会静默错"的地方。
      writeFileSync(
        join(root, '.deepcode', 'settings.json'),
        JSON.stringify({ plugins: { enable: ['demo'] } }),
      );
      const projectOnly = await run(['plugin', 'list'], root, env);
      expect(projectOnly.stdout).toContain('装进来的（1）');
      expect(projectOnly.stdout).toContain('未启用');
      expect(projectOnly.stdout).not.toContain('已启用');

      // ② 用户级写它 —— 这下才装载。
      writeFileSync(
        join(home, '.deepcode', 'settings.json'),
        JSON.stringify({ plugins: { enable: ['demo'] } }),
      );
      const userToo = await run(['plugin', 'list'], root, env);
      // 它**留在「装进来的」里**，只是标上了已启用 —— 位置不随开关跳（设计 §4.4）。
      // 写成「装上的（1）」的话，人一 enable 就会看到「装进来的（0）」，而他明明刚装过。
      expect(userToo.stdout).toContain('装进来的（1）');
      expect(userToo.stdout).toContain('已启用');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('索引里的 source 逃出索引根：非零码，且落点里什么都没多出来', async () => {
    const { base, home, root } = scene();
    try {
      const from = fixtureMarket(base, '../outside');
      const env = cleanEnv(home);

      const added = await run(['plugin', 'add', 'demo', `--from=${from}`], root, env);
      expect(added.code).not.toBe(0);
      expect(added.stderr).toContain('M5');
      // 承重的那半：中止发生在写盘之前。
      expect(existsSync(join(home, '.deepcode'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('remove 把落点那一份删掉', async () => {
    const { base, home, root } = scene();
    try {
      const from = fixtureMarket(base);
      const env = cleanEnv(home);
      await run(['plugin', 'add', 'demo', `--from=${from}`], root, env);

      const removed = await run(['plugin', 'remove', 'demo'], root, env);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain('plugins.enable'); // 提醒删掉设置里那一行
      expect(existsSync(join(home, '.deepcode', 'installed', 'demo'))).toBe(false);

      const gone = await run(['plugin', 'remove', 'demo'], root, env);
      expect(gone.code).not.toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('仓库自带的索引能装得上自己的插件（validate 之后 add）', async () => {
    // 真仓库那份 `.deepcode-plugin/marketplace.json` 到这里才第一次被行使：
    // 上面几条全用临时树。`M8`（索引名字与清单名字一致）在真仓库上没有反例，
    // 所以它绿的这一半由这条钉住，红的那一半只能靠临时树 —— 见计划末尾的对照表。
    const { base, home, root } = scene();
    try {
      const env = cleanEnv(home);
      const repo = resolve(process.cwd());
      const added = await run(['plugin', 'add', 'todo', `--from=${repo}`], root, env);
      expect(added.code).toBe(0);
      expect(existsSync(join(home, '.deepcode', 'installed', 'todo', 'plugin.json'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
```

`existsSync` 需要加到 `node:fs` 那一行 import 里。

- [ ] **Step 8: 跑**

Run: `pnpm typecheck`
Expected: 退出码 0。

Run: `pnpm exec vitest run test/cli.test.ts test/plugin-command.test.ts`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add .deepcode-plugin src/cli/plugin-command.ts src/cli/args.ts src/cli/main.ts test/cli.test.ts
git commit -m "feat(p4c): plugin list 的落点一节、help、仓库自带的 marketplace 与端到端"
```

---

## Task 6：反向验证（每条断言都要能红一次）

**口径：** 测试全绿不能说明什么 —— 一条永远不命中的断言也是绿的。把实现改坏一次，看它红不红；
不红就说明那条断言是摆设，**先修断言本身**，不是改设计。

⚠️ 一条纪律（上一轮真踩过）：**红不出来时，先确认那个变异是有效的** ——
拿一个可选字段做变异（`plugin.json` 里删掉 `version`）时它当然红不出来，因为那条路径不经过它。
无效的变异不是「断言是摆设」的证据。

每条的流程都是：**改坏 → 跑 → 看到红 → `git checkout -- <文件>` 还原 → 再跑一遍确认绿**。

- [ ] **变异 1：落点的闸门**

`src/cli/plugin-dir.ts` 里把 `if (origin !== 'user' && !enabledNames.includes(manifest.name))`
改回 `if (origin === 'project' && !enabledNames.includes(manifest.name))`。

Run: `pnpm exec vitest run test/plugin-dir.test.ts`
Expected: **红** —— 「落点里的一律不装载，除非给了 enabledInstalled」与
「**项目级名单管不着落点**」两条都红（落点不再受任何名单管，直接被装载）。

- [ ] **变异 2：落点那份名单换成项目级那份（决策 3 的核心）**

`src/cli/plugin-dir.ts` 里把
`const enabledInstalled = deps.enabledInstalled ?? [];` 改成
`const enabledInstalled = deps.enabledInstalled ?? deps.enabled;`。

Run: `pnpm exec vitest run test/plugin-dir.test.ts -t "项目级名单管不着落点"`
Expected: **红** —— 落点那份名单回落到项目级那份之后，`enabled: ['todo']` 就把落点里的
`todo` 装载了，`expect(found.loaded).toEqual([])` 炸。这条红的正是
「别人仓库里的 settings.json 不能点亮你全局装的东西」。

> ⚠️ **计划初稿把这条挂在了 `test/cli.test.ts -t "项目级写同一个名字不算数"` 上，那是错的** ——
> 拿那条命令跑这条变异**不会红**，而原因不是断言摆设，是**变异对那条命令无效**：
> `?? deps.enabled` 只在 `enabledInstalled === undefined` 时才走到，而 CLI 那条路径上
> 它**永远不是 undefined**（`plugin-command.ts:55` 总是传 `enabledInstalled: deps.enabledByUser`，
> 而 `enabledByUser` 恒为数组，见 `settings.ts:253`）。所以那段是 CLI 路径上的死代码，
> 变异根本没碰到被测的代码。
> 默认值这一半**是被钉住的**，钉它的是上面那条单元用例（它*不*传 `enabledInstalled`，
> 于是 `??` 的右支被行使）—— 这就是上一轮那个教训的同一个形状：
> **红不出来时先确认变异有没有效**。
> （那条 CLI 用例守的是另一件事：CLI 把**用户层**那份名单接进 `enabledInstalled`，
> 而不是接了合并后的名单 —— 它没接错。）

- [ ] **变异 3：`M8`**

`src/contract/marketplace.ts` 里把整个 `if (manifest.name !== name) { … continue; }` 块删掉。

Run: `pnpm exec vitest run test/marketplace.test.ts -t "M8"`
Expected: **红** —— 索引名字与清单名字不一致时不再报错，条目照样进 `entries`。

- [ ] **变异 4：`M5` 的路径检查**

`src/contract/marketplace.ts` 里把 `!isSafeRelativePath(source)` 改成 `false`（即只查
`typeof source !== 'string'`）。

Run: `pnpm exec vitest run test/marketplace.test.ts test/cli.test.ts -t "M5"` 以及
`pnpm exec vitest run test/cli.test.ts -t "source 逃出索引根"`
Expected: **红**（两处都红）。

- [ ] **变异 5：目标已存在不再拒绝**

`src/cli/plugin-install.ts` 里把 `if (await exists(target)) { … return … }` 那一段删掉。

Run: `pnpm exec vitest run test/plugin-command.test.ts -t "目标已存在"`
Expected: **红** —— 第二次 `add` 变成成功。

- [ ] **变异 6：名字守卫（`rm -rf` 的那一道）**

`src/cli/plugin-install.ts` 里把 `removePlugin` 开头的
`if (!isPluginName(name)) { … }` 删掉。

Run: `pnpm exec vitest run test/plugin-command.test.ts -t "不碰任何路径"`
Expected: **红** —— `remove ../installed/x` 把那个受害者目录删掉了。

- [ ] **一条红不出来的，如实记在这里**

**原子性没有可观测的反例。** 把 `landPlugin` 里的 `rename(staging, target)` 换成直接
`cp(sourceDir, target)` 不会有任何测试红 —— 「中断时不留半个目录」这件事，除非真去中断它，
否则不可观测。这是本轮唯一一条**断言不了**的保证，不假装它被钉住了。
它的成本是十几行，收益是挡掉一类"下次被当成坏插件报出来、而没人知道它从哪来"的 bug。

- [ ] **还原干净**

Run: `git diff --stat`
Expected: 无输出（六个变异全部还原）。

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。记下文件数与用例数。

- [ ] 把六条变异的结果填进计划末尾的对照表（能红的写"红了，红在哪条"，红不出来的写清楚为什么）

---

## ══ 检查点 C2 ══

- [ ] `pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm test` ✓（记下文件数与新的用例数）
- [ ] **一条 `it.skip` 都不许留** —— `grep -rn "it.skip\|describe.skip\|it.todo" test/` **必须无输出**。
      （这是本轮唯一一个「用例存在但永远不跑」的漏洞口：Task 4 埋过两条 skip。）
- [ ] 逐条核 spec §8 的 C2：
  - 端到端 describe 在 `test/cli.test.ts` 里，**全程零密钥**（环境里四个 API 变量都删掉了）
  - 反向验证**真红过**：变异 1、3、4、5、6 各自红在点名的用例上；变异 2 红在
    **`test/plugin-dir.test.ts` 的单元用例**上（挂在 CLI 那条命令上不会红 —— 那份变异
    对那条路径无效，理由见 Task 6 的注）。**六条里五条按原计划红，一条换了用例**，
    没有一条是「断言摆设」
  - 手工过一遍：`plugin add` 的报告里**钩子命令原文真的在** ——
    Task 4 Step 6 手跑那一次的输出里能看到它
- [ ] 推分支、开 PR：`git push -u origin p4c-marketplace` —— **已做**，PR [#5](https://github.com/yyyCode/DeepCode/pull/5)
- [ ] 两个 Node 版本的 job 都绿（**只能在推上去之后才算数**）—— **已验**：`check (node 20)` ✓ 29s、
      `check (node 22)` ✓ 21s（run [38136817040](https://github.com/yyyCode/DeepCode/actions/runs/38136817040)）。
      ⚠️ 这里正是那条**写计划阶段就处置掉的**坑的收口：`fs.cp` 在 20.x 上会打 `ExperimentalWarning`，
      若照原计划硬断言 stderr 干净，这条 20.x job 会是红的、而本地（22.19.0）全绿 —— 现在两个 leg 都过，
      证明「滤掉已知噪音再要求干净」那个改法是对的。（顺带：那次还撞上一次 push 的 `SSL_ERROR_SYSCALL`，
      重试即通，与本轮代码无关。）

---

## Task 7：文档收口与对照表

**Files:**
- Modify: `README.md`、`docs/项目简介.md`、`site/index.html`

- [ ] **Step 1: 先量出真实数字**

Run: `pnpm test`
Expected: 输出 `Test Files  NN passed` 与 `Tests  NNN passed` —— 用**实测**的那个数，
不要从上一轮（40 / 609）外推。

- [ ] **Step 2: `README.md`**

**(a)** `:456` 的 `pnpm test # 测试，40 个文件 609 个用例` → 换成实测数字。

**(b)** 「插件」一节（`:333-367`）：在 `:337` 之后加一段，并把 `:339-342` 那段命令清单补全：

````markdown
装一个插件 = 把目录放进去。用户级 `~/.deepcode/plugins/<名字>/` 自动装载；
项目级 `<工作目录>/.deepcode/plugins/<名字>/` 要在设置里 `plugins.enable` 之后才装
（"我自己装的"与"这个仓库要求我装什么"是两件事）。

还有第三种放法：**装进来**。`plugin add` 从一份本地索引把插件拷进落点
`~/.deepcode/installed/<名字>/` —— 而落点**不参与自动装载**。

```bash
deepcode plugin list                # 装上了哪些、装进来哪些、跳过了哪些，各带理由
deepcode plugin validate <目录>      # 只校验一份清单，不执行任何代码
deepcode plugin add <名字> --from=<目录>   # 从一份本地索引装进来
deepcode plugin remove <名字>        # 从落点删掉
```

**装 ≠ 启用。** `plugin add` 只把文件放好，不放行任何东西；要它跑，得在
**用户级** `~/.deepcode/settings.json` 里写 `plugins.enable: ["<名字>"]`。
**项目级设置里写同一个名字不算数** —— 否则一个克隆下来的仓库就能按名字点亮你
全局装着的插件。`plugin add` 也不会替你改设置：一条命令替你把代码放行，
与这个项目禁掉 `--yes` 是同一条理由。

marketplace 就是一份本地目录：`<目录>/.deepcode-plugin/marketplace.json` 列出若干条目，
每条一个 `name` 与一个相对 `source`。**只有本地索引**：没有网络、没有签名与校验和、
没有版本与升级（要更新就是 `remove` 之后再 `add`）。仓库自己那份在
[`.deepcode-plugin/marketplace.json`](.deepcode-plugin/marketplace.json)，
列的就是下面这两个插件。
````

- [ ] **Step 3: `docs/项目简介.md`**

**(a)** `:127` 的 `pnpm test`（40 个文件 609 个用例）→ 实测数字。

**(b)** `:45-46` 那条「插件」要点补一句落点：

```markdown
- **插件**：用户级目录自动装载，项目级要显式启用。还有第三种放法：`plugin add` 从一份本地
  索引把插件拷进**落点** `~/.deepcode/installed/`，而落点不自动装载 —— 装 ≠ 启用，
  且只有**用户级**设置能开这道闸（项目级写同一个名字不算数）。第三方插件只能拧紧不能拧松 ——
  它返回的放行判定会被丢弃，越界注册整个插件不装。`deepcode plugin list` 看装了哪些。
```

**(c)** `:71` 的路线图表 P4 行补 P4c-1：

```markdown
| P4 组合面 | 进行中 | `agents/*.md` 子代理能被 `description` 正确路由，工具白名单生效（P4a 已落地；P4b 会话压缩与沙箱、P4e CI 与两个检查器、P4c-1 marketplace 与安装也已落地；P4 整体未完 —— hookify DSL 与 `config.*` 在同一阶段里，还没做） |
```

**(d)** `:81` 起的「已知限制」里加一条：

```markdown
- **marketplace 只做本地索引**：不 fetch、不 clone、不 HTTP。没有签名与校验和 ——
  没有可信密钥体系时做一个假的比不做更糟。没有版本解析与升级：升级 = `remove` + `add`。
```

- [ ] **Step 4: `site/index.html`**

**(a)** `:71` 与 `:346` 的两个 `609`（以及 `40 个文件`）→ 实测数字。

**(b)** 路线图 P4 卡（`:399-402`）改成：

```html
      <div class="road__head"><span class="pill">进行中</span><h3>P4 组合面</h3></div>
      <p><strong>P4a / P4b / P4c-1 / P4e 已落地</strong>：<code>Task</code> / <code>Skill</code> 两个工具与
        <code>agent.offer</code> 进系统提示；会话压缩、<code>Bash</code> 沙箱、嵌套 <code>AGENTS.md</code>；
        marketplace 与安装（<strong>装 ≠ 启用</strong>，只有用户级设置能开闸）；CI 与两个检查器。
        P4 还剩 P4c 的另外两片（hookify DSL、<code>config.*</code>）与 P4d（多 surface）。</p>
```

**(c)** `site/index.html` 的「已知限制」一节（`:411` 起）加一条与 Step 3(d) 同口径的限制。

- [ ] **Step 5: 全仓扫一遍残留口径**

Run: `git grep -n "609"` 与 `git grep -n "需要先 clone"`
Expected: 前者的命中只在 `docs/superpowers/` 的历史计划/对照表里（那是记录，不改）；
后者无输出。

- [ ] **Step 6: 对着 spec 过一遍，把对照表填完**

逐条核 spec §1 的出口标准（那段引用）与 §8 的两个检查点，把下面那张表填掉。
**特别是 §7.5 那一条**（`M8` 在真仓库里没有反例）。

- [ ] **Step 7: 提交**

```bash
git add README.md docs/项目简介.md site/index.html
git commit -m "docs(p4c): 落点与「装 ≠ 启用」写进 README / 项目简介 / 官网，同步用例数"
```

---

## 与预登记的对照（执行时回来填）

| 预登记 | 实际 |
| --- | --- |
| **`M8`（索引名字与清单名字一致）在真仓库里没有反例** —— `plugins/todo/plugin.json` 的 `name` 是 `todo`，索引里也写 `todo`。所以真仓库上它是**绿的但没被行使**，只能靠临时树 | **成立，且绿的那一半现已被钉住**：Task 5 补的 e2e 用例 `仓库自带的索引能装得上自己的插件`（`test/cli.test.ts:860`）**真的行使了**仓库那份 `.deepcode-plugin/marketplace.json`（此前所有用例都用临时树），把「名字一致 → 装得上」这一半钉住；红的那一半（名字不一致 → `M8`）在真仓库里找不到反例，靠临时树 —— Task 6 变异 3 正是靠临时树红的 |
| 既有 `test/plugin-dir.test.ts` 的用例**一条不改**地继续绿（闸门从 `origin === 'project'` 改成 `origin !== 'user'` 时，既有两级的语义一个字不改） | **成立（中途误报过一次，核下来是改名 churn）**。`git diff main..p4c-marketplace -- test/plugin-dir.test.ts` 的 **6 行删除全部是机械改名**（1 行 import + 5 处 `installPlugins(` 调用），没有一条断言的期望值被改；新增 86 行是 Task 3 为落点那一级补的用例。一次「既有用例被改了？」的警觉，核清楚是这层改名，不是违规 |
| `.deepcode-plugin/` 这个新点目录对 `pnpm typecheck` / `pnpm lint` / `pnpm test` **零影响**（三个检查器都不看它） | **成立**。C1 / C2 两轮六次全绿（41 个文件，639 → 658 个用例，只增不减）。`tsconfig.json` 的 `include` 是 `["src","test","scripts"]`，`check-boundaries.mjs` 只扫 `src/` —— 都不看仓库根的 `.deepcode-plugin/` |
| `readPlugins` 让 user 层的 enable 落进 `SourceInfo.plugins.enable` —— 预期**零可见变化**，因为 `SourceInfo.plugins` 没有消费者（`permissions-command.ts:78-79` 读的是 policy 级那个合并结果） | **成立**。`SourceInfo.plugins` 确实没有消费者：唯一的 `policy.sources` 读者是 `permissions-command.ts`，它只用 `info.state` / `info.rules`（`:48`、`:65`、`:100`），从不碰 `info.plugins`。自动装载读的是 policy 级 `plugins.enable`，那条走 `PLUGIN_ENABLE_SOURCES` 的 flatMap（`settings.ts:246`），user 层不在那个常量里，所以新加的那句 `push` 改不了 `~/.deepcode/plugins/` 的行为 |
| ~~`fs.cp` 在 Node 20 / 22 上不打 `ExperimentalWarning`~~ —— **写计划时查证了，不成立**：`fs.cp` 直到 **22.3.0** 才转正，20.x 上会打。原计划那条断言会在本地绿、只在 CI 的 20.x job 上红。已改成「滤掉已知噪音后再要求 stderr 干净」（本机实测 Node 22.19.0 不打） | **已提前处置**（写计划阶段就改了，没等到 Task 5 执行） |
| `installPlugins` → `loadPlugins` 只动约 10 处、**零行为变化**（`grep -rn installPlugins src/ test/` 无输出，且那三个测试文件与改名前一样绿） | **成立**。`git show --stat 2331e33` = 5 个文件 / **+17 −14**，全是机械改名；`grep -rn installPlugins src/ test/` 无输出。相关的测试文件（plugin-dir / plugin-e2e）与改名前一样绿 |
| **原子 `rename` 没有可观测的反例** —— 变异 7（把 `rename` 换成直接 `cp`）不会有测试红。这是本轮唯一一条断言不了的保证 | **实测确认**：把 staging + `rename` 换成直接 `cp` 之后，三个与装机相关的文件 **82/82 全绿**，没有一条测试看得出差别。理由：那条保证（"中断时不留半个目录"）只有在真去中断（SIGINT／磁盘满／权限失败）时才可观测，而测试行使的两条失败路径（M5 逃逸、目标已存在）都在**写入任何字节之前**就中止了。所以它是真的，但**没有被钉住** —— 按计划要求**没有编一条假测试**上去 |
| 六条变异的红/不红（Task 6 实测） | 变异 **1、3、4、5、6 全部按原计划红**在点名的用例上：1 → `落点里的一律不装载`＋`项目级名单管不着落点`；3 → `M8 索引名字与清单名字不一致`；4 → `M5 source 逃出索引根`＋`M5 source 用反斜杠`＋cli 的 `索引里的 source 逃出索引根`；5 → `目标已存在就拒绝`；6 → `remove 一个名字不合法的**不碰任何路径**`。**变异 2 换了一条用例**（见下） |
| （计划缺陷，执行时才发现）Task 1 那份「干净清单」的 `uses` 只有 `describe` + `call`，经 M6 委托给 `validatePlugin` 后带回一条 **W7**（`plugin-manifest.ts:286`），好用例并不干净。实现是对的，错的**是计划里的固定件**。已把 `tool.check` 补进去，并把这条陷阱写在那段固定件旁边 | **执行时逮出，已修**（只动 `test/marketplace.test.ts`，`src/contract/marketplace.ts` 一个字没改） |
| （计划缺陷，执行前重核源码时逮出）Task 2 Step 1(f) 只点了 **3** 处 policy 级 `plugins: NO_PLUGINS`，实际有 **4** 处 —— 漏掉 `test/cli.test.ts:268`，它在一条测试体中间、离 `NO_POLICY` 很远，但进的是 `registered(policy: ResolvedPolicy)` | **已补齐四处并做成表**（否则 `tsc` 会在那儿炸，虽然炸得出来，但计划该是准的） |
| （计划缺陷，执行时逮出）Task 3 说 `installPlugins` 有「恰好 10 处」，但那串枚举本身就有 14 个 | **已改成 14** |
| （计划缺陷，执行时逮出）Task 3 的行号是照 **Task 2 之前**的文件写的，而计划把 Task 3 排在 Task 2 之后 —— `plugin-dir.ts` 被插了约 50 行，声明从 `:199` 漂到 `:250` | **已改成「按符号找、别照数行」**，并写明漂移的来由 |
| （**验收标准本身错了**，执行 C1 时逮出）C1 清单要求 `grep -o "'M[1-8]'"` 出 `M1…M8` 八条。**M6 按设计没有自己的编号** —— 它转发 `validatePlugin` 的 `E2`/`E3`，文件里不可能有 `'M6'` 字面量。实测正好七条 | **已改成七条 + 写清 M6 靠哪两条用例名去核**。值得记一笔：如果只跑代码不核清单，这条会被当「通过」放过去 —— 一条**永远不可能失败**的检查，与摆设断言是同一个毛病，只是长在计划里 |
| （计划缺陷，执行时逮出）Task 4 漏了 `src/cli/main.ts`：`PluginCommandDeps.enabledByUser` 变必填的瞬间 `main.ts:99` 就编译不过，而计划把它的接线推给了 Task 5 | **已并入 Task 4 的改文件表与 `git add`**；Task 5 Step 4 改成「核一遍」 |
| （计划缺陷，执行时逮出）Task 4 的 `--from` 解析写成 `argv[first + 2]`，在 `--from=…` 写在名字前面时那个位置正是 `--from=…` 自己，被 `startsWith('-')` 一挡回落成 help —— **计划自己的那条测试就会红** | **已改成 `argv.slice(first + 2).find(a => !a.startsWith('-'))`** |
| （计划排布失误，执行时逮出）Task 4 里那两条 `plugin list` 第三节的用例，断言的是 **Task 5 才有的** `renderList` 行为，早了一个任务 | Task 4 写成 `it.skip`，**Task 5 摘掉**；C2 新增一条硬检查：`grep -rn "it.skip\|describe.skip\|it.todo" test/` 必须无输出 |
| （计划说错了，执行时逮出）Task 4 Step 6 说 stderr 里有一条 W9 —— 实际 W9 走 `deps.out` 进 **stdout**，stderr 是**空的** | **已按实测改写**（本机 22.19.0：stdout 有报告，stderr 一个字没有，无 `ExperimentalWarning`）。`fs.cp` 那条预登记假设在本机成立 |
| （**计划内部自相矛盾**，执行时逮出）`renderList` 的**代码**按设计 §4.4 把「装进来的」当成"我装过什么"（启用的也留在这一节，标 `已启用`），而**同一节的用例**断言 `装上的（1）`。执行者照"用例是基准"改了**代码**去迁就断言 | **已判给 spec §4.4、改回代码**：§4.4 是用户批过的那份设计，而那条断言是我照着它派生的。判据是"照断言改"会让人一 enable 就看到 `装进来的（0）` —— 他明明刚装过。代码未动（本来就是对的），改的是**三处断言**（`plugin-command.test.ts` × 2、`cli.test.ts` × 1） |
| （计划缺陷，执行时逮出）Task 5 Step 7 的项目级设置用例写 `root/.deepcode/settings.json`，而 `scene()` 只建了 `home` 与 `root` —— `root/.deepcode/` 不存在，`writeFileSync` 抛 ENOENT | **已补 `mkdirSync`** |
| （计划缺陷，执行时逮出）Task 5 Step 9 的 `git add` 漏了 `test/plugin-command.test.ts`（那正是要摘 `.skip` 的文件） | **已补进 `git add`** |

## 自查（写完计划后自己过一遍的那张表）

| 检查 | 结果 |
| --- | --- |
| spec §0 决策 1–12 每条都能指到一个 Task | 决策 1（范围）→ 本计划只做 marketplace；2、3 → Task 2；4 → Task 2 Step 1(d)；5、6 → Task 1；7 → Task 4 Step 3(d)；8 → Task 3；9 → Task 4 Step 3(d)；10、11 → Task 5 Step 2 的 help 文案；12 → Task 4 Step 1 |
| spec §11「要改」的文件清单与本文「文件结构」表一致 | 一致（外加 `test/plugin-wiring.test.ts` / `test/plugin-e2e.test.ts` / `docs/项目简介.md` 这三处 spec 漏列的连带改动，已在表里点名） |
| 每个改动步骤都给了完整代码，没有「照上面那个写」「TBD」 | 是 |
| 前后用的名字一致（`landPlugin` / `installedPath` / `removePlugin` / `enabledByUser` / `enabledInstalled` / `INSTALLED_DIR` / `STAGING_DIR`） | 是 |
| 任务级验收只有 `pnpm typecheck`，测试按 C1 / C2 批量做 | 是 |
