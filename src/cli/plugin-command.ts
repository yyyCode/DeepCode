import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { validateMarketplace, type MarketplaceEntry } from '../contract/marketplace';
import type { PluginManifest, Problem } from '../contract/plugin-manifest';
import { validatePlugin } from '../contract/plugin-manifest';
import type { StartupAction } from './args';
import {
  dirReader,
  discoverPlugins,
  INSTALLED_DIR,
  type DiscoveredPlugin,
  type Discovery,
  type PluginOrigin,
} from './plugin-dir';
import { landPlugin, removePlugin } from './plugin-install';

/**
 * `deepcode plugin list` 与 `deepcode plugin validate <目录>`。
 *
 * 两条都**不执行任何插件的代码** —— `discoverPlugins` 只读清单，`validatePlugin` 是纯逻辑。
 * 这条分界线不是洁癖：它让"看一眼这个插件是什么"在安全上是平凡的，而
 * `deepcode plugin list` 是第一个会被人对着一个陌生目录敲的命令。
 *
 * validate 会把 `hooks.json` 里的命令**原文**打出来。这不是装饰：装一个插件 =
 * 信任它（代码在你的进程里跑），而 validate 能做到的下限就是让你在装之前看见
 * 它想跑什么。看不见的信任不叫信任，叫不知情。
 */

export type PluginAction = Extract<StartupAction, { kind: 'plugin' }>;

