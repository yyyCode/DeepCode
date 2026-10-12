# DeepCode MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个能真正改代码的终端 CLI —— 用户输入一句自然语言，它能读文件、改文件、跑命令、报告结果。

**Architecture:** 引擎在每个调用点抛出一个事件，所有插件（含六个内建工具）把自己的 hook 注册成中间件，按 tier 权威序串成一条链；一个 hook 可以应答 / 改写 / 拒绝 / 委托下层。内建工具与未来的第三方插件走完全相同的接口。

**Tech Stack:** TypeScript · Node ≥ 20 · ESM · pnpm · tsx（开发运行）· vitest（测试）· Anthropic Messages API（直接 fetch，无 SDK 依赖）

**Spec:** `docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`

---

## 执行须知：本计划的验收口径是批量验证，不是逐任务 TDD

**这是刻意的偏离，来自用户的明确要求（快速开发优先）。** 如果你习惯了逐任务 TDD，请注意本计划**不那样做**：

| 级别 | 时机 | 做什么 |
|---|---|---|
| **任务级** | 每个任务完成时 | **只跑 `pnpm typecheck`**。通过即可提交，不写测试 |
| **检查点级** | Task 9 / 17 / 20 / 21 | 一次写完一批测试，一次跑完 |

任务级之所以只靠编译，是因为**类型即契约**：往 `contract/` 加 import、hook 签名写错、事件名拼错、`Args`/`Result` 对不上——全部编译不过。`pnpm typecheck` 是这一层唯一也是最便宜的网。

**唯一例外**：Task 9（链语义测试）必须在 M2 之前写完。链语义（`next` 的续体行为、tier 顺序、故障隔离）是**运行时行为，编译器看不见**，晚写就没东西可测了。

**不要做的事**：不要给每个工具建独立测试文件、不要给每个事件写用例、不要引入覆盖率门槛、不要建 CI。

---

## 文件结构总览

```
DeepCode/
├── package.json                         Task 1
├── tsconfig.json                        Task 1
├── vitest.config.ts                     Task 1
├── .gitignore                           Task 1
├── scripts/check-boundaries.mjs         Task 1
├── README.md                            Task 21
├── src/
│   ├── contract/
│   │   ├── tier.ts                      Task 2   Tier / TIERS / isOuterThan
│   │   ├── next.ts                      Task 2   Next / HOOK_BUDGET / Origin / TraceEntry
│   │   ├── model-provider.ts            Task 3   Message / ContentBlock / ToolSpec / StreamEvent / ModelProvider
│   │   ├── plugin.ts                    Task 4   Plugin / On / EventHook
│   │   ├── engine.ts                    Task 4   EngineInterface + 10 个名词类型
│   │   ├── events.ts                    Task 5   39 个事件的 Args/Result 冻结
│   │   └── index.ts                     Task 5   barrel
│   ├── core/
│   │   ├── errors.ts                    Task 6   NotImplementedError / BudgetExceeded
│   │   ├── registry.ts                  Task 6   Registration / matchesPattern / Registry
│   │   ├── dispatch.ts                  Task 7   链组装、next 实现、故障隔离
│   │   ├── nouns/                       Task 8   fs / process / store / clock / ui / logger / session
│   │   ├── create.ts                    Task 8   engine.create 折叠 + plugin.register 准入
│   │   └── loop.ts                      Task 16  agent loop
│   ├── providers/
│   │   └── anthropic.ts                 Task 10 SSE 流式解析
│   ├── builtins/
│   │   ├── tools/read.ts                Task 11
│   │   ├── tools/write.ts               Task 11
│   │   ├── tools/edit.ts                Task 12
│   │   ├── tools/bash.ts                Task 13
│   │   ├── tools/glob.ts                Task 14
│   │   ├── tools/grep.ts                Task 14
│   │   ├── tools/index.ts               Task 14
│   │   ├── confirm.ts                   Task 15
│   │   └── commands.ts                  Task 15
│   └── cli/
│       ├── prompt.ts                    Task 18
│       ├── render.ts                    Task 18
│       ├── repl.ts                      Task 19
│       └── main.ts                      Task 19
└── test/
    ├── harness.ts                       Task 9
    ├── dispatch.test.ts                 Task 9   ← C1
    ├── tools.test.ts                    Task 17
    └── e2e.test.ts                      Task 17  ← C2
```

**依赖方向（Task 1 的脚本会强制它）**：`contract` 不 import 任何东西；`core` 只 import `contract`；`providers` 只 import `contract`；`builtins` 只 import `contract`；`cli` 可以 import 全部。

---

## M0 · 工程脚手架

### Task 1: 初始化工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `scripts/check-boundaries.mjs`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "deepcode",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "deepcode": "./bin/deepcode.mjs" },
  "scripts": {
    "dev": "tsx src/cli/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "node scripts/check-boundaries.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

用 `moduleResolution: "Bundler"` 而不是 `"NodeNext"`：这样相对导入可以省略 `.js` 后缀，tsx 与 vitest 都直接支持，省掉一整套扩展名摩擦。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
dist/
*.log
.env
.deepcode/
```

- [ ] **Step 5: 写 `scripts/check-boundaries.mjs`**

这是"契约唯一声明"的物理保障。它做的事情只有一个：检查谁不许 import 谁。

```js
#!/usr/bin/env node
// 依赖边界检查。规则见设计文档 §2.1。
// 不用 ESLint：flat config 下 import/no-restricted-paths 支持不稳定，而这里要的只是"某目录不许 import"。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = 'src';

// 每个目录允许 import 的 src 顶层目录白名单（'*' 表示不限）
const RULES = {
  contract: [],
  core: ['contract'],
  providers: ['contract'],
  builtins: ['contract'],
  cli: ['contract', 'core', 'providers', 'builtins'],
};

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function topAreaOf(file) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  return rel.split('/')[0];
}

const problems = [];

// src/ 在 Task 1 结束时还不存在（git 不跟踪空目录，所以新克隆里没有它）。
// 不守这一下，脚本会以 ENOENT 崩掉，而不是"检查通过"。
if (!existsSync(SRC)) {
  console.log('依赖边界检查通过（src/ 尚未创建）');
  process.exit(0);
}

for (const file of walk(SRC)) {
  const area = topAreaOf(file);
  const allowed = RULES[area];
  if (!allowed) continue;

  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 只查相对导入
    const target = join(file, '..', spec);
    const rel = relative(SRC, target).replace(/\\/g, '/');
    if (rel.startsWith('..')) continue; // 指向 src 之外，不管
    const targetArea = rel.split('/')[0];
    if (targetArea === area) continue; // 同目录内部不算越界
    if (!allowed.includes(targetArea)) {
      problems.push(`${relative(ROOT, file)}: 不允许 import ${targetArea}/（只允许 ${allowed.join(', ') || '无'}）`);
    }
  }
}

