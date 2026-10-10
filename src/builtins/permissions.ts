import { evaluate, fullyDeniedTools, type Rule } from '../contract/policy';
import type { Plugin } from '../contract/plugin';

export type PermissionsDeps = {
  /** 个人/项目/local/flag 四源的并集。**不含** policy —— 那是 sec-default 的事。 */
  readonly rules: readonly Rule[];
};

/**
 * 规则插件。坐 `user` 层，挂在 `confirm` 外面，只是把规则叠在它的答案之上。
 *
 * 它没有自己的"知识"：没命中规则就原样下沉，于是没配规则时行为与 P1 逐条一致。
 * 这是出口标准"fail-closed 未退化"的落点。
 */
export function createPermissionsPlugin(deps: PermissionsDeps): Plugin {
  return {
    name: 'permissions',
    uses: ['tool.check', 'tool.describe'],

    register(on) {
      on('tool.check', async (_$, e, next) => {
        const hit = evaluate(deps.rules, { tool: e.tool, input: e.input });
        if (hit === undefined) return next(e);

        const downstream = await next(e);

        // 下游是 deny 时原样返回（连 rule 一起）：allow 规则的效力上限是"把 ask
        // 变成 allow"，绝不放宽 deny。少了这一条，一条宽泛的 `allow: ["Bash"]`
        // 就能把 confirm 的未知工具拒绝也一并抹掉，而那条拒绝是 P1 的 fail-closed。
        // rule 也必须照抄下游：把下游的 deny 标成别的规则名，就是在谎报是谁拦下的。
        if (downstream.decision === 'deny') return downstream;

        // rule 填规则原文。这是出口标准"deny 携带规则名"的地基。
        return { decision: hit.decision, rule: hit.rule };
      });

      // 只有整工具 deny（不带括号）才隐藏工具。
      // 参数化 deny 绝不隐藏整个工具 —— 为了拦一条命令就把整个 Bash 从模型眼前
      // 藏掉是灾难，不是安全。
      for (const tool of fullyDeniedTools(deps.rules)) {
        on('tool.describe', { tool }, (() => ({ hidden: true })) as never);
      }
    },
  };
}
