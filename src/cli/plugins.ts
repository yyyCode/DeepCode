import type { Plugin } from '../contract/plugin';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { streamPlugin } from './stream';
import type { Renderer } from './render';

/**
 * CLI 装载的全部插件。
 *
 * 抽成函数只为一件事：让测试钉住"模型文本的出口确实在这份清单里"。
 * 原先这张表直接写在 main() 里，而 main() 一 import 就会跑起来，
 * 于是"插件少装了一个"这类错误只能靠人肉端到端发现 —— 事实也已经发生过一次：
 * 清单里没有 turn.step 的应答者，模型说的话一个字都到不了终端，
 * 而 typecheck、lint、C1/C2 全绿。
 */
export function cliPlugins(render: Renderer): Plugin[] {
  return [...coreTools, confirmPlugin, commandsPlugin, streamPlugin(render)];
}
