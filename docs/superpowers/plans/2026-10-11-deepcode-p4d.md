# DeepCode P4d（`prompt.*` 与文本通道 · 可观测）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让钩子能把话说进模型看得见的地方（`tool.result` / `prompt.submit.context` / `turn.stop` /
`prompt.section`），并让内核第一次能看见自己在做什么（`$.telemetry`，一行一条、零自由文本、默认关）。

**Architecture:** 新增一条**缝**的概念复用（`context: string` 三个落点共用一个 `withContext`）；
classic 桥从 3 个事件扩到 6 个，判定按事件分表（能表达才允许）；遥测是一个由插件通过
`engine.create` 折叠提供**名词**，挂在六个**纯通知**事件上写本地 JSONL。

**Tech Stack:** TypeScript（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、
Node ≥ 20、vitest、零运行时依赖。

**依据：** [`docs/superpowers/specs/2026-10-11-deepcode-p4d-design.md`](../specs/2026-10-11-deepcode-p4d-design.md)

**验收口径（用户长期指令）：** 任务级只跑 `pnpm typecheck`；测试按检查点批量做，
任务之间连续执行，不要停下来问。

---

## 文件结构

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/contract/prompt-channel.ts` | **新建** | `CONTEXT_MARKER` + `withContext`。零 import（`contract/` 是叶子） |
| `src/contract/events.ts` | 改 | `tool.result` / `turn.stop` 两个新事件；`prompt.submit` 加 `context`；`prompt.section` 转正 |
| `src/contract/classic.ts` | 改 | `BRIDGED_EVENTS` 3 → 6 + 注释 |
| `src/core/loop.ts` | 改 | `runOneTool` 派 `tool.result` 并并进 `context`；`runTurn` 的收手支派 `turn.stop` + `MAX_STOP_BLOCKS` |
| `src/core/create.ts` | 改 | 三条链尾缝的默认值 |
| `src/builtins/instructions.ts` | **新建** | `createInstructionsPlugin`：`AGENTS.md` / `CLAUDE.md` 走 `prompt.section` |
| `src/cli/main.ts` | 改 | 系统提示改走 `prompt.section`；`loadInstructions` 删掉；一次性模式拼 `context` |
| `src/cli/repl.ts` | 改 | `prompt.submit` 的 `context` 拼进 user 消息 |
| `src/cli/plugins.ts` | 改 | 装 `instructions` 与 `telemetry`；座位 |
| `src/cli/hook-run.ts` | 改 | `classify` 读 `additionalContext`；`HookVerdict` 加 `context?` |
| `src/cli/classic-hooks.ts` | 改 | 六个事件的桥 |
| `src/contract/plugin-manifest.ts` | 改 | `W3` 那句写死的事件名从 `BRIDGED_EVENTS` 推 |
| `src/cli/settings.ts` | 改 | `telemetry` 顶层键 + 解析 + `TelemetryPolicy` |
| `src/cli/telemetry-rows.ts` | **新建** | 纯逻辑：标识符正则、`validateEntry`、`formatRow`、`telemetryPath` |
| `src/cli/telemetry-sink.ts` | **新建** | 带缓冲的写盘（IO 可注入） |
| `src/cli/telemetry.ts` | **新建** | 插件本体 + `$.telemetry` 名词 + `/telemetry` |
| `plugins/hookify/core/rules.mjs` | 改 | `event` 字段 + 逐事件词表 + 逐事件 `field` 取值处 |
| `plugins/hookify/hooks/hook.mjs` | **改名** | 由 `pretooluse.mjs` 来，按 `hook_event_name` 分派 |
| `plugins/hookify/hooks/hooks.json` | 改 | 1 个事件 → 4 个 |
| `plugins/hookify/plugin.json` | 改 | `uses` 扩到四个引擎事件 |
| `plugins/hookify/README.md` | 改 | 四个事件、逐事件词表、失败代价的差别 |
| `README.md` / `docs/项目简介.md` / `site/index.html` | 改 | 事件计数 41/22/19、遥测、路线图 P4 收口 |

**顺序上的三个约束（不满足会中途红）：**

1. `prompt.section` 从 `UnimplementedEvent` 移进 `EventArgs` 的那一刻，`AllEventArgs` 的联合就变了；
   若有测试手写了 `UnimplementedEvent` 的字面量联合，同一步改掉。
2. `BRIDGED_EVENTS` 一加键，`cli/classic-hooks.ts` 的 `registerHooks` 与
   `contract/plugin-manifest.ts:367` 那句写死的文案**必须同一步**改 —— `BRIDGED_EVENTS` 是
   唯一一处"哪些 classic 事件有落点"的定义，漏一处就会出现"校验期说没落点、运行期有落点"
   的岔路（更糟的方向：反过来）。
3. `ResolvedPolicy` 加 `telemetry` 是**必填**字段，加上它的同一刻
   `test/cli.test.ts` / `test/plugin-wiring.test.ts` 里手写的 `ResolvedPolicy` 字面量就过不了 `tsc`。
   Task 10 的 Step 1 必须同时改 `settings.ts` 与那两个测试文件。

---

## Task 1：那一小块共用的东西（`withContext`）

**Files:**
- Create: `src/contract/prompt-channel.ts`
- Test: `test/prompt-channel.test.ts`

**为什么放 `contract/`：** `core/loop.ts`（工具结果）与 `cli/repl.ts`（用户消息）都要用它，
两边都 import `contract/` 是合法的；标记串只许有**一个**定义 —— 用户翻转录时看到的是同一句话。
`contract/` 是叶子，这个文件零 import。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { CONTEXT_MARKER, withContext } from '../src/contract/prompt-channel';

describe('withContext', () => {
  it('没有上下文时原样返回，不留标记', () => {
    expect(withContext('原文', undefined)).toBe('原文');
    expect(withContext('原文', '')).toBe('原文');
    expect(withContext('原文', '   \n ')).toBe('原文');
  });

  it('有上下文时追加，并带上唯一的那个标记', () => {
    expect(withContext('原文', '  补充  ')).toBe(`原文\n\n${CONTEXT_MARKER}\n补充`);
  });

  it('标记只在一处定义 —— 这个字面量改了就该这里红', () => {
    expect(CONTEXT_MARKER).toBe('[钩子补充的上下文]');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败** — `pnpm vitest run test/prompt-channel.test.ts`，期望"找不到模块"。

- [ ] **Step 3: 写实现**

```ts
/**
 * 钩子往对话里带文本的那条通道 —— 三个落点共用这一小块。
 *
 * 落点不同（工具结果 / 用户消息 / 不让收手时的下一轮输入），但"钩子补充的上下文"
 * 只有一个形状、一个标记。分开定义两次，用户翻转录时会看到两句不一样的话。
 *
 * `contract/` 是叶子：这个文件零 import。
 */
export const CONTEXT_MARKER = '[钩子补充的上下文]';

/** 把一段钩子给的上下文并进一段既有文本。空/纯空白 = 原样返回，不留空标记。 */
export function withContext(text: string, context: string | undefined): string {
  const extra = context?.trim() ?? '';
  if (extra === '') return text;
  return `${text}\n\n${CONTEXT_MARKER}\n${extra}`;
}
```

- [ ] **Step 4: 跑测试确认它通过** — `pnpm vitest run test/prompt-channel.test.ts`。

- [ ] **Step 5: 提交** — `git commit -m "feat(p4d): 钩子补充上下文的那条通道与它唯一的标记"`

---

## Task 2：`tool.result`（新事件）

**Files:**
- Modify: `src/contract/events.ts`（`EventArgs` / `EventResult` 各加一条）
- Modify: `src/core/create.ts`（链尾**缝**）
- Modify: `src/core/loop.ts:278-279`
- Test: `test/tool-result.test.ts`

三个要点：**只在工具真的跑了之后派**（四种拒绝路径都不派）；`ok` 复用既有约定
`!content.startsWith('ERROR:')`；返回的 `context` 用 `withContext` 并进那条工具结果。

- [ ] **Step 1: 加事件声明**

`src/contract/events.ts` 的 `EventArgs` 里，紧挨着 `'tool.check'` 之后：

```ts
  /**
   * 一次工具调用**跑完之后**。P4d 新增，是 classic `PostToolUse` 的着陆点。
   *
   * ⚠️ **这是缝，不是闸**：链尾无人应答 = 什么都不加（默认实现在 coreImpls 里）。
   * 它唯一的用处是钩子能往对话里补一段 —— 在这儿 deny 表达不出来（工具已经跑完了），
   * 所以别把它"统一"成 `tool.check` 那条 fail-closed 的形状。
   *
   * 只在工具**真的跑了**之后派：白名单外、权限 deny、用户拒了 ask、`tool.call` 返回 deny ——
   * 这四种情况下工具没执行过，给它们派一个"工具结果"事件是假账。
   */
  'tool.result': {
    readonly tool: string;
    readonly input: unknown;
    readonly toolUseId: string;
    /** `false` = 工具自己报了错（沿用 `content.startsWith('ERROR:')` 这条既有约定）。 */
    readonly ok: boolean;
    /** 模型将看到的那段正文（并进 context **之前**的原样）。 */
    readonly output: string;
  };
```

`EventResult` 里加：

```ts
  'tool.result': { readonly context?: string };
