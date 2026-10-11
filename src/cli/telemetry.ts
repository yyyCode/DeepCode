import type { Plugin } from '../contract/plugin';
import type { TelemetryPolicy } from './settings';
import { createTelemetrySink, type TelemetrySink } from './telemetry-sink';
import type { TelemetryEntry } from './telemetry-rows';

/**
 * 遥测名词 —— 插件通过 `engine.create` 折叠往 `$` 上加东西
 * （`contract/engine.ts` 那段"声明合并"的注释描述的就是它）。
 *
 * ⚠️ 这条路**只有第一方走得通**：`core/third-party.ts` 当场拒掉第三方往
 * `engine.create` 挂 hook（折叠早就完成了，挂上去是静默无效 —— 明着拒绝更好）。
 * 也就是说"插件能扩展 `$`"这句话今天仅对 `builtins/` 与 `cli/` 成立。
 */
export type TelemetryNoun = { log(entry: TelemetryEntry): void };

declare module '../contract/engine' {
  interface EngineInterface {
    telemetry: TelemetryNoun;
  }
}

export type TelemetryPluginDeps = {
  readonly home: string;
  readonly policy: TelemetryPolicy;
  readonly sessionId: string;
  readonly warn: (line: string) => void;
  /** 测试注入用；生产省略。 */
  readonly sink?: TelemetrySink;
};

/**
 * 遥测：六个事件各记一行，落到**用户级** `~/.deepcode/telemetry.jsonl`。
 *
 * 三条不变量，每条都有用例：
 *
 * 1. **它是个读者，不是链上的一环。** 每一条 hook 都 `return next(e)`，一个字节的裁决
 *    都不改。挂在 `tool.result` 而不是 `tool.check` 上，正是为了让它在工具执行路径**之外**
 *    —— 一个记录行为的东西不该有可能改变行为。
 * 2. **关着的时候一个系统调用都不发**（sink 那边保证，这里只管不记）。
 * 3. **只记零自由文本的行**（`validateEntry` 保证）。这份功能没有网络上报，
 *    唯一会离开进程的就是这个文件。
 */
export function createTelemetryPlugin(deps: TelemetryPluginDeps): Plugin {
  const sink =
    deps.sink ??
    createTelemetrySink({ home: deps.home, enabled: deps.policy.enabled, warn: deps.warn });

  const write = (entry: TelemetryEntry): void => {
    sink.record(entry);
  };

  const renderStatus = (): string => {
    const { written, rejected, lastReject, lastError, path } = sink.stats;
    const lines = [
      `遥测：${deps.policy.enabled ? '开' : '关'} —— ${deps.policy.why}`,
      `文件：${path}`,
      `本次会话记了 ${written} 行${rejected === 0 ? '' : `，丢了 ${rejected} 条（${lastReject ?? ''}）`}`,
    ];
    if (lastError !== undefined) lines.push(`⚠️ 上一次写盘失败：${lastError}`);
    if (!deps.policy.enabled) {
      lines.push(
        '打开：在**用户级** ~/.deepcode/settings.json 里写 {"telemetry":{"enabled":true}}。' +
          '项目里写不算数 —— 别人仓库的一份文件不该替你按下开关。',
      );
    }
    return lines.join('\n');
  };

  return {
    name: 'telemetry',
    uses: [
      'engine.create',
      'session.start',
      'session.end',
      'turn.complete',
      'tool.result',
      'session.compact',
      'agent.spawn',
      'command.run',
      'command.describe',
      'ui',
    ],

    register(on) {
      // 折叠：`{...beneath}` 先铺开，自己那份盖上去 —— **靠外的赢**。
      // 外层是权威更高的 tier（tier 权威序：prepend > user > append > builtin > core），
      // 于是"两个插件都提供同名名词"时由更权威的那个说了算，与其他所有裁决同向。
      on('engine.create', async (_$, e, next) => ({ ...(await next(e)), telemetry: { log: write } }));

      on('session.start', (_$, e, next) => {
        write({ kind: 'session.start', fields: { session: deps.sessionId } });
        return next(e);
      });

      on('turn.complete', (_$, e, next) => {
        write({
          kind: 'turn.complete',
          fields: {
            stop_reason: e.stopReason,
            input_tokens: e.inputTokens,
            output_tokens: e.outputTokens,
            estimated: e.usageEstimated === true,
          },
        });
        return next(e);
      });

      on('tool.result', (_$, e, next) => {
        write({ kind: 'tool.result', fields: { tool: e.tool, ok: e.ok } });
        return next(e);
      });

      on('session.compact', (_$, e, next) => {
        write({ kind: 'session.compact', fields: { trigger: e.trigger, tokens_before: e.tokensBefore } });
        return next(e);
      });

      on('agent.spawn', (_$, e, next) => {
        write({ kind: 'agent.spawn', fields: { agent: e.name } });
        return next(e);
      });

      on('session.end', async (_$, e, next) => {
        write({ kind: 'session.end', fields: { reason: e.reason } });
        // 收场前冲盘。sink 自己把写失败咽成一句 warn —— 遥测坏掉不该让退出卡住。
        await sink.flush();
        return next(e);
      });

      on('command.describe', { name: 'telemetry' }, () => ({
        description: '看遥测开关与本次会话写了多少行',
      }));

      on('command.run', { name: 'telemetry' }, ($) => {
        $.ui.log(renderStatus());
        return { handled: true };
      });
    },
  };
}
