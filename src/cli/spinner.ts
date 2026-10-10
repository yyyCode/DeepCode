export type Spinner = {
  start(label: string): void;
  stop(): void;
  active(): boolean;
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 90;

/**
 * 单行 spinner，只写 stderr。
 *
 * 非 TTY 下是彻底的 no-op：测试、管道、CI 里它一个字节都不该产出。
 */
export function createSpinner(
  stream: NodeJS.WriteStream = process.stderr,
  enabled: boolean = Boolean(stream.isTTY) && process.env.TERM !== 'dumb',
): Spinner {
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let label = '';

  /** 抹掉这一行。半行小圆圈后面接上模型的第一句话是最典型的 TUI 事故。 */
  const erase = (): void => {
    stream.write('\r\u001b[K');
  };

  return {
    start(next) {
      // 已经在转就什么都不做：重复 start 会把 interval 泄漏掉。
      if (!enabled || timer !== undefined) return;
      label = next;

      const tick = (): void => {
        const glyph = FRAMES[frame++ % FRAMES.length]!;
        stream.write(`\r${glyph} ${label}`);
      };
      tick();
      timer = setInterval(tick, INTERVAL_MS);
      // unref：spinner 不该成为"进程退不掉"的理由。
      timer.unref();

      // 进程死在 spinner 转着的时候，退出前把那一行抹掉。start/stop 是配对的，
      // 所以同时最多挂着一个监听。
      process.once('exit', erase);
    },

    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      process.off('exit', erase);
      erase();
    },

    active: () => timer !== undefined,
  };
}