```

- [ ] **Step 2: 加链尾缝**

`src/core/create.ts` 的 `coreImpls`，紧挨着 `'skill.prompt'` 那条之后：

```ts
    // 与 skill.prompt 同一条分寸：**缝，不是闸**。没人要说话就什么都不加。
    // 在这儿 fail-closed 会让每一次工具调用都变成一次"没人应答"的拒绝。
    'tool.result': () => ({}) as const,
```

- [ ] **Step 3: 在 loop 里派发**

`src/core/loop.ts` 顶部加 `import { withContext } from '../contract/prompt-channel';`，
`runOneTool` 的末尾（`:278-279`）改成：

```ts
  const content = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  // 沿用既有那条判据（原先直接写在这一行的 `isError` 里）：工具自己报错时返回
  // 一段以 `ERROR:` 开头的正文。另立一套会让同一件事有两个判据。
  const ok = !content.startsWith('ERROR:');

  const observed = await ctx.dispatch(
    'tool.result',
    { tool: use.name, input: use.input, toolUseId: use.id, ok, output: content },
    CORE_ORIGIN,
  );

  return { toolUseId: use.id, content: withContext(content, observed.context), isError: !ok };
```

- [ ] **Step 4: 写测试**

`test/tool-result.test.ts`：用 `test/harness.ts` 现成的装配（照 `test/loop-options.test.ts` 的写法），
造一条 `toolless` 的假 provider，逐条验：

1. 工具跑成功 → `tool.result` 收到 `{tool, ok: true, output}`，且返回的 `context` 出现在模型下一条
   消息看到的 tool 结果里（断言 `messages` 里那条 `role: 'tool'` 的 `content` 含标记串与那段话）。
2. 工具返回 `ERROR: ...` → `ok: false`（而 `tool.result` 照样派 —— 工具**跑过**了）。
3. `tool.check` 判 deny → **一个 `tool.result` 都没派**。
4. `tool.call` 返回 deny → 没派。
5. 白名单外（传 `tools: new Set()`）→ 没派。
6. `ask` 用户答 `n` → 没派。

- [ ] **Step 5: typecheck** — `pnpm typecheck`。
- [ ] **Step 6: 提交** — `git commit -m "feat(p4d): tool.result —— 工具跑完之后，钩子能补一句话"`

---

## Task 3：`turn.stop`（新事件）与收手上限

**Files:**
- Modify: `src/contract/events.ts`
- Modify: `src/core/create.ts`
- Modify: `src/core/loop.ts:169-172`（收手支）与顶部常量
- Test: `test/turn-stop.test.ts`

- [ ] **Step 1: 加事件声明**

`EventArgs` 里（放在 `'prompt.submit'` 之后）：

```ts
  /**
   * 模型不再要工具、本 turn 准备收手的那一刻。P4d 新增，是 classic `Stop` 的着陆点。
   *
   * ⚠️ **缝，不是闸**：链尾无人应答 = 照常收手。返回非空 `block` = 不让收手，
   * 那段文本作为**一条新的 user 消息**推进去，本 turn 接着转。
   *
   * `lastMessage` 是模型这一轮说过的最后一段文本。没有它，"不让收手"就没有触发条件 ——
   * 一条 Stop 规则只能无条件地拦，那是绊脚石不是规则。
   */
  'turn.stop': { readonly stopHookActive: boolean; readonly lastMessage: string };
```

`EventResult` 里加：

```ts
  'turn.stop': { readonly block?: string };
```

- [ ] **Step 2: 加链尾缝**

```ts
    // 第三条缝。链尾是"钩子没意见"，所以默认什么都不做。
    'turn.stop': () => ({}) as const,
```

- [ ] **Step 3: 改 loop**

顶部常量区加：

```ts
/**
 * 一个 turn 内允许被 `turn.stop` 拦下来的次数上限。
 *
 * 参考实现把这件事交给钩子自己看 `stop_hook_active`，那是把死循环的责任推给写钩子的人。
 * 内核自己兜一道：超了就**忽略 block 并出声** —— 不是静默忽略，
 * "我拦了 4 次你都不理"与"我拦了 4 次"对写钩子的人是两条不同的信息。
 */
export const MAX_STOP_BLOCKS = 3;
```

`runTurn` 里 `let exhausted = true;` 那一行的下面加 `let blocked = 0;`，
收手支（`:169-172`）改成：

```ts
    if (toolUses.length === 0) {
      const stopped = await ctx.dispatch(
        'turn.stop',
        { stopHookActive: blocked > 0, lastMessage: text },
        CORE_ORIGIN,
      );
      const keepGoing = stopped.block?.trim() ?? '';
      if (keepGoing !== '') {
        if (blocked < MAX_STOP_BLOCKS) {
          blocked += 1;
          // 作为**一条新的 user 消息**推进去：它是"还没干完，接着干"的指令，
          // 本来就该是新一轮的输入。
          messages.push({ role: 'user', content: keepGoing });
          continue;
        }
        ctx.$.ui.notice(
          `钩子第 ${MAX_STOP_BLOCKS} 次不让收手，已忽略（再往下就该是死循环了）`,
        );
      }
      exhausted = false;
      break;
    }
```

`continue` 走下一跳，于是撞 hop 上限时 `exhausted` 仍是 `true` → `stopReason` 是 `max_hops` ——
**这是对的**：钩子不放手与模型不放手都该报"这趟没做完"。

- [ ] **Step 4: 写测试** `test/turn-stop.test.ts`
  1. 无人应答 → 一次就收手（`turn.stop` 收到 `{stopHookActive: false, lastMessage: <模型说的话>}`）。
  2. 一个 block 的钩子 → turn 多转了一轮，模型看到了那段话（断言第二条 user 消息）。
  3. 永远 block → 恰好转 `MAX_STOP_BLOCKS` 次后收手 + 一条 notice。
  4. 第一次 block 时 `stopHookActive: false`、第二次 `true`。
  5. `lastMessage` 真的是模型这一轮说的话（不是上一轮的、也不是空串）。

- [ ] **Step 5: typecheck** — `pnpm typecheck`。
- [ ] **Step 6: 提交** — `git commit -m "feat(p4d): turn.stop —— 钩子可以不让本轮收手，内核给它三次机会"`

---

## Task 4：`prompt.submit` 的 `context`

**Files:**
- Modify: `src/contract/events.ts`（`prompt.submit` 的 args 与 result）
- Modify: `src/cli/repl.ts:85-88`
- Modify: `src/cli/main.ts`（一次性模式）
- Test: `test/prompt-submit.test.ts`

- [ ] **Step 1: 加字段**

```ts
  'prompt.submit': { readonly text: string };
```
result 改成：
```ts
  /**
   * `context` 是 P4d 加的：钩子能在这一行进模型**之前**补一段。
   * 它是**契约变宽**，不是新事件 —— 与 P3 给 `tool.check` 加 `toolUseId` 同形。
   */
  'prompt.submit': { readonly handled?: boolean; readonly context?: string };
```

- [ ] **Step 2: REPL**

`src/cli/repl.ts`，`messages.push({ role: 'user', content: trimmed });` 改成：

```ts
    // 拼进**用户那条消息**，不是另插一条：两条连续的 user 消息是某些端点会拒的形状，
    // 我们没有理由为了一句补充说明去踩这个坑。代价是转录里也含这段 —— 这是对的，
    // 模型当时看到的就是这个。
    messages.push({ role: 'user', content: withContext(trimmed, submitted.context) });
```

- [ ] **Step 3: 一次性模式**

`src/cli/main.ts` 里 `messages.push({ role: 'user', content: oneShot });` 之前加：

```ts
  const submitted = await dispatch('prompt.submit', { text: oneShot }, CORE_ORIGIN);
  // 只采纳 `context`，**忽略 `handled`**：那个字段的语义是"这一行输入被吃掉了，别送给模型"，
  // 而一次性模式没有可以"继续"的交互循环 —— 把它当真会得到一个静默什么都没做、
  // 退出码 0 的调用（设计 §8 偏差 9）。
```

再改成 `messages.push({ role: 'user', content: withContext(oneShot, submitted.context) });`

- [ ] **Step 4: 写测试** `test/prompt-submit.test.ts`
  1. 没有钩子 → 消息就是原文（一个字节都不多）。
  2. 有钩子给 `context` → 消息含标记与那段话，且原文在**前面**。
  3. 钩子给 `handled: true` → REPL 不送模型（既有行为，钉住它没被破坏）。

- [ ] **Step 5: typecheck** — `pnpm typecheck`。
- [ ] **Step 6: 提交** — `git commit -m "feat(p4d): prompt.submit 能带一段上下文进用户的下一句话"`

---

## Task 5：`prompt.section` 转正，指令文件的装载搬出 `main.ts`

**Files:**
- Modify: `src/contract/events.ts`（`prompt.section` 从 `UnimplementedEvent` 移出）
- Create: `src/builtins/instructions.ts`
- Modify: `src/cli/main.ts`（删 `loadInstructions`，改组装）
- Modify: `src/cli/plugins.ts`（装 `instructions`）
- Test: `test/prompt-section.test.ts`

- [ ] **Step 1: 事件转正**

`EventArgs` 里加：

```ts
  /**
   * 系统提示的一个**节**。P4d 从声明-only 转正。
   *
   * 每个 hook 的形状是 `const inner = await next(e); return {sections: [...inner.sections, mine]}`，
   * 于是**内层在前**，而同一 tier 内"先注册的在外层" —— 同一 tier 内的节序是注册顺序的倒序。
   * 跨 tier 则是 tier 序。今天只有一个贡献者，这条规则写下来是给下一个看的。
   */
  'prompt.section': Record<string, never>;
