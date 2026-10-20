import { execFile } from 'node:child_process';
import type { ModDeps } from '@deepcode/contract/mod';
import type { Backend, BackendProbe, BackendWords, PaneEntry, PaneFileHunks } from './backend';
import type { DiffLine } from './lines';

/**
 * git 后端 —— **默认实现**，也是这个项目里第一个真可选依赖（P5 设计 §5.2。
 *
 * "git 不在就降级"这件事能被测，靠的是下面那个 `GitRunner` 是**注入**的：
 * 测试给假的，于是"600 个文件走退化路径"不必真造一个改了 600 个文件的仓库，
 * "拿掉 git"也不必真的改 PATH。
 */

/** 一次 git 调用的超时。卡住的 git 不该让 `/diff` 卡住。 */
export const GIT_TIMEOUT_MS = 5000;

/** 单次 git 输出的上限。超了 `execFile` 会报错，我们当"这次没拿到"处理。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 一个文件的 diff 超过这个字节数就不逐行给了 —— 看不了逐行与"太大"对用户是同一件事。 */
const MAX_HUNK_BYTES = 256 * 1024;

/**
 * pathspec 一次给多少个。
 *
 * 与参考实现的 `MAX_PATHSPEC_CHARS` 同一条：命令行有长度上限，
 * 一次塞 500 个路径会 `E2BIG`。分批只是慢一点，失败是另一回事。
 */
const MAX_PATHSPEC = 20;

export type GitResult = { readonly stdout: string; readonly exitCode: number };

/**
 * 跑一次 git。**注入**的。
 *
 * `exitCode` 而不是异常：git 用非零退出报告"这不是一个仓库"这类**正常**情况，
 * 把它变成异常会让调用方不得不用 try/catch 表达分支。
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/**
 * 真的跑 git。
 *
 * 三处细节都不是随手写的：
 * - `--no-optional-locks` 由调用方拼在参数里（见下）—— 不去跟用户正在跑的 git 抢索引锁；
 * - `signal` 给超时，一个在坏 NFS 上挂住的 git 不能把 `/diff` 一起挂住；
 * - `windowsHide`：Windows 上不闪一个黑框出来。
 */
const defaultRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        // git 的输出用 C locale 与固定宽度，免得本地化的状态词把解析带歪。
        env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat' },
      },
      (error, stdout) => {
        if (error) {
          resolve({ stdout: '', exitCode: typeof error.code === 'number' ? error.code : 1 });
          return;
        }
        resolve({ stdout, exitCode: 0 });
      },
    );
  });

/**
 * 探针：`git --version` 出得来就算有。
 *
 * 失败（没装、不在 PATH、没有执行权）一律 `false` —— 这里没有"探针自己坏了"这种情形，
 * 一行版本号问不出别的花样来。装不成的后果见 `cli/mods.ts`：这个 mod 不装，`/diff` 降级。
 */
export async function gitProbe(deps: ModDeps, run: GitRunner = defaultRunner): Promise<boolean> {
  const result = await run(['--version'], deps.root);
  return result.exitCode === 0;
}

export const GIT_WORDS: BackendWords = {
  name: 'git',
  clean: '工作区干净',
  empty: 'git 没有给出逐行改动（不是仓库，或者头一次提交之前）',
  degraded: (files, limit) =>
    `改了 ${files} 个文件，超过 ${limit} 个就不逐文件算了 —— 只列文件名与状态。`,
};

/**
 * 建一个 git 后端。`run` 可注入（测试与探针共用同一份）。
 *
 * 每一个调用都带 `--no-optional-locks`：用户可能同时在终端里跑 git，
 * 抢索引锁的代价是被 `index.lock` 挡住 —— 一个只读的 `/diff` 不该有这个副作用。
 */
