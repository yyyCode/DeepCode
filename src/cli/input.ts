import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Interface } from 'node:readline';

/**
 * 输入层（P6d）。三件事都只跟"用户敲了什么"有关，与"屏幕上画什么"无关。
 *
 * ## 1. 行队列：补上那段空窗
 *
 * readline 只在有 `question` 挂着时才把行交给回调；其余的行以 `line` 事件发出去，
 * **没人听就丢掉**（实测：先挂 `line` 监听再 `question`，两种情况各归各的，不重复）。
 * 而 `main.ts` 从建 rl 到 REPL 开始读之间有一大段 await（读设置、建转录、发现插件），
 * 管道里的输入正好落在那段空窗里 —— `echo '/diff' | deepcode` 当时什么都不会发生，
 * 那正是这个队列要修的那一条（P6d 之前记在 README 的「已知限制」里，修掉之后那条就删了）。
 * 队列在 rl 一建好就挂上监听，于是**从那一刻起的每一行都留得住**。
 *
 * ## 2. 去抖：粘贴的多行不能变成多次提交
 *
 * 粘贴 10 行代码进 REPL，readline 会逐行发 `line`，每一行都可能变成一次提交 ——
 * 而其中任何一次都可能让模型去改文件。这不是"体验问题"。同一批（窗口内的）行合并成
 * 一批交出去。窗口 30ms：太短会把一次粘贴拆开，太长会把用户连着敲的两行粘在一起。
 *
 * ## 3. 摊平：一批行 → 依次要做的事
 *
 * 见 `planItems`：命令就地切开，其余攒成**一条**正文。
 */

/** 去抖窗口。粘贴的行是连着来的，30ms 足够把一次粘贴收成一批。 */
export const DEBOUNCE_MS = 30;

export type LineQueue = {
  /**
   * 下一批行。**只有一个消费者**（REPL）—— 同一条流上的确认提示走 `rl.question`，
   * 两者互不抢行（见本文件顶部）。
   *
   * EOF（Ctrl-D / 流关掉）且没有攒下的行时给 `null`。
   */
  next(): Promise<readonly string[] | null>;
};

export type LineQueueOptions = {
  /** 去抖窗口。测试给 0 —— 同一个 tick 里到达的行仍然会合成一批（`setTimeout(…, 0)`）。 */
  readonly windowMs?: number;
};

export function createLineQueue(rl: Interface, options: LineQueueOptions = {}): LineQueue {
  const windowMs = options.windowMs ?? DEBOUNCE_MS;
  const buffered: string[] = [];
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiter: ((batch: readonly string[] | null) => void) | undefined;

  /** 有人等着、而且有东西可给，就交出去。EOF 且队列空 → `null`。 */
  const hand = (): void => {
    if (waiter === undefined) return;
    if (buffered.length === 0 && !closed) return;
    const resolve = waiter;
    waiter = undefined;
    resolve(buffered.length === 0 ? null : buffered.splice(0, buffered.length));
  };

  const fire = (): void => {
    timer = undefined;
    hand();
  };

  rl.on('line', (line: string) => {
    buffered.push(line);
    // **每一批只起一个定时器**：粘贴的行是连着来的（readline 把一个 chunk 拆成多行、
    // 在同一个 tick 里发完），所以第一个定时器到点时那一批已经全到齐了。
    // 每来一行就重设窗口的话，一次长粘贴会把窗口一路往后推，反而更晚才交出去。
    if (timer === undefined) timer = setTimeout(fire, windowMs);
  });

  rl.on('close', () => {
    // EOF：把攒下的行先交出去（用户敲过的东西不许丢），下一次问才给 `null`。
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    hand();
  });

  return {
    next: () =>
      new Promise<readonly string[] | null>((resolve) => {
        // 空窗期攒下的行（也可能是一批已经到点的）：立刻给。
        if (buffered.length > 0 && timer === undefined) {
          resolve(buffered.splice(0, buffered.length));
          return;
        }
        if (closed && buffered.length === 0) {
          resolve(null);
          return;
        }
        waiter = resolve;
      }),
  };
}

export type InputItem =
  | { readonly kind: 'command'; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: 'prompt'; readonly text: string; readonly more: boolean };