```

`EventResult` 里加：

```ts
  'prompt.section': { readonly sections: readonly PromptSection[] };
```

并在 `ConfigEntry` 附近定义：

```ts
/** 系统提示里的一段。`name` 只给人看（调试、将来的排序），拼接不用它。 */
export type PromptSection = { readonly name: string; readonly text: string };
```

`UnimplementedEvent` 里**删掉** `'prompt.section'`。

- [ ] **Step 2: 链尾兜底**

```ts
    // 没人贡献 = 空清单。能力方向的 fail-closed：没有就是没有，不给一段假文本
    // —— 与 agent.offer 那条同一条。
    'prompt.section': () => ({ sections: [] }) as const,
```

- [ ] **Step 3: 建 `src/builtins/instructions.ts`**

```ts
import { join } from 'node:path';
import type { Plugin } from '../contract/plugin';

/**
 * 项目指令文件的装载：`AGENTS.md` / `CLAUDE.md` / `~/.deepcode/AGENTS.md`。
 *
 * P4d 之前这段硬编码在 `main.ts` 的 `loadInstructions` 里。搬进事件只有一个目的：
 * **摘掉这个插件的注册，指令就真的不再进系统提示** —— 一条能被测试钉住的因果关系，
 * 而不是一处谁都能绕过的字符串拼接。
 *
 * 读盘走 `$.fs` 而不是 `node:fs`：插件只碰 `$` 是这套架构里承重的那条线。
 * 只有 `ENOENT` 当"这个文件没有"；别的读不动**照旧抛出去** ——
 * `$.fs.exists` 把什么错都咽成 `false`，那会让一个权限错误变成一个安静的失效。
 */
export type InstructionsDeps = { readonly root: string; readonly home: string };

