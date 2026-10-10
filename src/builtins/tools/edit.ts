import type { Plugin } from '../../contract/plugin';

type Span = { at: number; length: number; crlf: boolean };

/**
 * 定位 old_string 在 content 里的唯一出现位置。
 *
 * 行尾要容忍：Windows 仓库里的文件多是 CRLF，而模型给的 old_string 通常用 LF 换行 ——
 * 直接 `indexOf` 找不到，于是**多行编辑在 Windows 上必然失败**，模型只能靠猜。
 * 所以先按原样找，找不到再把 needle 的 `\n` 换成 `\r\n` 试一次。
 *
 * 返回 'missing' / 'ambiguous' 让调用方自己决定怎么措辞：两个 hook 要说的话不一样。
 * 混合行尾的文件仍然会报 "missing" —— 那是老实的失败，不是猜一个位置出来。
 */
function findSpan(content: string, old: string): Span | 'missing' | 'ambiguous' {
  const candidates = old.includes('\r') ? [old] : [old, old.replace(/\n/g, '\r\n')];

  for (const [index, needle] of candidates.entries()) {
    const at = content.indexOf(needle);
    if (at === -1) continue;
    // 唯一性按同一个 needle 判断：命中两次就交给调用方拒绝，别猜用哪一个。
    if (content.indexOf(needle, at + 1) !== -1) return 'ambiguous';
    return { at, length: needle.length, crlf: index > 0 };
  }
  return 'missing';
}

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
      } catch (error) {
        return { value: `ERROR: 读取失败 ${input.file_path}: ${String(error)}` };
      }

      const span = findSpan(content, input.old_string);
      if (span === 'missing') {
        return { value: `ERROR: 在 ${input.file_path} 里找不到 old_string。请先 Read 确认原文。` };
      }
      if (span === 'ambiguous') {
        return {
          value: `ERROR: old_string 在 ${input.file_path} 里出现多次，不唯一。请提供更多上下文。`,
        };
      }

      // 校验通过，交给下层真正写盘。
      // 这里算出的新内容不往上传：hook 之间只能靠 next({...e, field}) 传值，
      // 而 e 是冻结的 Args，塞不进第三个字段 —— 所以下层会自己再读再算一遍，
      // 也因此**下层必须自带防御**（见下面那个 hook）。
      // confirm 的 diff 预览也由它自己从原始 input 算：tool.check 跑在这之前。
      //
      // 这里**不**写 `read:${path}` 标记。Edit 读过文件，不等于**模型**看过它 ——
      // 模型只拿到一行"已修改"，一个字的内容都没见到。打上标记就等于替
      // Write 的"覆盖已有文件前必须先 Read"开了后门：Edit 一下，随手就能整体覆盖。
      return next(e);
    });

    on('tool.call', { tool: 'Edit' }, async ($, e) => {
      const input = e.input as { file_path: string; old_string: string; new_string: string };
      try {
        const content = await $.fs.read(input.file_path);
        const span = findSpan(content, input.old_string);
        // 上面那个 hook 已经校验过一次，但两次读之间还有窗口：文件若被外部改过，
        // 定位会落空，而拿 -1 直接做 slice 算术不会报任何错，只会把文件内容搅乱
        // 写回去。宁可报错，也不要静默写坏。
        if (span === 'missing' || span === 'ambiguous') {
          return {
            value: `ERROR: 在 ${input.file_path} 里已经找不到 old_string（文件在校验与写入之间被改过？）。请重新 Read 后再试。`,
          };
        }
        // 命中靠的是 CRLF 变体时，替换内容也要跟着用 CRLF ——
        // 否则新插入的那几行与文件其余部分行尾不一致。
        const replacement = span.crlf
          ? input.new_string.replace(/\n/g, '\r\n')
          : input.new_string;
        const updated =
          content.slice(0, span.at) + replacement + content.slice(span.at + span.length);
        await $.fs.write(input.file_path, updated);
        return { value: `已修改 ${input.file_path}` };
      } catch (error) {
        return { value: `ERROR: 修改失败: ${String(error)}` };
      }
    });
  },
};
