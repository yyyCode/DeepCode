# DeepCode P4a（组合面：子代理与技能）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个会话能自己派出**受限的**子代理、按需加载知识包，而这两件事都不新增任何一条放宽权限的路径。

**Architecture:** 内核只多两样东西 —— 一个 `$.agent.spawn` 名词（内层再跑一遍同一个 `runTurn`，换一份 messages、一段 system prompt、一份工具清单）与一个 `$.skill.load` 名词（把技能正文过一遍 `skill.prompt` 这道缝）。白名单只有一个落点（`LoopContext.tools`），但循环里认它**两处**：`describeTools` 管"看不见"、`runOneTool` 管"够不着"。名册（`agents/*.md`、`skills/<name>/SKILL.md`）由两处异步发现函数读出来，交给第一方插件 `cli/subagents.ts` —— 它应答 `agent.offer`、注册 `Task` 与 `Skill` 两个工具、维护嵌套深度栈。**内核里没有硬编码的名册，也没有硬编码的工具表**（P3 守住的那条，本轮不能破）。

**Tech Stack:** TypeScript（ESM，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、Node ≥ 20、pnpm、vitest 2.1.9、tsx。**零运行时依赖**，这一条不允许破 —— frontmatter 解析器自己写就是因为这个。

**设计文档:** [`docs/superpowers/specs/2026-10-11-deepcode-p4a-design.md`](../specs/2026-10-11-deepcode-p4a-design.md)

**前序:** [`P3 计划`](2026-10-11-deepcode-p3.md)（同体例先例，含执行记录与偏差清单）

---

## 执行须知：验收口径

**长期指令（用户明确要求，优先于一切默认做法）：验收尽量精简，一次校验多个任务，以快速完成开发为主。**

具体落法：

1. **任务级验收只要求 `pnpm typecheck` 通过。** 每个任务写完代码与测试后，跑 `pnpm typecheck`，绿了就提交。
2. **测试按检查点批量做。** 任务里的测试**写完即提交**，但整批 `pnpm test` 留到 `C1` / `C2` / `C3` 检查点跑。测试文件与实现写在一起，是同一个任务的一部分。
3. **每个任务结束提交一次。** 提交命令写在任务的最后一步，直接照抄。
4. **任务之间连续执行，不要停下来问。** 只有三种情况值得停下来：真的卡住了（`BLOCKED`）、计划本身有错、或者全部任务做完了。
5. **计划里的代码块是成品，不是示意。** 照抄。如果发现计划有错，改代码的同时**把纠正记到文末的「执行记录」**里 —— P1/P2/P3 都是这么做的，那一段是这份计划最有用的部分。

跑测试的命令（`C1`/`C2`/`C3` 用）：

```bash
pnpm typecheck      # 类型
pnpm lint           # 依赖边界（往 contract/ 里加 import 会红）
pnpm test           # 全部测试
pnpm test test/loop-options.test.ts    # 单个文件
```

## 边界规则

`scripts/check-boundaries.mjs` 的硬约束，P4a 新增的文件必须落在里面：

| 目录 | 允许 import |
|---|---|
| `src/contract/` | **只有 node 内置类型**，不能 import 任何 `src/` 里的东西 |
| `src/core/` | `contract` |
| `src/providers/` | `contract` |
| `src/builtins/` | `contract` |
| `src/cli/` | `contract`、`core`、`providers`、`builtins` |

四条推论，直接决定了 P4a 的文件放哪：

- **frontmatter 解析必须是纯逻辑 → 住 `contract/frontmatter.ts`。** 它零 IO 零依赖，agent 与 skill 两个加载器共用同一份实现。
- **名册发现要读文件 → 住 `cli/agents.ts` 与 `cli/skills.ts`。** 它们要 `node:fs/promises`，而 `builtins/` 只有 `contract` 的 import 权限。
- **`Task` / `Skill` 两个工具 → 住 `cli/subagents.ts`。** 它们要知道名册、要屏幕通知、要深度栈 —— 这三样都是 CLI 侧的东西。（放 `builtins/` 也不是不行，但那里放的是"与 surface 无关的通用工具"，而 `Task` 的屏幕通知与嵌套计数是 REPL 的体验。）
- **内层 `runTurn` 与静音包装 → 住 `core/nouns/agent.ts`。** 它要 `core/loop.ts` 的 `runTurn` 与 `core/dispatch.ts` 的 `DispatchFn`，只有 `core/` 能同时拿到。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/contract/frontmatter.ts` | **新增** | `parseFrontmatter` + `readScalar` / `readList`。纯函数、零 IO、零依赖 |
| `src/contract/agent.ts` | **新增** | `AgentSpec` / `SkillSpec` / `AgentSpawnRequest` / `AgentSpawnResult`（type-only，零 import） |
| `src/contract/events.ts` | 修改 | 三个事件转正（12 → 15 实现）；`agent.spawn` 进 `NOTIFICATION_EVENTS` |
| `src/contract/engine.ts` | 修改 | `AgentNoun` / `SkillNoun`；`CoreEngineInterface` 加两个名词 |
| `src/contract/model-provider.ts` | 修改 | `StreamRequest.model?` |
| `src/contract/next.ts` | 修改 | `UNBUDGETED_EVENTS = ['tool.call']`（Task 9，修正既有缺陷） |
| `src/core/loop.ts` | 修改 | `LoopContext` 加三个可选字段；两个白名单落点；`max_hops`；`model` 透传；`onText` |
| `src/core/dispatch.ts` | 修改 | 长跑事件不上 hook 预算；`DispatcherDeps.hookBudgetMs?`（Task 9） |
| `src/core/nouns/agent.ts` | **新增** | `createAgentNoun`：内层 `runTurn` + 只吞 `turn.step` 的静音包装 |
| `src/core/nouns/skill.ts` | **新增** | `createSkillNoun`：把正文过一遍 `skill.prompt` |
| `src/core/nouns/index.ts` | 修改 | 装配 `agent` / `skill`；多一个 `refs` 参数（两个延迟取的 getter） |
| `src/core/create.ts` | 修改 | 两个延迟取的接线；两条 coreImpl（`agent.offer` / `skill.prompt` 的默认答复） |
| `src/builtins/confirm.ts` | 修改 | 新增「借道放行」一类：`Task` / `Skill`（设计 §6.7） |
| `src/providers/anthropic.ts` | 修改 | `model: req.model ?? config.model` |
| `src/providers/openai.ts` | 修改 | 同上 |
| `src/cli/walkdir.ts` | **新增** | 从 `plugin-dir.ts` 抽出的两段目录遍历 + `rosterRoots`（三处共用） |
| `src/cli/plugin-dir.ts` | 修改 | 删掉本地那份遍历，改用 `walkdir.ts` |
| `src/cli/agents.ts` | **新增** | agent 名册：异步发现、解析成 `AgentSpec`、白名单解析 |
| `src/cli/skills.ts` | **新增** | 技能名册：异步发现、解析成 `SkillSpec` |
| `src/cli/subagents.ts` | **新增** | 第一方插件：应答 `agent.offer`、注册 `Task` 与 `Skill`、深度栈、屏幕通知 |
| `src/cli/offer.ts` | **新增** | `renderOffer`：把 `agent.offer` 的答复渲染成 system prompt 里的一节 |
| `src/cli/plugins.ts` | 修改 | 装 `subagents`；deps 加两张名册与基础提示词 |
| `src/cli/main.ts` | 修改 | 异步发现两张名册并传下去；system prompt 多拼一节；`max_hops` 认成失败 |
| `test/frontmatter.test.ts` | **新增** | 解析器的 13 条 |
| `test/loop-options.test.ts` | **新增** | `LoopContext` 三个新字段与两个落点 |
| `test/provider-model.test.ts` | **新增** | `StreamRequest.model` 省略/给定时两个适配器的行为（4 条） |
| `test/agent-noun.test.ts` | **新增** | `$.agent.spawn` / `$.skill.load`，两条默认 coreImpl |
| `test/agents.test.ts` | **新增** | agent 名册的发现与解析（14 条） |
| `test/skills.test.ts` | **新增** | 技能名册的发现与解析（10 条） |
| `test/hook-budget.test.ts` | **新增** | `tool.call` 不上预算；别的事件照旧（2 条） |
| `test/subagent.test.ts` | **新增** | 端到端：派子代理、隔离、静音、白名单、深度、模型分层 |
| `test/offer.test.ts` | **新增** | `renderOffer` 的四种形态（4 条） |
| `test/skill-tool.test.ts` | **新增** | `Skill` 工具、`skill.prompt` 缝、第三层靠 `Read` |
| `test/harness.ts` | 修改 | `HarnessOptions.hookBudgetMs`（Task 9） |
| `test/dispatch.test.ts` | 修改 | "落到未实现的事件抛 `NotImplementedError`"那条改点名 `config.set`（`agent.spawn` 转正了） |
| `test/plugin-wiring.test.ts` | 修改 | `bundle()` 补上 `cliPlugins` 的三个新必需项 |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 修改 | 计数 12 → 15；agent / skill 约定目录 |

**新增源文件 9 个 + 新增测试 10 个；修改源文件 14 个 + 修改测试 3 个 + 修改文档 3 份。**
（其中 4 个源文件是**修正既有缺陷**而非新增能力：`contract/next.ts`、`core/dispatch.ts`、
`builtins/confirm.ts`、`cli/plugin-dir.ts`。）

---

## Task 1: frontmatter 解析器

**Files:**
- Create: `src/contract/frontmatter.ts`
- Test: `test/frontmatter.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// test/frontmatter.test.ts
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
    expect(readList(fm, 'description')).toBeUndefined();
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
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/frontmatter.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/contract/frontmatter"`

- [ ] **Step 3: 写实现**

```ts
// src/contract/frontmatter.ts

/**
 * 最小 frontmatter 解析器。纯函数、零 IO、零依赖 —— contract/ 的边界不破。
 *
 * 为什么不装个 yaml：零运行时依赖是这个项目的既有承诺（package.json 里只有
 * devDependencies），为十来个标量字段破这个戒不值得。
 *
 * 认识的就这些：
 *   key: value                裸标量
 *   key: "带 \n 转义"          双引号标量（认 \n \" \\，其余转义原样保留）
 *   key: ["a", "b"]           JSON 数组
 *   key: [a, b]               没加引号的方括号（交给 readList 按逗号切）
 *   # 注释 / 空行              忽略
 *
 * 不认识的一律**抛**（带行号）：多行标量（`|` `>`）、嵌套映射、锚点别名、重复键、
 * 没有冒号的行、引号没闭合。猜一个可能猜错的值，比明说"这一行读不懂"坏得多。
 *
 * ⚠️ 逗号切分**不在这儿**（见 readList）：这个解析器不知道哪个字段是列表，
 * 而 description 常含逗号 —— 在这儿切会把一句描述毁成数组。
 */

export type FrontmatterField = string | readonly string[];

export type Frontmatter = {
  readonly fields: ReadonlyMap<string, FrontmatterField>;
  /** frontmatter 之后的部分，原样（只去掉紧跟结束标记的那一个换行）。 */
  readonly body: string;
};

export function parseFrontmatter(text: string): Frontmatter {
  // CRLF 先归一：Windows 上写出来的文件每一行都带 \r，不归一的话键值尾部会留一个回车。
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('缺少 frontmatter（文件必须以一行 `---` 开头）');
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) throw new Error('frontmatter 没有结束的 `---`');

  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');

  const fields = new Map<string, FrontmatterField>();
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 2; // 第 1 行是那个 `---`
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`第 ${lineNo} 行不是 key: value —— ${line}`);
    const key = line.slice(0, colon).trim();
    if (key === '') throw new Error(`第 ${lineNo} 行没有键名`);
    // 重复键：后一个可能是有意覆盖，也可能是复制粘贴留下的 —— 两种都该被人看见。
    if (fields.has(key)) throw new Error(`第 ${lineNo} 行：键 ${key} 重复了`);

    const value = line.slice(colon + 1).trim();
    if (value === '') {
      fields.set(key, '');
      continue;
    }
    if (value.startsWith('|') || value.startsWith('>')) {
      throw new Error(`第 ${lineNo} 行：不支持多行标量（${value[0]}），请写成一行`);
    }
    fields.set(key, toField(value, lineNo));
  }
  return { fields, body };
}

/** 标量、双引号标量，或（合法 JSON 的）字符串数组。其余原样留着给 readList。 */
function toField(value: string, lineNo: number): FrontmatterField {
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed as readonly string[];
      }
    } catch {
      // 不是合法 JSON —— 大概率是 `[Read, Grep]` 这种没加引号的写法。
      // **不在这里报错**：交给 readList 按逗号切（切分归"知道这是列表"的那一方）。
    }
  }
  return unquote(value, lineNo);
}

function unquote(value: string, lineNo: number): string {
  if (!value.startsWith('"')) return value;
  if (value.length < 2 || !value.endsWith('"')) {
    throw new Error(`第 ${lineNo} 行：引号没有闭合 —— ${value}`);
  }
  const inner = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) throw new Error(`第 ${lineNo} 行：结尾的反斜杠没有内容可转义`);
    i++;
    if (next === 'n') out += '\n';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    // 不认识的转义原样保留：少猜一处，少错一处。
    else out += next;
  }
  return out;
}

/** 取一个字符串字段。字段不存在、或它其实是个数组 → undefined。 */
export function readScalar(fm: Frontmatter, key: string): string | undefined {
  const value = fm.fields.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 取一个列表字段。两种写法都认（设计 §3）：
 *   `tools: ["Read", "Grep"]`  （解析器已经变成数组）
 *   `tools: Read, Grep`        （这里按逗号切）
 *   `tools: [Read, Grep]`      （同上，方括号先剥掉）
 *
 * 字段不存在 → `undefined`，**不是空数组**：调用方靠这个区分"没写"与"写了个空的"，
 * 而这两件事在白名单上的含义完全相反（省略 = 继承全部，空 = 一个都不许用）。
 */
export function readList(fm: Frontmatter, key: string): readonly string[] | undefined {
  const value = fm.fields.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter((item) => item !== '');
}
```

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm test test/frontmatter.test.ts`
Expected: PASS —— 13 passed

- [ ] **Step 5: 跑类型检查**

Run: `pnpm typecheck`
Expected: 无输出（绿）

- [ ] **Step 6: 提交**

```bash
git add src/contract/frontmatter.ts test/frontmatter.test.ts
git commit -m "feat(contract): 最小 frontmatter 解析器，零依赖" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: 契约变宽（三个事件转正 + 两组类型）

**Files:**
- Create: `src/contract/agent.ts`
- Modify: `src/contract/events.ts`、`src/contract/engine.ts`、`src/contract/model-provider.ts`

> **这个任务没有可跑的测试 —— 它是纯类型。** 验收就是 `pnpm typecheck`，加上 Step 7 那条反向验证（故意写错一个字段名，确认 typecheck 真的会红）。真正的验收在 Task 3/4/5 用到它们的时候。

- [ ] **Step 1: 新建 `src/contract/agent.ts`**

```ts
// src/contract/agent.ts

/**
 * 组合面的契约类型（P4a）。**type-only、零 import** —— contract/ 的边界不破。
 *
 * 这里有两族，别混：
 * - `AgentSpec` / `SkillSpec` 是**策略侧**的中间表示 —— 从文件里读出来的东西。
 * - `AgentSpawnRequest` / `AgentSpawnResult` 是**内核唯一认识**的那两样，
 *   它们里面的字段**全是已经解析好的**：内核对"省略 tools 是什么意思"一无所知。
 */

export type AgentSpec = {
  readonly name: string;
  /** 路由就靠这一行（模型看到的是它，不是这个文件）。 */
  readonly description: string;
  /** markdown 正文。**为空时回落到会话的基础 system prompt**（设计 §5.1）。 */
  readonly prompt: string;
  /** 白名单。**省略 = 继承父级全部工具**；给了 = 只有列出的能用。 */
  readonly tools?: readonly string[];
  /** 在白名单之上再扣一层。 */
  readonly disallowedTools?: readonly string[];
  /** `'inherit'` | 别名 | 完整 id。省略 = inherit。 */
  readonly model?: string;
  /** 本子代理单次调用的最大往返次数，省略 = loop 的 MAX_HOPS。 */
  readonly maxTurns?: number;
};

export type SkillSpec = {
  readonly name: string;
  readonly description: string;
  /** SKILL.md 的正文（渐进式披露的第二层）。 */
  readonly body: string;
  /**
   * 这个技能自己的目录。
   *
   * **第三层要靠它**：第三层是"模型自己去读 `references/`"，而模型得先知道
   * 那个目录在哪 —— `Skill` 工具的结果里会把路径一块儿给它。
   */
  readonly dir: string;
};

export type AgentSpawnRequest = {
  /** 用于日志与错误消息。 */
  readonly name: string;
  /** **已解析**的系统提示词（回落已经算完）。内核不再做回落判断。 */
  readonly systemPrompt: string;
  readonly task: string;
  /** **已解析**的允许清单。内核只照着它过滤，不做任何减法。 */
  readonly tools: readonly string[];
  /** 已解析的模型；undefined = 用会话自己的（= 父级那个）。 */
  readonly model?: string;
  readonly maxHops?: number;
};

export type AgentSpawnResult = {
  /** 子代理**最后一轮**模型说的话。中间的工具结果一个字都不在这儿。 */
  readonly text: string;
  readonly stopReason: string;
};
```

- [ ] **Step 2: `StreamRequest` 加 `model?`**

`src/contract/model-provider.ts`，把 `StreamRequest` 改成：

```ts
export type StreamRequest = {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal: AbortSignal;
  /**
   * 覆盖适配器配置里的 model。省略 = 用配置的那个（会话级那个，也就是父级）。
   *
   * 模型分层没有别的表达方式：今天 model 是**适配器建的时候**定死的，没有别的口子。
   * 别名（`haiku` / `sonnet` / `opus`）**原样透传**，不翻译、不映射 ——
   * 我们不知道用户配的端点认不认它们，`providers/http.ts` 的 `MODEL_HINT_RE`
   * 已经会在模型 id 不存在时说一句人话，那已经是最好的处理方式。
   */
  readonly model?: string;
};
```

- [ ] **Step 3: `engine.ts` 加两个名词**

在 `src/contract/engine.ts` 里，`ModelNoun` 那一段之后加：