if (problems.length > 0) {
  console.error('依赖边界违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('依赖边界检查通过');
```

- [ ] **Step 6: 安装依赖并验证**

```bash
pnpm install
pnpm lint
```

Expected: `pnpm lint` 打印 `依赖边界检查通过（src/ 尚未创建）`。

**这一步刻意不跑 `pnpm typecheck`。** 此时 `src/` 与 `test/` 都还不存在，`tsc` 会以 `TS18003: No inputs were found` 报错 —— 那是"还没有任何 TS 文件"，不是代码有问题。本计划的"任务级 = `pnpm typecheck` 通过"从 **Task 2** 开始生效（`src/contract/tier.ts` 是第一个 `.ts` 输入）。

（边界脚本里那一下 `existsSync(SRC)` 守卫就是为了这个窗口：新克隆的仓库没有 `src/`，没有守卫会 ENOENT 崩溃。）

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore scripts/
git commit -m "chore: 初始化工程脚手架与依赖边界检查"
```

`pnpm-lock.yaml` 必须一起提交：没有它，`pnpm install` 在不同时间会解析出不同版本，vitest 与 tsx 的小版本漂移足以让后面的检查点表现不一致。

---

## M1 · 契约与内核

### Task 2: `contract/tier.ts` + `contract/next.ts`

**Files:**
- Create: `src/contract/tier.ts`
- Create: `src/contract/next.ts`

- [ ] **Step 1: 写 `src/contract/tier.ts`**

```ts
/**
 * tier 权威序：越靠外权威越高。
 *
 * prepend > user > append > builtin > core
 *
 * MVP 实际只有 builtin（内建插件）与 core（内核）两层落座，其余三层留空给 P2。
 * 但五个常量与比较函数必须一次到位 —— 否则 P2 的 sec-default 守门器会推倒重来。
 */
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const;

export type Tier = (typeof TIERS)[number];

/** next.to() 的合法目标：不能向上跳，因此排除 prepend 与 user。 */
export type TargetTier = Exclude<Tier, 'prepend' | 'user'>;

const OUTERMOST_FIRST: Record<Tier, number> = {
  prepend: 0,
  user: 1,
  append: 2,
  builtin: 3,
  core: 4,
};

/** a 是否比 b 更靠外（权威更高）。 */
export function isOuterThan(a: Tier, b: Tier): boolean {
  return OUTERMOST_FIRST[a] < OUTERMOST_FIRST[b];
}

/** 用于排序：数字越小越靠外。 */
export function tierIndex(t: Tier): number {
  return OUTERMOST_FIRST[t];
}
```

- [ ] **Step 2: 写 `src/contract/next.ts`**

```ts
import type { TargetTier, Tier } from './tier';

/** 抛出这次 dispatch 的插件。由宿主设定，插件写不了。 */
export type Origin = {
  readonly plugin: string;
  readonly tier: Tier;
};

export const CORE_ORIGIN: Origin = { plugin: 'core', tier: 'core' };

export type TraceEntry = {
  readonly plugin: string;
  readonly tier: Tier;
  readonly outcome: 'answered' | 'passed' | 'failed';
  readonly detail?: string;
};

export type HookFailure = { readonly kind: 'throw' | 'timeout'; readonly message?: string };

export type NextBudget = { readonly ms: number; readonly remainingMs: number };

/** 单个 hook 的时间预算。 */
export const HOOK_BUDGET = { ms: 10_000, catchMs: 1_000 } as const;

/**
 * Koa 式续体，不是事件发射器。
 *
 * - `next(e)`           运行下层 hook，带改写下行（每次调用都会重新运行下层）
 * - `next.to(e, tier)`  跳到指定 tier，跳过中间层
 * - 不调用 next 直接 return = 结束这条链并应答
 * - 什么都不返回 = 失败（被当作 hook 出错，跳过并上报）
 */
export type Next<E, R> = {
  (e: E): Promise<R>;
  readonly to: (e: E, tier: TargetTier) => Promise<R>;
  readonly signal: AbortSignal;
  readonly event: string;
  readonly origin: Origin;
  readonly trace: readonly TraceEntry[];
  readonly budget: NextBudget;
  /** 本事件的名字是否匹配某个 pattern（支持 `*` 与 `noun.*`）。 */
  readonly is: (pattern: string) => boolean;
};
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/contract/tier.ts src/contract/next.ts
git commit -m "feat(contract): tier 权威序与 Koa 式 next 续体"
```

---

### Task 3: `contract/model-provider.ts`

**Files:**
- Create: `src/contract/model-provider.ts`

接口放在 `contract/` 而不是 `providers/`：否则 `core/` 就不得不 import `providers/`，依赖方向立刻破掉。

- [ ] **Step 1: 写 `src/contract/model-provider.ts`**

```ts
/** 发给模型的一条消息。工具结果在 Anthropic 协议里也是 user 消息，这里保持中立表示。 */
export type Message =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: readonly ContentBlock[] }
  | {
      readonly role: 'tool';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

/** provider 的流式输出。文本增量即时产出；工具调用在参数收齐后一次性产出。 */
export type StreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'done'; readonly stopReason: string };

export type StreamRequest = {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal: AbortSignal;
};

/**
 * MVP 只有 Anthropic 一个实现，但接口先立着：
 * 之后加 OpenAI 兼容适配器时，事件链与 agent loop 一行都不用改。
 */
export type ModelProvider = {
  readonly name: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
};
```

- [ ] **Step 2: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/contract/model-provider.ts
git commit -m "feat(contract): ModelProvider 抽象与消息/流事件类型"
```

---

### Task 4: `contract/plugin.ts` + `contract/engine.ts`

**Files:**
- Create: `src/contract/plugin.ts`
- Create: `src/contract/engine.ts`

- [ ] **Step 1: 写 `src/contract/plugin.ts`**

注意 `On` 的三个重载：第一个让 pattern 是字面量事件名时能推断出正确的 `e` 类型；第三个是兜底，给 `noun.*` 这类 glob pattern 用。

```ts
import type { EngineInterface } from './engine';
import type { Args, EventName, Result } from './events';
import type { Next } from './next';

/** hook 的运行时形状：`($, e, next) => Result`。 */
export type EventHook = ($: EngineInterface, e: any, next: Next<any, any>) => any;

export type EventHookFor<N extends EventName> = (
  $: EngineInterface,
  e: Args<N>,
  next: Next<Args<N>, Result<N>>,
) => Result<N> | Promise<Result<N>>;

export type On = {
  /** 精确事件名：`pattern: N` 让 N 从字面量推断出来，hook 的 `e` 才有精确类型。 */
  <N extends EventName>(pattern: N, hook: EventHookFor<N>): void;
  /**
   * 精确事件名 + matcher。
   *
   * `pattern` 必须写 `N` 而不是 `string`：写成 `string` 时 N 在参数表里没有推断位置，
   * 会退化成整个 `EventName` 联合，`e` 随之变成 12 个事件的并集 —— 于是 `e.input`
   * 在并集上并不存在，六个内建工具全部编译不过。
   */
  <N extends EventName>(pattern: N, matcher: Record<string, unknown>, hook: EventHookFor<N>): void;
  /** 通配 / 否定模式（`tool.*`、`!x`）走这条：模式静态定不了事件，hook 退回宽类型。 */
  (pattern: string, hook: EventHook): void;
};

/**
 * 内建工具与未来的第三方插件走完全相同的接口。
 *
 * `uses` 是声明的依赖面（事件名与名词名），MVP 只记录不校验 —— P3 的准入闸门才用它。
 */
export type Plugin = {
  readonly name: string;
  readonly uses: readonly string[];
  register(on: On): void;
};
```

- [ ] **Step 2: 写 `src/contract/engine.ts`**

```ts
import type { Message, ModelProvider, StreamEvent, ToolSpec } from './model-provider';

export type UiNoun = {
  log(line: string): void;
  notice(line: string): void;
  ask(question: string): Promise<string>;
};

export type FsNoun = {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<readonly string[]>;
  stat(path: string): Promise<{ readonly size: number; readonly isDirectory: boolean }>;
};

export type ProcessNoun = {
  run(
    command: string,
    opts: { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
};

export type StoreNoun = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
};

export type ClockNoun = { now(): number };

export type LoggerNoun = { debug(line: string): void; warn(line: string): void };

export type SessionNoun = { id(): string; cwd(): string; root(): string };

export type ToolNoun = { list(): readonly string[] };

export type CommandNoun = { list(): readonly string[] };

export type ModelNoun = { stream(req: Parameters<ModelProvider['stream']>[0]): AsyncIterable<StreamEvent> };

/**
 * 内核名词。
 *
 * 注意：MVP 的 $ 是这些名词的**直接实现，不是事件** —— 架构文档里
 * `$.<noun>.<method>()` 本身也是一次 dispatch（OpEventOf，59 个），MVP 把这层省掉了。
 * 代价是 P2 之前无法在最内层拦截 process.run（沙箱的落点）。见设计文档 §10 偏差 5。
 */
export interface CoreEngineInterface {
  readonly session: SessionNoun;
  readonly tool: ToolNoun;
  readonly command: CommandNoun;
  readonly model: ModelNoun;
  readonly fs: FsNoun;
  readonly process: ProcessNoun;
  readonly store: StoreNoun;
  readonly clock: ClockNoun;
  readonly ui: UiNoun;
  readonly logger: LoggerNoun;
}

/**
 * 插件可以通过声明合并往 $ 上加名词（jQuery 往 $.fn 上加东西的做法）：
 *
 *   declare module '../contract/engine' {
 *     interface EngineInterface { telemetry: Telemetry }
 *   }
 */
export interface EngineInterface extends CoreEngineInterface {}

export type { Message, ToolSpec, StreamEvent, ModelProvider };
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: **失败** —— `./events` 还不存在。这是预期的：Task 5 才写它。此时先跳过，Task 5 后一起验。

- [ ] **Step 4: Commit**

```bash
git add src/contract/plugin.ts src/contract/engine.ts
git commit -m "feat(contract): Plugin/On 注册面与 EngineInterface 名词表"
```

---

### Task 5: `contract/events.ts` —— 39 个事件的冻结

**Files:**
- Create: `src/contract/events.ts`
- Create: `src/contract/index.ts`

这是整个 MVP 里最重要的一份文件：**先定事件目录，再定 API**。运行时要实现的只有 12 个，但全部 39 个事件（12 实现 + 27 只声明）的名字与 `Args`/`Result` 在这里一次冻结。

- [ ] **Step 1: 写 `src/contract/events.ts`**

```ts
import type { EngineInterface } from './engine';
import type { Next } from './next';
import type { Tier } from './tier';

// ─────────────────────────────────────────────────────────────
// 第一族：MVP 实际实现链的 12 个事件
// ─────────────────────────────────────────────────────────────

export type EventArgs = {
  'engine.create': { readonly plugins: readonly string[] };
  'plugin.register': {
    readonly name: string;
    readonly tier: Tier;
    readonly uses: readonly string[];
  };
  'session.start': { readonly sessionId: string; readonly cwd: string; readonly root: string };
  'session.end': { readonly reason: 'exit' | 'interrupt' | 'error' };
  'prompt.submit': { readonly text: string };
  'turn.start': { readonly index: number };
  'turn.step': { readonly delta: string };
  'turn.complete': {
    readonly stopReason: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  'tool.call': { readonly tool: string; readonly input: unknown; readonly toolUseId: string };
  'tool.check': { readonly tool: string; readonly input: unknown };
  'tool.describe': { readonly tool: string };
  'command.run': { readonly name: string; readonly args: readonly string[] };
};

export type EventResult = {
  'engine.create': Partial<EngineInterface>;
  'plugin.register': { readonly allow: true } | { readonly refuse: string };
  'session.start': Record<string, never>;
  'session.end': Record<string, never>;
  'prompt.submit': { readonly handled?: boolean };
  'turn.start': Record<string, never>;
  'turn.step': Record<string, never>;
  'turn.complete': Record<string, never>;
  'tool.call': { readonly value: unknown } | { readonly deny: string };
  'tool.check': { readonly decision: 'allow' | 'ask' | 'deny'; readonly rule?: string };
  'tool.describe': { readonly description: string; readonly inputSchema: unknown };
  'command.run': { readonly handled?: boolean };
};

// ─────────────────────────────────────────────────────────────
// 第二族：只声明、未实现的事件（27 个）
//
// core 落到它们时抛 NotImplementedError。现在就冻结，是因为事件目录
// 是这套架构里最容易返工的部分 —— 见设计文档 §3.3。
// ─────────────────────────────────────────────────────────────

export type UnimplementedEvent =
  | 'ui.render'
  | 'ui.press'
  | 'ui.input'
  | 'ui.select'
  | 'ui.message'
  | 'ui.scroll'
  | 'ui.focus'
  | 'ui.resolve'
  | 'agent.offer'
  | 'agent.spawn'
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
  | 'skill.prompt'
  | 'attribution.text'
  | 'session.receive'
  | 'session.compact'
  | 'session.attach'
  | 'session.detach'
  | 'session.measure';

export type AllEventArgs = EventArgs & {
  readonly [K in UnimplementedEvent]: Record<string, unknown>;
};
export type AllEventResult = EventResult & { readonly [K in UnimplementedEvent]: unknown };

export type EventName = keyof AllEventArgs;
export type Args<N extends EventName> = AllEventArgs[N];
export type Result<N extends EventName> = AllEventResult[N];

// ─────────────────────────────────────────────────────────────
// 事件与其参数的形状
// ─────────────────────────────────────────────────────────────

/**
 * 事件参数是深只读的：`e.command = 'ls'` 编译不过。
 * 改写必须拷贝后经 next 传下去：`next({ ...e, tool: 'Grep' })`。
 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** MVP 里只有 turn.step 是流式事件（其 hook 是 async generator）。 */
export const STREAMING_EVENTS = ['turn.step'] as const;
export type StreamingEventName = (typeof STREAMING_EVENTS)[number];

export type HookFor<N extends EventName> = (
  $: EngineInterface,
  e: DeepReadonly<Args<N>>,
  next: Next<Args<N>, Result<N>>,
) => Result<N> | Promise<Result<N>>;
```

- [ ] **Step 2: 写 `src/contract/index.ts`**

```ts
export * from './tier';
export * from './next';
export * from './model-provider';
export * from './plugin';
export * from './engine';
export * from './events';
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。如果 `plugin.ts` 的 `On` 报"循环引用"，把 `plugin.ts` 里 `events.ts` 的 import 改成 `import type`——`verbatimModuleSyntax` 下必须显式 `import type` 才不会生成运行时代码。

- [ ] **Step 4: 验证边界检查**

Run: `pnpm lint`
Expected: `依赖边界检查通过`（`contract/` 不 import 任何同级目录）。

- [ ] **Step 5: Commit**

```bash
git add src/contract/
git commit -m "feat(contract): 冻结 39 个事件的事件目录"
```

---

### Task 6: `core/errors.ts` + `core/registry.ts`

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/registry.ts`

- [ ] **Step 1: 写 `src/core/errors.ts`**

```ts
/** core 落到一个只声明未实现的事件时抛出。被 dispatch 捕获后降级，同一事件名只警告一次。 */
export class NotImplementedError extends Error {
  constructor(event: string) {
    super(`event not implemented in MVP: ${event}`);
    this.name = 'NotImplementedError';
  }
}

/** 某个 hook 超过 HOOK_BUDGET.ms 时抛出，用来把它从链上摘掉。 */
export class BudgetExceeded extends Error {
  constructor(ms: number) {
    super(`hook exceeded budget of ${ms}ms`);
    this.name = 'BudgetExceeded';
  }
}

/** pending 的 hook 超时后不等于停止运行 —— 只要没人 await 它的结果，它的副作用仍会继续。MVP 接受这一点。 */
export function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
```

- [ ] **Step 2: 写 `src/core/registry.ts`**

```ts
import { tierIndex, type Tier } from '../contract/tier';
import type { EventHook } from '../contract/plugin';

export type Registration = {
  readonly plugin: string;
  readonly tier: Tier;
  readonly pattern: string;
  readonly matcher?: Record<string, unknown>;
  readonly hook: EventHook;
  /** 同一插件内多次注册按注册顺序嵌套，先注册者在最外层。 */
  readonly seq: number;
};

/**
 * pattern 匹配：精确名 / `*` / `noun.*` / 取反 `!pattern`。
 * 取反是给 glob hook 用的：`on('!tool.*', ...)` 表示"除工具调用外的所有事件"。
 */
export function matchesPattern(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return !matchesPattern(pattern.slice(1), event);
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

/** matcher 是浅比较：`{ tool: 'Read' }` 只对 `e.tool === 'Read'` 的调用生效。 */
export function matchesMatcher(
  matcher: Record<string, unknown> | undefined,
  e: Record<string, unknown>,
): boolean {
  if (!matcher) return true;
  return Object.entries(matcher).every(([key, value]) => e[key] === value);
}

export class Registry {
  private readonly regs: Registration[] = [];
  private seq = 0;

  register(input: {
    plugin: string;
    tier: Tier;
    pattern: string;
    matcher?: Record<string, unknown>;
    hook: EventHook;
  }): Registration {
    const reg: Registration = { ...input, seq: this.seq++ };
    this.regs.push(reg);
    return reg;
  }

  all(): readonly Registration[] {
    return this.regs;
  }

  /** 取某事件的 hook，按 tier 由外到内、同 tier 按注册先后排序。 */
  hooksFor(event: string, e: Record<string, unknown>): readonly Registration[] {
    return this.regs
      .filter((r) => matchesPattern(r.pattern, event) && matchesMatcher(r.matcher, e))
      .sort((a, b) => tierIndex(a.tier) - tierIndex(b.tier) || a.seq - b.seq);
  }

  /**
   * 从注册面反推某类 matcher 的取值集合。
   * `$.tool.list()` 与 `$.command.list()` 靠它实现 —— 工具是自己注册进来的，
   * 不是内核里的一张硬编码表。
   */
  matcherValues(pattern: string, key: string): readonly string[] {
    const seen = new Set<string>();
    for (const r of this.regs) {
      if (r.pattern !== pattern) continue;
      const value = r.matcher?.[key];
      if (typeof value === 'string') seen.add(value);
    }
    return [...seen];
  }
}
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/core/errors.ts src/core/registry.ts
git commit -m "feat(core): 错误类型与 hook 注册表"
```

---

### Task 7: `core/dispatch.ts` —— 链的组装与执行

**Files:**
- Create: `src/core/dispatch.ts`

这是整个引擎的心脏。`next` 的每一处行为都在这里。

- [ ] **Step 1: 写 `src/core/dispatch.ts`**

```ts
import type { Args, EventName, Result } from '../contract/events';
import type { EngineInterface } from '../contract/engine';
import { HOOK_BUDGET, type Origin, type TraceEntry } from '../contract/next';
import { tierIndex, type TargetTier } from '../contract/tier';
import { NotImplementedError, withBudget } from './errors';
import { matchesPattern, type Registry } from './registry';

/** 事件的内核实现 —— 链的最内层。没有实现的事件在这里抛 NotImplementedError。 */
export type CoreImpls = Partial<Record<EventName, (e: any) => any>>;

export type DispatcherDeps = {
  registry: Registry;
  /** 延迟取 $：$ 要到 engine.create 折叠完成之后才存在。 */
  engine: () => EngineInterface;
  coreImpls: CoreImpls;
  logger: { warn(line: string): void };
  signal: AbortSignal;
};

export type DispatchFn = <N extends EventName>(
  event: N,
  args: Args<N>,
  origin: Origin,
  /** 重入保护：hook 通过 $ 发起调用时，跳过发起它的那个插件自己。 */
  skipPlugin?: string,
) => Promise<Result<N>>;

/** 事件参数深冻结：hook 不能偷偷改事实，改写必须拷贝。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export function createDispatcher(deps: DispatcherDeps): { dispatch: DispatchFn } {
  /** 同一个 (事件, 插件) 只警告一次，避免故障插件刷屏。 */
  const warned = new Set<string>();

  const dispatch: DispatchFn = async (event, args, origin, skipPlugin) => {
    const hooks = deps.registry
      .hooksFor(event, args as Record<string, unknown>)
      .filter((r) => r.plugin !== skipPlugin);

    const trace: TraceEntry[] = [];

    async function runAt(index: number, e: unknown, caller: Origin): Promise<any> {
      if (index >= hooks.length) {
        const impl = deps.coreImpls[event];
        if (!impl) throw new NotImplementedError(event);
        return impl(e);
      }

      const reg = hooks[index]!;
      const startedAt = Date.now();
      const self: Origin = { plugin: reg.plugin, tier: reg.tier };
      const next = makeNext(index, e, self, startedAt);

      try {
        const returned = await withBudget(
          Promise.resolve(reg.hook(deps.engine(), deepFreeze(e), next)),
          HOOK_BUDGET.ms,
        );
        if (returned === undefined) {
          throw new Error('hook returned undefined (什么都不返回 = 失败)');
        }
        trace.push({ plugin: reg.plugin, tier: reg.tier, outcome: 'answered' });
        return returned;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        trace.push({ plugin: reg.plugin, tier: reg.tier, outcome: 'failed', detail });

        // 故障隔离：跳过这个 hook，让下层照常运行。
        const key = `${event}#${reg.plugin}`;
        if (!warned.has(key)) {
          warned.add(key);
          deps.logger.warn(`hook ${reg.plugin} on ${event} 失败已跳过：${detail}`);
        }
        return runAt(index + 1, e, caller);
      }
    }

    function makeNext(index: number, e: unknown, self: Origin, startedAt: number) {
      const descend = (from: number, next_e: unknown) => runAt(from, next_e, self);

      const next = ((next_e: unknown) => descend(index + 1, next_e)) as any;

      /** 只向下跳：跳过那些比目标 tier 更靠外的层。 */
      next.to = (next_e: unknown, target: TargetTier) => {
        let i = index + 1;
        while (i < hooks.length && tierIndex(hooks[i]!.tier) < tierIndex(target)) i++;
        return descend(i, next_e);
      };

      next.signal = deps.signal;
      next.event = event;
      next.origin = self;
      next.trace = trace;
      next.budget = {
        ms: HOOK_BUDGET.ms,
        remainingMs: Math.max(0, HOOK_BUDGET.ms - (Date.now() - startedAt)),
      };
      next.is = (pattern: string) => matchesPattern(pattern, event);
      return next;
    }

    return runAt(0, args, origin);
  };

  return { dispatch };
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/core/dispatch.ts
git commit -m "feat(core): 中间件链调度、next 续体与故障隔离"
```

---

### Task 8: `core/nouns/*` + `core/create.ts`

**Files:**
- Create: `src/core/nouns/fs.ts`
- Create: `src/core/nouns/process.ts`
- Create: `src/core/nouns/store.ts`
- Create: `src/core/nouns/clock.ts`
- Create: `src/core/nouns/logger.ts`
- Create: `src/core/nouns/ui.ts`
- Create: `src/core/nouns/index.ts`
- Create: `src/core/create.ts`

- [ ] **Step 1: 写 `src/core/nouns/fs.ts`**

```ts
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import type { FsNoun } from '../../contract/engine';

export function createFsNoun(): FsNoun {
  return {
    read: (path) => readFile(path, 'utf8'),
    write: (path, content) => writeFile(path, content, 'utf8').then(() => undefined),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    list: (dir) => readdir(dir),
    stat: async (path) => {
      const s = await stat(path);
      return { size: s.size, isDirectory: s.isDirectory() };
    },
  };
}
```

- [ ] **Step 2: 写 `src/core/nouns/process.ts`**

```ts
import { spawn } from 'node:child_process';
import type { ProcessNoun } from '../../contract/engine';

export function createProcessNoun(): ProcessNoun {
  return {
    run(command, { cwd, timeoutMs, signal }) {
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

- [ ] **Step 3: 写 `src/core/nouns/store.ts`、`clock.ts`、`logger.ts`**

`src/core/nouns/store.ts`：

```ts
import type { StoreNoun } from '../../contract/engine';

/** MVP 用内存 Map。落盘与 --resume 是 P1 的事。 */
export function createStoreNoun(): StoreNoun {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}
```

`src/core/nouns/clock.ts`：

```ts
import type { ClockNoun } from '../../contract/engine';

