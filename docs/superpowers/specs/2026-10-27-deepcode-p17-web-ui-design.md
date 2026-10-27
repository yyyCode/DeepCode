# DeepCode P17 浏览器界面

> 一句话：**给现有引擎加一个本地网页界面 —— 进程内跑同一套插件、权限与工具链，
> 浏览器只负责显示与回答。**
> 不另写 agent、不复制一份工具、不引任何运行时依赖；终端 REPL 的行为一个字不改。

---

## 1. 现状与决定

- 今天唯一的界面是终端：`main.ts` 建 readline、渲染器与 `startRepl`，引擎本身与终端无关。
- 界面与内核的分工已经成立：内核派事件（`turn.step` / `tool.call` / `tool.check` /
  `tool.result`），插件应答；`ui.ask` 问人，渲染器只负责长相（P6 设计 §2.3、§3.1）。
- 这意味着一件事：**换一个界面不需要动引擎**。需要的只是两样东西 —— 一个实现
  `UiSink`（`print` / `notice` / `ask`）的对象，和一个实现渲染接口的对象。
- `main.ts` 里「读配置 → 权限 → 插件 → MCP → 引擎 → 系统提示 → 压缩 → 落盘」整整一段
  是终端无关的，今天却写在 `main()` 里。这是本阶段唯一的结构性改动：把它抽出来共用。

**范围**：`deepcode web` 子命令、本地 HTTP + SSE、聊天流、工具卡片、权限确认、
中断、斜杠命令、事件回放、token 鉴权。终端 REPL 与一次性模式继续可用。

---

## 2. 明确不做

| 不做的项 | 理由 |
| --- | --- |
| 多会话侧栏 / 工作区切换 | 一个进程一个工作目录，与今天 CLI 的模型一致；多会话要先把「一个进程多个引擎」想清楚 |
| diff 视图 / 文件树 / 编辑器 | 又一个界面子系统。工具卡片已经给出 `+/−` 与结果正文 |
| WebSocket | SSE 只下行、POST 只上行，够用；WebSocket 要自己写心跳与重连 |
| HTTPS / 账号体系 | 只绑 `127.0.0.1` + 一次性 token；改造为远程服务是另一条产品线 |
| 文件上传 / 图片输入 | 模型适配层今天只收文本 |
| React / Vite / 任何前端依赖 | 仓库的徽章是「运行时依赖 0」，前端也不破例 |
| 浏览器自动化测试 | 不在仓库里引 Puppeteer；服务器协议全用 `fetch` 测，界面人工验一次 |
| 远程访问开关（`--host`） | 加它就是加一个把本机工具暴露到局域网的开关，与既有的安全方向相反 |

---

## 3. 形态与启动

```bash
deepcode web                 # 随机空闲端口，自动开浏览器
deepcode web --port=3080     # 指定端口
deepcode web --no-open       # 只打印地址（远程机器、容器里用）
```

- 工作目录就是启动 `deepcode web` 时的 cwd，与 CLI 一样；没有工作区选择器。
- 启动后打印一行：

  ```
  DeepCode web: http://127.0.0.1:51234/?t=<32 位 token>
  Ctrl-C 停止服务
  ```

- 端口默认 `0`（系统分配空闲端口）；`--port=<n>` 取 `1..65535`。
- `--no-open` 不调系统浏览器；调用失败也**不**让服务起不来（地址已经打印了）。
- 参数解析沿用 CLI 的回落纪律：第一个非开关 token 是 `web`，且**其余 token 全是认识的
  web 开关**时才进 web 模式；`deepcode web 前端怎么写` 仍是一句提示词
  （与 `plugin` / `config` 子命令同一条规则，`args.ts`）。

---

## 4. 架构

```
┌──────────────── 浏览器（原生 HTML/CSS/JS，无构建）────────────────┐
│  时间线 · 工具卡片 · 权限卡片 · 输入框 · 停止按钮                  │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ SSE  /events                   │ POST /api/{prompt,answer,interrupt}
┌───────────────┴───────────────────────────────▼──────────────────┐
│ node:http（零依赖）  token / Host / Origin 校验 · 静态资源 · 回放    │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ emit(webEvent)                 │ host.submit / answer / interrupt
┌───────────────┴───────────────────────────────▼──────────────────┐
│ createSession()  —— 从 main.ts 抽出的共享装配                     │
│  引擎 · 插件 · MCP · 权限 · 压缩 · 系统提示 · 转录落盘              │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ UiSink / Renderer              │ runTurn / dispatch
┌───────────────┴───────────────────────────────▼──────────────────┐
│ 现有内核：tool.check 链、确认器、events —— 一行不改                 │
└──────────────────────────────────────────────────────────────────┘
```

