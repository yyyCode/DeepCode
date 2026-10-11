import type { Palette } from './ansi';
import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import type { FileChange, SessionChanges } from './changes';
import { diffLines, displayPath, formatUnified, splitLines, toHunks } from './diff';

/**
 * 需要外设的命令（`/diff`、`/clear`、`/compact`、`/help`）住在 `cli/` 而不是 `builtins/`。
 *
 * 依赖边界规则（设计 §2.1）规定 `builtins/` 只能 import `contract`，而 `/diff` 要着色
 * （`Palette`）、要知道会话根目录（`root`），`/clear` 要拿到 REPL 正在用的 `messages`
 * 数组 —— 全是表现层与会话态的东西。为一条命令放宽全局边界规则不划算。
 *
 * 分工：`builtins/commands.ts` 管**只碰 `$` 名词**的（现在就剩 `/exit`）；这里管要注入
 * 东西的。`/help` 是 P4c-2 搬过来的：它要打每条命令的一句话，那要派发 `command.describe`，
 * 而插件拿不到 dispatch（`contract/engine.ts:59-64`）—— 于是得由 CLI 注进来。
 * 命令清单来自注册面（`$.command.list()`），分成两个文件注册不影响它列全。
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
  /**
   * 问一条命令它自己是什么。**由 CLI 注入**，因为要派发 `command.describe` 而插件
   * 拿不到 dispatch（见上面那段）。
   *
   * ⚠️ 它在 `createEngine` **之后**才填得上（跟 `/compact` 同一个道理，`main.ts:235-238` 有
   * 一模一样的延迟取），所以实际传进来的是一个闭包，而不是函数本身。
   *
   * 不给 = 每条命令都当"没注册 describe"处理 —— `/help` 照样列全，只是每行只有名字。
   */
  readonly describeCommand?: (name: string) => Promise<CommandDescription>;
};

/**
 * 一条命令的自我描述，三种结果**必须分得开**：
 * `described` 有话要说、`hidden` 主动隐身、`missing` 是**故障**（忘了注册）。
 *
 * 把 `missing` 混进 `hidden`，`/help` 就会安静地少列一条命令 —— 那是这一族里最坏的失败方式。
 */
export type CommandDescription =
  | { readonly kind: 'described'; readonly description: string; readonly usage?: string }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'missing' };

export function createSessionCommands(deps: SessionCommandsDeps): Plugin {
  return {
    name: 'session-commands',
    uses: ['command.run', 'command.describe', 'ui'],

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

      // ── 各条命令的自我介绍 ──
      // 与各自那条 command.run 挨着写：一条命令加了、忘了写 describe，`/help` 会当场
      // 在屏幕上提醒（见下面 help 的兜底），比放在别处更容易被发现。
      on('command.describe', { name: 'diff' }, () => ({
        description: '看本会话改动过的文件（unified diff）',
      }));
      on('command.describe', { name: 'clear' }, () => ({
        description: '清空上下文里这一轮的消息（磁盘转录保留）',
      }));
      on('command.describe', { name: 'help' }, () => ({
        description: '列出可用的命令与工具',
      }));
      if (deps.compact !== undefined) {
        on('command.describe', { name: 'compact' }, () => ({
          description: '把上下文压缩一次（摘要失败就干脆不压）',
        }));
      }

      on('command.run', { name: 'help' }, async ($) => {
        const lines = ['可用命令：'];
        for (const name of $.command.list()) {
          const described = await describeOne(deps, $, name);
          if (described === undefined) continue; // 主动隐身，不进清单
          lines.push(described === null ? `  /${name}` : `  /${name}　${described}`);
        }
        lines.push(`可用工具：${$.tool.list().join('  ')}`);
        lines.push('直接输入自然语言即可对话。');
        $.ui.log(lines.join('\n'));
        return { handled: true };
      });
    },
  };
}

/**
 * 问一条命令它自己是什么。返回：
 * - `undefined`：这条命令**主动隐身**（`hidden: true`），不要列它；
 * - `null`：**没注册 describe** —— 故障，warn 一声，调用方退回裸名字；
 * - 字符串：那句话（带上可选的用法）。
 *
 * 三种结果分开，是因为"隐身"与"忘了写"必须看得出区别：`describeTools` 那条注释说得好，
 * 把故障混进正常状态里，会让人以为某个插件坏了却不去修。
 */
async function describeOne(
  deps: SessionCommandsDeps,
  $: { ui: { notice(line: string): void } },
  name: string,
): Promise<string | null | undefined> {
  if (deps.describeCommand === undefined) return null;
  const said = await deps.describeCommand(name);
  if (said.kind === 'hidden') return undefined;
  if (said.kind === 'missing') {
    $.ui.notice(`命令 /${name} 没有注册 describe（command.describe 无人应答）—— 只列名字。`);
    return null;
  }
  return said.usage === undefined ? said.description : `${said.description}　${said.usage}`;
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
