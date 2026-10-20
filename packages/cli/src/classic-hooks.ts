import type { ResolvedHookGroup } from '@deepcode/contract/classic';
import { BRIDGED_EVENTS } from '@deepcode/contract/classic';
import type { On } from '@deepcode/contract/plugin';
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
    // 落点一个都不在这里写死：全从 BRIDGED_EVENTS 读。上面那句"加一个桥接事件 = 映射表里加一条"
    // 要成立，这里就不能再抄一份事件名。
    const bridged = BRIDGED_EVENTS[group.event];

    // 两个工具事件共用一套 matcher 处理：`tool.result` 的参数里同样有 `tool`，
    // 于是"注册面只支持单键浅比较 → `Write|Edit` 挂成两条"这条对两者一模一样。
    if (bridged === 'tool.check' || bridged === 'tool.result') {
      const hook = bridged === 'tool.check' ? makeCheck(deps, group) : makeObserver(deps, group);
      if (group.tools === undefined) on(bridged, hook);
      else for (const tool of group.tools) on(bridged, { tool }, hook);
      continue;
    }

    if (bridged === 'prompt.submit') {
      on('prompt.submit', makePromptInjector(deps, group));
      continue;
    }
    if (bridged === 'turn.stop') {
      on('turn.stop', makeStopBlocker(deps, group));
      continue;
    }
    // 剩下两个（SessionStart / SessionEnd）都是生命周期通知：只吭声，不裁决。
    on(bridged, makeNotifier(deps, group));
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
      // stdout 是带判定的 JSON 时，它是**协议**不是给人看的话 —— 原样回显只会是一行生 JSON。
      // 只有 classify 说"没意见"（纯文本 stdout，读不出判定）时才当说明打出来。
      // 在此之前没有任何钩子走过 JSON 判定这条路（现有的那个用 exit 2 + stderr，
      // stdout 是空的），所以这一行一直潜伏着没被发现。
      //
      // 注释里刻意不写是哪个插件踩到的：`plugin-e2e.test.ts` 有一条断言按**字面文本**
      // 扫 src/，要求那儿一个字的插件名都没有。那条绝对性是有意留的，别为了写清来龙去脉破它。
      if (said !== '' && verdict.kind === 'silent') $.ui.log(`[钩子 ${deps.plugin}] ${said}`);

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

/** 一组钩子跑完之后，我们手里的两样东西 —— 两种意图分开，不靠位置区分。 */
type GroupOutcome = {
  /** 拦停意图：`exit 2` 的 stderr，或 Stop 上的 `deny`。第一条说了算。 */
  readonly block: string | undefined;
  /** 想补充给模型的文本，按顺序。Stop 上它永远是空的 —— 那个事件没有这条通道。 */
  readonly said: readonly string[];
};

/** 拦了却没说为什么时的兜底文本。空串会被 loop 当成"没拦"—— 一个安静的失效。 */
const BLOCKLESS_REASON = '钩子不肯收手，但没说为什么';

/**
 * 跑完一组钩子，读出它们的两种意图。
 *
 * **不改裁决**：这一支服务的三个事件（PostToolUse / UserPromptSubmit / Stop）上，
 * "一个坏掉的钩子必须让动作停下来"这条不适用 —— 工具已经跑完了、提示词已经写好了、
 * 模型也已经说完了，没有东西可停。这时让一段来路不明的文本进模型上下文才是更坏的方向，
 * 所以失败只吭一声（与 `makeNotifier` 同一条取向）。
 *
 * 逐事件能表达什么（设计 §4.1 是权威）：
 *
 * | 事件 | silent | exit 2 | say |
 * | --- | --- | --- | --- |
 * | PostToolUse / UserPromptSubmit | 注入 `context` | 降级成 `context` | 忽略并喊一声 |
 * | Stop | 丢弃并喊一声 | 当成 `block` | deny → `block`；allow/ask 忽略并喊一声 |
 */