export function createInstructionsPlugin(deps: InstructionsDeps): Plugin {
  const files = [
    join(deps.root, 'AGENTS.md'),
    join(deps.root, 'CLAUDE.md'),
    join(deps.home, '.deepcode', 'AGENTS.md'),
  ];

  return {
    name: 'instructions',
    uses: ['prompt.section', 'fs'],
    register(on) {
      on('prompt.section', async ($) => {
        const parts: string[] = [];
        for (const file of files) {
          let text: string;
          try {
            text = await $.fs.read(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          parts.push(`Contents of ${file}:\n\n${text}`);
        }
        return parts.length === 0
          ? { sections: [] }
          : { sections: [{ name: 'instructions', text: parts.join('\n\n') }] };
      });
    },
  };
}
```

- [ ] **Step 4: 改 `main.ts`**

删掉 `loadInstructions`（连同它上面的注释）与 `readFile` / `existsSync` / `join` 里不再用到的 import，
把组装那三行改成：

```ts
  // 指令文件（AGENTS.md / CLAUDE.md）从 `prompt.section` 来 —— 摘掉那个插件的注册，
  // 它们就不再进提示。清单一节（renderOffer）**有意没走这条路**：
  // 它要的是 `agent.offer` 的结果，而插件拿不到 dispatch，把另一个事件的结果塞进
  // prompt.section 的 args 比留一处硬编码更坏（设计 §3.5）。
  const sections = await dispatch('prompt.section', {}, CORE_ORIGIN);
  const offer = await dispatch('agent.offer', {}, CORE_ORIGIN);
  const systemPrompt = [
    SYSTEM_PROMPT,
    ...sections.sections.map((section) => section.text),
    renderOffer(offer),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
```

- [ ] **Step 5: 装插件**

`src/cli/plugins.ts` 的 `firstParty` 里，`createAgentsMdPlugin({ root: deps.root }),` 之后加：

```ts
    // 指令文件（AGENTS.md / CLAUDE.md）从 `prompt.section` 来。
    createInstructionsPlugin({ root: deps.root, home: deps.home }),
```

- [ ] **Step 6: 写测试** `test/prompt-section.test.ts`
  1. 三个文件都在 → 一段 `sections[0].text` 含三份内容，顺序是 root/AGENTS → root/CLAUDE → home/AGENTS。
  2. 一个都没有 → `{sections: []}`。
  3. 读不动（拿一个目录当文件读）→ **抛**，不是安静的 `{sections: []}`。
  4. **装配级**：`cliPlugins(...)` 的清单里有一个名字叫 `instructions` 的插件，它注册了 `prompt.section`
     （照 `test/plugin-wiring.test.ts` 那条"模型文本的出口确实在这份清单里"的写法）。

- [ ] **Step 7: typecheck** — `pnpm typecheck`。
- [ ] **Step 8: 提交** — `git commit -m "feat(p4d): 系统提示的组装走过 prompt.section，指令文件的装载搬出 main.ts"`

---

### 检查点 C1（Task 1–5）

- [ ] `pnpm typecheck && pnpm lint` 绿。
- [ ] `pnpm vitest run test/prompt-channel.test.ts test/tool-result.test.ts test/turn-stop.test.ts test/prompt-submit.test.ts test/prompt-section.test.ts` 全绿。
- [ ] `pnpm test` 全绿（**不许有新增的 skip**：`grep -rn "it.skip\|describe.skip\|it.todo" test/` 为空）。
- [ ] 反向验证三条（**每条都要先 grep 确认变异真的落上了**）：
  1. `withContext` 的 `if (extra === '') return text;` 删掉 → 标记测试必须红。
  2. `runOneTool` 里把 `tool.result` 的派发挪到 `'tool.check'` **之前** → "被拒的工具不派发"必须红。
  3. `MAX_STOP_BLOCKS` 的 `continue` 改成 `break` → "多转一轮"必须红。
- [ ] 提交检查点记录（写进本文件的"实际结果"一节，见 Task 15）。

---

## Task 6：`classify` 多读一个字段（`additionalContext`）

**Files:**
- Modify: `src/cli/hook-run.ts:34-51`（`HookVerdict`）与 `:187-231`（`classify`）
- Test: `test/hook-run.test.ts`

- [ ] **Step 1: 加字段**

```ts
export type HookVerdict =
  | { readonly kind: 'silent'; readonly context?: string }
  | { readonly kind: 'say'; readonly decision: 'allow' | 'ask' | 'deny'; readonly reason: string | undefined; readonly context?: string }
  | { readonly kind: 'block'; readonly reason: string; readonly context?: string }
  | { readonly kind: 'fail'; readonly reason: string; readonly context?: string };
```

顶部注释补一句：

```
 * `context` 来自 `hookSpecificOutput.additionalContext`（或顶层同名）—— 那是参考实现里
 * **通用**的那一个字段，而 `permissionDecision` 只是它的一种用法。判定是判定、上下文是上下文，
 * 两者可以同时出现，也可以只有后者（PostToolUse / UserPromptSubmit 上就只有后者）。
```

- [ ] **Step 2: 读它**

`classify` 里，算完 `reason` 之后（`return` 之前）：

```ts
  const rawContext = holder.additionalContext ?? record.additionalContext;
  const context =
    typeof rawContext === 'string' && rawContext.trim() !== '' ? rawContext : undefined;
```

三处 `return` 各带上 `context`；`silent` 那两个分支（JSON 读不出来、非对象）**不带** ——
那时候连 JSON 都没解析出来，没有 `additionalContext` 可言。判定读不出来（`fail`）时**带上**：
一段能说的文本不该因为判定写错就一起丢掉。

- [ ] **Step 3: 写测试**（补进 `test/hook-run.test.ts`）
  1. 只有 `additionalContext` → `silent` + `context`。
  2. `permissionDecision` + `additionalContext` → `say` + `context`。
  3. `additionalContext` 不是字符串（数字 / 对象）→ 当没有。
  4. 空的 / 纯空白 → 当没有。
  5. 顶层与 `hookSpecificOutput` 各来一次都读得到。

- [ ] **Step 4: typecheck** — `pnpm typecheck`。
- [ ] **Step 5: 提交** — `git commit -m "feat(p4d): classify 认识 additionalContext —— 判定之外，钩子还能说一段话"`

---

## Task 7：classic 桥从三个扩到六个

**Files:**
- Modify: `src/contract/classic.ts:61-80`
- Modify: `src/cli/classic-hooks.ts:31-47` 与新增的三支
- Modify: `src/contract/plugin-manifest.ts:367-372`（`W3` 的文案）
- Test: `test/classic-hooks.test.ts`、`test/plugin-manifest.test.ts`

- [ ] **Step 1: 桥接表**

```ts
export const BRIDGED_EVENTS = {
  PreToolUse: 'tool.check',
  PostToolUse: 'tool.result',
  UserPromptSubmit: 'prompt.submit',
  Stop: 'turn.stop',
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
} as const;
```

上面的注释改成（原来是"只有三个，因为只有这三个已经有着陆点"）：

```
 * 六个。P4d 之前只有三个，因为 `PostToolUse` 要一个 `tool.result` 事件、`Stop` 与
 * `UserPromptSubmit` 要一条能携带文本的通道 —— P4d 把这三样都做出来了（设计 §4）。
 *
 * `PostToolUseFailure` 仍然不桥：它需要一份**失败专用**的载荷（参考实现里是 `error` 之类），
 * 而那份形状我们没核实过。按已知的写会编出一个错的 stdin，"如实缺着"更便宜。
```

- [ ] **Step 2: `registerHooks` 按落点分派**

```ts
export function registerHooks(on: On, deps: ClassicHooksDeps): void {
  for (const group of deps.groups) {
    const bridged = BRIDGED_EVENTS[group.event];

    // 两个工具事件共用一支：它们都要 matcher（`tool.result` 的参数里也有 `tool`）。
    if (bridged === 'tool.check' || bridged === 'tool.result') {
      const hook = bridged === 'tool.check' ? makeCheck(deps, group) : makeObserver(deps, group);
      if (group.tools === undefined) on(bridged, hook);
      else for (const tool of group.tools) on(bridged, { tool }, hook);
      continue;
    }

    if (bridged === 'prompt.submit') { on('prompt.submit', makePromptInjector(deps, group)); continue; }
    if (bridged === 'turn.stop') { on('turn.stop', makeStopBlocker(deps, group)); continue; }
    // 剩下两个都是生命周期通知。
    on(bridged, makeNotifier(deps, group));
  }
}
```

三支新增的写法（`makeCheck` / `makeNotifier` 不动）：

```ts
/** 共用：把一组钩子跑完，收集它们想说的话（`context`）。 */
async function collect(deps: ClassicHooksDeps, group: ResolvedHookGroup, input: unknown): Promise<string[]> {
  const said: string[] = [];
  for (const def of group.hooks) {
    const result = await runHook(def, input, context(deps));
    const verdict = classify(result);
    if (verdict.kind === 'fail') {
      // 非阻断事件上，"一个坏掉的钩子必须让动作停下来"这条不适用 —— 已经发生的事停不了。
      // 让一段来路不明的文本进模型上下文才是更坏的方向，所以只吭一声。
      $.ui.notice(...)  // 见下：这个不带 $ 的版本把 notice 交给调用方
      continue;
    }
    if (verdict.context !== undefined) said.push(verdict.context);
  }
  return said;
}
```

⚠️ `collect` 拿不到 `$`（`ui` 在 hook 的第一个参数里），所以失败提示由调用方打。
三支的实现按这张表（**spec §4.1 是权威**）：

| 事件 | `silent` | `exit 2`（block） | `say` | `fail` |
| --- | --- | --- | --- | --- |
| PostToolUse / UserPromptSubmit | `context` 注入 | `reason` 当 `context` | **忽略并喊一声** | notice，不注入 |
| Stop | 不注入 | `reason` 当 `block` | deny → `block`；allow/ask 忽略并喊一声 | notice，不 block |

`makeObserver`（`tool.result`）：

```ts
function makeObserver(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: 'PostToolUse',
      tool_name: e.tool,
      tool_input: e.input,
      tool_use_id: e.toolUseId,
      // 我们自己的形状（`{ok, output}`），不是参考实现那一个。如实标在 README 里。
      tool_response: { ok: e.ok, output: e.output },
    };
    const ours = await runGroup($, deps, group, input);
    const inner = await next(e);
    const all = [...ours, ...(inner.context ? [inner.context] : [])];
    return all.length === 0 ? inner : { ...inner, context: all.join('\n\n') };
  };
}
```

`makePromptInjector`（`prompt.submit`）：input 是
`{session_id, transcript_path, cwd, hook_event_name: 'UserPromptSubmit', prompt: e.text}`；
`const inner = await next(e); return all.length === 0 ? inner : { ...inner, context: all.join('\n\n') };`
—— **`...inner` 保住 `handled`**，一个填了 `handled` 的钩子在别的插件那儿仍然算数。

`makeStopBlocker`（`turn.stop`）：input 是
`{session_id, transcript_path, cwd, hook_event_name: 'Stop', stop_hook_active: e.stopHookActive, last_assistant_message: e.lastMessage}`；
返回值 `const inner = await next(e); return block === undefined ? inner : { block: inner.block ?? block };`
（我们拦了就用我们的文本，否则让下层的过去）。

`runGroup`：把上面 `collect` 的那段收进来，带 `$`，所以失败时打得出一行 notice：

```ts
/** 跑完一组钩子，返回它们想注入的文本（按顺序）。非阻断事件上**不改裁决**。 */
async function runGroup($: any, deps: ClassicHooksDeps, group: ResolvedHookGroup, input: unknown): Promise<string[]> {
  const said: string[] = [];
  for (const def of group.hooks) {
    const result = await runHook(def, input, context(deps));
    const verdict = classify(result);
    if (verdict.kind === 'fail') {
      $.ui.notice(`[钩子 ${deps.plugin}] 没跑成：${verdict.reason}（这个事件上没有可拦的动作，只吭一声）`);
      continue;
    }
    // `exit 2` 在拦不住的事件上**降级成"说话"**：它的 stderr 本来就是写给模型看的。
    if (verdict.kind === 'block') { said.push(verdict.reason); continue; }
    if (verdict.kind === 'silent') { if (verdict.context !== undefined) said.push(verdict.context); continue; }
    // `say`：判定在这些事件上表达不出来。当它没说过，但**喊一声** ——
    // 与第三方 allow 那条一字不差：静默忽略会让人以为自己写对了。
    if (verdict.decision === 'deny' && group.event === 'Stop') { said.unshift(verdict.reason ?? ''); continue; }
    $.ui.log(`[钩子 ${deps.plugin}] 给了一个 ${verdict.decision} 判定，但 ${group.event} 上表达不出来（能表达的只有${group.event === 'Stop' ? ' deny' : '一段补充上下文'}），已忽略。`);
  }
  return said.filter((line) => line !== '');
}
```

`Stop` 上 `deny` 要变成 `block`，所以 `makeStopBlocker` 从 `runGroup` 的返回值里取第一段当 block；
其余两处取全部并 `join('\n\n')` 当 context。**这处"返回值靠位置区分"是这一支里最容易读岔的地方，
注释要写清**。

- [ ] **Step 3: `W3` 文案改成推导出来的**

`src/contract/plugin-manifest.ts:367` 那句写死了"只桥接了 PreToolUse / SessionStart / SessionEnd"，
改成 `只桥接了 ${Object.keys(BRIDGED_EVENTS).join(' / ')}`，并加一条测试断言它跟着表走
（`test/plugin-manifest.test.ts`：把 `Stop` 从表里去掉会让某条断言红是做不到的 ——
改成断言这行文案里出现的是**表里的全部**六个名字，而不是那三个旧的）。

- [ ] **Step 4: 写测试**（补进 `test/classic-hooks.test.ts`）

新增 fixture：`test/fixtures/hooks/say-context.mjs`（exit 0，输出 `{hookSpecificOutput:{additionalContext:'...'}}`）。
六个事件各验：
1. `PostToolUse` 的 `additionalContext` 真的进了 `tool.result` 的 `context`。
2. `PostToolUse` 上 `exit 2` 的 stderr 变成 `context`（**降级**这条要单独钉）。
3. `UserPromptSubmit` 的 `additionalContext` 进了 `prompt.submit` 的 `context`，且 `handled` 没被冲掉。
4. `Stop` 上 `permissionDecision: 'deny'` → `{block: reason}`。
5. `Stop` 上 `permissionDecision: 'allow'` → 不 block，且**喊了一声**（用假 `$` 收集 `ui.log`）。
6. `SessionStart` / `SessionEnd` 的既有行为没变（打一行 / notice）。
7. matcher：`PostToolUse` 写 `matcher: "Write"` 时只对 Write 生效。

- [ ] **Step 5: typecheck** — `pnpm typecheck`。
- [ ] **Step 6: 提交** — `git commit -m "feat(p4d): classic 钩子从三个事件扩到六个，判定按事件分表"`

---

## Task 8：hookify 的逐事件词表

**Files:**
- Modify: `plugins/hookify/core/rules.mjs`
- Test: `test/hookify.test.ts`

- [ ] **Step 1: 词表与 `event` 字段**

```js
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];
const EVENT_SET = new Set(EVENTS);
/**
 * 逐事件词表：**只有这个事件上能兑现的动作才允许写**。
 *
 * 与当年砍掉 `allow` 是同一条道理的另一个方向：在那个事件上表达不出来的东西，
 * 不该让它看起来能写。`PostToolUse` 上写 `deny` 是空头承诺 —— 工具已经跑完了。
 * `Stop` 上继续用 `deny`（"不允许停止"本来就是一次拒绝），不另发明一个词。
 */
const DECISIONS_BY_EVENT = {
  PreToolUse: ['deny', 'ask'],
  PostToolUse: ['notify'],
  UserPromptSubmit: ['notify'],
  Stop: ['deny'],
};
/** 省略 `decision` 时的默认值：无非只有一个选择，或有多个时那个更保守的。 */
const DEFAULT_DECISION = { PreToolUse: 'deny', PostToolUse: 'notify', UserPromptSubmit: 'notify', Stop: 'deny' };
```

`KNOWN_KEYS` 加 `'event'`；`REQUIRED` **不动**（`decision` 本来就不是必填）。

`parseRule` 里加：

```js
  const event = fm.event ?? 'PreToolUse';
  if (!EVENT_SET.has(event)) {
    throw new RuleError(`${source}: 不认识的 event "${event}"（支持 ${EVENTS.join(' / ')}）`);
  }
  const allowed = DECISIONS_BY_EVENT[event];
  const decision = fm.decision ?? DEFAULT_DECISION[event];
  if (!allowed.includes(decision)) {
    throw new RuleError(
      `${source}: 在 ${event} 上写了 decision "${decision}" —— 这个事件上能表达的是 ${allowed.join(' / ')}。` +
        (event === 'PreToolUse'
          ? 'allow 是表达不出来的：第三方插件只能拧紧不能拧松，一条放行规则在这里只会是空头承诺。'
          : '工具已经跑完了 / 提示词已经要进去了，"拒绝"在这个点上兑现不了。'),
    );
  }
