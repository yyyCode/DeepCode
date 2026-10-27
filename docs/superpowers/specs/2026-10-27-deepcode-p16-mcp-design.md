# DeepCode P16 MCP stdio 桥接

> 一句话：**把本地 stdio MCP server 的工具接进现有工具链，不改引擎、不加运行时依赖。**
> MCP 在 P3/P9 里被两次登记为「刻意不做」（`p3-design.md:546`、`p9-design.md:290`），
> 本阶段补的是那块被推迟的协议实现；工具注册、权限判定、结果外置全部复用既有结构。

---

## 1. 现状与决定

- `src/` 里没有任何 MCP 客户端。`plugin-manifest.ts` 认识 `mcpServers` 字段与
  `./.mcp.json`，但只做存在性校验，并报 `W8`「本版本不加载」。
- 工具从来不是内核里的硬编码表：谁注册 `tool.call {tool: X}`，谁就提供这个工具
  （`core/nouns/index.ts:66`）。因此 MCP 桥接可以是一个**普通插件**。
- 第三方插件加工具的唯一硬约束是权限链：`confirm` 坐 `builtin`，对不认识的工具直接
  deny 且不调 `next`（`builtins/confirm.ts:54`）。插件要么坐在它外面，要么逐工具应答
  `tool.check`。`plugins/todo/main.mjs:31` 是既有先例。
- 运行时依赖为 **0**（README 徽章）。JSON-RPC、行分帧、进程管理全部手写，不引 SDK。

**本阶段范围**：stdio 传输、用户级配置、插件 `.mcp.json`、`initialize` / `tools/list` /
`tools/call`、工具注册、权限询问、失败降级、`/mcp` 状态。

---

## 2. 明确不做

| 不做的项 | 理由 |
| --- | --- |
| HTTP / SSE / WebSocket 传输 | 需要鉴权、OAuth、重连，是另一块协议面。本阶段只交付本地 server |
| resources / prompts / sampling / roots / elicitation | 四个 MCP 能力面各有自己的交互模型；工具面已经是最大的一块 |
| `tools/list_changed` 热更新 | 注册面没有「按 matcher 撤销一个工具」的 API；删工具只能整个插件撤回。本阶段忽略该通知，下个会话生效 |
| 自动重连 / 健康检查 | server 崩溃后重连会把「它已经坏了」变成不可见状态；先如实报错 |
| 按参数匹配权限 | `isSupported` 只认 `Bash` 与三个路径工具；MCP 工具只支持整工具 allow/ask/deny |
| 项目级 / local / flag / 托管层 `mcpServers` | 打开一个仓库不该自动执行外部命令。只有**用户级**配置能启动 server |
| 清单内联 `mcpServers` 对象 | 现有清单把该字段当路径（E6 只收字符串），内联对象留到以后 |
| 信任 server 的 `readOnlyHint` | 自述旗标可以撒谎；MCP 工具一律当写、串行执行 |

---

## 3. 配置与信任模型

### 3.1 用户级 settings