export function createClockNoun(): ClockNoun {
  return { now: () => Date.now() };
}
```

`src/core/nouns/logger.ts`：

```ts
import type { LoggerNoun } from '../../contract/engine';

/** debug 只在 DEEPCODE_DEBUG 设了时才输出，且只走 stderr（不污染 stdout 的模型输出）。 */
export function createLoggerNoun(env: NodeJS.ProcessEnv): LoggerNoun {
  const debugOn = Boolean(env.DEEPCODE_DEBUG);
  return {
    debug: (line) => {
      if (debugOn) process.stderr.write(`[debug] ${line}\n`);
    },
    warn: (line) => process.stderr.write(`[warn] ${line}\n`),
  };
}
```

- [ ] **Step 4: 写 `src/core/nouns/ui.ts`**

UI 名词把输出交给 cli 提供的 sink。非 TTY 时 sink 的 `ask` 必须返回 `'n'` —— 这是 fail-closed 在交互层的体现。

```ts
import type { UiNoun } from '../../contract/engine';

export type UiSink = {
  print(line: string): void;
  notice(line: string): void;
  ask(question: string): Promise<string>;
};

export function createUiNoun(sink: UiSink): UiNoun {
  return {
    log: (line) => sink.print(line),
    notice: (line) => sink.notice(line),
    ask: (question) => sink.ask(question),
  };
}
```

- [ ] **Step 5: 写 `src/core/nouns/index.ts`**

```ts
import type { CoreEngineInterface, ModelProvider } from '../../contract/engine';
import type { Registry } from '../registry';
import { createClockNoun } from './clock';
import { createFsNoun } from './fs';
import { createLoggerNoun } from './logger';
import { createProcessNoun } from './process';
import { createStoreNoun } from './store';
import { createUiNoun, type UiSink } from './ui';

export type CoreNounsDeps = {
  provider: ModelProvider;
  ui: UiSink;
  sessionInfo: { id: string; cwd: string; root: string };
  env: NodeJS.ProcessEnv;
};

/**
 * registry 是第二个参数而不是 deps 的字段：它由 createEngine 自建，
 * 调用方（cli/main.ts）不该也不可能有它。
 */
export function createCoreNouns(deps: CoreNounsDeps, registry: Registry): CoreEngineInterface {
  return {
    session: {
      id: () => deps.sessionInfo.id,
      cwd: () => deps.sessionInfo.cwd,
      root: () => deps.sessionInfo.root,
    },
    // 工具清单不是硬编码表：它来自注册面上 `tool.call` 的 matcher 取值。
    tool: { list: () => registry.matcherValues('tool.call', 'tool') },
    command: { list: () => registry.matcherValues('command.run', 'name') },
    model: { stream: (req) => deps.provider.stream(req) },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    clock: createClockNoun(),
    ui: createUiNoun(deps.ui),
    logger: createLoggerNoun(deps.env),
  };
}
```

- [ ] **Step 6: 写 `src/core/create.ts`**

`engine.create` 是一次折叠：内核名词在最内层，插件用 `await next(e)` 拿到下层已建好的 `$`，再 spread 上自己的名词。

`plugin.register` 是准入闸门：MVP 的 core 实现永远返回 `{ allow: true }`，但它已经是一个真实的判定点 —— P3 的 `sec-default` 就是在这里拒绝。

```ts
import type { EngineInterface } from '../contract/engine';
import type { Plugin, On } from '../contract/plugin';
import { CORE_ORIGIN } from '../contract/next';
import { Registry } from './registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from './dispatch';
import { createCoreNouns, type CoreNounsDeps } from './nouns';

export type CreateEngineDeps = CoreNounsDeps & {
  plugins: readonly Plugin[];
  signal: AbortSignal;
};

export type BuiltEngine = {
  $: EngineInterface;
  registry: Registry;
  dispatch: DispatchFn;
};

export async function createEngine(deps: CreateEngineDeps): Promise<BuiltEngine> {
  const registry = new Registry();
  let engine: EngineInterface | undefined;

  const coreNouns = createCoreNouns(deps, registry);

  const coreImpls: CoreImpls = {
    // 折叠的最内层：内核名词。插件的 engine.create hook 会在这个结果之上叠加。
    'engine.create': () => coreNouns,

    // 准入闸门。MVP 全部放行 —— 但路径已经存在，P3 只需要换掉这个函数的实现。
    'plugin.register': () => ({ allow: true }) as const,

    // 没有工具应答 = 不知道这个工具，拒绝。
    'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),

    // fail-closed：走到链尾无人应答就是拒绝，不是放行。
    // 这是 MVP 里唯一一条 fail-closed，也是 P2 全部安全性质的种子。
    'tool.check': () => ({ decision: 'deny', rule: 'fail-closed: 没有 hook 应答 tool.check' }) as const,

    'command.run': (e) => ({ handled: false, name: String(e.name) }),

    // prompt.submit 在 MVP 里是个真实存在但什么都不做的钩子点：
    // core 说"我没处理"，于是 REPL 照常把这一行送进 loop。
    // P1 的斜杠命令展开 / prompt.fill / 附件都会挂到这里，届时改的是插件不是内核。
    'prompt.submit': () => ({ handled: false }) as const,

    // 生命周期通知事件：内核"无话可说"才是正常状态 —— 它们存在是为了让插件
    // 能观察（P1 的状态栏、遥测、自动保存都会挂上来）。
    //
    // 这几条 no-op 不是可有可无的装饰。dispatch 在没有 hook、也没有内核实现时
    // 会抛 NotImplementedError，而 loop 的第一行就是 turn.start、CLI 的第一行
    // 就是 session.start：少了它们，产品和启动即崩之间只隔一次 dispatch。
    // 它们同时也是 NotImplementedError 只用来指那 27 个真未实现事件的保证。
    'session.start': () => ({}) as const,
    'session.end': () => ({}) as const,
    'turn.start': () => ({}) as const,
    'turn.step': () => ({}) as const,
    'turn.complete': () => ({}) as const,

    'tool.describe': (e) => {
      throw new Error(`no description registered for tool: ${String(e.tool)}`);
    },
  };

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

  // 折叠：core 在最内层，插件按列表顺序、最外层在前。
  const folded = (await dispatch(
    'engine.create',
    { plugins: deps.plugins.map((p) => p.name) },
    CORE_ORIGIN,
  )) as EngineInterface;
  engine = folded;

  // 准入 + 注册
  for (const plugin of deps.plugins) {
    const verdict = await dispatch(
      'plugin.register',
      { name: plugin.name, tier: 'builtin', uses: plugin.uses },
      CORE_ORIGIN,
    );
    if ('refuse' in verdict) {
      coreNouns.logger.warn(`插件 ${plugin.name} 被拒绝加载：${verdict.refuse}`);
      continue;
    }
    plugin.register(makeOn(registry, plugin.name, 'builtin'));
  }

  return { $: engine, registry, dispatch };
}

/** 给插件一个绑定了它自己身份与座位的 on。 */
function makeOn(registry: Registry, plugin: string, tier: 'builtin' | 'user'): On {
  const on = ((pattern: string, second: unknown, third?: unknown) => {
    const hook = (third ?? second) as any;
    const matcher = third ? (second as Record<string, unknown>) : undefined;
    registry.register({ plugin, tier, pattern, matcher, hook });
  }) as On;
  return on;
}
```

- [ ] **Step 7: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 8: Commit**

```bash
git add src/core/
git commit -m "feat(core): 内核名词、engine.create 折叠与插件准入"
```

---

## C1 检查点 · 链语义批量验证

### Task 9: 测试 harness + 链语义测试套件

**Files:**
- Create: `test/harness.ts`
- Create: `test/dispatch.test.ts`

**这是 M2 之前唯一必须先写的测试。** 链语义是运行时行为，编译器看不见；晚写就没东西可测了。

**一次写完，一次跑完。** 不要把下面的用例拆成多个文件。

- [ ] **Step 1: 写 `test/harness.ts`**

```ts
import { Registry } from '../src/core/registry';
import { createDispatcher, type CoreImpls, type DispatchFn } from '../src/core/dispatch';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';
import type { Tier } from '../src/contract/tier';
import type { StreamEvent } from '../src/contract/model-provider';
import type { ModelProvider } from '../src/contract/engine';

export type HarnessOptions = {
  coreImpls?: CoreImpls;
  engine?: Partial<EngineInterface>;
  signal?: AbortSignal;
};

const NOOP_ENGINE = {} as EngineInterface;

export function createHarness(options: HarnessOptions = {}) {
  const registry = new Registry();
  const warnings: string[] = [];

  const dispatcher = createDispatcher({
    registry,
    engine: () => (options.engine ?? NOOP_ENGINE) as EngineInterface,
    coreImpls: options.coreImpls ?? {},
    logger: { warn: (line) => warnings.push(line) },
    signal: options.signal ?? new AbortController().signal,
  });

  function on(tier: Tier, plugin: string, pattern: string, hook: EventHook): void;
  function on(
    tier: Tier,
    plugin: string,
    pattern: string,
    matcher: Record<string, unknown>,
    hook: EventHook,
  ): void;
  function on(
    tier: Tier,
    plugin: string,
    pattern: string,
    third: Record<string, unknown> | EventHook,
    fourth?: EventHook,
  ): void {
    const hook = (fourth ?? third) as EventHook;
    const matcher = fourth ? (third as Record<string, unknown>) : undefined;
    registry.register({ plugin, tier, pattern, matcher, hook });
  }

  return { on, dispatch: dispatcher.dispatch, registry, warnings };
}

