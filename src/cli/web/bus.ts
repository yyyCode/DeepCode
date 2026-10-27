/**
 * 网页事件的总线：每条事件带自增 `seq`，同时留一份供刷新回放的缓冲。
 *
 * 为什么不是 EventEmitter：这里只有两件事 —— 扇出给所有 SSE 连接、留最近 N 条。
 * EventEmitter 再配一个数组，等于把这两件事写在两个地方；而 `emit` 里一个监听器
 * 抛错不该拖垮别的连接，这层保护本来就得自己写。
 *
 * **回放缓冲满了就丢最旧的，并记住"丢过"** —— 页面上的时间线不能假装自己是完整的
 * （见 spec §5.2）。
 */

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
      const stamped: WebEvent = { seq: ++seq, ...event };
      buffer.push(stamped);
      if (buffer.length > limit) {
        buffer.shift();
        truncated = true;
      }
      for (const listener of listeners) {
        try {
          listener(stamped);
        } catch {
          // 一个连接坏了不该拖垮别的连接 —— 也不该让 emit 抛进内核的调用栈。
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replay: () => buffer,
    get truncated() {
      return truncated;
    },
  };
}