```

规则对象上加 `event`。

- [ ] **Step 2: `evaluate` 变成逐事件**

签名改成 `evaluate(rules, event, subject, toolName)`：

```js
/**
 * 对一次事件求值。返回 `{ decision, reason }`，或 `undefined`（没意见）。
 *
 * `subject` 是**这个事件给规则看的那个对象**（逐事件一张表，见 README）：
 * PreToolUse 是 `tool_input`、PostToolUse 是 `{ok, output}`、
 * UserPromptSubmit 是 `{prompt}`、Stop 是 `{last_assistant_message}`。
 *
 * 只跑 `rule.event === event` 的规则 —— 但**所有**规则文件照旧全部解析，
 * 于是一条写坏了的规则在任何事件上都会让钩子失败（而不是"平时没事，用到才炸"）。
 */
export function evaluate(rules, event, subject, toolName) {
  const hits = rules.filter((rule) => rule.event === event).filter((rule) => {
    if (event === 'PreToolUse' && !toolMatches(rule.tool, toolName)) return false;
    if (rule.tool !== undefined && event !== 'PreToolUse') return false;   // 别的三个事件没有工具可筛
    const value = subject !== null && typeof subject === 'object' ? subject[rule.field] : undefined;
    if (typeof value !== 'string') return false;
    return test(rule.operator, value, rule.pattern);
  });
  ... // 后半段（deny 优先、理由拼装）原样不动
}
```

- [ ] **Step 3: 写测试**（补进 `test/hookify.test.ts`）
  1. 省略 `event` = `PreToolUse`（既有用例一个字不改，这就是回归证明）。
  2. 不认识的 `event` → `RuleError` 且消息里有那个值。
  3. **八条非法组合**（四个事件 × 各自不许的词）逐条 `RuleError`，且消息里点名"能表达的是…"。
  4. 四条合法组合各自解析通过。
  5. 逐事件的 `field` 取值处：`PostToolUse` 的 `field: output` 命中 `{ok, output}`；
     `UserPromptSubmit` 的 `field: prompt`；`Stop` 的 `field: last_assistant_message`。
  6. 一条 `PreToolUse` 的规则在 `PostToolUse` 上**不命中**（事件必须对上）。

- [ ] **Step 4: typecheck** — `pnpm typecheck`。
- [ ] **Step 5: 提交** — `git commit -m "feat(p4d): hookify 的规则能写在四个事件上，每个事件只有它能兑现的词汇"`

---

## Task 9：hookify 的脚本、清单与文档

**Files:**
- Rename: `plugins/hookify/hooks/pretooluse.mjs` → `plugins/hookify/hooks/hook.mjs`
- Modify: `plugins/hookify/hooks/hooks.json`、`plugins/hookify/plugin.json`
- Modify: `plugins/hookify/README.md`
- Test: `test/hookify.test.ts`、`test/plugin-e2e.test.ts`、`test/cli.test.ts`

- [ ] **Step 1: 脚本改名 + 分派**

`git mv plugins/hookify/hooks/pretooluse.mjs plugins/hookify/hooks/hook.mjs`，
然后改：

```js
const event = typeof input?.hook_event_name === 'string' ? input.hook_event_name : '';
if (!EVENTS.includes(event)) {
  die(`stdin 里的 hook_event_name 是 ${JSON.stringify(event)}，不在 ${EVENTS.join(' / ')} 里`);
}

// 逐事件给规则看的那个对象。与 README 里那张表一一对应。
const subject =
  event === 'PreToolUse' ? input?.tool_input
  : event === 'PostToolUse' ? input?.tool_response
  : event === 'UserPromptSubmit' ? { prompt: input?.prompt }
  : { last_assistant_message: input?.last_assistant_message };

const verdict = evaluate(rules, event, subject, String(input?.tool_name ?? ''));
if (verdict === undefined) process.exit(0);

const out =
  verdict.decision === 'notify'
    ? { additionalContext: verdict.reason }
    : { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason };

process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...out } })}\n`);
process.exit(0);
```

文件头那段"失败方向是 fail-closed"的注释补一句：**同一个坏了，代价看在哪个事件上** ——
在 `PreToolUse` 上拦下所有工具调用，在另外三个上退化成"notice 一声、什么都不注入/不 block"。

- [ ] **Step 2: `hooks.json` 四个事件**

```json
{
  "description": "把 .deepcode/hookify.*.local.md 里的规则编译成四个事件上的钩子判定",
  "hooks": {
    "PreToolUse":      [{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "timeout": 10 }] }],
    "PostToolUse":     [{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "timeout": 10 }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "timeout": 10 }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "timeout": 10 }] }]
  }
}
```

- [ ] **Step 3: `plugin.json` 的 `uses`**

```json
  "uses": ["tool.check", "tool.result", "prompt.submit", "turn.stop"],
```

**不改这一条，整个插件在装载期会被撤掉**（`core/third-party.ts` 按事件名查越界），
而 `plugin-manifest.ts` 的 `W10` 正是为了提前把这句话说出来。

- [ ] **Step 4: `plugins/hookify/README.md`** —— 补四节：`event` 字段与逐事件词表、
  逐事件的 `field` 取值处、四个事件、失败代价的差别；`allow` 仍然是错误那段保留。

- [ ] **Step 5: 测试**
  - `test/hookify.test.ts` 里凡是直接跑 `hooks/pretooluse.mjs` 的，路径改成 `hook.mjs` 并补上 stdin 的
    `hook_event_name`（**少了它现在会 `die`** —— 这正是它该有的样子）。
  - 新增端到端：四个事件各起一次真进程（照现有那条 `spawn` 的写法），断言四种输出形状。
  - `test/plugin-e2e.test.ts` / `test/cli.test.ts` 里出现 `pretooluse.mjs` 字样的地方一并改。

- [ ] **Step 6: typecheck** — `pnpm typecheck`。
- [ ] **Step 7: 提交** — `git commit -m "feat(p4d): hookify 一个脚本管四个事件，清单与文档跟上"`

---

### 检查点 C2（Task 6–9）

- [ ] `pnpm typecheck && pnpm lint` 绿。
- [ ] `pnpm vitest run test/hook-run.test.ts test/classic-hooks.test.ts test/plugin-manifest.test.ts test/hookify.test.ts test/plugin-e2e.test.ts` 全绿。
- [ ] `pnpm test` 全绿；`grep -rn "pretooluse" src/ test/ plugins/` 只剩历史文档里的字样。
- [ ] 反向验证三条：
  1. `registerHooks` 里把 `PostToolUse` 那一支的 `tool_response` 换成 `e.input` → hookify 的 PostToolUse 用例必须红。
  2. `runGroup` 里把 `exit 2` 那条降级分支删掉 → "exit 2 在 PostToolUse 上降级成上下文"必须红。
  3. `plugins/hookify/plugin.json` 的 `uses` 删掉 `"turn.stop"` → **装载期撤插件**那条必须红。

---

## Task 10：设置层的 `telemetry`

**Files:**
- Modify: `src/cli/settings.ts`（`KNOWN_TOP_LEVEL`、新的层解析、`ResolvedPolicy`）
- Modify: `test/cli.test.ts`、`test/plugin-wiring.test.ts`（`ResolvedPolicy` 字面量）
- Test: `test/settings.test.ts`

**⚠️ 这一步必须一起改**：`telemetry` 是 `ResolvedPolicy` 的必填字段，加上它的同一刻
那两个文件里手写的字面量就过不了 `tsc`。

- [ ] **Step 1: 类型与解析**

```ts
/**
 * 遥测开关。**只有用户层能开、托管层能关**（设计 §6.4）：
 *
 *   enabled = (用户层 === true) && (托管层 !== false)
 *
 * 一个克隆下来的仓库不该悄悄打开你的遥测 —— 与 `plugins.enableByUser` 完全同构。
 * 托管层那句话压过用户层，是"只能更严"在这份设置上的落法：它管不了你开不开，
 * 但能一句话把它关掉。
 */
export type TelemetryPolicy = {
  readonly enabled: boolean;
  /** 为什么是这个值。给 `/telemetry` 直接打出来 —— 一个不给理由的开关没人敢用。 */
  readonly why: string;
};
```

`KNOWN_TOP_LEVEL` 加 `'telemetry'`；`TelemetryLayer = { enabled?: boolean }`；
`readLayer` 里像 `compact` 那样读一层；组装段：

```ts
  const telemetry: TelemetryPolicy = (() => {
    for (const source of SETTINGS_SOURCES) {
      if (source === 'user' || source === 'policy') continue;
      if (telemetryLayers.get(source)?.enabled !== undefined) {
        warn(`${label(source)} 里写了 telemetry.enabled —— 只有用户层能开遥测，这一份已丢弃。`);
      }
    }
    if (telemetryLayers.get('user')?.enabled !== true) {
      return { enabled: false, why: '默认关（没有哪一层说要开）' };
    }
    if (telemetryLayers.get('policy')?.enabled === false) {
      return { enabled: false, why: '托管层把它关了（压过用户层）' };
    }
    return { enabled: true, why: '用户层开了' };
  })();
```

`ResolvedPolicy` 加 `readonly telemetry: TelemetryPolicy;`。

