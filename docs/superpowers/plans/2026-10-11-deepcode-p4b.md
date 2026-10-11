# DeepCode P4b（上下文与执行边界）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `Bash` 装一道**任何权限规则都绕不过去**的路径闸，给会话装一个**宁可涨也不静默丢**的压缩，再让 `AGENTS.md` 按目录**惰性**地跟着模型读文件走 —— 三样都改既有实现的内部，一个新扩展点都不加。

**Architecture:** 沙箱是**策略层的命令分析**（不做 OS 隔离），判定落在 `process` 名词内部、`spawn` 之前 —— 也就是**整条权限链的下游**，于是"个人规则掀不翻托管策略"从政策层面升级成结构层面。压缩先把两个适配器的真实 usage 接上（今天 `turn.complete` 报的是写死的 `0`），再做**摘要替换 + 保留最近 N 轮原文**，失败方向**刻意与 fail-closed 相反**：压不成就干脆不压、出声、原文一份不动。嵌套指令挂在 `Read` 的 `tool.call` 上，`next()` 之后把中间层目录的 `AGENTS.md` / `CLAUDE.md` 附上去。

**Tech Stack:** TypeScript（ESM，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`，**没有** `exactOptionalPropertyTypes`）、Node ≥ 20、pnpm、vitest 2.1.9、tsx。**零运行时依赖**，这一条不允许破。

**设计文档:** [`docs/superpowers/specs/2026-10-11-deepcode-p4b-design.md`](../specs/2026-10-11-deepcode-p4b-design.md)

**前序:** [`P4a 计划`](2026-10-11-deepcode-p4a.md)（同体例先例，含执行记录与偏差清单）

---

## 执行须知：验收口径

**长期指令（用户明确要求，优先于一切默认做法）：验收尽量精简，一次校验多个任务，以快速完成开发为主。**

具体落法：

1. **任务级验收只要求 `pnpm typecheck` 通过。** 每个任务写完代码与测试后，跑 `pnpm typecheck`，绿了就提交。
2. **测试按检查点批量做。** 任务里的测试**写完即提交**，但整批 `pnpm test` 留到 `C1` / `C2` / `C3` 检查点跑。
3. **每个任务结束提交一次。** 提交命令写在任务的最后一步，直接照抄。
4. **任务之间连续执行，不要停下来问。** 只有三种情况值得停下来：真的卡住了（`BLOCKED`）、计划本身有错、或者全部任务做完了。
5. **计划里的代码块是成品，不是示意。** 照抄。如果发现计划有错，改代码的同时**把纠正记到文末的「执行记录」**里。
6. **⚠️ 抄之前先看一眼被改的那几行。** P4a 被抓出来的五处计划错误**全都出在"照着记忆写代码"上**（改共享常量捅了别人、同一个错抄两遍、新写的测试没自洽、断言为真但理由不对、写错的期望字符串与漏掉的 `git add`）。本计划里凡是要你改**既有文件**的步骤，都给了足够的上下文行 —— 对不上就说明文件变了，**停下来重新核，别硬套**。

跑测试的命令（`C1`/`C2`/`C3` 用）：

```bash
pnpm typecheck      # 类型
pnpm lint           # 依赖边界（往 contract/ 里越界 import 会红）
pnpm test           # 全部测试
pnpm test test/sandbox.test.ts    # 单个文件
```

## 边界规则

`scripts/check-boundaries.mjs` 的硬约束（`RULES` 表 + "同目录内部不算越界"那条 `continue`）：

| 目录 | 允许 import 的 src 顶层目录 |
|---|---|
| `src/contract/` | 无（同目录内部随便 import —— `events.ts` 已经在 import `./engine`） |
| `src/core/` | `contract` |
| `src/providers/` | `contract` |
| `src/builtins/` | `contract` |
| `src/cli/` | `contract`、`core`、`providers`、`builtins` |

四条推论，直接决定了 P4b 的文件放哪：

- **`candidatePaths` 是纯函数、零 IO → 住 `contract/sandbox.ts`。** `SandboxConfig` 也住那儿（`core/nouns/process.ts` 要读它，不能反过来依赖 `cli/`）。它 import `./policy` 取 `Rule` 类型与三个归一助手 —— **同目录内部，不越界**。
- **`checkSandbox` 要拿 `cwd` / `home` 做解析 → 住 `core/nouns/sandbox.ts`。** 它 import `contract/policy`，`core` 允许。
- **压缩要读 `CompactConfig`（住 `cli/settings.ts`）、要派 `session.compact`、要动落盘游标 → 住 `cli/compact.ts`。**
- **嵌套 `AGENTS.md` 要用 `$.fs`、要算相对路径 → 住 `cli/agents-md.ts`。** `builtins/` 只能 import `contract`，放不下它。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/contract/sandbox.ts` | **新增** | `SandboxConfig` 类型 + `candidatePaths()` + `sandboxRule()`。纯函数、零 IO |
| `src/contract/policy.ts` | 修改 | **导出** `squeeze` / `slashes` / `expandHome`（沙箱复用同一套归一） |
| `src/contract/model-provider.ts` | 修改 | `Usage` 类型 + `toUsage()` + `StreamEvent.done.usage?` |
| `src/contract/events.ts` | 修改 | `session.compact` 转正；`turn.complete` 加 `usageEstimated?`；`NOTIFICATION_EVENTS` 加一员；**三处旧计数 12 → 16** |
| `src/contract/classic.ts` | 修改 | 注释里的旧计数 12 → 16（纯注释） |
| `src/core/nouns/sandbox.ts` | **新增** | `checkSandbox()`：解析候选 → 合成 `Write` 调用 → 给理由不给布尔 |
| `src/core/nouns/process.ts` | 修改 | 收 `ProcessDeps.sandbox?`，`spawn` 之前判定 |
| `src/core/nouns/index.ts` | 修改 | `CoreNounsDeps.sandbox?` 透传给 `createProcessNoun` |
| `src/core/loop.ts` | 修改 | `messageChars()` / `estimateTokens()`；`LoopContext.onUsage?`；两处收场统一填 usage |
| `src/providers/anthropic.ts` | 修改 | 新接 `message_start`（`input_tokens`）+ `message_delta.usage`（`output_tokens`） |
| `src/providers/openai.ts` | 修改 | 请求体加 `stream_options.include_usage`；先读 usage 再判 `choice` |
| `src/cli/settings.ts` | 修改 | 读 `sandbox` / `compact` 两块；`allow` 的来源过滤；`ResolvedPolicy` 加两个字段 |
| `src/cli/transcript.ts` | 修改 | `Persister` 类型 + `createPersister` 的 `reseed` 逃生口 |
| `src/cli/compact.ts` | **新增** | `splitAt` / `SUMMARIZE_PROMPT` / `createCompactor` |
| `src/cli/agents-md.ts` | **新增** | 嵌套 `AGENTS.md` 的第一方插件 |
| `src/cli/plugins.ts` | 修改 | 第一方加 `agents-md`（**必须排在 `coreTools` 之前**）；`CliPluginDeps.compact?` |
| `src/cli/commands.ts` | 修改 | `SessionCommandsDeps.compact?` → 注册 `/compact` |
| `src/cli/repl.ts` | 修改 | `ReplDeps.onUsage?` / `afterTurn?` |
| `src/cli/main.ts` | 修改 | 建压缩器、接 `/compact`、传 `sandbox` |
| `test/sandbox.test.ts` | **新增** | 候选提取 + 判定 + 结构性权威 + **副作用验证** |
| `test/compact.test.ts` | **新增** | 切点、失败方向、`session.compact`、**落盘游标** |
| `test/agents-md.test.ts` | **新增** | 嵌套、两种去重、边界 |
| `test/settings.test.ts` | 修改 | 追加 `sandbox` / `compact` 两块解析的用例 |
| `test/transcript.test.ts` | 修改 | 追加 `reseed` 的用例 |
| `test/loop-options.test.ts` | 修改 | 追加 usage 落到 `turn.complete` 的用例 |
| `test/provider.test.ts`、`test/openai.test.ts` | 修改 | 追加 usage 解析的用例 |
| `test/dispatch.test.ts` | 修改 | 生命周期清单加 `session.compact`；旧计数注释 24 → 23 |
| `test/cli.test.ts`、`test/plugin-wiring.test.ts` | 修改 | `ResolvedPolicy` 字面量补两个字段（**共享类型加了必填字段，4 处会当场编译不过**） |
| `README.md`、`docs/项目简介.md`、`site/index.html` | 修改 | 计数 16/23；沙箱那一节的诚实说明；不做 `dangerouslyDisableSandbox` |

---

## Task 1: `contract/sandbox.ts` —— 候选路径提取（纯函数）+ 导出三个归一助手

**Files:**
- Create: `src/contract/sandbox.ts`
- Modify: `src/contract/policy.ts:52-72`（三个私有函数变成导出）
- Test: `test/sandbox.test.ts`（本任务只放「候选提取」一节）

**为什么把 `squeeze` / `slashes` / `expandHome` 拆出来导出**：权限链那边已经立了一条规矩 ——"反斜杠统一成正斜杠，免得同一个路径因为写法不同而匹配不上"（`policy.ts:57-59`）。沙箱要是自己再写一遍归一，**两套迟早分叉**，而分叉的那一天表现是"同一条规则在权限链认、在沙箱不认"，一种最难查的错。Task 2 里有一条断言把两者钉成同一个形状。

- [ ] **Step 1: 写失败的测试**