```ts
/**
 * 子代理名词。
 *
 * **插件拿不到 `dispatch`**（hook 签名是 `($, e, next)`），而"跑一个内层 turn"
 * 必须要它 —— 所以这只能是名词。与 `$.model.stream` 同一个先例：
 * 名词是"内核能力的直接实现，不是事件"（MVP 设计 §10 偏差 5）。
 */
export type AgentNoun = {
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>;
};

/**
 * 技能名词：把正文过一遍 `skill.prompt` 这道缝。
 *
 * 这一对名词是"插件拿不到 dispatch"这条约束的**全部**代价：内核为此多开两个口子，
 * 而不是把 dispatch 漏给插件。
 */
export type SkillNoun = {
  load(req: { readonly name: string; readonly text: string }): Promise<{ readonly text: string }>;
};
```

顶部加 import（放在已有的 `model-provider` import 旁边）：

```ts
import type { AgentSpawnRequest, AgentSpawnResult } from './agent';
```

`CoreEngineInterface` 里加两个字段：

```ts
export interface CoreEngineInterface {
  readonly session: SessionNoun;
  readonly tool: ToolNoun;
  readonly command: CommandNoun;
  readonly model: ModelNoun;
  readonly agent: AgentNoun;
  readonly skill: SkillNoun;
  readonly fs: FsNoun;
  readonly process: ProcessNoun;
  readonly store: StoreNoun;
  readonly clock: ClockNoun;
  readonly ui: UiNoun;
  readonly logger: LoggerNoun;
}
```

- [ ] **Step 4: `events.ts` —— 三个事件转正**

`src/contract/events.ts`，在 `EventArgs` 的 `'command.run'` 之后加：

```ts
  // ── P4a 转正的三个（原先在 UnimplementedEvent 那族里）──

  /**
   * 把"这个会话能派什么、能加载什么"报给拼 system prompt 的那一处。
   *
   * 名字偏窄：它顺带报了技能清单。消费者是**同一个**，拆成 `skill.offer` 就是
   * 多一个第 40 个事件、多派一次、拼两份 —— 而事件目录是这个架构里最不该随手
   * 加东西的地方（见本文件顶部那段）。记为已知偏差。
   */
  'agent.offer': Record<string, never>;
  /** 即将启动一个子代理。**纯通知**，不带改写能力。 */
  'agent.spawn': { readonly name: string; readonly task: string; readonly model?: string };
  /**
   * 技能正文展开成文本的那一刻。
   *
   * ⚠️ **这是缝，不是闸**：链尾无人应答 = **原文通过**（默认实现在 coreImpls 里）。
   * 别把它"统一"成 fail-closed —— 在缝上 deny 会让一个没被任何插件碰过的技能
   * 彻底不可用。详细理由见设计 §10.3。
   */
  'skill.prompt': { readonly name: string; readonly text: string };
```

在 `EventResult` 的 `'command.run'` 之后加：

```ts
  'agent.offer': {
    // `tools` 是**我们多加的**（参考实现的 offer 只有 name + description）：
    // 白名单是承重的东西，让用户与模型都看得见比藏起来好。
    readonly agents: readonly {
      readonly name: string;
      readonly description: string;
      readonly tools?: readonly string[];
    }[];
    readonly skills: readonly { readonly name: string; readonly description: string }[];
  };
  'agent.spawn': Record<string, never>;
  'skill.prompt': { readonly text: string };
```

从 `UnimplementedEvent` 那个联合里删掉 `'agent.offer'`、`'agent.spawn'`、`'skill.prompt'`：

```ts
export type UnimplementedEvent =
  | 'prompt.fill'
  | 'prompt.suggest'
  | 'prompt.edit'
  | 'prompt.section'
  | 'prompt.context'
  | 'prompt.compose'
  | 'prompt.attachment'
  | 'command.describe'
  | 'config.set'
  | 'config.describe'
  | 'attribution.text'
  | 'session.receive'
  | 'session.compact'
  | 'session.attach'
  | 'session.detach'
  | 'session.measure';
```

`NOTIFICATION_EVENTS` 加一项：

```ts
export const NOTIFICATION_EVENTS = [
  'session.start',
  'session.end',
  'turn.start',
  'turn.step',
  'turn.complete',
  // P4a：派子代理也是"让插件看得见"这一类 —— 没有任何一条需要内核答复，
  // 链尾 `{}` 兜底正是它该有的语义。将来的 SubagentStart 桥、telemetry 挂这里。
  'agent.spawn',
] as const;
```

顺带把这族注释里"第二族：只声明、未实现的事件"下面那句"39 声明 / 12 实现"的口径说明保持不动 —— 计数在 README 里，不在代码里。

- [ ] **Step 5: 全仓找一圈没跟上的地方**

Run: `pnpm typecheck`
Expected: 有错，而且错得**正好是这两处**：`nouns/index.ts` 返回的对象少了 `agent` / `skill` 两个字段。这是对的（Task 5 才装它们）。

- [ ] **Step 6: 临时把缺的两个名词补上，让类型过关**

`src/core/nouns/index.ts` 的返回对象里，在 `logger` 之前插两行**临时桩**：

```ts
    // ⚠️ 临时桩：Task 5 会用真正的实现替换掉这两行。
    agent: { spawn: async () => ({ text: '', stopReason: 'error' }) },
    skill: { load: async (req) => ({ text: req.text }) },
```

Run: `pnpm typecheck`
Expected: 绿

- [ ] **Step 7: 反向验证 —— 确认这层类型真在拦人**

把 `src/contract/agent.ts` 里 `AgentSpawnRequest` 的 `readonly tools: readonly string[];` 改成 `readonly toolz: readonly string[];`，然后：

Run: `pnpm typecheck`
Expected: **绿 —— 这条此刻是走过场，别被它骗了。** 此刻还没有任何消费者读 `AgentSpawnRequest.tools`
（真正的消费者 `core/nouns/agent.ts` 要到 Task 5 才生出来，而 Step 6 的临时桩不读入参）。
**要看到红，得先造一个消费者**：把 Step 6 的临时桩改成读那个字段 ——
`agent: { spawn: async (req) => ({ text: req.tools.join(','), stopReason: 'error' }) },`
再跑 `pnpm typecheck`，这次会是 `Property 'tools' does not exist on type 'AgentSpawnRequest'. Did you mean 'toolz'?`。
看完把这处探针与那个 typo **一起**改回去，再确认绿。
（这条替换测试的正式版在 Task 5 —— 那里消费者真的存在了，一行 typo 就能让全仓红。）

- [ ] **Step 8: 提交**

```bash
git add src/contract/agent.ts src/contract/events.ts src/contract/engine.ts src/contract/model-provider.ts src/core/nouns/index.ts test/dispatch.test.ts
git commit -m "feat(contract): P4a 契约变宽 —— 三个事件转正、两个名词、model 透传" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

> ⚠️ `test/dispatch.test.ts` 也在这一笔里，计划原先漏了它：那条"落到未实现的事件抛
> `NotImplementedError`"的用例点名的正是 `agent.spawn`，而这一步把它转正了 ——
> 转正之后它既不编译（`agent.spawn` 的入参不再是 `{}`）、也不再成立（通知事件的链尾是 `{}` 不是抛）。
> 改成点名一个仍然未实现的事件（`config.set`），语义一字不变。

---

## Task 3: `LoopContext` 的三个新字段与两个白名单落点

**Files:**
- Modify: `src/core/loop.ts`
- Test: `test/loop-options.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// test/loop-options.test.ts
import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import type { ModelProvider, StreamEvent, ToolResult } from '../src/contract/model-provider';
import type { LoopContext } from '../src/core/loop';
import { runTurn } from '../src/core/loop';
import { createEngine } from '../src/core/create';

/** 三个工具。`called` 记真正被应答的 `tool.call` —— 被拒的那次不该留下痕迹。 */
function toolPlugins(called: string[]): Plugin[] {
  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      for (const name of ['Read', 'Write', 'Task']) {
        on('tool.describe', { tool: name }, () => ({ description: `工具 ${name}`, inputSchema: {} }));
        on('tool.call', { tool: name }, () => {
          called.push(name);
          return { value: `ok:${name}` };
        });
      }
    },
  };
  // 一律放行：这一套里没有 confirm，测的是 loop 自己的过滤。
  const check: Plugin = {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };
  return [tools, check];
}

type RunOptions = {
  script: readonly (readonly StreamEvent[])[];
  tools?: readonly string[];
  maxHops?: number;
  model?: string;
};

