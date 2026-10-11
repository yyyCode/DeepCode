import type { Palette } from './ansi';
import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import type { SessionChanges } from './changes';
import { formatChange } from './diff-render';

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
   *
   * 参数是 `/compact <说明>` 里那段说明（P7 §3.3）：用户指定"这次压掉前面、但要保住什么"。
   */
  readonly compact?: (instructions?: string) => Promise<void>;
  /**
   * `/context` 的几行（P7 §3.1）。**给它才注册这条命令**，与 `/compact` 同一条理由。
   *
   * 由 CLI 现算：它要看最近一次建出来的系统提示分节、会话消息、压缩阈值与上次实测用量
   * —— 四样都在 CLI 手里，插件够不着。
   */
  readonly context?: () => readonly string[];
  /**
   * 落盘游标归零。`/clear` 之后**必须**调（P7 §3.6）。
   *
   * 落盘器内部记着"已经写到第几条"（`transcript.ts:113-148`）。数组被清空之后不重置
   * 游标，新对话前 N 条就**一条都不写**：等数组再长过旧游标，`slice(N)` 从新数组的中段
   * 开始写 —— 盘上变成"旧对话 + 新对话的一段尾巴"，`--resume` 接回来缺开头，而且一声不吭。
   * 压缩那条路一直有 reseed（`compact.ts`），`/clear` 这条漏了。
   *
   * 省略 = 这个会话没有转录（`transcript === undefined` 的降级路径），游标本来也不存在。
   */
  readonly reseed?: (length: number) => void;
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
  /**
   * 内建 mod `diff` 装上了没有（P5c）。装上了 → `/diff` 由**那个 mod**应答，
   * 这里**一个字都不注册**。
   *
   * ⚠️ **必填、不给默认值。** 给默认 `false` 的话，生产里 mod 与 CLI 会**两条应答者
   * 抢同一条命令**（hook 链两条都跑，`/diff` 打两遍）而三条检查全绿；
   * 给默认 `true` 的话，一台没有 git 的机器上 `/diff` 会变成"未知命令"——
   * 而 §5.3 判据要的恰恰是那时**还给一句人话**。
   */
  readonly paneLoaded: boolean;
  /**
   * `paneLoaded === false` 时要多说的一句话（`cli/mods.ts` 的 `paneUnavailable` 给）。
   * 说不出原因时给 `undefined` —— 那时只打本会话改动那一块，不撒谎。
   */
  readonly paneUnavailable?: string;
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
      // ⚠️ **只有 mod `diff` 没装时才装这一条**（P5c）。
      // 装上了就没有这一段 —— 两条应答者抢同一条命令，`/diff` 会打两遍。
      // 那条因果链（"把 git 从 PATH 里拿掉 → mod 不装 → 这里接管"）由
      // `test/plugin-wiring.test.ts` 钉住，不靠读代码相信。
      if (!deps.paneLoaded) {
        on('command.run', { name: 'diff' }, ($) => {
          // 工作区那一块看不成了，先说为什么 —— 静默地少一块是最坏的那种降级。
          if (deps.paneUnavailable !== undefined) $.ui.log(deps.paneUnavailable);
          const changes = deps.changes.list();
          if (changes.length === 0) {
            $.ui.log('本会话还没有改动过文件。');
            return { handled: true };
          }
          // 每条改动**分开**打：渲染器是按行处理的，拼成一个大字符串会一团糟。
          for (const change of changes) {
            $.ui.log(formatChange(change, deps.root, deps.palette));
          }
          return { handled: true };
        });
      }

      on('command.run', { name: 'clear' }, ($) => {
        // 就地清空 REPL 正在用的那个数组引用，不是换一个新的 —— 换新的话
        // REPL 手里那个还挂着旧历史，清了个寂寞。
        const cleared = deps.messages.length;
        deps.messages.length = 0;
        // ⚠️ 清空之后必须把落盘游标归零（P7 §3.6）：不归零的话，新对话前 N 条消息
        // **静默不落盘**，等数组再长过旧游标就从新数组的中段开始写 —— 盘上少一段，
        // 没人知道。数组被改短就要 reseed，这条规矩压缩那边一直守着，这边漏了。
        deps.reseed?.(0);
        $.ui.log(
          `已清空上下文（${cleared} 条消息）。磁盘上的转录保留（接下来的对话接着往同一条里写），/diff 也还在。`,
        );
        return { handled: true };
      });

      if (deps.compact !== undefined) {
        on('command.run', { name: 'compact' }, async ($, e) => {
          // `input.ts:135` 按空白切 args，所以中文说明会进来好几个词 —— 拼回去就是用户
          // 敲的那句话。全空 = 只说 `/compact`，那就是没有额外要求。
          const said = e.args.join(' ').trim();
          await deps.compact?.(said === '' ? undefined : said);
          return { handled: true };
        });
      }

      if (deps.context !== undefined) {
        on('command.run', { name: 'context' }, ($) => {
          // 一行一条地打：渲染器是按行处理的，拼成一个大字符串会一团糟（与 /diff 同理）。
          for (const line of deps.context?.() ?? []) $.ui.log(line);
          return { handled: true };
        });
      }

      // ── 各条命令的自我介绍 ──
      // 与各自那条 command.run 挨着写：一条命令加了、忘了写 describe，`/help` 会当场
      // 在屏幕上提醒（见下面 help 的兜底），比放在别处更容易被发现。
      if (!deps.paneLoaded) {
        on('command.describe', { name: 'diff' }, () => ({
          description: '看本会话改动过的文件（unified diff）',
        }));
      }
      on('command.describe', { name: 'clear' }, () => ({
        description: '清空上下文里这一轮的消息（磁盘转录保留）',
      }));
      on('command.describe', { name: 'help' }, () => ({
        description: '列出可用的命令与工具',
      }));
      if (deps.compact !== undefined) {
        on('command.describe', { name: 'compact' }, () => ({
          description: '把上下文压缩一次（摘要失败就干脆不压）',
          usage: '可带一句说明：/compact 保住 API 设计决策',
        }));
      }
      if (deps.context !== undefined) {
        on('command.describe', { name: 'context' }, () => ({
          description: '看这一轮上下文都被什么占着（token 是估的）',
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
