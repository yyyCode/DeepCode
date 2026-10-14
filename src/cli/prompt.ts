import type { Interface, Key } from 'node:readline';
import type { AskOptions } from '../contract/engine';
import type { UiSink } from '../core/nouns/ui';
import { createPalette, type Palette } from './ansi';
import { activityWidth, fitTo } from './width';

export type PromptSinkOptions = {
  /**
   * 当前 turn 的 signal 工厂。确认提示**必须**能被它叫醒 ——
   * 见 ask 里的三条收场路径。
   */
  signalOf: () => AbortSignal;
  /** 只给测试用：默认按 `process.stdin.isTTY` 判断。 */
  interactive?: boolean;
  /** 提示语着色用。默认关（不传就是纯文本，测试里的断言才逐字节稳）。 */
  palette?: Palette;
  /** 落笔的流。默认 `process.stdout` —— 与 `RendererOptions.stream` 同一条缝。 */
  out?: NodeJS.WriteStream;
  /**
   * 提示落笔**之前**调一次。main.ts 用它停掉 spinner ——
   * 否则"思考中"那半行小圆圈会粘在 `> ` 提示符前面。
   */
  beforeAsk?: () => void;
};

/** `rl.input` 上菜单要用的那一小片能力。真 TTY 才有；测试可以自己造一个替身。 */
type RawInput = NodeJS.ReadableStream & { setRawMode?(mode: boolean): void };

/**
 * 复用调用方那**一个** readline 实例，绝不自己再建第二个。
 *
 * 同一个 process.stdin 上挂两个 Interface，两边都会收到用户敲的每一行
 * （已实测：两次 question 同时挂起时，一行输入被两个回调各收一份）。
 * 而 TTY 下两个 Interface 还会各自进入 raw 模式、各自挂 keypress 监听，
 * 于是每个按键被处理两遍、终端里回声重叠。
 *
 * 所以 rl 由 main.ts 建一次，REPL 与确认提示共用。
 *
 * ⚠️ 菜单（`ask` 带选项时）走的是这条共用的路里**更窄**的一段：菜单期间把 rl 自己那个
 * keypress 监听**摘下来**，用完原样装回去 —— 见 `menu()` 里的说明。依然没有第二个 Interface。
 */