async function runGroup(
  $: any,
  deps: ClassicHooksDeps,
  group: ResolvedHookGroup,
  input: unknown,
): Promise<GroupOutcome> {
  const said: string[] = [];
  let block: string | undefined;
  const isStop = group.event === 'Stop';
  const canSay = isStop ? '' : '一段补充上下文';

  for (const def of group.hooks) {
    const result = await runHook(def, input, context(deps));
    const verdict = classify(result);

    if (verdict.kind === 'fail') {
      $.ui.notice(
        `[钩子 ${deps.plugin}] 没跑成：${verdict.reason}（${group.event} 上没有可拦的动作，只吭一声）`,
      );
      continue;
    }

    // `exit 2` 在这里**降级**：它的 stderr 本来就是写给模型看的一段话。
    // PostToolUse / UserPromptSubmit 上落到"补充上下文"那条通道；Stop 上落到 `block`
    // —— 那正是它本来的意思，不需要降级。不这么接的话，一条老式钩子的拦停意图会整个消失。
    if (verdict.kind === 'block') {
      if (isStop) block ??= verdict.reason === '' ? BLOCKLESS_REASON : verdict.reason;
      else said.push(verdict.reason);
      continue;
    }

    if (verdict.kind === 'silent') {
      if (verdict.context === undefined) continue;
      // Stop 上没有"补充上下文"这个落点（结果类型只有 `block`）。**不能**当 block ——
      // 一个只想说句话的钩子会把 turn 拦下来，那是把话当成命令。丢掉，但出声。
      if (isStop) {
        $.ui.log(
          `[钩子 ${deps.plugin}] 给了 additionalContext，但 Stop 上表达不出来（那里只有"允不允许收手"），已忽略。`,
        );
        continue;
      }
      said.push(verdict.context);
      continue;
    }

    // `say`：判定能在这些事件上兑现的**只有 Stop 的 deny** —— "不允许停止"本来就是一次拒绝，
    // 不另发明一个词。其余一律当它没说过，但**喊一声**，与第三方 allow 那条一字不差：
    // 静默忽略会让人以为自己写对了。
    if (isStop && verdict.decision === 'deny') {
      const reason = verdict.reason ?? '';
      block ??= reason === '' ? BLOCKLESS_REASON : reason;
      continue;
    }
    $.ui.log(
      `[钩子 ${deps.plugin}] 给了一个 ${verdict.decision} 判定，但 ${group.event} 上表达不出来` +
        `（能表达的只有${isStop ? ' deny' : canSay}），已忽略。`,
    );
  }

  return { block, said };
}

/**
 * `PostToolUse` → `tool.result`。
 *
 * ⚠️ stdin 里的 `tool_response` 是**我们自己的形状**（`{ok, output}`），不是参考实现那一个
 * —— 那份形状没核实过。如实标在 README 与设计里，别让一条照着参考实现写的钩子以为
 * 它拿到的是官方载荷。
 */
function makeObserver(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: 'PostToolUse',
      tool_name: e.tool,
      tool_input: e.input,
      tool_use_id: e.toolUseId,
      tool_response: { ok: e.ok, output: e.output },
    };

    const ours = await runGroup($, deps, group, input);
    const inner = await next(e);
    // 内层在前：classic 钩子坐 append（插件目录来的都是），它们是链条最里面的那一层
    // —— 与 `prompt.section` 那条"内层在前"是同一套顺序。
    const all = [...ours.said, ...(inner.context === undefined ? [] : [inner.context])];
    return all.length === 0 ? inner : { ...inner, context: all.join('\n\n') };
  };
}

/** `UserPromptSubmit` → `prompt.submit`。⚠️ `...inner` 保住 `handled`。 */
function makePromptInjector(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: e.text,
    };

    const ours = await runGroup($, deps, group, input);
    const inner = await next(e);
    const all = [...ours.said, ...(inner.context === undefined ? [] : [inner.context])];
    return all.length === 0 ? inner : { ...inner, context: all.join('\n\n') };
  };
}

/**
 * `Stop` → `turn.stop`。
 *
 * 我们自己拦了就用我们的文本，否则让下层的过去 —— 与 `tool.check` 那条"更严的赢"不同：
 * 这里没有更严更松，只有"要不要接着转"。
 */
function makeStopBlocker(deps: ClassicHooksDeps, group: ResolvedHookGroup) {
  return async ($: any, e: any, next: any) => {
    const input = {
      session_id: deps.session.id,
      transcript_path: deps.session.transcriptPath,
      cwd: deps.cwd,
      hook_event_name: 'Stop',
      stop_hook_active: e.stopHookActive,
      last_assistant_message: e.lastMessage,
    };

    const outcome = await runGroup($, deps, group, input);
    const inner = await next(e);
    if (outcome.block === undefined) return inner;
    return { block: inner.block ?? outcome.block };
  };
}
