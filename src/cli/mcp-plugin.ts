import type { McpServerState, McpToolInfo } from '../contract/mcp';
import type { Plugin } from '../contract/plugin';
import type { McpRuntime } from './mcp-runtime';

/**
 * 把 MCP 运行时装配成一个**普通插件**。
 *
 * 引擎那边一个字都不用改：工具清单从 `tool.call` 的注册面推出来，权限判定走同一条
 * `tool.check` 链，`/mcp` 只是另一条 `command.run`。这就是「MCP 桥接不需要改内核」
 * 的全部含义。
 *
 * ⚠️ 顺序是这个插件唯一的结构性要求：它必须排在 `confirmPlugin` **之前**装配
 * （同 tier 内先注册者在外层）。`confirm` 对不认识的工具直接 deny 且不调 `next`，
 * 晚一步的话这里的 `tool.check` 永远够不着 —— 表现成「MCP 工具全部是未知工具」。
 */
export function createMcpPlugin(runtime: McpRuntime): Plugin {
  return {
    name: 'mcp',
    uses: ['tool.describe', 'tool.check', 'tool.call', 'command.run', 'command.describe', 'ui'],

    register(on) {
      for (const tool of runtime.tools) {
        on('tool.describe', { tool: tool.name }, () => ({
          description: describeTool(tool),
          inputSchema: schemaOf(tool),
        }));

        // 每一次调用都问。原因不是说 server 一定危险，而是我们对它一无所知：
        // 描述是它自己写的，`readOnlyHint` 也可以撒谎。问一次的成本远低于猜错。
        on('tool.check', { tool: tool.name }, () => ({
          decision: 'ask' as const,
          rule: `MCP 工具：${tool.server}/${tool.tool}`,
        }));

        on('tool.call', { tool: tool.name }, async (_$, e, next) => {
          const text = await runtime.call(tool.name, e.input ?? {}, next.signal);
          return { value: text };
        });
      }

      on('command.describe', { name: 'mcp' }, () => ({
        description: '列出已连接的 MCP server 与它们的工具',
      }));

      on('command.run', { name: 'mcp' }, ($) => {
        for (const line of formatMcpStates(runtime.states, runtime.hasServers)) {
          $.ui.log(line);
        }
        return { handled: true };
      });
    },
  };
}

function describeTool(tool: McpToolInfo): string {
  const body = tool.description.trim() === '' ? `${tool.tool}（服务器没有提供描述）` : tool.description;
  return `[MCP ${tool.server}] ${body}`;
}

/** 形状不对就当「没有参数」—— 模型看到一个空对象 schema 至少还能不带参数调用。 */
function schemaOf(tool: McpToolInfo): unknown {
  return typeof tool.inputSchema === 'object' && tool.inputSchema !== null
    ? tool.inputSchema
    : { type: 'object', properties: {} };
}

/**
 * `/mcp` 的文本。纯函数，测试直接对着它断言 —— 不必真起一个 REPL。
 *
 * 不做 reconnect，也不做热更新：状态是**会话开始时**的快照。改配置要下个会话才生效，
 * 这句话写在输出里，比让人对着一个不动的列表猜要诚实。
 */
export function formatMcpStates(states: readonly McpServerState[], hasServers: boolean): string[] {
  if (!hasServers) {
    return [
      '没有配置 MCP server。',
      '只认用户级 ~/.deepcode/settings.json 的 mcpServers（项目级配置不启动进程）；插件也可以带自己的 .mcp.json。',
    ];
  }

  const nameWidth = Math.max(...states.map((state) => state.name.length));
  const toolWidth = Math.max(
    0,
    ...states.flatMap((state) => state.tools.map((tool) => tool.name.length)),
  );

  const lines = ['mcp servers'];
  for (const state of states) {
    lines.push(`  ${state.name.padEnd(nameWidth)}  ${statusText(state)}`);
    for (const tool of state.tools) {
      lines.push(`    ${tool.name.padEnd(toolWidth)}  ${tool.tool}`);
    }
  }
  lines.push('（配置改动下个会话生效；本版本不自动重连。）');
  return lines;
}

function statusText(state: McpServerState): string {
  switch (state.status.kind) {
    case 'connected':
      return `connected  ${state.status.tools} tools`;
    case 'failed':
      return `failed     ${state.status.reason}`;
    case 'disabled':
      return 'disabled';
  }
}
