import type { Plugin } from '@deepcode/contract/plugin';

/**
 * 准入闸门：应答 `plugin.register`。
 *
 * MVP 里这个钩子点就有，应答的是内核里一行 `() => ({ allow: true })`，
 * 注释写着"路径已经存在，P3 只需要换掉这个函数的实现"。这个文件就是那一步。
 *
 * 判定依据是**五层 settings 合并出来的 `plugins.deny`**：没有来源优先级，
 * 因为它只能关掉东西、永远不可能放宽 —— 于是"谁写的"对结果毫无影响（设计 §3）。
 *
 * 它坐 `prepend`：闸门在所有人前面，与 `sec-default` 同一个理由 ——
 * 它要能推翻下游，就不能坐在下游。
 *
 * ⚠️ 它拦的是**链上权威**，不是代码执行。装一个插件 = 信任它，这一点写在
 * `plugin-dir.ts` 里。这条闸门管的只是"装上来之后它能说什么话"。
 */
export type PluginDenyRule = {
  readonly name: string;
  /** 规则来自哪一层（`user` / `project` / `local` / `flag` / `policy`）。只用来把理由说清。 */
  readonly source: string;
};

export type PluginGuardDeps = {
  readonly deny: readonly PluginDenyRule[];
  /**
   * 第一方（CLI 自带）插件的名字。名单点到它们时忽略并点名。
   *
   * 一份托管策略里写 `deny: ["sec-default"]` 多半是写错了 —— 而它的后果是
   * **守门器不装**，也就是整套权限模型的承重墙被托管方自己拆了。
   * 一份"禁用名单"不该有这个能力。
   */
  readonly firstParty: readonly string[];
};

export function createPluginGuardPlugin(deps: PluginGuardDeps): Plugin {
  return {
    name: 'plugin-guard',
    uses: ['plugin.register', 'ui'],

    register(on) {
      on('plugin.register', async ($, e, next) => {
        const hit = deps.deny.find((rule) => rule.name === e.name);
        if (hit === undefined) return next(e);

        if (deps.firstParty.includes(e.name)) {
          $.ui.log(
            `[插件] 禁用名单里点名了第一方插件 ${e.name}（规则来自 ${hit.source} 层）—— 忽略。这份名单是给掉进目录的第三方插件设的闸，不是拆承重墙的开关。`,
          );
          return next(e);
        }

        return { refuse: `被禁用（规则来自 ${hit.source} 层 settings 的 plugins.deny）` };
      });
    },
  };
}
