import type { AskOptions, AskChoice } from '../../contract/engine';
import type { Renderer } from '../render';

/**
 * 网页的界面实现：同时是 `Renderer`（长相）与 `UiSink`（问人/说话）。
 *
 * 与终端那份的分工一样 —— 它不认识工具、不认识权限，只把内核要它说的话变成事件，
 * 把内核要它问的问题挂起，等人从浏览器里答。
 *
 * **fail-closed 的底线不动**：`ask` 的每一条非答题收场（超时、服务退出、turn 被中断）
 * 都用内核给的 `fallback`。读不到答案 = 没同意。
 */

/** 工具权限那一屏的上下文。事件插件在 `tool.check` 返回 `ask` 时塞进来，`ask` 消费一次即清空。 */
export type AskContext = {
  readonly tool: string;
  readonly input: unknown;
  readonly toolUseId: string;
};

export type AskReason = 'answer' | 'timeout' | 'closed' | 'abort';

export type WebUi = Renderer & {
  /** 回答一个挂起的问题。未知 id / 不在 choices 里的值 → `false`，原问题继续挂着。 */
  answer(id: string, value: string): boolean;
  /** 下一次 `ask` 带上这份上下文（只消费一次）。 */
  setAskContext(context: AskContext | undefined): void;
  /** 把所有挂起的问题按各自的 `fallback` 收场。 */
  abortAll(reason: Exclude<AskReason, 'answer'>): void;
  /** 与服务退出同义：挂起的提问按 `fallback` 收场（reason `closed`）。 */
  close(): void;
};

export type WebUiDeps = {
  readonly emit: (event: Record<string, unknown>) => void;
  /** 没人回答时的收场时间。默认 5 分钟 —— 刷新页面后仍然答得上（spec §6）。 */
  readonly askTimeoutMs?: number;
};

type PendingAsk = {
  readonly resolve: (value: string) => void;
  readonly fallback: string;
  readonly values: ReadonlySet<string>;
  readonly timer: ReturnType<typeof setTimeout>;
};

export function createWebUi(deps: WebUiDeps): WebUi {
  const pending = new Map<string, PendingAsk>();
  let askSeq = 0;
  let context: AskContext | undefined;
  const timeoutMs = deps.askTimeoutMs ?? 300_000;

  const settle = (id: string, value: string, reason: AskReason): boolean => {
    const entry = pending.get(id);
    if (entry === undefined) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    deps.emit({ type: 'ask.resolved', id, value, reason });
    entry.resolve(value);
    return true;
  };

  return {
    print: (line) => deps.emit({ type: 'log', level: 'info', text: line }),
    notice: (line) => deps.emit({ type: 'log', level: 'warn', text: line }),
    delta: (text) => deps.emit({ type: 'delta', text }),

    // 网页用结构化事件重画时间线，终端那几样行内动作没有对应物。
    newline: () => {},
    thinking: () => {},
    activity: () => {},
    settle: () => {},

    ask: (question: string, options?: AskOptions): Promise<string> => {
      const id = `a${++askSeq}`;
      const choices: readonly AskChoice[] = options?.choices ?? [];
      const fallback = options?.fallback ?? 'n';
      // 上下文只消费一次：下一张不带工具信息的普通问题卡不会捡到上一张的 input。
      const ctx = context;
      context = undefined;

      deps.emit({
        type: 'ask',
        id,
        question,
        choices,
        fallback,
        ...(ctx === undefined ? {} : { tool: ctx.tool, input: ctx.input, toolUseId: ctx.toolUseId }),
      });

      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          settle(id, fallback, 'timeout');
        }, timeoutMs);
        // 挂着的定时器不该把进程吊在事件循环里。
        timer.unref?.();
        pending.set(id, {
          resolve,
          fallback,
          values: new Set(choices.map((choice) => choice.value)),
          timer,
        });
      });
    },

    answer: (id, value) => {
      const entry = pending.get(id);
      if (entry === undefined) return false;
      // choices 为空 = 不是选择卡（例如计划批准的自由输入），任何值都收。
      if (entry.values.size > 0 && !entry.values.has(value)) return false;
      return settle(id, value, 'answer');
    },

    setAskContext: (next) => {
      context = next;
    },

    abortAll: (reason) => {
      for (const id of [...pending.keys()]) {
        const entry = pending.get(id);
        if (entry !== undefined) settle(id, entry.fallback, reason);
      }
    },

    close: () => {
      for (const id of [...pending.keys()]) {
        const entry = pending.get(id);
        if (entry !== undefined) settle(id, entry.fallback, 'closed');
      }
    },
  };
}
