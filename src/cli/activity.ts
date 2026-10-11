import type { Plugin } from '../contract/plugin';
import type { Palette } from './ansi';
import type { Renderer } from './render';
import { actionLine, actionTarget, formatDuration, resultLines } from './result-view';
import { fitTo } from './width';

/**
 * P6a 活动面：「正在做什么」。
 *
 * **它是插件，不是内核分支。** 内核里没有一行代码知道"屏幕上要画什么" ——
 * 这个文件只是挂到了三条本来就存在的事件上，与第三方插件走完全相同的接口。
 * 这一条是 P6 设计 §2.3 那笔账的兑现方式：`ui.render` 那棵数据树仍然不实现，
 * 但"界面是所有人能挂上去的一条路"这件事由这里成立。
 *
 * 它要解决的是今天最大的那个空洞：**工具执行期间屏幕上什么都没有**。
 * spinner 在模型第一个增量时停下，之后 Bash 跑三十秒，用户面对一块静止的屏幕。
 */

export type ActivityDeps = {
  readonly render: Renderer;
  readonly palette: Palette;
  /** 注入的钟。测试拿它把耗时钉成一个确定的值（默认 `Date.now`）。 */
  readonly now?: () => number;
};

export function createActivityPlugin(deps: ActivityDeps): Plugin {
  const { render, palette } = deps;
  const now = deps.now ?? ((): number => Date.now());

  return {
    name: 'cli-activity',
    uses: ['tool.check', 'tool.call', 'session.compact'],
    register(on) {
      /**
       * 被拒绝的工具今天**对用户完全不可见** —— `loop.ts` 把 `ERROR: 已拒绝 —— …`
       * 当工具结果回喂模型，而工具结果从来不进终端。这正是权限模型最该说话的地方：
       * 模型试了一件被规则拦住的事，用户必须看得见。
       *
       * 只处理 `deny`：`allow` 没什么好说的，`ask` 由 `confirm` 打的预览 + 提示符承担
       * （预览已经写在屏幕上了，再补一行是重复）。
       */
      on('tool.check', async ($, e, next) => {
        const check = await next(e);
        if (check.decision === 'deny') {
          render.settle([
            actionLine(e.tool, e.input, palette),
            `  ${palette.dim('⎿')}  ${palette.red('已拒绝')} —— ${check.rule ?? '没有给出理由'}`,
          ]);
        }
        return check;
      });

      /**
       * 工具**真的开始跑了**：先挂一行转着的动作，跑完当结算成永久行。
       *
       * ⚠️ 收尾放在 `finally` 里，**不能**只靠 `tool.result` 配对：
       * 白名单外 / 权限 deny / 用户拒了 ask / `tool.call` 返回 deny 这四种情况下
       * 工具根本没执行，`tool.result` 也就不会派（见 `contract/events.ts` 那段）——
       * 而它们全都**没走到这条 hook 里来**，所以这里的 finally 恰好在且仅在
       * "进入过 tool.call" 时收尾，不会留着活动行挂在屏幕上。
       */
      on('tool.call', async ($, e, next) => {
        const started = now();
        const target = fitTo(actionTarget(e.tool, e.input), 80);
        render.activity((tick) => [
          `${palette.cyan('⏺')} ${palette.bold(e.tool)}${target === '' ? '' : `  ${target}`}` +
            formatDuration(tick.elapsedMs),
        ]);

        // 中断（`Ctrl-C` 打的是整条链）会让 next 抛出来。抛出去之前把活动行收掉：
        // 屏幕上留半行小圆圈，用户的下一条命令就会接着它写。
        // （渲染器那个退出钩子是兜底 —— 它只在进程真的死掉时才有机会跑。）
        let result: Awaited<ReturnType<typeof next>>;
        try {
          result = await next(e);
        } catch (error) {
          render.settle([
            actionLine(e.tool, e.input, palette, now() - started),
            `  ${palette.dim('⎿')}  ${palette.red('中断')}`,
          ]);
          throw error;
        }

        const durationMs = now() - started;
        const action = actionLine(e.tool, e.input, palette, durationMs);
        if ('deny' in result) {
          render.settle([
            action,
            `  ${palette.dim('⎿')}  ${palette.red('拒绝')} —— ${String(result.deny)}`,
          ]);
          return result;
        }

        const output = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        const ok = !output.startsWith('ERROR:');
        render.settle([
          action,
          ...resultLines(e.tool, output, ok, durationMs, palette),
        ]);
        return result;
      });

      /**
       * 压缩是**纯通知**（`session.compact` 派在压缩之前，没有配对的那一半），
       * 所以这里只挂一行转着的活动行 —— 压缩真的发生时它会很长，用户需要知道
       * "这几十秒不是卡住了"。下一次写永久行（或模型的下一个增量）自然把它抹掉。
       */
      on('session.compact', ($, e, next) => {
        render.activity((tick) => [`${tick.frame} 压缩上下文中…${formatDuration(tick.elapsedMs)}`]);
        return next(e);
      });
    },
  };
}