```ts
// test/sandbox.test.ts
import { describe, expect, it } from 'vitest';
import { candidatePaths, sandboxRule } from '../src/contract/sandbox';
import { parseRule, type Rule } from '../src/contract/policy';

/**
 * 候选提取只是**切分**，不是 shell 解析 —— 它不认识变量、命令替换、`cd &&`。
 * 这一节钉的是"我们想得到的写法都取到了"，不是"取全了"（设计 §9.4）。
 */
describe('candidatePaths：只切分，不解析', () => {
  it('不碰路径的命令：一个候选都没有', () => {
    expect(candidatePaths('ls -la')).toEqual([]);
    expect(candidatePaths('git status')).toEqual([]);
    expect(candidatePaths('npm run build')).toEqual([]);
  });

  it('绝对路径、相对路径、`~` 开头的都算候选，且**原样**返回（不展开、不归一）', () => {
    expect(candidatePaths('rm -rf /tmp/x')).toEqual(['/tmp/x']);
    expect(candidatePaths('rm -rf ~/.ssh')).toEqual(['~/.ssh']);
    expect(candidatePaths('cat ./a/b.txt')).toEqual(['./a/b.txt']);
  });

  it('带路径的命令名本身是候选', () => {
    expect(candidatePaths('/usr/bin/rm -rf /x')).toEqual(['/usr/bin/rm', '/x']);
  });

  it('纯词不当候选 —— 否则 `git commit -m "fix bug"` 会被整条拒掉', () => {
    expect(candidatePaths('git commit -m "fix bug"')).toEqual([]);
  });

  it('纯旗标跳过', () => {
    expect(candidatePaths('rm -rf /x')).toEqual(['/x']);
  });

  it('重定向目标无条件算，哪怕它是个纯词', () => {
    expect(candidatePaths('echo x > out.txt')).toEqual(['out.txt']);
    expect(candidatePaths('echo x >> out.txt')).toEqual(['out.txt']);
    expect(candidatePaths('echo x >/tmp/o')).toEqual(['/tmp/o']);
    expect(candidatePaths('echo x 2>/tmp/e')).toEqual(['/tmp/e']);
  });

  it('旗标里挂着的路径要拆出来 —— 否则 `--out=/etc/passwd` 能安静地绕过 `/etc/**`', () => {
    expect(candidatePaths('git commit --file=/etc/msg')).toEqual(['/etc/msg']);
  });

  it('引号内的空白不切，引号本身剥掉', () => {
    expect(candidatePaths('cp "/a b/c" /d')).toEqual(['/a b/c', '/d']);
  });

  it('反斜杠分隔（Windows 写法）也算', () => {
    expect(candidatePaths('type C:\\Windows\\win.ini')).toEqual(['C:\\Windows\\win.ini']);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/sandbox.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/contract/sandbox"`

- [ ] **Step 3: 把 `policy.ts` 的三个私有助手改成导出**

只改这三处签名（**函数体一个字不动**），并各加一行导出理由的注释。

`src/contract/policy.ts:52-54`，原文：

```ts
/** 连续空白折成单空格、去首尾。规则侧与调用侧都要做，`git  push` 才等于 `git push`。 */
function squeeze(text: string): string {
```

改成：

```ts
/**
 * 连续空白折成单空格、去首尾。规则侧与调用侧都要做，`git  push` 才等于 `git push`。
 *
 * **导出给沙箱用**（`contract/sandbox.ts` 的 `sandboxRule`）。P4b 那一道路径闸必须与
 * 权限链用**同一套**归一 —— 两套分叉的那天，症状是"同一条规则在权限链认、在沙箱不认"。
 */
export function squeeze(text: string): string {
```

`src/contract/policy.ts:57-58`，原文：

```ts
/** 反斜杠统一成正斜杠，免得同一个路径因为写法不同而匹配不上。 */
function slashes(text: string): string {
```

改成：

```ts
/** 反斜杠统一成正斜杠，免得同一个路径因为写法不同而匹配不上。**导出给沙箱用**，理由同 `squeeze`。 */
export function slashes(text: string): string {
```

`src/contract/policy.ts:68`，原文：

```ts
function expandHome(text: string, home: string): string {
```

改成：

```ts
export function expandHome(text: string, home: string): string {
```

并在它上面那段注释的末尾（`*/` 之前）补一句：

```
 * 沙箱**调用侧**要展开它：权限链的调用侧不展开是刻意的（模型给 `Read` 传 `~/...` 该由 fs 名词管），
 * 而沙箱的候选来自命令行文本，跟 fs 名词隔了一整条工具链 —— 不展开的话一条 `~/.ssh/**` 的
 * deny 会**永远不命中**，安静地失效。
```

- [ ] **Step 4: 写实现**

```ts
// src/contract/sandbox.ts
import type { Behavior, Rule } from './policy';
import { expandHome, slashes, squeeze } from './policy';

/**
 * 沙箱配置。**类型住 contract** —— `core/nouns/process.ts` 要读它，不能反过来依赖 `cli/`。
 *
 * 规则形状与权限规则**完全同一种**（`Rule`），于是匹配复用 `matchesRule`，不另写一套。
 */
export type SandboxConfig = {
  readonly enabled: boolean;
  /** 各层并集。任何来源都能往这儿加 —— 它只会让沙箱更严。 */
  readonly deny: readonly Rule[];
  /** 白名单。**只有托管层（`policy`）能设**；其余来源设了会被忽略并出声。 */
  readonly allow: readonly Rule[];
};

/**
 * 一条沙箱路径 → `Rule`。
 *
 * 这里**不调 `parseRule`**：设置文件里写的是裸路径（`/etc/**`），不是 `工具(参数)` 形式的规则，
 * `parseRule` 会因为 `工具名 "/etc/**" 不合法` 直接判错。但它归一用的是**同一组助手**，
 * 形状与 `parseRule('Write(/etc/**)', 'deny', home)` 逐字节相同 —— `test/sandbox.test.ts`
 * 里有一条断言把两者钉在一起。
 *
 * `tool` 恒为 `'Write'`：**文本分析分不出 `cat /x` 与 `rm /x`**，既然分不出就一律按写算 ——
 * 严的方向错好过松的方向错（设计 §2.3）。
 */
export function sandboxRule(text: string, decision: Behavior, home: string): Rule {
  return {
    raw: text,
    tool: 'Write',
    content: slashes(squeeze(expandHome(text, home))).replace(/\/+/g, '/'),
    decision,
  };
}

/** 只看重定向符号的那几个 token：`>`、`>>`、`2>`、`1>>`、`<`。 */
const REDIRECT_ONLY = /^(?:\d*>>|\d*>|\d*<)+$/;
/** 挂在 token 头上的重定向符号：`>/tmp/x`、`2>/tmp/x`。 */
const REDIRECT_HEAD = /^(?:\d*>>|\d*>|\d*<)+/;

/**
 * 从一条 shell 命令里取出**可能被写到的**路径候选（原样 token：不解析、不展开 `~`、不归一斜杠）。
 *
 * ⚠️ **这是文本分析，不是 shell 解析器。** `x=/etc/passwd; rm $x`、`rm $(echo /etc/passwd)`、
 * `cd /etc && ...` 全都绕得过去。候选提取的规则一律朝**保守**方向偏（宁可多取不可漏取），
 * 因为漏取是 fail-open。它的准确率是"我们信这组 fixture"，不是"我们量过"。
 *
 * 取法（设计 §2.2）：
 * 1. 按空白切 token，认单双引号（引号内的空白不切，引号本身剥掉）。
 * 2. 重定向目标一律算 —— `> out.txt` 里的 `out.txt` 是个纯词，但它就是要被写的地方。
 * 3. 第一个 token 是命令名：**带路径的**（`/usr/bin/rm`）算候选，裸名（`rm`）跳过。
 * 4. 旗标（`-` 开头）跳过；但**旗标里挂着的路径要拆出来**（`--out=/etc/x`）。
 * 5. 其余 token：含 `/` 或 `\`、或以 `~` 开头 → 候选。
 *    **纯词不算** —— `git commit -m "fix bug"` 里那些词解析成相对路径全是假的，
 *    而相对路径又要按 cwd 解析，假阳性会把正常命令全拒掉。
 */
export function candidatePaths(command: string): readonly string[] {
  const tokens = splitTokens(command);
  const out: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const prev = index === 0 ? undefined : tokens[index - 1]!;

    // 2. 上一个 token 是光秃秃的重定向符号 → 这个就是目标，无条件算。
    if (prev !== undefined && REDIRECT_ONLY.test(prev)) {
      out.push(token);
      continue;
    }
    if (index === 0) {
      // 3. 命令名：带路径的算候选（`/usr/bin/rm -rf /x` 里的前半截）。
      if (looksLikePath(token) || token.startsWith('~')) out.push(token);
      continue;
    }
    if (REDIRECT_ONLY.test(token)) continue; // 光秃秃的重定向符号本身不是路径

    // `>/tmp/o`、`2>/tmp/e`：把符号从 token 头上剥掉再判。
    const bare = token.replace(REDIRECT_HEAD, '');
    if (bare === '') continue;

    if (bare.startsWith('-')) {
      // 4. 旗标里挂着路径：`--out=/etc/x` 的值那一半才像路径，整串不像。
      const eq = bare.indexOf('=');
      const value = eq === -1 ? '' : bare.slice(eq + 1);
      if (value !== '' && (looksLikePath(value) || value.startsWith('~'))) out.push(value);
      continue;
    }

    if (looksLikePath(bare) || bare.startsWith('~')) out.push(bare);
  }

  return out;
}

function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('\\');
}

/**
 * 按空白切 token，认单双引号。**不做转义处理**（`\ ` 当普通反斜杠看）——
 * 与整个函数的定位一致：保守、够用、不假装是解析器。
 */
function splitTokens(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}
```

- [ ] **Step 5: 跑测试，确认它通过**

Run: `pnpm test test/sandbox.test.ts`
Expected: PASS（9 条）

- [ ] **Step 6: 加一条断言，把沙箱的归一与权限链的归一钉成同一个形状**

**这一步是本任务的重点**，别跳。追加到 `test/sandbox.test.ts` 末尾：

```ts
/**
 * 沙箱的规则归一必须与权限链**逐字节相同**。
 *
 * 分叉的那一天，症状是"同一条规则在权限链认、在沙箱不认" —— 一种最难查的错。
 * 这里拿裸路径（沙箱的写法）与 `Write(...)` 形式的规则（权限链的写法）对拍。
 */
describe('两套归一不分叉', () => {
  const HOME = '/home/u';

  it('裸路径产生的 Rule 与 `Write(<路径>)` 产生的 Rule 逐字段相同', () => {
    const mine = sandboxRule('~\\SSH\\**', 'deny', HOME);
    const theirs = parseRule('Write(~\\SSH\\**)', 'deny', HOME);
    expect('error' in theirs).toBe(false);
    expect(mine.tool).toBe('Write');
    expect(mine.content).toBe((theirs as Rule).content);
  });

  it('连续斜杠与重复空白也归成同一个形状', () => {
    expect(sandboxRule('/etc//passwd', 'deny', HOME).content).toBe('/etc/passwd');
    expect(sandboxRule('/a/  b', 'deny', HOME).content).toBe('/a/ b');
  });
});
```

Run: `pnpm test test/sandbox.test.ts`
Expected: PASS（11 条）

- [ ] **Step 7: 反向验证一条（改坏实现，确认它真会红）**

把 `sandboxRule` 里的 `slashes(` 临时删掉（变成 `squeeze(expandHome(text, home))`）。
Run: `pnpm test test/sandbox.test.ts`
Expected: `两套归一不分叉` 的第一条**变红**。改回来。
**不红就说明那条断言是摆设，修断言本身。**

- [ ] **Step 8: 提交**

```bash
git add src/contract/sandbox.ts src/contract/policy.ts test/sandbox.test.ts
git commit -m "feat(contract): 沙箱配置与候选路径提取，权限归一助手改为导出" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `core/nouns/sandbox.ts` —— 判定（解析 + 白名单 + 黑名单）

**Files:**
- Create: `src/core/nouns/sandbox.ts`
- Test: `test/sandbox.test.ts`（追加「判定」一节）

- [ ] **Step 1: 写失败的测试**

追加到 `test/sandbox.test.ts` 末尾：

```ts
import { checkSandbox } from '../src/core/nouns/sandbox';
import type { SandboxConfig } from '../src/contract/sandbox';
```

（⚠️ import 要挪到文件顶部 —— vitest 不介意，但 `verbatimModuleSyntax` 与代码风格介意。**把这两行加到文件开头的 import 区**。）

```ts
describe('checkSandbox：方向与理由', () => {
  const HOME = '/home/u';
  const opts = { cwd: '/proj', home: HOME };
  const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
    enabled: true,
    deny: [],
    allow: [],
    ...over,
  });
  const reasonOf = (result: ReturnType<typeof checkSandbox>): string => {
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('沙箱没开：直接放行，规则一条都不看', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /etc/passwd', opts, config({ enabled: false, deny })).ok).toBe(true);
  });

  it('候选为空：不碰路径的命令不受影响', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('git status', opts, config({ deny })).ok).toBe(true);
  });

  it('deny 命中：拒绝，且**理由里带规则原文**', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    const reason = reasonOf(checkSandbox('rm -rf /etc/passwd', opts, config({ deny })));
    expect(reason).toContain('/etc/**');
    expect(reason).toContain('/etc/passwd');
  });

  it('白名单非空：圈外被拒，圈内放行', () => {
    const allow = [sandboxRule('/proj/**', 'allow', HOME)];
    expect(checkSandbox('rm -rf /elsewhere/x', opts, config({ allow })).ok).toBe(false);
    expect(checkSandbox('rm -rf /proj/x', opts, config({ allow })).ok).toBe(true);
  });

  it('白名单为空：只按 deny 判', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /proj/x', opts, config({ deny })).ok).toBe(true);
  });

  it('同一条路径既在白名单又被 deny：**deny 赢**', () => {
    const allow = [sandboxRule('/proj/**', 'allow', HOME)];
    const deny = [sandboxRule('/proj/secrets/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /proj/secrets/x', opts, config({ allow, deny })).ok).toBe(false);
  });

  it('相对路径按 `cwd` 解析', () => {
    const deny = [sandboxRule('/proj/out.txt', 'deny', HOME)];
    expect(checkSandbox('rm -rf out.txt', opts, config({ deny })).ok).toBe(false);
  });

  it('`~` 展开 —— 不展开的话一条 `~/.ssh/**` 会永远不命中', () => {
    const deny = [sandboxRule('~/.ssh/**', 'deny', HOME)];
    expect(checkSandbox('cat ~/.ssh/id_rsa', opts, config({ deny })).ok).toBe(false);
  });

  it('`..` 折掉 —— `/x/../etc/passwd` 与 `/etc/passwd` 等价', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /x/../etc/passwd', opts, config({ deny })).ok).toBe(false);
  });

  it('多条候选里只有一条越界就整条拒', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('cp /proj/a /etc/b', opts, config({ deny })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/sandbox.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/core/nouns/sandbox"`

- [ ] **Step 3: 写实现**

```ts
// src/core/nouns/sandbox.ts
import type { SandboxConfig } from '../../contract/sandbox';
import { candidatePaths } from '../../contract/sandbox';
import { expandHome, matchesRule, slashes } from '../../contract/policy';

/** 放行 / 拒绝 + **理由**。"被拒了但不说为什么"是这一整套东西里最招人恨的一种失败。 */
export type SandboxVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 判一条命令过不过沙箱。**纯函数、零 IO** —— 真正"不起进程"的那一步在 `process.ts` 里。
 *
 * 判定顺序（设计 §2.3）：
 * 1. 没开 → 放行（零开销）。
 * 2. 一个候选都没有 → 放行（`ls`、`git status` 这类不受影响）。
 * 3. 白名单**非空**时，每个候选都得被它接住，否则拒。
 * 4. 每个候选再过一遍 deny，任一条命中就拒。
 * 5. 全过 → 放行。
 *
 * `cwd` 用来解析相对路径，`home` 用来展开 `~` —— 这两步**必须在调用侧做**，
 * 而权限链的调用侧刻意不做（`policy.ts:62-67` 那段注释），所以这里是唯一一处。
 */
export function checkSandbox(
  command: string,
  opts: { readonly cwd: string; readonly home: string },
  config: SandboxConfig,
): SandboxVerdict {
  if (!config.enabled) return { ok: true };

  const candidates = candidatePaths(command);
  if (candidates.length === 0) return { ok: true };

  for (const token of candidates) {
    const path = absolute(token, opts);
    // 合成一个 `Write` 调用喂给权限链的匹配器：沙箱判的永远是"会不会写到"，不是"读还是写"。
    const call = { tool: 'Write', input: { file_path: path } };

    if (config.allow.length > 0 && !config.allow.some((rule) => matchesRule(rule, call))) {
      return {
        ok: false,
        reason: `路径 ${path} 不在沙箱白名单里（白名单有 ${config.allow.length} 条，只有托管层能设）。`,
      };
    }

    const denied = config.deny.find((rule) => matchesRule(rule, call));
    if (denied !== undefined) {
      return { ok: false, reason: `路径 ${path} 命中沙箱规则 ${denied.raw}` };
    }
  }

  return { ok: true };
}

/**
 * token → 绝对路径。`~` 展开、反斜杠归一、`..` 折掉、连续分隔符折一 ——
 * 后两步与 `matchesPath` 的调用侧（`policy.ts:192-202`）是同一条归一。
 */
function absolute(token: string, opts: { readonly cwd: string; readonly home: string }): string {
  const expanded = expandHome(slashes(token), slashes(opts.home));
  const rooted =
    expanded.startsWith('/') || /^[A-Za-z]:\//.test(expanded)
      ? expanded
      : `${slashes(opts.cwd).replace(/\/+$/, '')}/${expanded}`;
  return popDotSegments(rooted).replace(/\/+/g, '/');
}

/**
 * 文本折叠 `..` —— **不看文件系统**。`/x/../etc/passwd` 必须与 `/etc/passwd` 等价，
 * 否则一条 `/etc/**` 的 deny 会被两个点安静地绕过（那是 fail-open）。
 */
function popDotSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}
```

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm test test/sandbox.test.ts`
Expected: PASS（21 条）

- [ ] **Step 5: 提交**

```bash
git add src/core/nouns/sandbox.ts test/sandbox.test.ts
git commit -m "feat(core): checkSandbox —— 策略层的路径判定，复用权限链的匹配器" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: 落点 —— `process.ts` 与名词装配

**Files:**
- Modify: `src/core/nouns/process.ts`（全文 53 行，Step 2 给的是完整新版）
- Modify: `src/core/nouns/index.ts:13-27`（`CoreNounsDeps`）与 `:70`（`process:`）
- Test: `test/sandbox.test.ts`（追加「落点与结构性权威」一节）

**这一步是本轮的承重点**：判定位置在 `run` 内部、`spawn` 之前，也就是**整条权限链的下游**。

```
模型 → tool.check（权限链，五层规则，可被 allow 放宽）
        ↓ 放行
     tool.call → bash.ts → $.process.run
                            ↓  ← 沙箱在这里
                          spawn
```

任何 `allow` 规则 —— 包括用户自己写的、将来插件写的 —— 最多只能让请求**走到这儿**。**"个人规则掀不翻托管策略"于是不再靠自觉，靠位置。**

- [ ] **Step 1: 写失败的测试**

把这两行加到 `test/sandbox.test.ts` 顶部的 import 区：

```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/create';
import { bashTool } from '../src/builtins/tools/bash';
import { createPermissionsPlugin } from '../src/builtins/permissions';
import { CORE_ORIGIN } from '../src/contract/next';
import { scriptedProvider } from './harness';
```

追加到文件末尾：

```ts
describe('落点与结构性权威（沙箱在权限链下游）', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deepcode-sandbox-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 起一个真引擎：真 `Bash` 工具 + 真沙箱。`allowBash` 给不给决定测的是哪一条。 */
  async function engine(over: { sandbox?: SandboxConfig; allowBash?: boolean }) {
    return createEngine({
      plugins: [
        ...(over.allowBash === true
          ? [
              createPermissionsPlugin({
                rules: [{ raw: 'Bash', tool: 'Bash', decision: 'allow' }],
              }),
            ]
          : []),
        bashTool,
      ],
      ...(over.allowBash === true ? { seating: { permissions: 'user' as const } } : {}),
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => 'n' },
      sessionInfo: { id: 's1', cwd: dir, root: dir },
      env: {},
      ...(over.sandbox === undefined ? {} : { sandbox: { config: over.sandbox, home: dir } }),
      signal: () => new AbortController().signal,
    });
  }

  const out = () => join(dir, 'out.txt');
  const writeOut = () => `echo hello > ${out()}`;

  it('没接沙箱时 `process` 名词照旧（闸不在，就不该有任何变化）', async () => {
    const built = await engine({});
    const result = await built.$.process.run('echo hi', {
      cwd: dir,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('C1-3 圈内命令**真的执行**：退出码与输出都对', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      deny: [sandboxRule('/elsewhere/**', 'deny', dir)],
      allow: [],
    };
    const built = await engine({ sandbox });
    const result = await built.$.process.run('echo hi', {
      cwd: dir,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('C1-4 副作用验证：被拒之后**文件根本不存在**', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      deny: [sandboxRule(`${join(dir, '**')}`, 'deny', dir)],
      allow: [],
    };
    const built = await engine({ sandbox });
    expect(existsSync(out())).toBe(false);

    const result = await built.$.process.run(writeOut(), {
      cwd: dir,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    // 断言返回值只是第一层；真正的证据是**文件没被创建** —— 它比返回值难糊弄得太多。
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('[沙箱拒绝]');
    expect(existsSync(out())).toBe(false);
  });

  it('C1-5 结构性权威：给 `Bash` 配一条 `allow` 权限规则，沙箱照样拒', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      deny: [sandboxRule(`${join(dir, '**')}`, 'deny', dir)],
      allow: [],
    };
    const built = await engine({ sandbox, allowBash: true });
    const args = { tool: 'Bash', input: { command: writeOut() }, toolUseId: 'tu_1' };

    // 权限链说得很清楚：allow。但那是**上游**。
    expect(await built.dispatch('tool.check', args, CORE_ORIGIN)).toMatchObject({
      decision: 'allow',
    });

    const result = await built.dispatch('tool.call', args, CORE_ORIGIN);
    expect(JSON.stringify(result)).toContain('沙箱拒绝');
    expect(existsSync(out())).toBe(false);
  });

  it('C1-7 `enabled: false` 与"规则为空"两种情况下命令照常跑', async () => {
    const off = await engine({
      sandbox: { enabled: false, deny: [sandboxRule(`${join(dir, '**')}`, 'deny', dir)], allow: [] },
    });
    const empty = await engine({ sandbox: { enabled: true, deny: [], allow: [] } });

    for (const built of [off, empty]) {
      const result = await built.$.process.run(writeOut(), {
        cwd: dir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(out())).toBe(true);
      await rm(out(), { force: true });
    }
  });
});
```

⚠️ `beforeAll` / `afterAll` 也要加进第一行的 `vitest` import（`import { afterAll, beforeAll, describe, expect, it } from 'vitest';`）。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/sandbox.test.ts`
Expected: FAIL —— `sandbox` 不是 `CreateEngineDeps` 的字段（typecheck 层）／`[沙箱拒绝]` 没出现

- [ ] **Step 3: 改 `process.ts`**

改动很小：加 `ProcessDeps`、在**已中断检查之后、`spawn` 之前**插判定。完整新版：

```ts
import { spawn } from 'node:child_process';
import type { ProcessNoun } from '../../contract/engine';
import type { SandboxConfig } from '../../contract/sandbox';
import { checkSandbox } from './sandbox';

export type ProcessDeps = {
  /**
   * 沙箱。**省略 = 没有闸**（既有测试与一次性使用的桩都是这个分支），
   * 生产里由 `cli/main.ts` 从五层设置里透传进来。
   */
  readonly sandbox?: { readonly config: SandboxConfig; readonly home: string };
};

export function createProcessNoun(deps: ProcessDeps = {}): ProcessNoun {
  return {
    run(command, { cwd, timeoutMs, signal }) {
      // 本 turn 已经中断了就别起进程：用户刚按完 Ctrl-C，命令还照跑完，
      // 等于把那次中断当没看见。这是确认路径上的 fail-open，宁可当作已被掐断。
      if (signal.aborted) {
        return Promise.resolve({ stdout: '', stderr: '[用户中断]', exitCode: -1 });
      }

      // ⚠️ 沙箱判定在**这一层**，位于整条权限链的**下游**：任何 `allow` 规则（用户的、将来插件的）
      // 最多只能把调用送到这儿，送不到闸门外面去。这是"个人规则掀不翻托管策略"从政策层面
      // 升级成结构层面的那一步 —— 不靠自觉，靠位置（设计 §2.1）。
      //
      // 它**不是事件、不是 hook**，这是有意的：谁都能挂 hook 的东西做不了闸，
      // 一个坐在 prepend 上的第三方插件随手就能把它换掉。
      if (deps.sandbox !== undefined) {
        const verdict = checkSandbox(command, { cwd, home: deps.sandbox.home }, deps.sandbox.config);
        if (!verdict.ok) {
          // 复用名词**已有的**"没真跑成"形状（abort 与超时就是这么返回的），
          // 于是它在 bash.ts 那边**自动**变成带 `ERROR:` 前缀的工具错误给模型看 ——
          // 一行都不用改 bash.ts。
          return Promise.resolve({ stdout: '', stderr: `[沙箱拒绝] ${verdict.reason}`, exitCode: -1 });
        }
      }

      return new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (exitCode: number, extra?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr: extra ? `${stderr}\n${extra}` : stderr, exitCode });
        };

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(-1, `[命令超时 ${timeoutMs}ms 已终止]`);
        }, timeoutMs);

        const onAbort = () => {
          child.kill('SIGKILL');
          finish(-1, '[用户中断]');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // addEventListener 不会为"已经 abort 过的 signal"补发事件。上面那个入口检查
        // 到这一行之间还夹着 spawn —— 挤进这个窗口的 Ctrl-C 会就此丢失，命令照跑完。
        if (signal.aborted) onAbort();

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => finish(-1, String(err)));
        child.on('close', (code) => finish(code ?? -1));
      });
    },
  };
}
```

- [ ] **Step 4: 改 `nouns/index.ts`**

`:13-27` 的 `CoreNounsDeps`，在 `signal` 那个字段之前加一行：

```ts
  /**
   * 沙箱。`{ config, home }` —— `home` 是给候选路径里的 `~` 展开用的。
   * 省略 = 没有闸（既有测试与桩都是这个分支），生产里由 `cli/main.ts` 透传。
   */
  sandbox?: { readonly config: SandboxConfig; readonly home: string };
```

并在文件顶部加 `import type { SandboxConfig } from '../../contract/sandbox';`

`:70` 的 `process: createProcessNoun(),` 改成：

```ts
    // 直接透传 deps：`CoreNounsDeps.sandbox` 的形状与 `ProcessDeps.sandbox` 完全一样。
    process: createProcessNoun(deps),
```

- [ ] **Step 5: 跑测试，确认它通过**

Run: `pnpm test test/sandbox.test.ts && pnpm typecheck`
Expected: PASS（27 条）；typecheck 绿

- [ ] **Step 6: 反向验证一条（变异测试）**

把 `process.ts` 里那段沙箱判定的 `if (deps.sandbox !== undefined)` 整块**移到 `spawn` 之后**（或直接注释掉）。
Run: `pnpm test test/sandbox.test.ts`
Expected: `C1-4` 与 `C1-5` 两条**变红**（文件被创建了）。改回来。
**不红就说明那两条断言是摆设，修断言本身。**

- [ ] **Step 7: 提交**

```bash
git add src/core/nouns/process.ts src/core/nouns/index.ts test/sandbox.test.ts
git commit -m "feat(core): 沙箱落到 process 名词内部 —— 权限链下游那道闸" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 规则从哪来 —— `settings.ts` 读 `sandbox` 与 `compact`，并修好被牵连的字面量

**Files:**
- Modify: `src/cli/settings.ts`（多段）
- Modify: `src/cli/main.ts`（透传 `sandbox`）
- Modify: `test/cli.test.ts:46`、`:549`、`:607`
- Modify: `test/plugin-wiring.test.ts:13`
- Test: `test/settings.test.ts`（追加）

⚠️ **本任务会踩到 P4a 计划错误第 1 类（改共享常量捅了别人）**：`ResolvedPolicy` 加了两个**必填**字段，`test/cli.test.ts` 里 3 处、`test/plugin-wiring.test.ts` 里 1 处对象字面量会当场编译不过。那 4 处已经列在上面，**一处都不许漏**（漏了就是一次编译不过的提交）。

- [ ] **Step 1: 写失败的测试**

追加到 `test/settings.test.ts` 末尾（这个文件已经有 `load(table, extra)` 助手，签名是 `load(table) => { policy, warnings }`，`USER` / `PROJECT` / `LOCAL` / `MANAGED` 四个路径常量也都在）：

```ts
describe('沙箱块', () => {
  const block = (json: unknown): string => JSON.stringify({ sandbox: json });

  it('默认：关着，规则一条都没有', async () => {
    const { policy } = await load({});
    expect(policy.sandbox).toEqual({ enabled: false, deny: [], allow: [] });
  });

  it('`deny` 各层取并集，`allow` 只认托管层', async () => {
    const { policy, warnings } = await load({
      [USER]: block({ enabled: true, paths: { deny: ['~/.ssh/**'], allow: ['/home/u/**'] } }),
      [MANAGED]: block({ paths: { deny: ['/etc/**'], allow: ['/srv/**'] } }),
    });

    expect(policy.sandbox.enabled).toBe(true);
    expect(policy.sandbox.deny.map((rule) => rule.raw)).toEqual(['~/.ssh/**', '/etc/**']);
    expect(policy.sandbox.allow.map((rule) => rule.raw)).toEqual(['/srv/**']);
    // 丢掉必须有声 —— 静默丢掉一份白名单比拒收更坏。
    expect(warnings.join('\n')).toContain('白名单只有托管层能设');
  });

  it('`enabled` 是各层的**或** —— 个人能开，但关不掉托管开的闸', async () => {
    const opened = await load({ [USER]: block({ enabled: true }) });
    expect(opened.policy.sandbox.enabled).toBe(true);

    const forced = await load({
      [USER]: block({ enabled: false }),
      [MANAGED]: block({ enabled: true }),
    });
    expect(forced.policy.sandbox.enabled).toBe(true);
  });

  it('每层都是确定性断言：不做相对路径规则 —— 它永远不命中', () => {
    // 见下一条，本条只是把"绝对路径"这个前提说出来。
    expect(true).toBe(true);
  });

  it('相对路径的规则被拒收并出声（判定的候选一律是绝对路径）', async () => {
    const { policy, warnings } = await load({ [USER]: block({ enabled: true, paths: { deny: ['out.txt'] } }) });
    expect(policy.sandbox.deny).toEqual([]);
    expect(warnings.join('\n')).toContain('不是绝对路径');
  });

  it('形状写坏：**整块忽略** + 警告，不猜一个更严的', async () => {
    const { policy, warnings } = await load({ [USER]: block({ enabled: 'yes' }) });
    expect(policy.sandbox).toEqual({ enabled: false, deny: [], allow: [] });
    expect(warnings.join('\n')).toContain('sandbox 块整块忽略');

    const broken = await load({ [USER]: block({ paths: { deny: 'x' } }) });
    expect(broken.policy.sandbox.deny).toEqual([]);
    expect(broken.warnings.join('\n')).toContain('sandbox 块整块忽略');
  });

  it('`sandbox` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [USER]: block({ enabled: true }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });

  it('规则用 `~` 与反斜杠写，归一后与权限链同形', async () => {
    const { policy } = await load({ [USER]: block({ enabled: true, paths: { deny: ['~\\SSH\\**'] } }) });
    expect(policy.sandbox.deny[0]?.content).toBe(`${HOME}/SSH/**`.replace(/\\/g, '/'));
  });
});

describe('压缩块', () => {
  const block = (json: unknown): string => JSON.stringify({ compact: json });

  it('默认：自动关、阈值 100_000、保留 6 轮', async () => {
    const { policy } = await load({});
    expect(policy.compact).toEqual({ auto: false, atTokens: 100_000, keepTurns: 6 });
  });

  it('后读到的覆盖先读到的（user → project → local → flag → policy）', async () => {
    const { policy } = await load({
      [USER]: block({ auto: false, keepTurns: 10 }),
      [PROJECT]: block({ keepTurns: 4, atTokens: 5_000 }),
    });
    expect(policy.compact).toEqual({ auto: false, atTokens: 5_000, keepTurns: 4 });
  });

  it('字段级降级：类型不对只用默认值 + 出声，不整块丢', async () => {
    const { policy, warnings } = await load({
      [USER]: block({ auto: 'true', atTokens: 0, keepTurns: 1.5 }),
    });
    expect(policy.compact).toEqual({ auto: false, atTokens: 100_000, keepTurns: 6 });
    expect(warnings.join('\n')).toContain('compact.auto 不是布尔值');
    expect(warnings.join('\n')).toContain('compact.atTokens 不是正整数');
    expect(warnings.join('\n')).toContain('compact.keepTurns 不是正整数');
  });

  it('`compact` 不再被当成不认识的顶层键', async () => {
    const { warnings } = await load({ [USER]: block({ auto: true }) });
    expect(warnings.join('\n')).not.toContain('不认识的顶层键');
  });
});
```

⚠️ 这两节里 `HOME` 是 `test/settings.test.ts` 已有的常量（`'/home/u'`）。若它是别的名字，**照该文件里的实际常量改**，别新加一个。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/settings.test.ts`
Expected: FAIL —— `policy.sandbox` 是 `undefined`；且有「不认识的顶层键：sandbox」

- [ ] **Step 3: 改 `settings.ts` —— 类型与常量**

`:1-4` 的 import 区加：

```ts
import { sandboxRule, type SandboxConfig } from '../contract/sandbox';
```

`import { isSupported, parseRule, type Behavior, type Rule } from '../contract/policy';` 改成（`Behavior` 与 `Rule` 之外多取三个助手）：

```ts
import {
  expandHome,
  isSupported,
  parseRule,
  slashes,
  squeeze,
  type Behavior,
  type Rule,
} from '../contract/policy';
```

⚠️ **别直接删掉没用的**：`expandHome` / `slashes` / `squeeze` 在本任务里**其实用不到**（`sandboxRule` 已经把它们包进去了）—— 所以这一条 import 只加 `sandboxRule` 与 `SandboxConfig`，**不加那三个**。写计划时列在这儿是为了让你核对"归一的那一套确实在 `contract/sandbox.ts` 里，settings 只负责把它们读出来"。

**最终这一行是**：

```ts
import { sandboxRule, type SandboxConfig } from '../contract/sandbox';
```

在 `PLUGIN_ENABLE_SOURCES` 那一段之后加两个类型与两个常量：

```ts
/**
 * 压缩偏好。
 *
 * 它**不是权限**，挤进这份快照只是因为 `resolvePolicy` 是唯一走完五层的地方 ——
 * 为它再写一遍五层遍历，就多一处会漂的顺序（设计 §3.2）。
 */
export type CompactConfig = {
  /** 自动压缩。**默认关** —— 阈值是猜的，静默丢细节不能是默认行为。 */
  readonly auto: boolean;
  /** 跨过这个数就出声（`auto: true` 时顺手压）。**这个默认值是猜的**，见 README 的限制。 */
  readonly atTokens: number;
  /** 压缩时保留最近几轮的原文。一轮 = 一条 `role === 'user'` 消息及其之后的一切。 */
  readonly keepTurns: number;
};

export const DEFAULT_COMPACT: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 6 };

/** 沙箱没开、也没有任何规则。 */
export const EMPTY_SANDBOX: SandboxConfig = { enabled: false, deny: [], allow: [] };

/** 一层的 `sandbox` 段解析结果。`enabled` 是各层的**或**，所以逐层分开存。 */
type SandboxLayer = { readonly enabled: boolean; readonly deny: readonly Rule[]; readonly allow: readonly Rule[] };
const EMPTY_SANDBOX_LAYER: SandboxLayer = { enabled: false, deny: [], allow: [] };

/** 一层的 `compact` 段：只存这一层**写了**的字段。 */
type CompactLayer = Partial<CompactConfig>;

/** 认得出来的顶层键。**加一个顶层块就得加一项** —— 漏了就是给用户发一条假警告。 */
const KNOWN_TOP_LEVEL = new Set(['permissions', 'plugins', 'sandbox', 'compact']);
```

- [ ] **Step 4: 改 `settings.ts` —— `ResolvedPolicy` 与 `LayerRead`**

`ResolvedPolicy`（`:55-68`）里，在 `plugins` 之后加：

```ts
  /**
   * 沙箱。规则与权限规则**同一套**（`contract/policy.ts`），只是判定落在 `process` 名词里。
   */
  readonly sandbox: SandboxConfig;
  /**
   * 压缩偏好。它不是权限 —— 挤在这份"权限快照"里只因为 `resolvePolicy` 是唯一走完五层的地方。
   */
  readonly compact: CompactConfig;
```

`LayerRead`（`:184-188`）加两个字段：

```ts
type LayerRead = {
  readonly info: SourceInfo;
  readonly rules: readonly Rule[];
  readonly plugins: PluginsLayer;
  readonly sandbox: SandboxLayer;
  readonly compact: CompactLayer;
};
```

- [ ] **Step 5: 改 `settings.ts` —— `readLayer` 的四个 return**

`:199` 那一处（`where === undefined`）：

```ts
    return {
      info: base(layer, 'missing', undefined, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
    };
```

`:202-205` 的 `broken`：

```ts
  const broken = (error: string): LayerRead => {
    warn(`${label(layer.source)} ${where} ${error} —— 这一层按空处理。`);
    return {
      info: base(layer, 'broken', error, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
    };
  };
```

`:214-216` 那一处（`text === undefined`）：

```ts
  if (text === undefined) {
    return {
      info: base(layer, 'missing', undefined, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
    };
  }
```

`:230` 那一行，原文：

```ts
  const unknown = Object.keys(record).filter((key) => key !== 'permissions' && key !== 'plugins');
```

改成：

```ts
  const unknown = Object.keys(record).filter((key) => !KNOWN_TOP_LEVEL.has(key));
```

`:241` 那一行之后（`const plugins = readPlugins(...)` 与它的 `if ('broken' in plugins) return broken(...)` 之后）加：

```ts
  // ⚠️ 与 plugins 同一个道理：这两块必须在 permissions 的早期 return **之前**解析，
  // 否则一份只有 sandbox 段、没有 permissions 段的设置会把闸丢掉。
  const sandbox = readSandbox(record.sandbox, layer, where, deps.home, warn);
  const compact = readCompact(record.compact, layer, where, warn);
```

`:244-250` 那一处（`raw === undefined`）：

```ts
  if (raw === undefined) {
    return {
      info: base(layer, 'ok', undefined, [], [], plugins.value),
      rules: [],
      plugins: plugins.value,
      sandbox,
      compact,
    };
  }
```

`:293-297` 最后一处：

```ts
  return {
    info: base(layer, 'ok', undefined, problems, rules, plugins.value),
    rules,
    plugins: plugins.value,
    sandbox,
    compact,
  };
```

- [ ] **Step 6: 改 `settings.ts` —— 加两个解析函数**

放在 `readPlugins` 之后、`base` 之前：

```ts
/**
 * 解析一层的 `sandbox` 段。
 *
 * 形状错的处置**与 `permissions` 不同**：这里只丢掉这一层这一块，不废掉整份文件。
 * 理由在设计 §6 的失败行为表里：沙箱是"多一道闸"，不是"判定权限"。猜一个更严的会把用户的
 * 正常命令全拒掉（比不沙箱更糟），猜松则等于没配 —— **读不懂就不动**，与 `parseRule`
 * 对不认识的规则的处理一致。
 */
function readSandbox(
  value: unknown,
  layer: Layer,
  where: string,
  home: string,
  warn: (line: string) => void,
): SandboxLayer {
  const ignore = (why: string): SandboxLayer => {
    warn(`${label(layer.source)} ${where} 的 sandbox 块整块忽略 —— ${why}`);
    return EMPTY_SANDBOX_LAYER;
  };

  if (value === undefined) return EMPTY_SANDBOX_LAYER;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ignore('不是一个对象');

  const record = value as Record<string, unknown>;

  let enabled = false;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') return ignore('enabled 不是布尔值');
    enabled = record.enabled;
  }

  let deny: readonly Rule[] = [];
  let allow: readonly Rule[] = [];

  const paths = record.paths;
  if (paths !== undefined) {
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return ignore('paths 不是一个对象');
    const list = paths as Record<string, unknown>;

    const denyRules = readSandboxList(list.deny, layer, where, home, 'deny', warn);
    if (denyRules === undefined) return ignore('paths.deny 不是字符串数组');
    const allowRules = readSandboxList(list.allow, layer, where, home, 'allow', warn);
    if (allowRules === undefined) return ignore('paths.allow 不是字符串数组');
    deny = denyRules;
    allow = allowRules;

    const unknown = Object.keys(list).filter((key) => key !== 'deny' && key !== 'allow');
    if (unknown.length > 0) {
      warn(`${label(layer.source)} ${where} 的 sandbox.paths 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
    }
  }

  const unknownTop = Object.keys(record).filter((key) => key !== 'enabled' && key !== 'paths');
  if (unknownTop.length > 0) {
    warn(`${label(layer.source)} ${where} 的 sandbox 里有不认识的子键：${unknownTop.join('、')}（已忽略）。`);
  }

  return { enabled, deny, allow };
}

/**
 * 一条沙箱路径列表。形状不对返回 `undefined`（调用方**整块忽略**）；
 * 单条规则坏了只丢那一条（方向是**不收紧**，所以必须出声 —— 与 permissions 同一条）。
 */
function readSandboxList(
  value: unknown,
  layer: Layer,
  where: string,
  home: string,
  key: 'deny' | 'allow',
  warn: (line: string) => void,
): Rule[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;

  const out: Rule[] = [];
  for (const text of value as string[]) {
    const trimmed = squeeze(text);
    if (trimmed === '') {
      warn(`${label(layer.source)} ${where} 这条不生效 —— sandbox.paths.${key} 里有一条是空的。`);
      continue;
    }
    // 判定的候选**一律**被解析成绝对路径，所以相对路径的规则永远不命中。
    // 静默失效比拒收更坏：写的人会以为自己在防一件其实没防的事。
    if (!isAbsoluteLike(trimmed)) {
      warn(
        `${label(layer.source)} ${where} 这条不生效 —— sandbox.paths.${key} 里的 ${JSON.stringify(text)} 不是绝对路径（\`~\` 可以），相对路径在判定时无从解析。`,
      );
      continue;
    }
    out.push(sandboxRule(text, key, home));
  }
  return out;
}

/** 绝对路径式：`/…`、`~/…`、`C:/…`（反斜杠也认，`slashes` 在后面统一）。 */
function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 解析一层的 `compact` 段。**字段级降级**：只有那一个字段类型不对时用默认值 + 出声，
 * 不整块忽略 —— 它不是权限，没有"猜严/猜松"的方向问题。
 */
function readCompact(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): CompactLayer {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 compact 块整块忽略 —— 不是一个对象。`);
    return {};
  }

  const record = value as Record<string, unknown>;
  const out: { auto?: boolean; atTokens?: number; keepTurns?: number } = {};

  if (record.auto !== undefined) {
    if (typeof record.auto === 'boolean') out.auto = record.auto;
    else warn(`${label(layer.source)} ${where} compact.auto 不是布尔值，按默认值处理。`);
  }

  for (const key of ['atTokens', 'keepTurns'] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) out[key] = raw;
    else warn(`${label(layer.source)} ${where} compact.${key} 不是正整数，按默认值处理。`);
  }

  const unknown = Object.keys(record).filter(
    (key) => key !== 'auto' && key !== 'atTokens' && key !== 'keepTurns',
  );
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 compact 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return out;
}
```

- [ ] **Step 7: 改 `settings.ts` —— `resolvePolicy` 的汇总**

`:139-140` 两个 Map 之后加：

```ts
  const sandboxLayers = new Map<SettingsSource, SandboxLayer>();
  const compactLayers = new Map<SettingsSource, CompactLayer>();
```

`:142-147` 那个循环里，`pluginsBySource.set(...)` 之后加两行：

```ts
    sandboxLayers.set(layer.source, read.sandbox);
    compactLayers.set(layer.source, read.compact);
```

`:152-169` 的 return 之前，插入汇总并把两个字段合进 return：

```ts
  // ── 沙箱 ──
  // `deny` 各层**取并集**：任何来源都能往这儿加，它只会让闸更严。
  // `allow` **只有托管层能设** —— 与 `plugins.enable` 同一条道理：让个人配置能写白名单，
  // 等于让它一句话掀掉托管策略设的圈。
  // `enabled` 是各层的**或**：开闸只能靠有人明确要开，没有默认值能把它悄悄打开；
  // 而"个人想关掉托管打开的闸"正是"个人掀翻托管"，方向不对。
  const sandbox: SandboxConfig = {
    enabled: SETTINGS_SOURCES.some((source) => sandboxLayers.get(source)?.enabled === true),
    deny: SETTINGS_SOURCES.flatMap((source) => sandboxLayers.get(source)?.deny ?? []),
    allow: sandboxLayers.get('policy')?.allow ?? [],
  };
  for (const source of SETTINGS_SOURCES) {
    if (source === 'policy') continue;
    if ((sandboxLayers.get(source)?.allow.length ?? 0) > 0) {
      warn(`${label(source)} 里写了 sandbox.paths.allow —— 白名单只有托管层能设，这一份已丢弃。`);
    }
  }

  // ── 压缩偏好 ──
  // 后读到的覆盖先读到的（数组顺序就是低 → 高）。它没有"更严/更松"的方向，
  // 硬套权限那一套只会造出一条解释不通的规则。
  const compact: CompactConfig = { ...DEFAULT_COMPACT };
  for (const source of SETTINGS_SOURCES) {
    Object.assign(compact, compactLayers.get(source) ?? {});
  }

  return {
    sources,
    // policy 源 vs. 其余全部 —— 在固定优先级下这是唯一承重的划分（设计 §4.3）。
    policyRules: bySource.get('policy') ?? [],
    personalRules: SETTINGS_SOURCES.filter((s) => s !== 'policy').flatMap((s) => bySource.get(s) ?? []),
    sandbox,
    compact,
    plugins: {
      // （原有内容一字不动）
```

- [ ] **Step 8: 修那 4 处被牵连的字面量**

`test/cli.test.ts:21` 的 import 改成：

```ts
import { DEFAULT_COMPACT, EMPTY_SANDBOX, type ResolvedPolicy } from '../src/cli/settings';
```

`:46-51` 的 `NO_POLICY`：

```ts
const NO_POLICY: ResolvedPolicy = {
  sources: [],
  policyRules: [],
  personalRules: [],
  sandbox: EMPTY_SANDBOX,
  compact: DEFAULT_COMPACT,
  plugins: NO_PLUGINS,
};
```

`:549` 的 `fixturePolicy()`：在 `personalRules: [...]` 之后、`plugins: NO_PLUGINS,` 之前插两行：

```ts
      sandbox: EMPTY_SANDBOX,
      compact: DEFAULT_COMPACT,
```

`:607` 的 `empty`：

```ts
    const empty: ResolvedPolicy = {
      sources: [],
      policyRules: [],
      personalRules: [],
      sandbox: EMPTY_SANDBOX,
      compact: DEFAULT_COMPACT,
      plugins: NO_PLUGINS,
    };
```

`test/plugin-wiring.test.ts:11` 的 import 改成：

```ts
import { DEFAULT_COMPACT, EMPTY_SANDBOX, type ResolvedPolicy } from '../src/cli/settings';
```

`:13-18` 的 `POLICY`：

```ts
const POLICY: ResolvedPolicy = {
  sources: [],
  policyRules: [],
  personalRules: [],
  sandbox: EMPTY_SANDBOX,
  compact: DEFAULT_COMPACT,
  plugins: { enable: [], deny: [] },
};
```

- [ ] **Step 9: 改 `main.ts` —— 把沙箱透传进引擎**

`:245-257` 的 `createEngine({...})` 调用里，在 `signal:` 那一行**之前**加：

```ts
    // 沙箱：五层设置里读出来的规则 + `~` 展开用的 home。省略 = 没有闸。
    sandbox: { config: policy.sandbox, home },
```

- [ ] **Step 10: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/settings.test.ts`
Expected: typecheck 绿；settings 用例全绿

- [ ] **Step 11: 反向验证一条**

把 `resolvePolicy` 里 `allow: sandboxLayers.get('policy')?.allow ?? []` 改成
`allow: SETTINGS_SOURCES.flatMap((s) => sandboxLayers.get(s)?.allow ?? [])`。
Run: `pnpm test test/settings.test.ts`
Expected: 「`deny` 各层取并集，`allow` 只认托管层」**变红**（个人层的 `/home/u/**` 混进来了）。改回来。

- [ ] **Step 12: 提交**

```bash
git add src/cli/settings.ts src/cli/main.ts test/settings.test.ts test/cli.test.ts test/plugin-wiring.test.ts
git commit -m "feat(cli): 设置里读 sandbox 与 compact，白名单只认托管层" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: 把 token 数据接上 —— `Usage` 与两个适配器

**Files:**
- Modify: `src/contract/model-provider.ts:34-38`
- Modify: `src/providers/anthropic.ts`
- Modify: `src/providers/openai.ts:42-48`、`:82-83`、`:116`
- Test: `test/provider.test.ts`、`test/openai.test.ts`

⚠️ 这一节的两个事实是写计划时**逐行读源码**才发现的，设计文档里没有：
- `anthropic.ts` **完全没有 `message_start` 分支** —— 而 `usage.input_tokens` 正是在那一帧里。
- `openai.ts:82-83` 的 `if (!choice) continue;` 会把**只带 usage 的那一帧**（`choices` 是空数组）整个跳过。

- [ ] **Step 1: 写失败的测试**

追加到 `test/provider.test.ts` 末尾：

```ts
describe('usage', () => {
  it('message_start 的 input_tokens 与 message_delta 的 output_tokens 归一成 usage', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":123,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":45}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: '好' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
  });

  it('端点没报 usage：`done` 上就没有 usage 这个字段（不塞 0）', async () => {
    stub([
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    expect(await collect()).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('只报了一半：整份不带 —— 报半个账比不报更坏', async () => {
    stub([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":123}}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    expect(await collect()).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });
});
```

追加到 `test/openai.test.ts` 末尾：

```ts
describe('usage', () => {
  it('`include_usage` 那一帧（choices 为空）也能被读到', async () => {
    stub([
      frame({ choices: [{ delta: { content: '好' } }] }),
      frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      'data: [DONE]\n\n',
    ]);

    expect(await collect()).toEqual([
      { type: 'text', text: '好' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } },
    ]);
  });

  it('请求体里带上了 `stream_options.include_usage`', async () => {
    let body: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = init.body as string;
        return sseResponse(['data: [DONE]\n\n']);
      }),
    );

    await collect();
    expect(JSON.parse(body!)).toMatchObject({ stream_options: { include_usage: true } });
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/provider.test.ts test/openai.test.ts`
Expected: FAIL —— `done` 上没有 `usage`

- [ ] **Step 3: 改 `contract/model-provider.ts`**

`:34-38` 的 `StreamEvent`，原文：

```ts
/** provider 的流式输出。文本增量即时产出；工具调用在参数收齐后一次性产出。 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'done'; readonly stopReason: string };
```

改成：

```ts
/**
 * 一次调用的用量。**只在端点真报了的时候才带** —— 缺了就缺了，塞 0 是撒谎
 * （`turn.complete` 的 `inputTokens` 曾经长期写死 0，压缩器拿到的信号一直是"上下文是空的"）。
 */
export type Usage = { readonly inputTokens: number; readonly outputTokens: number };

/** provider 的流式输出。文本增量即时产出；工具调用在参数收齐后一次性产出。 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'done'; readonly stopReason: string; readonly usage?: Usage };

/**
 * 两家适配器共用的归一：`input` 是 anthropic 的 `input_tokens` / openai 的 `prompt_tokens`，
 * 同理 `output`。
 *
 * **只有两个都是有限数才成一份 usage。** 缺一个就当整份没有 —— 报半个账比不报更坏：
 * 消费端会拿它当"这一轮就这么点输入"去比阈值。
 */
export function toUsage(input: unknown, output: unknown): Usage | undefined {
  const inputTokens = count(input);
  const outputTokens = count(output);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
```

- [ ] **Step 4: 改 `anthropic.ts`**

`:1-7` 的 import 加 `Usage`：

```ts
import type {
  ContentBlock,
  Message,
  ModelProvider,
  StreamEvent,
  ToolSpec,
  Usage,
} from '../contract/model-provider';
import { toUsage } from '../contract/model-provider';
```

（或并成一条 `import { toUsage, type ContentBlock, ... }`；`verbatimModuleSyntax` 下 `type` 修饰符要写对。）

`:52-53`，原文：

```ts
      const pending = new Map<number, { type: string; id: string; name: string; json: string }>();
      let stopReason = 'end_turn';
```

改成：

```ts
      const pending = new Map<number, { type: string; id: string; name: string; json: string }>();
      let stopReason = 'end_turn';
      // 两份用量分两次到达：Anthropic 在 `message_start` 里给 `input_tokens`，
      // 在末尾的 `message_delta` 里给 `output_tokens`。少接一个就会报半个假账。
      let inputTokens: unknown;
      let outputTokens: unknown;
```

`:55-56` 的循环开头，在 `if (frame.event === 'content_block_start') {` **之前**插入一个分支：

```ts
        if (frame.event === 'message_start') {
          // 这一帧此前**完全没有被处理过** —— `usage.input_tokens` 就藏在它里面。
          const data = JSON.parse(frame.data);
          inputTokens = data?.message?.usage?.input_tokens ?? inputTokens;
        } else if (frame.event === 'content_block_start') {
```

⚠️ 注意：原来的第一个分支是 `if (frame.event === 'content_block_start')`，插进去之后它要变成 `else if`。**整条链一起改**，别只加一个 `if`（那会变成两个独立的 `if`，`content_block_start` 仍会被两边都判一次 —— 逻辑上还能跑，但读起来是错的）。

`:84-86` 的 `message_delta` 分支，原文：

```ts
        } else if (frame.event === 'message_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        } else if (frame.event === 'error') {
```

改成：

```ts
        } else if (frame.event === 'message_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          outputTokens = data?.usage?.output_tokens ?? outputTokens;
        } else if (frame.event === 'error') {
```

`:98-99` 与 `:104-105` 两处 `yield { type: 'done', stopReason } satisfies StreamEvent;` 都改成：

```ts
          yield doneEvent(stopReason, toUsage(inputTokens, outputTokens));
```

（第二处的缩进是 4 空格。）并在文件末尾加：

```ts
/** 没有用量就不带那个字段 —— 带上一个 `usage: undefined` 会让"端点报了"与"端点没报"长得一样。 */
function doneEvent(stopReason: string, usage: Usage | undefined): StreamEvent {
  return usage === undefined ? { type: 'done', stopReason } : { type: 'done', stopReason, usage };
}
```

- [ ] **Step 5: 改 `openai.ts`**

`:1-7` 的 import 同样加 `Usage` 与 `toUsage`。

`:42-48` 的请求体，原文：

```ts
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: config.maxTokens ?? 8192,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
          stream: true,
        }),
```

改成：

```ts
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: config.maxTokens ?? 8192,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
          stream: true,
          // 用量只在**最后一帧**单独来，而且那一帧的 `choices` 是空数组 —— 不显式要，端点根本不发。
          //
          // ⚠️ 兼容风险：这是 OpenAI 后来的字段，严格的兼容端点可能不认它而回 400。
          // 认不认由端点自己说：真被挡回来时那句报错里有原因（见 providers/http.ts），
          // 那比"永远拿不到用量"清楚。
          stream_options: { include_usage: true },
        }),
```

`:57-59`，原文：

```ts
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = 'end_turn';
```

改成（多两行）：

```ts
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = 'end_turn';
      let inputTokens: unknown;
      let outputTokens: unknown;
```

`:82-83`，原文：

```ts
        const choice = parsed?.choices?.[0];
        if (!choice) continue;
```

改成：

```ts
        // 用量那一帧的 `choices` 是**空数组**。原来是 `if (!choice) continue;` 把它整个跳过的
        // —— 加了 `stream_options.include_usage` 之后，那一帧就是唯一的用量来源。
        inputTokens = parsed?.usage?.prompt_tokens ?? inputTokens;
        outputTokens = parsed?.usage?.completion_tokens ?? outputTokens;

        const choice = parsed?.choices?.[0];
        if (!choice) continue;
```

`:116`，原文：

```ts
      yield { type: 'done', stopReason } satisfies StreamEvent;
```

改成：

```ts
      yield doneEvent(stopReason, toUsage(inputTokens, outputTokens));
```

并在文件末尾加同样那个 `doneEvent` 助手（两个适配器各一份，与它们各自解析 SSE 的方式一样，是**逐文件**的东西）：

```ts
/** 没有用量就不带那个字段 —— 带上一个 `usage: undefined` 会让"端点报了"与"端点没报"长得一样。 */
function doneEvent(stopReason: string, usage: Usage | undefined): StreamEvent {
  return usage === undefined ? { type: 'done', stopReason } : { type: 'done', stopReason, usage };
}
```

- [ ] **Step 6: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/provider.test.ts test/openai.test.ts`
Expected: 全绿。**特别确认既有的 SSE 用例都没被打破**（`done` 事件在"没有 usage"那一路形状一字不变）。

- [ ] **Step 7: 提交**

```bash
git add src/contract/model-provider.ts src/providers/anthropic.ts src/providers/openai.ts test/provider.test.ts test/openai.test.ts
git commit -m "feat(providers): 两个适配器解析真实 usage，接上 message_start 与 include_usage" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: `loop.ts` —— 把 usage 填进 `turn.complete`

**Files:**
- Modify: `src/contract/events.ts:21-25`
- Modify: `src/core/loop.ts`
- Test: `test/loop-options.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

追加到 `test/loop-options.test.ts` 末尾：

```ts
describe('用量落到 turn.complete 上', () => {
  const ENGINE = {
    tool: { list: () => [] },
    logger: { debug: () => {}, warn: () => {} },
    ui: { log: () => {}, notice: () => {}, ask: async () => 'n' },
  } as unknown as EngineInterface;

  /** 跑一轮，把 `turn.complete` 的参数收下来。 */
  async function run(events: readonly StreamEvent[], system = '提示', text = '干活') {
    const h = createHarness({ engine: ENGINE });
    const seen: { stopReason: string; inputTokens: number; outputTokens: number; usageEstimated?: boolean }[] = [];
    h.on('builtin', 'spy', 'turn.complete', (e) => {
      seen.push(e as unknown as (typeof seen)[number]);
      return {};
    });

    const provider: ModelProvider = {
      name: 'stub',
      async *stream() {
        for (const event of events) yield event;
      },
    };
    const messages: Message[] = [{ role: 'user', content: text }];
    await runTurn(
      {
        $: ENGINE,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: system,
        turnIndex: 0,
      },
      messages,
    );
    return seen;
  }

  it('端点报了：原样填进去，且不带 `usageEstimated`', async () => {
    const seen = await run([
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
    expect(seen).toEqual([
      { stopReason: 'end_turn', inputTokens: 123, outputTokens: 45 },
    ]);
  });

  it('端点没报：回落估计，并**标出来**', async () => {
    const seen = await run([{ type: 'done', stopReason: 'end_turn' }]);
    expect(seen).toEqual([
      {
        stopReason: 'end_turn',
        inputTokens: estimateTokens('提示'.length + '干活'.length),
        outputTokens: 0,
        usageEstimated: true,
      },
    ]);
  });

  it('`onUsage` 收到同一份数据（自动压缩的触发信号从这儿走）', async () => {
    const h = createHarness({ engine: ENGINE });
    h.on('builtin', 'spy', 'turn.complete', () => ({}));
    const got: unknown[] = [];
    const provider: ModelProvider = {
      name: 'stub',
      async *stream() {
        yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 3 } } as const;
      },
    };

    await runTurn(
      {
        $: ENGINE,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: 's',
        turnIndex: 0,
        onUsage: (usage) => got.push(usage),
      },
      [{ role: 'user', content: '干活' }],
    );

    expect(got).toEqual([{ inputTokens: 9, outputTokens: 3, estimated: false }]);
  });
});
```

`test/loop-options.test.ts` 顶部的 import 要补：

```ts
import { estimateTokens, runTurn } from '../src/core/loop';
import { createHarness } from './harness';
import type { EngineInterface } from '../src/contract/engine';
import type { Message } from '../src/contract/model-provider';
```

（`runTurn` 已经 import 过，别重复 —— 把 `estimateTokens` 加进那一行。）

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/loop-options.test.ts`
Expected: FAIL —— 拿到的还是 `inputTokens: 0`；`estimateTokens` 不存在

- [ ] **Step 3: 改 `contract/events.ts` 的 `turn.complete` 入参**

`:21-25`，原文：

```ts
  'turn.complete': {
    readonly stopReason: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
```

改成：

```ts
  'turn.complete': {
    readonly stopReason: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /**
     * `true` = 上面两个数是**字符 ÷ 4 估的**，不是端点报的。
     * 省略 = 端点报的真数。（`outputTokens: 0` 配上这个标记是常态：估得出输入，估不出输出。）
     */
    readonly usageEstimated?: boolean;
  };
```

- [ ] **Step 4: 改 `loop.ts`**

`:1-10` 的 import 加 `Usage`：

```ts
import type {
  ContentBlock,
  Message,
  ModelProvider,
  ToolResult,
  ToolSpec,
  Usage,
} from '../contract/model-provider';
```

`LoopContext`（`:15-36`）在 `onText` 之后加：

```ts
  /**
   * 每一轮结束时把用量报出去（与 `turn.complete` 是同一条数据）。
   *
   * 自动压缩的触发信号从这儿走，**不是**靠一个监听 `turn.complete` 的插件：插件拿不到
   * `dispatch`，而压缩前后要派 `session.compact`。
   */
  onUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimated: boolean;
  }) => void;
```

在文件末尾加两个导出助手：

```ts
/**
 * 一段文本的 token 数**粗估**。参数是**字符数**不是文本 —— 两处调用方手里本来就是长度。
 *
 * ⚠️ 它是估计，不是测量：中英混排会失真（中文一个字约 1–2 个 token，不是 0.25 个）。
 * 之所以留着它，是因为"什么都不报"比"报一个标出来的估计"更坏 —— 前者让消费端
 * 以为上下文是空的。
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 一个消息数组的**字符数**。工具结果与工具入参都算进去 —— 它们也是要占窗口的东西。 */
export function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      total += message.content.length;
    } else if (message.role === 'tool') {
      for (const result of message.results) total += result.content.length;
    } else {
      for (const block of message.content) {
        total +=
          block.type === 'text' ? block.text.length : JSON.stringify(block.input ?? {}).length;
      }
    }
  }
  return total;
}

/** 这一轮的用量。端点报了就报真的；没报就估算并**标出来**。 */
function turnUsage(
  usage: Usage | undefined,
  systemPrompt: string,
  messages: readonly Message[],
): { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean } {
  if (usage !== undefined) {
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: false };
  }
  return {
    inputTokens: estimateTokens(systemPrompt.length + messageChars(messages)),
    outputTokens: 0,
    estimated: true,
  };
}
```

- [ ] **Step 5: 改 `loop.ts` 里 `runTurn` 的两处收场**

`:46` 之后（`await ctx.dispatch('turn.start', ...)` 那一行之后）加两行，并把 `complete` 定义插在 `for` 循环之前：

```ts
  // 两处收场（失败与正常）共用这一份 —— 原先它们各自写死 `inputTokens: 0`，
  // 于是 `turn.complete` 长期在报假账，而压缩器唯一的信号就是它。
  let usage: Usage | undefined;
  const complete = async (reason: string): Promise<void> => {
    const tokens = turnUsage(usage, ctx.systemPrompt, messages);
    ctx.onUsage?.(tokens);
    await ctx.dispatch(
      'turn.complete',
      // 估的时候才带这个字段：带上一个 `false` 会让"端点报了"与"我们猜的"长得一模一样，
      // 而消费端要把这两件事分开。
      tokens.estimated
        ? {
            stopReason: reason,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            usageEstimated: true,
          }
        : { stopReason: reason, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens },
      CORE_ORIGIN,
    );
  };
