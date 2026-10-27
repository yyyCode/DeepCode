# DeepCode P17 浏览器界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DeepCode 加一个本地网页界面：浏览器里聊天、看工具卡片、回答权限确认、中断。

**Architecture:** 把 `main.ts` 里与终端无关的装配抽成 `createSession()`；web 侧提供
`Renderer + UiSink` 的网页实现与一个事件观察插件；`node:http` 起 SSE + POST 的本地服务；
前端是三个原生静态文件。引擎、权限链、工具链一行不改。

**Tech Stack:** TypeScript、Node ≥ 20（`node:http` / `node:crypto` / `node:child_process`）、
vitest。运行时依赖保持 0。

**Spec:** `docs/superpowers/specs/2026-10-27-deepcode-p17-web-ui-design.md`

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/cli/session.ts` | 从 `main.ts` 抽出的共享装配；`submit` / `runCommand` / `close` |
| `src/cli/turns.ts` | 新增 `interrupt(): boolean` |
| `src/cli/repl.ts` | 可选 `submit` 依赖，复用会话的 turn 生命周期 |
| `src/cli/main.ts` | 改用 `createSession`；终端特有部分留下 |
| `src/cli/args.ts` | `web` 子命令与 `--port=` / `--no-open` |
| `src/cli/web/bus.ts` | 带 seq 与回放缓冲的事件总线 |
| `src/cli/web/ui.ts` | `Renderer + UiSink`：事件化输出、挂起的 ask |
| `src/cli/web/events.ts` | 引擎事件 → 工具卡片 / turn / busy |
| `src/cli/web/server.ts` | HTTP 路由、鉴权、SSE、静态资源 |
| `src/cli/web/command.ts` | `deepcode web` 的启动、开浏览器、SIGINT、关闭 |
| `src/cli/web/static/*` | `index.html` / `app.js` / `style.css` |
| `test/web-*.test.ts` | 参数、sink、事件、HTTP |
| `test/cli-web.test.ts` | 真起服务的 bin e2e |

---

### Task 1: 抽取 `createSession`

**Files:**
- Create: `src/cli/session.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/turns.ts`
- Modify: `src/cli/repl.ts`
- Test: 既有 `test/cli.test.ts` / `test/e2e.test.ts` / `test/prompt-menu.test.ts`（不改，必须全绿）

- [ ] **Step 1: 跑基线**

Run: `pnpm test`
Expected: 91 files / 1438 passed / 1 skipped。

- [ ] **Step 2: `turns.interrupt()`**

`src/cli/turns.ts` 的类型与实现加一条：

```ts
export type TurnSignals = {
  begin(): AbortSignal;
  end(): void;
  current(): AbortSignal;
  /** 忙且没中断 → abort 并返回 true；空闲 / 已中断 → false（不退出进程）。 */
  interrupt(): boolean;
  onSigint(): void;
};

// 实现里
interrupt: () => {
  if (!busy || live.signal.aborted) return false;
  live.abort();
  return true;
},
onSigint: () => {
  const now = Date.now();
  if (now - lastSigint < 50) return;
  lastSigint = now;
  if (!interrupt()) process.exit(130);
},
```

- [ ] **Step 3: 新建 `src/cli/session.ts`**

从 `main.ts` 原样搬入第 100 行（`loadConfig`）到第 500 行（`commandDescriber` 赋值）之间
与终端无关的部分。公开接口：

```ts
import type { Message } from '../contract/model-provider';
import type { TurnReason } from '../contract/turn';
import type { EngineInterface } from '../contract/engine';
import type { DispatchFn } from '../core/dispatch';
import type { UiSink } from '../core/nouns/ui';
import type { Renderer } from './render';
import type { Palette } from './ansi';
import type { ResumeTarget } from './args';
import type { CliPluginBundle } from './plugins';
import type { TurnSignals } from './turns';
import type { Transcript } from './transcript';
import type { McpRuntime } from './mcp-runtime';

export type SessionInfo = {
  readonly model: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
};

export type Session = {
  readonly $: EngineInterface;
  readonly dispatch: DispatchFn;
  readonly messages: Message[];
  readonly turns: TurnSignals;
  readonly bundle: CliPluginBundle;
  readonly info: SessionInfo;
  submit(text: string): Promise<TurnReason>;
  runCommand(name: string, args: readonly string[]): Promise<boolean>;
  close(): Promise<void>;
};

export type SessionDeps = {
  readonly home: string;
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly settingsPath: string | undefined;
  readonly resume: ResumeTarget;
  readonly ui: UiSink;
  readonly render: Renderer;
  readonly palette?: Palette;
};