/**
 * 一批行摊成"要依次做的事"。
 *
 * 两条规则：
 * - **`/` 开头的行是命令，就地切开**：它前面攒下的正文先提交，自己再当命令跑。
 *   于是 `printf '/diff\n/exit\n' | deepcode` 这种脚本不会被合成一次多行提交
 *   （那会把 `/exit` 变成 `/diff` 的一个参数，命令就丢了）。
 * - 其余的行攒成**一条**正文，用换行连起来 —— 粘贴 10 行代码是一次提交，不是 10 次。
 *
 * 行尾的 `\` 是"还有下一行"：批里还有下一行就就地接上（换行保留 —— 用户要的是
 * 多行正文，不是把两行焊成一行），没有了就给 `more: true`，调用方接着问。
 */
export function planItems(lines: readonly string[]): readonly InputItem[] {
  const items: InputItem[] = [];
  let body: string[] = [];

  const flush = (): void => {
    if (body.length === 0) return;
    items.push({ kind: 'prompt', ...foldContinuation(body) });
    body = [];
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    // 空行不进正文（与 P6 之前一致：敲一个空行是"我不想说什么"，不是提交一个空提示）。
    if (trimmed === '') continue;

    if (trimmed.startsWith('/')) {
      flush();
      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      items.push({ kind: 'command', name: name ?? '', args });
      continue;
    }
    body.push(raw);
  }
  flush();
  return items;
}

/** `text` 是攒好的正文，`more` = 最后一行以 `\` 结尾（调用方接着问下一行）。 */
function foldContinuation(lines: readonly string[]): { text: string; more: boolean } {
  const out: string[] = [];
  let more = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.endsWith('\\')) {
      out.push(line);
      continue;
    }
    // 行尾的 `\` 只表示"还有下一行"，本身不是内容。
    out.push(line.slice(0, -1));
    if (i === lines.length - 1) more = true;
  }

  return { text: out.join('\n'), more };
}

/** readline 要的形状：`[补全候选, 被替换掉的那一截]`。 */
export type Completer = (line: string) => readonly [readonly string[], string];

export type CompleterOptions = {
  /** 命令名册。**现取**（`$.command.list()`），不另抄一份 —— 抄的那份迟早落后。 */
  readonly commands: () => readonly string[];
  readonly cwd: string;
  /** 注入的目录读取（测试用）。默认真的读磁盘，只读 `cwd` 里面。 */
  readonly readDir?: (dir: string) => readonly string[];
};

/**
 * `/` 补命令名，`@` 补**当前工作目录内**的相对路径。
 *
 * `@` 这一条的边界是刻意的：只扫 cwd，不读用户主目录、不跨盘符、不往上走。
 * 用户可以自己敲出任何路径 —— 但"他自己敲得出来"与"我们主动列给他"是两件事，
 * 后者要有理由（P6 设计 §6.3）。这与"没有路径围栏"不是一回事：围栏是**拦**，
 * 这里只是**不主动铺路**。
 *
 * 同步实现（`readdirSync`）：readline 的 completer 是同步的，而这里读的
 * 至多一个目录、还是用户按 Tab 的那一刻，不值得为它铺一条异步的路。
 */
export function createCompleter(options: CompleterOptions): Completer {
  const readDir = options.readDir ?? listDir;

  return (line) => {
    if (line.startsWith('/')) {
      // 已经敲了空格说明在写参数，补不了名字。`@` 可以出现在正文里，`/` 不行。
      if (line.includes(' ')) return [[], line];
      const prefix = line.slice(1);
      return [
        options
          .commands()
          .filter((name) => name.startsWith(prefix))
          .map((name) => `/${name}`),
        line,
      ];
    }

    const at = line.lastIndexOf('@');
    if (at < 0) return [[], line];

    const typed = line.slice(at + 1);
    if (typed.includes(' ')) return [[], line];
    const slash = typed.lastIndexOf('/');
    const dir = slash < 0 ? '' : typed.slice(0, slash + 1);
    const head = slash < 0 ? typed : typed.slice(slash + 1);
    const base = line.slice(0, at + 1); // 含那个 `@`

    // `..` 与绝对路径都挡住：补全只铺 cwd 里的路。
    if (escapes(options.cwd, dir)) return [[], line];

    return [
      readDir(join(options.cwd, dir))
        .filter((name) => name.startsWith(head))
        .map((name) => `${base}${dir}${name}`),
      line,
    ];
  };
}

function escapes(cwd: string, dir: string): boolean {
  const inside = relative(cwd, resolve(cwd, dir));
  return inside.startsWith('..');
}

/** 默认的目录读取：隐藏项不列（不主动铺路），目录带尾斜杠好接着往下敲。 */
function listDir(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    // 读不动（不存在、没权限、不是目录）就是"没有候选"，不是错误。
    return [];
  }
}
