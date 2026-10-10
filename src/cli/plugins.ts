import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { streamPlugin } from './stream';
import { createChangesPlugin, type SessionChanges } from './changes';
import { createSessionCommands } from './commands';
import type { Renderer } from './render';
import type { Palette } from './ansi';

/** 装配 CLI 全部插件需要的外设：渲染器、会话改动表、REPL 的消息数组、根目录、调色板。 */
export type CliPluginDeps = {
  readonly render: Renderer;
  /** 会话改动表。session-changes 插件往它记，/diff 从它读 —— 必须是同一个对象。 */
  readonly changes: SessionChanges;
  /** REPL 正在用的**那个**消息数组。/clear 就地清空它，所以也必须是同一个引用。 */
  readonly messages: Message[];
  readonly root: string;
  readonly palette: Palette;
};

/**
 * CLI 装载的全部插件。
 *
 * 抽成函数只为一件事：让测试钉住"模型文本的出口确实在这份清单里"。
 * 原先这张表直接写在 main() 里，而 main() 一 import 就会跑起来，
 * 于是"插件少装了一个"这类错误只能靠人肉端到端发现 —— 事实也已经发生过一次：
 * 清单里没有 turn.step 的应答者，模型说的话一个字都到不了终端，
 * 而 typecheck、lint、C1/C2 全绿。
 */
export function cliPlugins(deps: CliPluginDeps): Plugin[] {
  return [
    // ⚠️ 顺序是契约，不是随手排的：session-changes 必须排在 coreTools **之前**。
    // 同 tier 内先装载者在外层，而它要在 tool-write 自己的 hook 跑之前抢到文件的**原样**。
    // 晚一步，next 回来时文件已经写完了，before 就成了 after 的副本，/diff 永远空白。
    // （见 cli/changes.ts 里 createChangesPlugin 的顺序约束注释。）
    createChangesPlugin(deps.changes),
    ...coreTools,
    confirmPlugin,
    commandsPlugin,
    streamPlugin(deps.render),
    // /diff、/clear 要碰渲染会话语状态，所以住在 cli/ 而不是 builtins/（见 cli/commands.ts）。
    createSessionCommands({
      changes: deps.changes,
      messages: deps.messages,
      root: deps.root,
      palette: deps.palette,
    }),
  ];
}
