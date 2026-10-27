# DeepCode P16 MCP stdio 桥接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepCode 连接本地 stdio MCP server，把它的工具接进现有工具链与权限链。

**Architecture:** `src/mcp/` 放零依赖的 JSON-RPC / stdio 客户端与配置解析；`src/cli/` 负责把连接结果装配成一个普通 `Plugin`，逐工具注册 `tool.describe` / `tool.check` / `tool.call`。引擎、权限、结果外置全部复用现有结构，不改内核。

**Tech Stack:** TypeScript、Node ≥ 20（`node:child_process` / `node:string_decoder`）、vitest。运行时依赖保持 0。

**Spec:** `docs/superpowers/specs/2026-10-27-deepcode-p16-mcp-design.md`

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/contract/mcp.ts` | 类型与常量，零 import |
| `src/mcp/jsonrpc.ts` | 换行分帧、请求表、超时、server→client 请求兜底 |
| `src/mcp/config.ts` | 配置形状校验、`${VAR}` 展开、名字合法化（纯函数） |
| `src/mcp/stdio-client.ts` | spawn、握手、`tools/list` 分页、`tools/call`、关闭 |
| `src/cli/mcp-runtime.ts` | 汇总用户级 + 插件配置、并行连接、工具快照、`close()` |
| `src/cli/mcp-plugin.ts` | 快照 → `Plugin`，含 `/mcp` |
| `src/cli/settings.ts` | 顶层键 `mcpServers`，只收 user 层 |
| `src/cli/plugins.ts` | MCP 插件排在 `confirm` 之前，进第一方名单 |
| `src/cli/main.ts` | 连接、装配、`session.end` 后关闭 |
| `test/fixtures/fake-mcp-server.mjs` | 测试用 stdio MCP server |
| `scripts/check-boundaries.mjs` | `mcp` 只许 import contract；cli 许 import mcp |

---

### Task 1: 契约与 JSON-RPC

**Files:**
- Create: `src/contract/mcp.ts`
- Create: `src/mcp/jsonrpc.ts`
- Test: `test/mcp-jsonrpc.test.ts`

- [ ] 写 `src/contract/mcp.ts`：

```ts
export type McpServerOrigin = 'user' | 'plugin';

export type McpServerConfig = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly origin: McpServerOrigin;
  readonly plugin: string | undefined;
};