```

`:62-69` 的重试循环开头，那段 `blocks.length = 0; toolUses.length = 0; text = '';` 之后加一行：

```ts
      usage = undefined; // 与 text 同一个道理：重试的那一次不该继承上一次的用量
```

`:71-97` 的 `for await` 里，最后那个 `else` 分支（`:94-96`）原文：

```ts
          } else {
            stopReason = event.stopReason;
          }
```

改成：

```ts
          } else {
            stopReason = event.stopReason;
            usage = event.usage;
          }
```

`:115-128` 的失败收场，原文：

```ts
      const interrupted = ctx.signal.aborted;
      ctx.$.ui.notice(
        interrupted
          ? '这一回合已被中断（会话保留，可以继续输入）'
          : `本 turn 失败：${failure}（会话保留，可以继续输入）`,
      );
      await ctx.dispatch(
        'turn.complete',
        { stopReason: interrupted ? 'interrupted' : 'error', inputTokens: 0, outputTokens: 0 },
        CORE_ORIGIN,
      );
      return interrupted ? 'interrupted' : 'error';
```

改成：

```ts
      const interrupted = ctx.signal.aborted;
      ctx.$.ui.notice(
        interrupted
          ? '这一回合已被中断（会话保留，可以继续输入）'
          : `本 turn 失败：${failure}（会话保留，可以继续输入）`,
      );
      await complete(interrupted ? 'interrupted' : 'error');
      return interrupted ? 'interrupted' : 'error';