async function run(options: RunOptions) {
  const called: string[] = [];
  const requests: { tools: string[]; model: string | undefined }[] = [];
  const texts: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(req) {
      requests.push({ tools: req.tools.map((t) => t.name), model: req.model });
      const events = options.script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const { $, dispatch } = await createEngine({
    plugins: toolPlugins(called),
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Parameters<typeof runTurn>[1] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $,
    provider,
    signal: new AbortController().signal,
    dispatch,
    systemPrompt: 's',
    turnIndex: 0,
    ...(options.tools === undefined ? {} : { tools: new Set(options.tools) }),
    ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
    ...(options.model === undefined ? {} : { model: options.model }),
    onText: (text) => texts.push(text),
  };

  const stopReason = await runTurn(ctx, messages);
  const last = messages.at(-1);
  const lastResult: ToolResult | undefined =
    last?.role === 'tool' ? last.results.at(-1) : undefined;

  return { stopReason, requests, called, texts, lastResult };
}

const callTool = (name: string): readonly StreamEvent[] => [
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' },
];

describe('LoopContext.tools —— 落点一：看不见', () => {
  it('给了清单，模型看到的就只有清单里的', async () => {
    const { requests } = await run({ script: [say('好')], tools: ['Read'] });
    expect(requests[0]?.tools).toEqual(['Read']);
  });

  it('没给清单就不筛 —— 会话主循环走的是这一支', async () => {
    const { requests } = await run({ script: [say('好')] });
    expect(requests[0]?.tools).toEqual(['Read', 'Write', 'Task']);
  });
});

describe('LoopContext.tools —— 落点二：够不着', () => {
  it('点名调用清单外的工具 → 拒，而且 tool.call 根本没被派发', async () => {
    const { called, lastResult } = await run({ script: [callTool('Write')], tools: ['Read'] });
    expect(lastResult?.isError).toBe(true);
    expect(lastResult?.content).toContain('不在本次的工具清单里');
    // 关键：不是"派了但插件拒了"，是**根本没走到插件**。
    expect(called).toEqual([]);
  });

  it('清单内的工具照常跑通 —— 证明上一条测的是过滤而不是"谁都不许用"', async () => {
    const { called, lastResult } = await run({ script: [callTool('Read')], tools: ['Read'] });
    expect(called).toEqual(['Read']);
    expect(lastResult?.isError).toBe(false);
  });
});

describe('maxHops 与 stopReason', () => {
  it('撞上上限时 stopReason 是 max_hops，不是 end_turn', async () => {
    // 每一轮都要工具，永远不自己收手。
    // ⚠️ 脚本必须**每跳都给出工具**：只写一条时，第 2 跳会落到"脚本跑完 →
    // `done`/`end_turn`"的兜底，loop 于是自己收手，压根撞不到上限（这条注释与脚本
    // 曾经对不上，执行时实测才露出来 —— 见执行记录 T3）。
    const { stopReason } = await run({ script: [callTool('Read'), callTool('Read')], maxHops: 2 });
    expect(stopReason).toBe('max_hops');
  });

  it('模型自己收手时是 end_turn —— 上一条测的是区分，不是"一律 max_hops"', async () => {
    const { stopReason } = await run({ script: [say('好')], maxHops: 2 });
    expect(stopReason).toBe('end_turn');
  });
});

describe('model 与 onText', () => {
  it('model 一路透传给 provider', async () => {
    const { requests } = await run({ script: [say('好')], model: 'haiku' });
    expect(requests[0]?.model).toBe('haiku');
  });

  it('不给 model 时就是 undefined —— 适配器据此用配置里那个（父级）', async () => {
    const { requests } = await run({ script: [say('好')] });
    expect(requests[0]?.model).toBeUndefined();
  });

  it('onText 每一轮调一次，给的是那一轮的话；空话不调', async () => {
    const { texts } = await run({ script: [callTool('Read'), say('收工')] });
    expect(texts).toEqual(['收工']);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/loop-options.test.ts`
Expected: FAIL —— 前几条报"工具清单对不上"（`requests[0].tools` 是三个而不是一个）、`max_hops` 那条报 `'end_turn'`。

- [ ] **Step 3: 改 `LoopContext`**

`src/core/loop.ts`，把 `LoopContext` 换成：

```ts
export type LoopContext = {
  $: EngineInterface;
  provider: ModelProvider;
  signal: AbortSignal;
  dispatch: <N extends EventName>(event: N, args: Args<N>, origin: Origin) => Promise<Result<N>>;
  systemPrompt: string;
  turnIndex: number;
  /**
   * 允许调用的工具。**undefined = 不筛**（会话主循环就是这一支）。
   *
   * 子代理的白名单落在这里。它在**两个**地方被认：
   * `describeTools` 管"看不见"、`runOneTool` 管"够不着" —— 少任何一个都是纸糊的，
   * 因为"看不见"拦不住一个被点名调用的工具（P3 的 todo 插件栽过这一次）。
   */
  tools?: ReadonlySet<string>;
  /** 覆盖 MAX_HOPS。子代理的 maxTurns 落在这里。 */
  maxHops?: number;
  /** 覆盖适配器配置里的 model。省略 = 用配置的那个（= 父级那个）。 */
  model?: string;
  /** 每一轮模型说的话（只在非空时调）。主循环不传 —— 它直接走 turn.step 就出去了。 */
  onText?: (text: string) => void;
};
```

- [ ] **Step 4: 改 `runTurn` 的循环**

`runTurn` 开头（`const tools = await describeTools(ctx);` 那两行）改成：

```ts
  const tools = await describeTools(ctx);
  const maxHops = ctx.maxHops ?? MAX_HOPS;
  let stopReason = 'end_turn';
  // 跑满 hop 就是撞墙了。不区分的话调用方分不清"模型说完了"与"到上限了" ——
  // 子代理那一侧会把两种情况都当正常结束，然后拿一段被截断的话当结论。
  let exhausted = true;

  for (let hop = 0; hop < maxHops; hop++) {
```

`ctx.provider.stream({...})` 那个对象加一个字段：

```ts
        for await (const event of ctx.provider.stream({
          system: ctx.systemPrompt,
          messages,
          tools,
          signal: ctx.signal,
          model: ctx.model,
        })) {
```

`messages.push({ role: 'assistant', content: assistantBlocks });` 之后加一行：

```ts
    messages.push({ role: 'assistant', content: assistantBlocks });
    // 只在有话说时调：空话会把"上一轮的话"冲掉（子代理那边用的是覆盖式收集器）。
    if (text) ctx.onText?.(text);
```

`if (toolUses.length === 0) break;` 改成：

```ts
    if (toolUses.length === 0) {
      exhausted = false;
      break;
    }
```

循环结束之后、`await ctx.dispatch('turn.complete', ...)` 之前加：

```ts
  // 走到这儿说明要么跑满、要么模型自己收手（`exhausted = false`）。
  if (exhausted) stopReason = 'max_hops';
```

- [ ] **Step 5: `runOneTool` 的落点二**

`runOneTool` 函数体最前面（`const check = await ctx.dispatch('tool.check', ...)` 之前）加：

```ts
  // 白名单的第二个落点，**在 tool.check 之前**：清单外的工具根本走不到权限链上。
  // 只做"看不见"不够 —— 模型可以照样点名一个它没见过的工具，插件也可以替你应答它。
  if (ctx.tools !== undefined && !ctx.tools.has(use.name)) {
    return {
      toolUseId: use.id,
      content: `ERROR: 已拒绝 —— 工具 ${use.name} 不在本次的工具清单里（可用：${[...ctx.tools].join(', ')}）`,
      isError: true,
    };
  }
```

- [ ] **Step 6: `describeTools` 的落点一**

`describeTools` 的循环体最前面加：

```ts
  for (const name of ctx.$.tool.list()) {
    // 与下面的 `hidden` 同一条：**安静**略去，一条 debug。
    // 这不是"没注册描述"（那是故障，要 warn），是"这个子代理不许用"。
    if (ctx.tools !== undefined && !ctx.tools.has(name)) {
      ctx.$.logger.debug(`工具 ${name} 不在本次的工具清单里，不进模型可见列表。`);
      continue;
    }
    try {
```

- [ ] **Step 7: 跑测试，确认它通过**

Run: `pnpm test test/loop-options.test.ts`
Expected: PASS —— 9 passed

- [ ] **Step 8: 跑全套确认没有回归**

Run: `pnpm test`
Expected: 全绿（`loop.ts` 的四处改动对主循环都是"默认不生效"的）

- [ ] **Step 9: 提交**

```bash
git add src/core/loop.ts test/loop-options.test.ts
git commit -m "feat(core): 工具清单与模型分层落进 LoopContext，max_hops 不再静默" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 两个适配器认 `req.model`

**Files:**
- Modify: `src/providers/anthropic.ts`、`src/providers/openai.ts`、`test/harness.ts`
- Test: `test/provider-model.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// test/provider-model.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest } from '../src/contract/model-provider';
import { createAnthropicProvider } from '../src/providers/anthropic';
import { createOpenAIProvider } from '../src/providers/openai';

const REQUEST: StreamRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
};

/** 假 fetch：记下发出去的请求体，回一段立刻收尾的 SSE。不碰真网络。 */
function stubFetch(frames: string): { sent(): Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(frames, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return { sent: () => body };
}

const ANTHROPIC_FRAMES = 'event: message_stop\ndata: {}\n\n';
const OPENAI_FRAMES = 'data: [DONE]\n\n';

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // 排空而已：这一组测的是发出去的请求，不是收回来的响应。
  }
}

describe('模型分层：StreamRequest.model 覆盖适配器配置里的 model', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('anthropic：给了 model 就发它', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(provider.stream({ ...REQUEST, model: 'haiku' }));
    expect(fake.sent().model).toBe('haiku');
  });

  it('anthropic：没给就用配置里那个 —— 会话主循环走的是这一支', async () => {
    const fake = stubFetch(ANTHROPIC_FRAMES);
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5' });
    await drain(provider.stream({ ...REQUEST }));
    expect(fake.sent().model).toBe('claude-opus-5-5');
  });

  it('openai：给了 model 就发它', async () => {
    const fake = stubFetch(OPENAI_FRAMES);
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt-4o' });
    await drain(provider.stream({ ...REQUEST, model: 'haiku' }));
    expect(fake.sent().model).toBe('haiku');
  });

  it('openai：没给就用配置里那个', async () => {
    const fake = stubFetch(OPENAI_FRAMES);
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt-4o' });
    await drain(provider.stream({ ...REQUEST }));
    expect(fake.sent().model).toBe('gpt-4o');
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/provider-model.test.ts`
Expected: FAIL —— 两条"就发它"的用例拿到的是配置里的 `claude-opus-5-5` / `gpt-4o`。

- [ ] **Step 3: 改 `anthropic.ts`**

`src/providers/anthropic.ts` 的 `stream`，解构多接一个 `model`，并把**两处** `config.model` 换掉：

```ts
    // `req.model` 是模型分层的唯一落点。别名（haiku/sonnet/opus）**原样透传**，
    // 不翻译、不映射 —— 我们不知道用户配的端点认不认它们，猜错还不如让端点自己说。
    // 出错的提示语也要用**真正发出去的那个** id，否则报的是"模型 claude-opus-5-5 不存在"，
    // 而真正发出去的是 haiku，用户照着提示去查会查错地方。
    async *stream({ system, messages, tools, signal, model }) {
      const effectiveModel = model ?? config.model;
```

然后：

```ts
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: config.maxTokens ?? 8192,
```

```ts
        throw new Error(await describeHttpFailure('anthropic', response, effectiveModel));
```

- [ ] **Step 4: 改 `openai.ts`**

同样三处：

```ts
    async *stream({ system, messages, tools, signal, model }) {
      const effectiveModel = model ?? config.model;
```

```ts
        body: JSON.stringify({
          model: effectiveModel,
```

```ts
        throw new Error(await describeHttpFailure('openai', response, effectiveModel));
```

- [ ] **Step 5: 跑测试，确认它通过**

Run: `pnpm test test/provider-model.test.ts`
Expected: PASS —— 4 passed

- [ ] **Step 6: 给 `recordingProvider` 补记 `model`**

`test/harness.ts` 里那个工厂现在只记工具清单。加一份同样形状的记录（后面的 C2 要用它钉模型分层）：

```ts
/**
 * 会记下每次请求里模型看到的工具清单、以及这一趟用的 model 的 provider。
 *
 *「按权限过滤工具可见性」与"模型分层"都只能从这里验 —— 两者都是**模型眼里的东西**，
 * 别处看不见。同一个 provider 的两本账，不额外再造一个。
 */
export function recordingProvider(): {
  provider: ModelProvider;
  lastTools(): string[];
  lastModel(): string | undefined;
} {
  let tools: string[] = [];
  let model: string | undefined;
  return {
    lastTools: () => tools,
    lastModel: () => model,
    provider: {
      name: 'recording',
      async *stream(req: StreamRequest) {
        tools = req.tools.map((t) => t.name);
        model = req.model;
        yield { type: 'done', stopReason: 'end_turn' } as const;
      },
    },
  };
}
```

- [ ] **Step 7: 跑全套确认没有回归**

Run: `pnpm test`
Expected: 全绿（`recordingProvider` 是**加**了一个方法，既有的 `lastTools()` 调用点一行都不用改）

- [ ] **Step 8: 提交**

```bash
git add src/providers/anthropic.ts src/providers/openai.ts test/harness.ts test/provider-model.test.ts
git commit -m "feat(providers): StreamRequest.model 覆盖配置里的 model" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: 两个名词（`agent` / `skill`）

**Files:**
- Create: `src/core/nouns/agent.ts`、`src/core/nouns/skill.ts`
- Modify: `src/core/nouns/index.ts`、`src/core/create.ts`
- Test: `test/agent-noun.test.ts`

- [ ] **Step 1: 新建 `src/core/nouns/skill.ts`**

```ts
// src/core/nouns/skill.ts
import { CORE_ORIGIN } from '../../contract/next';
import type { EngineInterface } from '../../contract/engine';
import type { DispatchFn } from '../dispatch';

/**
 * 把技能正文过一遍 `skill.prompt`。
 *
 * ⚠️ 这是**变换缝**，不是闸：链尾无人应答时返回的是**原文**（coreImpls 里那条），
 * 不是拒绝。在缝上 deny 会让一个没被任何插件碰过的技能彻底不可用。
 * 详细理由见 `contract/events.ts` 里 `'skill.prompt'` 的注释与设计 §10.3。
 */
export function createSkillNoun(deps: {
  dispatch: () => DispatchFn;
}): EngineInterface['skill'] {
  return {
    async load(req) {
      const result = await deps.dispatch()(
        'skill.prompt',
        { name: req.name, text: req.text },
        CORE_ORIGIN,
      );
      return { text: result.text };
    },
  };
}
```

- [ ] **Step 2: 新建 `src/core/nouns/agent.ts`**

```ts
// src/core/nouns/agent.ts
import type { AgentSpawnRequest, AgentSpawnResult } from '../../contract/agent';
import type { EngineInterface } from '../../contract/engine';
import type { Args, EventName, Result } from '../../contract/events';
import type { Message, ModelProvider } from '../../contract/model-provider';
import { CORE_ORIGIN, type Origin } from '../../contract/next';
import type { DispatchFn } from '../dispatch';
import { runTurn, type LoopContext } from '../loop';

/**
 * 子代理名词：内层再跑一遍**同一个** `runTurn`。
 *
 * 不是子进程、不是第二个循环。换的只有三样：一份全新的 messages、一段 system prompt、
 * 一份更小的工具清单。于是"子代理不能做父级不能做的事"是**结构**，不是一条要人守的规则
 * —— 它走的是同一条 `dispatch`、同一条链，`tool.check` 是同一个函数调用。
 */
export function createAgentNoun(deps: {
  /** 延迟取 `$`：折叠完成之前它还不存在，而内层那一轮必须跑在折叠后的 `$` 上。 */
  engine: () => EngineInterface;
  provider: ModelProvider;
  /** signal 是**工厂**：abort 过的 signal 再也回不去，现取才等于"只掐这一次"。 */
  signal: () => AbortSignal;
  dispatch: () => DispatchFn;
}): EngineInterface['agent'] {
  return {
    async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
      const dispatch = deps.dispatch();

      // 派**在开跑之前**：订阅它的插件（将来的 SubagentStart 桥、telemetry）
      // 要在子代理动手之前就看得见。
      await dispatch(
        'agent.spawn',
        {
          name: req.name,
          task: req.task,
          ...(req.model === undefined ? {} : { model: req.model }),
        },
        CORE_ORIGIN,
      );

      // 子代理说的话不往屏幕上流，理由不是"省事"：它是父级那一轮的一个工具调用，
      // 让它自己的文本混进输出，用户会以为那是回答。
      //
      // 只能从 dispatch 这一层拦：`cli-stream` 是**拿自己的 render 闭包**直接写屏幕的
      // （cli/stream.ts），换一个安静的 `$` 根本拦不住它。
      //
      // **只吞 turn.step，其余一律照发**：
      // - `tool.*` 必须照发 —— 子代理改的文件要进 `/diff`（createChangesPlugin 记的账）。
      //   静音静的是**屏幕**，不是**事实**。
      // - `turn.start` / `turn.complete` 也必须照发 —— 它们记的是"这里真跑过一轮"。
      const silent: DispatchFn = <N extends EventName>(
        event: N,
        args: Args<N>,
        origin: Origin,
      ): Promise<Result<N>> =>
        event === 'turn.step' ? Promise.resolve({} as never) : dispatch(event, args, origin);

      let text = '';
      const messages: Message[] = [{ role: 'user', content: req.task }];
      const ctx: LoopContext = {
        $: deps.engine(),
        provider: deps.provider,
        signal: deps.signal(),
        dispatch: silent,
        systemPrompt: req.systemPrompt,
        // 子代理自己那本账从 0 开始。
        turnIndex: 0,
        tools: new Set(req.tools),
        // 覆盖而不是累加：要的就是"最后一段话"。空话不调（loop 里那处 `if (text)`），
        // 所以最后一轮只调了工具没说话时，留下的还是上一次说的话 —— 正是想要的。
        onText: (chunk) => {
          text = chunk;
        },
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.maxHops === undefined ? {} : { maxHops: req.maxHops }),
      };

      const stopReason = await runTurn(ctx, messages);
      return { text, stopReason };
    },
  };
}
```

- [ ] **Step 3: 改 `nouns/index.ts` —— 多一个 `refs` 参数**

文件里**已有的东西一个字都不动**（`CoreNounsDeps`、那十条名词、`registry` 的那段注释）。只做四件事：加 import、加 `CoreNounsRefs`、给函数加第三个参数、往返回对象里插两行。

import 换成：

```ts
import type { CoreEngineInterface, EngineInterface, ModelProvider } from '../../contract/engine';
import type { Registry } from '../registry';
import type { DispatchFn } from '../dispatch';
import { createAgentNoun } from './agent';
import { createClockNoun } from './clock';
import { createFsNoun } from './fs';
import { createLoggerNoun } from './logger';
import { createProcessNoun } from './process';
import { createSkillNoun } from './skill';
import { createStoreNoun } from './store';
import { createUiNoun, type UiSink } from './ui';
```

`CoreNounsDeps` 之后加：

```ts
export type CoreNounsRefs = {
  /**
   * 延迟取 `$`。
   *
   * 它要到 `createEngine` 的折叠完成之后才存在 —— 而 `agent` 名词要在内层跑一轮，
   * 那一轮必须拿**折叠后**的 `$`（引擎自己的 hook 那时才都挂上去了），
   * 不是 `createCoreNouns` 手里这份还只有内核名词的半成品。
   * 与 `DispatcherDeps.engine`（core/dispatch.ts:19）同一个形状、同一条理由。
   */
  readonly engine: () => EngineInterface;
  /** 同理：dispatch 也是 createEngine 建完才有的。 */
  readonly dispatch: () => DispatchFn;
};
```

函数签名与函数体（`registry` 那条注释照旧，只在它上面补一句 `refs`）：

```ts
/**
 * `registry` 与 `refs` 是第二、第三个参数而不是 deps 的字段：两者都由 createEngine 自建，
 * 调用方（cli/main.ts）不该也不可能有它们。
 */
export function createCoreNouns(
  deps: CoreNounsDeps,
  registry: Registry,
  refs: CoreNounsRefs,
): CoreEngineInterface {
  return {
    session: { /* 原样 */ },
    tool: { list: () => registry.matcherValues('tool.call', 'tool') },
    command: { list: () => registry.matcherValues('command.run', 'name') },
    model: { stream: (req) => deps.provider.stream(req) },
    agent: createAgentNoun({
      engine: refs.engine,
      provider: deps.provider,
      signal: deps.signal,
      dispatch: refs.dispatch,
    }),
    skill: createSkillNoun({ dispatch: refs.dispatch }),
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    clock: createClockNoun(),
    ui: createUiNoun(deps.ui),
    logger: createLoggerNoun(deps.env),
  };
}
```

**同时删掉 Task 2 Step 6 那两行临时桩。**（它们是 `agent: { spawn: ... }` 与 `skill: { load: ... }`，现在有了真东西。）

- [ ] **Step 4: 改 `create.ts` —— 两条延迟取 + 两条 coreImpl**

`createEngine` 开头：

```ts
export async function createEngine(deps: CreateEngineDeps): Promise<BuiltEngine> {
  const registry = new Registry();
  let engine: EngineInterface | undefined;
  let dispatchFn: DispatchFn | undefined;

  const coreNouns = createCoreNouns(deps, registry, {
    // 两个都延迟取：它们要到下面折叠完成之后才存在。`$` 尤其要紧 ——
    // 子代理要在**折叠后的** $ 上跑，引擎自己的 hook 那时才都挂上去了。
    engine: () => {
      if (!engine) throw new Error('$ 尚未构建完成');
      return engine;
    },
    dispatch: () => {
      if (!dispatchFn) throw new Error('dispatch 尚未构建完成');
      return dispatchFn;
    },
  });
```

`coreImpls` 里加两条（放在 `'tool.describe'` 之前）：

```ts
    // 没人报名册就是空清单。**内核不认识任何 agent/skill 文件** ——
    // 发现是 CLI 侧的事（cli/agents.ts、cli/skills.ts），与"内核没有硬编码的工具表"同一条。
    // 链尾无人应答 = 能力方向的 fail-closed：没有就是没有，不给个假清单。
    'agent.offer': () => ({ agents: [], skills: [] }) as const,

    // ⚠️ 这条**不是** fail-closed —— 它是变换缝的默认值：没人要改，就原文通过。
    // 在这儿 deny 会让一个没被任何插件碰过的技能彻底不可用。
    // 别把它"统一"成上面那条的形状，两者问的不是同一个问题（设计 §10.3）。
    'skill.prompt': (e) => ({ text: String(e.text) }),
```

接线（`createDispatcher` 那一段之后）：

```ts
  const { dispatch } = createDispatcher({
    registry,
    engine: () => {
      if (!engine) throw new Error('$ 尚未构建完成');
      return engine;
    },
    coreImpls,
    logger: coreNouns.logger,
    signal: deps.signal,
  });
  dispatchFn = dispatch;
```

- [ ] **Step 5: 写测试**

```ts
// test/agent-noun.test.ts
import { describe, expect, it } from 'vitest';
import type { Plugin } from '../src/contract/plugin';
import type { ModelProvider, StreamEvent } from '../src/contract/model-provider';
import { createEngine } from '../src/core/create';

const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' },
];

const callTool = (name: string): readonly StreamEvent[] => [
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

/** 一轮里既说话又要工具 —— 用来验"回传的是最后一段话"。 */
const sayAndCall = (text: string, name: string): readonly StreamEvent[] => [
  { type: 'text', text },
  { type: 'tool_use', id: 'u1', name, input: {} },
  { type: 'done', stopReason: 'tool_use' },
];

type Seen = { tools: string[]; model: string | undefined; msgCount: number; first: string };

async function mount(script: readonly (readonly StreamEvent[])[]) {
  const seen: Seen[] = [];
  const calls: string[] = [];
  const observed: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(req) {
      seen.push({
        tools: req.tools.map((t) => t.name),
        model: req.model,
        msgCount: req.messages.length,
        first: JSON.stringify(req.messages[0]),
      });
      const events = script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const tools: Plugin = {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      for (const name of ['Read', 'Write']) {
        on('tool.describe', { tool: name }, () => ({ description: `工具 ${name}`, inputSchema: {} }));
        on('tool.call', { tool: name }, () => {
          calls.push(name);
          return { value: `ok:${name}` };
        });
      }
    },
  };

  const check: Plugin = {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision: 'allow' }) as const);
    },
  };

  // 观察者：静音与否只能从"事件到底有没有被派发"看出来。
  const observer: Plugin = {
    name: 'test-observer',
    uses: ['turn.start', 'turn.step', 'turn.complete', 'agent.spawn'],
    register(on) {
      for (const event of ['turn.start', 'turn.step', 'turn.complete', 'agent.spawn'] as const) {
        on(event, () => {
          observed.push(event);
          return {} as never;
        });
      }
    },
  };

  const engine = await createEngine({
    plugins: [tools, check, observer],
    provider,
    // 这条链里没有 confirm，所以子代理里的 Write 不必过 y/N。
    ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const spawn = (overrides: Partial<Parameters<typeof engine.$.agent.spawn>[0]> = {}) =>
    engine.$.agent.spawn({
      name: 'explorer',
      systemPrompt: '你是探索者',
      task: '看看这个',
      tools: ['Read'],
      ...overrides,
    });

  return { ...engine, seen, calls, observed, spawn };
}

describe('子代理：隔离', () => {
  it('第一次请求里只有任务本身 —— 父级的对话历史进不去', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.seen[0]?.msgCount).toBe(1);
    expect(m.seen[0]?.first).toContain('看看这个');
  });

  it('工具调用照常跑 —— 中间的工具结果留在子代理自己那本账里', async () => {
    const m = await mount([callTool('Read'), say('结论')]);
    const result = await m.spawn();
    expect(m.calls).toEqual(['Read']);
    expect(m.seen.length).toBe(2);
    expect(result.text).toBe('结论');
  });
});

describe('子代理：静音', () => {
  it('吞掉 turn.step，但 turn.start / turn.complete / agent.spawn 照发', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.observed).toContain('turn.start');
    expect(m.observed).toContain('turn.complete');
    expect(m.observed).toContain('agent.spawn');
    // 屏幕那一侧：子代理说的话一个字节都不许流出去。
    expect(m.observed).not.toContain('turn.step');
  });

  it('tool.call 不被吞 —— /diff 的账不能丢', async () => {
    const m = await mount([callTool('Read'), say('结论')]);
    await m.spawn();
    expect(m.calls).toEqual(['Read']);
  });
});

describe('子代理：回传', () => {
  it('回传的是**最后一段**话，不是拼接', async () => {
    const m = await mount([sayAndCall('我看看', 'Read'), say('结论')]);
    const result = await m.spawn();
    expect(result.text).toBe('结论');
  });

  it('末轮没说话时留的是上一轮那句 —— 空话不覆盖', async () => {
    // 第 2 轮只有工具调用、没有文本；第 3 轮才有话。
    const m = await mount([sayAndCall('我看看', 'Read'), callTool('Read'), say('结论')]);
    const result = await m.spawn();
    expect(result.text).toBe('结论');
  });

  it('撞上限时 stopReason 是 max_hops，一路带回来', async () => {
    // 同上：脚本每跳都要有工具，否则兜底的 end_turn 会掩盖"撞墙"这条路径。
    const m = await mount([callTool('Read'), callTool('Read')]);
    const result = await m.spawn({ maxHops: 2 });
    expect(result.stopReason).toBe('max_hops');
  });
});

describe('子代理：白名单与模型分层', () => {
  it('子代理只看得见清单里的工具', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ tools: ['Read'] });
    expect(m.seen[0]?.tools).toEqual(['Read']);
  });

  it('model 透传到 provider', async () => {
    const m = await mount([say('好')]);
    await m.spawn({ model: 'haiku' });
    expect(m.seen[0]?.model).toBe('haiku');
  });

  it('不给 model 时是 undefined —— 适配器据此用配置里那个（= 父级）', async () => {
    const m = await mount([say('好')]);
    await m.spawn();
    expect(m.seen[0]?.model).toBeUndefined();
  });
});