export type McpToolInfo = {
  readonly server: string;
  readonly serverPrefix: string;
  readonly name: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export type McpServerStatus =
  | { readonly kind: 'connected'; readonly tools: number; readonly protocolVersion: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'disabled' };

export type McpServerState = {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly tools: readonly McpToolInfo[];
};

export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
export const MAX_MCP_TIMEOUT_MS = 600_000;
export const MAX_MCP_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_NAME_LENGTH = 64;
```

- [ ] 写 `src/mcp/jsonrpc.ts`：`LineDecoder`（`StringDecoder` + 16 MiB 上限 + 按 `\n` 切分）、`JsonRpcPeer`（`request` / `notify` / `handleLine` / `failAll`）、`JsonRpcTimeoutError`（带 `requestId`）、server→client 请求兜底（`ping` → `{}`，其余 `-32601`）。
- [ ] 写测试：分帧跨 chunk、超时、超长行、非法 JSON、未知方法、`failAll`。
- [ ] 运行 `pnpm vitest run test/mcp-jsonrpc.test.ts`，通过。
- [ ] 提交：`feat(mcp): JSON-RPC 行分帧与请求表`

---

### Task 2: 配置解析与 settings 接线

**Files:**
- Create: `src/mcp/config.ts`
- Modify: `src/cli/settings.ts`
- Test: `test/mcp-config.test.ts`、`test/settings.test.ts`（补用例）

- [ ] `src/mcp/config.ts` 导出：
  - `isMcpServerName(name)`：`/^[A-Za-z][A-Za-z0-9_-]{0,31}$/`
  - `serverPrefix(name)`：`-` → `_`
  - `toolName(serverPrefix, raw, used)`：sanitize、首字符补 `t_`、截断加 8 位哈希、重名加 `_2`
  - `expandVars(text, env, extra)`：`${VAR}`；缺失返回 error
  - `parseMcpServers(value, opts)`：逐台校验，返回 `{ servers, problems }`；`opts` 含 `origin`、`plugin`、`env`、`extraEnv`、`resolvePath`、`warn`
- [ ] `settings.ts`：
  - `KNOWN_TOP_LEVEL` 加 `'mcpServers'`
  - `LayerRead` 加 `mcpServers`
  - `readLayer` 在 `permissions` 早期 return 之前解析；只有 `layer.source === 'user'` 收下，其余层警告丢弃
  - `ResolvedPolicy` 加 `readonly mcpServers: readonly McpServerConfig[]`
  - `resolvePolicy` 用 `deps.env ?? {}` 做展开，`deps.root` 解相对 `cwd`
- [ ] `main.ts` 两处 `resolvePolicy` 调用补 `env: process.env`。
- [ ] 测试：形状错误、`type: "sse"`、`enabled:false`、缺变量、`~`/相对 `cwd`、四层丢弃警告、user 层收下、重名合法化。
- [ ] 运行 `pnpm vitest run test/mcp-config.test.ts test/settings.test.ts`，通过。
- [ ] 提交：`feat(mcp): 配置解析与用户级 settings 接线`

---

### Task 3: stdio 客户端

**Files:**
- Create: `src/mcp/stdio-client.ts`
- Create: `test/fixtures/fake-mcp-server.mjs`
- Test: `test/mcp-client.test.ts`

- [ ] fake server 实现：`initialize`、`tools/list`（含分页模式）、`tools/call`（`echo` / `fail` / `slow` / `image`）、`ping`、未知方法错误、坏 JSON 模式、调用后崩溃模式。用环境变量 `FAKE_MCP_MODE` 切换。
- [ ] `connectMcpServer(config, deps)`：
  - spawn（POSIX `shell:false`；Windows `shell:true` + 参数转义 + `windowsHide`）
  - stderr 逐行转发 `[mcp:<server>]`
  - `initialize`（10 s）→ `notifications/initialized` → `tools/list`（15 s，最多 100 页）
  - 失败返回 `{ ok:false, reason }`，杀进程
- [ ] `McpConnection.call(name, input, { timeoutMs, signal })`：参数必须是对象；超时/中断发 `notifications/cancelled`；结果按 spec §5.4 转字符串。
- [ ] `close()` 幂等：`stdin.end()` → `SIGTERM` → 2 s `SIGKILL`。
- [ ] 测试：握手、分页、文本/错误/空结果、坏 JSON、超时、崩溃、关闭后 `dead`。
- [ ] 运行 `pnpm vitest run test/mcp-client.test.ts`，通过。
- [ ] 提交：`feat(mcp): stdio 客户端与握手/调用`

---

### Task 4: 运行时与插件

**Files:**
- Create: `src/cli/mcp-runtime.ts`
- Create: `src/cli/mcp-plugin.ts`
- Test: `test/mcp-plugin.test.ts`

- [ ] `startMcp(deps)`：用户级在前、插件 `.mcp.json` 在后；同名插件跳过并警告；`enabled:false` 记 `disabled`；并行连接；返回 `{ states, tools, call, close, hasServers }`。
- [ ] `loadPluginMcpServers(plugins, deps)`：读清单声明的 `mcpServers` 路径，否则默认 `./.mcp.json`；`${DEEPCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 展开；坏 JSON 警告跳过。
- [ ] `createMcpPlugin(runtime)`：
  - 每工具 `tool.describe`（`[MCP <server>] ...`，不带 `readOnly`）
  - 每工具 `tool.check` → `{ decision:'ask', rule:'MCP 工具：<server>/<tool>' }`
  - 每工具 `tool.call` → `runtime.call`，错误变 `{ value: 'ERROR: ...' }`
  - `command.describe` / `command.run` 提供 `/mcp`
- [ ] 测试：默认 ask、permissions allow/deny、confirm 不误 deny、`hidden`、`tool.list` 含工具、`/mcp` 输出、计划模式下不可见。
- [ ] 运行 `pnpm vitest run test/mcp-plugin.test.ts`，通过。
- [ ] 提交：`feat(mcp): 运行时与工具插件`

---

### Task 5: 接线

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/plugins.ts`
- Modify: `scripts/check-boundaries.mjs`
- Modify: `src/contract/plugin-manifest.ts`（移除 `mcpServers` 的 W8）
- Test: `test/plugin-manifest.test.ts`、`test/plugin-dir.test.ts`（补用例）

- [ ] `main.ts`：插件发现之后、`ctx = cliPlugins(...)` 之前 `await startMcp(...)`；传给 `cliPlugins` 的 `mcp`；`session.end` 后 `close()`。
- [ ] `cliPlugins`：`CliPluginDeps.mcp?: Plugin`；`firstParty` 里排在 `confirmPlugin` 之前。
- [ ] `check-boundaries.mjs`：`RULES.mcp = ['contract']`；`RULES.cli` 加 `'mcp'`。
- [ ] `plugin-manifest.ts`：`NOT_LOADED_FIELDS` 去掉 `mcpServers`；`CONVENTION_DIRS` 去掉 `.mcp.json`；更新相关测试断言。
- [ ] 运行 `pnpm typecheck && pnpm lint && pnpm vitest run test/plugin-manifest.test.ts test/plugin-dir.test.ts`，通过。
- [ ] 提交：`feat(mcp): 接入 CLI 装配与插件清单`

---

### Task 6: 端到端与文档

**Files:**
- Create: `test/mcp-e2e.test.ts`
- Modify: `README.md`、`site/已知限制.md`、`CHANGELOG.md`

- [ ] e2e：临时 home/root、用户级 `settings.json` 指向 fake server、假 provider，验证 `$.tool.list()` 含 `mcp__fake__echo`、`tool.call` 返回文本、`/mcp` 有 `connected`。
- [ ] README「扩展」加一段 MCP 用法；「已知限制」加 spec §8 五条。
- [ ] CHANGELOG 记录范围、出口标准、偏差（不做 HTTP/SSE、不热更新、项目级不生效、默认每次问）。
- [ ] 运行 `pnpm typecheck && pnpm lint && pnpm test`，全绿。
- [ ] 提交：`docs(mcp): 使用说明、限制与变更记录`
