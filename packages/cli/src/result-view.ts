import type { Palette } from './ansi';
import { fitTo } from './width';

/**
 * 工具调用的**给人看**的那两行。纯函数 —— 输入是事件里那点东西，输出是几行字符串。
 *
 * ⚠️ 这里做的截断**只对终端**。回喂模型的是 `tool.result` 的原样正文
 * （`core/loop.ts` 里那条），一个字都不动：给模型看 6 行会让它以为工具真只输出了 6 行。
 * 两个消费者两条口径，这一条是 P6a 的出口标准之一。
 */

/** 摘要最多几行。一屏 24–40 行，一次工具活动不该吃掉它的 1/4。 */
export const MAX_LINES = 6;

/** 每行最多几列。超了就该折行，而摘要**刻意不折**（折行是内容面的事）。 */
export const MAX_COLUMNS = 200;

/** ` · 1.2s`，**不满一秒给空串**。低一秒的动作刷出一串 `0.1s 0.2s` 只是抖动。 */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : '';
}

/** 工具的落点：Bash 给命令，其余给路径 / 模式 / 名字。与 `confirm.ts` 预览同源。 */
export function actionTarget(tool: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;

  switch (tool) {
    case 'Bash':
      return text(data['command']) ?? '';
    case 'Task':
      return [text(data['subagent_type']), text(data['description'])].filter(Boolean).join(' ');
    case 'Skill':
      return text(data['name']) ?? '';
    case 'Glob':
    case 'Grep':
      return text(data['pattern']) ?? '';
    default:
      return text(data['file_path']) ?? '';
  }
}

/** 动作行：`⏺ Bash  pnpm test · 3.2s`（耗时不满一秒时那一段不出现）。 */
export function actionLine(
  tool: string,
  input: unknown,
  palette: Palette,
  durationMs = 0,
): string {
  const target = fitTo(actionTarget(tool, input), MAX_COLUMNS);
  const head = `${palette.cyan('⏺')} ${palette.bold(tool)}`;
  return `${target === '' ? head : `${head}  ${target}`}${formatDuration(durationMs)}`;
}

/**
 * 结果行：一行 `⎿ 12 行输出 · 退出码 1 · 3.2s`，其后最多 `MAX_LINES` 行正文。
 *
 * 缩进五格是照着 `⎿` 的宽度对齐的 —— 它比 `⏺` 窄，正文要挂在结果行下面而不是
 * 回到动作行那一列去。
 */
export function resultLines(
  tool: string,
  output: string,
  ok: boolean,
  durationMs: number,
  palette: Palette,
): string[] {
  const marker = `  ${palette.dim('⎿')}  `;
  const pad = '     ';

  const body = output === '' ? [] : output.split('\n');
  const shown = clamp(body, ok);
  const meta = metaOf(tool, output, body.length, durationMs);

  if (meta === '') {
    if (shown.length === 0) return [`${marker}${palette.dim('（没有输出）')}`];
    return shown.map((line, index) => (index === 0 ? marker : pad) + fitTo(line, MAX_COLUMNS));
  }

  return [
    `${marker}${ok ? palette.dim(meta) : palette.red(meta)}`,
    ...shown.map((line) => pad + fitTo(line, MAX_COLUMNS)),
  ];
}

/**
 * `12 行输出 · 退出码 1 · 3.2s`。三段各自只在"这里确实有话可说"时出现 ——
 * 一行不到的输出再报一句"1 行"是纯噪音。
 */
function metaOf(tool: string, output: string, lineCount: number, durationMs: number): string {
  const parts: string[] = [];
  if (lineCount > 1) parts.push(tool === 'Bash' ? `${lineCount} 行输出` : `${lineCount} 行`);
  if (tool === 'Bash') {
    const code = exitCodeOf(output);
    if (code !== undefined) parts.push(`退出码 ${code}`);
  }
  const duration = formatDuration(durationMs).replace(' · ', '');
  if (duration !== '') parts.push(duration);
  return parts.join(' · ');
}

/**
 * Bash 把退出码藏在工具的正文里（见 `builtins/tools/bash.ts`）。
 * 成功时是结尾的 `[退出码 N]`，失败时是开头那句 `ERROR: 命令以退出码 N 结束`。
 */
export function exitCodeOf(output: string): number | undefined {
  const failed = /^ERROR: 命令以退出码 (-?\d+) 结束/m.exec(output);
  if (failed?.[1] !== undefined) return Number(failed[1]);
  const lines = output.trimEnd().split('\n');
  const matched = /^\[退出码 (-?\d+)\]$/.exec(lines[lines.length - 1] ?? '');
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

/**
 * 挑重点 + 截到 `MAX_LINES` 行。**只截断、只重排，不改任何一个字** ——
 * 一旦开始改写，终端上那段就成了一份"摘要"，而上面那句正文里明说了它必须是原样。
 */
function clamp(lines: readonly string[], ok: boolean): string[] {
  let shown: readonly string[] = lines;
  if (!ok) {
    // 报错时优先给 `ERROR:` 那一行 —— 那是用户最想先看到的。
    const index = lines.findIndex((line) => line.startsWith('ERROR:'));
    if (index > 0) shown = [lines[index]!, ...lines.slice(0, index), ...lines.slice(index + 1)];
  }
  if (shown.length <= MAX_LINES) return [...shown];
  return [...shown.slice(0, MAX_LINES), `… 还有 ${shown.length - MAX_LINES} 行`];
}
