import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 输入历史（P6d）：`~/.deepcode/history`。
 *
 * **与转录同一条安全规矩**：用户级 home、权限 0600。理由与那份一模一样 ——
 * 历史里装的是用户敲过的话，而敲进去的往往是代码。规矩定过一次就得一以贯之，
 * 不能因为"这只是输入"就把它放进项目目录（那样它会跟着 git 走）。
 *
 * `/clear` **不动它**：清的是上下文，不是"我敲过什么"。
 *
 * ## 为什么把它做成"活的数组"交给 readline
 *
 * 上下键是 readline 自己的事（`history` / `historySize` 两个建实例时的选项），
 * 而它就地 `unshift` 到传进去的那个数组上。所以这里交出 `entries` **本身**，
 * 不再另记一份：两本账的话，存下去的与上键翻出来的迟早不是一回事。
 * 代价是确认提示上敲的 `y` 也会进历史 —— 与 shell 里敲 `y` 会进历史同一种形状，
 * 不值得为它造一套过滤。
 */

/** 留最近这么多条。再多也只是把上键按得更久。 */
export const HISTORY_LIMIT = 500;

export function historyPath(home: string): string {
  return join(home, '.deepcode', 'history');
}

export type History = {
  /** 最近的在**前**（readline 的 `rl.history` 就是这个顺序），readline 就地往里加。 */
  readonly entries: string[];
  /** 落盘。写失败只喊一声，不抛 —— 历史丢了不影响干活（与转录落盘同一条）。 */
  save(): Promise<void>;
};

/**
 * 读一份历史（不存在就从头开始）。
 *
 * 读失败**不是故障**：第一次跑没有这个文件，读不动也只少了几条上键。
 * 与转录落盘失败同一条降级原则（设计 §2.5）。
 */
export async function loadHistory(home: string, warn: (line: string) => void): Promise<History> {
  const path = historyPath(home);
  // 文件里是**时间序**（一行一条，老的在前），readline 要的是最近在前。
  let entries: string[] = [];
  try {
    entries = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .slice(-HISTORY_LIMIT)
      .reverse();
  } catch {
    entries = [];
  }

  return {
    entries,

    async save() {
      if (entries.length === 0) return;
      try {
        await mkdir(dirname(path), { recursive: true });
        // `mode: 0o600` 与转录那份同一个理由（Windows 基本忽略，但不吃亏）。
        await writeFile(path, `${[...entries].reverse().join('\n')}\n`, { mode: 0o600 });
      } catch (error) {
        warn(`历史没写进 ${path}（${String(error)}），下次上键就少几条。`);
      }
    },
  };
}