/** 脚本化的模型响应：E2E 用它驱动 loop，不花 token、可确定性重放。 */
export function scriptedProvider(script: readonly (readonly StreamEvent[])[]): ModelProvider {
  let turn = 0;
  return {
    name: 'scripted',
    async *stream() {
      const events = script[turn++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };
}
```

- [ ] **Step 2: 写 `test/dispatch.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createHarness, scriptedProvider } from './harness';
import { createEngine } from '../src/core/create';
import { CORE_ORIGIN } from '../src/contract/next';
import { NotImplementedError } from '../src/core/errors';

const CALL = 'tool.call';
const args = { tool: 'Read', input: {}, toolUseId: 't1' };

describe('链语义', () => {
  it('按 tier 由外到内执行，内核在最内层', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const order: string[] = [];
    h.on('builtin', 'inner', CALL, async (_$, _e, next) => {
      order.push('builtin');
      return next(_e);
    });
    h.on('prepend', 'outer', CALL, async (_$, e, next) => {
      order.push('prepend');
      return next(e);
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(order).toEqual(['prepend', 'builtin']);
    expect(result).toEqual({ value: 'core' });
  });

  it('不调用 next 直接返回 = 结束链，内核不运行', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core-never-runs' }) },
    });
    h.on('builtin', 'short', CALL, async () => ({ value: 'short-circuit' }));

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'short-circuit' });
  });

  it('next({...e, field}) 改写下行，但不改自己的 e', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': (e: any) => ({ value: e.tool }) },
    });
    let seenByOuter: unknown;
    let seenByInner: unknown;

    h.on('builtin', 'inner', CALL, async (_$, e, next) => {
      seenByInner = e.tool;
      return next(e);
    });
    h.on('prepend', 'outer', CALL, async (_$, e, next) => {
      const rewritten = await next({ ...e, tool: 'Grep' });
      seenByOuter = e.tool;
      return rewritten;
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'Grep' });   // 改写下行生效
    expect(seenByOuter).toBe('Read');            // 自己的 e 没被改
    expect(seenByInner).toBe('Grep');            // 下层看到的是改写后的值
  });

  it('事件参数是深冻结的', async () => {
    const h = createHarness({ coreImpls: { 'tool.call': () => ({ value: 'ok' }) } });
    let frozen = false;
    h.on('builtin', 'probe', CALL, async (_$, e, next) => {
      frozen = Object.isFrozen(e);
      return next(e);
    });

    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(frozen).toBe(true);
  });

  it('hook 抛错被隔离：跳过它、下层照跑、按插件名上报一次', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'survived' }) },
    });
    h.on('prepend', 'boom', CALL, async () => {
      throw new Error('炸了');
    });
    h.on('builtin', 'ok', CALL, async (_$, e, next) => next(e));

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'survived' });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('boom');

    // 同一个 (事件, 插件) 只警告一次
    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(h.warnings).toHaveLength(1);
  });

  it('hook 什么都不返回 = 失败，被当作抛错处理', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'survived' }) },
    });
    h.on('builtin', 'silent', CALL, (async () => undefined) as any);

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'survived' });
    expect(h.warnings[0]).toContain('undefined');
  });

  it('next.to(tier) 只向下跳，跳过中间层，直达内核', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const visited: string[] = [];

    // 座位从外到内：user → append → builtin → core(内核实现)
    // user 层直接跳到内核，append 与 builtin 都不该被运行。
    h.on('user', 'usr', CALL, async (_$, _e, next) => {
      visited.push('usr');
      return next.to(_e, 'core');
    });
    h.on('append', 'app', CALL, async (_$, _e, next) => {
      visited.push('app');
      return next(_e);
    });
    h.on('builtin', 'bi', CALL, async (_$, _e, next) => {
      visited.push('bi');
      return next(_e);
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'core' }); // 确实落到了内核
    expect(visited).toEqual(['usr']);          // append 与 builtin 被跳过
  });

  it('next.signal / origin / budget / is 都挂上了', async () => {
    const controller = new AbortController();
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'x' }) },
      signal: controller.signal,
    });
    let snapshot: any;
    h.on('builtin', 'probe', CALL, async (_$, e, next) => {
      snapshot = {
        signal: next.signal === controller.signal,
        event: next.event,
        plugin: next.origin.plugin,
        tier: next.origin.tier,
        ms: next.budget.ms,
        isCall: next.is('tool.*'),
        isOther: next.is('ui.*'),
      };
      return next(e);
    });

    await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(snapshot).toEqual({
      signal: true,
      event: CALL,
      plugin: 'probe',
      tier: 'builtin',
      ms: 10_000,
      isCall: true,
      isOther: false,
    });
  });

  it('skipPlugin 跳过发起者自己，避免自递归', async () => {
    const h = createHarness({
      coreImpls: { 'tool.call': () => ({ value: 'core' }) },
    });
    const visits: string[] = [];
    h.on('builtin', 'self-dispatch', CALL, async (_$, e, next) => {
      visits.push('direct');
      // 模拟 hook 通过 $ 再发起一次同事件调用：应当跳过它自己
      const nested = await h.dispatch(CALL, e, CORE_ORIGIN, 'self-dispatch');
      visits.push('nested');
      return nested;
    });

    const result = await h.dispatch(CALL, args, CORE_ORIGIN);
    expect(result).toEqual({ value: 'core' });
    expect(visits).toEqual(['direct', 'nested']); // 嵌套那次没再进 self-dispatch
  });

  it('matcher 只对匹配的输入生效', async () => {
    const h = createHarness({ coreImpls: { 'tool.call': () => ({ deny: 'unknown tool' }) } });
    h.on('builtin', 'read-tool', CALL, { tool: 'Read' }, async () => ({ value: 'read-ran' }));

    expect(await h.dispatch(CALL, args, CORE_ORIGIN)).toEqual({ value: 'read-ran' });
    expect(await h.dispatch(CALL, { ...args, tool: 'Bash' }, CORE_ORIGIN)).toEqual({
      deny: 'unknown tool',
    });
  });

  it('落到未实现的事件抛 NotImplementedError', async () => {
    const h = createHarness();
    await expect(h.dispatch('agent.spawn', {}, CORE_ORIGIN)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

describe('fail-closed', () => {
  it('tool.check 无人应答时，链尾返回 deny 而不是 allow', async () => {
    // 故意走真实的 createEngine，不借 harness 塞桩。
    // fail-closed 是 src/core/create.ts 里那条内核实现的属性，用测试自己提供的桩去测
    // 等于自问自答：把内核那条改成 allow，桩版本照样绿。这条是 MVP 唯一一条 fail-closed，
    // 也是 P2 全部安全性质的种子，必须真的钉在内核实现上。
    const built = await createEngine({
      plugins: [],
      signal: new AbortController().signal,
      provider: scriptedProvider([]),
      ui: { print: () => {}, notice: () => {}, ask: async () => '' },
      sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
      env: {},
    });

    const result = await built.dispatch('tool.check', { tool: 'Bash', input: {} }, CORE_ORIGIN);
    expect(result.decision).toBe('deny');
  });
});
```

- [ ] **Step 3: 一次跑完全部链语义测试**

Run: `pnpm test`
Expected: 全部 PASS。

**如果失败，先修实现再往下走** —— 这些用例锁的是后续所有阶段的地基。

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: C1 检查点 —— 链语义批量验证"
```

> **C1 出口**：链语义测试全绿。契约冻结、内核可跑、fail-closed 方向正确。

---

## M2 · 工具、provider 与 agent loop

### Task 10: `providers/anthropic.ts`

**Files:**
- Create: `src/providers/anthropic.ts`

直接用 `fetch` + 手写 SSE 解析，不引 SDK：少一个依赖，且 `base_url` 天然可配（P2 的 gateway 收口要用到）。

- [ ] **Step 1: 写 `src/providers/anthropic.ts`**

```ts
import type {
  ContentBlock,
  Message,
  ModelProvider,
  StreamEvent,
  ToolSpec,
} from '../contract/model-provider';

export type AnthropicConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
};

export function createAnthropicProvider(config: AnthropicConfig): ModelProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    name: 'anthropic',
    async *stream({ system, messages, tools, signal }) {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 8192,
          system,
          messages: toAnthropicMessages(messages),
          tools: tools.map(toAnthropicTool),
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`anthropic ${response.status}: ${await response.text()}`);
      }
      if (!response.body) throw new Error('anthropic: 响应没有 body');

      const pending = new Map<number, { type: string; id: string; name: string; json: string }>();
      let stopReason = 'end_turn';

      for await (const frame of sseFrames(response.body)) {
        if (frame.event === 'content_block_start') {
          const data = JSON.parse(frame.data);
          const block = data.content_block ?? {};
          pending.set(data.index, {
            type: block.type,
            id: block.id ?? '',
            name: block.name ?? '',
            json: '',
          });
        } else if (frame.event === 'content_block_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.type === 'text_delta') {
            yield { type: 'text', text: data.delta.text } satisfies StreamEvent;
          } else if (data.delta?.type === 'input_json_delta') {
            const entry = pending.get(data.index);
            if (entry) entry.json += data.delta.partial_json ?? '';
          }
        } else if (frame.event === 'content_block_stop') {
          const data = JSON.parse(frame.data);
          const entry = pending.get(data.index);
          if (entry?.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: entry.id,
              name: entry.name,
              input: JSON.parse(entry.json || '{}'),
            } satisfies StreamEvent;
          }
        } else if (frame.event === 'message_delta') {
          const data = JSON.parse(frame.data);
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        } else if (frame.event === 'message_stop') {
          yield { type: 'done', stopReason } satisfies StreamEvent;
          return;
        }
      }

      // 服务端没发 message_stop 就断了：当作正常结束，不留悬挂的 await。
      yield { type: 'done', stopReason };
    },
  };
}

/** 中立的 Message 表示 → Anthropic 协议。工具结果在 Anthropic 里是 user 消息里的 tool_result block。 */
function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolUseId,
            content: message.content,
            is_error: message.isError,
          },
        ],
      };
    }
    return {
      role: 'assistant',
      content: message.content.map((block: ContentBlock) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
      ),
    };
  });
}

function toAnthropicTool(tool: ToolSpec): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

/** 逐帧读 SSE。Anthropic 的流是 `event: X\ndata: {...}\n\n`。 */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = '';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (event && dataLines.length > 0) {
        yield { event, data: dataLines.join('\n') };
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/providers/
git commit -m "feat(providers): Anthropic 流式适配器（fetch + SSE 手写解析）"
```

---

### Task 11: `builtins/tools/read.ts` + `write.ts`

**Files:**
- Create: `src/builtins/tools/read.ts`
- Create: `src/builtins/tools/write.ts`

工具的形态：一个 `Plugin`，在 `tool.call` 上按 `{ tool: 'X' }` 注册实现，在 `tool.describe` 上按同样 matcher 注册描述。**工具不认识内核，内核也不认识工具。**

- [ ] **Step 1: 写 `src/builtins/tools/read.ts`**

```ts
import type { Plugin } from '../../contract/plugin';

const MAX_LINES = 2000;

export const readTool: Plugin = {
  name: 'tool-read',
  uses: ['tool.call', 'tool.describe', 'fs', 'store'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Read' },
      () => ({
        description: '读取一个文本文件的内容，返回带行号的正文。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            limit: { type: 'number', description: `最多读取的行数，默认 ${MAX_LINES}` },
          },
          required: ['file_path'],
        },
      }),
    );

    on('tool.call', { tool: 'Read' }, async ($, e) => {
      const input = e.input as { file_path: string; limit?: number };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      try {
        const content = await $.fs.read(input.file_path);
        // 记下"这次会话读过它"。Write 覆盖已存在的文件前会查这个 key ——
        // 少了这一行，那个检查永远为假，任何先前就存在的文件都再也覆盖不了：
        // 你没法在不写的情况下打上标记，也没法在没标记的情况下写。
        await $.store.set(`read:${input.file_path}`, '1');
        const lines = content.split('\n');
        const limit = input.limit ?? MAX_LINES;
        const shown = lines.slice(0, limit);
        const numbered = shown.map((line, index) => `${index + 1}\t${line}`).join('\n');
        const truncated =
          lines.length > limit ? `\n... 共 ${lines.length} 行，已截断到 ${limit} 行` : '';
        return { value: numbered + truncated };
      } catch (error) {
        // 工具失败不抛：它是给模型的信息，不是崩溃。
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }
    });
  },
};
```

- [ ] **Step 2: 写 `src/builtins/tools/write.ts`**

```ts
import type { Plugin } from '../../contract/plugin';

export const writeTool: Plugin = {
  name: 'tool-write',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Write' },
      () => ({
        description: '把内容完整写入一个文件（覆盖已有内容）。新文件也可用。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            content: { type: 'string', description: '要写入的完整内容' },
          },
          required: ['file_path', 'content'],
        },
      }),
    );

    on('tool.call', { tool: 'Write' }, async ($, e, next) => {
      const input = e.input as { file_path: string; content: string };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      const alreadyExists = await $.fs.exists(input.file_path);

      // 覆盖已存在的文件要先看过它 —— 防的是"模型凭记忆重写一个它没读过的文件"。
      if (alreadyExists) {
        const seenKey = `read:${input.file_path}`;
        const seen = await $.store.get(seenKey);
        if (!seen) {
          return {
            value: `ERROR: ${input.file_path} 已存在，但你这次会话还没读过它。先 Read 再 Write。`,
          };
        }
      }

      // 交给下层：confirm 插件挂在 tool.check 上，写入的确认由 loop 统一发起。
      return next(e);
    });

    on('tool.call', { tool: 'Write' }, async ($, e) => {
      const input = e.input as { file_path: string; content: string };
      try {
        await $.fs.write(input.file_path, input.content);
        await $.store.set(`read:${input.file_path}`, '1');
        return { value: `已写入 ${input.file_path}（${input.content.length} 字符）` };
      } catch (error) {
        return { value: `ERROR: 写入失败: ${String(error)}` };
      }
    });
  },
};
```

> 一个插件对同一事件注册两次时，**先注册者在最外层**——上面的顺序是：先做"读过才允许覆盖"的检查，再落到真正写盘的 hook。这是文档里"同 plugin 先注册者最外层"的直接应用。

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/builtins/tools/read.ts src/builtins/tools/write.ts
git commit -m "feat(tools): Read 与 Write"
```

---

### Task 12: `builtins/tools/edit.ts`

**Files:**
- Create: `src/builtins/tools/edit.ts`

- [ ] **Step 1: 写 `src/builtins/tools/edit.ts`**

```ts
import type { Plugin } from '../../contract/plugin';

export const editTool: Plugin = {
  name: 'tool-edit',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Edit' },
      () => ({
        description:
          '把文件里的 old_string 精确替换成 new_string。old_string 必须在文件中唯一出现，否则报错。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
            new_string: { type: 'string', description: '替换成的新内容' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      }),
    );

    on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      let content: string;
      try {
        content = await $.fs.read(input.file_path);
        await $.store.set(`read:${input.file_path}`, '1');
      } catch (error) {
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }

      const first = content.indexOf(input.old_string);
      if (first === -1) {
        return { value: `ERROR: 在 ${input.file_path} 里找不到 old_string。请先 Read 确认原文。` };
      }
      if (content.indexOf(input.old_string, first + 1) !== -1) {
        return {
          value: `ERROR: old_string 在 ${input.file_path} 里出现多次，不唯一。请提供更多上下文。`,
        };
      }

      const updated =
        content.slice(0, first) + input.new_string + content.slice(first + input.old_string.length);

      // 校验通过，交给下层真正写盘。
      // confirm 的 diff 预览由它自己从原始 input 算 —— tool.check 跑在这之前，
      // 这里挂上去的字段它看不到。
      return next(e);
    });

    on('tool.call', { tool: 'Edit' }, async ($, e) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      try {
        const content = await $.fs.read(input.file_path);
        const at = content.indexOf(input.old_string);
        const updated =
          content.slice(0, at) + input.new_string + content.slice(at + input.old_string.length);
        await $.fs.write(input.file_path, updated);
        return { value: `已修改 ${input.file_path}` };
      } catch (error) {
        return { value: `ERROR: 修改失败: ${String(error)}` };
      }
    });
  },
};
```

> 这里读了两遍文件（一次校验、一次写盘）。MVP 接受这个小浪费——它换来了"校验与写入各自独立、不会因为中间状态而错位"的简单性。

- [ ] **Step 2: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/builtins/tools/edit.ts
git commit -m "feat(tools): Edit（唯一性校验 + 精确替换）"
```

---

### Task 13: `builtins/tools/bash.ts`

**Files:**
- Create: `src/builtins/tools/bash.ts`

- [ ] **Step 1: 写 `src/builtins/tools/bash.ts`**