- [ ] **Step 2: 补字面量**

`test/cli.test.ts` / `test/plugin-wiring.test.ts` 里所有 `ResolvedPolicy` 字面量加
`telemetry: { enabled: false, why: '默认关（没有哪一层说要开）' }`。

- [ ] **Step 3: 写测试**（`test/settings.test.ts`）
  1. 谁都没写 → 关 + `why` 是"默认关"。
  2. 用户层 `true` → 开。
  3. 用户层 `true` + 托管层 `false` → 关 + `why` 里有"托管层"。
  4. 项目层 `true` → 关，且 `warn` 收到一句话。
  5. `--settings`（flag 层）写 `true` → 同上。
  6. `telemetry` 不是对象 / `enabled` 不是布尔 → 那一层按空处理并 warn（沿用既有 `readLayer` 的破法）。

- [ ] **Step 4: typecheck** — `pnpm typecheck`。
- [ ] **Step 5: 提交** — `git commit -m "feat(p4d): telemetry 设置 —— 只有你能开，托管层随时能关"`

---

## Task 11：遥测的纯逻辑（`telemetry-rows.ts`）

**Files:**
- Create: `src/cli/telemetry-rows.ts`
- Test: `test/telemetry-rows.test.ts`

- [ ] **Step 1: 写实现**

```ts
/**
 * 遥测的纯逻辑：一条插件给的记录怎么算合格、一行怎么拼。
 *
 * 没有 IO —— 读盘写盘全在 telemetry-sink.ts 里。拆开是为了让"什么算自由文本"
 * 能被穷举测试：这条协议是这份功能**唯一**的隐私闸门，松一格就没了。
 */
import { join } from 'node:path';

/**
 * 一个标识符：字母数字开头，只含 `[A-Za-z0-9_.:-]`，最长 64。
 *
 * 这条路是**故意窄的**：它要挡住的不是"奇怪的字符"，是自由文本本身 ——
 * 一个空格、一个斜杠、一个引号之后就该走别的路（或者干脆别记）。
 * 工具名（`Bash` / `mcp__x__y`）与日期时间戳都能过，文件路径过不去，这正是想要的。
 */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export type TelemetryFields = Readonly<Record<string, number | boolean | string>>;

export type TelemetryEntry = { readonly kind: string; readonly fields?: TelemetryFields };

/** 落到磁盘上的一行。`at` / `seq` 是**我们**补的，不走插件校验。 */
export type TelemetryRow = {
  readonly at: string;
  readonly seq: number;
  readonly kind: string;
  readonly fields: TelemetryFields;
};

export type ValidateResult =
  | { readonly ok: true; readonly kind: string; readonly fields: TelemetryFields }
  | { readonly ok: false; readonly reason: string };

export function validateEntry(entry: TelemetryEntry): ValidateResult {
  if (typeof entry?.kind !== 'string' || !IDENT.test(entry.kind)) {
    return { ok: false, reason: `kind ${JSON.stringify(entry?.kind)} 不是标识符（自由文本记不进遥测）` };
  }
  const fields: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (!IDENT.test(key)) return { ok: false, reason: `字段名 ${JSON.stringify(key)} 不是标识符` };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, reason: `字段 ${key} 是 ${value}，不是有限数字` };
      fields[key] = value;
      continue;
    }
    if (typeof value === 'boolean') { fields[key] = value; continue; }
    if (typeof value === 'string' && IDENT.test(value)) { fields[key] = value; continue; }
    return { ok: false, reason: `字段 ${key} 的值是自由文本（只许有限数字 / 布尔 / 标识符）` };
  }
  return { ok: true, kind: entry.kind, fields };
}

export function formatRow(row: TelemetryRow): string {
  return `${JSON.stringify(row)}\n`;
}

/** 行都落在一个文件里 —— 一天一个文件会攒出一片没人删的目录，而它本来就是给 `tail` 看的。 */
export function telemetryPath(home: string): string {
  return join(home, '.deepcode', 'telemetry.jsonl');
}
```

- [ ] **Step 2: 写测试**（`test/telemetry-rows.test.ts`）
  正的：`kind: 'turn.complete'`、字段名带 `_`、值是数字 / 布尔 / `Bash` / `2026-10-11T10:00:00.000Z`。
  反的（**每条都要有自己的用例**）：kind 空 / kind 带空格 / kind 带中文 / kind 超 64 / kind 以 `-` 开头 /
  键带空格 / 值是 `NaN` / `Infinity` / `undefined` / 对象 / 数组 / 含空格的字符串。
  `formatRow` 是一行一个 `\n`、能被 `JSON.parse` 回读。`telemetryPath` 拼在用户级。

- [ ] **Step 3: typecheck** — `pnpm typecheck`。
- [ ] **Step 4: 提交** — `git commit -m "feat(p4d): 遥测的零自由文本行协议"`

---

## Task 12：带缓冲的写盘（`telemetry-sink.ts`）

**Files:**
- Create: `src/cli/telemetry-sink.ts`
- Test: `test/telemetry-sink.test.ts`

- [ ] **Step 1: 写实现**

```ts
/**
 * 遥测的写盘面 —— 全项目**第二处**直接写文件的地方（第一处是转录）。
 *
 * IO 全部注入（`append` / `mkdir` / `now`）：于是"关掉时零输出"这条能被测
 * （用一个会抛的 `mkdir` 断言它根本没被调用），而不是靠读代码相信。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatRow, telemetryPath, validateEntry, type TelemetryEntry, type TelemetryRow } from './telemetry-rows';

/** 缓冲多少行冲一次。 */
export const BATCH_SIZE = 20;

export type TelemetrySink = {
  /** 记一条。**同步返回** —— 它挂在链上，不该让任何一次工具调用等磁盘。 */
  record(entry: TelemetryEntry): void;
  /** 把缓冲区写下去。`session.end` 与测试用。 */
  flush(): Promise<void>;
  readonly stats: {
    readonly written: number;
    readonly rejected: number;
    readonly lastReject: string | undefined;
    readonly lastError: string | undefined;
    readonly path: string;
  };
};

export type TelemetrySinkDeps = {
  readonly home: string;
  readonly enabled: boolean;
  readonly warn: (line: string) => void;
  /** 测试注入用；生产省略。 */
  readonly mkdir?: (path: string) => Promise<void>;
  readonly append?: (path: string, text: string) => Promise<void>;
  readonly now?: () => Date;
};
```

实现要点（**每一条都有对应的测试**）：

- `enabled === false`：`record` 直接 `return`，`flush` 直接 `return`
  —— **不建目录、不开文件、不打任何一行**（出口标准 4）。连 `mkdir` 都不许调到。
- 校验不过：`rejected += 1`、`lastReject = reason`，**第一次**出现时 `warn` 一行；
  这条不进缓冲、不落盘。（不截断、不改写 —— 一条被改写过的行比一条丢了更难查。）
- 缓冲到 `BATCH_SIZE` 就异步冲一次（`void this.flush()`，不 await）。
- `flush` 一次 `append(text)` 写完这一批（与转录同一个写法定式）。
- 写失败：`lastError` 记下来，`warn` **一次**，之后不再重试也不再抱
  —— 遥测坏掉不该让会话坏掉。
- `mkdir(dirname(path), { recursive: true })` 只在第一次真的要写的时候调。

- [ ] **Step 2: 写测试**（`test/telemetry-sink.test.ts`）
  1. **关掉时零输出**：注入会抛的 `mkdir` / `append`，记 100 条 → 一个都没被调用，`written === 0`。
  2. 开着时：记 19 条不落盘，第 20 条落一整个批次。
  3. `flush` 落掉不足一批的那些。
  4. 被拒的条目不落盘、`rejected` 计数、`warn` 只在第一次响。
  5. 写失败只 `warn` 一次，且后续 `record` 不抛。
  6. 真文件（临时目录）：文件存在、内容能逐行 `JSON.parse`、POSIX 上权限是 `0o600`
     （`process.platform === 'win32'` 时跳过这一条，与转录的测试同一条写法）。

- [ ] **Step 3: typecheck** — `pnpm typecheck`。
- [ ] **Step 4: 提交** — `git commit -m "feat(p4d): 遥测的行写入面 —— 批量、可注入、关掉时一个系统调用都不发"`

---

## Task 13：`$.telemetry` 名词、六个事件、`/telemetry`

**Files:**
- Create: `src/cli/telemetry.ts`
- Modify: `src/cli/plugins.ts`（装插件 + 座位）
- Test: `test/telemetry.test.ts`

- [ ] **Step 1: 插件本体**

```ts
import type { Plugin } from '../contract/plugin';
import type { TelemetryPolicy } from './settings';
import { createTelemetrySink, type TelemetrySink } from './telemetry-sink';
import type { TelemetryEntry } from './telemetry-rows';

/**
 * 遥测名词 —— 插件通过 `engine.create` 折叠往 `$` 上加东西（`contract/engine.ts:91-98`
 * 那段注释描述的就是它）。
 */
export type TelemetryNoun = { log(entry: TelemetryEntry): void };

declare module '../contract/engine' {
  interface EngineInterface { telemetry: TelemetryNoun }
}

export type TelemetryPluginDeps = {
  readonly home: string;
  readonly policy: TelemetryPolicy;
  readonly sessionId: string;
  readonly warn: (line: string) => void;
  /** 测试注入用；生产省略。 */
  readonly sink?: TelemetrySink;
};
```

