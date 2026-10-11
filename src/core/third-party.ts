import type { EventHook, On } from '../contract/plugin';
import type { Tier } from '../contract/tier';
import type { Registry } from './registry';

/**
 * 第三方插件的 `on` —— 能力上限在**结构上**被钉死：它没法放宽任何一行权限。
 *
 * 三件事，都在注册那一刻生效，不靠约定、不靠文档、不靠人记得：
 * 1. 返回的 `{decision:'allow'}` 一律丢弃（当它没说过，判定交回下层）
 * 2. 注册的事件必须在清单的 `uses` 里，越界就**整个插件不装**
 * 3. 往 `engine.create` 挂 hook 当场拒绝（不是静默无效 —— 那是颗地雷）
 *
 * 座位（永远 `append`）不在这里，在 `create.ts` 里强制 —— 它要在派发 `plugin.register`
 * 之前就定下来，而这次派发的结果本身就是闸门的一部分。
 */

export type ThirdPartyOnDeps = {
  readonly registry: Registry;
  readonly plugin: string;
  readonly tier: Tier;
  readonly uses: readonly string[];
  /** 装载期消息的出口（越界、拒挂 `$`）。生产里是 `coreNouns.logger.warn`。 */
  readonly log: (line: string) => void;
};

/**
 * `uses` 覆盖：`*` 覆盖一切，`tool.*` 覆盖 `tool.` 下的所有事件，否则精确匹配。
 *
 * 与 `registry.matchesPattern` 分开：那个是**事件名**匹配（运行时按 dispatch 的事件挑
 * hook），这个是**声明**匹配（装载期按 `uses` 挑注册）。两者规则像，但一个管链、
 * 一个管准入 —— 合成一个函数会让"改链的匹配"顺手改掉"准入的匹配"。
 */
export function coversUses(pattern: string, uses: readonly string[]): boolean {
  return uses.some(
    (item) =>
      item === '*' ||
      item === pattern ||
      (item.endsWith('.*') && pattern.startsWith(item.slice(0, -1))),
  );
}

function isAsyncIterable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

export function makeThirdPartyOn(deps: ThirdPartyOnDeps): On {
  /** 越界之后这块 `on` 就废了：后续注册一概不理（先前那些已经被 revoke 撤掉）。 */
  let revoked = false;

  /**
   * 那道闸：**看返回值的形状**，不看 pattern 的名字。
   *
   * ⚠️ 这里与设计 §4.4 的初稿不同，是有意的纠正。初稿写的是"pattern 命中
   * `turn.step` 就跳过包装"，理由是外面套 async 会把生成器协议截断。两个问题：
   *
   * 1. 那个理由是错的。`dispatch` 用 `await Promise.resolve(hook(...))` 接返回值，
   *    而 `await` 一个生成器对象得到的还是它自己 —— async 包装**不破坏**生成器协议。
   * 2. 更要紧的是它是条**绕过路径**：`on('*')` 与 `on('tool.*')` 都命中 `turn.step`，
   *    于是通配 hook 会拿到"免包装"待遇，一条 `{decision:'allow'}` 就能溜出去。
   *
   * 改成无条件包装 + 按返回值的形状让流式直通：这一步之后，"想放宽"这件事
   * 不是被禁掉了，而是**没法表达** —— 一个第三方 hook 的 allow 连它自己那一层
   * 都出不去。
   */
  const wrap = (hook: EventHook): EventHook => {
    return ($, e, next) => {
      const returned = hook($, e, next);
      // 流式返回值在包装之前就原样交出去。今天内核里没有任何 hook 从钩子点返回
      // 生成器（`turn.step` 的应答者返回的是 `{}`），所以这一支是**守着一个假设**，
      // 不是一条承重路径 —— 留着它是因为它便宜，而去掉它需要"未来不会有流式 hook"这个承诺。
      if (isAsyncIterable(returned)) return returned;

      return (async () => {
        const out = await returned;
        if (isAsyncIterable(out)) return out;
        if (
          typeof out === 'object' &&
          out !== null &&
          (out as { decision?: unknown }).decision === 'allow'
        ) {
          const tool = (e as { tool?: unknown }).tool;
          // 走 ui 而不是 logger：这是**用户该看见的**事（有个插件想放行某个动作）。
          // 安全相关的反馈不该只活在 DEEPCODE_DEBUG 里。
          $.ui.log(
            `[插件] ${deps.plugin} 想放行${typeof tool === 'string' ? ` ${tool}` : ''} —— 第三方插件只能拧紧不能拧松，这条判定被丢弃，交给下层。`,
          );
          return next(e);
        }
        return out;
      })();
    };
  };

  const on = ((pattern: string, second: unknown, third?: unknown) => {
    if (revoked) return;

    const hook = (third ?? second) as EventHook;
    const matcher = third === undefined ? undefined : (second as Record<string, unknown>);

    if (pattern === 'engine.create') {
      // 今天这是个**静默无效**：`engine.create` 早在插件注册之前就折叠完了，
      // 挂上去的 hook 永远不会跑，而插件会以为自己扩展了 `$`（MVP §10 偏差 7）。
      // 静默无效比明着不支持坏得多 —— 改成当场拒绝，让它自己知道。
      deps.log(
        `[插件] ${deps.plugin} 想扩展 $（往 engine.create 挂 hook）—— 本版本不支持，这条注册被丢弃（插件扩展 $ 排在 P4）。`,
      );
      return;
    }

    if (!coversUses(pattern, deps.uses)) {
      revoked = true;
      const removed = deps.registry.revoke(deps.plugin);
      deps.log(
        `[插件] ${deps.plugin} 注册了 ${pattern}，但清单里的 uses 只有 ${deps.uses.length === 0 ? '（空）' : deps.uses.join('、')} —— 越界，整个插件不装（已撤掉 ${removed} 条注册）。`,
      );
      return;
    }

    deps.registry.register({
      plugin: deps.plugin,
      tier: deps.tier,
      pattern,
      matcher,
      hook: wrap(hook),
    });
  }) as On;

  return on;
}
