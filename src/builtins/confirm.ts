import type { Plugin } from '../contract/plugin';

/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/** 会改动磁盘或执行命令的工具，需要确认。 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

export const confirmPlugin: Plugin = {
  name: 'confirm',
  uses: ['tool.check', 'ui'],

  register(on) {
    on('tool.check', async ($, e) => {
      const tool = e.tool;

      if (READ_ONLY_TOOLS.has(tool)) return { decision: 'allow' };

      if (!MUTATING_TOOLS.has(tool)) {
        // 不认识的工具：拒绝，不是放行。
        return { decision: 'deny', rule: `未知工具 ${tool}，不在确认器的白名单里` };
      }

      // 打印预览，然后把"要不要做"交给 loop 统一问用户。
      const preview = renderPreview(tool, e.input);
      if (preview) $.ui.log(preview);

      return { decision: 'ask', rule: `最小确认：${tool}` };
    });
  },
};

/**
 * 预览从模型给的原始 input 直接算。
 *
 * 不能指望工具把预览挂在 e 上再流到这里：loop 里 tool.check 跑在 tool.call **之前**，
 * 工具的 hook 那时还没执行，挂上去的东西 confirm 根本看不见 —— 预览会永远显示
 * "(未知命令)"、Edit 永远没有 diff。所以预览必须自给自足。
 */
function renderPreview(tool: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>;

  if (tool === 'Bash') {
    const command = typeof data.command === 'string' ? data.command : '(未知命令)';
    return `\n  Bash  $ ${command}\n`;
  }

  const target = typeof data.file_path === 'string' ? data.file_path : '(未知文件)';

  if (tool === 'Edit') {
    const before = typeof data.old_string === 'string' ? data.old_string : '';
    const after = typeof data.new_string === 'string' ? data.new_string : '';
    const removed = before
      .split('\n')
      .map((line) => `  - ${line}`)
      .join('\n');
    const added = after
      .split('\n')
      .map((line) => `  + ${line}`)
      .join('\n');
    return `\n  Edit  ${target}\n${removed}\n${added}\n`;
  }

  if (tool === 'Write') {
    const content = typeof data.content === 'string' ? data.content : '';
    const lineCount = content === '' ? 0 : content.split('\n').length;
    const head = content
      .split('\n')
      .slice(0, 3)
      .map((line) => `  | ${line}`)
      .join('\n');
    return `\n  Write  ${target}（${lineCount} 行）\n${head}\n`;
  }

  return `\n  ${tool}  ${target}\n`;
}
