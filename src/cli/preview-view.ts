import type { Palette } from './ansi';

/**
 * 确认框那一屏预览的**样子**（P6c）。
 *
 * 为什么它住 `cli/` 而不是 `builtins/confirm.ts`：边界规则里 `builtins` 只许 import
 * `contract`，而"上色"要 `Palette`。这与 `mods/diff` 那条同一条道理 ——
 * **产出决策的留在原处，长什么样的归引擎**。confirm 仍然决定"要不要问"，
 * 只是不再决定"那一屏印成什么颜色"。
 *
 * 与 P6a 的 `⏸` 前缀同一条规矩：内核说的是**问什么**，界面说的是**长什么样**。
 */

/** 一行 diff 的两种前缀。与 `mods/diff/lines.ts` 的 `kind` 一一对应，只是这里只有文本。 */
export function previewLines(tool: string, input: unknown, palette: Palette): readonly string[] {
  const data = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value !== '' ? value : fallback;

  if (tool === 'Bash') {
    const command = text(data['command'], '(未知命令)');
    return ['', `  ${palette.bold('Bash')}  $ ${command}`, ''];
  }

  // 只读工具与借道放行的两个（Read / Glob / Grep / Skill / Task）根本不会走到这儿：
  // confirm 对它们直接给 allow，没有"要不要做"可预览。
  const target = text(data['file_path'], '(未知文件)');

  if (tool === 'Edit') {
    const before = typeof data['old_string'] === 'string' ? data['old_string'] : '';
    const after = typeof data['new_string'] === 'string' ? data['new_string'] : '';
    const removed = lines(before).length;
    const added = lines(after).length;
    return [
      '',
      `  ${palette.bold('Edit')}  ${palette.bold(target)}  ${stat(added, removed, palette)}`,
      ...renderHalf('-', before, palette.red),
      ...renderHalf('+', after, palette.green),
      '',
    ];
  }

  if (tool === 'Write') {
    const content = typeof data['content'] === 'string' ? data['content'] : '';
    const body = lines(content);
    return [
      '',
      `  ${palette.bold('Write')}  ${palette.bold(target)}  ${palette.dim(`${body.length} 行`)}`,
      ...body.slice(0, 3).map((line) => `  ${palette.green('+')} ${line}`),
      // 只给头三行就说清"后面还有"，别让用户以为整个文件就这么长。
      ...(body.length > 3 ? [palette.dim(`  … 还有 ${body.length - 3} 行`)] : []),
      '',
    ];
  }

  return ['', `  ${palette.bold(tool)}  ${palette.bold(target)}`, ''];
}

/** `+3 −1`。两个都是 0 就给一个空格 —— 空字符串会让那行看着少了半截。 */
export function stat(added: number, removed: number, palette: Palette): string {
  if (added === 0 && removed === 0) return palette.dim('没有净改动');
  return [
    ...(added === 0 ? [] : [palette.green(`+${added}`)]),
    ...(removed === 0 ? [] : [palette.red(`−${removed}`)]),
  ].join(' ');
}

function renderHalf(sign: '-' | '+', text: string, color: (s: string) => string): string[] {
  if (text === '') return [];
  return lines(text).map((line) => `  ${color(sign)} ${line}`);
}

/** 空串 = 零行（不是"一行空行"）。`''.split('\n')` 会给 `['']`，那是错的。 */
function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}
