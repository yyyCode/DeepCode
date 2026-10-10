import { evaluate, fullyDeniedTools, isLooser, type Rule } from '../contract/policy';
import type { Plugin } from '../contract/plugin';

/** 检查没跑完时用的规则名。它会被原样报给用户，所以写成一句话而不是一个代号。 */
export const UNCHECKED_DENY = 'sec-default: 检查未完成，按拒绝处理';

export type SecDefaultDeps = {
  /** **只**来自 policy 源。个人/项目/local/flag 里的同名规则永远不参与。 */
  readonly rules: readonly Rule[];
};

/**
 * 守门器。坐 `prepend` 首位，目的只有一个：维护组织既有控制面不被个人插件放宽。
 *
 * 它不制定任何策略 —— 没配托管文件时它什么都不做，一切照常由 confirm 决定。
 *
 * 为什么是"持有"而不是架构文档里的"重放"：重放成立需要两个前提（引擎按调用者
 * 作用域重算裁决、`settings.read` 本身是可被 hook 的事件），我们一个都没有 ——
 * 设置是启动期解析好的不可变数组。这种情况下重放必然得到与第一遍相同的答案，
 * 是装样子。持有直接把策略裁决拿在手里，比重放更强：少一段可能被插手的推导路。
 */
export function createSecDefaultPlugin(deps: SecDefaultDeps): Plugin {
  return {
    name: 'sec-default',
    uses: ['tool.check', 'tool.describe', 'ui'],

    register(on) {
      on('tool.check', async ($, e, next) => {
        try {
          // 先把链跑完：策略没意见时，答案完全由下游决定，行为与 P1 逐条一致。
          const below = await next(e);
          const policy = evaluate(deps.rules, { tool: e.tool, input: e.input });

          // 三种不插手的情形，都在这一行里：
          // - 策略没提到这次调用（policy === undefined）
          // - 策略不比下游更严（更松或相同）—— 包括"策略是 allow、下层是 ask"：
          //   守门器的职责是防放宽，不是替个人取消他自己多要的那次询问。
          //   若让策略在这里也赢，一条 `allow: ["Bash"]` 就成了自动放行开关，
          //   与"谁加自动放行开关谁就是在开倒车"直接冲突。
          if (policy === undefined || policy.decision === 'allow') return below;
          if (!isLooser(below.decision, policy.decision)) return below;

          // 下游确实放宽了。持有裁决：直接拿策略的规则原文作答。
          $.ui.log(
            `[安全] 一条更宽松的判定被拦下：策略里 ${policy.rule} 要求 ${policy.decision}，` +
              `实际得到 ${below.decision}。以托管策略为准。`,
          );
          return { decision: policy.decision, rule: policy.rule };
        } catch (error) {
          // ⚠️ 这一条不是装饰。dispatch 的故障隔离会把抛错的 hook 跳过并继续跑下层 ——
          // 守门器一旦自己炸了，它的保护会**无声消失**，而 confirm 会照常给出 ask。
          // 那是一条真实的 fail-open 通道：守门器必须自己兜底成 deny，不能指望引擎替它兜。
          $.ui.log(`[安全] ${UNCHECKED_DENY}（${error instanceof Error ? error.message : String(error)}）`);
          return { decision: 'deny', rule: UNCHECKED_DENY };
        }
      });

      // 策略里的整工具 deny，用与 permissions 相同的一套机制隐藏。
      // 坐 prepend，所以策略的隐藏先于个人的隐藏生效。
      for (const tool of fullyDeniedTools(deps.rules)) {
        on('tool.describe', { tool }, (() => ({ hidden: true })) as never);
      }
    },
  };
}
