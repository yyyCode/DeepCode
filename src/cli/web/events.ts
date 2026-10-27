import type { Plugin } from '../../contract/plugin';
import type { AskContext } from './ui';

/**
 * 引擎事件 → 网页事件（工具卡片、turn、busy）。
 *
 * **只观察，不裁决**：每一条 hook 都把 `next` 的返回值原样交出去。唯一"改写"的东西
 * 是它自己的这本账（开始时间），而账是只读方向的。
 *
 * 座位：这个插件必须排在**第一方数组最前**（`cli/plugins.ts` 的 `extraPlugins`）。
 * 工具自己的 `tool.call` matcher hook 跑完直接返回、不调 next —— 排在它里面，
 * `tool.start` 与耗时就永远看不见真实的调用。
 */

/** 界面里工具输出的上限。模型拿到的是完整的（超出部分按 P11 外置）。 */
export const TOOL_OUTPUT_LIMIT = 20_000;

export type WebEventsDeps = {
  readonly emit: (event: Record<string, unknown>) => void;
  readonly onAskContext: (context: AskContext) => void;
  /** 测试注入。 */
  readonly now?: () => number;
};

const cap = (output: string): { output: string; truncated: boolean } =>
  output.length <= TOOL_OUTPUT_LIMIT
    ? { output, truncated: false }
    : { output: output.slice(0, TOOL_OUTPUT_LIMIT), truncated: true };

export function createWebEventsPlugin(deps: WebEventsDeps): Plugin {
  const now = deps.now ?? Date.now;
  /** toolUseId → 开始时间。`tool.result` 可能被延后派发，所以时长在收尾时现算。 */
  const startedAt = new Map<string, number>();

  return {
    name: 'web-events',
    uses: ['tool.check', 'tool.call', 'tool.result', 'tool.consent', 'turn.start', 'turn.complete'],
    register(on) {
      on('tool.check', async ($, e, next) => {
        const check = await next(e);
        if (check.decision === 'deny') {
          deps.emit({
            type: 'tool.denied',
            toolUseId: e.toolUseId,
            tool: e.tool,
            ...(check.rule === undefined ? {} : { rule: check.rule }),
          });
        } else if (check.decision === 'ask') {
          // 权限卡的那份上下文：`ui.ask` 落笔时把它带上，只消费一次。
          deps.onAskContext({ tool: e.tool, input: e.input, toolUseId: e.toolUseId });
        }
        return check;
      });

      on('tool.call', async ($, e, next) => {
        const started = now();
        startedAt.set(e.toolUseId, started);
        deps.emit({ type: 'tool.start', toolUseId: e.toolUseId, tool: e.tool, input: e.input });

        let result: Awaited<ReturnType<typeof next>>;
        try {
          result = await next(e);
        } catch (error) {
          startedAt.delete(e.toolUseId);
          deps.emit({
            type: 'tool.end',
            toolUseId: e.toolUseId,
            status: 'error',
            durationMs: now() - started,
          });
          throw error;
        }

        if ('deny' in result) {
          startedAt.delete(e.toolUseId);
          deps.emit({
            type: 'tool.end',
            toolUseId: e.toolUseId,
            status: 'denied',
            durationMs: now() - started,
          });
        }
        return result;
      });

      on('tool.result', async ($, e, next) => {
        const started = startedAt.get(e.toolUseId);
        startedAt.delete(e.toolUseId);
        const capped = cap(e.output);
        deps.emit({
          type: 'tool.end',
          toolUseId: e.toolUseId,
          status: e.ok ? 'ok' : 'error',
          output: capped.output,
          ...(capped.truncated ? { truncated: true } : {}),
          ...(started === undefined ? {} : { durationMs: now() - started }),
        });
        // 这是缝：钩子可以往对话里补一段。观察者不许把它吞掉。
        return next(e);
      });

      on('tool.consent', async ($, e, next) => {
        deps.emit({ type: 'consent', tool: e.tool, granted: e.granted });
        return next(e);
      });

      on('turn.start', async ($, e, next) => {
        deps.emit({ type: 'turn', phase: 'start', index: e.index });
        deps.emit({ type: 'busy', busy: true });
        return next(e);
      });

      on('turn.complete', async ($, e, next) => {
        try {
          return await next(e);
        } finally {
          // 放在 finally 里：一个下游 hook 把 turn.complete 抛坏了，界面上的
          // "思考中"也不能永远转下去。
          deps.emit({
            type: 'turn',
            phase: 'end',
            stopReason: e.stopReason,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            ...(e.usageEstimated === undefined ? {} : { estimated: e.usageEstimated }),
          });
          deps.emit({ type: 'busy', busy: false });
        }
      });
    },
  };
}