### 4.1 `createSession()` 抽取

新增 `src/cli/session.ts`。从 `main.ts` **原样搬入**、不改行为的部分：

1. 读连接配置与 key（`loadConfig` / `resolveSettings`）；
2. `resolvePolicy`、托管网关钉死；
3. `messages`、`changes`；
4. 转录接续 / 新建、`persist`；
5. 插件发现与装载、agent / skill 名册；
6. provider 适配器、`engineEnv`；
7. MCP 启动与兜底关闭；
8. 内建 mods 装载；
9. `cliPlugins` 装配；
10. `createEngine`、`session.start`；
11. 系统提示 builder、压缩器、五层上下文窗口；
12. 命令补全名册与 `command.describe` 的延迟取位置。

留 `main.ts` 的（终端特有）：readline / 行队列 / SIGINT 接线 / prompt sink /
历史文件 / banner / 一次性与 REPL 循环 / 退出摘要。

接口：

```ts
export type Session = {
  readonly $: EngineInterface;
  readonly dispatch: DispatchFn;
  readonly messages: Message[];           // REPL 与 /clear 共用的那个数组
  readonly turns: TurnSignals;
  readonly render: Renderer;
  readonly bundle: CliPluginBundle;       // tally / memory / changes
  readonly info: { model: string; provider: string; baseUrl?: string;
                   sessionId: string; cwd: string; transcriptPath?: string };
  /** 跑一轮。返回收场理由；`prompt.submit` 吃掉这一行时返回 'answer' 且不跑 turn。 */
  submit(text: string): Promise<TurnReason>;
  /** 跑一条 /命令。返回值 = 该不该退出（与 REPL 同义）。 */
  runCommand(name: string, args: readonly string[]): Promise<boolean>;
  /** session.end + MCP 关闭。幂等。 */
  close(): Promise<void>;
};

export type SessionDeps = {
  home: string; root: string; env: Record<string, string | undefined>;
  settingsPath?: string; resume: ResumeTarget;
  ui: UiSink; render: Renderer; palette?: Palette;
};

export class SessionStartError extends Error { readonly exitCode = 1 }
```

- 缺 key、`--resume` 找不到 → 抛 `SessionStartError`（消息沿用今天逐字的两段文本）。
  `main.ts` 接到后打印到 stderr、关 prompt、退出码 1 —— 与今天可观测行为一致。
- `submit` 内部承担今天 REPL `submit` 的全部职责（`prompt.submit`、拼上下文、
  `turns.begin/end`、`builder.build`、`runTurn`、`persist`、`afterTurn`、
  用量与投影回调）。REPL 增加一个可选的 `submit` 依赖：给了就用它，没给沿用自带的
  那一份 —— 既有的 REPL 测试一个字不改。
- `turns` 增加 `interrupt(): boolean`：忙且未中断 → abort 并返回 `true`；否则 `false`。
  `onSigint` 改为调用它，终端里"空闲 Ctrl-C = 退出"的行为不变；网页的停止按钮只调
  `interrupt()`，**永远不会**因为空闲点一下就把进程杀掉。

### 4.2 Web 侧的两个实现

**`src/cli/web/ui.ts` —— `createWebUi()`**：同时实现 `Renderer` 与 `UiSink`。

| 方法 | 行为 |
| --- | --- |
| `print` / `log` | 事件 `log {level:'info'}` |
| `notice` | 事件 `log {level:'warn'}` |
| `delta` | 事件 `delta {text}` |
| `ask` | 事件 `ask {id, question, choices, fallback, tool?, input?}`，返回挂起的 Promise |
| `newline` / `thinking` / `activity` / `settle` | no-op（网页用结构化事件，不画终端行） |

- `ask` 的五个收场路径：答题（`answer()`）、中断（turn abort）、`close()`（服务退出）、
  5 分钟超时、以及计划批准这类不带选项的 ask —— 除答题外一律用 `fallback`；
  没有 `fallback` 时回 `'n'`。**读不到答案 = 没同意**，与 CLI 同一条底线。
- 工具权限那一屏的上下文（工具名 / input / toolUseId）由事件插件在
  `tool.check` 返回 `ask` 时塞进来，`ask` 消费一次即清空；队列为空时就是一张普通问题卡。

**`src/cli/web/events.ts` —— `createWebEventsPlugin()`**：只观察，不裁决。