```ts
import type { Plugin } from '../../contract/plugin';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 40_000;

export const bashTool: Plugin = {
  name: 'tool-bash',
  uses: ['tool.call', 'tool.describe', 'process'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Bash' },
      () => ({
        description:
          '在工作目录里执行一条 shell 命令，返回 stdout/stderr 与退出码。用于跑测试、构建、git 等。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            cwd: { type: 'string', description: '工作目录，默认会话根目录' },
            timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}` },
          },
          required: ['command'],
        },
      }),
    );

    on('tool.call', { tool: 'Bash' }, async ($, e) => {
      const input = e.input as { command: string; cwd?: string; timeout_ms?: number };
      if (!input?.command) return { value: 'ERROR: 缺少 command 参数' };
      const cwd = input.cwd ?? $.session.root();

      const result = await $.process.run(input.command, {
        cwd,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: new AbortController().signal,
      });

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
      parts.push(`[退出码 ${result.exitCode}]`);

      let output = parts.join('\n');
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n... 输出已截断`;
      }

      // 命令失败也是给模型的信息，不是崩溃 —— 所以这里仍然返回 value 而不是抛。
      return { value: output };
    });
  },
};
```

> `Bash` 的 `$.process.run` 传的是新的 `AbortController`，不是 `next.signal`。原因：MVP 的 `$` 名词是直接实现，拿不到 `next`；把 loop 的 signal 传进来需要在 Task 16 里给 loop 的 `ctx` 加上它。**Task 16 会用 `ctx.signal` 替换这里**，届时 Ctrl-C 能掐断正在跑的命令。这个替换是 Task 16 的一个明确步骤，不要漏。

- [ ] **Step 2: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/builtins/tools/bash.ts
git commit -m "feat(tools): Bash（超时、输出截断、失败不抛）"
```

---

### Task 14: `builtins/tools/glob.ts` + `grep.ts` + `index.ts`

**Files:**
- Create: `src/builtins/tools/glob.ts`
- Create: `src/builtins/tools/grep.ts`
- Create: `src/builtins/tools/index.ts`

- [ ] **Step 1: 写 `src/builtins/tools/glob.ts`**

```ts
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Plugin } from '../../contract/plugin';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_RESULTS = 500;

/** 极简 glob：支持 `**`（任意层）、`*`（单层任意）与字面量。够 MVP 用。 */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`);
}

export const globTool: Plugin = {
  name: 'tool-glob',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Glob' },
      () => ({
        description: '按路径模式查找文件，例如 `src/**/*.ts`。返回相对路径列表。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，如 `src/**/*.ts`' },
            path: { type: 'string', description: '搜索起点，默认会话根目录' },
          },
          required: ['pattern'],
        },
      }),
    );

    on('tool.call', { tool: 'Glob' }, async ($, e) => {
      const input = e.input as { pattern: string; path?: string };
      if (!input?.pattern) return { value: 'ERROR: 缺少 pattern 参数' };

      const root = input.path ?? $.session.root();
      const matcher = toRegExp(input.pattern);
      const found: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (found.length >= MAX_RESULTS) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (found.length >= MAX_RESULTS) return;
          if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

          const full = join(dir, entry.name);
          const rel = relative(root, full).replace(/\\/g, '/');
          if (entry.isDirectory()) await walk(full);
          else if (matcher.test(rel)) found.push(rel);
        }
      }

      await walk(root);
      return {
        value:
          found.length === 0
            ? `没有匹配 ${input.pattern} 的文件`
            : found.join('\n') + (found.length >= MAX_RESULTS ? '\n... 已达上限' : ''),
      };
    });
  },
};
```

- [ ] **Step 2: 写 `src/builtins/tools/grep.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Plugin } from '../../contract/plugin';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;

export const grepTool: Plugin = {
  name: 'tool-grep',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Grep' },
      () => ({
        description: '在文件内容里做正则搜索。返回 `相对路径:行号: 该行内容`。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式' },
            path: { type: 'string', description: '搜索起点，默认会话根目录' },
            glob: { type: 'string', description: '只看匹配该 glob 的文件，如 `**/*.ts`' },
          },
          required: ['pattern'],
        },
      }),
    );

    on('tool.call', { tool: 'Grep' }, async ($, e) => {
      const input = e.input as { pattern: string; path?: string; glob?: string };
      if (!input?.pattern) return { value: 'ERROR: 缺少 pattern 参数' };

      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (error) {
        return { value: `ERROR: 正则非法: ${String(error)}` };
      }

      const root = input.path ?? $.session.root();
      const fileFilter = input.glob ? new RegExp(globToRegexSource(input.glob)) : undefined;
      const matches: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (matches.length >= MAX_MATCHES) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= MAX_MATCHES) return;
          if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

          const full = join(dir, entry.name);
          const rel = relative(root, full).replace(/\\/g, '/');

          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (fileFilter && !fileFilter.test(rel)) continue;

          let fileStat;
          try {
            fileStat = await stat(full);
          } catch {
            continue;
          }
          if (fileStat.size > MAX_FILE_BYTES) continue;

          let text: string;
          try {
            text = await readFile(full, 'utf8');
          } catch {
            continue;
          }

          for (const [index, line] of text.split('\n').entries()) {
            if (matches.length >= MAX_MATCHES) return;
            if (regex.test(line)) matches.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`);
          }
        }
      }

      await walk(root);
      return {
        value:
          matches.length === 0
            ? `没有匹配 ${input.pattern} 的内容`
            : matches.join('\n') + (matches.length >= MAX_MATCHES ? '\n... 已达上限' : ''),
      };
    });
  },
};

function globToRegexSource(pattern: string): string {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return `^${escaped}$`;
}
```

- [ ] **Step 3: 写 `src/builtins/tools/index.ts`**

```ts
import type { Plugin } from '../../contract/plugin';
import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { writeTool } from './write';

/** MVP 的六个核心工具。这里是硬编码清单 —— P3 的目录扫描会取代它。 */
export const coreTools: readonly Plugin[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];
```

- [ ] **Step 4: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/builtins/tools/
git commit -m "feat(tools): Glob 与 Grep，六个核心工具齐备"
```

---

### Task 15: `builtins/confirm.ts` + `builtins/commands.ts`

**Files:**
- Create: `src/builtins/confirm.ts`
- Create: `src/builtins/commands.ts`

- [ ] **Step 1: 写 `src/builtins/confirm.ts`**

这是 MVP 的安全底线，也是 P2 会被整个替换掉的那个文件。

```ts
import type { Plugin } from '../contract/plugin';

/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/** 会改动磁盘或执行命令的工具，需要确认。 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

export const confirmPlugin: Plugin = {
  name: 'confirm',
  uses: ['tool.check', 'ui'],

  register(on) {
    on('tool.check', async ($, e) => {
      const tool = e.tool;

      if (READ_ONLY_TOOLS.has(tool)) return { decision: 'allow' };

      if (!MUTATING_TOOLS.has(tool)) {
        // 不认识的工具：拒绝，不是放行。
        return { decision: 'deny', rule: `未知工具 ${tool}，不在确认器的白名单里` };
      }

      // 打印预览，然后把"要不要做"交给 loop 统一问用户。
      const preview = renderPreview(tool, e.input);
      if (preview) $.ui.log(preview);

      return { decision: 'ask', rule: `最小确认：${tool}` };
    });
  },
};

/**
 * 预览从模型给的原始 input 直接算。
 *
 * 不能指望工具把预览挂在 e 上再流到这里：loop 里 tool.check 跑在 tool.call **之前**，
 * 工具的 hook 那时还没执行，挂上去的东西 confirm 根本看不见 —— 预览会永远显示
 * "(未知命令)"、Edit 永远没有 diff。所以预览必须自给自足。
 */
function renderPreview(tool: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>;

  if (tool === 'Bash') {
    const command = typeof data.command === 'string' ? data.command : '(未知命令)';
    return `\n  Bash  $ ${command}\n`;
  }

  const target = typeof data.file_path === 'string' ? data.file_path : '(未知文件)';

  if (tool === 'Edit') {
    const before = typeof data.old_string === 'string' ? data.old_string : '';
    const after = typeof data.new_string === 'string' ? data.new_string : '';
    const removed = before
      .split('\n')
      .map((line) => `  - ${line}`)
      .join('\n');
    const added = after
      .split('\n')
      .map((line) => `  + ${line}`)
      .join('\n');
    return `\n  Edit  ${target}\n${removed}\n${added}\n`;
  }

  if (tool === 'Write') {
    const content = typeof data.content === 'string' ? data.content : '';
    const lineCount = content === '' ? 0 : content.split('\n').length;
    const head = content
      .split('\n')
      .slice(0, 3)
      .map((line) => `  | ${line}`)
      .join('\n');
    return `\n  Write  ${target}（${lineCount} 行）\n${head}\n`;
  }

  return `\n  ${tool}  ${target}\n`;
}
```

- [ ] **Step 2: 写 `src/builtins/commands.ts`**

```ts
import type { Plugin } from '../contract/plugin';

/** MVP 只有两个斜杠命令。`/help` 的命令列表来自 $.command.list()，不是硬编码数组。 */
export const commandsPlugin: Plugin = {
  name: 'commands',
  uses: ['command.run', 'ui'],

  register(on) {
    on(
      'command.run',
      { name: 'exit' },
      () => {
        process.exitCode = 0;
        process.kill(process.pid, 'SIGINT');
        return { handled: true };
      },
    );

    on(
      'command.run',
      { name: 'help' },
      async ($) => {
        const commands = $.command.list();
        const tools = $.tool.list();
        $.ui.log(
          [
            '可用命令：' + commands.map((name) => `/${name}`).join('  '),
            '可用工具：' + tools.join('  '),
            '直接输入自然语言即可对话。',
          ].join('\n'),
        );
        return { handled: true };
      },
    );
  },
};
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/builtins/confirm.ts src/builtins/commands.ts
git commit -m "feat(builtins): 最小确认器与斜杠命令"
```

---

### Task 16: `core/loop.ts` —— agent loop

**Files:**
- Create: `src/core/loop.ts`
- Modify: `src/builtins/tools/bash.ts`（把 `new AbortController().signal` 换成 `$.session` 提供的会话 signal —— 见下）

- [ ] **Step 1: 写 `src/core/loop.ts`**

```ts
import type { ContentBlock, Message, ModelProvider, ToolSpec } from '../contract/model-provider';
import type { Args, EventName, Result } from '../contract/events';
import type { EngineInterface } from '../contract/engine';
import { CORE_ORIGIN, type Origin } from '../contract/next';

/** 一个 turn 内最多允许的"模型→工具→模型"往返次数，防止模型陷入死循环。 */
const MAX_HOPS = 25;

export type LoopContext = {
  $: EngineInterface;
  provider: ModelProvider;
  signal: AbortSignal;
  dispatch: <N extends EventName>(event: N, args: Args<N>, origin: Origin) => Promise<Result<N>>;
  systemPrompt: string;
  turnIndex: number;
};

/** 跑一个完整 turn：把 messages 推进到模型不再要工具为止。messages 会被就地追加。 */
export async function runTurn(ctx: LoopContext, messages: Message[]): Promise<void> {
  await ctx.dispatch('turn.start', { index: ctx.turnIndex }, CORE_ORIGIN);

  const tools = await describeTools(ctx);
  let stopReason = 'end_turn';

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const blocks: ContentBlock[] = [];
    const toolUses: Extract<ContentBlock, { type: 'tool_use' }>[] = [];
    let text = '';
    let failure: string | undefined;

    // provider 网络错 / 限流：退避重试一次。见设计文档 §5.1。
    for (let attempt = 0; attempt < 2; attempt++) {
      // 每次尝试都清空累积器。不清的话，第一次尝试里已经收到的 tool_use
      // block 会被第二次重放一遍，同一个工具被调用两次。
      // （能走到重试就说明这次一个字符都没流出去，见下面的 `if (text) break`，
      //  所以清空是安全的 —— 用户还没看到任何东西。）
      blocks.length = 0;
      toolUses.length = 0;
      text = '';

      try {
        for await (const event of ctx.provider.stream({
          system: ctx.systemPrompt,
          messages,
          tools,
          signal: ctx.signal,
        })) {
          if (event.type === 'text') {
            text += event.text;
            await ctx.dispatch('turn.step', { delta: event.text }, CORE_ORIGIN);
          } else if (event.type === 'tool_use') {
            const block = {
              type: 'tool_use' as const,
              id: event.id,
              name: event.name,
              input: event.input,
            };
            blocks.push(block);
            toolUses.push(block);
          } else {
            stopReason = event.stopReason;
          }
        }
        failure = undefined;
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // 已经把部分文本推给用户了，重试会造成重复输出 —— 不再重试。
        if (text) break;
        if (attempt === 0) {
          ctx.$.logger.warn(`provider 出错，1 秒后重试一次：${failure}`);
          await sleep(1000);
        }
      }
    }

    // 重试后仍然失败：结束本 turn，但保留会话、不退出进程。
    if (failure !== undefined) {
      ctx.$.ui.notice(`本 turn 失败：${failure}（会话保留，可以继续输入）`);
      await ctx.dispatch('turn.complete', { stopReason: 'error', inputTokens: 0, outputTokens: 0 }, CORE_ORIGIN);
      return;
    }

    const assistantBlocks: ContentBlock[] = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    assistantBlocks.push(...blocks);
    messages.push({ role: 'assistant', content: assistantBlocks });

    if (toolUses.length === 0) break;

    for (const use of toolUses) {
      const output = await runOneTool(ctx, use);
      messages.push({
        role: 'tool',
        toolUseId: use.id,
        content: output.text,
        isError: output.isError,
      });
    }
  }

  await ctx.dispatch(
    'turn.complete',
    { stopReason, inputTokens: 0, outputTokens: 0 },
    CORE_ORIGIN,
  );
}

/** 抛 tool.check 判定 → 需要就问用户 → 抛 tool.call 执行。 */
async function runOneTool(
  ctx: LoopContext,
  use: Extract<ContentBlock, { type: 'tool_use' }>,
): Promise<{ text: string; isError: boolean }> {
  const check = await ctx.dispatch(
    'tool.check',
    { tool: use.name, input: use.input },
    CORE_ORIGIN,
  );

  if (check.decision === 'deny') {
    return { text: `ERROR: 已拒绝 —— ${check.rule ?? '没有给出理由'}`, isError: true };
  }

  if (check.decision === 'ask') {
    const answer = await ctx.$.ui.ask(`执行 ${use.name}? (y/N) `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      return { text: 'ERROR: 用户拒绝了这次操作', isError: true };
    }
  }

  const result = await ctx.dispatch(
    'tool.call',
    { tool: use.name, input: use.input, toolUseId: use.id },
    CORE_ORIGIN,
  );

  if ('deny' in result) {
    return { text: `ERROR: ${result.deny}`, isError: true };
  }

  const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  return { text, isError: text.startsWith('ERROR:') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 工具清单与描述都来自 tool.describe 事件 —— 内核里没有硬编码的工具表。 */
async function describeTools(ctx: LoopContext): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  for (const name of ctx.$.tool.list()) {
    try {
      const described = await ctx.dispatch('tool.describe', { tool: name }, CORE_ORIGIN);
      specs.push({
        name,
        description: described.description,
        inputSchema: described.inputSchema,
      });
    } catch (error) {
      ctx.$.logger.warn(`工具 ${name} 没有注册描述，已从模型可见列表中略去：${String(error)}`);
    }
  }
  return specs;
}
```

- [ ] **Step 2: 让 Bash 用上会话 signal（拧紧 Task 13 留下的那个口子）**

Ctrl-C 必须能掐断正在跑的命令。做法是把 loop 的 signal 通过 `$` 传下去。在 `src/contract/engine.ts` 的 `SessionNoun` 上加一个 `signal()`：

```ts
export type SessionNoun = {
  id(): string;
  cwd(): string;
  root(): string;
  /** 会话级 AbortSignal：用户 Ctrl-C 时触发，用来掐断正在跑的外部命令。 */
  signal(): AbortSignal;
};
```

在 `src/core/nouns/index.ts` 的 `deps` 里加 `signal: AbortSignal`，并让 `session` 名词返回它：

```ts
    session: {
      id: () => deps.sessionInfo.id,
      cwd: () => deps.sessionInfo.cwd,
      root: () => deps.sessionInfo.root,
      signal: () => deps.signal,
    },
```

`src/core/create.ts` 里**不用改**：它的 `CreateEngineDeps extends CoreNounsDeps`，本来就把整个 `deps` 传给了 `createCoreNouns(deps, registry)`，加上字段后 `deps.signal` 自动流下去。

最后把 `src/builtins/tools/bash.ts` 里的一行改掉：

```ts
      const result = await $.process.run(input.command, {
        cwd,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: $.session.signal(),
      });
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。若报 `$.session.signal` 不存在，说明 Step 2 的 `SessionNoun` 改动没落到 `contract/engine.ts`。

- [ ] **Step 4: Commit**

```bash
git add src/core/loop.ts src/contract/engine.ts src/core/nouns/ src/core/create.ts src/builtins/tools/bash.ts
git commit -m "feat(core): agent loop 与可中断的会话 signal"
```

---

## C2 检查点 · 工具与 E2E 批量验证

### Task 17: 工具测试 + mock provider 的 E2E

**Files:**
- Create: `test/tools.test.ts`
- Create: `test/e2e.test.ts`

**一次写完，一次跑完。** 六个工具的测试**合并在这一个文件里**，不拆。

- [ ] **Step 1: 写 `test/tools.test.ts`**

```ts
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness';
import { coreTools } from '../src/builtins/tools';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';
import { createFsNoun } from '../src/core/nouns/fs';
import { createProcessNoun } from '../src/core/nouns/process';
import { createStoreNoun } from '../src/core/nouns/store';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeHarness() {
  // engine 必须先建好再交给 createHarness —— 它是 hook 里 $ 的来源。
  // 漏传的话 createHarness 会退回 NOOP_ENGINE（空对象），此时
  // `$.fs.read(...)` 会抛 TypeError，被 dispatch 的故障隔离吞掉，
  // 最后落到内核的 { deny: 'unknown tool' } —— 于是每个工具测试都"失败"，
  // 但看起来像工具坏了，其实是 harness 没接上。直接用真实的名词实现，
  // 只有 session 是桩。
  const engine = {
    session: { id: () => 'test', cwd: () => root, root: () => root, signal: () => new AbortController().signal },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    ui: { log: () => {}, notice: () => {}, ask: async () => 'n' },
    logger: { debug: () => {}, warn: () => {} },
    // 真实内核的 $.tool.list() 是注册面上 `tool.call` 的 matcher 取值（见 nouns/index.ts）。
    // 桩这里不能写成 coreTools.map(p => p.name) —— 那是插件名（'tool-read'），
    // 不是工具名（'Read'）。写错的话 describeTools 会拿插件名去查 tool.describe，
    // 六个工具全部落到 catch 分支被静默略去，E2E 表面上照样绿。
    tool: { list: () => ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] },
    command: { list: () => [] },
    model: { stream: async function* () {} },
  } as unknown as EngineInterface;

  const h = createHarness({
    engine,
    coreImpls: {
      'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),
      'tool.describe': () => {
        throw new Error('no description');
      },
    },
  });

  for (const plugin of coreTools) {
    plugin.register((pattern: string, second: any, third?: any) => {
      // 显式分支而不是展开数组：h.on 是重载函数，
      // 用 `...args` 展开会让 TS 无法选定重载。
      if (third !== undefined) {
        h.on('builtin', plugin.name, pattern, second as Record<string, unknown>, third as EventHook);
      } else {
        h.on('builtin', plugin.name, pattern, second as EventHook);
      }
    });
  }

  return { h, engine };
}