`register(on)` 里：

```ts
      // 折叠：`{...beneath}` 先铺开，自己那份盖上去 —— **靠外的赢**。
      // 外层是权威更高的 tier（tier 权威序：prepend > user > append > builtin > core），
      // 于是"两个插件都提供同名名词"时由更权威的那个说了算，与其他所有裁决同向。
      on('engine.create', async (_$, e, next) => ({ ...(await next(e)), telemetry: noun }));

      on('session.start', (_$, e, next) => { write({kind:'session.start', fields:{session: deps.sessionId}}); return next(e); });
      on('turn.complete', (_$, e, next) => { write({kind:'turn.complete', fields:{stopReason:e.stopReason, inputTokens:e.inputTokens, outputTokens:e.outputTokens, estimated:e.usageEstimated === true}}); return next(e); });
      on('tool.result', (_$, e, next) => { write({kind:'tool.result', fields:{tool:e.tool, ok:e.ok}}); return next(e); });
      on('session.compact', (_$, e, next) => { write({kind:'session.compact', fields:{trigger:e.trigger, tokensBefore:e.tokensBefore}}); return next(e); });
      on('agent.spawn', (_$, e, next) => { write({kind:'agent.spawn', fields:{agent:e.name}}); return next(e); });
      // 收场前冲盘。**不 await 到会挡住退出的程度**：sink 自己把失败咽成一句 warn。
      on('session.end', async (_$, e, next) => { write({kind:'session.end', fields:{reason:e.reason}}); await sink.flush(); return next(e); });

      on('command.describe', { name: 'telemetry' }, () => ({ description: '看遥测开关与本次会话写了多少行' }));
      on('command.run', { name: 'telemetry' }, ($) => { $.ui.log(renderStatus()); return { handled: true }; });
```

**每一条 hook 都 `return next(e)`** —— 遥测是**读者**，不是链上的一环。这一条要写进注释：
挂在 `tool.result` 而不是 `tool.call` 上，正是为了让它在工具执行路径之外。

`renderStatus()` 打出：开关 + `why` + 路径 + 本次会话行数 + 拒了几行（带第一次拒绝的理由）。

`uses`：`['engine.create','session.start','session.end','turn.complete','tool.result','session.compact','agent.spawn','command.run','command.describe','ui']`。

- [ ] **Step 2: 装进 `cliPlugins`**

`firstParty` 末尾（`createConfigCommand(...)` 之后）加：

```ts
    createTelemetryPlugin({
      home: deps.home,
      policy: deps.policy.telemetry,
      sessionId: deps.sessionId,
      warn: deps.warn,
    }),
```

于是 `CliPluginDeps` 要加两样：`readonly sessionId: string;` 与 `readonly warn: (line: string) => void;`
（`main.ts` 里 `sessionId` 已经算出来了、`warn` 就是现成的那个 `warnLine`）。
座位不用特殊给（默认 `builtin`）：它不裁决任何动作。

- [ ] **Step 3: 写测试**（`test/telemetry.test.ts`）
  1. `$.telemetry` 在折叠后真的存在（`createEngine` 出来的 `$` 上）。
  2. 六个事件各记一行，字段与事件参数对得上（用假 sink 收集）。
  3. `session.end` 之后 `flush` 被调过。
  4. **一条 hook 都没改裁决**：`tool.result` 的返回值与没人挂它时逐字节相同（`{}`）。
  5. 关着的时候：走完一整个 `session.start → turn.complete → session.end`，假 sink 收到 6 条
     `record` 调用但 `written === 0`、`append` 一次没调。
  6. `/telemetry` 的输出里有开关、`why`、路径、行数。
  7. **装配级**：`cliPlugins(...)` 的清单里有 `telemetry`（照 `plugin-wiring.test.ts` 的写法）。

- [ ] **Step 4: typecheck** — `pnpm typecheck`。
- [ ] **Step 5: 提交** — `git commit -m "feat(p4d): \$.telemetry —— 六个事件各记一行，不改任何裁决"`

---

### 检查点 C3（Task 10–13）

- [ ] `pnpm typecheck && pnpm lint` 绿。
- [ ] `pnpm vitest run test/settings.test.ts test/telemetry-rows.test.ts test/telemetry-sink.test.ts test/telemetry.test.ts` 全绿。
- [ ] `pnpm test` 全绿（44 个文件 → 预计 53 个上下）；无新增 skip。
- [ ] 反向验证三条：
  1. `validateEntry` 的字符串分支换成 `typeof value === 'string'` → "自由文本被拒"必须红。
  2. `enabled = user === true && policy !== false` 里的 `&& policy !== false` 去掉 → "托管层关掉"必须红。
  3. sink 的 `if (!enabled) return;` 删掉 → "关掉时零输出"（会抛的 `mkdir`）必须红。

---

## Task 14：三份文档收口

**Files:** `README.md`、`docs/项目简介.md`、`site/index.html`

- [ ] **事件计数**：`39 声明 / 19 实现 / 20 未实现` → `41 声明 / 22 实现 / 19 未实现`，三处都改
  （`grep -rn "39 \|19 个实现\|20 个未实现" README.md docs/项目简介.md site/index.html`）。
- [ ] **classic 桥 3 → 6**：README 里"只桥接三个事件"的说法与那张表。
- [ ] **遥测一节**（README 与项目简介各一段）：默认关、只有用户层能开、托管层能关、
  用户级 `~/.deepcode/telemetry.jsonl`、零自由文本、六个事件各一行、不做网络上报。
- [ ] **hookify 一节**：四个事件、`event` 字段、逐事件词表、失败代价的差别（README 与 site 的
  "已知限制"卡片里那句"规则写坏了工具会全停"要**加限定**：只在 `PreToolUse` 上全停）。
- [ ] **测试计数**：跑一遍 `pnpm test` 拿真实数字，同步 README / 项目简介 / site 三处的
  "N 个文件 M 个用例"。
- [ ] **路线图**：`site/index.html` 的 P4 卡片与 `docs/项目简介.md` 的 P4 行改成
  "P4 五片全部落地；P4d 的多 surface 一节**有意未做**（零消费者，见设计 §9）"。
- [ ] `git commit -m "docs(p4d): 事件计数与遥测、hookify 四个事件写进三份文档"`

---

## Task 15：反向验证汇总、全量三绿、推送与 PR

- [ ] **Step 1: 全量** — `pnpm typecheck && pnpm lint && pnpm test`，记下三个真实数字。
- [ ] **Step 2: 反向验证**（spec §7 的 C3 清单，**每条先 grep 确认变异落上了**，
       每条红完立刻 `git checkout` 还原）——共 9 条：
  1. `withContext` 的空判删掉 → 标记测试红
  2. `tool.result` 派发提前到 `tool.check` 之前 → "被拒的工具不派"红
  3. `MAX_STOP_BLOCKS` 的 `continue` 改 `break` → "多转一轮"红
  4. `PostToolUse` 的 `tool_response` 换成 `e.input` → hookify 的 PostToolUse 用例红
  5. `runGroup` 的 `exit 2` 降级分支删掉 → 该用例红
  6. `plugin.json` 的 `uses` 去掉 `"turn.stop"` → 装载期撤插件红
  7. `validateEntry` 的字符串分支放宽 → 自由文本用例红
  8. 托管层的 `!== false` 去掉 → "托管层关掉"红
  9. sink 的 `if (!enabled) return;` 删掉 → "零输出"红
- [ ] **Step 3: 把实际结果写进本文件**（"检查点实际结果"一节：三个数字、9 条变异各自的
       红/绿与对应的测试文件、计划外的动作、以及对 spec 的偏差）。
- [ ] **Step 4: 提交并推送** — `git push -u origin p4d-prompt-telemetry`。
- [ ] **Step 5: PR** —— 标题 `P4d：prompt.* 与文本通道 · 可观测`，正文按 P4a/P4b/P4c 的体例
       （做了什么 / 出口标准逐条对上哪个测试 / 有意不做什么 / 已知偏差），末尾带
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- [ ] **Step 6: CI** —— Node 20 / 22 都要绿；红了先看是不是本片引入的。

---

## 检查点实际结果

（Task 15 Step 3 填。）

### C1（Task 1–5）—— 2026-10-11

- `pnpm typecheck` 绿；`pnpm lint` 绿（依赖边界 + 工作流硬化两条都过）。
- `pnpm vitest run`（五个新文件 + `plugin-wiring`）：34 条全绿。
- `pnpm test`：**49 文件 / 764 用例全绿**，`it.skip|describe.skip|it.todo` 为空。
- 反向验证三条，每条都先 `grep` 确认变异落上：

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | `withContext` 的 `if (extra === '__NEVER__')`（把 `=== ''` 改掉） | 红 2 条（`prompt-channel` 1、`prompt-submit` 1） |
| 2 | `runOneTool` 开头插一次 `tool.result` 派发（等价于"挪到 tool.check 之前"） | 红 6 条（含全部四条"没跑的工具不派"） |
| 3 | `MAX_STOP_BLOCKS` 分支的 `continue` → `break` | 红 3 条（多转一轮、`stopHookActive`、三次上限） |

**计划外的两处动作**（记下来，因为它们不属于任何任务的"文件"清单）：

