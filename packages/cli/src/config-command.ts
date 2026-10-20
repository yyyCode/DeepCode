import type { Plugin } from '@deepcode/contract/plugin';
import type { ConfigEntry } from '@deepcode/contract/events';
import { describeConfig, setConfigValue } from './config';

/**
 * `/config` 命令，连带 `config.describe` 与 `config.set` 两个事件的应答者，都住这一个插件里。
 *
 * 住 `cli/` 不住 `builtins/` 的理由与 `cli/commands.ts` 顶部那段一字不差：它要读盘
 * （`describeConfig` / `setConfigValue`），而 `builtins/` 只许 import `contract/`。
 *
 * ⚠️ 它是**第一个**由命令去写配置文件的入口。拒绝面全在 `setConfigValue` 里 ——
 * 这个插件一个字都不判，只负责把 CLI 侧的外设（home / root / env）递进去。
 * 在这儿再补一层判断就等于多一个地方可以走岔。
 */
export type ConfigCommandDeps = {
  /** 用户主目录：`config.set` 只写 `<home>/.deepcode/config.json`。 */
  readonly home: string;
  /** 会话根目录：只读，用来报项目级那一层的来源。 */
  readonly root: string;
  /** 生效环境变量的快照 —— `config.describe` 的 source 判定靠它。 */
  readonly env: Record<string, string | undefined>;
  /** 未知字段 / 覆盖关系的告警出口。 */
  readonly warn?: (line: string) => void;
};

export function createConfigCommand(deps: ConfigCommandDeps): Plugin {
  const read = (): Promise<ConfigEntry[]> =>
    describeConfig({
      env: deps.env,
      home: deps.home,
      root: deps.root,
      ...(deps.warn === undefined ? {} : { warn: deps.warn }),
    });

  return {
    name: 'config-command',
    // `command.describe` 一个都不能少：漏一项这个插件会在装载期被整个撤掉
    // （core/third-party.ts 拿 `uses` 当"它声明要用哪些事件"的清单去核）。
    uses: ['command.run', 'command.describe', 'config.describe', 'config.set', 'ui'],

    register(on) {
      on('command.describe', { name: 'config' }, () => ({
        description: '看生效的连接配置（改它用 deepcode config set）',
      }));

      on('config.describe', async () => ({ entries: await read() }));

      // 不 try/catch：`setConfigValue` 把每种失败都做成了 `ok: false` 的返回值，
      // 而它真抛出来说明是本文件没考虑到的情况 —— 那种时候静默吞掉最坏。
      on('config.set', async (_$, e) => await setConfigValue({ home: deps.home, key: e.key, value: e.value }));

      on('command.run', { name: 'config' }, async ($) => {
        $.ui.log(renderEntries(await read()));
        return { handled: true };
      });
    },
  };
}

/**
 * 一屏清单。可写的那几行带一句提示 —— 用户看得见能改什么，才不用去翻文档。
 *
 * 空清单要**说出来**：那是链尾 `config.describe` 的 fail-closed 兜底（没人应答），
 * 与"什么都没配"长得一模一样。只打一个标题会让前者看着像后者。
 */
export function renderEntries(entries: readonly ConfigEntry[]): string {
  if (entries.length === 0) {
    return '连接配置：（没有 hook 应答 config.describe —— 这份清单是空的，不等于"什么都没配"）';
  }
  const width = Math.max(...entries.map((entry) => entry.key.length));
  const lines = entries.map((entry) => {
    const key = entry.key.padEnd(width);
    const mark = entry.writable ? '  （可改）' : '';
    return `  ${key}  ${entry.value}  [${entry.source}]${mark}`;
  });
  return ['连接配置：', ...lines, '改它：deepcode config set model <名字>'].join('\n');
}