export function createPromptSink(
  rl: Interface,
  options: PromptSinkOptions,
): UiSink & { close(): void } {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  const palette = options.palette ?? createPalette(false);
  const out = options.out ?? process.stdout;
  // `Interface` 的**公开类型**没把 `input` 漏出来（运行时它就在实例上，正是
  // `createInterface` 传进去的那一个流）。菜单要的就是它的 raw 模式与按键事件。
  const input = (rl as unknown as { readonly input: RawInput }).input;

  /**
   * 逐行问（自由文本）。今天只有两个落点：菜单用不了的环境、以及不带选项的 `ask`。
   */
  const line = (question: string, ask: AskOptions | undefined): Promise<string> => {
    const answer = ask?.fallback ?? 'n';
    return new Promise<string>((resolve) => {
      const signal = options.signalOf();
      let settled = false;

      // 三条路都必须能收场，而且方向只能是"拒绝"：
      // - 用户答了 → 用他的答案；
      // - Ctrl-D / 流被关掉 → 拒绝值（读不到答案 = 没同意）；
      // - Ctrl-C 掐断了本 turn → 拒绝值。
      // 少了后两条，`rl.question` 的回调就永远不来，这个 await 把整个会话挂死 ——
      // 连 repl 里的 turns.end() 都跑不到，busy 永远停在 true。
      // （实测：close() 不会调用尚在挂起的 question 回调。）
      const settle = (value: string): void => {
        if (settled) return;
        settled = true;
        rl.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onClose = (): void => settle(answer);
      const onAbort = (): void => settle(answer);

      rl.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      // 已经 abort 过的 signal 不会补发事件，得自己查一次。
      if (signal.aborted) {
        settle(answer);
        return;
      }

      // 问什么由内核说（`执行 Edit?`），长什么样由界面说 —— 这个 `⏸` 是界面加的
      // （P6 设计 §3.1 的「等」那一态）。选项摊回一行文字，值还是内核认的那几个。
      rl.question(palette.bold(`⏸ ${question}${asText(ask)}`), (raw) => settle(raw));
    });
  };

  /**
   * 一屏菜单：上下键移动（`j`/`k` 同义）、回车选定、Esc / Ctrl-C / Ctrl-D 取消。
   * 选某一项也可以直接按它那个 `value` 的首字母 —— 旧的 `y` / `n` 手感不至于丢。
   *
   * 屏幕账目很简单：菜单永远画在**屏幕最下面**（画之前调用方刚 settle 过预览那一屏），
   * 画完光标停在块尾的下一行行首，于是重画就是"上移块高、逐行清掉再写"。
   */
  const menu = (question: string, ask: AskOptions): Promise<string> =>
    new Promise<string>((resolve) => {
      const choices = ask.choices;
      const signal = options.signalOf();
      let index = 0;
      let rows = 0;
      let settled = false;

      // ⚠️ 菜单期间 readline 自己的 keypress 监听必须摘掉。两边都收到按键的话，
      // 它会把上下键当**历史翻页**去翻，还会把字母键回显进它自己的行缓冲 ——
      // 那是终端里的重影，而且它翻的那一行用户根本看不见。摘掉之后 `line` 也不发，
      // 菜单上的按键不会被 REPL 的行队列收走。（原样装回去，见 settle。）
      const savedKeys = input.listeners('keypress') as unknown as Array<(...args: unknown[]) => void>;
      input.removeAllListeners('keypress');
      // 流必须一直在流：上游（readline 自己）闲下来时会 pause，而"按了键才收场"
      // 这条路上没有别的东西会再把它叫醒 —— 真 paused 了就是一个永远不来的 await。
      input.resume?.();
      // raw 模式：不吃掉终端自己的行缓冲，方向键才当场送得到，
      // 而且终端不再回显 —— 这一屏的画面完全由下面这个 paint 说了算。
      input.setRawMode?.(true);

      const paint = (): void => {
        // 每一行都先截到终端宽度内：折了行，屏幕上的行数就与下面那个 `rows` 不符，
        // `\u001b[<n>A` 上移立刻算错 —— 与活动区同一条硬要求（见 `width.ts`）。
        const width = activityWidth(out.columns);
        const lines = [
          palette.bold(`⏸ ${question}`),
          ...choices.map((choice, i) =>
            i === index
              ? `${palette.cyan('❯')} ${palette.bold(choice.label)}`
              : `  ${choice.label}`,
          ),
        ].map((line) => fitTo(line, width));
        // 上一次画的那几行先收回来：光标上移到块首，再逐行清掉重写。
        let frame = rows > 0 ? `\u001b[${rows}A` : '';
        frame += '\r';
        for (const drawn of lines) frame += `\u001b[K${drawn}\n`;
        rows = lines.length;
        out.write(frame);
      };

      // 两条收场路（`close` / `abort`）与按键走同一个落点。与 `line` 那条一样，
      // 监听**必须**在这里摘干净：rl 是整个会话活着的，一轮确认留一个
      // `close` 监听，几十轮下来就是一条 MaxListenersExceededWarning。
      const settle = (value: string, label: string | undefined): void => {
        if (settled) return;
        settled = true;
        rl.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
        input.removeListener('keypress', onKey);
        // 顺序要紧：先出 raw 模式，再把 readline 的监听装回去。反过来的话，
        // 装回去的那一个会在 raw 模式下先吃掉用户接下来的一个按键。
        input.setRawMode?.(false);
        for (const fn of savedKeys) input.on('keypress', fn as (...args: unknown[]) => void);
        if (rows > 0) {
          out.write(`\u001b[${rows}A\r\u001b[0J`);
          rows = 0;
        }
        // 选定那一项落成一行永久行：屏幕上留下"刚才问了什么、人挑了什么"。
        // 取消（Esc / Ctrl-C）不留 —— 那一屏本来就该像没出现过。
        if (label !== undefined) {
          out.write(`${palette.bold(`⏸ ${question}`)}  ${label}\n`);
        }
        resolve(value);
      };

      const onClose = (): void => settle(ask.fallback, undefined);
      const onAbort = (): void => settle(ask.fallback, undefined);

      const onKey = (chunk: string | undefined, key: Key | undefined): void => {
        if (key === undefined) return;
        if (key.name === 'up' || key.name === 'k') {
          index = (index + choices.length - 1) % choices.length;
        } else if (key.name === 'down' || key.name === 'j') {
          index = (index + 1) % choices.length;
        } else if (key.name === 'return' || key.name === 'enter') {
          const chosen = choices[index]!;
          settle(chosen.value, chosen.label);
          return;
        } else if (key.name === 'escape' || key.ctrl === true) {
          // Ctrl-C 还得让**整个 turn** 停下来，不能只把这一次调用拒掉：
          // 真终端里 ^C 是 readline 接住再在 rl 上抛 SIGINT 的，这里照它那条路走。
          // （raw 模式下终端自己不再产生 SIGINT，所以这一步不能省。）
          if (key.ctrl === true && key.name === 'c') rl.emit('SIGINT');
          settle(ask.fallback, undefined);
          return;
        } else {
          // 直接按某个选项的 value（`y` / `a` / `n`）＝选中它。
          const hit = choices.find((choice) => choice.value === (chunk ?? '').toLowerCase());
          if (hit === undefined) return;
          settle(hit.value, hit.label);
          return;
        }
        paint();
      };

      rl.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      // 已经 abort 过的 signal 不会补发事件，得自己查一次。
      if (signal.aborted) {
        onAbort();
        return;
      }

      input.on('keypress', onKey as (...args: unknown[]) => void);
      paint();
    });

  return {
    print: (line) => out.write(`${line}\n`),
    notice: (line) => process.stderr.write(`${line}\n`),

    ask: (question, ask) => {
      // 非交互环境没人能确认 —— 默认拒绝，不放行。
      if (!interactive) return Promise.resolve(ask?.fallback ?? 'n');

      // 确认提示落笔前先让调用方停 spinner（见 beforeAsk 的注释）。放在交互判定**之后**：
      // 非交互下这里根本不会画提示符，反倒往里插一个换行会污染管道输出。
      options.beforeAsk?.();

      // 有选项、而且输入面撑得起菜单（真 TTY 才有 setRawMode）→ 上下键选；
      // 否则退回逐行问，选项摊回一行文字。
      if (ask !== undefined && ask.choices.length > 0 && typeof input?.setRawMode === 'function') {
        return menu(question, ask);
      }
      return line(question, ask);
    },

    close: () => rl.close(),
  };
}

/** 菜单用不了时，选项摊回一行文字。值是内核认的那几个，不是文案。 */
function asText(ask: AskOptions | undefined): string {
  if (ask === undefined) return '';
  return ` (${ask.choices.map((choice) => `${choice.value}=${choice.label}`).join('  ')})`;
}