```

`:155-159` 的正常收场，原文：

```ts
  await ctx.dispatch(
    'turn.complete',
    { stopReason, inputTokens: 0, outputTokens: 0 },
    CORE_ORIGIN,
  );
  return stopReason;
```

改成：

```ts
  await complete(stopReason);
  return stopReason;
```

- [ ] **Step 6: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/loop-options.test.ts test/dispatch.test.ts test/agent-noun.test.ts`
Expected: 全绿。`dispatch.test.ts` 那条生命周期清单用 `toEqual` 比对 `{stopReason, inputTokens: 0, outputTokens: 0}`，而 `toEqual` 忽略值为 `undefined` 的键 —— 它应该仍然绿；**若它红了，说明你在估的那条路上多带了字段**，别改那条测试，改 `complete`。

- [ ] **Step 7: 提交**

```bash
git add src/contract/events.ts src/core/loop.ts test/loop-options.test.ts
git commit -m "feat(core): turn.complete 报真用量，拿不到时用估计并标出来" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: 落盘游标 —— `createPersister` 的 `reseed`

**Files:**
- Modify: `src/cli/transcript.ts:87-124`
- Test: `test/transcript.test.ts`（追加）

**这是本轮唯一一处会静默损坏数据的地方。** 压缩把 `messages` 改短，而 `createPersister` 内部的 `written` 游标不跟着走：
- 短于旧游标的期间落盘**静默停止**（不报错，什么都没写）；
- 等数组再长过旧游标，`slice(written)` 取到的是**错位的一批**。

- [ ] **Step 1: 写失败的测试**

追加到 `test/transcript.test.ts` 末尾（这个文件已有 `home` 临时目录与 `seed()` 助手）：

```ts
describe('reseed：压缩把数组改短之后的逃生口', () => {
  it('reseed 之后，新消息照样落盘', async () => {
    const cwd = join(home, 'reseed-a');
    const first: Message[] = [userMessage('一'), userMessage('二'), userMessage('三')];
    const transcript = await seed(cwd, first);
    const persist = createPersister(transcript, first.length, () => {});

    // 假装压缩：内存里只剩一条，而盘上还是三条。
    const memory: Message[] = [userMessage('摘要')];
    await persist(memory);
    expect((await readTranscript(transcript.path)).messages.length).toBe(3);

    persist.reseed(memory.length);
    memory.push(userMessage('四'));
    await persist(memory);

    const onDisk = (await readTranscript(transcript.path)).messages;
    // 盘上**保留**被压掉的那三条（压缩不改历史文件），后面接着写新的 —— 不错位、不重复。
    expect(onDisk.slice(0, 3)).toEqual(first);
    expect(onDisk.slice(3)).toEqual([userMessage('四')]);
  });

  it('没有 reseed 的时候会**静默停止** —— 这条钉的是那个陷阱本身', async () => {
    const cwd = join(home, 'reseed-b');
    const first: Message[] = [userMessage('一'), userMessage('二'), userMessage('三')];
    const transcript = await seed(cwd, first);
    const persist = createPersister(transcript, first.length, () => {});

    const memory: Message[] = [userMessage('摘要')];
    await persist(memory);
    memory.push(userMessage('四'));
    await persist(memory); // 没有 reseed：2 <= 3，静默什么都不写

    expect((await readTranscript(transcript.path)).messages.length).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/transcript.test.ts`
Expected: FAIL —— `persist.reseed is not a function`

- [ ] **Step 3: 改实现**

`src/cli/transcript.ts:97-101`，原文：

```ts
export function createPersister(
  transcript: Transcript | undefined,
  alreadySaved: number,
  onError?: (line: string) => void,
): (messages: readonly Message[]) => Promise<void> {
  let written = alreadySaved;
  let complained = false;

  return async (messages: readonly Message[]): Promise<void> => {
```

改成：

```ts
export type Persister = {
  (messages: readonly Message[]): Promise<void>;
  /**
   * 把落盘游标重置到 `length`。
   *
   * ⚠️ **压缩把 `messages` 改短之后必须调。** 内部游标 `written` 记的是"已经落盘到第几条"，
   * 而压缩是 CLI 原地把数组换短 —— 不重置的话：短于旧游标的期间落盘**静默停止**（不报错、
   * 什么都没写），等数组再长过旧游标时 `slice(written)` 取到的是**错位的一批**。
   * 这是 P4b 里唯一一处会静默损坏数据的地方（设计 §3.5）。
   *
   * 注意它重置的是**游标**，不是文件：已经落盘的历史一个字都不动，
   * 所以 `--resume` 接回来的仍然是那份未压缩的完整对话。这是有意的。
   */
  reseed(length: number): void;
};

export function createPersister(
  transcript: Transcript | undefined,
  alreadySaved: number,
  onError?: (line: string) => void,
): Persister {
  let written = alreadySaved;
  let complained = false;

  const persist = async (messages: readonly Message[]): Promise<void> => {
```

并把那个 return 之前的所有 `return async (messages) => {...}` 体内的代码**一字不动**地留在 `persist` 里；原本这个箭头函数是直接 `return` 的，现在结尾要改。

原结尾（`:105-123`）结构是：

```ts
  return async (messages: readonly Message[]): Promise<void> => {
    if (transcript === undefined) return;
    if (messages.length <= written) return;
    ...
    } catch (error) {
      if (!complained) {
        complained = true;
        onError?.(`会话无法落盘（${transcript.path}）：${String(error)}`);
      }
    }
  };
}
```

改成：

```ts
  const persist = async (messages: readonly Message[]): Promise<void> => {
    if (transcript === undefined) return;
    if (messages.length <= written) return;
    ...
    } catch (error) {
      if (!complained) {
        complained = true;
        onError?.(`会话无法落盘（${transcript.path}）：${String(error)}`);
      }
    }
  };

  // 用 `Object.assign` 而不是 `as Persister` 铸型：铸型会把"少写了 reseed"这件事一起瞒过去，
  // 而少写 reseed 正是这一轮唯一一处会静默损坏数据的地方。
  return Object.assign(persist, {
    reseed: (length: number): void => {
      written = length;
    },
  });
}
```

⚠️ **函数体内部（`if (transcript === undefined) return;` 到 `}` 那段）一个字都不要改**，只改"箭头函数从 `return` 位置挪到 `const persist =`"。这是 P4a 教训第 2 类（同一个错抄两遍）最容易发生的地方。

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/transcript.test.ts`
Expected: 全绿（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/cli/transcript.ts test/transcript.test.ts
git commit -m "feat(cli): 落盘器加 reseed 逃生口 —— 压缩改短数组后的那条静默损坏路径" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: `session.compact` 转正

**Files:**
- Modify: `src/contract/events.ts`（三处）
- Modify: `test/dispatch.test.ts`（两处）
- Modify: `src/contract/classic.ts:12`（旧计数注释）

⚠️ **P4a 的教训（计划错误第 2 类）：把一个声明-only 的事件转正时，先 `grep` 一遍它的名字，看看谁把它当"未实现"在测。**

```bash
grep -rn "session.compact" src test
```
Expected: 只有 `src/contract/events.ts:145`（`UnimplementedEvent` 那一行）。**若出现别的，先处理它。**

- [ ] **Step 1: 改 `contract/events.ts`**

`:38-57` 那一族（P4a 转正的三个）之后追加（`'skill.prompt'` 那一条的后面）：

```ts

  // ── P4b 转正的一个 ──

  /**
   * 发生过一次上下文压缩。**纯通知**，与 `session.start` 同一族 —— 结果类型是空对象。
   *
   * 它**不返回压缩后的 messages**：压缩是 CLI 自己的事，把结果做成可变的东西会让它变成一个
   * **权威**事件，而权威事件是要 fail-closed 的 —— 那正好与"摘要失败就干脆不压、宁可上下文
   * 继续涨"的方向相反（设计 §3.4/§3.6）。
   *
   * 派发时机是**压缩之前**：`tokensBefore` 这个名字只有在改之前派才说得通，
   * 而 `PreCompact` 该看到的本来就该是压缩前的状态。
   */
  'session.compact': { readonly trigger: 'manual' | 'auto'; readonly tokensBefore: number };
```

`EventResult`（`:60-85`）里，`'skill.prompt': { readonly text: string };` 之后加：

```ts
  'session.compact': Record<string, never>;
```

`UnimplementedEvent`（`:132-148`）里删掉这一行：

```ts
  | 'session.compact'
```

`NOTIFICATION_EVENTS`（`:186-195`）里，`'agent.spawn',` 之后加：

```ts
  // P4b：压缩也是"让插件看得见"这一类 —— 它没有任何一条需要内核答复。
  // 靠链尾兜底而不是在 createEngine 的 coreImpls 里补一条：见本文件上面那段注释
  // （"放在链尾意味着任何 dispatcher 都天然满足这条不变量，没有第二个地方可以漏"）。
  'session.compact',
```

- [ ] **Step 2: 顺手改掉三处旧计数（P4a 漏掉的）**

`src/contract/events.ts:6`，原文：

```ts
// 第一族：MVP 实际实现链的 12 个事件
```

改成：

```ts
// 第一族：已实现链的事件（P4b 之后 16 个）
```

`src/contract/events.ts:32`，原文：

```ts
   * 这是**契约变宽**，不是新事件：39 声明 / 12 实现那两项计数都不变。
```

改成：

```ts
   * 这是**契约变宽**，不是新事件：39 声明 / 16 实现那两项计数都不变。
```

`src/contract/classic.ts:12`，原文：

```ts
 * ⚠️ **这不是 33 个引擎事件。** 引擎事件目录在 `events.ts`（39 个声明 / 12 个实现）。
```

改成：

```ts
 * ⚠️ **这不是 33 个引擎事件。** 引擎事件目录在 `events.ts`（39 个声明 / 16 个实现）。
```

（这三处是 P4a 留下的残渣 —— 它那一轮的收口 grep 只扫了 `README.md` / `docs/项目简介.md` / `site/index.html`，**没扫 `src/`**。Task 12 的收口 grep 会连 `src/` 一起扫。）

- [ ] **Step 3: 改 `test/dispatch.test.ts` 的两处**

`:365-370` 的生命周期清单里，`'turn.complete'` 那一行之后加：

```ts
    ['session.compact', { trigger: 'manual', tokensBefore: 12_345 }],
```

并把上面那句注释 `it('五个生命周期事件都能 dispatch，且不抛', ...)` 与 `:356-359` 那段注释里的"五条"一起改成"六条/六件"（三处 `五` → `六`）。

`:392-396` 那段注释里的旧计数，原文：

```ts
    // 上面那条的另一半：no-op 只针对生命周期事件，
    // NotImplementedError 必须继续为那 24 个真未实现的事件保留意义
    // （P4a 把 agent.offer / agent.spawn / skill.prompt 转正了，27 → 24）。
```

改成：

```ts
    // 上面那条的另一半：no-op 只针对通知事件，
    // NotImplementedError 必须继续为那 23 个真未实现的事件保留意义
    // （P4a 把 agent.offer / agent.spawn / skill.prompt 转正了，27 → 24；
    //   P4b 把 session.compact 转正，24 → 23）。
```

- [ ] **Step 4: 跑测试**

Run: `pnpm typecheck && pnpm test test/dispatch.test.ts test/classic.test.ts`
Expected: 全绿

- [ ] **Step 5: 反向验证一条**

把 `NOTIFICATION_EVENTS` 里的 `'session.compact'` 注释掉。
Run: `pnpm test test/dispatch.test.ts`
Expected: 「六个生命周期事件都能 dispatch」**变红**（抛 `NotImplementedError`）。改回来。

- [ ] **Step 6: 提交**

```bash
git add src/contract/events.ts src/contract/classic.ts test/dispatch.test.ts
git commit -m "feat(contract): session.compact 转正为通知事件（实现 15 → 16）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: `cli/compact.ts` —— 摘要策略与失败方向

**Files:**
- Create: `src/cli/compact.ts`
- Test: `test/compact.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// test/compact.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamRequest } from '../src/contract/model-provider';
import type { DispatchFn } from '../src/core/dispatch';
import { createPersister, createTranscript } from '../src/cli/transcript';
import { SUMMARIZE_PROMPT, createCompactor, splitAt } from '../src/cli/compact';
import type { CompactConfig } from '../src/cli/settings';
import type { Persister } from '../src/cli/transcript';

const CONFIG: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 2 };

/** 一轮 = 一条 user 消息及其之后的一切。造 n 轮。 */
function turns(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: 'user', content: `问题${i}` });
    out.push({ role: 'assistant', content: [{ type: 'text', text: `回答${i}` }] });
  }
  return out;
}

