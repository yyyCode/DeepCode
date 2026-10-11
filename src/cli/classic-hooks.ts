import type { ResolvedHookGroup } from '../contract/classic';
import type { On } from '../contract/plugin';
import { classify, runHook, type HookContext, type HookVerdict } from './hook-run';

/**
 * 把 `hooks.json` 里的钩子组翻成链上的 hook。
 *
 * ⚠️ **这些 hook 是以那个插件自己的名字挂上去的**，不是由一个第一方"桥插件"代挂
 * （设计 §5.0）。差别是致命的：`uses` 越界检查与"剥掉 allow 判定"这两道闸都按
 * **插件名**生效 —— 代挂的话，这两道闸会作用在桥插件身上，于是一个插件只要把权限
 * 判定写进 `hooks.json` 就绕开了"只能更严"。代挂本身就是个漏洞。
 *
 * 落法：生产的 `plugin-dir.ts` 把 `hooks.json` 与入口模块拼成**一个** `Plugin`，
 * 两者共用同一个名字，于是共用同一块 `on`。这个文件只负责"拼什么"，不负责"谁去挂"。
 */

export type ClassicHooksDeps = {
  /** 插件名。只用于消息 —— 座位与闸门由名字在别处生效。 */
  readonly plugin: string;
  /** 插件目录：`${CLAUDE_PLUGIN_ROOT}` 指向它。 */
  readonly dir: string;
  readonly groups: readonly ResolvedHookGroup[];
  readonly cwd: string;
  readonly projectDir: string;
  readonly session: { readonly id: string; readonly transcriptPath: string | undefined };
  readonly env: NodeJS.ProcessEnv;
};

export function registerHooks(on: On, deps: ClassicHooksDeps): void {
  for (const group of deps.groups) {
    if (group.event === 'PreToolUse') {
      const check = makeCheck(deps, group);
      // matcher 是我们唯一的"多值"表达障碍：注册面只支持单键浅比较，
      // 于是 `Write|Edit` 挂成两条。任一命中即执行，同一时刻只会命中一条。
      if (group.tools === undefined) on('tool.check', check);
      else for (const tool of group.tools) on('tool.check', { tool }, check);
      continue;
    }
    // 剩下两个都是生命周期通知：桥接的目标定在 BRIDGED_EVENTS 里，不在这里写死。
    if (group.event === 'SessionStart') {
      on('session.start', makeNotifier(deps, group));
    } else {
      on('session.end', makeNotifier(deps, group));
    }
  }
}

function context(deps: ClassicHooksDeps): HookContext {
  return { cwd: deps.cwd, pluginRoot: deps.dir, projectDir: deps.projectDir, env: deps.env };
}

function makeCheck(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: e.tool,
      tool_input: e.input,
      // 参考实现的 stdin 里有这个字段，所以要填。它是 P3 唯一一处契约改动：
      // `tool.check` 的参数多了一个字段（**不是**新事件）—— loop 手里本来就有它。
      tool_use_id: e.toolUseId,
    };

    // 组内串行：前一条拦下就不再跑后一条。参考实现也是这个顺序，
    // 而"谁先拦下"决定了模型看到的理由是哪一句。
    for (const def of group.hooks) {
      const result = await runHook(def, input, context(deps));
      const verdict = classify(result);

      const said = result.stdout.trim();
      if (said !== '') $.ui.log(`[钩子 ${deps.plugin}] ${said}`);

      if (verdict.kind === 'block' || verdict.kind === 'fail') {
        return {
          decision: 'deny',
          rule: `${deps.plugin} 的钩子拦下了 ${String(e.tool)}：${verdict.reason}`,
        };
      }
      if (verdict.kind === 'silent') continue;

      if (verdict.decision === 'allow') {
        // 第三方插件的 allow 一律不采纳（设计 §4.4）。这里**不是**把 allow 改写成 deny，
        // 而是当它没说过：下层（个人规则、confirm、fail-closed 链尾）照常裁决。
        // 差别在于"更严的永远赢"那个方向不受影响 —— 一个插件的 allow 连"让 confirm 闭嘴"
        // 都做不到，它做得到的只有"什么都不说"。
        $.ui.log(
          `[钩子 ${deps.plugin}] 想放行 ${String(e.tool)} —— 第三方插件只能拧紧不能拧松，这条判定被忽略，交给下层。`,
        );
        continue;
      }

      return { decision: verdict.decision, rule: reasonOf(deps, verdict, e) };
    }

    return next(e);
  };
}

function reasonOf(
  deps: ClassicHooksDeps,
  verdict: Extract<HookVerdict, { kind: 'say' }>,
  e: any,
): string {
  return (
    `${deps.plugin} 的钩子要求${verdict.decision === 'ask' ? '先问一次' : '拒绝'} ${String(e.tool)}` +
    (verdict.reason === undefined ? '' : `：${verdict.reason}`)
  );
}

function makeNotifier(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: group.event,
    };

    for (const def of group.hooks) {
      const result = await runHook(def, input, context(deps));
      const said = result.stdout.trim();
      if (said !== '') $.ui.log(`[钩子 ${deps.plugin}] ${said}`);
      const complained = result.stderr.trim();
      if (complained !== '') $.ui.notice(`[钩子 ${deps.plugin}] ${complained}`);
      // 这两个事件上**没有可阻断的动作** —— 会话已经开始了/已经在收了。
      // 所以退出码在这里只用来决定"要不要吭一声"，不改变任何裁决（设计 §5.3 的推论）。
      if (result.failure !== undefined) {
        $.ui.notice(`[钩子 ${deps.plugin}] 没跑成：${result.failure}（不影响主流程）`);
      } else if (result.exitCode !== 0 && result.exitCode !== 2) {
        $.ui.notice(`[钩子 ${deps.plugin}] 以退出码 ${result.exitCode} 结束（不影响主流程）`);
      }
    }

    return next(e);
  };
}
