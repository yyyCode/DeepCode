export type TurnSignals = {
  /** 每个 turn 开头取一个新的 signal：Ctrl-C 掐断的就是它。 */
  begin(): AbortSignal;
  end(): void;
  /** createEngine 要的工厂：永远是"当前这个 turn"的 signal。 */
  current(): AbortSignal;
  onSigint(): void;
};

/**
 * 每个 turn 一个 AbortController，而不是全进程共用一个。
 *
 * 一个 AbortSignal 一旦 abort 就再也回不去。全进程共用一个的话，用户按一次
 * Ctrl-C 之后，往后每个 turn 都会拿着一个已经 aborted 的 signal 去 fetch，
 * 会话当场变成尸体 —— 而 loop 那边还在安慰用户"会话保留，可以继续输入"。
 * 所以中断 = 掐断当前这个 turn，下一个 turn 拿的是全新的 signal。
 */
export function createTurnSignals(): TurnSignals {
  let live = new AbortController();
  let busy = false;
  let lastSigint = 0;

  return {
    begin: () => {
      live = new AbortController();
      busy = true;
      return live.signal;
    },
    end: () => {
      busy = false;
    },
    current: () => live.signal,

    onSigint: () => {
      // 同一次按键可能被 process 与 readline 两条路各送一遍，去重。
      // 50ms 远短于人类"连按两次"的间隔，所以不影响下面的强制退出。
      const now = Date.now();
      if (now - lastSigint < 50) return;
      lastSigint = now;

      // 空闲时 Ctrl-C = 退出；同一个 turn 里再按一次 = 强制退出。
      if (!busy || live.signal.aborted) process.exit(130);

      // 正在跑：掐断它，进程不退。
      live.abort();
    },
  };
}
