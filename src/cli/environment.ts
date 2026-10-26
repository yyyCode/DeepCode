import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 环境探测（P13）。放在单独的文件里，因为它是**唯一碰盘**的那一部分：
 * `prompt-text.ts` 只负责把观测结果渲染成文本，纯函数好测。
 */

/**
 * 从 `start` 向上找 `.git`（目录或文件都算 —— worktree 的 `.git` 是一个文件）。
 * 找不到返回 false。不抛：读不动一个目录只说明"这里没有"，不是故障。
 */
export async function isGitRepo(start: string): Promise<boolean> {
  let dir = start;
  for (;;) {
    try {
      await access(join(dir, '.git'));
      return true;
    } catch {
      // 继续往上。
    }
    const parent = dirname(dir);
    // Windows 的 `C:\` 与 POSIX 的 `/` 都会在这一步等于自己。
    if (parent === dir) return false;
    dir = parent;
  }
}

/** `SHELL` → `ComSpec` → 平台默认。只取文件名，不把整条路径塞进提示。 */
export function shellName(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const raw = env.SHELL ?? env.ComSpec ?? env.COMSPEC;
  if (raw !== undefined && raw !== '') {
    // 两种分隔符都认。`node:path.basename` 跟随**运行平台**：Linux 上它不把 `\`
    // 当分隔符，`C:\Windows\system32\cmd.exe` 会整条返回。环境变量可能来自另一个
    // 平台（WSL、跨平台测试 fixture、CI 上的 `ComSpec` 断言）。
    const parts = raw.split(/[\\/]/);
    return parts[parts.length - 1] || raw;
  }
  return platform === 'win32' ? 'cmd.exe' : 'sh';
}

export function platformLabel(platform: string = process.platform): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * 本地日期（YYYY-MM-DD），**不用** `toISOString()`：那是 UTC，
 * 东八区 23:30 会被写成第二天，模型讨论「今天」时就会差一天。
 */
export function todayLabel(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