`~/.deepcode/settings.json` 新增顶层 `mcpServers`：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "cwd": ".",
      "timeoutMs": 60000,
      "enabled": true
    }
  }
}
```

| 字段 | 类型 | 默认 | 规则 |
| --- | --- | --- | --- |
| `command` | string | 必填 | 非空；走 PATH 解析 |
| `args` | string[] | `[]` | 类型不对 → 整台跳过 |
| `env` | Record<string,string> | `{}` | 合并到 `process.env` 之上；类型不对 → 整台跳过 |
| `cwd` | string | 会话根目录 | 相对路径按会话根目录解析，`~` 展开 |
| `timeoutMs` | number | `60000` | 正整数，上限 `600000`；只作用于 `tools/call` |
| `enabled` | boolean | `true` | `false` = 保留配置、不连接，`/mcp` 里标 `disabled` |
| `type` | string | `stdio` | 只认缺省或 `"stdio"`；其余（`http` / `sse`）跳过并点名 |

**只有 `user` 层收下这个块。** `project` / `local` / `flag` / `policy` 写了就整块丢弃，
逐层警告，与 `telemetry`（只有用户层能开）、`gateway`（只有托管层能钉）同一条方向：
一份克隆下来的配置文件不该替你启动一个进程。

### 3.2 插件的 `.mcp.json`

- 插件清单声明了 `mcpServers` 路径 → 读声明的；没声明但根目录有 `./.mcp.json` → 读默认位置。
- 插件已经通过 `plugins.enable` / `plugins.deny` / 清单校验的闸门，`loadPlugins` 也已经
  import 它的入口代码；`.mcp.json` 不额外加闸，随插件生效。
- 展开 `${DEEPCODE_PLUGIN_ROOT}`（并兼容 `${CLAUDE_PLUGIN_ROOT}`）为插件绝对路径。
- 插件 server 与用户级 server **同名** → 插件那台跳过，警告点名；用户级优先。
- `plugin-manifest.ts` 的 `NOT_LOADED_FIELDS` 移除 `mcpServers`，`.mcp.json` 不再是 W8。

### 3.3 环境变量展开

- 支持 `${VAR}`；插件配置额外支持 `${DEEPCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`。
- 引用了不存在的变量 → **该 server 跳过**并说明缺哪个变量。不静默展开成空串：
  一个空 `GITHUB_TOKEN` 会让 server 启动成功、每次调用 401，比直接不启动更难查。
- 只在 `command` / `args` / `env` / `cwd` 四处展开；展开后不再二次展开。

---

## 4. 协议与生命周期

### 4.1 传输

MCP stdio 传输是**换行分隔的 JSON-RPC 2.0**（UTF-8，一行一条消息，消息内不得含裸换行）。
不写 `Content-Length` 头。

- 请求 ID 用递增整数。
- 单行上限 16 MiB；超长 → 该 server 判死，警告一次，会话继续。
- server 的 stderr 按行转发到 `debug`（`DEEPCODE_DEBUG`），前缀 `[mcp:<server>]`；
  不进入模型上下文。stdout 只当协议，非法 JSON 行警告一次并丢弃。

### 4.2 启动握手

每台 server 并行执行：

1. `spawn(command, args, { stdio: ['pipe','pipe','pipe'], cwd, env, windowsHide: true })`
2. `initialize`（10 s 超时）：
   ```json
   { "protocolVersion": "2025-06-18", "capabilities": {},
     "clientInfo": { "name": "deepcode", "version": "0.0.1" } }
   ```
3. `notifications/initialized`
4. 若 `capabilities.tools` 存在：`tools/list`（15 s 超时，按 `nextCursor` 翻页，最多 100 页）

失败（命令不存在、非零退出、握手超时、`tools/list` 报错）→ 杀进程、记 `failed: <原因>`，
警告一条；这台 server 的工具不出现，**不阻塞会话启动**。

`protocolVersion` 以 server 返回值为准；不在已知集合（`2024-11-05` / `2025-03-26` /
`2025-06-18`）里时仍继续，warn 一次，因为工具面在这些版本间是同构的。

### 4.3 调用与取消

`tools/call` 参数：`{ name: <原始工具名>, arguments: <模型给的 input> }`。

- `timeoutMs` 到点 → 发 `notifications/cancelled { requestId, reason: "timeout" }`，
  给模型返回 `ERROR: ...超时`。
- `next.signal` abort → 发 `notifications/cancelled { requestId, reason: "user" }`，
  返回 `ERROR: 已中断`。
- server 在请求进行中退出 → 所有未完成请求 reject；调用方拿到 `ERROR: ...连接已断开`。

### 4.4 关闭

`session.end` 之后与 `process.on('exit')` 各调一次 `runtime.close()`（幂等）：

1. `child.stdin.end()`
2. `SIGTERM`
3. 2 s 后仍在 → `SIGKILL`

Windows 上 `child.kill()` 只杀直接子进程，孙进程可能残留 —— 写进已知限制。

### 4.5 server 主动发来的消息

- `ping` 请求 → 回 `{}`。
- 其余 server → client 请求（sampling / roots / elicitation）→ 回 JSON-RPC 错误 `-32601`
  （Method not found），不假装支持。
- `notifications/message` → debug 行。
- `notifications/tools/list_changed` → 一条 debug：「本版本不热更新，下个会话生效」。

---

## 5. 工具面

### 5.1 命名

工具名固定为 `mcp__<server>__<tool>`：

- server 名（配置键）必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,31}$`；`-` 在工具名里换成 `_`。
- tool 原始名里的非 `[A-Za-z0-9_]` 字符换成 `_`；首字符不是字母时前缀 `t_`。
- 总长超过 64 字符 → 截断 tool 段并追加 8 位原文哈希，保证唯一。
- 同一 server 内 sanitize 后重名 → 后者加 `_2` / `_3`。
- 原始 server / tool 名保留在 `/mcp` 输出里，方便对照。

### 5.2 描述

`tool.describe` 返回：

```
[MCP <server>] <server 提供的 description>
```

没有描述时写 `[MCP <server>] <原始工具名>（服务器没有提供描述）`。
**不带 `readOnly`** —— 执行面按会写处理，同一轮里的 MCP 调用串行。

### 5.3 权限

桥接插件为每个工具注册一条：

```
tool.check { tool: "mcp__<server>__<tool>" } → { decision: 'ask', rule: 'MCP 工具：<server>/<tool>' }
```

- 插件必须排在 `confirmPlugin` **之前**装配（同 tier 内先注册者在外层），否则 `confirm`
  先看到未知工具并直接 deny，桥接的 `tool.check` 永远够不着。
- `permissions` 坐 `user`，天然更外层：一条 `allow: ["mcp__github__search"]` 能把 `ask`
  变成 `allow`，`deny` 照旧掀不翻。
- 整工具 deny → `permissions` 注册 `hidden`，工具从模型清单里消失。
- 带参规则（`mcp__x__y(...)`）加载时走 `isSupported` 的既有警告，不会假装生效。

### 5.4 返回给模型

`tools/call` 的 `result.content` 逐项转换后以换行拼接：

| content 项 | 转换 |
| --- | --- |
| `{type:'text', text}` | 原文 |
| `{type:'resource', resource:{text}}` | 原文 |
| `{type:'resource', resource:{blob}}` | `[资源 <uri>（base64，已省略）]` |
| `{type:'image'}` / `{type:'audio'}` | `[<类型> <mimeType>，已省略 base64]` |
| 未知类型 | `JSON.stringify(item)` |

- 没有 `content` 但有 `structuredContent` → 序列化 `structuredContent`。
- `isError === true` → 整体加 `ERROR: ` 前缀。
- 空结果 → `(MCP server 返回了空结果)`。
- JSON-RPC 错误 / 超时 / 断线 → `ERROR: MCP <server>/<tool> 调用失败：<原因>`，
  **不抛**：工具失败是给模型的信息，与六个内建工具同一条（`read.ts:67`）。
- 超大结果不在 MCP 层截断；沿用 P11 第 1 层的外置与预览。

---

## 6. 文件布局与接线

```
src/contract/mcp.ts       类型与常量（零依赖）
src/mcp/jsonrpc.ts        行分帧、请求表、超时、最大行长
src/mcp/stdio-client.ts   spawn、握手、tools/list、tools/call、关闭
src/mcp/config.ts         形状校验、变量展开、名字合法化（纯函数）
src/cli/mcp-runtime.ts    汇总配置 → 并行连接 → 工具快照；close()
src/cli/mcp-plugin.ts     快照 → Plugin：describe / check / call / `/mcp`
src/cli/settings.ts       KNOWN_TOP_LEVEL + user 层读取 mcpServers
src/cli/plugins.ts        把 mcp 插件排进 firstParty、confirm 之前
src/cli/main.ts           发现插件后连接、session.end 后关闭
scripts/check-boundaries.mjs  mcp 只许 import contract；cli 许 import mcp
```

- `mcp/` 不认识引擎、渲染器、CLI 设置；`cli/` 负责把连接结果装配成插件。
- 连接在 `createEngine` **之前**完成：`tool.list()` 是注册面的快照，工具必须在装配期
  就注册好；每轮重算清单的既有结构不需要改。
- MCP 插件是**第一方**（进 `cliPlugins` 的 `firstParty`），名字 `mcp`；它的
  `tool.check` 只答 `ask`，不拥有放宽权限的能力，但仍然享受 `plugins.deny` 的第一方豁免
  —— 想关掉某台 server 用 `enabled: false`，不是插件禁用名单。

---

## 7. `/mcp`

会话内命令，逐台列出：

```
mcp servers
  github       connected  12 tools
    mcp__github__search          search
    mcp__github__create_issue    create_issue
  filesystem   failed    spawn npx ENOENT
  old          disabled
```

- 状态只有 `connected` / `failed: <原因>` / `disabled`。
- 工具行左边是模型看到的合法名，右边是 server 原始名。
- 不做 reconnect；配置改动下个会话生效。

---

## 8. 安全与限制（写进 README / 已知限制）

1. **MCP server 是用户权限下的任意进程**，信任级别与插件相同。只从用户级配置启动，
   是这一阶段唯一的结构性约束。
2. **工具描述与返回内容是外部输入**，会进入系统提示与上下文。本版只加 `[MCP <server>]`
   前缀便于识别，不做提示注入防护 —— 与 P15 对子代理外部内容的登记同一条。
3. 没有项目级配置：团队共享 server 配置要每人自己写一份用户级配置。
4. Windows 上关闭只杀直接子进程，孙进程可能残留。
5. server 崩溃不自动重连，必须重启会话。

---

## 9. 测试

| 层 | 用例 |
| --- | --- |
| `jsonrpc` | 分帧、请求 ID 唯一、超时、超长行、非法 JSON |
| `config` | 形状错误、`type` 非 stdio、`enabled:false`、变量缺失、`~`/相对 `cwd`、名字合法化与重名 |
| `settings` | user 层收下；其余四层丢弃并逐层警告；unknown key 不误报 |
| `stdio-client` | 用 `test/fixtures/fake-mcp-server.mjs` 覆盖握手、分页、文本/错误/空结果、坏 JSON、超时、崩溃、关闭清理 |
| 插件 | 默认 `ask`；permissions allow/deny；`confirm` 不误 deny；`hidden`；`/mcp` 输出；计划模式不可见 |
| e2e | 假 provider + 真 fake server：会话启动后 `$.tool.list()` 含 MCP 工具，调用结果回给模型 |

所有测试全桩，不需要密钥；fake server 是一个只依赖 `node:` 的 `.mjs`，由测试临时目录里的
配置点名启动。

---

## 10. 与主流实现的差异（有话直说）

- **不做 HTTP/SSE**：主流客户端四种传输都做；本阶段只做 stdio，其余明确报「本版本不支持」。
- **项目级配置不自动生效**：主流实现会对仓库里的 `.mcp.json` 弹一次批准；这里直接不认，
  换来的是「clone 即安全」。
- **工具清单热更新忽略**：主流实现响应 `tools/list_changed`；这里下个会话生效。
- **默认每次问**：主流实现按 server 配置 autoApprove；这里把「放宽」交给权限规则，
  桥接层只答 `ask`。

---

## 11. 实施顺序

1. `contract/mcp.ts` + `mcp/jsonrpc.ts` + 测试
2. `mcp/config.ts` + 测试（含 settings 接线）
3. `mcp/stdio-client.ts` + fake server 测试
4. `cli/mcp-runtime.ts` + `cli/mcp-plugin.ts` + 权限/工具面测试
5. `main.ts` / `cliPlugins` / `check-boundaries.mjs` 接线
6. `/mcp` 命令 + e2e
7. README / 已知限制 / CHANGELOG
