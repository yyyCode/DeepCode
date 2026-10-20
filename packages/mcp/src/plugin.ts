import type { Plugin } from '@deepcode/contract/plugin';
import type { McpHost } from './host';

/**
 * 把 MCP 工具接进现有工具面。
 *
 * 三条精确 hook 缺一不可：
 * - `tool.describe` 让 `listTools` 看得见它；
 * - `tool.check` 给它一个判定。**必须直接返回 `ask`、不调 `next`**：
 *   `confirm` 对不认识的工具是 deny 的，而它坐在同 tier 的内层，
 *   所以本插件要排在 `confirm` 前面，否则 MCP 工具一出生就是死的。
 * - `tool.call` 真正转发给 server。
 *
 * MCP 自己报的 `readOnlyHint` / `destructiveHint` 一律不拿来做放行依据：
 * 那是 server 自述，不是托管策略。要免问，请在 permissions.allow 里点名。
 */
export function createMcpPlugin(host: McpHost): Plugin {
  return {
    name: 'mcp',
    uses: ['tool.call', 'tool.describe', 'tool.check'],

    register(on) {
      for (const tool of host.tools) {
        on('tool.describe', { tool: tool.visibleName }, () => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));

        on('tool.check', { tool: tool.visibleName }, () => ({
          decision: 'ask' as const,
          rule: `MCP 工具 ${tool.server}/${tool.name}`,
        }));

        on('tool.call', { tool: tool.visibleName }, async ($, e) => {
          try {
            const result = await host.call(tool.visibleName, e.input, $.session.signal());
            return { value: result.text };
          } catch (error) {
            if ($.session.signal().aborted) return { value: 'ERROR: 已取消' };
            return {
              value: `ERROR: MCP 工具 ${tool.server}/${tool.name} 调用失败：${describe(error)}`,
            };
          }
        });
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
