export type TurnSignals = {
  /** 每个 turn 开头取一个新的 signal：Ctrl-C 掐断的就是它。 */
  begin(): AbortSignal;
  end(): void;
  /** createEngine 要的工厂：永远是"当前这个 turn"的 signal。 */
  current(): AbortSignal;
  /**
   * 只掐当前 turn，不退出进程（P17 网页的停止按钮）。
   * 忙且还没中断 → abort 并返回 `true`；空闲 / 已经中断 → `false`。
   */
  interrupt(): boolean;
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

  /**
   * 两条路共用一个落点：Ctrl-C 与网页的停止按钮都只能是"掐断当前 turn"。
   * 写成两个地方各 abort 一次，迟早会有一处忘了查 `busy`。
   */
  const interrupt = (): boolean => {
    if (!busy || live.signal.aborted) return false;
    live.abort();
    return true;
  };

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

    interrupt,

    onSigint: () => {
      // 同一次按键可能被 process 与 readline 两条路各送一遍，去重。
      // 50ms 远短于人类"连按两次"的间隔，所以不影响下面的强制退出。
      const now = Date.now();
      if (now - lastSigint < 50) return;
      lastSigint = now;

      // 空闲时 Ctrl-C = 退出；同一个 turn 里再按一次 = 强制退出。
      if (!interrupt()) process.exit(130);
    },
  };
}
