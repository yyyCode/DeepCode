import { readFile } from 'node:fs/promises';

/**
 * 读一个文本文件。两种失败必须分得开：
 * - 返回 `undefined` = 文件**不存在**（正常，绝大多数机器没有托管文件）
 * - **抛** = 文件存在但读不了（权限、是个目录、编码）—— 这一条是设计里唯一的 fail-open，要吼
 *
 * P5d 把它从 `settings.ts` 挪出来：托管通道（`managed.ts`）也要读文件，而
 * `settings.ts` 要 import `managed.ts`（拿托管那一段文本）—— 留在原地就是一个
 * 循环。挪进一个叶子模块，两边都 import 它，`settings.ts` 原样再导出一次
 * （既有 import 一处都不用改，与 P5a 把 `TelemetryPolicy` 挪进契约同一条做法）。
 */
export type TextReader = (path: string) => Promise<string | undefined>;

export const defaultTextReader: TextReader = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // 只有"不存在"算正常（绝大多数机器没有托管文件）。
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    // 其余一律抛出去。
    // ⚠️ 这里曾经是 `if (!existsSync(path)) return undefined` —— 一个把自己的承诺反过来的
    // 短路：existsSync 在"文件在、但 stat 过来被拒"时也返回 false，于是 EACCES 这类
    // "存在但读不了"被伪装成"没这个文件"，整层静默作废。而这是托管策略所在的层 ——
    // 恰恰是设计里最不能安静的那一层。
    throw error;
  }
};
