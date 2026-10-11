import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ResolvedHookGroup } from '../contract/classic';
import type { On, Plugin } from '../contract/plugin';
import { validatePlugin, type PluginManifest, type PluginReader } from '../contract/plugin-manifest';
import { registerHooks } from './classic-hooks';
import { subdirectories } from './walkdir';

/**
 * 插件目录的发现与装载。
 *
 * **两段，不是一个函数**，这是这个文件最要紧的结构：
 * - `discoverPlugins` 读清单（**不执行任何代码**）
 * - `installPlugins` import 入口（执行代码）
 *
 * ⚠️ 目录有**三个来源**，不是两个：项目级、用户级，以及 `plugin add` 装进来的落点。
 * 三者的闸门不一样：项目级要 `plugins.enable`、用户级自动装载、落点要**用户级的**
 * `plugins.enable`（`enabledInstalled`）。前两者的语义自 P3 起一个字没改。
 *
 * `deepcode plugin list` 与 `validate` 只做前者。列个清单不该执行别人的代码 ——
 * 这条分界线让"看一眼"这个动作在安全上是平凡的。
 *
 * ⚠️ 而 `installPlugins` 里的那一行 `import` 就是"装一个插件 = 信任它"的全部。
 * 准入闸门管的是**链上权威**（谁能放宽权限），不是"这段代码能不能跑" ——
 * 把插件目录放进去，就是让它以你的身份跑。参考实现也是这个语义（设计 §4.6）。
 */

export type PluginOrigin = 'user' | 'project' | 'installed';

export type DiscoveredPlugin = {
  readonly name: string;
  readonly dir: string;
  readonly origin: PluginOrigin;
  readonly manifest: PluginManifest;
  /** 入口模块的相对路径。没有入口（只有钩子）时是 undefined。 */
  readonly entry: string | undefined;
  readonly hooks: readonly ResolvedHookGroup[];
};

export type SkippedPlugin = {
  readonly dir: string;
  readonly origin: PluginOrigin;
  /** 清单本身就坏时点不了名。 */
  readonly name: string | undefined;
  readonly reason: string;
};

export type Discovery = {
  /** 装得上的，按名字字典序。 */
  readonly loaded: readonly DiscoveredPlugin[];
  /** 没装的，每条带理由 —— `plugin list` 直接把这张表打出来。 */
  readonly skipped: readonly SkippedPlugin[];
};

export type DiscoverDeps = {
  readonly home: string;
  readonly root: string;
  /**
   * 项目级目录里哪几个被显式启用了（来自五层合并后的 `plugins.enable`）。
   * **用户级不受它管**：用户级一律自动装载 —— 那是"我自己装的插件"，
   * 与"这个仓库要求我装什么"是两件事（设计 §3）。
   */
  readonly enabled: readonly string[];
  /**
   * 装进来的那一层（落点）要哪几个名字启用。**只认用户层**，理由见设计 §0 决策 3：
   * 把落点并进同一个名单，别人仓库里的 settings.json 就能按名字点亮你全局装着的插件。
   *
   * 可选而不是必填，两个理由：默认值 fail-closed（不给 = 一个都不开），
   * 以及既有十几处 `{ ...world, enabled: [] }` 的调用点不用全改。
   */
  readonly enabledInstalled?: readonly string[];
  readonly warn?: (line: string) => void;
};

/**
 * 用户自己放插件的目录。项目级与用户级共用这个相对路径。
 */
const USER_DIR = ['.deepcode', 'plugins'] as const;

/**
 * 落点：`plugin add` 装进来的地方。
 *
 * 它与 `USER_DIR` 只差一个词，但语义完全不同 —— **不参与自动装载**：
 * 这个目录里的插件要**用户级**设置显式 `plugins.enable` 才跑（设计 §0 决策 2）。
 * 常量名与 origin 名相同是特意选的：读代码时两个词指同一件事，不用在脑子里做映射。
 */
export const INSTALLED_DIR = ['.deepcode', 'installed'] as const;

/**
 * 落盘的暂存目录。
 *
 * **它必须是落点的兄弟节点**（同在 `~/.deepcode/` 下），不能放进落点里 ——
 * `subdirectories()`（`walkdir.ts:38-49`）的过滤条件**只有 `entry.isDirectory()`，
 * 没有任何名字规则**：不排点开头、不排 `.tmp`、什么都不排。所以落点里的任何临时目录
 * 在拷贝窗口内都会被 `plugin list` 当成一个坏插件扫出来。
 * 选这儿还因为它与落点**同一个文件系统**（都在 `~/.deepcode/` 下），
 * 于是 `rename` 是真原子动作；换成系统临时目录就退化成跨设备的拷贝，那还不如不原子。
 */
