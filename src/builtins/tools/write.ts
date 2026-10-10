import type { Plugin } from '../../contract/plugin';

export const writeTool: Plugin = {
  name: 'tool-write',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Write' },
      () => ({
        description: '把内容完整写入一个文件（覆盖已有内容）。新文件也可用。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            content: { type: 'string', description: '要写入的完整内容' },
          },
          required: ['file_path', 'content'],
        },
      }),
    );

    on('tool.call', { tool: 'Write' }, async ($, e, next) => {
      const input = e.input as { file_path: string; content: string };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      const alreadyExists = await $.fs.exists(input.file_path);

      // 覆盖已存在的文件要先看过它 —— 防的是"模型凭记忆重写一个它没读过的文件"。
      if (alreadyExists) {
        const seenKey = `read:${input.file_path}`;
        const seen = await $.store.get(seenKey);
        if (!seen) {
          return {
            value: `ERROR: ${input.file_path} 已存在，但你这次会话还没读过它。先 Read 再 Write。`,
          };
        }
      }

      // 交给下层：confirm 插件挂在 tool.check 上，写入的确认由 loop 统一发起。
      return next(e);
    });

    on('tool.call', { tool: 'Write' }, async ($, e) => {
      const input = e.input as { file_path: string; content: string };
      try {
        await $.fs.write(input.file_path, input.content);
        await $.store.set(`read:${input.file_path}`, '1');
        return { value: `已写入 ${input.file_path}（${input.content.length} 字符）` };
      } catch (error) {
        return { value: `ERROR: 写入失败: ${String(error)}` };
      }
    });
  },
};