export type PluginCommandDeps = {
  readonly action: PluginAction;
  readonly home: string;
  readonly root: string;
  /** 五层合并后的 `plugins.enable`（只有项目级的发现需要它）。 */
  readonly enabled: readonly string[];
  /** 只有**用户层**的名单 —— 落点只认这一层（设计 §0 决策 3）。 */
  readonly enabledByUser: readonly string[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** 返回进程退出码 —— 子命令要能进脚本，所以失败必须有非零码。 */
export async function runPluginCommand(deps: PluginCommandDeps): Promise<number> {
  if (deps.action.sub === 'help') {
    deps.out(PLUGIN_HELP);
    return 0;
  }
  if (deps.action.sub === 'list') {
    const found = await discoverPlugins({
      home: deps.home,
      root: deps.root,
      enabled: deps.enabled,
      enabledInstalled: deps.enabledByUser,
      warn: deps.err,
    });
    deps.out(renderList(found, deps.home, deps.root));
    return 0;
  }
  if (deps.action.sub === 'add') {
    return await runAdd(deps, deps.action.name, deps.action.from);
  }
  if (deps.action.sub === 'remove') {
    const result = await removePlugin(deps.home, deps.action.name);
    if (!result.ok) {
      deps.err(result.error);
      return 1;
    }
    deps.out(`已删掉 ${result.dir}。`);
    // 把话说全：名字可能还挂在设置里，而那一行现在指向一个不存在的东西。
    deps.out(
      `若这个名字还在用户级设置的 plugins.enable 里，那一行现在指向一个不存在的东西 —— 顺手删掉它。`,
    );
    return 0;
  }

  const dir = resolve(deps.action.dir);
  const validated = await validatePlugin(dir, dirReader(dir));
  deps.out(renderValidate(dir, validated));
  return validated.ok ? 0 : 1;
}

/**
 * `plugin add` 的六步（设计 §4.2）。**顺序是要紧的**：任何 E 级问题都在写盘之前中止，
 * 而且一个字节都不写。
 */
async function runAdd(deps: PluginCommandDeps, name: string, from: string): Promise<number> {
  const marketDir = resolve(from);
  const indexLabel = `${marketDir} 下的 .deepcode-plugin/marketplace.json`;

  const index = await validateMarketplace(marketDir, {
    async readIndex() {
      // 与 settings.ts 的默认 reader 同一条区分：不存在返回 undefined 是常态，
      // 存在但读不了要抛 —— 后者可能是有人故意藏了个读不了的东西。
      try {
        return await readFile(join(marketDir, '.deepcode-plugin', 'marketplace.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    openPlugin: (source) => dirReader(join(marketDir, source)),
  });

  if (!index.ok || index.entries === undefined) {
    deps.err(`这份索引用不了：${indexLabel}`);
    for (const line of renderProblems(index.problems)) deps.err(line);
    return 1;
  }

  const entry = index.entries.find((item) => item.name === name);
  if (entry === undefined) {
    // 一次 typo 教会你有哪些可选 —— 于是不需要单独的 `plugin search`（YAGNI）。
    deps.err(`这份索引里没有 ${JSON.stringify(name)}。有的名字：`);
    for (const item of index.entries) deps.err(`  ${item.name.padEnd(24)} ${item.source}`);
    return 1;
  }

  return await installEntry(deps, marketDir, entry);
}

async function installEntry(
  deps: PluginCommandDeps,
  marketDir: string,
  entry: MarketplaceEntry,
): Promise<number> {
  const sourceDir = join(marketDir, entry.source);
  // 再校验一次 source 指向的那个目录，**为的是拿到 entry / hooks** ——
  // `MarketplaceEntry` 只带归一后的 manifest，而下面那一屏要打的是钩子命令的**原文**。
  const validated = await validatePlugin(sourceDir, dirReader(sourceDir));
  deps.out(renderValidate(sourceDir, validated));
  if (!validated.ok) {
    deps.err(`这份插件有问题，没有装 —— 落点里一个字节都没写。`);
    return 1;
  }

  const landed = await landPlugin(deps.home, entry.name, sourceDir);
  if (!landed.ok) {
    deps.err(landed.error);
    return 1;
  }

  deps.out(`装到了 ${landed.dir}。`);
  // **不替用户改设置**（设计 §0 决策 9）：一条命令替你把代码放行，
  // 与项目禁掉 `--yes` 是同一条理由 —— 谁加自动放行开关谁就是在开倒车。
  deps.out(
    `它现在**不会跑**。要它跑，在用户级 ~/.deepcode/settings.json 里写：` +
      `{"plugins": {"enable": ["${entry.name}"]}}`,
  );
  deps.out(`（项目级设置里写同一个名字不算数 —— 否则一个克隆下来的仓库就能点亮你全局装着的插件。）`);
  return 0;
}

export const PLUGIN_HELP = `deepcode plugin —— 插件

  deepcode plugin list                        列出装上的 / 装进来的 / 跳过的，各带理由
  deepcode plugin validate <目录>              只校验一份清单，不执行任何代码
  deepcode plugin add <名字> --from=<目录>     从一份本地索引装进来（**不启用**）
  deepcode plugin remove <名字>                从落点删掉

装在哪
  用户级 ~/.deepcode/plugins/<名字>/plugin.json         自动装载
  项目级 <工作目录>/.deepcode/plugins/<名字>/plugin.json   要在设置里 plugins.enable 之后才装
  落点   ~/.deepcode/installed/<名字>/                  plugin add 装在这儿

装 ≠ 启用
  plugin add 只把文件放好，不放行任何东西。要它跑，得在**用户级**
  ~/.deepcode/settings.json 里写 plugins.enable: ["<名字>"]。
  **项目级设置里写同一个名字不算数** —— 否则一个克隆下来的仓库就能按名字
  点亮你全局装着的插件。这条命令也不会替你改设置。

marketplace 就是一份本地目录：<目录>/.deepcode-plugin/marketplace.json 列出若干条目，
每条一个 name 与一个相对 source（指向该目录下的一个插件目录）。没有网络、没有签名、
没有版本与升级 —— 要更新就是 remove 之后再 add。

一份插件至少要有 plugin.json（name 必填），可以再带一个入口模块（main.mjs）与
一份 hooks/hooks.json。清单里的路径必须是相对的、以 ./ 开头、不含 ..。
`;

function renderValidate(dir: string, validated: Awaited<ReturnType<typeof validatePlugin>>): string {
  const lines: string[] = [];
  const errors = validated.problems.filter((problem) => problem.level === 'error');
  const warns = validated.problems.filter((problem) => problem.level === 'warn');

  lines.push(`插件目录 ${dir}`);
  lines.push(
    validated.ok
      ? `清单没问题${warns.length === 0 ? '' : `（${warns.length} 条警告）`}`
      : `清单有问题：${errors.length} 条错误${warns.length === 0 ? '' : `、${warns.length} 条警告`}`,
  );
  lines.push(...renderProblems(validated.problems));

  if (validated.manifest) lines.push('', ...renderManifest(validated.manifest));
  if (validated.entry !== undefined) lines.push(`  入口模块     ${validated.entry}`);
  lines.push(...renderHooks(validated.hooks));
  lines.push('', '这份命令没有执行任何插件的代码 —— 只读了文件。');
  return lines.join('\n');
}

/**
 * 来源标签。落点那条**必须**带全路径读起来才不混（设计 §7.2）：
 * `installed` 与 `user` 在字面上都是"装上的"，而它们一个自动装载、一个不自动装载。
 */
function originLabel(origin: PluginOrigin): string {
  if (origin === 'user') return '用户级';
  if (origin === 'project') return '项目级';
  return '装进来的';
}

function describeLoaded(plugin: DiscoveredPlugin): string {
  const parts = [plugin.manifest.version, originLabel(plugin.origin)];
  if (plugin.entry !== undefined) parts.push(`入口 ${plugin.entry}`);
  if (plugin.hooks.length > 0) {
    parts.push(`钩子 ${plugin.hooks.map((group) => group.event).join('、')}`);
  }
  return parts.join(' · ');
}

function renderList(found: Discovery, home: string, root: string): string {
  // 落点单独占一节（「装进来的」），而不是并进「跳过的」：**"装了但还没启用"是一个正常状态，
  // 不是错误** —— 混进错误列表会让人觉得装坏了（设计 §4.4）。
  //
  // ⚠️ 用一个名字被用户级设置点亮之后，它就从「装进来的」挪进「装上的」：`装上的` 是
  // "正在跑的那一组"，落点里被启用的那几个也在这一组，只是多标一个「已启用」。
  // （计划原文把 installed-loaded 也留在「装进来的」里计数，与本节两条用例——
  // 「启用了之后它出现在「装上的」里」——的断言对不上；按用例更正：装上的 = loaded 全体。）
  const installedSkipped = found.skipped.filter((plugin) => plugin.origin === 'installed');
  const otherSkipped = found.skipped.filter((plugin) => plugin.origin !== 'installed');

  const lines: string[] = [
    '插件目录',
    `  ${join(root, '.deepcode', 'plugins')}（项目级，要在设置里 plugins.enable）`,
    `  ${join(home, '.deepcode', 'plugins')}（用户级，自动装载）`,
    `  ${join(home, ...INSTALLED_DIR)}（落点，plugin add 装在这儿，只有用户级设置能启用）`,
  ];

  lines.push('', `装上的（${found.loaded.length}）`);
  if (found.loaded.length === 0) lines.push('  （一个都没有）');
  for (const plugin of found.loaded) {
    const suffix = plugin.origin === 'installed' ? ' · 已启用' : '';
    lines.push(`  ${plugin.name.padEnd(24)} ${describeLoaded(plugin)}${suffix}`);
    if (plugin.manifest.description !== undefined) {
      lines.push(`  ${' '.repeat(24)} ${plugin.manifest.description}`);
    }
  }

  lines.push('', `装进来的（${installedSkipped.length}）`);
  if (installedSkipped.length === 0) lines.push('  （一个都没有）');
  for (const plugin of installedSkipped) {
    // 清单坏了的点不了名 —— 那时候理由就不是"没启用"，照原样打。
    const who = plugin.name ?? '（清单坏了）';
    const why = plugin.name === undefined ? plugin.reason : `未启用 —— ${plugin.reason}`;
    lines.push(`  ${who.padEnd(24)} ${why}`);
    lines.push(`  ${' '.repeat(24)} ${plugin.dir}`);
  }

  lines.push('', `跳过的（${otherSkipped.length}）`);
  if (otherSkipped.length === 0) lines.push('  （没有）');
  for (const plugin of otherSkipped) {
    lines.push(`  ${(plugin.name ?? '（清单坏了）').padEnd(24)} ${plugin.reason}`);
    lines.push(`  ${' '.repeat(24)} ${plugin.dir}`);
  }

  lines.push('', '这份命令没有执行任何插件的代码 —— 只读了文件。');
  return lines.join('\n');
}

function renderProblems(problems: readonly Problem[]): readonly string[] {
  return problems.map(
    (problem) => `  ${problem.level === 'error' ? '✖' : '⚠'} ${problem.code} ${problem.message}`,
  );
}

function renderManifest(manifest: PluginManifest): readonly string[] {
  const lines = [`  名字         ${manifest.name}`, `  声明要用的   ${manifest.uses.length === 0 ? '（什么都没声明）' : manifest.uses.join('、')}`];
  if (manifest.description !== undefined) lines.push(`  说明         ${manifest.description}`);
  if (manifest.homepage !== undefined) lines.push(`  主页         ${manifest.homepage}`);
  return lines;
}

function renderHooks(hooks: Awaited<ReturnType<typeof validatePlugin>>['hooks']): readonly string[] {
  if (hooks.length === 0) return [];
  const lines = ['', '它会跑的命令'];
  for (const group of hooks) {
    const scope = group.tools === undefined ? '所有工具' : group.tools.join('、');
    for (const def of group.hooks) {
      lines.push(`  ${group.event}  [${scope}]  ${def.timeoutMs / 1000}s`);
      lines.push(`    ${def.command}`);
    }
  }
  return lines;
}