export const STAGING_DIR = ['.deepcode', '.installed-staging'] as const;

/**
 * 把一个插件目录包成 `PluginReader`。
 *
 * 只做拼接，不做边界检查 —— 越界的路径在校验器里就被 `isSafeRelativePath` 拦下了，
 * 这里只会收到通过检查的路径（外加清单校验器自己那几个字面量常量）。
 */
export function dirReader(dir: string): PluginReader {
  return {
    async read(relative) {
      // 与 settings.ts 的 TextReader 同一条区分：不存在返回 undefined 是常态，
      // 存在但读不了要抛 —— 后者可能是有人故意藏了个读不了的东西。
      try {
        return await readFile(join(dir, relative), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async exists(relative) {
      try {
        await stat(join(dir, relative));
        return true;
      } catch {
        // 读不了也算"这儿没东西"：最坏的后果是报一条 E8「路径不存在」，
        // 而不会把"存在但读不了"悄悄放过去。
        return false;
      }
    },
  };
}

export async function discoverPlugins(deps: DiscoverDeps): Promise<Discovery> {
  const warn = deps.warn ?? (() => {});
  const enabledInstalled = deps.enabledInstalled ?? [];
  const projectDir = join(deps.root, ...USER_DIR);
  const userDir = join(deps.home, ...USER_DIR);
  const installedDir = join(deps.home, ...INSTALLED_DIR);

  // 顺序：project > user > installed。既有两级的相对顺序与语义一个字不改；
  // 中介最多的那个来源排最后 —— 同名冲突时，更**直接**的那个赢
  // （下面 `claimed` 那张表在做这件事，语义照旧）。
  //
  // 落点与前两者不会撞路径：`INSTALLED_DIR` 与 `USER_DIR` 是两个目录名，
  // 所以这里不需要去重。
  const roots: readonly { origin: PluginOrigin; dir: string }[] = [
    ...(resolve(projectDir) === resolve(userDir)
      ? // home 兜底成 root 时两个目录是同一个（main.ts 的 home 默认值）。那种情况下
        // 按用户级算：它本来就是"我自己装的那个目录"，没有"这个仓库要求"可言。
        [{ origin: 'user', dir: userDir } as const]
      : [
          { origin: 'project', dir: projectDir } as const,
          { origin: 'user', dir: userDir } as const,
        ]),
    // 落点永远单独一个来源。它跟谁都不共目录，闸门也是另一份名单。
    { origin: 'installed', dir: installedDir },
  ];

  const loaded: DiscoveredPlugin[] = [];
  const skipped: SkippedPlugin[] = [];
  const claimed = new Map<string, PluginOrigin>();

  for (const { origin, dir } of roots) {
    for (const name of await subdirectories(dir, '插件目录', warn)) {
      const pluginDir = join(dir, name);
      const validated = await validatePlugin(`插件目录 ${pluginDir}`, dirReader(pluginDir));

      for (const problem of validated.problems) {
        warn(
          `${problem.level === 'error' ? '✖' : '⚠'} ${pluginDir}：${problem.code} ${problem.message}`,
        );
      }

      if (!validated.ok || validated.manifest === undefined) {
        const first = validated.problems.find((problem) => problem.level === 'error');
        skipped.push({
          dir: pluginDir,
          origin,
          name: undefined,
          reason: first === undefined ? '装不上' : `${first.code} ${first.message}`,
        });
        continue;
      }

      const manifest = validated.manifest;
      // user 级不受任何名单管；其余两级各有一份：项目级那份来自五层合并的
      // `plugins.enable`，落点那份只认**用户层**设置（设计 §0 决策 3）。
      const enabledNames = origin === 'installed' ? enabledInstalled : deps.enabled;
      if (origin !== 'user' && !enabledNames.includes(manifest.name)) {
        skipped.push({
          dir: pluginDir,
          origin,
          name: manifest.name,
          reason:
            origin === 'project'
              ? `项目级插件要显式启用：在 .deepcode/settings.json 里写 plugins.enable: ["${manifest.name}"]`
              : `装进来的插件只能由用户级设置启用：在 ~/.deepcode/settings.json 里写 plugins.enable: ["${manifest.name}"]（项目级设置里写同一个名字不算数）`,
        });
        continue;
      }

      const owner = claimed.get(manifest.name);
      if (owner !== undefined) {
        skipped.push({
          dir: pluginDir,
          origin,
          name: manifest.name,
          reason: `同名插件已由 ${owner} 级目录提供，这一份没用上`,
        });
        continue;
      }

      claimed.set(manifest.name, origin);
      loaded.push({
        name: manifest.name,
        dir: pluginDir,
        origin,
        manifest,
        entry: validated.entry,
        hooks: validated.hooks,
      });
    }
  }

  // 装载顺序 = 名字字典序。目录枚举顺序跨平台不保证，而"同 tier 内先装载者在外层"
  // 是条真规则 —— 用一个稳定的顺序换掉一个不稳定的顺序，让链的行为可预测。
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return {
    loaded: loaded.sort(byName),
    skipped: skipped.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)),
  };
}

export type InstallDeps = {
  /** 工作目录，也是 `${CLAUDE_PROJECT_DIR}`。今天等于会话根目录，分开写是为了不让巧合变成前提。 */
  readonly projectDir: string;
  readonly session: { readonly id: string; readonly transcriptPath: string | undefined };
  readonly env: NodeJS.ProcessEnv;
  readonly warn?: (line: string) => void;
};

/**
 * 把发现的插件变成真的 `Plugin`：入口模块与 `hooks.json` 在这里合流。
 *
 * 合流的意义不只是方便：两者共用**一个插件名、一个 `register`**，于是也共用
 * `uses` 检查与"剥掉 allow"那两道闸（设计 §5.0）。
 */
export async function installPlugins(
  discovered: readonly DiscoveredPlugin[],
  deps: InstallDeps,
): Promise<readonly Plugin[]> {
  const warn = deps.warn ?? (() => {});
  const out: Plugin[] = [];

  for (const item of discovered) {
    let entryRegister: ((on: On) => void) | undefined;

    if (item.entry !== undefined) {
      const file = join(item.dir, item.entry);
      try {
        const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
        entryRegister = readRegister(loaded.default, item.name, warn);
      } catch (error) {
        warn(
          `插件 ${item.name} 的入口 ${file} 装不上（${error instanceof Error ? error.message : String(error)}）—— 整个插件不装。`,
        );
      }
      // 一个出口管两条路：import 抛异常时 entryRegister 压根没被赋值，
      // 入口在但不合格时 readRegister 已经吼过 —— 两条都是"整个插件不装，没有半个插件"。
      // （原先 catch 里还有一条自己的 `continue`，与这一句完全等价，删了。）
      if (entryRegister === undefined) continue;
    }

    out.push({
      name: item.name,
      uses: item.manifest.uses,
      register(on) {
        entryRegister?.(on);
        registerHooks(on, {
          plugin: item.name,
          dir: item.dir,
          groups: item.hooks,
          cwd: deps.projectDir,
          projectDir: deps.projectDir,
          session: deps.session,
          env: deps.env,
        });
      },
    });
  }

  return out;
}

/** 入口模块的默认导出必须是个带 `register` 函数的对象。其余一律装不上。 */
function readRegister(
  value: unknown,
  name: string,
  warn: (line: string) => void,
): ((on: On) => void) | undefined {
  if (typeof value !== 'object' || value === null) {
    warn(`插件 ${name} 的入口没有默认导出对象（要 \`export default { register }\`）。`);
    return undefined;
  }
  const module = value as Record<string, unknown>;
  if (typeof module.register !== 'function') {
    warn(`插件 ${name} 的入口对象上没有 register 函数。`);
    return undefined;
  }
  // 自述的名字被点名，但**以清单为准**：名字决定座位归属与 uses 判定，
  // 不能让被审对象自己说我是谁（设计 §2.2）。
  if (module.name !== undefined && module.name !== name) {
    warn(
      `插件 ${name} 的入口自述名字是 ${JSON.stringify(module.name)} —— 以清单为准，名字不能自述。`,
    );
  }
  const register = module.register as (this: unknown, on: On) => void;
  // 用 .call(module)：插件把 register 写成方法、里头用 this 的话，剥出来单调用会当场炸。
  return (on) => register.call(module, on);
}
