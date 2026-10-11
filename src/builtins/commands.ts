import type { Plugin } from '../contract/plugin';

/**
 * 不碰任何外设的那条命令：`/exit`。
 *
 * `/help` **曾经住在这里**，P4c-2 搬去了 `cli/commands.ts`。搬的理由不是它变了，
 * 而是它要打"每个命令的一句话"—— 那要派发 `command.describe`，而**插件拿不到 dispatch**
 * （`$` 是名词的集合，见 `contract/engine.ts:59-64`）。要用 dispatch 的插件就得由 CLI
 * 把 dispatcher 注进去，也就只能住在 `cli/` 里。`/compact` 早就是这条路。
 *
 * 于是两个文件的分工变得比原来更干净：**这里管"只碰 `$` 名词"的，`cli/` 管"要注入点东西"的。**
 * 命令清单仍然来自注册面（`$.command.list()`），分在两个文件里注册不影响它列全。
 */
export const commandsPlugin: Plugin = {
  name: 'commands',
  uses: ['command.run', 'command.describe', 'ui'],

  register(on) {
    on(
      'command.run',
      { name: 'exit' },
      () => {
        process.exitCode = 0;
        return { handled: true };
      },
    );

    on('command.describe', { name: 'exit' }, () => ({
      description: '退出会话',
    }));
  },
};
