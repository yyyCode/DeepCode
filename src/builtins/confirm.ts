import type { Plugin } from '../contract/plugin';

/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 不碰磁盘、不执行命令，但也不是"读一个文件"的那一类：借道放行，不问。
 *
 * - `Skill`：把一段文本加载进上下文 —— 与 `Read` 同类。
 * - `Task`：派一个子代理。**放过它绝不等于免确认**：子代理内部每一次工具调用都要
 *   再走一遍这条链（`core/loop.ts` 是同一个 `runTurn`），它要写文件照样弹 y/N。
 *   在 `Task` 上再问一次只是让用户多按一次 y，还会误导出"我批准了 Task
 *   就是批准了它接下来做的一切"。
 *
 * ⚠️ 这两个名字**必须**在这儿，否则它们一出生就是死的：下面那条"不认识的工具 → deny"
 * 会把它们当场拒掉。这是 P3 的 `todo` 插件踩过的同一个坑 ——
 * 它的注释（`plugins/todo/main.mjs`）说得很清楚：插件工具要么自己在 `builtin` 之外
 * 答一次 `tool.check`，要么确认器得认识它。`Task`/`Skill` 是第一方工具，走第二条。
 */
const PASS_THROUGH_TOOLS = new Set(['Skill', 'Task']);

/** 会改动磁盘或执行命令的工具，需要确认。 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

export const confirmPlugin: Plugin = {
  name: 'confirm',
  uses: ['tool.check', 'ui'],

  register(on) {
    on('tool.check', async ($, e) => {
      const tool = e.tool;

      if (READ_ONLY_TOOLS.has(tool)) return { decision: 'allow' };

      // 借道放行：它们自己不碰磁盘，但经手的事情会在别处再走一遍这条链。
      if (PASS_THROUGH_TOOLS.has(tool)) return { decision: 'allow' };

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
