import type { Palette } from './ansi';
import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import type { FileChange, SessionChanges } from './changes';
import { diffLines, displayPath, formatUnified, splitLines, toHunks } from './diff';

/**
 * 需要外设的两条命令（`/diff`、`/clear`、`/compact`）住在 `cli/` 而不是 `builtins/`。
 *
 * 依赖边界规则（设计 §2.1）规定 `builtins/` 只能 import `contract`，而 `/diff` 要着色
 * （`Palette`）、要知道会话根目录（`root`），`/clear` 要拿到 REPL 正在用的 `messages`
 * 数组 —— 全是表现层与会话态的东西。为一条命令放宽全局边界规则不划算。
 *
 * 分工：`builtins/commands.ts` 继续管不碰外设的 `/exit`、`/help`；这里管要碰渲染与
 * 会话状态的 `/diff`、`/clear`、`/compact`。`/help` 的命令列表来自注册面
 * （`$.command.list()`），所以分成两个文件注册不影响它列全。
 */
export type SessionCommandsDeps = {
  readonly changes: SessionChanges;
  /** REPL 正在用的**那个**数组，同一个对象引用 —— /clear 就地清空它。 */
  readonly messages: Message[];
  readonly root: string;
  readonly palette: Palette;
  /**
   * 压缩。**给它才注册 `/compact`** —— 没给的时候这条命令不存在，`/help` 也不会列它，
   * 这比"命令在、点了没反应"诚实。
   */
  readonly compact?: () => Promise<void>;
};

export function createSessionCommands(deps: SessionCommandsDeps): Plugin {
  return {
    name: 'session-commands',
    uses: ['command.run', 'ui'],

    register(on) {
      on('command.run', { name: 'diff' }, ($) => {
        const changes = deps.changes.list();
        if (changes.length === 0) {
          $.ui.log('本会话还没有改动过文件。');
          return { handled: true };
        }
        // 每条改动**分开**打：渲染器是按行处理的，拼成一个大字符串会一团糟。
        for (const change of changes) {
          $.ui.log(renderChange(change, deps.root, deps.palette));
        }
        return { handled: true };
      });

      on('command.run', { name: 'clear' }, ($) => {
        // 就地清空 REPL 正在用的那个数组引用，不是换一个新的 —— 换新的话
        // REPL 手里那个还挂着旧历史，清了个寂寞。
        const cleared = deps.messages.length;
        deps.messages.length = 0;
        $.ui.log(`已清空上下文（${cleared} 条消息）。磁盘上的转录保留，/diff 也还在。`);
        return { handled: true };
      });

      if (deps.compact !== undefined) {
        on('command.run', { name: 'compact' }, async () => {
          await deps.compact?.();
          return { handled: true };
        });
      }
    },
  };
}

/**
 * 一条改动渲染成一屏 unified diff（或一句退化说明）。
 *
 * 三种退化各有独立输出，不混成一句：
 * - 任意一侧 skipped（太大 / 是目录 / 读不动）→ 说清为什么没内容，别假装没改过；
 * - `hunks.length === 0`（写了一遍却一字未变，或改了又改回去）→ "没有净改动"，
 *   说了也白说，不打一片空白。
 */
function renderChange(change: FileChange, root: string, palette: Palette): string {
  const label = displayPath(change.path, root);

  const skipped = [change.before, change.after].find((s) => s.kind === 'skipped');
  if (skipped?.kind === 'skipped') return `${label}: 未记录内容（${skipped.why}）`;

  const before = change.before.kind === 'text' ? splitLines(change.before.text) : [];
  const after = change.after.kind === 'text' ? splitLines(change.after.text) : [];
  const hunks = toHunks(diffLines(before, after));
  if (hunks.length === 0) return `${label}: 没有净改动。`;

  return formatUnified(label, hunks, palette, { isNew: change.before.kind === 'absent' });
}
