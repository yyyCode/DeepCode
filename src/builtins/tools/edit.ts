import type { Plugin } from '../../contract/plugin';

export const editTool: Plugin = {
  name: 'tool-edit',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Edit' },
      () => ({
        description:
          '把文件里的 old_string 精确替换成 new_string。old_string 必须在文件中唯一出现，否则报错。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件绝对路径' },
            old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
            new_string: { type: 'string', description: '替换成的新内容' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      }),
    );

    on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      let content: string;
      try {
        content = await $.fs.read(input.file_path);
        await $.store.set(`read:${input.file_path}`, '1');
      } catch (error) {
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }

      const first = content.indexOf(input.old_string);
      if (first === -1) {
        return { value: `ERROR: 在 ${input.file_path} 里找不到 old_string。请先 Read 确认原文。` };
      }
      if (content.indexOf(input.old_string, first + 1) !== -1) {
        return {
          value: `ERROR: old_string 在 ${input.file_path} 里出现多次，不唯一。请提供更多上下文。`,
        };
      }

      const updated =
        content.slice(0, first) + input.new_string + content.slice(first + input.old_string.length);

      // 校验通过，交给下层真正写盘。
      // confirm 的 diff 预览由它自己从原始 input 算 —— tool.check 跑在这之前，
      // 这里挂上去的字段它看不到。
      return next(e);
    });

    on('tool.call', { tool: 'Edit' }, async ($, e) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      try {
        const content = await $.fs.read(input.file_path);
        const at = content.indexOf(input.old_string);
        const updated =
          content.slice(0, at) + input.new_string + content.slice(at + input.old_string.length);
        await $.fs.write(input.file_path, updated);
        return { value: `已修改 ${input.file_path}` };
      } catch (error) {
        return { value: `ERROR: 修改失败: ${String(error)}` };
      }
    });
  },
};