async function call(world: ReturnType<typeof makeHarness>, tool: string, input: unknown) {
  return world.h.dispatch('tool.call', { tool, input, toolUseId: 'x' }, CORE_ORIGIN);
}

describe('六个核心工具', () => {
  it('Write 与 Read 往返', async () => {
    const ctx = makeHarness();
    const target = join(root, 'a.txt');

    await call(ctx, 'Write', { file_path: target, content: 'hello\nworld' });
    const result = await call(ctx, 'Read', { file_path: target });
    expect((result as any).value).toContain('1\thello');
    expect((result as any).value).toContain('2\tworld');
  });

  it('Write 拒绝覆盖没读过的已有文件', async () => {
    const ctx = makeHarness();
    const target = join(root, 'b.txt');
    await writeFile(target, 'original', 'utf8');

    const result = await call(ctx, 'Write', { file_path: target, content: 'overwritten' });
    expect((result as any).value).toContain('已存在');
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('Edit 精确替换', async () => {
    const ctx = makeHarness();
    const target = join(root, 'c.ts');
    await writeFile(target, 'const a = 1;\nconst b = 2;\n', 'utf8');
    await call(ctx, 'Read', { file_path: target });

    await call(ctx, 'Edit', { file_path: target, old_string: 'const a = 1;', new_string: 'const a = 9;' });
    expect(await readFile(target, 'utf8')).toBe('const a = 9;\nconst b = 2;\n');
  });

  it('Edit 在 old_string 不唯一时拒绝', async () => {
    const ctx = makeHarness();
    const target = join(root, 'd.ts');
    await writeFile(target, 'x();\nx();\n', 'utf8');
    await call(ctx, 'Read', { file_path: target });

    const result = await call(ctx, 'Edit', { file_path: target, old_string: 'x();', new_string: 'y();' });
    expect((result as any).value).toContain('不唯一');
    expect(await readFile(target, 'utf8')).toBe('x();\nx();\n');
  });

  it('Bash 返回 stdout 与退出码', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Bash', { command: 'echo hi' });
    expect((result as any).value).toContain('hi');
    expect((result as any).value).toContain('退出码 0');
  });

  it('Bash 命令失败时返回 value 而不是抛错', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Bash', { command: 'exit 3' });
    expect((result as any).value).toContain('退出码 3');
  });

  it('Glob 按模式找到文件', async () => {
    const ctx = makeHarness();
    await writeFile(join(root, 'e.ts'), '', 'utf8');
    const result = await call(ctx, 'Glob', { pattern: '*.ts' });
    expect((result as any).value).toContain('e.ts');
  });

  it('Grep 返回 路径:行号: 内容', async () => {
    const ctx = makeHarness();
    await writeFile(join(root, 'f.ts'), 'const needle = 1;\n', 'utf8');
    const result = await call(ctx, 'Grep', { pattern: 'needle' });
    expect((result as any).value).toMatch(/f\.ts:1:.*needle/);
  });

  it('未知工具被拒绝而不是放行', async () => {
    const ctx = makeHarness();
    const result = await call(ctx, 'Nope', {});
    expect((result as any).deny).toContain('unknown tool');
  });
});
```

- [ ] **Step 2: 写 `test/e2e.test.ts`**

E2E 用脚本化的 provider 驱动完整的 agent loop：模型要求 Read → 工具返回 → 模型要求 Edit → 工具返回 → 模型收尾。**不花 token、可确定性重放。**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, scriptedProvider } from './harness';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { runTurn } from '../src/core/loop';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import type { Message } from '../src/contract/model-provider';
import type { EventHook } from '../src/contract/plugin';
import { createFsNoun } from '../src/core/nouns/fs';
import { createProcessNoun } from '../src/core/nouns/process';
import { createStoreNoun } from '../src/core/nouns/store';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-e2e-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function buildWorld(answers: string[]) {
  const asked: string[] = [];
  const engine = {
    session: { id: () => 'e2e', cwd: () => root, root: () => root, signal: () => new AbortController().signal },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    ui: {
      log: () => {},
      notice: () => {},
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? 'n';
      },
    },
    logger: { debug: () => {}, warn: () => {} },
    // 真实内核的 $.tool.list() 是注册面上 `tool.call` 的 matcher 取值（见 nouns/index.ts）。
    // 桩这里不能写成 coreTools.map(p => p.name) —— 那是插件名（'tool-read'），
    // 不是工具名（'Read'）。写错的话 describeTools 会拿插件名去查 tool.describe，
    // 六个工具全部落到 catch 分支被静默略去，E2E 表面上照样绿。
    tool: { list: () => ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] },
    command: { list: () => [] },
    model: { stream: async function* () {} },
  } as unknown as EngineInterface;

  // engine 必须传进去：createHarness 漏了它会退回空对象，
  // 工具 hook 里的 `$.fs` 就是 undefined，整个 E2E 会以假乱真地失败。
  const h = createHarness({
    engine,
    coreImpls: {
      'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),
      'tool.check': () => ({ decision: 'deny', rule: 'fail-closed' }),
      'tool.describe': () => {
        throw new Error('no description');
      },
    },
  });

  for (const plugin of [...coreTools, confirmPlugin]) {
    plugin.register((pattern: string, second: any, third?: any) => {
      if (third !== undefined) {
        h.on('builtin', plugin.name, pattern, second as Record<string, unknown>, third as EventHook);
      } else {
        h.on('builtin', plugin.name, pattern, second as EventHook);
      }
    });
  }

  return { h, engine, asked };
}

describe('E2E：脚本化模型的完整 turn', () => {
  it('Read → Edit → 收尾，且 Edit 前问过用户', async () => {
    const target = join(root, 'greet.ts');
    await writeFile(target, 'export const greet = () => "hi";\n', 'utf8');

    const { h, engine, asked } = buildWorld(['y']);

    const provider = scriptedProvider([
      [
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: target } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        {
          type: 'tool_use',
          id: 'u2',
          name: 'Edit',
          input: { file_path: target, old_string: '"hi"', new_string: '"hello"' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', text: '改好了。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const messages: Message[] = [{ role: 'user', content: '把 greet 的返回值改成 hello' }];
    await runTurn(
      {
        $: engine,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(await readFile(target, 'utf8')).toBe('export const greet = () => "hello";\n');
    expect(asked).toHaveLength(1);          // 只有 Edit 问了一次；Read 不问
    expect(asked[0]).toContain('Edit');
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('用户拒绝时工具不执行，且拒绝结果回灌给模型', async () => {
    const target = join(root, 'keep.ts');
    await writeFile(target, 'original\n', 'utf8');

    const { h, engine, asked } = buildWorld(['n']);

    const provider = scriptedProvider([
      [
        { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: target, old_string: 'original', new_string: 'changed' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', text: '好的，不改了。' }, { type: 'done', stopReason: 'end_turn' }],
    ]);

    const messages: Message[] = [{ role: 'user', content: '改一下' }];
    await runTurn(
      {
        $: engine,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(asked).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe('original\n');
    const toolResult = messages.find((m) => m.role === 'tool') as any;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain('拒绝');
  });
});
```

- [ ] **Step 3: 一次跑完全部测试**

Run: `pnpm test`
Expected: 全部 PASS。

**如果 E2E 里 `asked` 是空的**，检查 `confirmPlugin` 是否被注册进了 harness —— 它才是决定 `decision: 'ask'` 的那个 hook。

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: C2 检查点 —— 六个工具与 mock provider E2E"
```

> **C2 出口**：工具测试与 E2E 全绿。loop 能跑完整闭环，确认流程的拒绝路径正确。

---

## M3 · CLI

### Task 18: `cli/prompt.ts` + `cli/render.ts`

**Files:**
- Create: `src/cli/prompt.ts`
- Create: `src/cli/render.ts`

> **实施记录**：`render.ts` 落地时多了一个 `atLineStart` 状态，`print` / `notice` /
> `newline` 都会先补上那半行。原来 `newline()` 只在 TTY 下无条件写一个 `\n`，是够用的 ——
> 那会儿 `delta` 是死代码，没有任何东西会停在行中间。一旦增量打印真接上（见 Task 19），
> 工具预览和通知就会接到半句话后面，这个状态从"没必要"变成"必需"。

- [ ] **Step 1: 写 `src/cli/prompt.ts`**

非 TTY 时 `ask` 返回 `'n'` —— 这是 fail-closed 在交互层的体现（管道、CI 里没人能按 y）。

```ts
import type { Interface } from 'node:readline';
import type { UiSink } from '../core/nouns/ui';

/**
 * 复用调用方那**一个** readline 实例，绝不自己再建第二个。
 *
 * 同一个 process.stdin 上挂两个 Interface，两边都会收到用户敲的每一行
 * （已实测：两次 question 同时挂起时，一行输入被两个回调各收一份）。
 * 而 TTY 下两个 Interface 还会各自进入 raw 模式、各自挂 keypress 监听，
 * 于是每个按键被处理两遍、终端里回声重叠。
 *
 * 所以 rl 由 main.ts 建一次，REPL 与确认提示共用。
 */
export function createPromptSink(rl: Interface): UiSink & { close(): void } {
  const interactive = Boolean(process.stdin.isTTY);

  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),
    ask: (question) => {
      // 非交互环境没人能确认 —— 默认拒绝，不放行。
      if (!interactive) return Promise.resolve('n');
      return new Promise((resolve) => rl.question(question, resolve));
    },
    close: () => rl.close(),
  };
}
```

- [ ] **Step 2: 写 `src/cli/render.ts`**

```ts
import type { UiSink } from '../core/nouns/ui';

/**
 * MVP 的渲染就是往 stdout 写文本 —— 不走 ui.render 事件。
 * 架构文档里的 ui.render 返回的是纯数据树 + 逐 surface 元素表，那是为了跨
 * terminal/desktop/mobile 复用；MVP 只有一个 surface，现在建它是白建。见设计文档 §10 偏差 1。
 */
export type Renderer = UiSink & { delta(text: string): void; newline(): void };

export function createRenderer(): Renderer {
  const interactive = Boolean(process.stdout.isTTY);
  return {
    print: (line) => process.stdout.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),
    ask: async () => 'n',
    delta: (text) => process.stdout.write(text),
    newline: () => {
      if (interactive) process.stdout.write('\n');
    },
  };
}
```

- [ ] **Step 3: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/cli/prompt.ts src/cli/render.ts
git commit -m "feat(cli): 输入 sink 与流式渲染"
```

---

### Task 19: `cli/repl.ts` + `cli/main.ts` + bin

**Files:**
- Create: `src/cli/repl.ts`
- Create: `src/cli/main.ts`
- Create: `bin/deepcode.mjs`
- Modify: `src/builtins/commands.ts`（`/exit` 那处，见 Step 2 末尾）

README 归 Task 21 一次写成，本任务不碰它（写了也是马上被覆盖）。

> **实施记录**：本任务实际多落了三个文件，计划里没有 —— 它们是两个只在真机上才暴露的
> 空洞，测试全绿也照样在：
>
> - **`src/cli/stream.ts`**：把 `turn.step` 的增量写进渲染器。计划漏了它，而它是
>   **产品能不能说话**的分界线 —— `render.delta` 被定义出来却没有任何调用者，
>   于是模型说的话一个字都到不了终端（内核负责抛事件，插件负责应答；
>   `NOTIFICATION_EVENTS` 的兜底只是安静地返回 `{}`）。当时的 typecheck / lint /
>   C1 / C2 全绿，因为它们断言的是事件链与文件内容，不是终端上有没有字。
> - **`src/cli/plugins.ts`**：插件清单从 `main()` 里抽出来，好让测试钉住"文本出口
>   确实在这份清单里"。不抽的话"少装一个插件"只能靠人肉端到端发现。
> - **`src/cli/turns.ts`**：每个 turn 一个 `AbortSignal`。原计划全进程共用一个
>   `controller`，而 `AbortSignal` 一旦 abort 就回不去 —— 按一次 Ctrl-C 之后，
>   往后每个 turn 都拿着已 abort 的 signal 去 fetch，会话当场变成尸体，
>   而 loop 还在提示"会话保留，可以继续输入"。连带 `CoreNounsDeps.signal` 与
>   `DispatcherDeps.signal` 从 `AbortSignal` 改成 `() => AbortSignal`。
>
> 三个都有测试钉住（`test/cli.test.ts`），其中最后一条走真实 `createEngine` +
> 真实 `runTurn` + `cliPlugins(render)`。

