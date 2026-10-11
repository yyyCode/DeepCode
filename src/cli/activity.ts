import { resolve } from 'node:path';
import type { Plugin } from '../contract/plugin';
import type { FileChange } from './changes';
import type { Palette } from './ansi';
import type { SessionChanges } from './changes';
import { changeStat } from './diff-render';
import { previewLines, stat } from './preview-view';
import type { Renderer } from './render';
import { actionLine, actionTarget, formatDuration, resultLines } from './result-view';
import { formatElapsed, formatTokens, type Tally } from './tally';
import { fitTo } from './width';

/**
 * 界面的那两条面：「正在做什么」（P6a）与「改了什么」（P6c）。
 *
 * **它是插件，不是内核分支。** 内核里没有一行代码知道"屏幕上要画什么" ——
 * 这个文件只是挂到了几条本来就存在的事件上，与第三方插件走完全相同的接口。
 * 这一条是 P6 设计 §2.3 那笔账的兑现方式：`ui.render` 那棵数据树仍然不实现，
 * 但"界面是所有人能挂上去的一条路"由这里成立。
 *
 * 它要解决的两个空洞：
 * - 工具执行期间屏幕上什么都没有（spinner 在模型第一个增量时就停了）；
 * - 改动**之前**有预览，改动**之后**什么都没有 —— 用户只在确认那一刻看过一眼。
 */

export type ActivityDeps = {
  readonly render: Renderer;
  readonly palette: Palette;
  /** 会话改动表。改完之后的 `+3 −1` 与每轮摘要的"改了几个文件"都从它读 —— 与 `/diff` 同一份。 */
  readonly changes: SessionChanges;
  /** 会话账本。**一份，两个消费者**（每轮摘要与退出摘要），见 `tally.ts`。 */
  readonly tally: Tally;
  /** 注入的钟。测试拿它把耗时钉成一个确定的值（默认 `Date.now`）。 */
  readonly now?: () => number;
};

/** `  ⎿  `：结果行与摘要行共用的那截前缀。 */
const marker = (palette: Palette): string => `  ${palette.dim('⎿')}  `;