/** 会记账的摘要 provider。 */
function summaryProvider(behavior: { text?: string; throw?: Error } = {}) {
  const requests: StreamRequest[] = [];
  const provider: ModelProvider = {
    name: 'stub',
    async *stream(req) {
      requests.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      yield { type: 'text', text: behavior.text ?? '摘要正文' } as const;
      yield { type: 'done', stopReason: 'end_turn' } as const;
    },
  };
  return { provider, requests };
}

function setup(over: { provider?: ModelProvider; config?: CompactConfig; messages?: Message[] } = {}) {
  const messages: Message[] = over.messages ?? turns(6);
  const seen: unknown[] = [];
  const warnings: string[] = [];
  const seed = over.provider ?? summaryProvider().provider;

  const dispatch = (async (event: string, args: unknown) => {
    seen.push({ event, args });
    return {};
  }) as unknown as DispatchFn;

  const compact = createCompactor({
    messages,
    provider: seed,
    dispatch,
    persist: Object.assign(async () => {}, { reseed: () => {} }) as Persister,
    config: over.config ?? CONFIG,
    warn: (line) => warnings.push(line),
    signal: () => new AbortController().signal,
  });

  return { compact, messages, seen, warnings };
}

describe('splitAt：轮边界按 role === "user" 数', () => {
  it('保留最近 N 轮，切在倒数第 N 条 user 消息上', () => {
    expect(splitAt(turns(6), 2)).toBe(8); // 6 轮共 12 条，倒数第 2 条 user 在下标 8
  });

  it('历史不够 → undefined（没有可压的）', () => {
    expect(splitAt(turns(2), 2)).toBeUndefined();
  });

  it('切点落在第 0 条 → undefined（压了等于没压）', () => {
    expect(splitAt(turns(3), 3)).toBeUndefined();
  });
});

