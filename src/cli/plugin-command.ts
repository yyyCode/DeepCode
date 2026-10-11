import { resolve } from 'node:path';

import type { PluginManifest, Problem } from '../contract/plugin-manifest';
import { validatePlugin } from '../contract/plugin-manifest';
import type { StartupAction } from './args';
import { dirReader, discoverPlugins, type Discovery } from './plugin-dir';

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
      warn: deps.err,
    });
    deps.out(renderList(found, deps.home, deps.root));
    return 0;
  }

  const dir = resolve(deps.action.dir);
  const validated = await validatePlugin(dir, dirReader(dir));
  deps.out(renderValidate(dir, validated));
  return validated.ok ? 0 : 1;
}

export const PLUGIN_HELP = `deepcode plugin —— 插件

  deepcode plugin list             列出装上的与跳过的，各带理由
  deepcode plugin validate <目录>  只校验一份清单，不执行任何代码

装在哪
  用户级 ~/.deepcode/plugins/<名字>/plugin.json        自动装载
  项目级 <工作目录>/.deepcode/plugins/<名字>/plugin.json  要在设置里 plugins.enable 之后才装

一份插件至少要有 plugin.json（name / version），可以带一个入口模块（main.mjs）与
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

function renderList(found: Discovery, home: string, root: string): string {
  const lines: string[] = [`插件目录 ${root}/.deepcode/plugins 与 ${home}/.deepcode/plugins`];

  lines.push('', `装上来的（${found.loaded.length}）`);
  if (found.loaded.length === 0) lines.push('  （一个都没有）');
  for (const plugin of found.loaded) {
    const parts = [`${plugin.manifest.version}`, plugin.origin === 'user' ? '用户级' : '项目级'];
    if (plugin.entry !== undefined) parts.push(`入口 ${plugin.entry}`);
    if (plugin.hooks.length > 0) {
      parts.push(`钩子 ${plugin.hooks.map((group) => group.event).join('、')}`);
    }
    lines.push(`  ${plugin.name.padEnd(24)} ${parts.join(' · ')}`);
    if (plugin.manifest.description !== undefined) {
      lines.push(`  ${' '.repeat(24)} ${plugin.manifest.description}`);
    }
  }

  lines.push('', `跳过的（${found.skipped.length}）`);
  if (found.skipped.length === 0) lines.push('  （没有）');
  for (const skipped of found.skipped) {
    lines.push(`  ${(skipped.name ?? '（清单坏了）').padEnd(24)} ${skipped.reason}`);
    lines.push(`  ${' '.repeat(24)} ${skipped.dir}`);
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