- [ ] **Step 1: 写 `src/cli/repl.ts`**

```ts
import type { Interface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import type { EngineInterface } from '../contract/engine';
import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { runTurn } from '../core/loop';
import type { Renderer } from './render';

export type ReplDeps = {
  $: EngineInterface;
  dispatch: DispatchFn;
  render: Renderer;
  /** 与确认提示共用的那一个 readline 实例。不要在别处再 createInterface。 */
  rl: Interface;
  systemPrompt: string;
  signal: AbortSignal;
};

/** 交互式 REPL。退出方式：/exit、Ctrl-D、Ctrl-C。 */
export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = deps.rl;
  const messages: Message[] = [];
  let turnIndex = 0;

  /** 问一行；stdin 关闭（Ctrl-D）时返回 null。 */
  const askLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      // close 监听必须在拿到答案后摘掉。rl.once 每调用一次就挂一个新监听，
      // 而 rl 是整个会话共用的 —— 不摘的话监听器一路累积，
      // 十几轮之后就开始刷 MaxListenersExceededWarning。
      const onClose = () => resolve(null);
      rl.once('close', onClose);
      rl.question('\n> ', (answer) => {
        rl.off('close', onClose);
        resolve(answer);
      });
    });

  for (;;) {
    const line = await askLine();
    if (line === null) break;

    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith('/')) {
      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      const result = await deps.dispatch('command.run', { name: name ?? '', args }, CORE_ORIGIN);
      if (result.handled) {
        if (name === 'exit') break;
        continue;
      }
      deps.render.notice(`未知命令：/${name}`);
      continue;
    }

    // prompt.submit 是留给 P1 的钩子点（斜杠展开、prompt.fill、附件）。
    // core 返回 { handled: false }，所以 MVP 里它什么都不做 —— 但它真的被抛出来了，
    // 而不是躺在 contract 里没人碰。
    const submitted = await deps.dispatch('prompt.submit', { text: trimmed }, CORE_ORIGIN);
    if (submitted.handled) continue;

    messages.push({ role: 'user', content: trimmed });

    await runTurn(
      {
        $: deps.$,
        provider: { name: 'repl', stream: (req) => deps.$.model.stream(req) },
        signal: deps.signal,
        dispatch: deps.dispatch,
        systemPrompt: deps.systemPrompt,
        turnIndex: turnIndex++,
      },
      messages,
    );

    deps.render.newline();
  }

  rl.close();
}
```

- [ ] **Step 2: 写 `src/cli/main.ts`**

```ts
// import 清单只认本任务末尾那份"配套的 import 清单"，不要在这里另列一份。
// 原先这里有一份和它不一致的旧清单（少 CORE_ORIGIN / Message / runTurn，
// 多一个从头到尾没人用的 Plugin）—— 照着旧的那份写会编译不过。
```

