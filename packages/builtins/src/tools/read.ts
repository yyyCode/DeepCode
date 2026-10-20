import type { Plugin } from '@deepcode/contract/plugin';

const MAX_LINES = 2000;

export const readTool: Plugin = {
  name: 'tool-read',
  uses: ['tool.call', 'tool.describe', 'fs', 'store'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Read' },
      () => ({
        description: '读取一个文本文件的内容，返回带行号的正文。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            limit: { type: 'number', description: `最多读取的行数，默认 ${MAX_LINES}` },
          },
          required: ['file_path'],
        },
      }),
    );

    on('tool.call', { tool: 'Read' }, async ($, e) => {
      const input = e.input as { file_path: string; limit?: number };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      try {
        const content = await $.fs.read(input.file_path);
        // 记下"这次会话读过它"。Write 覆盖已存在的文件前会查这个 key ——
        // 少了这一行，那个检查永远为假，任何先前就存在的文件都再也覆盖不了：
        // 你没法在不写的情况下打上标记，也没法在没标记的情况下写。
        await $.store.set(`read:${input.file_path}`, '1');
        const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
        const limit = input.limit ?? MAX_LINES;
        const shown = lines.slice(0, limit);
        const numbered = shown.map((line, index) => `${index + 1}\t${line}`).join('\n');
        const truncated =
          lines.length > limit ? `\n... 共 ${lines.length} 行，已截断到 ${limit} 行` : '';
        return { value: numbered + truncated };
      } catch (error) {
        // 工具失败不抛：它是给模型的信息，不是崩溃。
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }
    });
  },
};