1. `test/e2e.test.ts` 与 `test/loop-options.test.ts` 的手搭 `coreImpls` 需要补
   `'turn.stop': () => ({})`（e2e 还要 `'tool.result'`）。理由：`createHarness` 走的是
   另一条 dispatcher，链尾兜底够不着它 —— 这一点 `test/dispatch.test.ts` 里那条
   "两条路"的用例早就写明了。漏掉的表现是 loop 走到收手时抛 `NotImplementedError`。
2. `test/plugin-wiring.test.ts` 新增一条**装配级**用例：`cliPlugins` 的清单交给真引擎后，
   `prompt.section` 交出来的文本里有临时目录那份 `AGENTS.md` 的正文。这条钉的是
   "拔掉 `cli/plugins.ts` 里那一行，指令就不再进系统提示" —— 否则 Task 5 的意义
   只能靠人肉端到端发现。

### C2（Task 6–9）—— 2026-10-11

- `pnpm typecheck` 绿；`pnpm lint` 绿。
- `pnpm vitest run test/hook-run.test.ts test/classic-hooks.test.ts test/plugin-manifest.test.ts test/hookify.test.ts test/plugin-e2e.test.ts` 全绿
  （`hook-run` 34 条、`classic-hooks` 29 条、`hookify` 58 条、`plugin-e2e` 13 条、`plugin-manifest` 59 条）。
- `pnpm test`：**49 文件 / 818 用例全绿**。
- `grep -rn "pretooluse" src/ test/ plugins/` 只剩 `test/classic.test.ts:22` 那条
  `isClassicEvent('pretooluse')` 的反例 —— 与改名无关，是故意的。
- 反向验证三条，每条都先 `grep` 确认变异落上：

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | `classic-hooks.ts` 的 `tool_response: {ok, output}` → `e.input` | 红 1 条（`classic-hooks` 那条"stdin 里 tool_response 是我们自己的形状"） |
| 2 | `runGroup` 里删掉 `else said.push(verdict.reason)`（exit 2 的降级） | 红 1 条（"exit 2 在 PostToolUse 上降级成上下文"） |
| 3 | `plugins/hookify/plugin.json` 的 `uses` 删掉 `"turn.stop"` | 红 3 条（`plugin-e2e` 三条 hookify 真链路用例） |

变异 3 顺带证实了机制真的是 W10 那条：`[warn] hookify 注册了 turn.stop，但清单里的
uses 只有 … —— 越界，整个插件不装（已撤掉 3 条注册）`。

**计划的两处偏差**（都记下来，因为与计划正文写的不是一回事）：

1. **Task 8 与 Task 9 合成了一次提交**（`f2a42f3`）。理由：`evaluate` 的签名一换成
   `(rules, event, subject, toolName)`，不跟着改的 `hooks/pretooluse.mjs` 就把工具名当事件传，
   所有规则都不命中 —— 也就是说 Task 8 单独提交时 hookify 的测试**全红**。
   计划里"Step 3 写测试"那六条里有两条（逐事件 `field` 取值处、事件必须对上）本来就
   只有改完脚本才跑得起来。一个测试全红的提交不是我们想要的中间态。
2. C2 变异 1 的效果与计划写的不一样：计划说"hookify 的 PostToolUse 用例必须红"，
   实际红的是 `test/classic-hooks.test.ts` 里那条 stdin 形状断言 —— hookify 的测试
   直接 spawn 脚本，不经过 `classic-hooks.ts`。断言本身是有效的，只是**敏感的位置**
   与计划预估的不同。

**计划之外的一处改动**：`rules.mjs` 里那条"这个事件上表达不出来"的理由文案**改成逐事件**
（`DECISIONS_BY_EVENT[event].why`）。计划给的是两句共用的话，但 `Stop` 上被拒的词是
`allow`/`ask`/`notify` 而不是 `deny`，"工具已经跑完了"那句话在那儿是**错的报错**。
`test/hookify.test.ts` 里两条用例专门钉这件事（Stop 的理由里不许出现"工具已经跑完"）。

### C3（Task 10–13）—— 2026-10-11

- `pnpm typecheck` 绿；`pnpm lint` 绿（依赖边界 + 工作流硬化）。
- `pnpm vitest run test/settings.test.ts test/telemetry-rows.test.ts test/telemetry-sink.test.ts test/telemetry.test.ts`：
  **4 文件 / 103 用例全绿**（settings 45、rows 29、sink 15、telemetry 14）。
- `pnpm test`：**52 文件 / 891 用例全绿**（C2 时是 49 / 818）。
- 反向验证三条，每条都先 `grep` 确认变异落上：

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | `telemetry-rows.ts` 的值分支 `typeof value === 'string' && IDENT.test(value)` → 只要 `typeof value === 'string'` | 红 4 条（带空格 / 带中文 / 空串 / 一个坏字段带坏整条） |
| 2 | `settings.ts` 的遥测表达式里把 `telemetryLayers.get('policy')?.enabled === false` 换成 `false` | 红 1 条（"托管层能一句话把它关掉"） |
| 3 | `telemetry-sink.ts` 删掉**`record` 里**那句 `if (!deps.enabled) return;` | 红 1 条（"关着的时候连'这条不合格'都不判"） |

**变异 3 与计划写的不一样，值得记下来**：计划只说"删掉 `if (!enabled) return;`"，
而 sink 里**有两处**这句话（`record` 一处、`flush` 一处）。先拆 `flush` 那处 ——
**一条都没红**：`record` 的早退让缓冲永远是空的，`flush` 于是早就停在
`buffer.length === 0` 那行，永远走不到那道闸。也就是说"关掉时零系统调用"这条性质
今天由**两道**防线各挡一次，其中 `flush` 那道在公开 API 上不可达（`enabled` 是构造期
常量，生产里不会中途翻），属于纵深防御而不是承重墙。**保留它**，但把它记在这里：
下一个人拆它时不会看到红，那不等于它没意义，也不等于可以顺手把 `record` 那道也拆了。

**计划之外的一处改动（Task 13 实现时才发现）**：`src/core/create.ts` 的 `engine.create`
折叠原先发生在**插件注册之前**，于是"插件可以往 `$` 上加名词"这句话（`contract/engine.ts:91-98`
的 `declare module` 注释、设计 §6.1）在运行时是**假的** —— 那条 hook 永远不会被 dispatch，
`$.telemetry` 是 `undefined`（Task 13 的第 1 条用例第一次跑就红了）。第三方的那条拒绝
理由（`core/third-party.ts`："早在插件注册之前就折叠完了"）一直是这个时间差。

改成折**两次**：注册前折一次（注册期间 `plugin.register` 的 hook 要拿到 `$` ——
dispatch 是**无条件**取 `deps.engine()` 的，没有 `$` 会让每一次注册都走进
"hook 失败已跳过"，闸门静默失灵），注册之后再折一次（插件的名词这时才叠得上去）。
两折用同一张 registry，座位与"靠外的赢"是同一条规则。第三方**依旧不许**扩 `$`，
但理由从"技术上不可能"改成判定（`$` 是给所有人的门面），消息文案随之更新。
`test/dispatch.test.ts` 新增三条用例把它钉住（名词进得来且内核名词一个不少、
两个插件供同名名词时靠外的赢、座位抬到 `prepend` 就压过 `builtin`）。

### Task 15：全量三绿与九条反向验证（汇总）—— 2026-10-11

- `pnpm typecheck` 绿；`pnpm lint` 绿；`pnpm test` **52 文件 / 891 用例全绿**
  （P4d 开始前是 44 / 738）。
- 历史遗留的过期计数也一并清了：官网首屏那格写着 `16/39`（比 README 的 44/738 还旧），
  连同 README / 项目简介 / `site` 三处的"只桥了 3 个 classic 事件"一起改成现值。
- 九条反向验证**没有在这里重跑**。理由不是省事，是它们的目标文件在那之后**一个字节都没动过**
  —— 逐条核对（`git log` 各文件的最后一次改动，均早于各自检查点）：

| # | 变异 | 目标文件最后改动 | 红了几条（记在） |
| --- | --- | --- | --- |
| 1 | `withContext` 的空判 | `contract/prompt-channel.ts` @ C1 | 2（C1） |
| 2 | `tool.result` 派发提前到 `tool.check` 之前 | `core/loop.ts` @ C1 | 6（C1） |
| 3 | `MAX_STOP_BLOCKS` 的 `continue` → `break` | `core/loop.ts` @ C1 | 3（C1） |
| 4 | `PostToolUse` 的 `tool_response` 换成 `e.input` | `cli/classic-hooks.ts` @ C2 | 1（C2） |
| 5 | `runGroup` 的 `exit 2` 降级分支 | `cli/classic-hooks.ts` @ C2 | 1（C2） |
| 6 | `plugin.json` 的 `uses` 去掉 `"turn.stop"` | `plugins/hookify/` @ C2 | 3（C2） |
| 7 | `validateEntry` 的字符串分支放宽 | `cli/telemetry-rows.ts` @ C3 | 4（C3） |
| 8 | 托管层那条 `!== false` 去掉 | `cli/settings.ts` @ C3 | 1（C3） |
| 9 | sink 的 `if (!enabled) return;`（`record` 那处） | `cli/telemetry-sink.ts` @ C3 | 1（C3） |

第 7–9 条是本次跑的新结果，逐条记在 C3 一节里（含第 9 条那个"两处同名、只有一处承重"的发现）。
第 1–6 条的结果在 C1 / C2 一节里，连同各自的变异手法与"计划预估的红点与实际红点不一致"
那两处偏差。**九条各自的断言都是有效的**：没有一条出现"变异落上了却全绿"。