describe('内核的默认答复（不接插件的裸引擎）', () => {
  it('agent.offer 链尾无人应答 = 空清单', async () => {
    const engine = await createEngine({
      plugins: [],
      provider: { name: 'noop', async *stream() { /* 用不到 */ } },
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const offer = await engine.dispatch('agent.offer', {}, { plugin: 'core', tier: 'core' });
    expect(offer).toEqual({ agents: [], skills: [] });
  });

  it('skill.prompt 链尾无人应答 = **原文通过**（变换缝，不是闸）', async () => {
    const engine = await createEngine({
      plugins: [],
      provider: { name: 'noop', async *stream() { /* 用不到 */ } },
      ui: { print: () => {}, notice: () => {}, ask: async () => 'y' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
      signal: () => new AbortController().signal,
    });
    const loaded = await engine.$.skill.load({ name: 'x', text: '原文' });
    expect(loaded.text).toBe('原文');
  });
});
```

> ⚠️ 最后那两条用例里的 origin **别手写对象字面量**：`import { CORE_ORIGIN } from '../src/contract/next';`，
> 然后用 `engine.dispatch('agent.offer', {}, CORE_ORIGIN)`。
> （这一份测试里只有这两处需要它 —— 别的用例走的是 `$.agent.spawn`，origin 在名词里已经写好了。）

- [ ] **Step 6: 跑测试，确认它通过**

Run: `pnpm test test/agent-noun.test.ts`
Expected: PASS —— 12 passed

- [ ] **Step 7: 反向验证 —— 到这一步消费者终于存在了**

Task 2 的 Step 7 是走过场的（那时没人读 `AgentSpawnRequest`）。**现在是真的了**，两条都要红：

1. 把 `src/contract/agent.ts` 的 `AgentSpawnRequest` 里 `readonly tools: readonly string[];`
   改成 `readonly toolz: ...`，跑 `pnpm typecheck`。
   Expected: **红**，且错在 `src/core/nouns/agent.ts`（"Property 'tools' does not exist"）。改回来。
2. 把 `src/core/create.ts` 里那条 `'skill.prompt': (e) => ({ text: String(e.text) })` 注释掉，
   跑 `pnpm test test/agent-noun.test.ts`。
   Expected: **红** —— `$.skill.load` 落到链尾没人应答，抛 `NotImplementedError`。
   **这条证明的是"缝"的语义是承重的**：缝尾那条默认实现一没，技能就彻底不可用。
   看到红之后把那一行**原样改回来**（连注释一起）。

两条都红了才算数。任一条不红，说明那一处是摆设，修的是断言本身。

- [ ] **Step 8: 跑全套 + 类型**

```bash
pnpm typecheck && pnpm test
```

Expected: 全绿

- [ ] **Step 9: 提交**

```bash
git add src/core/nouns/agent.ts src/core/nouns/skill.ts src/core/nouns/index.ts src/core/create.ts test/agent-noun.test.ts
git commit -m "feat(core): agent 与 skill 两个名词，内层跑同一个 runTurn" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: 抽出 `walkdir.ts`，三处共用遍历

**Files:**
- Create: `src/cli/walkdir.ts`
- Modify: `src/cli/plugin-dir.ts:1,119,185-201`

- [ ] **Step 1: 新建 `src/cli/walkdir.ts`**

```ts
// src/cli/walkdir.ts
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 目录遍历 + 名册的根：**三处**共用（插件、agent、技能）。
 *
 * 抽出来的理由不是省行数：三处的"读不了怎么办"必须是**同一个答案** ——
 * 否则一个坏掉的 `skills/` 目录会在一处静默、在另一处吼，用户看到的行为随风飘。
 *
 * ⚠️ 复用只到"遍历"这一层。`plugin-manifest.ts` 那个 JSON 清单校验器**不复用**
 * （设计 §4.3）—— 字段集与 frontmatter 完全不同，硬套会得到一个两边都不像的东西。
 */

/**
 * 读一层目录的原始条目。**不存在 → `undefined` 且不吭声**（常态）；
 * 在但读不了 → 吼一声 + `undefined`（这一层这次一个都不用）。
 */
async function listEntries(
  dir: string,
  what: string,
  warn: (line: string) => void,
) {
  try {
    // 显式写 `encoding: 'utf8'`：`readdir` 带 `withFileTypes` 时名字的类型跟着编码走，
    // 不写就落到 Buffer 那支重载上，`entry.name` 变成 NonSharedBuffer。
    return await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    warn(
      `${what} ${dir} 读不了（${error instanceof Error ? error.message : String(error)}）—— 这一层这次一个都不用。`,
    );
    return undefined;
  }
}

/** 目录下的子目录名，字典序。 */
export async function subdirectories(
  dir: string,
  what: string,
  warn: (line: string) => void,
): Promise<readonly string[]> {
  const entries = await listEntries(dir, what, warn);
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 目录下的 `.md` 文件名，字典序。错误行为与上一条完全一致。 */
export async function markdownFiles(
  dir: string,
  what: string,
  warn: (line: string) => void,
): Promise<readonly string[]> {
  const entries = await listEntries(dir, what, warn);
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

export type RosterRoot = {
  readonly origin: 'project' | 'user' | 'plugin';
  readonly dir: string;
  /** 插件级名册的名字前缀（`<插件名>:<name>`）。项目级/用户级没有。 */
  readonly namespace?: string;
};

/**
 * 名册该去哪些目录找，**按优先级从高到低**。三个来源的顺序是规则不是巧合（设计 §4.1/§4.2）：
 *
 * - 项目级赢用户级：与 settings、与插件目录同一个方向 —— "这个仓库要求用什么"
 *   比"我全局装过什么"更具体。
 * - 插件级排最后：它带命名空间，结构上撞不上；排最后只是让"先放的赢"在三个来源上
 *   是同一个答案。
 *
 * `home` 兜底成 `root` 时项目级与用户级是**同一个目录**（main.ts 的 home 默认值），
 * 那种情况下按用户级算，去重一次 —— 与 plugin-dir.ts 里那条同源。
 */
export function rosterRoots(deps: {
  readonly root: string;
  readonly home: string;
  readonly plugins: readonly { readonly name: string; readonly dir: string }[];
  /** `'agents'` 或 `'skills'`。 */
  readonly sub: string;
}): readonly RosterRoot[] {
  const projectDir = join(deps.root, '.deepcode', deps.sub);
  const userDir = join(deps.home, '.deepcode', deps.sub);

  const roots: RosterRoot[] =
    resolve(projectDir) === resolve(userDir)
      ? [{ origin: 'user', dir: userDir }]
      : [
          { origin: 'project', dir: projectDir },
          { origin: 'user', dir: userDir },
        ];

  for (const plugin of deps.plugins) {
    roots.push({ origin: 'plugin', dir: join(plugin.dir, deps.sub), namespace: plugin.name });
  }
  return roots;
}
```

- [ ] **Step 2: `plugin-dir.ts` 改用它**

三处改动：

1. 第 1 行的 import 去掉 `readdir`（它只被下面那个函数用过）：

```ts
import { readFile, stat } from 'node:fs/promises';
```

2. 加一行 import：

```ts
import { subdirectories } from './walkdir';
```

3. 第 119 行的调用改成三参数：

```ts
    for (const name of await subdirectories(dir, '插件目录', warn)) {
```

4. **删掉本地的 `subdirectories` 函数**（第 184-201 行，含上面那两行注释 ——
   它们已经搬到 `walkdir.ts` 里去了）。删干净，别留一个没人调用的版本。

- [ ] **Step 3: 跑全套测试**

Run: `pnpm test`
Expected: 全绿。**没有一条测试断言"插件目录读不了"那句原话**（已确认过：`test/` 里唯一的
"读不了"断言在 `settings.test.ts` 与 `plugin-manifest.test.ts` 里，说的是别的文件）。
如果真红了，说明有一处断言钉着旧措辞 —— 改那条断言，措辞变了是这次重构的正当后果。

- [ ] **Step 4: 跑类型与边界**

```bash
pnpm typecheck && pnpm lint
```

Expected: 全绿（`walkdir.ts` 在 `cli/` 里，只用 node 内置模块，边界不破）

- [ ] **Step 5: 提交**

```bash
git add src/cli/walkdir.ts src/cli/plugin-dir.ts
git commit -m "refactor(cli): 目录遍历抽到 walkdir.ts，三处共用" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: agent 名册

**Files:**
- Create: `src/cli/agents.ts`
- Test: `test/agents.test.ts`

- [ ] **Step 1: 写实现**

```ts
// src/cli/agents.ts
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentSpec } from '../contract/agent';
import { parseFrontmatter, readList, readScalar, type Frontmatter } from '../contract/frontmatter';
import { markdownFiles, rosterRoots, type RosterRoot } from './walkdir';

/**
 * 认得的 frontmatter 字段。**其余一律 warn + 忽略**，不让整个文件作废。
 *
 * 为什么不报错：参考实现的 agent 定义有 17 个字段，我们只实现六个。一份合法的、
 * 用着别的字段的 agent 文件应该还能装进来（少几个特性），而不是一个字都读不了。
 */
export const KNOWN_AGENT_FIELDS: readonly string[] = [
  'name',
  'description',
  'model',
  'tools',
  'disallowedTools',
  'maxTurns',
];

export type AgentRosterDeps = {
  /** 会话根目录，读 `<root>/.deepcode/agents/`。 */
  readonly root: string;
  /** 主目录，读 `~/.deepcode/agents/`。 */
  readonly home: string;
  /** **已装载**的插件（只算判为 loaded 的）。被 deny 的、没 enable 的不贡献名册。 */
  readonly plugins?: readonly { readonly name: string; readonly dir: string }[];
  readonly warn?: (line: string) => void;
};

/**
 * 读一遍三处根，得到一个按名字排好序的 agent 名册。
 *
 * **目录不存在是常态，安静**；目录在但读不了、文件坏掉、没有 `description`，
 * 都是一条 warn + 这一个文件不装 —— 与 `plugin-dir` 同一条：没有半个 agent。
 */
export async function discoverAgents(deps: AgentRosterDeps): Promise<readonly AgentSpec[]> {
  const warn = deps.warn ?? ((): void => {});
  /** 名字 → 来源说明。先放的赢。 */
  const claimed = new Map<string, string>();
  const agents: AgentSpec[] = [];

  const roots = rosterRoots({
    root: deps.root,
    home: deps.home,
    plugins: deps.plugins ?? [],
    sub: 'agents',
  });

  for (const root of roots) {
    for (const file of await markdownFiles(root.dir, 'agent 目录', warn)) {
      const path = join(root.dir, file);
      const spec = await readAgent(path, root, warn);
      if (spec === undefined) continue;

      const owner = claimed.get(spec.name);
      if (owner !== undefined) {
        // 落选的那份必须出声：静默丢弃会让人对着一个改了半天没反应的 agent 文件发呆。
        warn(`${path}：agent ${spec.name} 已由${owner}提供，这一份没用上。`);
        continue;
      }
      claimed.set(spec.name, describeOrigin(root));
      agents.push(spec);
    }
  }

  return agents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function describeOrigin(root: RosterRoot): string {
  if (root.origin === 'plugin') return `插件 ${root.namespace}`;
  return root.origin === 'project' ? '项目级目录' : '用户级目录';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读一个文件 → 一份 `AgentSpec`；任何一处不对就 warn + `undefined`（这一个不装）。 */
async function readAgent(
  path: string,
  root: RosterRoot,
  warn: (line: string) => void,
): Promise<AgentSpec | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    warn(`${path} 读不了（${describeError(error)}）—— 这个 agent 不装。`);
    return undefined;
  }

  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(text);
  } catch (error) {
    // frontmatter 用了不支持的语法：**不猜**，整个文件不装（设计 §3/§11）。
    warn(`${path}：frontmatter 坏掉（${describeError(error)}）—— 这个 agent 不装。`);
    return undefined;
  }

  for (const key of fm.fields.keys()) {
    if (!KNOWN_AGENT_FIELDS.includes(key)) warn(`${path}：不认识的字段 ${key}，忽略。`);
  }

  const declared = readScalar(fm, 'name');
  if (declared === undefined) {
    warn(`${path}：没写 name，用文件名兜底。`);
  }
  const local = declared ?? basename(path, '.md');
  // 插件级带命名空间前缀，与项目级/用户级结构上撞不上（设计 §4.1）。
  const name = root.namespace === undefined ? local : `${root.namespace}:${local}`;

  const description = readScalar(fm, 'description');
  if (description === undefined || description.trim() === '') {
    // 路由**全靠**这一行：没有它，这个 agent 永远不会被选中，装进来只是个看不见的摆设。
    warn(`${path}：没有 description —— 路由全靠它，这个 agent 不装。`);
    return undefined;
  }

  const model = readScalar(fm, 'model');
  const tools = readList(fm, 'tools');
  const disallowedTools = readList(fm, 'disallowedTools');
  const maxTurns = readPositiveInt(fm, 'maxTurns', path, warn);

  // 可选字段一律用展开，不写 `tools: undefined`：省得依赖 exactOptionalPropertyTypes 关着。
  return {
    name,
    description,
    // 正文为空不是错误：插件那一侧会回落到会话的基础 system prompt（设计 §5.1）。
    prompt: fm.body.trim(),
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    // `inherit` 是缺省，与"没写"是同一种含义：用父级那个（参考实现 15 个 agent 里 8 个写它）。
    ...(model === undefined || model === 'inherit' ? {} : { model }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
}

function readPositiveInt(
  fm: Frontmatter,
  key: string,
  path: string,
  warn: (line: string) => void,
): number | undefined {
  const raw = readScalar(fm, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    warn(`${path}：${key} 要是正整数，读到 ${raw} —— 忽略这个字段。`);
    return undefined;
  }
  return value;
}
```

- [ ] **Step 2: 写测试**

```ts
// test/agents.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAgents } from '../src/cli/agents';

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
```

- [ ] **Step 3: 跑测试**

Run: `pnpm test test/agents.test.ts`
Expected: PASS —— 14 passed

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 绿

- [ ] **Step 5: 提交**

```bash
git add src/cli/agents.ts test/agents.test.ts
git commit -m "feat(cli): agent 名册的异步发现与解析" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: 技能名册

**Files:**
- Create: `src/cli/skills.ts`
- Test: `test/skills.test.ts`

- [ ] **Step 1: 写实现**

```ts
// src/cli/skills.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillSpec } from '../contract/agent';
import { parseFrontmatter, readScalar, type Frontmatter } from '../contract/frontmatter';
import { rosterRoots, subdirectories, type RosterRoot } from './walkdir';

/**
 * 认得的 frontmatter 字段。`version` 与 `license` **收下但不用** ——
 * 参考笔记里说技能 frontmatter 只有 name / description / version / license 这四个，
 * 对它们报"不认识"是纯噪音。
 */
export const KNOWN_SKILL_FIELDS: readonly string[] = ['name', 'description', 'version', 'license'];

/** description 的上限。500 是参考实现给的规范值，不是我们拍的数（设计 §10.1）。 */
const DESCRIPTION_LIMIT = 500;

export type SkillRosterDeps = {
  readonly root: string;
  readonly home: string;
  readonly plugins?: readonly { readonly name: string; readonly dir: string }[];
  readonly warn?: (line: string) => void;
};

/**
 * 技能的目录形态是 `<skillsDir>/<name>/SKILL.md`（不是散落的 `.md`）——
 * 因为它自带一个目录：`references/`、`examples/`、`scripts/` 那些**第三层**的东西
 * 就放在技能自己的目录里，靠模型用 `Read` / `Bash` 自己取（设计 §10.1）。
 *
 * 所以 `SkillSpec.dir` 是承重的：`Skill` 工具的结果里要把这个路径交给模型。
 */
export async function discoverSkills(deps: SkillRosterDeps): Promise<readonly SkillSpec[]> {
  const warn = deps.warn ?? ((): void => {});
  const claimed = new Map<string, string>();
  const skills: SkillSpec[] = [];

  const roots = rosterRoots({
    root: deps.root,
    home: deps.home,
    plugins: deps.plugins ?? [],
    sub: 'skills',
  });

  for (const root of roots) {
    for (const dirName of await subdirectories(root.dir, '技能目录', warn)) {
      const dir = join(root.dir, dirName);
      const spec = await readSkill(join(dir, 'SKILL.md'), dir, dirName, root, warn);
      if (spec === undefined) continue;

      const owner = claimed.get(spec.name);
      if (owner !== undefined) {
        warn(`${dir}：技能 ${spec.name} 已由${owner}提供，这一份没用上。`);
        continue;
      }
      claimed.set(spec.name, describeOrigin(root));
      skills.push(spec);
    }
  }

  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function describeOrigin(root: RosterRoot): string {
  if (root.origin === 'plugin') return `插件 ${root.namespace}`;
  return root.origin === 'project' ? '项目级目录' : '用户级目录';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSkill(
  path: string,
  dir: string,
  dirName: string,
  root: RosterRoot,
  warn: (line: string) => void,
): Promise<SkillSpec | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // 目录在、SKILL.md 不在（`ENOENT`）是最常见的一种：直接说清要什么文件名，
    // 别只说"读不了"——用户看到的是这个技能为什么没出现。
    warn(`${dir}：没有可读的 SKILL.md（${describeError(error)}）—— 这个技能不装。`);
    return undefined;
  }

  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(text);
  } catch (error) {
    warn(`${path}：frontmatter 坏掉（${describeError(error)}）—— 这个技能不装。`);
    return undefined;
  }

  for (const key of fm.fields.keys()) {
    if (!KNOWN_SKILL_FIELDS.includes(key)) warn(`${path}：不认识的字段 ${key}，忽略。`);
  }

  const declared = readScalar(fm, 'name');
  if (declared === undefined) warn(`${path}：没写 name，用目录名兜底。`);
  const local = declared ?? dirName;
  const name = root.namespace === undefined ? local : `${root.namespace}:${local}`;

  const description = readScalar(fm, 'description');
  if (description === undefined || description.trim() === '') {
    warn(`${path}：没有 description —— 模型全靠它决定要不要加载，这个技能不装。`);
    return undefined;
  }

  const body = fm.body.trim();
  if (body === '') {
    // 装还是要装的（正文可能是空的但即将由 skill.prompt 的应答者填上），
    // 但这事得让人看见：不吭声的话，加载它得到一屏空白。
    warn(`${path}：正文是空的 —— 加载它只会得到一段空文本。`);
  }

  // 截断是**装载时**做的（设计 §10.1）：这段文字每次会话都进 system prompt，
  // 而清单里的每一行都是真金白银的 token。截了要出声。
  const trimmed =
    description.length > DESCRIPTION_LIMIT
      ? (() => {
          warn(
            `${path}：description 有 ${description.length} 字符，超过 ${DESCRIPTION_LIMIT}，已截断。`,
          );
          return description.slice(0, DESCRIPTION_LIMIT);
        })()
      : description;

  return {
    name,
    description: trimmed,
    body,
    /** 技能自己的目录：第三层（`references/` 等）靠它 + 模型自己的 `Read`。 */
    dir,
  };
}
```

- [ ] **Step 2: 写测试**

```ts
// test/skills.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from '../src/cli/skills';

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
```

> ⚠️ 一个容易看岔的地方：`put(root, 'a', doc('name: a\ndescription: d', ''))` 造出来的文件结尾是
> `---\n` —— `parseFrontmatter` 的 `body` 因此是空串 `''`（去掉紧跟结束标记的那一个换行之后什么都没有），
> 正是"正文是空的"那条要测的情形。

- [ ] **Step 3: 跑测试**

Run: `pnpm test test/skills.test.ts`
Expected: PASS —— 10 passed

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 绿

- [ ] **Step 5: 提交**

```bash
git add src/cli/skills.ts test/skills.test.ts
git commit -m "feat(cli): 技能名册的异步发现与解析" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: `tool.call` 不上时间预算（一个真窟窿）

**Files:**
- Modify: `src/contract/next.ts`、`src/core/dispatch.ts`、`test/harness.ts`
- Test: `test/hook-budget.test.ts`

> **这是写计划时逐行对照源码发现的，不在原设计里。** 它不是 P4a 的附加项，是 P4a 能不能用的前提：
>
> `core/dispatch.ts:91` 给**每一个** hook 套了 `withBudget(..., HOOK_BUDGET.ms)`，而 `HOOK_BUDGET.ms = 10_000`。
> 超时的 hook 被 `catch` 住、当"失败"跳过，链一路落到链尾 —— 对 `tool.call` 来说链尾就是
> `coreImpls['tool.call'] = (e) => ({ deny: 'unknown tool: ...' })`。
>
> 于是：**`Bash` 跑一条超过 10 秒的命令，模型拿到的是 `ERROR: unknown tool: Bash`**，
> 而那条命令**还在后台继续跑**（`withBudget` 的注释自己写着这件事）。
> `src/builtins/tools/bash.ts:3` 的 `DEFAULT_TIMEOUT_MS = 120_000` 摆在那儿 —— 这两个数字一直互相矛盾。
> 子代理更是以分钟计，所以 P4a 撞上它不是偶然，是必然。
>
> **顺手修掉它**，并把 `hookBudgetMs` 做成可注入的 —— 否则这条线只能用"等 10 秒"来测，
> 那就等于不测。

- [ ] **Step 1: `contract/next.ts` 加一条 `UNBUDGETED_EVENTS`**

`src/contract/next.ts`，紧跟在 `HOOK_BUDGET` 之后：

```ts
/**
 * 这些事件的 hook **不上时间预算**：它们的时长由被调用的东西自己说了算。
 *
 * `tool.call` 是唯一一个，而它必须在这儿，否则工具从源头就是坏的：Bash 自己的默认超时
 * 是 120 秒（builtins/tools/bash.ts:3），子代理以分钟计 —— 10 秒的预算在这儿不叫"防故障"，
 * 叫"把一个正常的慢工具变成一个假的 unknown tool"：超时之后 dispatch 把它当 hook 失败跳过，
 * 链一路落到 coreImpl 的 `unknown tool: ${tool}` 回给模型，而那个工具**还在后台继续跑**。
 *
 * 工具的时长归工具自己管（`Bash` 有 `timeout_ms`，文件操作本来就有界），
 * 预算这条线留着管那些"本该立刻回答却卡住了"的 hook。
 */
export const UNBUDGETED_EVENTS: readonly string[] = ['tool.call'];
```

- [ ] **Step 2: `core/dispatch.ts` 用它**

import 那一行改成：

```ts
import { HOOK_BUDGET, UNBUDGETED_EVENTS, type Origin, type TraceEntry } from '../contract/next';
```

`DispatcherDeps` 里加一个字段（写在 `signal` 之前）：

```ts
  /**
   * hook 的时间预算（毫秒）。**只为测试存在**：把 10 秒缩成几十毫秒，
   * 才验得了"超时会把这个 hook 摘掉、让下层应答"这条线。生产不传。
   */
  hookBudgetMs?: number;
```

`createDispatcher` 开头（`const warned = new Set<string>();` 之后）加：

```ts
  /** 每个 hook 的时间预算。测试可以缩小它；`UNBUDGETED_EVENTS` 里的事件没有闸。 */
  const budgetFor = (event: string): number =>
    UNBUDGETED_EVENTS.includes(event)
      ? Number.POSITIVE_INFINITY
      : (deps.hookBudgetMs ?? HOOK_BUDGET.ms);
```

`runAt` 里改**两处**，其余（链尾兜底、故障隔离、`next.to` / `next.signal` 那一串）一个字不动。

**第一处**（`runAt` 里 hook 执行的那一段，原先 91-97 行）—— 旧的是：

```ts
      try {
        const returned = await withBudget(
          Promise.resolve(reg.hook(deps.engine(), deepFreeze(e), next)),
          HOOK_BUDGET.ms,
        );
        if (returned === undefined) {
```

换成：

```ts
      try {
        const work = Promise.resolve(reg.hook(deps.engine(), deepFreeze(e), next));
        // 长跑事件不上预算。理由见 contract/next.ts 的 UNBUDGETED_EVENTS ——
        // 对 tool.call 来说，超时不是"摘掉一个坏 hook"，是"把一个正常工具判死"。
        const ms = budgetFor(event);
        const returned = Number.isFinite(ms) ? await withBudget(work, ms) : await work;
        if (returned === undefined) {
```

**第二处**（`makeNext` 里，原先 142-145 行）—— 旧的是：

```ts
      next.budget = {
        ms: HOOK_BUDGET.ms,
        remainingMs: Math.max(0, HOOK_BUDGET.ms - (Date.now() - startedAt)),
      };
```

换成：

```ts
      next.budget = {
        ms: budgetFor(event),
        // 不上预算的事件里它是 Infinity —— 名义值，别拿它做判断（那里本来就没有闸）。
        remainingMs: Math.max(0, budgetFor(event) - (Date.now() - startedAt)),
      };
```

（`budgetFor` 定义在 `createDispatcher` 顶层，`runAt` 与 `makeNext` 都嵌在它里面，闭包里拿得到。
改完之后 `HOOK_BUDGET` 只剩 `budgetFor` 里那一处引用 —— import 不要顺手删掉。）

- [ ] **Step 3: `test/harness.ts` 把预算传下去**

`HarnessOptions` 加一项：

```ts
export type HarnessOptions = {
  coreImpls?: CoreImpls;
  engine?: Partial<EngineInterface>;
  signal?: AbortSignal;
  /** 缩小 hook 时间预算，供 test/hook-budget.test.ts 用。 */
  hookBudgetMs?: number;
};
```

`createDispatcher` 的入参里加：

```ts
    signal: () => options.signal ?? DEFAULT_SIGNAL,
    ...(options.hookBudgetMs === undefined ? {} : { hookBudgetMs: options.hookBudgetMs }),
```

- [ ] **Step 4: 写测试**

```ts
// test/hook-budget.test.ts
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { createHarness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 20ms 的预算 —— 于是 80ms 一定超时，而测试不用等 10 秒。 */
const BUDGET = 20;
const SLOW = 80;

describe('hook 时间预算', () => {
  it('tool.call 不上预算：慢工具不会被判成 hook 失败', async () => {
    const h = createHarness({ hookBudgetMs: BUDGET });
    h.on('builtin', 'slow-tool', 'tool.call', async () => {
      await sleep(SLOW);
      return { value: '跑完了' };
    });

    const result = await h.dispatch(
      'tool.call',
      { tool: 'Bash', input: {}, toolUseId: 'u1' },
      CORE_ORIGIN,
    );

    expect(result).toEqual({ value: '跑完了' });
    // 关键的一条：不能有"失败已跳过"。旧行为下这里是假的 unknown tool，
    // 而命令其实还在后台跑 —— 这正是要修掉的病。
    expect(h.warnings).toEqual([]);
  });

  it('对照：别的事件照旧上预算，超时的 hook 被摘掉、由下层应答', async () => {
    const h = createHarness({ hookBudgetMs: BUDGET });
    // 慢的那个钉在 `user`（比 `builtin` 靠外）—— 用**座位**而不是注册顺序来定内外，
    // 这样这条用例不依赖"同 tier 内先注册者在外层"那个细节。
    h.on('user', 'slow-describer', 'tool.describe', async () => {
      await sleep(SLOW);
      return { description: '来自慢的那个', inputSchema: {} };
    });
    h.on('builtin', 'fast-describer', 'tool.describe', () => ({
      description: '来自下层',
      inputSchema: {},
    }));

    const result = await h.dispatch('tool.describe', { tool: 'Read' }, CORE_ORIGIN);

    expect(result).toEqual({ description: '来自下层', inputSchema: {} });
    expect(h.warnings.some((line) => line.includes('失败已跳过'))).toBe(true);
  });

  it('next.budget.ms：tool.call 是不上预算的名义值，普通事件拿到 10 秒', async () => {
    // 这个不对称是这一任务的全部意义 —— 只测"慢工具没被判死"是行为层，
    // 这一条把它钉在 `next.budget` 这个可观测面上（否则将来有人"顺手统一"回去没人拦得住）。
    const h = createHarness();
    let onToolCall: number | undefined;
    let onDescribe: number | undefined;
    h.on('builtin', 'probe-call', 'tool.call', async (_$, e, next) => {
      onToolCall = next.budget.ms;
      return next(e);
    });
    h.on('builtin', 'probe-desc', 'tool.describe', async (_$, e, next) => {
      onDescribe = next.budget.ms;
      return next(e);
    });

    await h.dispatch('tool.call', { tool: 'Bash', input: {}, toolUseId: 'u1' }, CORE_ORIGIN);
    await h.dispatch('tool.describe', { tool: 'Read' }, CORE_ORIGIN);

    expect(onToolCall).toBe(Number.POSITIVE_INFINITY);
    expect(onDescribe).toBe(10_000);
  });
});
```

- [ ] **Step 5: 跑测试，确认它通过**

Run: `pnpm test test/hook-budget.test.ts`
Expected: PASS —— 3 passed

> 第一条用例如果拿到的不是 `{ value: '跑完了' }` 而是 `{ deny: 'unknown tool: ...' }`，
> 说明 `budgetFor` 那一处没接上 `UNBUDGETED_EVENTS`（Step 2 漏了）。改实现，别去改断言。
> 第二条用例如果拿到的不是"来自下层"，看 `budgetFor` 是不是把 `tool.describe` 也划进了不上预算的那一档。
> 第三条靠 `h.on(...)` 的 hook 返回 `next(e)` 把链走完 —— 不返回的话链就断在它那儿，
> 第二个 dispatch 的 `onDescribe` 会是 `undefined`（`undefined !== 10_000`，红）。

- [ ] **Step 6: 反向验证**

把 `UNBUDGETED_EVENTS` 改回 `[]`，跑 `pnpm test test/hook-budget.test.ts`：
Expected: **第一条红**（结果是 `{ deny: 'unknown tool: Bash' }` 且有一条 `失败已跳过` 警告）。看到红之后**改回来**。

- [ ] **Step 7: 跑全套**

Run: `pnpm test`
Expected: 全绿。**但会先红一条，那是计划漏掉的牵连，改它。**

> ⚠️ **`test/dispatch.test.ts:217` 那条 `next.signal / origin / budget / is 都挂上了` 会红。**
> 它用 `CALL`（= `tool.call`）做载体，断言 `ms: 10_000` —— 而 `tool.call` 从这一任务起不上预算，
> `next.budget.ms` 因此是 `Infinity`。
>
> 这条断言是**对的**，只是它的载体该换：它要钉的是"`budget` 这个访问器挂上了、值是对的"，
> 与"哪个事件"无关。所以：
>
> 1. 把那一处的 `tool.call` 载体换成**有预算**的事件（`tool.describe` 最省事：它有内核算实现，
>    `args` 是 `{ tool: 'Read' }`），`ms: 10_000` 原样留着 —— 它继续钉"普通事件拿到 10 秒"。
> 2. 顺带在 `test/hook-budget.test.ts` 里补一条：`tool.call` 的 `next.budget.ms` 是 `Infinity`。
>    这个不对称是这一任务的**全部意义**，值得有断言钉住，而不是只有"慢工具没被判死"这条行为断言。
>
> 这与 Task 2 里 `agent.spawn` 转正时捅出 `dispatch.test.ts` 是同一回事：
> **改一个共享常量的语义之前，先 grep 谁在断言它的值。** 本次已 grep 过：全套里钉 `budget.ms`
> 的只有 `test/dispatch.test.ts:230,243` 这一处（其余 `10_000` 是 `timeoutMs`，不相干）。

- [ ] **Step 8: 提交**

```bash
git add src/contract/next.ts src/core/dispatch.ts test/harness.ts test/hook-budget.test.ts
git commit -m "fix(core): tool.call 不上 hook 时间预算 —— 慢工具不再被判成 unknown tool" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: `subagents` 插件 + 确认器认下 `Task`/`Skill`

**Files:**
- Create: `src/cli/subagents.ts`
- Modify: `src/builtins/confirm.ts`
- Test: `test/subagent.test.ts`

> 这是本轮最大的一道题：一个源文件 + 一行安全相关的改动 + C2 的全部验收。两半（`Task` 与 `Skill`）
> 写在一个文件里，因为有一样东西是共用的 —— `agent.offer` 一次报两张名册。

- [ ] **Step 1: `confirm.ts` 先开一条借道的口子**

**这一步必须在前**：`Task` / `Skill` 注册上来的第一件事就是被 `confirm` 当"未知工具"拒掉。

`src/builtins/confirm.ts`，三个集合那一段改成：

```ts
/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 不碰磁盘、不执行命令，但也不是"读一个文件"的那一类：借道放行，不问。
 *
 * - `Skill`：把一段文本加载进上下文 —— 与 `Read` 同类。
 * - `Task`：派一个子代理。**放过它绝不等于免确认**：子代理内部每一次工具调用都要
 *   再走一遍这条链（`core/loop.ts` 是同一个 `runTurn`），它要写文件照样弹 y/N。
 *   在 `Task` 上再问一次只是让用户多按一次 y，还会误导出"我批准了 Task
 *   就是批准了它接下来做的一切"。
 *
 * ⚠️ 这两个名字**必须**在这儿，否则它们一出生就是死的：下面那条"不认识的工具 → deny"
 * 会把它们当场拒掉。这是 P3 的 `todo` 插件踩过的同一个坑 ——
 * 它的注释（`plugins/todo/main.mjs`）说得很清楚：插件工具要么自己在 `builtin` 之外
 * 答一次 `tool.check`，要么确认器得认识它。`Task`/`Skill` 是第一方工具，走第二条。
 */
const PASS_THROUGH_TOOLS = new Set(['Skill', 'Task']);

/** 会改动磁盘或执行命令的工具，需要确认。 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);
```

`register` 里那条判定加一行：

```ts
      if (READ_ONLY_TOOLS.has(tool)) return { decision: 'allow' };

      // 借道放行：它们自己不碰磁盘，但经手的事情会在别处再走一遍这条链。
      if (PASS_THROUGH_TOOLS.has(tool)) return { decision: 'allow' };

      if (!MUTATING_TOOLS.has(tool)) {
```

- [ ] **Step 2: 写 `src/cli/subagents.ts`**

```ts
// src/cli/subagents.ts
import type { AgentSpec, SkillSpec } from '../contract/agent';
import type { EngineInterface } from '../contract/engine';
import type { Plugin } from '../contract/plugin';

export type SubagentsDeps = {
  /** **已解析**的 agent 名册。发现已在 main.ts 里做完 —— 装配是同步的（设计 §4.1）。 */
  readonly agents: readonly AgentSpec[];
  /** **已解析**的技能名册。 */
  readonly skills: readonly SkillSpec[];
  /** 会话那一份**基础** system prompt（不是拼完那份）。agent 正文为空时回落到它。 */
  readonly baseSystemPrompt: string;
};

/**
 * 白名单能表达"允许不允许"，表达不了"允许几次"。一次失控的递归要花真钱 ——
 * 这不是策略，是保险丝（设计 §8）。顶层 Task 的 depth = 1。
 */
const MAX_DEPTH = 3;

/** 子代理没正常结束的三种 stopReason。其余（end_turn / max_tokens / 端点自定义的）都当正常。 */
const ABNORMAL_STOP = new Set(['error', 'interrupted', 'max_hops']);

const TASK_DESCRIPTION =
  '派一个子代理去独立完成一件事。它**看不到**你和我现在的对话，只能看到 prompt 里写的内容 —— ' +
  '把任务说清楚：要它做什么、看哪些文件、回报什么。可用子代理见系统提示词里的清单，' +
  'subagent_type 必须与那里写的名字完全一致。';

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    subagent_type: { type: 'string', description: '名册里的 agent 名字，精确匹配' },
    prompt: { type: 'string', description: '交给子代理的全部任务说明' },
    model: { type: 'string', description: '可选：覆盖这个 agent 用的模型' },
  },
  required: ['subagent_type', 'prompt'],
};

const SKILL_DESCRIPTION =
  '按名字把一个技能的知识正文加载进当前上下文。可用技能见系统提示词里的清单' +
  '（不在这里重复第二份）。正文里提到的 references/ 等资源自己用 Read 去读 —— ' +
  '结果里会给出这个技能的目录。';

const SKILL_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', description: '技能名，精确匹配' } },
  required: ['name'],
};

/**
 * 组合面的第一方插件：应答 `agent.offer`、注册 `Task` 与 `Skill` 两个工具。
 *
 * 为什么住 `cli/` 而不是 `builtins/`：它要知道名册、要往屏幕上打通知、要维护一个嵌套
 * 深度栈 —— 这三样都是 REPL 侧的东西。`builtins/` 放的是"与 surface 无关的通用工具"。
 */
export function createSubagentsPlugin(deps: SubagentsDeps): Plugin {
  /**
   * 只用来在错误消息里说清是"谁派的谁"。
   *
   * **闭包里的栈，不是模块级变量**：模块级的会跨测试泄漏（设计 §8）。
   * 又因为工具是串行执行的（`core/loop.ts`），这个栈不会交错，不需要栈帧栈那类东西。
   */
  const stack: string[] = [];

  return {
    name: 'subagents',
    // `uses` 的腔调照抄其余插件：事件写全名，**名词写名字本身**（`fs` / `ui` 那样），
    // 不写点号路径。所以是 `agent` / `skill`，不是 `agent.spawn` / `skill.load`。
    uses: ['agent.offer', 'tool.call', 'tool.describe', 'ui', 'agent.spawn', 'agent', 'skill'],
    register(on) {
      on('agent.offer', () => ({
        agents: deps.agents.map((spec) => ({
          name: spec.name,
          description: spec.description,
          // 印的是**文件里写的**那份白名单，不是解析后的：省略 = 继承全部，
          // 真解析出来会随会话此刻的工具表变，印一份会变的清单没有意义（设计 §7）。
          ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        })),
        skills: deps.skills.map((spec) => ({ name: spec.name, description: spec.description })),
      }));

      // ── Task ────────────────────────────────────────────────────────────
      on('tool.describe', { tool: 'Task' }, () => ({
        description: TASK_DESCRIPTION,
        inputSchema: TASK_SCHEMA,
      }));

      on('tool.call', { tool: 'Task' }, async ($, e) => {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        const callModel =
          typeof input.model === 'string' && input.model.trim() !== '' ? input.model : undefined;

        // 派一个没任务的子代理没有意义（设计 §11）。
        if (prompt.trim() === '') {
          return { deny: 'Task 的 prompt 是空的 —— 子代理看不到别的上下文，没有任务它无从下手' };
        }

        // **精确匹配**，不做前缀、不做模糊（设计 §7.1）：对不上就把可选名字列出来。
        const spec = deps.agents.find((candidate) => candidate.name === type);
        if (spec === undefined) {
          return {
            deny:
              deps.agents.length === 0
                ? `没有可派的子代理（subagent_type=${type}）：这个会话一个 agent 都没装`
                : `没有叫 ${type} 的子代理。可选的：${deps.agents.map((a) => a.name).join(', ')}`,
          };
        }

        if (stack.length >= MAX_DEPTH) {
          return {
            deny: `嵌套太深了（${[...stack, spec.name].join(' → ')}，上限 ${MAX_DEPTH} 层）`,
          };
        }

        // 模型分层的解析顺序：调用参数 → spec 自带的 → 父级（undefined = 适配器配置里那个）。
        const model = callModel ?? spec.model;
        // 正文为空 ⇒ 回落到会话的基础提示。**回落判断在这儿**，内核不知道这回事（设计 §2.3）。
        const systemPrompt =
          spec.prompt.trim() === ''
            ? `${deps.baseSystemPrompt}\n\n你是子代理「${spec.name}」：${spec.description}`
            : spec.prompt;

        stack.push(spec.name);
        $.ui.notice(`派子代理 ${spec.name}（第 ${stack.length} 层）：${firstLine(prompt)}`);
        try {
          const result = await $.agent.spawn({
            name: spec.name,
            systemPrompt,
            task: prompt,
            tools: resolveTools(spec, $),
            ...(model === undefined ? {} : { model }),
            ...(spec.maxTurns === undefined ? {} : { maxHops: spec.maxTurns }),
          });

          $.ui.notice(`子代理 ${spec.name} 回来了（${result.stopReason}）`);

          // 子代理失败**不是**让父级整个 turn 炸掉，而是变成本次 tool.call 的错误结果
          // （设计 §5.3）：父级要知道"那个子代理失败了"并继续，而不是自己一起倒下。
          // `ERROR:` 前缀是 loop.ts 判 isError 的依据。
          if (ABNORMAL_STOP.has(result.stopReason)) {
            return {
              value: `ERROR: 子代理 ${spec.name} 未正常结束（${result.stopReason}）\n\n${result.text}`,
            };
          }
          return { value: result.text };
        } finally {
          stack.pop();
        }
      });

      // ── Skill ───────────────────────────────────────────────────────────
      on('tool.describe', { tool: 'Skill' }, () => ({
        description: SKILL_DESCRIPTION,
        inputSchema: SKILL_SCHEMA,
      }));

      on('tool.call', { tool: 'Skill' }, async ($, e) => {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name : '';

        // 点名不存在的技能 = deny + 列出可用名：不静默失败、不猜、不做前缀匹配（设计 §10.2）。
        const spec = deps.skills.find((candidate) => candidate.name === name);
        if (spec === undefined) {
          return {
            deny:
              deps.skills.length === 0
                ? `没有可加载的技能（name=${name}）：这个会话一个技能都没装`
                : `没有叫 ${name} 的技能。可选的：${deps.skills.map((s) => s.name).join(', ')}`,
          };
        }

        // 过一遍 `skill.prompt` 这道**变换缝**（链尾无人应答 = 原文通过，设计 §10.3）。
        const loaded = await $.skill.load({ name: spec.name, text: spec.body });

        // 第三层（references/ 等）我们一行代码都不写：把目录交给模型，它用 Read 自己取
        // （设计 §10.1）。这就是"第三层是白送的"落到代码上的全部内容。
        return { value: `${loaded.text}\n\n（这个技能的目录：${spec.dir}）` };
      });
    },
  };
}

/**
 * 白名单解析就是一行减法，归插件 —— 内核只收解析后的结果（设计 §6.1）：
 *   1. 省略 `tools` ⇒ 继承父级全部工具
 *   2. 给出 `tools` ⇒ 白名单，清单外的调不通
 *   3. `disallowedTools` 在白名单之上再扣一层
 *
 * "继承父级全部"听着宽，但**"全权"指的是工具面、不是免确认**：一个省略 tools 的子代理
 * 去写文件，照样要走同一条 `tool.check` 链（confirm 在 builtin、个人规则在 user、
 * 守门器在 prepend，一个都不少）。C2 有一条出口标准专门钉它。
 */
function resolveTools(spec: AgentSpec, $: EngineInterface): readonly string[] {
  const inherited = spec.tools ?? $.tool.list();
  const denied = spec.disallowedTools;
  if (denied === undefined) return [...inherited];
  return inherited.filter((tool) => !denied.includes(tool));
}

/** 通知里只放任务的第一行：它是一句进度提示，不是把 prompt 抄一遍。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
```

- [ ] **Step 3: 写 C2 的验收测试**

```ts
// test/subagent.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpec } from '../src/contract/agent';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { confirmPlugin } from '../src/builtins/confirm';
import { coreTools } from '../src/builtins/tools';
import { createEngine } from '../src/core/create';
import { runTurn, type LoopContext } from '../src/core/loop';
import { createSubagentsPlugin } from '../src/cli/subagents';
import { streamPlugin } from '../src/cli/stream';
import type { Renderer } from '../src/cli/render';

let root = '';
let notesPath = '';

const FILE_TEXT = '这是子代理读到的文件内容。';

const agentSpec = (spec: Partial<AgentSpec> & { name: string }): AgentSpec => ({
  description: `${spec.name} 的描述`,
  prompt: `你是 ${spec.name}。`,
  ...spec,
});

const toolUse = (id: string, name: string, input: unknown = {}): StreamEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });
const say = (text: string): readonly StreamEvent[] => [
  { type: 'text', text },
  done('end_turn'),
];
const callTask = (type: string, prompt = '去干活'): readonly StreamEvent[] => [
  toolUse('u_task', 'Task', { subagent_type: type, prompt }),
  done('tool_use'),
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-subagent-'));
  notesPath = join(root, 'notes.md');
  await writeFile(notesPath, FILE_TEXT);
});

type MountOptions = {
  agents: readonly AgentSpec[];
  script?: readonly (readonly StreamEvent[])[];
  /**
   * 第 n 次请求（从 1 数）该流什么。比 `script` 多拿得到 `req` ——
   * "把上一轮的工具结果原样复述出来"这种事，只有拿着 req 才写得出来（见 C2-5 第二条）。
   */
  response?: (req: StreamRequest, n: number) => readonly StreamEvent[];
  answer?: string;
  /** 在流之前跑：抛出去就是从 provider 里抛（测"子代理的 provider 炸了"）。 */
  before?: (req: StreamRequest, n: number) => void;
};

async function mount(options: MountOptions) {
  const requests: StreamRequest[] = [];
  const describes: { tool: string; atRequest: number }[] = [];
  const toolCalls: string[] = [];
  const spawns: string[] = [];
  const deltas: string[] = [];
  const notices: string[] = [];
  const asks: string[] = [];

  const provider: ModelProvider = {
    name: 'test',
    async *stream(req) {
      requests.push(req);
      const n = requests.length;
      options.before?.(req, n);
      const events =
        options.response?.(req, n) ??
        options.script?.[n - 1] ??
        [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  /**
   * 观察者：**坐在 prepend** 才有用。
   *
   * 工具自己的 `tool.describe` / `tool.call` 都在 `builtin`，它们**直接应答、不调 next**，
   * 坐在它们里面的话一次都轮不到我。坐在最外层，看一笔、再交给下面。
   * 而且**必须 `return next(e)`** —— 什么都不返回会被 dispatch 当成 hook 失败
   * （core/dispatch.ts:95），链虽然照常往下走，但会多出"失败已跳过"的假警告。
   */
  const observer: Plugin = {
    name: 'test-observer',
    uses: ['tool.describe', 'tool.call', 'agent.spawn'],
    register(on) {
      on('tool.describe', (_$, e, next) => {
        describes.push({ tool: String(e.tool), atRequest: requests.length });
        return next(e);
      });
      on('tool.call', (_$, e, next) => {
        toolCalls.push(String(e.tool));
        return next(e);
      });
      on('agent.spawn', (_$, e, next) => {
        spawns.push(String(e.name));
        return next(e);
      });
    },
  };

  // streamPlugin 只用到 render.delta —— 一个只记 delta 的壳就够。
  const fakeRender = { delta: (text: string) => deltas.push(text) } as unknown as Renderer;

  const engine = await createEngine({
    plugins: [
      streamPlugin(fakeRender),
      confirmPlugin,
      createSubagentsPlugin({ agents: options.agents, skills: [], baseSystemPrompt: '基础提示' }),
      ...coreTools,
      observer,
    ],
    seating: { 'test-observer': 'prepend' },
    provider,
    ui: {
      print: () => {},
      notice: (line) => notices.push(line),
      ask: async (question) => {
        asks.push(question);
        return options.answer ?? 'y';
      },
    },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });

  /** 跑一个**父级** turn（走真的 loop，于是工具的返回值都留在 messages 里）。 */
  async function runParent(): Promise<{ messages: Message[]; stopReason: string }> {
    const messages: Message[] = [{ role: 'user', content: '干活' }];
    const ctx: LoopContext = {
      $: engine.$,
      provider,
      signal: new AbortController().signal,
      dispatch: engine.dispatch,
      systemPrompt: '父级提示',
      turnIndex: 0,
    };
    const stopReason = await runTurn(ctx, messages);
    return { messages, stopReason };
  }

  return { ...engine, requests, describes, toolCalls, spawns, deltas, notices, asks, runParent };
}

/**
 * 最后一条**工具结果**消息里的第 n 个内容。
 *
 * ⚠️ **别用 `messages.at(-1)`**：loop 在 `break` 之前还会 push 一条 assistant 消息
 * （没有文本时 `content` 是空数组，见 `core/loop.ts:130-139`），所以 turn 跑完之后
 * 最后一条**往往不是**工具消息。这里要的是"上一轮工具拿回了什么"，得往回找。
 * （这条是 T3 执行时实测出来的，原计划的写法三处用例全挂。）
 */
function resultAt(messages: readonly Message[], index = 0): string {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  if (last?.role !== 'tool') throw new Error('这一轮没有任何工具结果消息');
  return last.results[index]?.content ?? '';
}

describe('C2-5：白名单的两个落点', () => {
  it('看见的恰好是三个 —— describe 也只派发了三次', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read', 'Glob', 'Grep'] })],
      script: [callTask('explorer'), say('父级收工')],
    });
    await m.runParent();

    // 父级自己那一轮的 describe 发生在第一次请求**之前**（atRequest === 0）；
    // 子代理那一轮的 describe 发生在父级第一次请求**之后**（atRequest === 1）。
    const inner = m.describes.filter((d) => d.atRequest === 1).map((d) => d.tool).sort();
    expect(inner).toEqual(['Glob', 'Grep', 'Read']);
    // 模型眼里也是三个。
    expect(m.requests[1]?.tools.map((t) => t.name).sort()).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('点名清单外的工具 → 拒，理由里把可用的列了出来', async () => {
    const target = join(root, '不该出现.txt');
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read', 'Glob', 'Grep'] })],
      response: (req, n) => {
        if (n === 1) return callTask('explorer', '试着写个文件');
        if (n === 2) {
          // 子代理第一轮：同时点名一个允许的与一个越界的。
          return [
            toolUse('u1', 'Read', { file_path: notesPath }),
            toolUse('u2', 'Write', { file_path: target, content: 'x' }),
            done('tool_use'),
          ];
        }
        if (n === 3) {
          // 子代理第二轮：把上一轮的工具结果**原样复述出来**。
          // 这是穿透隔离的唯一一个窗口，而且是**子代理自己选的** —— 隔离没被破坏，
          // 父级能看见只是因为子代理把看到的东西报了上来。
          const last = req.messages.at(-1);
          const text =
            last?.role === 'tool' ? last.results.map((r) => r.content).join('\n---\n') : '';
          return say(text);
        }
        return [{ type: 'done', stopReason: 'end_turn' }];
      },
    });
    const { messages } = await m.runParent();

    const content = resultAt(messages);
    expect(content).toContain('不在本次的工具清单里');
    expect(content).toContain('可用：Read, Glob, Grep');
    // 它压根没走到 tool.call —— 落点二在权限链**之前**。
    expect(m.toolCalls).not.toContain('Write');
    // 而允许的那个真的跑了：文件内容原样在复述里。
    expect(content).toContain(FILE_TEXT);
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});
```

其余几条接在这里：

```ts
describe('C2-7：隔离', () => {
  it('父级只拿到子代理最后那句话，拿不到它读过的文件内容', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read'] })],
      script: [
        callTask('explorer', '读一下 notes.md'),
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('文件我读完了，结论是 X。'),
        say('父级收工'),
      ],
    });
    const { messages } = await m.runParent();

    const content = resultAt(messages);
    expect(content).toBe('文件我读完了，结论是 X。');
    // 中间的工具结果留在子代理自己那本账里，随它一起丢掉 —— 这就是"隔离"的全部含义。
    expect(content).not.toContain(FILE_TEXT);
  });
});

describe('C2-8：静音', () => {
  it('子代理的话不写屏幕，但它调的工具照常派发', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'explorer', tools: ['Read'] })],
      script: [
        callTask('explorer'),
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('子代理的私语'),
        say('父级的收工语'),
      ],
    });
    await m.runParent();

    const screen = m.deltas.join('');
    expect(screen).toContain('父级的收工语');
    // 静音静的是**屏幕**。子代理的文本一个字节都没到渲染器上。
    expect(screen).not.toContain('子代理的私语');
    // 但事实照发：它调的工具真的跑了（/diff 的账不能丢）。
    expect(m.toolCalls).toContain('Read');
    expect(m.toolCalls).toContain('Task');
  });
});

describe('C2-9：tools: [] 断掉递归', () => {
  it('空白名单的 agent 连 Task 都看不见', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'lonely', tools: [] })],
      script: [callTask('lonely'), say('父级收工')],
    });
    await m.runParent();
    expect(m.requests[1]?.tools).toEqual([]);
  });
});

describe('C2-10：深度保险丝', () => {
  it('三层派得下去，第四层被拒', async () => {
    const m = await mount({
      // 省略 tools = 继承全部，于是它有 Task —— 深度是白名单的推论，保险丝只兜底次数。
      agents: [agentSpec({ name: 'recursor' })],
      script: [
        callTask('recursor'),
        callTask('recursor'),
        callTask('recursor'),
        callTask('recursor'), // 第 4 次：stack.length === 3，被拒
        say('够深了'),
        say('回'),
        say('回'),
        say('收工'),
      ],
    });
    const { stopReason } = await m.runParent();

    expect(m.spawns).toEqual(['recursor', 'recursor', 'recursor']);
    expect(m.notices.filter((line) => line.startsWith('派子代理'))).toHaveLength(3);
    // 父级没有被这件事绊倒。
    expect(stopReason).toBe('end_turn');
  });
});
```

```ts
describe('C2-11：全权不等于免确认', () => {
  it('省略 tools 的子代理写文件，confirm 照样弹 y/N', async () => {
    const target = join(root, 'out.txt');
    const m = await mount({
      agents: [agentSpec({ name: 'writer' })],
      answer: 'n',
      script: [
        callTask('writer', '写个文件'),
        [toolUse('u1', 'Write', { file_path: target, content: 'hi' }), done('tool_use')],
        say('结束'),
        say('父级收工'),
      ],
    });
    await m.runParent();

    // "全权"指的是工具面，不是免确认：Write 走的是同一条 tool.check 链。
    expect(m.asks).toHaveLength(1);
    expect(m.asks[0]).toContain('Write');
    // 用户在那个提示上按了 n → 文件不该存在。
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});

describe('C2-12：模型分层', () => {
  it('spec 的 model 送到 provider；没写就是 undefined（= 父级那个）', async () => {
    const m = await mount({
      // `model: inherit` 在 agents.ts 里已经变成"字段不存在"（Task 7 钉着那一步），
      // 所以这里那一条直接省略字段。
      agents: [agentSpec({ name: 'smart', model: 'haiku' }), agentSpec({ name: 'plain' })],
      script: [
        callTask('smart'),
        say('子'),
        say('父'),
        callTask('plain'),
        say('子'),
        say('父'),
      ],
    });
    await m.runParent();
    await m.runParent();

    expect(m.requests[1]?.model).toBe('haiku');
    expect(m.requests[4]?.model).toBeUndefined();
    // 父级自己那两轮也都不是 haiku。
    expect(m.requests[0]?.model).toBeUndefined();
  });
});

describe('C2-13：子代理失败不炸父级', () => {
  it('撞 max_hops → 变成本次 tool.call 的错误结果，父级继续', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'stuck', maxTurns: 1 })],
      script: [
        callTask('stuck'),
        // 子代理唯一那一跳就要工具 —— 跳用完就撞上限。
        [toolUse('u1', 'Read', { file_path: notesPath }), done('tool_use')],
        say('父级继续了'),
      ],
    });
    const { messages, stopReason } = await m.runParent();

    expect(resultAt(messages)).toContain('未正常结束（max_hops）');
    expect(stopReason).toBe('end_turn');
  });

  it('provider 抛异常 → 同样变成错误结果', async () => {
    const m = await mount({
      agents: [agentSpec({ name: 'boom' })],
      // 两次都抛：loop 会退避重试一次（`loop.ts` 的那条），所以 n=2 与 n=3 都得炸。
      // 这条用例会实打实花掉那 1 秒 —— 值的：它是 'error' 这一支唯一的端到端证明。
      before: (_req, n) => {
        if (n === 2 || n === 3) throw new Error('provider 炸了');
      },
      script: [callTask('boom'), say('父级继续了')],
    });
    const { messages, stopReason } = await m.runParent();

    expect(resultAt(messages)).toContain('未正常结束（error）');
    expect(stopReason).toBe('end_turn');
  });
});
```

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm test test/subagent.test.ts`
Expected: PASS —— 10 passed（约 1 秒，那第二条 `C2-13` 的退避重试）

- [ ] **Step 5: 反向验证 —— 两条断言各自承重**

这一条是本仓库的规矩（设计 §13 C2 第 6 条）：**把实现改坏，确认断言真的会红；不红就是那条断言是摆设。**

1. 把 `core/loop.ts` 的 `describeTools` 里那段白名单过滤删掉（只留 `hidden` 那条）→
   `pnpm test test/subagent.test.ts` → **`C2-5` 的第一条必须红**（`inner` 变成五六个）。改回来。
2. 把 `core/loop.ts` 的 `runOneTool` 里那段白名单判断删掉 →
   `pnpm test test/subagent.test.ts` → **`C2-5` 的第二条必须红**。改回来。
3. 把 `confirm.ts` 的 `PASS_THROUGH_TOOLS.has(tool)` 那一行删掉 →
   `pnpm test test/subagent.test.ts` → 全部用例必须红（`Task` 一出生就被拒）。改回来。

三条都红了才算数。**任一条没红，说明那一处是摆设，修的是断言本身。**

- [ ] **Step 6: 跑全套 + 类型**

```bash
pnpm typecheck && pnpm test
```

Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/cli/subagents.ts src/builtins/confirm.ts test/subagent.test.ts
git commit -m "feat(cli): subagents 插件 —— Task 与 Skill 两个工具，确认器认下这两个名字" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 11: 接线（`offer` 渲染 + `cliPlugins` + `main.ts`）

**Files:**
- Create: `src/cli/offer.ts`
- Modify: `src/cli/plugins.ts`、`src/cli/main.ts`、`test/plugin-wiring.test.ts`
- Test: `test/offer.test.ts`、`test/skill-tool.test.ts`

- [ ] **Step 1: 写 `src/cli/offer.ts`**

> 为什么不把它直接写在 `main.ts` 里：`main.ts` 一 import 就会跑起来，那段拼装只能靠起子进程
> （`test/cli.test.ts` 那套）来测，而它是一段纯文本拼接 —— 不值得。抽成一个纯函数，一条单测钉住格式。
> 这是与原设计 §12 文件表的一处偏差，记进执行记录。

```ts
// src/cli/offer.ts
import type { Result } from '../contract/events';

/**
 * 把 `agent.offer` 的答复渲染成 system prompt 里的那一节（设计 §7）。
 *
 * **模型看到的是一行 `description`，不是文件** —— 与参考实现一致。`tools` 一并印出来是
 * **我们多加的**：既然白名单是承重的东西，让用户与模型都看得见比藏起来好。
 * 印的是**文件里写的那份**（省略 = 继承全部，那时什么都不印）。
 *
 * 两节都空时返回 `''` —— 拼接方靠这个把整节省掉，别给空白加标题。
 */
export function renderOffer(offer: Result<'agent.offer'>): string {
  const sections: string[] = [];

  if (offer.agents.length > 0) {
    sections.push(
      [
        '可用子代理（用 Task 工具派发，subagent_type 填名字）：',
        ...offer.agents.map((agent) =>
          agent.tools === undefined
            ? `- ${agent.name}: ${agent.description}`
            : `- ${agent.name}: ${agent.description}（tools: ${agent.tools.join(', ')}）`,
        ),
      ].join('\n'),
    );
  }

  if (offer.skills.length > 0) {
    sections.push(
      [
        '可用技能（用 Skill 工具按名加载）：',
        ...offer.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 2: 写 `test/offer.test.ts`**

```ts
// test/offer.test.ts
import { describe, expect, it } from 'vitest';
import { renderOffer } from '../src/cli/offer';

const AGENT = { name: 'explorer', description: '深入探索代码库', tools: ['Read', 'Grep'] as const };
const SKILL = { name: 'design-notes', description: '本项目的设计口径' };

describe('renderOffer', () => {
  it('两节都在，格式是给模型看的那种直白清单', () => {
    const text = renderOffer({ agents: [AGENT], skills: [SKILL] });
    expect(text).toBe(
      [
        '可用子代理（用 Task 工具派发，subagent_type 填名字）：',
        '- explorer: 深入探索代码库（tools: Read, Grep）',
        '',
        '可用技能（用 Skill 工具按名加载）：',
        '- design-notes: 本项目的设计口径',
      ].join('\n'),
    );
  });

  it('省略 tools 的 agent 不印 tools 那一截', () => {
    const text = renderOffer({ agents: [{ name: 'plain', description: 'd' }], skills: [] });
    expect(text).toContain('- plain: d');
    expect(text).not.toContain('tools:');
  });

  it('只有一边时不打另一边的标题', () => {
    const text = renderOffer({ agents: [AGENT], skills: [] });
    expect(text).toContain('可用子代理');
    expect(text).not.toContain('可用技能');
  });

  it('两边都空 → 空串（别给空白加标题）', () => {
    expect(renderOffer({ agents: [], skills: [] })).toBe('');
  });
});
```

- [ ] **Step 3: `plugins.ts` 装 subagents**

`CliPluginDeps` 加三项：

```ts
export type CliPluginDeps = {
  readonly render: Renderer;
  readonly changes: SessionChanges;
  readonly messages: Message[];
  readonly root: string;
  readonly palette: Palette;
  readonly policy: ResolvedPolicy;
  readonly home: string;
  /** **已解析**的 agent 名册。发现是异步的、在 main.ts 里做完（设计 §4.1）。 */
  readonly agents: readonly AgentSpec[];
  /** **已解析**的技能名册。 */
  readonly skills: readonly SkillSpec[];
  /**
   * 会话那一份**基础** system prompt（`main.ts` 的 `SYSTEM_PROMPT` 常量，不是拼完那份）。
   * agent 正文为空时回落到它。给拼完的那份会递归 —— 拼完的那份里已经含着这儿的清单。
   */
  readonly baseSystemPrompt: string;
  readonly discovered?: readonly Plugin[];
  readonly pluginDeny?: readonly PluginDenyRule[];
};
```

import 加：

```ts
import type { AgentSpec, SkillSpec } from '../contract/agent';
import { createSubagentsPlugin } from './subagents';
```

`firstParty` 里，紧跟 `...coreTools` 之后加：

```ts
    ...coreTools,
    // 组合面：应答 agent.offer、注册 Task 与 Skill。放在工具这一串里，
    // 名字自动进下面的第一方名单（`names`），于是 deny 名单点它也没用。
    createSubagentsPlugin({
      agents: deps.agents,
      skills: deps.skills,
      baseSystemPrompt: deps.baseSystemPrompt,
    }),
    confirmPlugin,
```

- [ ] **Step 4: `main.ts` 三处**

import 加三行：

```ts
import { discoverAgents } from './agents';
import { discoverSkills } from './skills';
import { renderOffer } from './offer';
```

在 `installPlugins(...)` 之后、`createProvider` 之前插入：

```ts
  // ── 名册 ──
  // 发现是异步的、装配是同步的（`cliPlugins` 是同步函数），所以发现放在这儿：
  // 结果是两张**已经解析好**的名册，以参数进 `cliPlugins`（设计 §4.1）。
  // 只有判为 `loaded` 的插件贡献名册 —— 被 deny 的、项目级没 enable 的、清单坏掉的，
  // 它们的 agent 也不该出现。
  const warnLine = (line: string): void => process.stderr.write(`${line}\n`);
  const pluginDirs = found.loaded.map((plugin) => ({ name: plugin.name, dir: plugin.dir }));
  const agents = await discoverAgents({ root, home, plugins: pluginDirs, warn: warnLine });
  const skills = await discoverSkills({ root, home, plugins: pluginDirs, warn: warnLine });
```

`cliPlugins` 的入参加三项：

```ts
  const bundle = cliPlugins({
    render,
    changes,
    messages,
    root,
    palette,
    policy,
    home,
    agents,
    skills,
    // 基础那份，不是拼完那份 —— 拼完那份里含着下面这节清单（见 offer.ts 的注释）。
    baseSystemPrompt: SYSTEM_PROMPT,
    discovered: thirdParty,
    pluginDeny: policy.plugins.deny,
  });
```

system prompt 的拼装（原先那两行）：

```ts
  const instructions = await loadInstructions(root, home);
  // 能派什么、能加载什么，报给模型（设计 §7）。模型看到的是一行 description，不是文件。
  const offer = await dispatch('agent.offer', {}, CORE_ORIGIN);
  const systemPrompt = [SYSTEM_PROMPT, instructions ?? '', renderOffer(offer)]
    .filter((part) => part !== '')
    .join('\n\n');
```

一次性模式的退出码：

```ts
    if (reason === 'error') process.exitCode = 1;
    else if (reason === 'interrupted') process.exitCode = 130;
    // 撞上 hop 上限就是"这趟没做完"。与 error 一样是非零 —— 不能悄悄退 0。
    else if (reason === 'max_hops') process.exitCode = 1;
```

- [ ] **Step 5: 把 `plugin-wiring.test.ts` 的 `bundle()` 补上新的必需项**

```ts
function bundle(overrides: Partial<Parameters<typeof cliPlugins>[0]> = {}) {
  return cliPlugins({
    render: createRenderer(),
    changes: createSessionChanges(),
    messages: [],
    root: process.cwd(),
    palette: createPalette(),
    policy: POLICY,
    home: '/home/u',
    agents: [],
    skills: [],
    baseSystemPrompt: '基础提示',
    ...overrides,
  });
}
```

`describe('第一方名单不会漂')` 那一节现在会顺带把 `subagents` 也过一遍 —— 它必须仍然全绿（这正是那一节存在的意义：往 `firstParty` 里加插件而忘了算进第一方名单，会被它逮住）。

Hmm，等等 —— 那条测试遍历的是 `bundle().plugins.map((p) => p.name)` 并断言都不被 `plugin-guard` 拒。`subagents` 在 `firstParty` 里，所以已经在 `names` 里了。✓

- [ ] **Step 6: 写 C3 的验收测试**

```ts
// test/skill-tool.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { confirmPlugin } from '../src/builtins/confirm';
import { createEngine } from '../src/core/create';
import { runTurn, type LoopContext } from '../src/core/loop';
import { discoverSkills } from '../src/cli/skills';
import { createSubagentsPlugin } from '../src/cli/subagents';
import { renderOffer } from '../src/cli/offer';

let root = '';
let home = '';

const BODY = '正文：这个项目写文档的三条规矩。';

const toolUse = (id: string, name: string, input: unknown = {}): StreamEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-skilltool-'));
  home = await mkdtemp(join(tmpdir(), 'deepcode-skilltool-home-'));
  const dir = join(root, '.deepcode', 'skills', 'design-notes');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: design-notes\ndescription: 本项目的设计口径\n---\n${BODY}`,
  );
});

async function mount(script: readonly (readonly StreamEvent[])[], extra: readonly Plugin[] = []) {
  const requests: StreamRequest[] = [];
  const describes: string[] = [];
  const asks: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'test',
    async *stream(req) {
      requests.push(req);
      const events = script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const observer: Plugin = {
    name: 'test-observer',
    uses: ['tool.describe'],
    register(on) {
      on('tool.describe', (_$, e, next) => {
        describes.push(String(e.tool));
        return next(e);
      });
    },
  };

  const skills = await discoverSkills({ root, home });
  const engine = await createEngine({
    plugins: [
      confirmPlugin,
      createSubagentsPlugin({ agents: [], skills, baseSystemPrompt: '基础提示' }),
      observer,
      ...extra,
    ],
    seating: { 'test-observer': 'prepend' },
    provider,
    ui: {
      print: () => {},
      notice: () => {},
      ask: async (question) => {
        asks.push(question);
        return 'y';
      },
    },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $: engine.$,
    provider,
    signal: new AbortController().signal,
    dispatch: engine.dispatch,
    systemPrompt: '提示',
    turnIndex: 0,
    // 会话里没有真正的工具，只留 Skill 一个 —— 这几条测的是技能，不是工具。
    tools: new Set(['Skill']),
  };

  return { engine, requests, describes, asks, messages, ctx, skills, run: () => runTurn(ctx, messages) };
}

/**
 * 最后一条**工具结果**消息里的第 n 个内容。
 *
 * ⚠️ **别用 `messages.at(-1)`**：loop 在 `break` 之前还会 push 一条 assistant 消息
 * （没有文本时 `content` 是空数组，见 `core/loop.ts:130-139`），所以 turn 跑完之后
 * 最后一条**往往不是**工具消息。这里要的是"上一轮工具拿回了什么"，得往回找。
 * （这条是 T3 执行时实测出来的，原计划的写法三处用例全挂。）
 */
function resultAt(messages: readonly Message[], index = 0): string {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  if (last?.role !== 'tool') throw new Error('这一轮没有任何工具结果消息');
  return last.results[index]?.content ?? '';
}

describe('C3-14：名册确实进了 system prompt', () => {
  it('技能的 name 与 description 出现在 agent.offer 渲染出来的那一节里', async () => {
    const m = await mount([]);
    const offer = await m.engine.dispatch('agent.offer', {}, CORE_ORIGIN);
    const rendered = renderOffer(offer);
    expect(rendered).toContain('design-notes');
    expect(rendered).toContain('本项目的设计口径');
    // 印的是 description 那一行，不是正文 —— 正文要等命中才进上下文（三层披露的第二层）。
    expect(rendered).not.toContain(BODY);
  });
});

describe('C3-15：Skill 工具', () => {
  it('拿回正文，并带上技能自己的目录（第三层靠它）', async () => {
    const m = await mount([
      [toolUse('u1', 'Skill', { name: 'design-notes' }), done('tool_use')],
      [{ type: 'text', text: '好' }, done('end_turn')],
    ]);
    await m.run();

    const content = resultAt(m.messages);
    expect(content).toContain(BODY);
    expect(content).toContain(join('.deepcode', 'skills', 'design-notes'));
  });

  it('点名不存在的技能 → deny，并把可用的列出来', async () => {
    const m = await mount([]);
    const result = await m.engine.dispatch(
      'tool.call',
      { tool: 'Skill', input: { name: '不存在' }, toolUseId: 'u1' },
      CORE_ORIGIN,
    );
    expect(result).toEqual({
      deny: '没有叫 不存在的 技能。可选的：design-notes',
    });
  });
});

describe('C3-16：skill.prompt 是变换缝', () => {
  it('没人应答时是原文 —— 缝尾不是闸', async () => {
    const m = await mount([]);
    const loaded = await m.engine.$.skill.load({ name: 'design-notes', text: BODY });
    expect(loaded.text).toBe(BODY);
  });

  it('有插件应答时用改写后的正文', async () => {
    // 一个"往里加一句话"的应答者，坐在 prepend（外层），改完交给下面。
    const annotator: Plugin = {
      name: 'test-annotator',
      uses: ['skill.prompt'],
      register(on) {
        on('skill.prompt', (_$, e, next) =>
          next({ name: e.name, text: `${e.text}\n（本轮附加：注意口径）` }),
        );
      },
    };
    const m = await mount(
      [
        [toolUse('u1', 'Skill', { name: 'design-notes' }), done('tool_use')],
        [{ type: 'text', text: '好' }, done('end_turn')],
      ],
      [annotator],
    );
    await m.run();

    const content = resultAt(m.messages);
    expect(content).toContain('（本轮附加：注意口径）');
  });
});
```

> `test-annotator` 坐在默认的 `builtin`，比 coreImpl 靠外，所以它的 `next(...)` 能落到链尾那条默认实现上。✓
> 注意 `next(改写后的事件)` 就是"带改写下行"那条语义（`next.ts` 的注释）。

- [ ] **Step 7: 跑这两个测试文件**

Run: `pnpm test test/offer.test.ts test/skill-tool.test.ts`
Expected: PASS —— 4 + 5 passed

- [ ] **Step 8: 反向验证（C3 两条）**

1. 把 `coreImpls['skill.prompt']` 改成 `() => ({ text: '' })` →
   `pnpm test test/skill-tool.test.ts` → **C3-15 第一条、C3-16 第一条必须红**。改回来。
2. 把 `confirm.ts` 的 `PASS_THROUGH_TOOLS` 里 `'Skill'` 去掉 →
   同上文件 → **C3-15 必须红**（模型拿到的是 `ERROR: 已拒绝 —— 未知工具 Skill`）。改回来。

- [ ] **Step 9: 跑全套 + 类型 + 边界**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿

- [ ] **Step 10: 提交**

```bash
git add src/cli/offer.ts src/cli/plugins.ts src/cli/main.ts test/offer.test.ts test/skill-tool.test.ts test/plugin-wiring.test.ts
git commit -m "feat(cli): 接线 —— 名册发现、agent.offer 拼进 system prompt、subagents 进第一方" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 12: 文档与计数

**Files:**
- Modify: `README.md`、`docs/项目简介.md`、`site/index.html`

- [ ] **Step 1: 数一遍，别照抄计划里的数字**

```bash
pnpm test 2>&1 | tail -20          # 用例总数与测试文件数
grep -c "^  '" src/contract/events.ts   # 只是给个手感，真正的口径在下面两步
```

口径以**代码**为准，不以本节写的数字为准：

- 事件：`EventArgs` 的键数（已实现）与 `UnimplementedEvent` 的成员数（未实现）。
  P4a 之后应当是 **39 声明 / 15 实现 / 24 未实现**（三个事件从第二族搬到第一族）。
- 工具：`$.tool.list()` 能列出几个。P4a 之后是 **8 个**（六个原有的 + `Task` + `Skill`）。

把这两组数字在三个地方对齐：`README.md`、`docs/项目简介.md`、`site/index.html`。
三处都要改，别只改 README —— 上一轮的教训是"写在一处的数字会被另一处的旧数字顶回去"。

- [ ] **Step 2: README 补一节「子代理与技能」**

写在「插件」那一节之后，用仓库里既有的腔调（直白、说代价）。至少覆盖这五条：

```markdown
## 子代理与技能

两处约定目录，与插件目录并列（`.deepcode/` 下）：

| 类型 | 项目级 | 用户级 | 插件级 |
| --- | --- | --- | --- |
| 子代理 | `.deepcode/agents/<name>.md` | `~/.deepcode/agents/<name>.md` | `<plugin>/agents/<name>.md` |
| 技能 | `.deepcode/skills/<name>/SKILL.md` | `~/.deepcode/skills/<name>/SKILL.md` | `<plugin>/skills/<name>/SKILL.md` |

- 文件开头是一段 frontmatter，正文是**系统提示词**（agent）或**知识正文**（技能）。
  agent 认 `name` / `description` / `model` / `tools` / `disallowedTools` / `maxTurns`；
  不认识的字段会**出声忽略**，不会让整个文件作废。
- **`description` 是路由的全部依据** —— 模型看到的只有这一行，没有它就永远选不中，
  这样的文件会被跳过并给出警告。
- agent 的 `tools` 省略 = **继承会话的全部工具**；给出 = 白名单。
  「全权」指的是工具面，**不是免确认**：子代理写文件照样弹 `y/N`。
- 子代理**看不到**当前对话，`prompt` 就是它的全部上下文；它最后一段话作为工具结果回到父级。
- 嵌套靠白名单：`tools` 里有 `Task` 才能再派，外加 3 层的硬上限。
- **项目级的 agent 与技能不需要显式启用**（与插件不同）：它们是文本，
  和这个仓库的 README、源码同级，而 `Read` 本来就是无闸的。
- 技能只加载正文。它旁边的 `references/`、`scripts/` 由模型自己用 `Read` / `Bash` 取 ——
  这一层我们一行代码都不写。
```

- [ ] **Step 3: `docs/项目简介.md` 与 `site/index.html` 同步**

- 两处的工具数、事件数改成 Step 1 数出来的值。
- `site/index.html` 的「架构」一节里那句「39 个已声明 · 12 个已实现」跟着改。
- 若**官网**那节写了工具清单（六个内建工具），补上 `Task` 与 `Skill` 并说明它们不是内建工具
  而是第一方插件提供的 —— 口径与 README 一致。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/项目简介.md site/index.html
git commit -m "docs: P4a —— 子代理与技能，计数 12 → 15" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# 检查点

## C1（Task 1–5 之后）：契约与解析

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §13 的 C1**

1. `parseFrontmatter` 的 fixture 组 —— `test/frontmatter.test.ts`（13 条：裸标量/注释/空行、
   双引号转义、JSON 数组、逗号串、方括号不加引号也认、`description` 里的逗号不被切、
   body 原样、`readList` 对缺失字段返回 `undefined`、没有 frontmatter 抛、没有结束的 `---` 抛、
   多行标量抛且带行号、重复键抛、引号没闭合抛）。✓
2. `agent.offer` 默认答复是空清单（不接插件的裸引擎）—— `test/agent-noun.test.ts` 最后那一节。✓
3. `skill.prompt` 默认答复是原文 —— 同上。✓
4. `StreamRequest.model` 省略时两个适配器都用 `config.model`；给了就用给的 ——
   `test/provider-model.test.ts`（4 条，假 provider / 假 fetch，不碰真网络）。✓

- [ ] **变异测试一条**

把 `src/contract/frontmatter.ts` 的 `readList` 里那句
`.split(',').map(...)` 换成 `.split(',').map((item) => item)` 之外什么都不做 —— 也就是让它不 trim、不剥引号。
Expected: `test/frontmatter.test.ts` 里那条"没加引号的方括号写法也认"变红。
改回来。**不红就说明那条断言是摆设，修断言本身。**

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4a C1 通过（契约与解析）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C2（Task 6–10 之后）：子代理

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §13 的 C2**

5. 白名单的**两个落点** —— `test/subagent.test.ts` 的 `C2-5` 两条。✓
6. **两条反向验证** —— 已写在 Task 10 Step 5，三条都跑过且都红。✓
7. 隔离 —— `C2-7`。✓
8. 静音（真 `streamPlugin` + 假 renderer，`tool.*` 照发） —— `C2-8`。✓
9. `tools: []` 断掉递归 —— `C2-9`。✓
10. 深度 3 层过、第 4 层拒 —— `C2-10`。✓
11. 全权 ≠ 免确认 —— `C2-11`。✓
12. 模型分层 —— `C2-12`。✓
13. 失败不炸父级 —— `C2-13`（两条：`max_hops` 与 provider 抛异常）。✓

- [ ] **手工看一眼真实输出（可选，两分钟）**

```bash
mkdir -p /tmp/p4a-demo/.deepcode/agents
cat > /tmp/p4a-demo/.deepcode/agents/explorer.md <<'EOF'
---
name: explorer
description: 深入探索代码库并回报结论
tools: Read, Glob, Grep
---
你是一个只读的探索者。只回报结论，不要复述过程。
EOF
cd /tmp/p4a-demo && node --import tsx F:/ts/DeepCode/src/cli/main.ts "这个目录里有什么？用 explorer 看一眼"
```

看三件事：屏幕上**先**出现「派子代理 explorer（第 1 层）…」、子代理自己的输出**不出现**、
最后「子代理 explorer 回来了（end_turn）」，并且父级给出结论。
（真跑要花 token。不做也行 —— 上面那 13 条已经全在测试里钉住了。）

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4a C2 通过（子代理）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C3（Task 11–12 之后）：技能与收口

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §13 的 C3**

14. `skills/x/SKILL.md` 的 name + description 出现在 system prompt 里 —— `test/skill-tool.test.ts` 的
    `C3-14`。✓（口径：`agent.offer` 报出它们 + `renderOffer` 印出它们，两段都在测试里；
    `main.ts` 里最后那次 `join` 只有三行，靠上面那次手工跑一遍兜底。）
15. `Skill` 拿回正文；点名不存在的 → deny 且列出可用名 —— `C3-15` 两条。✓
16. 一个测试插件经 `skill.prompt` 改写正文，模型收到改写后的 —— `C3-16` 第二条。✓

- [ ] **收口自检：三处数字对不对得上**

```bash
grep -rn "12 个已实现\|39 个\|六个\|6 个工具\|257" README.md docs/项目简介.md site/index.html
```

Expected: 没有残留的旧口径（`257` 那种是 P3 时代的用例数，本次要按实测值改）。

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4a C3 通过（技能与收口）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自查记录（写计划时逐行对照源码的产物）

写完计划后按 writing-plans 的三条自查过了一遍，结果是三处修正 + 一处范围发现：

1. **覆盖**：设计 §13 的 16 条出口标准逐条落到了任务上（见上面的检查点清单）。
   设计 §15「明确不做」的九条一条都没做，也不用做。
2. **占位符**：扫了一遍「TBD / TODO / 类似 Task N / 加上适当的错误处理」—— 零。
   每一个改代码的步骤都给了成品代码块。
3. **类型一致性**：跨任务的名字对齐了 ——
   `AgentSpec.maxTurns` → `AgentSpawnRequest.maxHops`（**故意不同名**：一个是文件里的字段、
   一个是内核的入参，改一个不影响另一个）；`AgentSpawnResult.text` 全程叫 `text`；
   `SkillSpec.dir` 在 skills.ts 里写、在 subagents.ts 里读；
   `createCoreNouns` 的第三参数全程叫 `refs`。
4. **范围发现（最大的那一件）**：`tool.call` 的 10 秒 hook 预算会把 `Bash` 与 `Task` 判成
   "未知工具"。原设计没有这一条，见 Task 9 的开头。**这是本轮唯一一处改到 `contract/next.ts`
   与 `core/dispatch.ts` 的地方，也是唯一一个修正既有缺陷而非新增能力的地方。**

## 执行记录

（执行时填。格式照 P3 的做法：每个偏差一段 —— 现象、为什么计划错了、改成了什么、影响。

预登记的、大概率会出现的几处：

- **Task 12 的数字**：计划里写的 39/15/24 与 8 个工具是**写计划时按代码推的**，
  执行时必须以 `src/contract/events.ts` 与 `$.tool.list()` 的实际值为准。
- **`renderOffer` 的落脚点**：原设计把它写在 `main.ts` 里，计划改成了 `src/cli/offer.ts`
  （纯函数、可单测）。功能不变，文件多一个。
- **`walkdir.ts` 多了一个 `rosterRoots`**：原设计只说"抽出目录遍历"，
  实际抽出的是"遍历 + 名册的根"，因为 agents.ts 与 skills.ts 共用同一条
  「项目级 > 用户级 > 插件级」的根顺序，抄两份必然会漂。
- **`subagents` 插件在 system prompt 里报的是文件里写的 `tools`**，不是解析后的白名单：
  解析后的那份 = 会话此刻的全部工具，会随时间变，印一份会变的清单没有意义。）

### 实际发生的偏差

**T1 —— 计划里有一条自相矛盾的断言被删掉了（计划错了，不是实现错了）。**

- **现象**：`test/frontmatter.test.ts` 的 `description 里的逗号不会被切成数组` 一条，计划写了
  `expect(readList(fm, 'description')).toBeUndefined();`，实测红：
  `expected [...] to be undefined`，收到的是那个逗号切出来的三元素数组。
- **为什么计划错了**：同文件的 `逗号串写法`（`tools: Glob, Grep, Read` → `['Glob','Grep','Read']`）
  要求 `readList` 必须对裸标量做逗号切分，而 `description` 在解析器眼里与 `tools` 没有任何区别 ——
  **两条断言不可能同时成立**。设计 §3 末段也明说切分归 `readList`。那条断言是写计划时顺手加的，
  它想钉的是"切分不长在通用解析器里"，而这一条**紧邻的 `readScalar` 断言已经钉住了**（若解析器
  自己把它切成了数组，`readScalar` 就会返回 `undefined`）。
- **改成了什么**：删掉那一行，保留该用例与它的 `readScalar` 断言。
- **影响**：零。用例数 13（计划里写的"12 条"是少算了一条，两处已改）。删掉的断言是**重复**而非**缺口**。

**T1 —— 计数少了一个**：计划说 12 条，实际 13 条。文件结构总览与 C1 清单已改为 13。

**T2 —— 计划漏了一个被牵连的测试文件（计划错了）。**

- **现象**：`test/dispatch.test.ts:277` 那条「落到未实现的事件抛 `NotImplementedError`」点名的正是
  `agent.spawn`，而入参写的是 `{}`。三个事件一转正，这一行**既不编译**（入参不再收 `{}`）
  **也不再成立**（`agent.spawn` 进了 `NOTIFICATION_EVENTS`，链尾兜底返回 `{}`，不抛）。
- **为什么计划错了**：写计划时按设计文档列了要改的文件清单，没有反向扫一遍"谁在依赖这三个事件
  当前的状态"。这是清单式分解的典型漏法 —— 被牵连的消费者不会主动出现在清单里。
- **改成了什么**：改点名 `config.set`（仍然未实现），语义一字不变；`test/dispatch.test.ts`
  进 Task 2 的 `git add`，文件结构总览补上这一行、计数 2 → 3。
- **影响**：零功能影响。**这是一条值得记住的教训**：把一个声明-only 的事件转正时，
  先 grep 一遍它的名字，看看谁把它当"未实现"在测。

**T2 —— Step 7 的反向验证在 Task 2 时刻是走过场的（计划错了）。**

- **现象**：把 `AgentSpawnRequest.tools` 打成 `toolz`，`pnpm typecheck` **依然是绿的**。
- **为什么**：此刻没有任何消费者读这个字段 —— 真正的消费者 `core/nouns/agent.ts` 要到 Task 5 才生出来，
  而 Task 2 自己的临时桩不读入参。**"类型变宽"这一步在它被消费之前是拦不住任何人的。**
- **改成了什么**：Step 7 的文案改成实话（"此刻是走过场，要看到红得先造一个消费者"），
  并给出那一步的临时探针写法；正式的替换测试留在 Task 5。
- **影响**：零。但这条值得单独记：**反向验证要在"消费者存在"的那一步做才有意义**，
  否则它绿得毫无信息量 —— 而绿的假验证比没有验证更坏，因为它会让人以为验过了。

**T3 —— 计划给的测试助手取错了消息（计划错了，而且坑了三处）。**

- **现象**：`test/loop-options.test.ts` 三条用例挂掉，`lastResult` 永远是 `undefined`。
- **为什么计划错了**：助手写的是 `messages.at(-1)`，但 `runTurn` 在 `break` **之前**
  还会 `push` 一条 assistant 消息（`core/loop.ts:130-139`，没有文本时 `content` 是空数组）。
  于是"上一轮工具拿回了什么"根本不在最后一条上 —— 前后差一步。
- **改成了什么**：`[...messages].reverse().find((m) => m.role === 'tool')`。
  **同一份助手在 Task 10 与 Task 11 的测试里各抄了一遍，已一并改成这个写法**
  （计划里那两处才是真正的雷：那里断言的是"父级拿到的子代理结论"，取错消息就什么都验不到）。
- **影响**：这是本轮最值得记的一条 —— **它不只让 Task 3 红，还让后面两处照抄的助手带着同一个
  盲点**。写计划时同一段代码抄三遍，错就错三遍；执行时先红的那一处救了后面两处。

**T3 —— `maxHops` 的脚本太短（计划错了）**：计划给的是 `script: [callTool('Read')]` 配
`maxHops: 2`，但脚本只有一条时，第 2 跳会落到"没有脚本了 → `done/end_turn`"的兜底，
于是 loop 自己收手、根本撞不到上限。改成两条 `callTool('Read')`（断言 `toBe('max_hops')` 未动）。
**计划里那句注释（"每一轮都要工具，永远不自己收手"）是对的，脚本没跟上注释。**

**T3 —— 计数又是 10 而实际 9**（同 T1，已改）。

**T2 的连带发现 —— `as any` 让 typecheck 漏掉了两处（计划错了 + 一条教训）。**

- **现象**：Task 2 把 `agent.spawn` 转正之后，`test/dispatch.test.ts` 里其实有**三处**把它当
  "未实现的事件"在测。Task 2 的清单只提了会**编译失败**的那一处（`{}` 入参），另外两处
  因为写了 `as any` 而照常编译 —— 于是 `pnpm typecheck` 全绿，而这两条测试**在运行时红着**，
  一路带到 T3 的全套跑才露头（459 passed / 2 failed）。
- **为什么计划错了**：写计划时只 grep 了"谁编译不过"，没问"谁在**假设**这个事件没有实现"。
- **改成了什么**：两条改点名仍然未实现的 `config.set`，顺手**去掉 `as any`**
  （`config.set` 的入参是 `Record<string, unknown>`，`{}` 天然合法），让它重新受类型保护；
  另在"裸 dispatcher 也能 dispatch 通知事件"那条里补上 `agent.spawn` 的断言 ——
  它现在是这一族的新成员，这条性质正是本轮新引入的。注释里的 "27 个未实现" 同步改成 24。
- **影响**：零功能影响，但教训值钱：**`as any` 是"编译期审查失效"的开关**。
  凡是靠 `as any` 才编译得过的地方，都等于把这道闸关掉了 —— 被转正的事件正好会藏在那儿。

**T5 —— 同一个 `maxHops` 脚本陷阱，在另一个文件里又来了一遍（计划错了）。**

- **现象**：Task 5 的 `agent-noun.test.ts` 那条 `撞上限时 stopReason 是 max_hops` 断言
  `expected 'end_turn' to be 'max_hops'` —— 与 T3 里那条**一字不差地**同一种错。
- **改成了什么**：只改脚本（`[callTool('Read')]` → `[callTool('Read'), callTool('Read')]`），
  `maxHops: 2` 与断言都没动。执行时还顺手对齐了 `test/loop-options.test.ts` 里已经改好的那份。
- **影响**：零。但**这是这份计划最该记住的一条教训**：
  T3 报出这个错的时候我只改了**被报的那一处**，没有去 grep 计划里还有几处同样的写法 ——
  于是 T5 又踩了一遍，由实现者自己认出来并引用了 T3 的先例。
  **一个错在计划里出现的次数，永远大于某一次执行抱怨它的次数。**
  计划里剩下的两处（Task 3 的 Step 1 测试块、Task 5 的 Step 5 测试块）已一并改正，
  免得下次再有人照抄。


**T6/T7/T8 —— 三处名册抽取，实现本身零偏差；但 T6 的提交署名错了（执行侧，非计划）。**

- **T6/T7/T8 的实现**：三者都一次通过，没有一条断言需要改（T6 全绿 477；
  T7 `test/agents.test.ts` 14 passed；T8 `test/skills.test.ts` 10 passed）。
  `walkdir.ts` 抽出来后 `plugin-dir.ts` 的"读不了"措辞换成了共用版本 —— 那是重构的正当后果，
  没有任何测试钉着旧措辞（印证了计划里那句"已确认过"）。
- **T6 的署名**：子代理的宿主指令让它把 trailer 写成 `Co-Authored-By: Claude Haiku 5.5 …`，
  与本仓库**每一个**提交（以及这份计划每一步）写的 `Co-Authored-By: Claude Code …` 不一致。
  已 `git commit --amend` 改回；T7/T8 在派活 prompt 里把那一行写死之后就没再犯。
- **教训**：**署名这类"仓库约定"必须在派活 prompt 里逐字写出**，不能指望子代理从
  自己的环境里推出正确的那一个 —— 它的环境和这份仓库的约定不是同一套。

**计划的一处"未执行先改"（T9）—— 又是共享常量被断言钉住的老问题。**

- **现象（静态审出来的，不是跑出来的）**：`test/dispatch.test.ts:217` 那条
  `next.signal / origin / budget / is 都挂上了` 用 `CALL`（= `tool.call`）做载体，
  断言 `ms: 10_000`。T9 让 `tool.call` 不上预算之后 `next.budget.ms` 是 `Infinity`，
  **这条必然红** —— 而 T9 的 Step 7 原文写着"Expected: 全绿"。
- **改成了什么**：Step 7 补上警告与改法（把载体换成有预算的 `tool.describe`，`10_000` 留着），
  并在 `test/hook-budget.test.ts` 里**加一条**断言 `tool.call` 是 `Infinity`、
  普通事件是 `10_000` —— 这个不对称是 T9 的全部意义，值得有断言钉住。Step 5 的计数 2 → 3。
- **为什么这次是好事**：T2 那次是**跑出来**才发现牵连，T3/T5 那次是**同一个错踩两遍**。
  这次在派活之前先 grep 了 `budget\|10_000\|HOOK_BUDGET`，确认全套里钉 `budget.ms` 的
  只有那一处（其余 `10_000` 都是 `timeoutMs`，不相干）——
  **改共享常量的语义之前，先 grep 谁在断言它的值。** 这条已经写进 T9 的 Step 7。