- `tool.check` 返回后：`deny` → `tool.denied`；`ask` → 记下上下文（供权限卡）。
- `tool.call` 前 → `tool.start`（记开始时间）；返回 deny → `tool.end {status:'denied'}`。
- `tool.result` → `tool.end {status: ok|error, output, durationMs}`；output 超过 20 000
  字符截断并标 `truncated`。
- `tool.consent` → `consent {tool, granted}`（界面把「总是允许」画出来）。
- `turn.start` / `turn.complete` → `turn` 事件与 `busy` 状态。

---

## 5. 传输协议

### 5.1 路由

| 方法与路径 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /` | `index.html` | token（查询参数 `?t=`） |
| `GET /app.js`、`GET /style.css` | 静态资源（白名单三个文件名） | 无 |
| `GET /events?t=` | SSE 下行 | token |
| `POST /api/prompt` | `{text}`；以 `/` 开头走命令，否则跑一轮 | token + Host/Origin |
| `POST /api/answer` | `{id, value}` | 同上 |
| `POST /api/interrupt` | 中断当前 turn | 同上 |

- 请求体上限 1 MiB；`Content-Type` 必须是 `application/json`。
- 忙时 `/api/prompt` 返 `409 {error}`；空文本 `400`。
- 未知 id 的答案、或不在选项里的值 → `409`。

### 5.2 SSE 事件

每条事件带自增 `seq`（同时作为 SSE `id`）：

```
hello      {model, provider, cwd, sessionId, busy, replayTruncated}
user       {text}
delta      {text}
log        {level: 'info'|'warn', text}
tool.start {toolUseId, tool, input}
tool.end   {toolUseId, status: 'ok'|'error'|'denied', output?, durationMs?, truncated?}
tool.denied{toolUseId, tool, rule}
ask        {id, question, choices, fallback, tool?, input?}
ask.resolved {id, value, reason: 'answer'|'timeout'|'closed'|'abort'}
consent    {tool, granted}
turn       {phase: 'start'|'end', index?, stopReason?, inputTokens?, outputTokens?}
busy       {busy}
```

- 服务端保留最近 2 000 条事件的回放缓冲；新连接先收 `hello`，再收缓冲，再收实时事件。
- 回放缓冲溢出时丢弃最旧的，`hello` 里带 `replayTruncated: true`，前端提示
  「更早的记录不在这一份里」（**不假装完整**）。
- 助手正文靠 `delta` 增量拼；刷新页面后从回放重建时间线（转录仍在磁盘上，长会话以它为准）。

### 5.3 命令

输入框里以 `/` 开头 → `session.runCommand`，输出走 `render.print/notice` → `log` 事件。
`/exit` 在命令跑完后关闭服务；`/clear` 就地清空消息数组（与终端同一条）。

---

## 6. 权限、中断与 fail-closed

- 工具权限的裁决链**一行不改**：`permissions` → 计划模式 → `confirm` → MCP 桥接
  → `ui.ask`。网页只是把 `ask` 画成卡片：三个按钮的值就是内核给的 `y` / `a` / `n`。
- 一次只跑一轮：忙时新提问 409。工具调用本身照旧串行 / 只读并发，与终端一致。
- 停止按钮 → `turns.interrupt()`；没有正在跑的 turn 时**什么都不做**。
- 服务退出（Ctrl-C 或 `/exit`）：挂起的 ask 全部以 `fallback` 收场，再 `session.close()`。
- 页面断开**不**立即判死：ask 继续挂着，刷新后能看到并回答；5 分钟没人答才按拒绝收场。

---

## 7. 前端

- 单栏：顶部状态条（DeepCode · cwd · model · 连接点）→ 时间线 → 输入区。
- 时间线元素：
  - 用户消息、助手文本（流式追加）；
  - 工具卡片：`工具名 + 参数摘要`，展开看完整 input / output，`+/−` 与耗时；
  - 权限卡片：问题、工具输入预览、三个按钮；
  - 系统行：notice / 命令输出，灰色；
  - 状态条：`思考中` / `等待确认` / `空闲`。
- 输入：Enter 发送、Shift+Enter 换行；发送中显示停止按钮；`/` 开头照常发送。
- 安全渲染：所有来自模型与工具的文字**先转义再匹配**极简 markdown（围栏代码块、
  行内代码、加粗、标题、列表、链接只允许 `http(s)`）。不引第三方 markdown 库。
- 深浅色跟随 `prefers-color-scheme`；窄屏单列自适应；不做移动端专门交互。
- 资源是 `src/cli/web/static/` 下的三个真文件，由 `new URL('./static/', import.meta.url)`
  定位；无构建步骤。

---

## 8. 安全

1. 只 `listen(port, '127.0.0.1')`；没有 `--host`。
2. 每次启动生成 32 位十六进制 token（`node:crypto`）；页面地址带 `?t=`，
   API 用 `x-deepcode-token` 头，SSE 用查询参数；比较用定长比较。
3. 每个请求校验 `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`} —— 挡住 DNS rebinding；
   POST 若带 `Origin`，必须是这两个来源之一。
4. 静态资源按**文件名白名单**直读，不拼用户路径 —— 没有目录穿越面。
5. 响应头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、
   `Referrer-Policy: no-referrer`；HTML 带一条最小 CSP（`default-src 'self'`，
   允许内联样式，不允许内联脚本 —— JS 全在 `app.js`）。
6. token 只活在打印出来的 URL 里，不写配置文件、不进转录。

---

## 9. 文件布局

```
src/cli/session.ts         createSession()：从 main.ts 抽出的共享装配 + submit/runCommand
src/cli/main.ts            改用 createSession；终端特有的东西留在这里
src/cli/args.ts            web 子命令与 --port= / --no-open
src/cli/turns.ts           TurnSignals.interrupt()
src/cli/web/command.ts     deepcode web 的启动、浏览器打开、SIGINT、关闭
src/cli/web/server.ts      node:http 路由、token/Host/Origin、SSE、回放、静态资源
src/cli/web/ui.ts          Renderer + UiSink：事件化输出与挂起的 ask
src/cli/web/events.ts      引擎事件 → 工具卡片 / turn / busy
src/cli/web/static/        index.html · app.js · style.css
test/web-*.test.ts         参数、UI sink、事件插件、HTTP 协议
test/cli-web.test.ts       真跑 bin：起服务、拿地址、取首页、退出
```

依赖边界不变：全部在 `src/cli/` 下，允许 import `contract / core / providers /
builtins / mcp`；不新增顶层目录，`scripts/check-boundaries.mjs` 不用改。

---

## 10. 测试

| 层 | 用例 |
| --- | --- |
| 参数 | `web` / `--port=3080` / `--no-open` 进 web；`web 前端怎么写`、`--port=abc` 回落成提示词 |
| UI sink | `print/notice/delta` 映射；ask 发事件并挂起；answer 落值；超时 / close / abort 回 fallback；未知 id 不落 |
| 事件插件 | 工具 start/end、deny、ask 上下文、output 截断、turn/busy |
| HTTP | token 缺失/错误 401；Host 不符 403；Origin 不符 403；静态白名单；404；prompt 202/409/400；answer；interrupt；SSE 回放 + 实时 |
| 会话 | 抽取后既有 CLI / REPL / 一次性 / `--resume` 测试逐条保持绿 |
| bin e2e | 真起 `bin/deepcode.mjs web --no-open`，从 stdout 取 URL，`fetch` 首页 200，SIGINT 退出 |

真实浏览器人工验一次：提问 → 流式文本 → 工具卡片 → 权限卡片（允许/总是/拒绝）→
停止按钮 → 刷新恢复时间线。

---

## 11. 已知限制（写进 `site/已知限制.md`）

- **只绑本机**，没有远程访问与账号体系；token 只在本次进程有效。
- **一个进程一个会话**：没有侧栏、没有工作区切换，刷新恢复的是同一条会话。
- **回放只有最近 2 000 条事件**：超出的部分页面重建不出来；转录文件仍是完整的那份。
- **工具输出在界面里截到 20 000 字符**（模型拿到的是完整的，超出的按 P11 外置）。
- **浏览器关掉服务不停**：后台 turn 会跑完；要停服务得关终端或按 Ctrl-C。
- **没有 diff / 文件树 / 图片输入**；权限卡只覆盖整工具判定，与终端一致。
- **没有自动化浏览器测试**：前端回归靠协议测试与人工验收。

---

## 12. 实施顺序

1. `session.ts` 抽取 + `turns.interrupt()` + REPL 可选 `submit`；全量测试保持绿。
2. `web/ui.ts` + `web/events.ts` + 单测。
3. `web/server.ts`（token / Host / Origin / SSE / 回放 / 静态）+ 协议测试。
4. `args.ts` + `web/command.ts` + `main.ts` 接线 + bin e2e。
5. 前端三件套 + 人工验收。
6. README / 已知限制 / CHANGELOG。
