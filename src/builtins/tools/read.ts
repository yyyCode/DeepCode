import type { Plugin } from '../../contract/plugin';

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
            offset: { type: 'number', description: '从第几行开始读（1 起，默认 1）' },
            limit: { type: 'number', description: `最多读取的行数，默认 ${MAX_LINES}` },
          },
          required: ['file_path'],
        },
      }),
    );

    on('tool.call', { tool: 'Read' }, async ($, e) => {
      const input = e.input as { file_path: string; offset?: number; limit?: number };
      if (!input?.file_path) return { value: 'ERROR: 缺少 file_path 参数' };

      try {
        const content = await $.fs.read(input.file_path);
        // 记下"这次会话读过它"。Write 覆盖已存在的文件前会查这个 key ——
        // 少了这一行，那个检查永远为假，任何先前就存在的文件都再也覆盖不了：
        // 你没法在不写的情况下打上标记，也没法在没标记的情况下写。
        await $.store.set(`read:${input.file_path}`, '1');
        const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));

        // `offset` 是**行号**（1 起），不是数组下标。第 1 层把大结果落盘之后，
        // 模型要靠它把「存盘文件里的某一段」读回来 —— 只有 limit 没有 offset 时
        // 预览里那句「读指定行范围」是空话（P11 §4.1）。
        const offset = typeof input.offset === 'number' && Number.isFinite(input.offset)
          ? Math.max(1, Math.floor(input.offset))
          : 1;
        if (offset > lines.length) {
          return { value: `ERROR: offset ${offset} 超出文件行数（共 ${lines.length} 行）` };
        }
        // `limit` 同样得挡住 0 / 负数 / NaN：模型按预览里的建议传参时，一个负数
        // 会让 `slice(start, start + limit)` 切出空段，却还报"显示第 X–X−1 行"。
        const limit =
          typeof input.limit === 'number' && Number.isFinite(input.limit)
            ? Math.max(1, Math.floor(input.limit))
            : MAX_LINES;
        const start = offset - 1;
        const shown = lines.slice(start, start + limit);
        const numbered = shown.map((line, index) => `${start + index + 1}\t${line}`).join('\n');

        const end = start + shown.length;
        const truncated =
          end < lines.length || start > 0
            ? `\n... 共 ${lines.length} 行，本次显示第 ${start + 1}–${end} 行`
            : '';
        return { value: numbered + truncated };
      } catch (error) {
        // 工具失败不抛：它是给模型的信息，不是崩溃。
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }
    });
  },
};