describe('压缩的形状与失败方向', () => {
  it('C2-10 压完 = 一条摘要 + 最近 N 轮原文', async () => {
    const { compact, messages } = setup();
    expect(await compact.run('manual')).toBe(true);

    expect(messages.length).toBe(1 + 4); // 1 条摘要 + 2 轮 × 2 条
    expect(messages[0]?.role).toBe('user');
    const summary = messages[0]?.role === 'user' ? messages[0].content : '';
    expect(summary).toContain('摘要正文');
    expect(summary).toContain('8 条消息'); // 被压掉的条数要让模型知道
    expect(messages.at(-1)).toEqual(turns(2).at(-1));
  });

  it('摘要那一轮**绝不带工具**', async () => {
    const stub = summaryProvider();
    const { compact } = setup({ provider: stub.provider });
    await compact.run('manual');
    expect(stub.requests[0]?.tools).toEqual([]);
    expect(stub.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: SUMMARIZE_PROMPT });
  });

  it('C2-12a 摘要调用抛错 → 不压缩、出声、原文一条不动', async () => {
    const before = turns(6);
    const { compact, messages, warnings } = setup({
      messages: [...before],
      provider: summaryProvider({ throw: new Error('网络炸了') }).provider,
    });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('网络炸了');
  });

  it('C2-12b 摘要返回空 → 同上', async () => {
    const before = turns(6);
    const { compact, messages, warnings } = setup({ messages: [...before], provider: summaryProvider({ text: '   ' }).provider });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('没有返回任何文本');
  });

  it('C2-12c 压完反而更长 → 放弃，原文一条不动（这一条最容易漏）', async () => {
    const before: Message[] = [
      { role: 'user', content: '一' },
      ...turns(4),
    ];
    const { compact, messages, warnings } = setup({
      messages: [...before],
      provider: summaryProvider({ text: '啰'.repeat(5_000) }).provider,
    });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('没有比原文短');
  });

  it('C2-13 派了 session.compact，trigger 分得清 manual / auto', async () => {
    const manual = setup();
    await manual.compact.run('manual');
    expect(manual.seen).toEqual([
      { event: 'session.compact', args: { trigger: 'manual', tokensBefore: expect.any(Number) } },
    ]);

    const auto = setup({ config: { ...CONFIG, auto: true } });
    await auto.compact.run('auto');
    expect(auto.seen).toEqual([
      { event: 'session.compact', args: { trigger: 'auto', tokensBefore: expect.any(Number) } },
    ]);
  });
});

describe('阈值与提醒', () => {
  it('没到阈值不出声', async () => {
    const { compact, warnings } = setup();
    compact.note({ inputTokens: 10, estimated: false });
    await compact.afterTurn();
    expect(warnings).toEqual([]);
  });

  it('跨过阈值出声**一次**，不每轮刷屏', async () => {
    const { compact, warnings } = setup({ config: { ...CONFIG, atTokens: 100 } });
    compact.note({ inputTokens: 200, estimated: false });
    await compact.afterTurn();
    await compact.afterTurn();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('/compact');
  });

  it('估出来的数出声时要说明是估的', async () => {
    const { compact, warnings } = setup({ config: { ...CONFIG, atTokens: 100 } });
    compact.note({ inputTokens: 200, estimated: true });
    await compact.afterTurn();
    expect(warnings[0]).toContain('估');
  });

  it('`auto: true` 时顺手压，不再只是提醒', async () => {
    const { compact, messages, warnings } = setup({ config: { ...CONFIG, auto: true, atTokens: 100 } });
    compact.note({ inputTokens: 200, estimated: false });
    await compact.afterTurn();
    expect(messages.length).toBeLessThan(12);
    expect(warnings.join('\n')).toContain('已压缩');
  });
});

describe('C2-11 游标：压缩之后继续落盘，不错位、不重复', () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'deepcode-compact-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('压缩 + 继续说话之后，转录里新增的那一批正好是新的那些', async () => {
    const cwd = join(home, 'proj');
    const original = turns(10); // 20 条，`alreadySaved` 全是 20
    const transcript = await createTranscript({ home, cwd, model: 'm', provider: 'anthropic' });
    const persist = createPersister(transcript, 0);
    await persist(original);
    // 接上旧会话的样子：游标从 20 起
    const resumed = createPersister(transcript, original.length);

    const messages: Message[] = [...original];
    const compact = createCompactor({
      messages,
      provider: summaryProvider({ text: '早前的摘要' }).provider,
      dispatch: (async () => ({})) as unknown as DispatchFn,
      persist: resumed,
      config: CONFIG,
      warn: () => {},
      signal: () => new AbortController().signal,
    });

    expect(await compact.run('manual')).toBe(true);
    expect(messages.length).toBeLessThan(original.length);

    messages.push({ role: 'user', content: '新的问题' });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: '新的回答' }] });
    await resumed(messages);

    // 再长过旧游标，走一遍"错位切片"那条路
    for (let i = 0; i < 15; i++) messages.push({ role: 'user', content: `补${i}` });
    await resumed(messages);

    const onDisk = (await readFile(transcript.path, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; message?: Message })
      .filter((record) => record.type === 'message')
      .map((record) => record.message);

    // 盘上 = **未被改写的原始 20 条** + 压缩之后真正新增的那些（一条不漏、一条不重）。
    // 这三条断言连起来把"错位"那条路径钉死了：没有 `reseed` 时第三条数不对、
    // 第二条取到的是内存里**别的**一批（`补13`、`补14`），两条都会红。
    expect(onDisk.slice(0, original.length)).toEqual(original);
    expect(onDisk.slice(original.length)).toEqual([
      { role: 'user', content: '新的问题' },
      { role: 'assistant', content: [{ type: 'text', text: '新的回答' }] },
      ...Array.from({ length: 15 }, (_, i) => ({ role: 'user' as const, content: `补${i}` })),
    ]);
    expect(onDisk.length).toBe(original.length + 2 + 15);
  });
});
```

（数字核对：`turns(10)` 是 20 条，`keepTurns: 2` → 切点 16 → 压完 1 + 4 = 5 条；再推 2 条 → 7；再推 15 条 → 22。落盘按游标切片，合计 20 + 2 + 15 = 37。）

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/compact.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/cli/compact"`

- [ ] **Step 3: 写实现**

```ts
// src/cli/compact.ts
import { CORE_ORIGIN } from '../contract/next';
import type { Message, ModelProvider } from '../contract/model-provider';
import type { DispatchFn } from '../core/dispatch';
import { estimateTokens, messageChars } from '../core/loop';
import type { CompactConfig } from './settings';
import type { Persister } from './transcript';

/**
 * 摘要那一轮的指令。
 *
 * 要求里**明确写了"不要复述过程"**：摘要只要能接手的东西（目标、改过的文件、结论、未决问题），
 * 逐轮复述等于把原文换个说法搬回来，压缩率会掉到接近零。
 */
export const SUMMARIZE_PROMPT = `请把上面这段编码会话压缩成一份摘要，供后续对话接手使用。要求：
1. 用户的目标是什么、做到哪一步了。
2. 已经改过哪些文件（写全路径）。
3. 已经确认的结论，以及还没解决的问题。
4. **不要复述过程**，不要逐轮复述。只写结论与状态。
用中文，条目式，尽量短。`;

/**
 * 找压缩的切点：从尾部数第 `keepTurns` 条 `role === 'user'` 消息的下标。
 * 一轮 = 一条 user 消息**及其之后**的一切（assistant 回复、工具结果都算这一轮里的）。
 *
 * 返回 `undefined` = 没有可压的：历史不够 `keepTurns` 轮，或者切点正好落在第 0 条
 * （那两种情况压了都等于没压）。
 */
export function splitAt(messages: readonly Message[], keepTurns: number): number | undefined {
  if (keepTurns <= 0) return undefined;

  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== 'user') continue;
    seen += 1;
    if (seen === keepTurns) return index === 0 ? undefined : index;
  }
  return undefined;
}

export type CompactorDeps = {
  /** REPL 正在用的**那个**数组引用 —— 压缩必须就地改，换一个新的等于没改。 */
  readonly messages: Message[];
  readonly provider: ModelProvider;
  readonly dispatch: DispatchFn;
  readonly persist: Persister;
  readonly config: CompactConfig;
  /** 出声（渲染器的 notice）。压缩改的是用户手里的上下文，**必须**看得见。 */
  readonly warn: (line: string) => void;
  readonly signal: () => AbortSignal;
};

export type Compactor = {
  /** 记下这一轮报上来的用量。`estimated` 为真时，提醒里要说明这个数是估的。 */
  note(usage: { readonly inputTokens: number; readonly estimated: boolean }): void;
  /** 每轮收尾调一次：跨过阈值就出声（`auto: true` 时顺手压）。 */
  afterTurn(): Promise<void>;
  /** `/compact` 与自动压缩共用的入口。返回是否真的压了。 */
  run(trigger: 'manual' | 'auto'): Promise<boolean>;
};

/**
 * 压缩器。
 *
 * ⚠️ **它的失败方向与 fail-closed 相反，这是有意的。** 摘要是**变换缝**（与 P4a 的
 * `skill.prompt` 同类），不是闸：压不成就不压、出声、原文一条不动。宁可上下文继续涨到
 * 真的报错，也不静默丢掉用户已经做过的事 —— 别把它"统一"成 fail-closed（设计 §3.4）。
 */
export function createCompactor(deps: CompactorDeps): Compactor {
  let last: { inputTokens: number; estimated: boolean } | undefined;
  /** 跨过阈值只出声一次。掉回阈值以下时复位 —— 下次再跨过还要出声。 */
  let warned = false;

  const compactor: Compactor = {
    note(usage) {
      last = usage;
    },

    async afterTurn() {
      if (last === undefined) return;

      if (last.inputTokens < deps.config.atTokens) {
        warned = false;
        return;
      }
      if (warned) return;
      warned = true;

      if (deps.config.auto) {
        await compactor.run('auto');
        return;
      }
      const how = last.estimated ? '（估）' : '';
      deps.warn(
        `上下文已到约 ${last.inputTokens} token${how}，阈值 ${deps.config.atTokens}。` +
          `输入 /compact 压缩，或把设置里的 compact.auto 打开。`,
      );
    },

    async run(trigger) {
      const tokensBefore = last?.inputTokens ?? estimateTokens(messageChars(deps.messages));
      const cut = splitAt(deps.messages, deps.config.keepTurns);
      if (cut === undefined) {
        deps.warn('没有可压缩的历史：上下文里还没有超过保留轮数的旧消息。');
        return false;
      }

      const head = deps.messages.slice(0, cut);
      const tail = deps.messages.slice(cut);

      let text: string;
      try {
        text = (await summarize(deps, head)).trim();
      } catch (error) {
        deps.warn(
          `压缩没做成，上下文一条没动：摘要调用失败（${error instanceof Error ? error.message : String(error)}）。`,
        );
        return false;
      }
      if (text === '') {
        deps.warn('压缩没做成，上下文一条没动：摘要那一轮没有返回任何文本。');
        return false;
      }

      const summary: Message = {
        role: 'user',
        content: `以下是更早的 ${head.length} 条消息的摘要（原文已从上下文里移除）：\n\n${text}`,
      };
      const next: Message[] = [summary, ...tail];

      // 压缩之后**反而更长**：摘要比原文还长，短会话上真会发生。
      // 漏了这一条就是把上下文越"压"越大 —— 设计里点名"这一条最容易漏"。
      if (messageChars(next) >= messageChars(deps.messages)) {
        deps.warn('压缩没做成，上下文一条没动：摘要没有比原文短。');
        return false;
      }

      // 通知派在**改之前**：`tokensBefore` 这个名字只有在改之前派才说得通。
      await deps.dispatch('session.compact', { trigger, tokensBefore }, CORE_ORIGIN);

      // 就地改：REPL 与 `/clear` 手里是**同一个数组引用**，换一个新的等于没改（见 cli/commands.ts）。
      deps.messages.length = 0;
      deps.messages.push(...next);
      // ⚠️ 数组变短了，落盘游标必须跟着重置 —— 漏了这一句会**静默损坏**转录（设计 §3.5）。
      deps.persist.reseed(deps.messages.length);

      warned = false;
      deps.warn(
        `已压缩：${head.length} 条旧消息压成 1 条摘要，保留了最近 ${deps.config.keepTurns} 轮的原文。`,
      );
      return true;
    },
  };

  return compactor;
}

/**
 * 摘要那一轮是**旁路**调用：不走 `runTurn`（它会往 `messages` 里追加，而我们要的只是
 * 一次读），而且 `tools: []` —— 摘要那一轮绝不能让模型去调工具。
 */
async function summarize(deps: CompactorDeps, head: readonly Message[]): Promise<string> {
  let text = '';
  for await (const event of deps.provider.stream({
    system: '你负责把一段编码会话的上下文压缩成一份能接手用的摘要。',
    messages: [...head, { role: 'user', content: SUMMARIZE_PROMPT }],
    tools: [],
    signal: deps.signal(),
  })) {
    if (event.type === 'text') text += event.text;
  }
  return text;
}
```

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/compact.test.ts`
Expected: 全绿（**Step 1 里那两行占位断言要删掉**，别照抄）

- [ ] **Step 5: 反向验证两条（都做）**

1. 把 `deps.persist.reseed(deps.messages.length);` 注释掉。
   Run: `pnpm test test/compact.test.ts`
   Expected: `C2-11` **变红**。改回来。
2. 把 `if (messageChars(next) >= messageChars(deps.messages))` 整块删掉。
   Run: `pnpm test test/compact.test.ts`
   Expected: `C2-12c` **变红**。改回来。

**任一条没红，说明那条断言是摆设，修断言本身。**

- [ ] **Step 6: 提交**

```bash
git add src/cli/compact.ts test/compact.test.ts
git commit -m "feat(cli): 压缩器 —— 摘要替换 + 保留最近 N 轮，失败就不压" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: `cli/agents-md.ts` —— 嵌套的目录约定

