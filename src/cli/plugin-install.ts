import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isPluginName } from '../contract/plugin-manifest';
import { INSTALLED_DIR, STAGING_DIR } from './plugin-dir';

/**
 * 把一份插件从 marketplace 拷进落点。
 *
 * **这个文件是唯一往 `~/.deepcode/installed/` 写东西的地方**（唯一一条 `rm -rf` 也是）。
 * 所以三条约束都收在这里，不散到调用方去：
 *
 * 1. **名字先过 `isPluginName`**。名字直接参与拼路径 —— 不守这一条的话，
 *    `plugin remove ../../x` 就是一条删除任意目录的命令。
 * 2. **目标已存在一律拒绝**。覆盖掉的到底是什么不容易看，而多一个 `--force`
 *    就是多一条需要人判断的歧义；先 `remove` 是显式的，也是一步就能做完的。
 * 3. **先写暂存、再 `rename`**。中断（Ctrl-C、磁盘满、权限失败）不许留下半个插件目录 ——
 *    那半个下次会被发现层当成一个坏插件报出来，而到那时没人知道它是从哪来的。
 *    暂存目录是**落点的兄弟节点**，理由见 `plugin-dir.ts` 的 `STAGING_DIR`。
 */

export type LandResult =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly error: string };

/** 落点的绝对路径。`remove` 与它共用同一个算式 —— 两处各写一遍就会漂。 */
export function installedPath(home: string, name: string): string {
  return join(home, ...INSTALLED_DIR, name);
}

export async function landPlugin(
  home: string,
  name: string,
  sourceDir: string,
): Promise<LandResult> {
  if (!isPluginName(name)) {
    return { ok: false, error: `${JSON.stringify(name)} 不是合法的插件名（kebab-case），没有碰任何路径。` };
  }

  const target = installedPath(home, name);
  if (await exists(target)) {
    return { ok: false, error: `${target} 已经在了 —— 先 deepcode plugin remove ${name}，再装。` };
  }

  const staging = join(home, ...STAGING_DIR, name);
  // 上一次崩在半路留下的暂存目录要清掉：不清的话 cp 会往里面摞东西，
  // 而摞出来的东西看起来完全正常 —— 那是最坏的一种"装上了"。
  await rm(staging, { recursive: true, force: true });

  try {
    await mkdir(join(home, ...STAGING_DIR), { recursive: true });
    // dereference: false —— 符号链接原样拷，不跟随。不做额外处理，理由是插件本来就是
    // "以你的身份跑的代码"：它读得到的东西你本来也读得到，跟随链接换不来任何新权限。
    await cp(sourceDir, staging, { recursive: true, dereference: false });
    await mkdir(join(home, ...INSTALLED_DIR), { recursive: true });
    // 暂存与落点是兄弟节点（同一个文件系统）→ 这是真原子动作。
    await rename(staging, target);
  } catch (error) {
    // 失败不许留残骸。
    await rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      error: `${target} 没装上（${error instanceof Error ? error.message : String(error)}）—— 落点里没有留下任何东西。`,
    };
  }

  return { ok: true, dir: target };
}

export async function removePlugin(home: string, name: string): Promise<LandResult> {
  if (!isPluginName(name)) {
    return { ok: false, error: `${JSON.stringify(name)} 不是合法的插件名（kebab-case），没有碰任何路径。` };
  }

  const target = installedPath(home, name);
  if (!(await exists(target))) {
    return { ok: false, error: `${target} 里没有这个插件 —— 落点里没有 ${JSON.stringify(name)} 这个名字。` };
  }

  await rm(target, { recursive: true, force: true });
  return { ok: true, dir: target };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