export class SessionStartError extends Error {
  readonly exitCode = 1;
}
```

实现要点（每条都对应搬运前的一行，别重新发明）：

- 缺 key → `throw new SessionStartError(<今天那三段文本>)`。
- `--resume` 找不到 → `throw new SessionStartError(await describeResumeFailure(...))`。
- `messages`、`changes`、`turns` 在 `createSession` 里建；`changes` 交给 `cliPlugins`。
- `warnLine = (line) => render.notice(line)`；所有原来的 `render.notice` 改写保持原样。
- `submit` 承担 REPL 今天那段（`prompt.submit` → `withContext` → `turns.begin` →
  `builder.build` → `runTurn` → `finally { turns.end(); render.newline(); persist; afterTurn }`），
  返回 `runTurn` 的收场理由；`submitted.handled` 时返回 `'answer'` 且不跑 turn。
- `runCommand` 就是 `dispatch('command.run', …)`，返回 `name === 'exit'`。
- `close()`：`dispatch('session.end', { reason: 'exit' })` → `await mcp.close()`；幂等。
- `process.once('exit', () => void mcp.close())` 仍然要在里面注册。
- `submit` 里带上 `onUsage`（compactor.note）、`onTools`（lastTools）、
  `onProjection`（lastProjection）、`contextWindow` —— `/context` 的闭包读的就是它们。

- [ ] **Step 4: `main.ts` 改接**

- 删掉搬走的 import；加 `import { createSession, SessionStartError } from './session';`
- readline / 提示 sink 建好之后：

```ts
let session;
try {
  session = await createSession({
    home, root, env: process.env, settingsPath: action.settings,
    resume: action.resume,
    ui: prompt, render, palette,
  });
} catch (error) {
  if (!(error instanceof SessionStartError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode;
  prompt.close();
  return;
}
const { $, dispatch, messages, turns, bundle } = session;
```

- 一次性模式：原来的 `dispatch`/`withContext`/`turns.begin`/`builder.build`/`runTurn`
  那一整段换成 `const reason = await session.submit(oneShot);`。
- REPL：`startRepl({ ...原参数, submit: (text) => session.submit(text) })`；
  其余字段保持不变（它们现在由 session 提供）。
- 退出：`await history.save(); render.settle(exitLines(...)); await session.close(); prompt.close();`
  （删掉原来那行 `dispatch('session.end')` 与 `mcp.close()`）。
- 启动时需要 `session.info.model / provider / baseUrl / sessionId / transcriptPath`
  的地方改用 `session.info`。

- [ ] **Step 5: `repl.ts` 接受外部 `submit`**

`ReplDeps` 加：

```ts
/**
 * 外部的一轮执行（P17）。省略 = 沿用文件内那一份 —— 既有测试一个字不改。
 * 给 `createSession.submit` 之后，turn 的 begin/end 与落盘都由它负责。
 */
readonly submit?: (text: string) => Promise<unknown>;
```

文件内原来的 `submit` 改名 `localSubmit`，再加：

```ts
const submit = async (text: string): Promise<void> => {
  if (deps.submit !== undefined) {
    await deps.submit(text);
    return;
  }
  await localSubmit(text);
};
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 类型通过；全部测试绿（文件数不变）。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "refactor(cli): 抽出 createSession，终端与网页共用装配"
```

---

### Task 2: 网页 UI sink 与事件插件

**Files:**
- Create: `src/cli/web/bus.ts`
- Create: `src/cli/web/ui.ts`
- Create: `src/cli/web/events.ts`
- Test: `test/web-ui.test.ts`、`test/web-events.test.ts`

- [ ] **Step 1: 失败测试（先写）**

`test/web-ui.test.ts` 至少覆盖：

```ts
it('ask 发一条事件并挂起，answer 落值并再发 ask.resolved', async () => { … });
it('没人回答时 5 分钟回 fallback（用注入的 timeoutMs 缩短）', async () => { … });
it('close() 把挂起的 ask 全部按 fallback 收场', async () => { … });
it('print/notice/delta 分别映射成 log info / log warn / delta', async () => { … });
it('未知 id 的 answer 返回 false，不误伤别的 ask', async () => { … });
```

`test/web-events.test.ts` 用 `createHarness` + `seat` 覆盖：`tool.call` → `tool.start` /
`tool.end`；`tool.result` 的 output 截断到 20 000；`tool.check` 拒绝 → `tool.denied`；
`ask` 判定时记录上下文；`turn.start/complete` → `turn` 与 `busy`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/web-ui.test.ts test/web-events.test.ts`
Expected: 模块不存在，FAIL。

- [ ] **Step 3: `bus.ts`**

```ts
export type WebEvent = { readonly seq: number } & Record<string, unknown>;

export type WebBus = {
  emit(event: Record<string, unknown>): void;
  subscribe(listener: (event: WebEvent) => void): () => void;
  replay(): readonly WebEvent[];
  readonly truncated: boolean;
};

export function createWebBus(limit = 2_000): WebBus {
  let seq = 0;
  let truncated = false;
  const buffer: WebEvent[] = [];
  const listeners = new Set<(event: WebEvent) => void>();
  return {
    emit(event) {
      const stamped = { seq: ++seq, ...event };
      buffer.push(stamped);
      if (buffer.length > limit) {
        buffer.shift();
        truncated = true;
      }
      for (const listener of listeners) {
        try { listener(stamped); } catch { /* 一个连接坏了不该拖垮别的 */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replay: () => buffer,
    get truncated() { return truncated; },
  };
}
```

- [ ] **Step 4: `ui.ts`**

```ts
export type WebUi = Renderer & {
  answer(id: string, value: string): boolean;
  setAskContext(context: { tool: string; input: unknown; toolUseId: string } | undefined): void;
  close(): void;
};

export function createWebUi(deps: {
  readonly emit: (event: Record<string, unknown>) => void;
  readonly askTimeoutMs?: number;
  readonly now?: () => number;
}): WebUi;
```

实现：

- `print(line)` → `emit({type:'log', level:'info', text:line})`
- `notice(line)` → `emit({type:'log', level:'warn', text:line})`
- `delta(text)` → `emit({type:'delta', text})`
- `newline` / `thinking` / `activity` / `settle` → 空实现
- `ask(question, options)`：
  - 生成 id（`a1`、`a2`…），`choices = options?.choices ?? []`，`fallback = options?.fallback ?? 'n'`；
  - 取出并清空 `askContext`，附在事件上；
  - `emit({type:'ask', id, question, choices, fallback, ...ctx})`；
  - 定时器（默认 300 000ms，测试注入 20ms）到点 → 以 `fallback` 收场，
    `emit({type:'ask.resolved', id, value:fallback, reason:'timeout'})`；
  - `answer(id,value)`：不在表里 → `false`；在表里但 value 不在 choices 里（choices 非空时）
    → `false`；否则收场并 `emit(..., reason:'answer')`，返回 `true`。
- `close()`：所有挂起的 ask 以 `fallback` 收场（`reason:'closed'`）。
- turn 被中断时 `ask` 还要能收场：`createWebUi` 暴露 `abortPending()`，由会话层在
  `interrupt()` 之后调用；简化做法是 `setAskContext` 旁边多一个 `abortAll(reason)`，
  `runWebCommand` 在停止按钮处理里调。

- [ ] **Step 5: `events.ts`**

```ts
export function createWebEventsPlugin(deps: {
  readonly emit: (event: Record<string, unknown>) => void;
  readonly onAskContext: (context: { tool: string; input: unknown; toolUseId: string } ) => void;
}): Plugin;
```

- `tool.check`：`const check = await next(e);` → `deny` 发 `tool.denied`；
  `ask` 调 `onAskContext({tool:e.tool, input:e.input, toolUseId:e.toolUseId})`；返回 `check`。
- `tool.call`：记 `startedAt` 与 `emit({type:'tool.start', ...})`；`next` 返回 `deny`
  → `tool.end {status:'denied'}`；抛错 → `tool.end {status:'error'}` 后重新抛。
- `tool.result`：`emit({type:'tool.end', toolUseId, status: e.ok?'ok':'error',
  output: cap(e.output), durationMs, truncated })`。
- `turn.start` / `turn.complete` → `turn` 事件；统一发 `busy`。
- `tool.consent` → `consent {tool, granted}`。

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run test/web-ui.test.ts test/web-events.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(web): 事件总线、网页 UI sink 与工具卡片插件"
```

---

### Task 3: HTTP 服务

**Files:**
- Create: `src/cli/web/server.ts`
- Test: `test/web-server.test.ts`

- [ ] **Step 1: 失败测试**

用假 host：

```ts
type FakeHost = {
  info: { model: 'stub', provider: 'stub', cwd: '/tmp/x', sessionId: 's1' };
  isBusy(): boolean;
  submit(text: string): Promise<void>;
  runCommand(name: string, args: string[]): Promise<boolean>;
  interrupt(): void;
  close(): Promise<void>;
};
```

用例：token 缺失/错误 401；`Host: evil.test` 403；`Origin` 不符 403；静态白名单
（`/app.js` 200、`/../package.json` 404）；`POST /api/prompt` 202 且触发 submit；
忙 409；空文本 400；`/api/answer` 未知 id 409；`/api/interrupt` 调 host；
SSE 先收到回放再收到实时事件。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/web-server.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
export type WebHost = {
  readonly info: SessionInfo;
  isBusy(): boolean;
  submit(text: string): Promise<void>;
  runCommand(name: string, args: readonly string[]): Promise<boolean>;
  interrupt(): void;
  close(): Promise<void>;
};

export type WebServer = {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
};

export async function createWebServer(deps: {
  readonly host: WebHost;
  readonly bus: WebBus;
  readonly answer: (id: string, value: string) => boolean;
  readonly staticDir: string;          // 测试可注入临时目录
  readonly token?: string;             // 测试可钉
  readonly port?: number;              // 0 = 随机
  readonly hostname?: string;          // 默认 127.0.0.1
}): Promise<WebServer>;
```

- 路由严格按 spec §5.1；`GET /` 也校验 token。
- Host 校验：`host` 头必须等于 `127.0.0.1:<port>` 或 `localhost:<port>`（大小写不敏感）；
  POST 的 `Origin` 若存在必须是这两个来源之一。
- SSE：`Content-Type: text/event-stream`、`Cache-Control: no-store`、`Connection: keep-alive`；
  先写 `event: hello`，再回放，再订阅。每个事件写 `id: <seq>\ndata: <json>\n\n`。
  连接关闭时退订。每 15 秒写一行 `: ping` 防代理超时（本机其实用不上，但无害）。
- 静态：只认 `index.html` / `app.js` / `style.css` 三个名字，读 `join(staticDir, name)`；
  不拼用户路径。HTML/JS/CSS 的 MIME 固定表。
- token 比较：长度不同直接 false，长度相同用 `timingSafeEqual`。
- `close()`：`server.closeAllConnections?.()` + `server.close()`，等待回调。

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run test/web-server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(web): 本地 HTTP 服务与 SSE 协议"
```

---

### Task 4: 子命令与接线

**Files:**
- Modify: `src/cli/args.ts`
- Create: `src/cli/web/command.ts`
- Modify: `src/cli/main.ts`
- Test: `test/web-args.test.ts`、`test/cli-web.test.ts`

- [ ] **Step 1: 失败测试**

`test/web-args.test.ts`：

```ts
expect(parseArgs(['web'])).toEqual({ kind: 'web', port: undefined, open: true });
expect(parseArgs(['web', '--port=3080', '--no-open']))
  .toEqual({ kind: 'web', port: 3080, open: false });
expect(parseArgs(['web', '--port=abc']).kind).toBe('prompt');
expect(parseArgs(['web', '前端怎么写']).kind).toBe('prompt');
```

`test/cli-web.test.ts`：临时 home 写 `config.json`（假 key），spawn
`node node_modules/tsx/dist/cli.mjs src/cli/main.ts web --no-open`，从 stdout 读
`http://127.0.0.1:<port>/?t=<token>`，`fetch` 首页 200 且含 `<title>DeepCode</title>`，
再 `child.kill()`；超时 20s。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/web-args.test.ts test/cli-web.test.ts`
Expected: FAIL。

- [ ] **Step 3: `args.ts`**

- `StartupAction` 加 `{ kind: 'web'; port: number | undefined; open: boolean }`。
- `parseArgs` 在 plugin/config 之后调用 `parseWebCommand(argv)`：
  - 第一个非开关 token 必须是 `web`；
  - 其余 token 只允许 `--no-open` 与 `--port=<1..65535>`；
  - 出现别的 token（包括 `--port` 裸写、非法数字）→ `undefined`，回落提示词。

- [ ] **Step 4: `web/command.ts`**

```ts
export async function runWebCommand(deps: {
  readonly home: string;
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly settingsPath: string | undefined;
  readonly resume: ResumeTarget;
  readonly port: number | undefined;
  readonly open: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}): Promise<number>;
```

流程：

1. `createWebBus()`；
2. `createWebUi({emit: bus.emit})`；
3. `createWebEventsPlugin({emit: bus.emit, onAskContext: ui.setAskContext})`；
4. `createSession({...deps, ui, render: ui, palette: createPalette(false)})`，
   并把事件插件塞进 `cliPlugins` 的 `mcp` 前面？——**不**：`createSession` 需要额外收一个
   `extraPlugins`（插在 `confirm` 之前、第一方名单内）。在 `SessionDeps` 加
   `readonly extraPlugins?: readonly Plugin[]`，`createSession` 把它们拼进传给 `cliPlugins`
   的 `mcp` 之前（同一处顺序约束）。`onAskContext` 走 `ui.setAskContext` 即可，
   不需要额外通道。
5. `createWebServer({host, bus, answer: ui.answer, staticDir})`；
6. 打印 `DeepCode web: <url>` 与 `Ctrl-C 停止服务`；`open` 时调 `openBrowser(url)`；
7. `SIGINT`：`if (!session.turns.interrupt()) await shutdown(); else ui.abortPending('abort')`；
   第二次 Ctrl-C 强制 `process.exit(130)`；
8. `shutdown()`：`await server.close(); await session.close(); ui.close();`，返回 0；
9. `host.runCommand` 里 `/exit` 触发 `shutdown`。

`createSession` 里补：`render` 与 `ui` 传进 `createEngine`（`ui: {print, notice, ask}` 的
接口就是 `UiSink`，直接传 `ui`）；`cliPlugins` 的 `render` 传 `render`（网页实现）。

- [ ] **Step 5: `main.ts`**

`action.kind === 'web'` 在 plugin/config 分支之后、读配置之前处理：

```ts
if (action.kind === 'web') {
  process.exitCode = await runWebCommand({
    home, root, env: process.env,
    settingsPath: undefined,             // web 暂不认 --settings=
    resume: { kind: 'latest' },
    port: action.port, open: action.open,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  return;
}
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm vitest run test/web-args.test.ts test/cli-web.test.ts`
Expected: PASS。然后 `pnpm test` 全绿。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(web): deepcode web 子命令与 CLI 接线"
```

---

### Task 5: 前端

**Files:**
- Create: `src/cli/web/static/index.html`
- Create: `src/cli/web/static/style.css`
- Create: `src/cli/web/static/app.js`
- Test: `test/web-server.test.ts` 增一条「首页引用 app.js/style.css」

- [ ] **Step 1: `index.html`**

结构：`<header>`（品牌 · cwd · model · 状态点）→ `<main id="timeline">` →
`<form id="composer">`（textarea + 发送/停止按钮）。`<script type="module" src="/app.js">`。
CSP 由服务端响应头给，不在 meta 里重复。

- [ ] **Step 2: `style.css`**

单列、最大宽度 860px、等宽字体给代码；CSS 变量定义深浅色两套（`prefers-color-scheme`）；
卡片、系统行、权限按钮、状态点各一组；窄屏（< 640px）撤掉边距。

- [ ] **Step 3: `app.js`**

要点：

- token 从 `new URLSearchParams(location.search).get('t')`；没有就显示「地址里缺 token」。
- `new EventSource('/events?t=' + token)`；按 `type` 分发：
  `delta` 追加到当前助手气泡；`tool.start` 建卡片；`tool.end` 更新卡片；
  `ask` 建权限卡；`ask.resolved` 落定；`log` 系统行；`turn` 状态；`busy` 按钮态。
- `post(path, body)` 带 `x-deepcode-token`；非 2xx 把 `error` 显示成系统行。
- markdown-lite：`escapeHtml` **先做**，再处理 ``` 围栏、`` ` ``、`**`、`#`、`- `、
  `[text](http…)`（只认 http/https）。不用 `innerHTML` 拼未转义内容。
- 发送：Enter（无 Shift）提交；发送中把按钮换成「停止」→ `/api/interrupt`。
- 自动贴底：仅在用户本就贴着底部时滚动。

- [ ] **Step 4: 手工验收**

Run: `pnpm dev web`（在任意项目目录），浏览器里：
提问 → 流式文本；触发一次 `Bash` → 权限卡 → 允许一次 → 工具卡出现结果；
再触发一次 → 拒绝 → 卡片显示拒绝；点停止；刷新页面时间线还在。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(web): 单栏聊天界面与工具/权限卡片"
```

---

### Task 6: 文档

**Files:**
- Modify: `README.md`（用法表加 `deepcode web`，一段最小说明）
- Modify: `site/已知限制.md`（新增「网页界面」一节 + 目录）
- Modify: `CHANGELOG.md`（总表 P17 行 + 正文）

- [ ] **Step 1: README**：`deepcode web [--port=<n>] [--no-open]`，一句「只绑本机，
  地址里带一次性 token」。
- [ ] **Step 2: 已知限制**：把 spec §11 七条逐条写进去（如实，不美化）。
- [ ] **Step 3: CHANGELOG**：范围、为什么、出口标准、偏差、验证计数。
- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "docs(web): 使用说明、限制与变更记录"
```