**Files:**
- Create: `src/cli/agents-md.ts`
- Test: `test/agents-md.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// test/agents-md.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { createEngine } from '../src/core/create';
import { readTool } from '../src/builtins/tools/read';
import { createAgentsMdPlugin } from '../src/cli/agents-md';
import { scriptedProvider } from './harness';

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
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm test test/agents-md.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/cli/agents-md"`

- [ ] **Step 3: 写实现**

```ts
// src/cli/agents-md.ts
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EngineInterface } from '../contract/engine';
import type { Plugin } from '../contract/plugin';

/** 认这两个名字，顺序即附加顺序。 */
const FILES = ['AGENTS.md', 'CLAUDE.md'];

export type AgentsMdDeps = { readonly root: string };

/**
 * 嵌套的目录约定：模型读一个文件时，把**它上面每一层目录**的 `AGENTS.md` / `CLAUDE.md`
 * 附在那一次工具结果后面。
 *
 * **为什么挂 `Read` 而不是启动时全树预读**：全树预读会在大仓库上白烧 token，而约定是
 * "读到这一层才需要"的东西 —— 这正是"惰性"二字的意思（设计 §4.1）。
 *
 * ⚠️ **它必须排在 `coreTools` 之前**（同 tier 内先装载者在外层），否则 `next(e)` 回来时
 * `Read` 还没跑，拿到的是链尾的答复。这条顺序约束写在 `cli/plugins.ts` 的装配表里。
 */
export function createAgentsMdPlugin(deps: AgentsMdDeps): Plugin {
  // 同层去重：一个文件一次会话只附一次。
  // "一次会话"以**插件实例**为界 —— `--resume` 起新实例会再附一次，可接受：
  // 重新开一段对话，重新给一遍上下文是对的。
  const attached = new Set<string>();

  return {
    name: 'agents-md',
    uses: ['tool.call', 'fs', 'session'],

    register(on) {
      on('tool.call', { tool: 'Read' }, async ($, e, next) => {
        const result = await next(e);

        // 读都没读成，附约定没有意义。
        if ('deny' in result) return result;
        if (typeof result.value !== 'string' || result.value.startsWith('ERROR:')) return result;

        const input = e.input as { file_path?: unknown } | null;
        if (typeof input?.file_path !== 'string') return result;

        // 与 `read.ts` 完全一致地解析：它把 `input.file_path` **原样**交给 `$.fs.read`，
        // 相对路径由 `readFile` 按进程 cwd 解析 —— 而 `$.session.root()` 就是启动时的
        // `resolve(process.cwd())`。这里按同一个起点算，两边的"这个文件在哪"才是一回事。
        const root = resolve($.session.root());
        const file = resolve(root, input.file_path);

        const notes = await collect($, root, dirname(file), attached);
        if (notes.length === 0) return result;

        return { value: `${result.value}\n\n${notes.join('\n\n')}` };
      });
    },
  };
}

/**
 * 从 root **下面**开始，逐层向下收集到 `dir` 为止的约定文件。
 *
 * - **跨层去重**：root 自己那份（以及用户级那份）已经进了 system prompt
 *   （`main.ts` 的 `loadInstructions`），所以回溯从 root 下面开始 ——
 *   否则模型每读一个文件都要重读一遍根约定。
 * - **只对 root 之内的文件触发**：读 `~/.ssh/...`、读另一个仓库，不跨界去拽无关的约定文件。
 */
async function collect(
  $: EngineInterface,
  root: string,
  dir: string,
  attached: Set<string>,
): Promise<string[]> {
  const rel = relative(root, dir);
  // `''` = 目标就在 root 本身；`..` 开头或跨盘符时 `relative` 给出绝对路径 = root 之外。
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];

  const segments = rel.split(/[\\/]/);
  const notes: string[] = [];

  for (let depth = 1; depth <= segments.length; depth++) {
    const where = join(root, ...segments.slice(0, depth));
    for (const name of FILES) {
      const path = join(where, name);
      if (attached.has(path)) continue;

      let content: string;
      try {
        if (!(await $.fs.exists(path))) continue;
        content = await $.fs.read(path);
      } catch {
        // 读不动就跳过：跟着一个文件附带约定是**便利**，不是判定 —— 它要是能拦下这次读取，
        // 就变成了一个没写在文档里、也没人能配的权限层。
        continue;
      }

      attached.add(path);
      notes.push(`以下是 ${where} 的目录约定（${name}）：\n\n${content}`);
    }
  }

  return notes;
}
```

- [ ] **Step 4: 跑测试，确认它通过**

Run: `pnpm typecheck && pnpm test test/agents-md.test.ts`
Expected: 全绿

- [ ] **Step 5: 反向验证两条（都做）**

1. 把 `if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];` 里的 `rel === ''` 去掉。
   Run: `pnpm test test/agents-md.test.ts`
   Expected: 「root 与用户层那两份不重附」**变红**。改回来。
2. 把 `if (attached.has(path)) continue;` 删掉。
   Run: `pnpm test test/agents-md.test.ts`
   Expected: `C3-15`（第二次读不重附）**变红**。改回来。

- [ ] **Step 6: 提交**

```bash
git add src/cli/agents-md.ts test/agents-md.test.ts
git commit -m "feat(cli): 嵌套 AGENTS.md —— 挂在 Read 上，双层去重" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 11: 接线 —— `/compact`、自动压缩、插件表

**Files:**
- Modify: `src/cli/plugins.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/repl.ts`
- Modify: `src/cli/main.ts`

⚠️ **本任务有一处顺序陷阱**：`cliPlugins()` 在 `createEngine()` **之前**被调用，而压缩器需要 `dispatch`（只有 `createEngine` 之后才有）。所以 `main.ts` 给插件的是一个**延迟取的回调** —— 与 `core/nouns/index.ts` 里那两个 `refs` 是同一种写法。

- [ ] **Step 1: 改 `cli/commands.ts`**

`:18-24` 的 `SessionCommandsDeps`，在 `palette` 之后加：

```ts
  /**
   * 压缩。**给它才注册 `/compact`** —— 没给的时候这条命令不存在，`/help` 也不会列它，
   * 这比"命令在、点了没反应"诚实。
   */
  readonly compact?: () => Promise<void>;
```

`:26-31` 的 register 里，`/clear` 那一条（`:45-52`）之后加：

```ts
      if (deps.compact !== undefined) {
        on('command.run', { name: 'compact' }, async () => {
          await deps.compact?.();
          return { handled: true };
        });
      }
```

并把 `createSessionCommands` 上面那段文档注释里的 `/diff`、`/clear` 一句改成 `/diff`、`/clear`、`/compact`。

- [ ] **Step 2: 改 `cli/plugins.ts`**

`:1-18` 的 import 区加：

```ts
import { createAgentsMdPlugin } from './agents-md';
```

`CliPluginDeps`（`:21-50`）里，`baseSystemPrompt` 之后加：

```ts
  /**
   * 压缩入口（`/compact` 用）。**延迟取的回调**：压缩器要到 `createEngine` 之后才建得出来
   * （它需要 `dispatch`），而这张表是那之前装的 —— 与 `core/nouns/index.ts` 里那两个
   * `refs` 同一种写法。不给 = 没有 `/compact` 这条命令。
   */
  readonly compact?: () => Promise<void>;
```

`firstParty`（`:81-105`）里，`createChangesPlugin(deps.changes)` **之后**、`...coreTools` **之前**插：

```ts
    // 嵌套目录约定。**必须在 coreTools 之前**：同 tier 内先装载者在外层，
    // 而它要在 `next(e)` 回来之后**拿到 Read 的结果**才能追加。晚一步就是个空动作。
    // （与上面 session-changes 那条顺序约束同一个道理。）
    createAgentsMdPlugin({ root: deps.root }),
```

`createSessionCommands({...})`（`:97-102`）改成：

```ts
    createSessionCommands({
      changes: deps.changes,
      messages: deps.messages,
      root: deps.root,
      palette: deps.palette,
      ...(deps.compact === undefined ? {} : { compact: deps.compact }),
    }),
```

⚠️ 用 `...(x === undefined ? {} : { k: x })` 那个写法而不是直接 `compact: deps.compact`：这个库里到处是这种写法（`loop-options.test.ts` 的 `RunOptions`、`core/create.ts` 的 `seating`）。**别"顺手简化"** —— TS 关掉 `exactOptionalPropertyTypes` 时两种都编译得过，但前者是这儿的惯例。

- [ ] **Step 3: 改 `cli/repl.ts`**

`ReplDeps`（`:10-26`）里，`persist` 之后加：

```ts
  /** 每一轮的用量（`turn.complete` 的同一条数据）。压缩的阈值判定吃它。 */
  onUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimated: boolean;
  }) => void;
  /** 每个 turn 收尾时调一次（落盘之后）。跨过压缩阈值时的提醒与自动压缩都在这儿。 */
  afterTurn?: () => Promise<void>;
```

`:86-96` 的 `runTurn({...})` 调用里，`turnIndex: turnIndex++,` 之后加：

```ts
          ...(deps.onUsage === undefined ? {} : { onUsage: deps.onUsage }),
```

`:97-104` 的 `finally` 块，原文：

```ts
    } finally {
      // 失败也要归零：留着 busy=true 会让下一次 Ctrl-C 变成"掐一个已经结束的 turn"。
      deps.turns.end();
      // 每个 turn 收尾都补一个换行、并把新增消息落盘 —— 放在 finally 里，
      // 出错/被中断的那一轮也照样收尾。newline 只在这里调一次，别在外面再来一遍。
      deps.render.newline();
      await deps.persist(messages);
    }
```

改成：

```ts
    } finally {
      // 失败也要归零：留着 busy=true 会让下一次 Ctrl-C 变成"掐一个已经结束的 turn"。
      deps.turns.end();
      // 每个 turn 收尾都补一个换行、并把新增消息落盘 —— 放在 finally 里，
      // 出错/被中断的那一轮也照样收尾。newline 只在这里调一次，别在外面再来一遍。
      deps.render.newline();
      await deps.persist(messages);
      // 落盘之后再判压缩：压完要 `reseed` 游标，而游标是落盘器自己的状态。
      await deps.afterTurn?.();
    }
```

- [ ] **Step 4: 改 `cli/main.ts`**

imports 区加：

```ts
import { createCompactor, type Compactor } from './compact';
```

`:229-244`，在 `const providerAdapter = createProvider(...)` 之前加：

```ts
  // 压缩器要到 `createEngine` **之后**才建得出来（它需要 `dispatch`），而 `/compact`
  // 这条命令在 `cliPlugins` 里注册 —— 所以这里先留一个延迟取的位置，
  // 与 core/nouns 里那两个 `refs` 同一种写法。
  let compactor: Compactor | undefined;
```

`cliPlugins({...})` 的实参里，`pluginDeny` 那一行之后加：

```ts
    compact: async () => {
      await compactor?.run('manual');
    },
```

`createEngine({...})` 的 `signal:` 那一行之前，**Task 4 已经加过 `sandbox:` 了**，确认它在。

`:259` 的 `await dispatch('session.start', ...)` 之后加：

```ts
  // 压缩器：它要 messages / provider / dispatch / persist —— 四样这时候都齐了。
  compactor = createCompactor({
    messages,
    provider: providerAdapter,
    dispatch,
    persist,
    config: policy.compact,
    warn: (line) => render.notice(line),
    signal: () => turns.current(),
  });
```

`:293` 的 `startRepl({...})` 调用改成：

```ts
    await startRepl({
      $,
      dispatch,
      render,
      rl,
      systemPrompt,
      turns,
      messages,
      persist,
      onUsage: (usage) => compactor?.note(usage),
      afterTurn: async () => {
        await compactor?.afterTurn();
      },
    });
```

⚠️ **一次性模式（`oneShot` 那一段）不加任何东西** —— 它跑完一个 turn 就退出，自动压缩在那儿没有意义。别为了"统一"在两条路上都插调用点。

- [ ] **Step 5: 跑 typecheck 与相关测试**

Run: `pnpm typecheck && pnpm test test/cli.test.ts test/plugin-wiring.test.ts`
Expected: 全绿（`compact` 是可选的，既有用例一处都不用改）

- [ ] **Step 6: 手工看一眼（可选，两分钟）**

```bash
mkdir -p /tmp/p4b-demo/.deepcode
cat > /tmp/p4b-demo/.deepcode/settings.json <<'EOF'
{ "sandbox": { "enabled": true, "paths": { "deny": ["~/.ssh/**"] } },
  "compact": { "atTokens": 2000 } }
EOF
cd /tmp/p4b-demo && node --import tsx F:/ts/DeepCode/src/cli/main.ts
```
在 REPL 里：`/help` 里应当有 `/compact`；说一句让它跑 `cat ~/.ssh/config`，应当收到 `[沙箱拒绝]`；
`/compact` 在历史不足时应当回一句"没有可压缩的历史"。（真跑要花 token，不做也行。）

- [ ] **Step 7: 提交**

```bash
git add src/cli/plugins.ts src/cli/commands.ts src/cli/repl.ts src/cli/main.ts
git commit -m "feat(cli): 接线 —— /compact、阈值提醒、agents-md 进第一方" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 12: 文档与收口

**Files:**
- Modify: `README.md`
- Modify: `docs/项目简介.md`
- Modify: `site/index.html`

⚠️ 设计 §5 的话照抄在这儿：**只改一处，会被另一处的旧数字顶回去。** P4a 就是这么留下一批残渣的。

- [ ] **Step 1: 先量一下真实的数字**

```bash
pnpm test 2>&1 | tail -20
```
记下**用例数**与**测试文件数**（当前是 523 / 36，本轮新增 3 个文件 → 39）。
下面凡写 `<用例数>` / `<文件数>` 的地方，用实测值替换。**一个数字都不许编。**

- [ ] **Step 2: README —— 计数与沙箱那一节**

`:403`，原文：

```md
- **39 个事件里实现了 15 个**：其余 24 个已声明、未实现，用到时会抛 `NotImplementedError`。
```

改成：

```md
- **39 个事件里实现了 16 个**：其余 23 个已声明、未实现，用到时会抛 `NotImplementedError`。
```

`:419`，原文：

```md
pnpm test        # 测试，36 个文件 523 个用例
```

改成（数字用实测值）：

```md
pnpm test        # 测试，<文件数> 个文件 <用例数> 个用例
```

`:243` 那句"真要封死"，原文：

```md
> 东西照样绕得过去。真要封死得靠进程权限或沙箱，那排到 P3/P4。
```

改成：

```md
> 东西照样绕得过去。真要封死得靠进程权限或操作系统级的隔离；下面「沙箱」那一节加的是闸，
> 不是墙 —— 它在同一个局限里。
```

`:385`，原文：

```md
所以别在装着重要东西的机器上放它乱跑。沙箱化（含 Bash 的）在设计文档里排到 P2。
```

改成：

```md
所以别在装着重要东西的机器上放它乱跑。**`Bash` 另有一道可选的路径闸**（见下面「沙箱」一节），
但它只盖 `Bash`、只做文本分析 —— 它加的是闸，不是墙。
```

在 `## 会话落盘` **之前**插入新的一节：

