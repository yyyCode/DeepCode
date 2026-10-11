// src/cli/walkdir.ts
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 目录遍历 + 名册的根：**三处**共用（插件、agent、技能）。
 *
 * 抽出来的理由不是省行数：三处的"读不了怎么办"必须是**同一个答案** ——
 * 否则一个坏掉的 `skills/` 目录会在一处静默、在另一处吼，用户看到的行为随风飘。
 *
 * ⚠️ 复用只到"遍历"这一层。`plugin-manifest.ts` 那个 JSON 清单校验器**不复用**
 * （设计 §4.3）—— 字段集与 frontmatter 完全不同，硬套会得到一个两边都不像的东西。
 */

/**
 * 读一层目录的原始条目。**不存在 → `undefined` 且不吭声**（常态）；
 * 在但读不了 → 吼一声 + `undefined`（这一层这次一个都不用）。
 */
async function listEntries(
  dir: string,
  what: string,
  warn: (line: string) => void,
) {
  try {
    // 显式写 `encoding: 'utf8'`：`readdir` 带 `withFileTypes` 时名字的类型跟着编码走，
    // 不写就落到 Buffer 那支重载上，`entry.name` 变成 NonSharedBuffer。
    return await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    warn(
      `${what} ${dir} 读不了（${error instanceof Error ? error.message : String(error)}）—— 这一层这次一个都不用。`,
    );
    return undefined;
  }
}

/** 目录下的子目录名，字典序。 */
export async function subdirectories(
  dir: string,
  what: string,
  warn: (line: string) => void,
): Promise<readonly string[]> {
  const entries = await listEntries(dir, what, warn);
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 目录下的 `.md` 文件名，字典序。错误行为与上一条完全一致。 */
export async function markdownFiles(
  dir: string,
  what: string,
  warn: (line: string) => void,
): Promise<readonly string[]> {
  const entries = await listEntries(dir, what, warn);
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

export type RosterRoot = {
  readonly origin: 'project' | 'user' | 'plugin';
  readonly dir: string;
  /** 插件级名册的名字前缀（`<插件名>:<name>`）。项目级/用户级没有。 */
  readonly namespace?: string;
};

/**
 * 名册该去哪些目录找，**按优先级从高到低**。三个来源的顺序是规则不是巧合（设计 §4.1/§4.2）：
 *
 * - 项目级赢用户级：与 settings、与插件目录同一个方向 —— "这个仓库要求用什么"
 *   比"我全局装过什么"更具体。
 * - 插件级排最后：它带命名空间，结构上撞不上；排最后只是让"先放的赢"在三个来源上
 *   是同一个答案。
 *
 * `home` 兜底成 `root` 时项目级与用户级是**同一个目录**（main.ts 的 home 默认值），
 * 那种情况下按用户级算，去重一次 —— 与 plugin-dir.ts 里那条同源。
 */
export function rosterRoots(deps: {
  readonly root: string;
  readonly home: string;
  readonly plugins: readonly { readonly name: string; readonly dir: string }[];
  /** `'agents'` 或 `'skills'`。 */
  readonly sub: string;
}): readonly RosterRoot[] {
  const projectDir = join(deps.root, '.deepcode', deps.sub);
  const userDir = join(deps.home, '.deepcode', deps.sub);

  const roots: RosterRoot[] =
    resolve(projectDir) === resolve(userDir)
      ? [{ origin: 'user', dir: userDir }]
      : [
          { origin: 'project', dir: projectDir },
          { origin: 'user', dir: userDir },
        ];

  for (const plugin of deps.plugins) {
    roots.push({ origin: 'plugin', dir: join(plugin.dir, deps.sub), namespace: plugin.name });
  }
  return roots;
}