export function createActivityPlugin(deps: ActivityDeps): Plugin {
  const { render, palette, changes, tally } = deps;
  const now = deps.now ?? ((): number => Date.now());

  /**
   * 子代理嵌套了几层。`agent.spawn` 没有配对的那一半事件，所以靠"当前正有一个 Task
   * 在 tool.call 里"来判断：层数不为 0 时，里面的 `turn.start` / `turn.complete`
   * 是子代理的轮次，**不能**拿它们去重置外层那一轮的账。
   */
  let nesting = 0;

  return {
    name: 'cli-activity',
    uses: ['tool.check', 'tool.call', 'turn.start', 'turn.complete', 'session.compact'],
    register(on) {
      /**
       * 被拒绝的工具今天**对用户完全不可见** —— `loop.ts` 把 `ERROR: 已拒绝 —— …`
       * 当工具结果回喂模型，而工具结果从来不进终端。这正是权限模型最该说话的地方。
       *
       * 裁决是 `ask` 时印那一屏**预览**（P6c）：从模型给的原始 input 直接算，
       * 因为 `tool.call` 还没跑、工具自己还什么都不知道。预览搬来这儿而不是留在
       * `builtins/confirm.ts`，是因为它要上色，而边界规则不许 builtins 认识 `Palette`。
       */
      on('tool.check', async ($, e, next) => {
        const check = await next(e);

        if (check.decision === 'deny') {
          render.settle([
            actionLine(e.tool, e.input, palette),
            `${marker(palette)}${palette.red('已拒绝')} —— ${check.rule ?? '没有给出理由'}`,
          ]);
          return check;
        }

        if (check.decision === 'ask') {
          const preview = previewLines(e.tool, e.input, palette);
          if (preview.length > 0) render.settle(preview);
        }
        return check;
      });

      /**
       * 工具**真的开始跑了**：先挂一行转着的动作，跑完当结算成永久行。
       *
       * ⚠️ 收尾放在 `catch` 里而不是只靠 `tool.result` 配对：白名单外 / 权限 deny /
       * 用户拒了 ask / `tool.call` 返回 deny 这四种情况下工具根本没执行，
       * `tool.result` 也就不会派 —— 而它们全都**没走到这条 hook 里来**。
       */
      on('tool.call', async ($, e, next) => {
        const started = now();
        tally.toolCalls += 1;
        // 顶层轮次的工具数才进"本轮"那一栏。子代理内部的调用已经计在它外面那次
        // Task 上了 —— 两边都算的话，一次 Task 会被数成它自己加上它跑过的所有工具。
        if (nesting === 0) tally.turnToolCalls += 1;

        const target = fitTo(actionTarget(e.tool, e.input), 80);
        render.activity((tick) => [
          `${palette.cyan('⏺')} ${palette.bold(e.tool)}${target === '' ? '' : `  ${target}`}` +
            formatDuration(tick.elapsedMs),
        ]);

        // 派子代理：它内部的每一轮都在这一层里跑，账不能被它们重置。
        if (e.tool === 'Task') nesting += 1;

        let result: Awaited<ReturnType<typeof next>>;
        try {
          result = await next(e);
        } catch (error) {
          // 中断（`Ctrl-C` 打的是整条链）会让 next 抛出来。抛出去之前把活动行收掉：
          // 屏幕上留半行小圆圈，用户的下一条命令就会接着它写。
          render.settle([
            actionLine(e.tool, e.input, palette, now() - started),
            `${marker(palette)}${palette.red('中断')}`,
          ]);
          throw error;
        } finally {
          if (e.tool === 'Task') nesting -= 1;
        }

        const durationMs = now() - started;
        const action = actionLine(e.tool, e.input, palette, durationMs);
        if ('deny' in result) {
          render.settle([
            action,
            `${marker(palette)}${palette.red('拒绝')} —— ${String(result.deny)}`,
          ]);
          return result;
        }

        // 读写工具改完之后给的是 `+3 −1`，不是工具自己那段正文 ——
        // 正文（"已写入 84 行"）对用户没有信息量，而**改了多少**才是这一格的意义。
        // 数字从会话改动表来，与 `/diff` 是同一份、同一套 diff。
        const written = result.value === undefined ? undefined : changeOf(changes, e.input);
        const counted = written === undefined ? undefined : changeStat(written);
        if (counted !== undefined && (e.tool === 'Write' || e.tool === 'Edit')) {
          render.settle([action, `${marker(palette)}${stat(counted.added, counted.removed, palette)}`]);
          return result;
        }

        const output =
          typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        const ok = !output.startsWith('ERROR:');
        render.settle([action, ...resultLines(e.tool, output, ok, durationMs, palette)]);
        return result;
      });

      // ── 每轮摘要（P6c）──
      //
      // 子代理那几层不算独立的一轮：它们的工具调用已经计在外层那一轮的 Task 上了。
      on('turn.start', ($, e, next) => {
        if (nesting === 0) {
          tally.turnStartedAt = now();
          tally.turnToolCalls = 0;
          tally.turnChanges = changes.size();
        }
        return next(e);
      });

      on('turn.complete', ($, e, next) => {
        tally.tokens += e.inputTokens + e.outputTokens;
        if (e.usageEstimated === true) tally.estimated = true;

        if (nesting === 0) {
          const changed = changes.size() - tally.turnChanges;
          render.settle([
            turnLine(
              palette,
              tally.turnToolCalls,
              changed,
              e.inputTokens + e.outputTokens,
              now() - tally.turnStartedAt,
              e.usageEstimated === true,
            ),
          ]);
        }
        return next(e);
      });

      /**
       * 压缩是**纯通知**（派在压缩之前，没有配对的那一半），所以这里只挂一行转着的活动行 ——
       * 压缩真的发生时它会很长，用户需要知道"这几十秒不是卡住了"。
       * 下一次写永久行（或模型的下一个增量）自然把它抹掉。
       */
      on('session.compact', ($, e, next) => {
        render.activity((tick) => [`${tick.frame} 压缩上下文中…${formatDuration(tick.elapsedMs)}`]);
        return next(e);
      });
    },
  };
}

/** `  ⎿  本轮 3 次工具调用 · 改 2 个文件 · 1.2k tokens · 8.4s`。没发生的段落不出现。 */
export function turnLine(
  palette: Palette,
  toolCalls: number,
  changed: number,
  tokens: number,
  elapsedMs: number,
  estimated: boolean,
): string {
  const parts = [`本轮 ${toolCalls} 次工具调用`];
  if (changed > 0) parts.push(`改 ${changed} 个文件`);
  // `（估）`：端点数是我们估的（`turn.complete` 的 `usageEstimated`）。
  // 不标就是报假账 —— 一个"1.2k"看起来与端点报的一样可信。
  parts.push(`${formatTokens(tokens)} tokens${estimated ? '（估）' : ''}`);
  parts.push(formatElapsed(elapsedMs));
  return `${marker(palette)}${palette.dim(parts.join(' · '))}`;
}

/**
 * 这一次改动在会话表里的那一条。
 *
 * `Write` / `Edit` 的 `input.file_path` 是**用户当初敲的那个路径**，而表里的 key 是
 * `resolve` 过的绝对路径 —— 所以不能直接拿它查，得再 resolve 一次。
 * 对不上（工具没真改、或工具自己报了错）就返回 `undefined`，调用方退回印工具正文。
 */
function changeOf(changes: SessionChanges, input: unknown): FileChange | undefined {
  const filePath = (input as { readonly file_path?: unknown } | null)?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return undefined;
  const wanted = resolve(filePath);
  // 同一路径改多次会合并成一条，所以表里本来就只有一条。
  return changes.list().find((change) => change.path === wanted);
}