```md
## 沙箱（只有 `Bash`）

`Bash` 命令在**真的起进程之前**会过一道路径闸。它默认**关着**，在 `settings.json` 里写：

```json
{
  "sandbox": {
    "enabled": true,
    "paths": { "deny": ["~/.ssh/**", "/etc/**"], "allow": ["/home/you/repo/**", "/tmp/**"] }
  }
}
```

- **落点在权限链的下游。** 判定发生在 `process` 名词里、`spawn` 之前，而权限链（`tool.check`）
  在**上游** —— 所以**任何 `allow` 规则都绕不过它**，包括你自己写的、将来插件写的。
  "个人规则掀不翻托管策略"在这里不是政策，是位置。
- **`deny` 各层取并集，`allow` 只有托管层能设。** 个人配置能收紧自己，不能替自己开圈 ——
  非托管层写了 `allow` 会被丢弃并出声，不静默。
- **规则里写裸路径**（`/etc/**`、`~/.ssh/**`），`~` 会展开，反斜杠会归一，`**` 跨目录。
  相对路径的规则会被拒收并点名 —— 判定的候选一律是绝对路径，相对规则永远不命中。
- **不做 `dangerouslyDisableSandbox`。** 那个键就是一个"放行开关"，与上面那条底线冲突
  （原话：**谁加自动放行开关谁就是在开倒车**）。
- **它只盖 `Bash`。** `Read` / `Write` / `Edit` 走各自的路径与确认，不在这道闸里。

> ⚠️ **它是文本分析，不是 shell 解析器。** 从命令行里取"可能被写到的路径"靠的是切分 token，
> 不是解析：`x=/etc/passwd; rm $x`、`rm $(echo /etc/passwd)`、`cd /etc && ...` 全都绕得过去。
> 这与上面那条"前缀匹配不懂 shell 语法"是**同一种**局限、同一句话：**它是给手滑与误操作
> 加的一道闸，不是反对抗手段** —— 正因为如此，它**不是**"可以放开权限"的理由。
```

`## 已知限制（MVP 有意不做）` 那一节里（`:397` 之后），在第一条之前插入两条：

```md
- **沙箱是策略层的命令分析，不是 OS 隔离**：Windows 上没有 bubblewrap / sandbox-exec 的对应物，
  做真隔离等于写一段本机永远跑不到、也永远测不了的代码。候选路径的提取只有一组手写 fixture，
  准确率是"我们信这组 fixture"，不是"我们量过"。路径比较**区分大小写**（与权限规则一致）。
- **压缩的阈值 `compact.atTokens` 默认 100_000 是猜的**：参考笔记明说引擎内部看不见真实窗口。
  自动压缩**默认关**，`/compact` 手动始终可用；摘要失败 / 返回空 / 压完反而更长 —— 三种情况
  都**不压缩**，出声，原文一条不动。
```

- [ ] **Step 3: `docs/项目简介.md`**

`:61`，原文：

```md
  真要封死得靠进程权限或沙箱，那排在后面的阶段。
```

改成：

```md
  真要封死得靠进程权限或操作系统级的隔离；`Bash` 另有一道可选的路径闸，但它在同一个局限里。
```

`:78`，原文：

```md
事件目录：**39 个已声明，15 个已实现**，其余 24 个用到时会抛 `NotImplementedError`。
```

改成：

```md
事件目录：**39 个已声明，16 个已实现**，其余 23 个用到时会抛 `NotImplementedError`。
```

`:124`，原文：

```md
`verbatimModuleSyntax`）、`pnpm lint`（依赖边界）、`pnpm test`（36 个文件 523 个用例）。
```

改成（数字用实测值）：

```md
`verbatimModuleSyntax`）、`pnpm lint`（依赖边界）、`pnpm test`（<文件数> 个文件 <用例数> 个用例）。
```

`## 已知限制（有意不做）` 那一节里，"没有路径围栏"那一条之后加：

```md
- **沙箱只盖 `Bash`，而且是文本分析不是 shell 解析器**：`x=/etc/passwd; rm $x` 这类绕得过去。
  它是给手滑加的一道闸，不是反对抗手段。**没有** `dangerouslyDisableSandbox` 那种逃生阀。
- **压缩阈值是猜的**：不知道模型的真实窗口，自动压缩默认关，`/compact` 手动始终可用。
```

- [ ] **Step 4: `site/index.html`**

`:73`，原文：

```html
    <li><b>15/39</b><span>事件已实现（如实标注）</span></li>
```

改成：

```html
    <li><b>16/39</b><span>事件已实现（如实标注）</span></li>
```

`:302`，原文：

```html
  <p class="muted">样张里的 <code>WebSearch</code> 与 README 的例子一致：这个名字本轮还没实现（见「15/39」），
```

改成：

```html
  <p class="muted">样张里的 <code>WebSearch</code> 与 README 的例子一致：这个名字本轮还没实现（见「16/39」），
```

`:336`，原文：

```html
    <p><strong>39 个事件已声明，15 个已实现。</strong>其余 24 个在类型里躺着，
```

改成：

```html
    <p><strong>39 个事件已声明，16 个已实现。</strong>其余 23 个在类型里躺着，
```

`:71`，原文：

```html
    <li><b>523</b><span>用例全绿 · 36 个文件</span></li>
```

改成（数字用实测值）：

```html
    <li><b><用例数></b><span>用例全绿 · <文件数> 个文件</span></li>
```

`:347`，原文：

```html
      <p>用例，36 个测试文件，<code>pnpm test</code> 全绿。</p>
```

改成（数字用实测值）：

```html
      <p>用例，<文件数> 个测试文件，<code>pnpm test</code> 全绿。</p>
```

`:262`，原文：

```html
        <p>所以 <code>deny</code> 是给手滑与误操作加的一道闸，<strong>不是反对抗手段</strong>：写得出绕开写法的东西照样绕得过去。
          真要封死得靠进程权限或沙箱，那排在后面的阶段。</p>
```

改成：

```html
        <p>所以 <code>deny</code> 是给手滑与误操作加的一道闸，<strong>不是反对抗手段</strong>：写得出绕开写法的东西照样绕得过去。
          真要封死得靠进程权限或操作系统级的隔离 —— <code>Bash</code> 另有一道可选的路径闸，但它在同一个局限里。</p>
```

`:421`，原文：

```html
      <p class="card__cost">所以别在装着重要东西的机器上放它乱跑。沙箱化排在后面的阶段。</p>
```

改成：

```html
      <p class="card__cost">所以别在装着重要东西的机器上放它乱跑。<code>Bash</code> 另有一道可选的路径闸，
        但它只做文本分析 —— 它加的是闸，不是墙。</p>
```

并在这一节里再插一张卡片（放在「没有路径围栏」那张之后）：

```html
    <article class="card card--limit">
      <h3>沙箱不是 OS 隔离</h3>
      <p><code>Bash</code> 命令会过一道路径闸，但它靠切分 token 判路径，不是解析 shell：
        <code>x=/etc/passwd; rm $x</code>、<code>rm $(echo /etc/passwd)</code> 都绕得过去。
        Windows 上没有 bubblewrap / sandbox-exec 的对应物，做真隔离等于写一段本机永远跑不到也测不了的代码。</p>
      <p class="card__cost">它是给手滑加的一道闸，不是反对抗手段 —— 也正因如此，它<b>不是</b>可以放开权限的理由。
        没有 <code>dangerouslyDisableSandbox</code> 那种逃生阀（那是个放行开关）。</p>
    </article>
```

- [ ] **Step 5: 收口自检：旧口径零残留**

```bash
grep -rn "已实现\|个声明\|/39\|12 实现\|12 个事件\|15 个\|24 个" README.md docs/项目简介.md site/index.html src/contract/events.ts src/contract/classic.ts
```

Expected: **每一条都是 16/23**，没有一处还写着 15、24 或 12。
（注意：`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 下的历史文档**不动** —— 它们是当时的记录。）

- [ ] **Step 6: 提交**

```bash
git add README.md docs/项目简介.md site/index.html
git commit -m "docs: P4b —— 沙箱的诚实说明与 16/23 计数" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# 检查点

## C1（Task 1–4 之后）：沙箱

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §8 的 C1**

1. `deny` 命中的路径被拒，理由里带**是哪条规则**拒的 —— `test/sandbox.test.ts` 的「deny 命中」。✓
2. `allow` 非空时，白名单外的路径被拒 —— 「白名单非空：圈外被拒，圈内放行」。✓
3. 圈内路径放行，命令**真的执行** —— 「C1-3 圈内命令真的执行」。✓
4. **副作用验证** —— 「C1-4 副作用验证：被拒之后文件根本不存在」。✓
5. **结构性权威** —— 「C1-5 结构性权威」（先断言 `tool.check` 给的是 `allow`，再断言 `tool.call` 被沙箱拒）。✓
6. 非托管层设 `sandbox.paths.allow` 被丢弃且有警告 —— 「`deny` 各层取并集，`allow` 只认托管层」。✓
7. `enabled: false` 与"规则为空"两种情况下命令照常跑 —— 「C1-7」。✓

- [ ] **变异测试两条**

1. 把 `process.ts` 里那段沙箱判定挪到 `spawn` 之后 → `C1-4` / `C1-5` 变红。（Task 3 Step 6 已做）
2. 把 `resolvePolicy` 里 `allow` 的来源改成"全层并集" → `allow 只认托管层` 变红。（Task 4 Step 11 已做）

**任一条没红，说明那条断言是摆设，修断言本身。**

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4b C1 通过（沙箱）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C2（Task 5–9 之后）：usage 与压缩

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §8 的 C2**

8. 两个适配器都解析出 usage（假 fetch，不碰真网络）—— `test/provider.test.ts` 与 `test/openai.test.ts` 的 `usage` 那两节。✓
9. 拿不到 usage 时回落估计且 `usageEstimated: true` —— `test/loop-options.test.ts` 的「端点没报」。✓
10. 压缩后形状 = 一条摘要 + 最近 N 轮原文，轮边界按 `role === 'user'` —— `test/compact.test.ts` 的 C2-10 与 `splitAt` 那一节。✓
11. **游标** —— `test/compact.test.ts` 的 C2-11（内存改了短之后继续落盘，新增那批不多不少）+ `test/transcript.test.ts` 的 `reseed` 那一节。✓
12. 三种失败都不压缩、出声、原文不动 —— C2-12a/b/c。✓
13. `session.compact` 真的被派了，`trigger` 分得清 —— C2-13。✓

- [ ] **变异测试两条**

1. 注释掉 `persist.reseed(...)` → C2-11 变红。（Task 9 Step 5）
2. 删掉"压完反而更长就放弃"那一段 → C2-12c 变红。（Task 9 Step 5）

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4b C2 通过（usage 与压缩）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## C3（Task 10–12 之后）：嵌套与收口

- [ ] **跑一遍**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **逐条对设计 §8 的 C3**

14. 读子目录里的文件时中间层的约定被附上 —— `test/agents-md.test.ts` 的 C3-14。✓
15. 同一个文件第二次读不重附 —— C3-15。✓
16. root 与用户层那两份不重附 —— C3-16。✓
17. 读 root 之外的文件不触发 —— C3-17。✓
18. 三处文档数字对齐为 **16 实现 / 23 未实现**，旧口径扫描零残留 —— Task 12 Step 5 的 grep。✓

- [ ] **变异测试两条**

1. 去掉 `collect` 里 `rel === ''` 那半个条件 → 「不重附 root 那两份」变红。（Task 10 Step 5）
2. 删掉 `attached.has(path)` 的跳过 → C3-15 变红。（Task 10 Step 5）

- [ ] **提交检查点记录**

```bash
git commit --allow-empty -m "checkpoint: P4b C3 通过（嵌套与收口）" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自查记录（写计划时逐行对照源码的产物）

写完计划后按 writing-plans 的三条自查过了一遍，另外把设计文档里**每一处要引用的原文**都打开看过。结果如下。

1. **覆盖**：设计 §8 的 18 条验收标准逐条落到了任务上（见三个检查点的清单）。设计 §10「明确不做」的十条一条都没做（OS 隔离、网络隔离、`dangerouslyDisableSandbox`、`autoAllowBashIfSandboxed`、按动词分读写、自动压缩默认开、`PreCompact.custom_instructions`、压缩后恢复"最近读取的文件"、子代理内部压缩、压缩第二策略）。
2. **占位符**：扫了一遍「TBD / TODO / 类似 Task N / 加上适当的错误处理」—— 零。每一个改代码的步骤都给了成品代码块。
3. **类型一致性**：`SandboxConfig` 全程三个字段（`enabled` / `deny` / `allow`）；`checkSandbox(command, {cwd, home}, config)` 在 Task 2 定义、Task 3 调用，签名一致；`Compactor` 的三个方法（`note` / `afterTurn` / `run`）在 Task 9 定义、Task 11 调用，签名一致；`Persister`（函数 + `reseed`）在 Task 7 定义、Task 9 消费；`LoopContext.onUsage` 的入参形状（`{inputTokens, outputTokens, estimated}`）在 Task 6 定义、Task 11 消费；`messageChars` / `estimateTokens` 在 Task 6 定义、Task 9 消费。
4. **【写计划时新发现的四处，都不在设计的字面上】** —— 见下一节。

### 写计划时读源码读出来的、设计文档里没有的事实

1. **`anthropic.ts` 根本没有 `message_start` 分支。** 设计 §3.1 只说"解析响应里的 usage"，而 `input_tokens` 恰好在一条**当前完全没人处理**的帧里。Task 5 补了这个分支。同一条：`openai.ts:82-83` 的 `if (!choice) continue;` 会把只带 usage 的那一帧（`choices: []`）整个跳过，而且 `include_usage` 必须显式写进请求体。
2. **`settings.ts:230` 有一个顶层键白名单。** `sandbox` / `compact` 不加进去，用户会收到一句"不认识的顶层键"的假警告。设计没提这一行。
3. **P4a 在 `src/` 里留下了三处过期计数**（`events.ts:6`、`events.ts:32`、`classic.ts:12`，都还写着"12 实现"）。P4a 的收口 grep 只扫了 `README.md` / `docs/项目简介.md` / `site/index.html`，**从来没扫过 `src/`**。Task 8 Step 2 顺手修掉，Task 12 Step 5 的 grep 加上 `src/`。
4. **`ResolvedPolicy` 有 4 处对象字面量**（`test/cli.test.ts` 三处、`test/plugin-wiring.test.ts` 一处）。给它加**必填**字段，这 4 处会当场编译不过 —— 这正是 P4a 计划错误第 1 类（改共享常量捅了别人）。Task 4 把它们逐处列了出来。

### 与设计文档的偏差（六处，都是"设计的字面做不到或自相矛盾"）

1. **`estimateTokens` 的签名从 `(text: string)` 改成 `(chars: number)`**，另加一个 `messageChars(messages)`。理由：两处调用方（`loop.ts`、`compact.ts`）手里本来就是长度，让它们各写一遍 `Math.ceil(x / 4)` 才是"同一个东西抄两遍"—— P4a 教训第 2 类。
2. **`session.compact` 靠 `NOTIFICATION_EVENTS` 的链尾兜底，不写 `coreImpls`。** 设计 §3.6 说"`coreImpls` 里给 `() => ({})`"，但同一个文件的 `events.ts:183-185` 写着"放在链尾意味着任何 dispatcher 都天然满足这条不变量，**没有第二个地方可以漏**" —— 那条注释是 P3 用一次真实事故换来的。**照文件自己的规矩来。**
3. **只派一次 `session.compact`（改之前），不是"压缩前后各派一次"。** 设计 §3.6 后半句那么说，但同一节给的入参只有 `{ trigger, tokensBefore }` —— 同一个事件、同一份参数派两遍，没有任何消费方能区分。派在改之前，与 `tokensBefore` 这个名字、与 `PreCompact` 的语义都对得上。`PostCompact` 的经典 hook 名占着位，接线留到将来。
4. **沙箱的 JSON 里写**裸路径**，不走 `parseRule`。** 设计 §2.4 说"解析走 `parseRule(text, 'deny', home)`，于是 `~` 展开、反斜杠归一、`**` 语义全都是现成的"，但同一节的 JSON 例子写的是 `["~/.ssh/**", "/etc/**"]` —— 裸路径喂给 `parseRule` 会得到 `工具名 "/etc/**" 不合法`。改成 `contract/sandbox.ts` 的 `sandboxRule()`，用**同一组助手**（`squeeze` / `expandHome` / `slashes`）产生**逐字节相同**的形状，并加一条断言把两者钉在一起。设计想要的"归一不分叉"因此仍然成立，而且比原方案更直接地可验。
5. **自动压缩的触发信号走 `LoopContext.onUsage`，不是监听 `turn.complete` 的插件。** 设计没说机制，但插件拿不到 `dispatch`（hook 签名是 `($, e, next)`），而压缩前后要派 `session.compact`。用 `onUsage` 还顺带避开了另一个坑：子代理的内层 `runTurn` 也会派 `turn.complete`（静音包装只吞 `turn.step`，那是有意的），插件听到的会是子代理那一轮的用量。
6. **`compact` 配置挤进 `ResolvedPolicy`；`enabled` 的语义是各层的"或"；相对路径的沙箱规则被拒收。** 前两条设计没写清楚（`enabled` 只说"规则从各层并集来"，那是讲 `deny` 的）。第三条是补的：判定的候选一律绝对化，相对规则永远不命中，静默失效比拒收坏。

## 执行记录

（执行时填。格式照 P3/P4a 的做法：每个偏差一段 —— 现象、为什么计划错了、改成了什么、影响。

预登记的、大概率会出现的几处：

- **Task 12 的数字**：计划里写的 39/16/23 与文件数是**写计划时按源码推的**，执行时必须以 `events.ts` 的实际内容与 `pnpm test` 的实际输出为准。
- **Task 5 的 `else if` 链**：把 `message_start` 插进 `anthropic.ts` 的帧分派时，必须把原来那个 `if` 改成 `else if` —— 这是最容易抄错的一处。
- **Task 7 的 `persist` 搬家**：只把箭头函数从 `return` 位置挪到 `const persist =`，**函数体一个字都不要动**。）
