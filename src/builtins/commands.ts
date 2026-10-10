import type { Plugin } from '../contract/plugin';

/** MVP 只有两个斜杠命令。`/help` 的命令列表来自 $.command.list()，不是硬编码数组。 */
export const commandsPlugin: Plugin = {
  name: 'commands',
  uses: ['command.run', 'ui'],

  register(on) {
    on(
      'command.run',
      { name: 'exit' },
      () => {
        process.exitCode = 0;
        return { handled: true };
      },
    );

    on(
      'command.run',
      { name: 'help' },
      async ($) => {
        const commands = $.command.list();
        const tools = $.tool.list();
        $.ui.log(
          [
            '可用命令：' + commands.map((name) => `/${name}`).join('  '),
            '可用工具：' + tools.join('  '),
            '直接输入自然语言即可对话。',
          ].join('\n'),
        );
        return { handled: true };
      },
    );
  },
};