export function createGitBackend(deps: ModDeps, run: GitRunner = defaultRunner): Backend {
  const cwd = deps.root;

  const list = async (): Promise<readonly PaneEntry[]> => {
    const result = await run(
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
      cwd,
    );
    // 非零退出 = 不是仓库 / git 抽风。两种都当"这里没有改动" —— `/diff` 是个只读视图，
    // 它报错没有任何人能处理，说"干净"至少不会骗人说有改动。
    if (result.exitCode !== 0) return [];
    return parsePorcelain(result.stdout);
  };

  const hunks = async (paths: readonly string[]): Promise<readonly PaneFileHunks[]> => {
    const out: PaneFileHunks[] = [];
    // 分批而不是一次给全：命令行长度有上限（见 MAX_PATHSPEC）。
    for (let i = 0; i < paths.length; i += MAX_PATHSPEC) {
      const batch = paths.slice(i, i + MAX_PATHSPEC);
      const result = await run(
        // `-U3` 与 `lines.ts` 的 CONTEXT 同口径；`--no-color` 是硬要求 ——
        // 带 ANSI 的文本进了 hunk 解析就全歪了（上色是 cli 侧的事，见 `diff-render.ts`）。
        ['--no-optional-locks', 'diff', '--no-color', '-U3', '--', ...batch],
        cwd,
      );
      const parsed = result.exitCode === 0 ? parseUnified(result.stdout) : new Map();
      for (const path of batch) {
        const found = parsed.get(path);
        out.push(
          found === undefined
            ? { path, lines: null, why: GIT_WORDS.empty }
            : found,
        );
      }
    }
    return out;
  };

  return { words: GIT_WORDS, list, hunks };
}

/**
 * `git status --porcelain -z` 的解析。
 *
 * `-z` 用 NUL 分隔且**不转义**路径 —— 带空格、带引号、带非 ASCII 的文件名在
 * 非 `-z` 那一种写法里会被 git 加引号并转义，那是这个解析器唯一真正会踩的坑。
 */
export function parsePorcelain(stdout: string): readonly PaneEntry[] {
  const out: PaneEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path === '') continue;
    out.push({ path, status: statusOf(code) });
  }
  return out;
}

function statusOf(code: string): PaneEntry['status'] {
  if (code === '??') return 'untracked';
  // 索引与工作区各一列（`XY`）。任一侧是 D/A 就按那个说 —— 一个文件不可能既新建又删除，
  // 所以这里的顺序不构成歧义。
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  return 'modified';
}

/**
 * `git diff` 输出的解析：一个路径 → 它的逐行改动。
 *
 * 只看三种前缀（`+` / `-` / 空格）与 `diff --git` 这两处 —— hunk 头（`@@`）、
 * `index`、`---` / `+++` 全部跳过。这就是"够用"与"完整"之间的取舍：
 * 我们不需要行号（表头给总数就够），也就不必把 `@@` 那几个数字算进 `DiffLine[]` 里。
 */
export function parseUnified(stdout: string): Map<string, PaneFileHunks> {
  const out = new Map<string, PaneFileHunks>();
  let path: string | undefined;
  let lines: DiffLine[] = [];

  const flush = (): void => {
    if (path === undefined) return;
    out.set(path, { path, lines });
  };

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush();
      path = pathFromDiffHeader(raw);
      lines = [];
      continue;
    }
    if (path === undefined) continue;
    // 文件级元信息。`--- a/x` 与 `+++ b/x` 紧跟在 `diff --git` 后面，
    // 不特判的话它们会被当成两行删/增，每个文件凭空多出两行改动。
    if (
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('@@') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename from') ||
      raw.startsWith('rename to') ||
      raw.startsWith('Binary files')
    ) {
      continue;
    }
    if (raw.startsWith('\\')) continue; // `\ No newline at end of file`
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) lines.push({ kind: 'context', text: raw.slice(1) });
    // 其余（空行等）忽略：`git diff` 不产生它们，而猜一个含义不如不猜。
  }
  flush();

  // 太大的那些不逐行给。放在解析**之后**是因为"大不大"要看真实行数，
  // 而 `git diff` 没有"只报大小"的开关 —— 这一处的代价是已知的、可接受的。
  for (const [key, value] of out) {
    const bytes = (value.lines ?? []).reduce((sum, line) => sum + line.text.length + 1, 0);
    if (bytes > MAX_HUNK_BYTES) {
      out.set(key, { path: key, lines: null, why: '文件太大，没逐行给' });
    }
  }
  return out;
}

/**
 * `diff --git a/<old> b/<new>` → 新路径。
 *
 * 路径里有空格时这行是没法可靠地按空格切的，所以只看第一个 ` b/` 之后的部分；
 * 找不到就返回 `undefined`（这个文件整个不要了 —— 猜一个路径出来比丢掉更糟）。
 */
function pathFromDiffHeader(line: string): string | undefined {
  const marker = line.indexOf(' b/');
  if (marker < 0) return undefined;
  const path = line.slice(marker + 3);
  return path === '' ? undefined : path;
}
