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

      // 校验通过，交给下层真正写盘。
      // 这里算出的新内容不往上传：hook 之间只能靠 next({...e, field}) 传值，
      // 而 e 是冻结的 Args，塞不进第三个字段 —— 所以下层会自己再读再算一遍，
      // 也因此**下层必须自带防御**（见下面那个 hook）。
      // confirm 的 diff 预览也由它自己从原始 input 算：tool.check 跑在这之前。
      return next(e);
    });

    on('tool.call', { tool: 'Edit' }, async ($, e) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      try {
        const content = await $.fs.read(input.file_path);
        const at = content.indexOf(input.old_string);
        // 上面那个 hook 已经校验过一次，但两次读之间还有窗口：文件若被外部改过，
        // indexOf 会返回 -1，而 slice(0, -1) + ... + slice(-1 + len) 不会报任何错，
        // 只会把文件内容搅乱写回去。宁可报错，也不要静默写坏。
        if (at === -1) {
          return {
            value: `ERROR: 在 ${input.file_path} 里已经找不到 old_string（文件在校验与写入之间被改过？）。请重新 Read 后再试。`,
          };
        }
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