/** 项目指令文件。MVP 只看两层：项目与用户。嵌套懒加载是 P4 的事。 */
async function loadInstructions(root: string, home: string): Promise<string> {
  const parts: string[] = [];
  for (const file of [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'), join(home, '.deepcode', 'AGENTS.md')]) {
    if (existsSync(file)) {
      parts.push(`Contents of ${file}:\n\n${await readFile(file, 'utf8')}`);
    }
  }
  return parts.join('\n\n');
}

const SYSTEM_PROMPT = `你是 DeepCode，一个在用户终端里工作的编码助手。

工作方式：
- 需要看代码就用 Read / Glob / Grep，不要凭空猜文件内容。
- 改文件用 Edit（精确替换）或 Write（整体重写）；Write 覆盖已有文件前必须先 Read 过它。
- 需要跑测试、构建、git 就在 Bash 里跑。
- 工具失败会以 ERROR: 开头返回给你，那是信息不是崩溃 —— 读它、改方案、再试。

回答保持简短，说清楚你改了什么、为什么。`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('缺少 ANTHROPIC_API_KEY 环境变量。\n');
    process.exitCode = 1;
    return;
  }

  const root = resolve(process.cwd());
  const home = process.env.USERPROFILE ?? process.env.HOME ?? root;
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  });

  const render = createRenderer();
  // readline 全进程只建这一次：REPL 的行输入与工具确认提示共用同一个实例。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const prompt = createPromptSink(rl);
  const provider = createAnthropicProvider({
    apiKey,
    model: process.env.DEEPCODE_MODEL ?? 'claude-sonnet-4-5',
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });

  const { $, dispatch } = await createEngine({
    plugins: [...coreTools, confirmPlugin, commandsPlugin],
    provider,
    ui: { print: render.print, notice: render.notice, ask: prompt.ask },
    sessionInfo: { id: String(Date.now()), cwd: root, root },
    env: process.env,
    signal: controller.signal,
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  const instructions = await loadInstructions(root, home);
  const systemPrompt = instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT;

  const oneShot = args.join(' ').trim();

  if (oneShot) {
    // 一次性模式：`deepcode "改一下 X"`
    const messages: Message[] = [{ role: 'user', content: oneShot }];
    await runTurn(
      { $, provider, signal: controller.signal, dispatch, systemPrompt, turnIndex: 0 },
      messages,
    );
    render.newline();
  } else {
    await startRepl({ $, dispatch, render, rl, systemPrompt, signal: controller.signal });
  }

  await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
  prompt.close();
}

main().catch((error) => {
  process.stderr.write(`启动失败：${String(error)}\n`);
  process.exitCode = 1;
});
```

配套的 import 清单（本文件开头）：

```ts
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import { CORE_ORIGIN } from '../contract/next';
import { createEngine } from '../core/create';
import { runTurn } from '../core/loop';
import { createAnthropicProvider } from '../providers/anthropic';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { createPromptSink } from './prompt';
import { createRenderer } from './render';
import { startRepl } from './repl';
```

`main()` 之外还要有 `loadInstructions` 与 `SYSTEM_PROMPT`（见 Step 2 上半段）。注意 `provider` 是**独立的变量**而不是从 `$` 上取：`$.model` 是个只暴露 `stream` 的名词，`runTurn` 要的是完整的 `ModelProvider`。

**顺带修一处 `src/builtins/commands.ts`。** `/exit` 的 hook 目前是：

```ts
process.exitCode = 0;
process.kill(process.pid, 'SIGINT');
return { handled: true };
```

那句 `process.kill` 是错的，删掉它、只留 `process.exitCode = 0`。两个理由：

1. 它多余 —— `startRepl` 收到 `handled: true` 后会自己 `break`，退出路径本来就是干净的。
2. 它会伤到这次新加的 SIGINT 处理器：`main.ts` 在 Ctrl-C 上挂了一个处理器，自己给自己发 SIGINT 就会把它一并触发。POSIX 上只是顺手 abort 一次 `controller`（无害但莫名其妙）；Windows 上 `process.kill` 对非 0 信号是**无条件终止进程**，于是 `session.end` 根本来不及 dispatch、退出码也不受 `exitCode = 0` 控制。

```ts
    on(
      'command.run',
      { name: 'exit' },
      () => {
        process.exitCode = 0;
        return { handled: true };
      },
    );
```

- [ ] **Step 3: 写 `bin/deepcode.mjs`**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'cli', 'main.ts');

const child = spawn(process.execPath, [join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
```

- [ ] **Step 4: 验证编译**

Run: `pnpm typecheck`
Expected: 无错误。若报 `createEngine` 的参数类型不匹配，逐一核对：`plugins` / `provider` / `ui` / `sessionInfo` / `env` / `signal` —— 这里**不该有** `registry`（它是 `createEngine` 自建的）。

- [ ] **Step 5: Commit**

```bash
git add src/cli/ bin/ src/builtins/commands.ts
git commit -m "feat(cli): REPL、一次性模式与 deepcode 可执行入口"
```

---

## M4 · 收尾

### Task 20: C3 手动端到端验证

**Files:** 无新增

这是**手动**检查点。前面所有测试都跑在 mock 世界里，这一次要真连模型。

> **准备状态**：验收目录已经建好，在 `C:\Users\86178\deepcode-accept`（Git Bash 里是
> `~/deepcode-accept`），三个文件按下面 Step 1 的内容写好了 —— 在 Windows 上直接 `cd` 过去即可，
> 不必再手工建。改坏了也没关系，就是拿来做靶子的。

- [ ] **Step 1: 准备一个真实验收场景**

在一个**临时目录**里建三个文件（不要在自己的仓库里试，因为这一步会真的改文件）：

```bash
mkdir -p /tmp/deepcode-accept && cd /tmp/deepcode-accept
cat > utils.ts <<'EOF'
export function parseDate(input: string): Date {
  return new Date(input);
}
EOF
cat > utils.test.ts <<'EOF'
import { expect, it } from 'vitest';
import { parseDate } from './utils';

it('显式带偏移的时间，按原偏移理解', () => {
  expect(parseDate('2026-10-11T10:00:00+08:00').toISOString()).toBe('2026-10-11T02:00:00.000Z');
});

it('没带时区的时间一律当北京时间（UTC+8），跟机器在哪个时区无关', () => {
  // 为什么要折腾这一下 TZ：开发机本身就在东八区，不把它假装成别的时区，
  // `new Date(input)` 这种"靠机器本地时区蒙对"的实现照样能过 ——
  // 那条测试就只是在确认"我人在中国"，而不是在确认代码对不对。
  const before = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    expect(parseDate('2026-10-11 10:00:00').toISOString()).toBe('2026-10-11T02:00:00.000Z');
    expect(parseDate('2026-10-11T10:00:00').toISOString()).toBe('2026-10-11T02:00:00.000Z');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
EOF
# 让"跑测试确认"这半句真的可执行：本目录没有依赖，直接借用 DeepCode 仓库里的 vitest。
cat > package.json <<'EOF'
{
  "name": "deepcode-accept",
  "private": true,
  "type": "module",
  "scripts": { "test": "node F:/ts/DeepCode/node_modules/vitest/vitest.mjs run" }
}
EOF
```

> **这个夹具是改过的版本，第一版是空转的。** 初稿的 `utils.test.ts` 只有那条显式 `+08:00`
> 的断言，而 `new Date('2026-10-11T10:00:00+08:00')` 本来就返回正确结果 —— 测试一开始就绿，
> 模型会理直气壮地回答"已通过、无需改动"，整场验收什么都验不到（而且开发机本地时区就是
> `Asia/Shanghai`，"按北京时间解释"这条要求靠 `new Date` 蒙也能蒙对）。
> 现在这条测试把机器假装成 UTC 再断言，**未修的 `utils.ts` 必须失败** —— 实测：
> 修之前 `1 failed | 1 passed`，套用参考实现后 `2 passed`，还原后又变回红。
> 两边都验过，才算这个靶子有牙。

- [ ] **Step 2: 跑起来**

```bash
cd /tmp/deepcode-accept
# 不必再 export ANTHROPIC_API_KEY：用户级配置 C:\Users\86178\.deepcode\config.json 里已经有了。
# 别用 `pnpm --dir /path/to/DeepCode dev`：pnpm 会把脚本的 cwd 设成**包目录**，
# 于是工具的工作目录变成 DeepCode 仓库本身，而不是这个验收目录 —— 模型会在
# 错误的仓库里改文件。直接跑 bin 并给绝对路径：bin 是在自己所在位置解析 tsx 的，
# 从哪个目录 cd 过去都能跑，而 cwd 保持为验收目录。
node F:/ts/DeepCode/bin/deepcode.mjs "给 utils.ts 里的 parseDate 加上时区处理：没带时区的时间按北京时间（UTC+8）算，然后跑测试确认"
```

（Git Bash 的 `/tmp` 指向 Windows 临时目录；用 `~/deepcode-accept` 也一样。）

Expected: 模型先 Read `utils.ts`、再 `npm test` 看到红的，然后 Edit `utils.ts`；Edit 之前终端打印出
`-  return new Date(input);` / `+  ...` 并停下来等 `执行 Edit? (y/N)`。按 `y` 之后它应当再跑一次测试，
告诉你 `2 passed`。**如果它第一句就说"测试已经通过、无需改动"，那是它没跑测试** —— 这正是初版夹具
的毛病，现在红是已知状态。

- [ ] **Step 3: 在同一次会话里顺手验三件事**

1. **按 `n`** → 工具不执行，模型收到 `ERROR: 用户拒绝了这次操作` 并继续对话（而不是崩掉）。
2. **让模型跑一条耗时的命令，在它跑的时候按 Ctrl-C** → 命令被掐断，进程不退出。
   Windows 的 cmd 里没有 `sleep`，改说"跑 `ping -n 30 127.0.0.1`"。
   **再补一句最关键的下半场**：中断之后**继续对话**，下一个 turn 必须照常工作 ——
   这条是 per-turn signal 的验收点（见 `cli/turns.ts`）。中断只掐断这一次，不是废掉会话。
   空闲时按 Ctrl-C 应当直接退出。
3. **管道模式**（非 TTY）验证写入被拒：

```bash
echo "把 utils.ts 里 parseDate 的返回值改成 null" | node F:/ts/DeepCode/bin/deepcode.mjs
```

Expected: 模型要求 Edit，但因为 stdin 不是 TTY，`ask` 直接返回 `'n'`，文件**未被修改**。

- [ ] **Step 4: 记录结果**

把这一次跑通的完整交互贴进 commit message。**如果任何一条没通过，先修再往下走。**

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "test: C3 手动端到端验收通过（Read→Edit→Bash 闭环）"
```

> **C3 出口**：三条都过 —— 闭环跑通、拒绝可用、Ctrl-C 可中断、非 TTY 安全。

---

### Task 21: C4 收尾 —— 边界检查、全量测试、README

**Files:**
- Create: `README.md`
- Modify: `package.json`（确认 scripts 齐全）

- [ ] **Step 1: 写 `README.md`**

```markdown
# DeepCode

一个终端里的 agentic 编码助手。给它一句自然语言，它会读文件、改文件、跑命令。

## 用法

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm install

# 一次性
pnpm dev "给 utils.ts 里的 parseDate 加上时区处理"

# 交互式
pnpm dev
```

可选环境变量：

| 变量 | 作用 |
|---|---|
| `DEEPCODE_MODEL` | 覆盖模型 id，默认 `claude-sonnet-4-5` |
| `ANTHROPIC_BASE_URL` | 覆盖 API 端点 |
| `DEEPCODE_DEBUG` | 打开 hook 调试输出（走 stderr） |

## 架构一句话

引擎在每个调用点抛出一个事件，所有插件（**包括六个内建工具**）把自己的 hook 注册成中间件，
按 tier 权威序 `prepend > user > append > builtin > core` 串成一条链。一个 hook 可以
应答 / 改写 / 拒绝 / 委托下层。

`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` 走的接口与未来的第三方插件**完全相同** ——
内核里没有一张硬编码的工具表。

## 安全

MVP 的安全底线是 `tool.check` 事件上的最小确认：

- `Read` / `Glob` / `Grep` 只读，不询问。
- `Write` / `Edit` / `Bash` 打印预览后等一行 `y/N`。
- 非 TTY（管道、CI）环境下**默认拒绝**。
- `tool.check` 走到链尾无人应答 = **deny**，不是 allow。

完整的权限系统（settings 来源优先级、allow/ask/deny 规则、`sec-default` 守门器）是下一个阶段的事。

## 开发

```bash
pnpm typecheck   # 类型检查（任务级验收就靠它）
pnpm test        # 测试
pnpm lint        # 依赖边界检查
```

## 设计文档

- 设计：[`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`](docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md)
- 实施计划：[`docs/superpowers/plans/2026-10-11-deepcode-mvp.md`](docs/superpowers/plans/2026-10-11-deepcode-mvp.md)
- 架构参考：`docs/claude-code-架构分析/`
```

- [ ] **Step 2: 一次跑完所有检查**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 三者全绿，无输出错误。

- [ ] **Step 3: 确认边界规则真的会失败**

临时往 `src/contract/tier.ts` 顶部加一行：

```ts
import { Registry } from '../core/registry';
```

然后：

```bash
pnpm lint
```

Expected: **失败**，输出里提到 `contract` 不允许 import `core/`。删掉那一行，再跑一次确认恢复通过。

（必须用相对路径 —— 脚本只查相对导入。`node:` 内置模块不算越界，拿它试是试不出来的。）

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README 与 MVP 收尾"
```

> **实施记录**：C4 三项都实际跑过。
>
> - **门禁**：`pnpm typecheck && pnpm lint && pnpm test` 全绿 —— 5 个测试文件 / **37 个测试**
>   （dispatch 15、safety 7、e2e 2、cli 4、tools 9）。
> - **边界脚本确实会失败**（不是只贴一份通过的日志）：往 `src/contract/tier.ts` 顶部加
>   `import { Registry } from '../core/registry';` 后 `pnpm lint` 退出码 1，输出
>   `✗ contract\tier.ts: 不允许 import core/（只允许 无）`；删掉后恢复通过。
> - **README 与计划里那版草稿有实质差异**，都是实测出来的，不是改文风：
>   1. 草稿只写了 `pnpm dev`，但那条路会把**本仓库**当工作目录。README 拆成两条：
>      在本仓库里用 `pnpm dev`，要在别的项目里干活就用 `node /path/to/DeepCode/bin/deepcode.mjs`，
>      并明确警告别写 `pnpm --dir … dev` —— pnpm 会把脚本 cwd 设成包目录，
>      于是一句话下去，模型在错的仓库里改文件。
>   2. 补了键位表，其中 `Ctrl-C` 是**三态**的（掐断本回合 / 空闲时退出 / 同回合连按两次强制退出），
>      配 `cli/turns.ts` 那套 50ms 去重逻辑。
>   3. 安全清单补了三条实现里真实存在、草稿没写的：不认识的工具拒绝而非放行；
>      `Write` 覆盖前必须先 `Read` 过；以及**有意没有** `--yes`（非交互环境没人能按 `y`，
>      那就写不了文件 —— 谁加自动放行开关谁就是在开倒车）。
>   4. 新增"已知限制"，只写验证过的：无会话落盘、Windows 下 shell 孙进程成孤儿、
>      纯文本渲染、39 个事件实现 12 个。
> - **收尾前做了一轮独立评审**，查出四处"门禁全绿、跑起来是坏的"缺陷，已修并各配一条回归测试
>   （`9008f4d` + `test/safety.test.ts`）：确认提示没有出口（Ctrl-D/Ctrl-C 时整个会话挂死）、
>   中断后命令照跑完（已 abort 的 signal 不补发事件）、`Edit` 在校验与写入之间文件被改过时静默写坏、
>   被掐断的 turn 还退避重试一秒并误报"provider 出错"。
>   每条测试都做过**反向验证**：把修复改回去，测试必须失败。其中一条最初写成"看命令有没有留下副作用"，
>   改回修复后照样通过 —— 那是在跟 `kill` 赛跑，不是断言合同；改成断言 `spawn` 未被调用才算数。
> - **第二轮独立评审**（覆盖内核与 provider —— 第一轮只审了 CLI/安全面）确认四道防火墙都成立：
>   `tool.check` 链尾仍是 deny、非 TTY 仍拒绝、没有任何 `--yes`、`Write` 仍要求先 Read、
>   只读工具仍不询问；链序、`next(e)`、超时隔离、无未处理拒绝也都正常。
>   但查出五处运行时缺陷，已修（`e2784f5`）：SSE 错误帧被静默略过（一次过载变成"成功的空 turn"，
>   用户的问题凭空消失）、Bash 非零退出不是 `is_error`（模型跑挂测试却收到"成功"）、
>   Grep/Glob 跳过所有点开头的条目（`.env`/`.github/**` 搜不到，返回"没有匹配"）、
>   Edit 顺手打 read: 标记给 Write 开了后门、Edit 改不了 CRLF 文件的多行。
>   补了 `test/provider.test.ts`（SSE 解析此前零覆盖，而它是唯一只有真 API 才走得到的代码），
>   并把七处修复逐条改回去验证 —— 5 个新测试全数失败，其余 40 个照过。
> - 默认模型 id 由 `claude-sonnet-4-5` 改为 `claude-sonnet-5-5`：前者恐已退役，开箱即 404，
>   与代码对不对无关。
> - Task 20（C3 真机端到端）需要真实 `ANTHROPIC_API_KEY` 与 TTY，**未由我执行**，命令已备好留给你跑。

> **C4 出口**：MVP 完成。下一个动作是写 P1 的计划（会话落盘 + `--resume` + Ink TUI + OpenAI 兼容适配器），见设计文档 §9.2。

---

## 追加需求 · 配置文件（MVP 之后）

**需求**：API key / 模型等不应每次开终端都 `export` 一遍。**决定**：加配置文件，
用户级 + 项目级两层，**允许把 key 写进配置文件**。

- **优先级**：环境变量 > 项目级 `<root>/.deepcode/config.json` > 用户级 `<home>/.deepcode/config.json`，
  逐字段合并（不是整体替换）。
- **字段**：`apiKey` / `model` / `baseUrl` / `debug`，全部可省略。
- **新增**：`src/cli/config.ts`（`loadConfig({ home, root, warn?, readText? })`）、
  `test/config.test.ts`（8 条）。改 `src/cli/main.ts`（解析顺序 + 把 `config.debug` 桥进 `env`）。
- **坏输入不许静默失效**：文件不存在 → 安静跳过（这是常态）；存在但读不动 / JSON 非法 /
  顶层非对象 / 字段类型不对 → **抛**，带上路径与实际值；字段名拼错 → **点名**，列出认识的字段。
  只有"生效"和"大声报错"两种结局。理由见设计文档 §6.2。
- **项目级放 `apiKey` 会额外警告一次**（这文件很容易被一起提交），但按用户决定不禁止。
  本仓库 `.gitignore` 已有 `.deepcode/`。
- **与 `settings` 无关**：`config.ts` 不进事件、不进 `$`，任何 hook 都读不到，所以
  "插件放宽策略"那条路依然关着（设计文档 §3.5）。
- **顺带修掉一处"文档写了、代码没做"**：`DEEPCODE_DEBUG` 此前只是变量名，
  现在真的在 stderr 打调试轨迹（每次 dispatch 一行，说明被谁应答、谁被跳过），
  流式事件 `turn.step` 不打（否则刷屏）。`test/harness.ts` 随之多出 `debugLines`。

> **实施记录**（实测，非设计意图）：
>
> - **门禁**：`pnpm typecheck && pnpm lint && pnpm test` 全绿 —— **7 个测试文件 / 57 个测试**
>   （dispatch 19、tools 12、config 8、safety 7、provider 5、cli 4、e2e 2）。
> - **端到端真跑过**（在 `C:\Users\86178\deepcode-cfgtest` 用真配置文件起进程，非只是单测）：
>   ① key 从文件读到并真的发到了 API（拿假 key 换回 401，说明用的是文件里那个）；
>   ② `debug: true` 真的打出轨迹行 `[debug] tool.describe [1ms] tool-read@builtin`，
>      且 `turn.step` 正确缺席；
>   ③ 失败回合退出码 1；
>   ④ 三条错误路径：缺 key → 三选一提示 + 退出码 1；字段拼错 → 点名后**继续跑**；
>      JSON 非法 → `启动失败：… 不是合法 JSON` + 退出码 1。
> - **一处观感缺陷**：`main().catch` 原本用 `String(error)`，输出成了
>   `启动失败：Error: 用户级配置文件 …`。改成取 `error.message`，复跑确认为
>   `启动失败：用户级配置文件 … 不是合法 JSON：SyntaxError: …`。
> - **顺带纠正文档里的假话**：设计文档原写"MVP 的配置只来自 CLI flag 与环境变量，不读任何设置文件"，
>   加了 `config.ts` 之后这句不再成立，已改成区分"启动配置"与"settings"（§3.5）。

### 追加需求 · 认兼容端点的那组变量名

**需求**：用户在 Claude Code 里配的是 DeepSeek 的 Anthropic 兼容端点，环境里已有
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`，但 DeepCode 只认
`ANTHROPIC_API_KEY` / `DEEPCODE_MODEL` —— 开箱即"缺少 API key"。

- **改**：`apiKey` 与 `model` 各认两个名字（`ANTHROPIC_API_KEY` ?? `ANTHROPIC_AUTH_TOKEN`；
  `DEEPCODE_MODEL` ?? `ANTHROPIC_MODEL`），两套都给时官方那套赢。
- **抽函数**：把优先级规则从 `main.ts` 提到 `config.ts` 的 **`resolveSettings(env, config)`** ——
  "谁盖谁"正是最该被钉住的部分，而 `main.ts` 是个一跑就建 readline、连网的脚本，测不动。
  新增 5 条测试（含"debug 只能是或、环境变量关不掉配置文件里的 true"这条反直觉语义）。
- **认证头不用动**：实测 `x-api-key` 与 `Authorization: Bearer` DeepSeek 两边都收。
- **真机验证**（不是只跑单测）：① 带环境变量的完整回合跑通 —— 读文件、求和得 50；
  ② 把六个环境变量全部 `env -u` 掉、只靠 `~/.deepcode/config.json`，再跑一次仍跑通（最大值 25）。
- **一次顺带的安全观察**：模型自己多调了一次 `Bash`（`ls -la; find . -name numbers.txt`），
  调试轨迹显示 `tool.check → confirm@builtin` 之后**没有** `tool.call` —— 非 TTY 下它被拒了，
  而回合照常结束。fail-closed 在真模型面前也成立。

### 追加需求 · 顶掉配置文件时要出声，以及 --help / --version

**来由**：用户在自己终端里跑 `deepcode` 一律 401。查到底发现是 `HKCU\Environment` 里残留着一组
指向 `www.fucheers.top` 中转站的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，
**静默顶掉**了配置文件，请求压根没发到 DeepSeek 官方（`"type":"new_api_error"` 是中转网关的格式，
官方 API 给的是 `authentication_error` —— 这条判据也写进 README 了）。
环境变量本身在用户同意下已清掉，但**"静默顶掉"这件事必须从代码上消掉**。

- **改**：`resolveSettings(env, config, warn?)` 多收一个告警出口。**只在两处值不同时告警** ——
  同一把 key 既在环境里又在配置里是常态，每次都吼只会训练用户忽略它。apiKey 被顶掉时
  只说"两处内容不一致"，绝不打印 key。顺带把空字符串当"没给"：`setx VAR ""` 留下的是空值而非删除，
  照收的话会凭空顶掉配置文件，比原故障还难查。
- **改**：`argv` 里认 `--help` / `-h` 与 `--version` / `-V`（`-v` 留给 verbose），其余照旧拼成提示词。
  开关在**读配置、要 key 之前**处理 —— 没有 key 的机器上 `deepcode --help` 也该给用法。
  新增 `src/cli/args.ts`：`parseArgs` / `readVersion`（版本号从 package.json 现读，不写两份）/ `HELP_TEXT`。
- **测试**：13 条新增（配置告警 5、参数 6、真跑 bin 的集成 2）。
- **反向验证**：把告警调用去掉、把两个开关短路成永不命中，跑一遍 —— **6 条按预期变红**
  （含那个真跑 `bin/deepcode.mjs --help` 的集成测试），还原后 73 全绿。
  那条集成测试还把 `HOME`/`USERPROFILE` 指到不存在的目录，保证开关万一又坏了，
  它是以"缺少 API key"非零退出，而**不会替用户真花一次 API 调用**。
- **真机验过**：`deepcode --version` → `0.0.1`；`deepcode --help` → 用法；
  `DEEPCODE_MODEL=环境变量里的模型 deepcode "..."` → 启动即打出
  `环境变量 DEEPCODE_MODEL 顶掉了配置文件里的 model（环境给的是 …，配置文件里是 deepseek-v4-flash）`。

---

## 自查记录

| 检查项 | 结果 |
|---|---|
| **Spec 覆盖** | §2 分层 → Task 1 边界脚本；§3 契约 → Task 2–5；§4.1 dispatch → Task 7；§4.2 loop → Task 16；§4.3 六工具 → Task 11–14；§5 错误处理 → Task 6/7/10/11/16；§6 验证 → Task 9/17/20/21 四个检查点；§7 目录 → 文件结构总览；§8 验收 → Task 20 |
| **Spec 未覆盖项** | §3.6 的"事件名快照测试"被 §6.3 明确删掉了（事件目录本身写在一个文件里，肉眼可见），保持一致；§9 各阶段计划本就是后续文档，不在本计划范围内 |
| **占位符扫描** | 无 TBD/TODO，无"类似 Task N"。初稿的 Task 19 曾在 Step 2 放一版含 `as never` 的错误代码、Step 3 再改掉 —— 那是幻觉式的教学，已删；现在 Step 2 就是最终版本，类型检查一次过 |
| **类型一致性** | `HOOK_BUDGET.ms = 10_000`（Task 2 定义 → Task 9 断言）；`DeepReadonly` 定义在 Task 5、被 Task 5 的 `HookFor` 使用；`createCoreNouns(deps, registry)` 的签名在 Task 8 定型后**不再变动**；`CoreNounsDeps.signal` 在 Task 16 Step 2 加入，因 `CreateEngineDeps extends CoreNounsDeps` 而自动流向名词；`SessionNoun.signal()` 在 Task 16 Step 2 加入并被 `bash.ts` 使用；`scriptedProvider` 在 Task 9 定义、Task 17 使用 |
| **自查修正** | 初稿里 `CoreNounsDeps` 带 `registry` 字段、Task 19 再把它摘掉 —— 那是一次跨任务的签名变更，已就地修正：`registry` 从一开始就是 `createCoreNouns` 的第二个参数 |
