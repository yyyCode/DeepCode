import { evaluate, fullyDeniedTools, squeeze, type Rule } from '../contract/policy';
import type { Plugin } from '../contract/plugin';

/**
 * 本次会话当场批准、并记住的规则。
 *
 * **进程内，不落盘**：复刻对象把这件事建模成 `PermissionUpdate` 的一个**目的地**
 * （`userSettings|projectSettings|localSettings|session|cliArg`）—— 我们只做其中的
 * `session` 那一档，而且是它的内存版。忘了它的代价只是"下次再问一遍"，
 * 而写进 settings 是另一件事（那要改文件，得人自己去改）。
 *
 * 与 `cli/changes.ts` 的 `SessionChanges` 同一条先例：状态由 CLI 建**一份**，
 * 两个消费者（这个插件与 `/permissions`）拿的是同一个引用。
 */
export type SessionGrants = {
  add(rule: Rule): void;
  list(): readonly Rule[];
  clear(): void;
};

export function createSessionGrants(): SessionGrants {
  const rules: Rule[] = [];
  return {
    add(rule) {
      // 同一条按了好几遍 `a` 也只留一份：`/permissions` 要把它们摊开给人看，
      // 重复项会把它变成一串越来越长的废话。
      if (rules.some((held) => held.tool === rule.tool && held.content === rule.content)) return;
      rules.push(rule);
    },
    list: () => rules,
    clear: () => {
      rules.length = 0;
    },
  };
}

export type PermissionsDeps = {
  /** 个人/项目/local/flag 四源的并集。**不含** policy —— 那是 sec-default 的事。 */
  readonly rules: readonly Rule[];
  /** 本次会话当场批准记住的规则。 */
  readonly grants: SessionGrants;
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
    uses: ['tool.check', 'tool.describe', 'tool.consent'],

    register(on) {
      on('tool.check', async (_$, e, next) => {
        // 会话里记住的那几条与 settings 的规则**同等**（同在 allow 桶里）——
        // 不另立一条判定语义，于是"deny 掀不翻"、"更严的永远赢"这些性质一条都不用重讲。
        // 副作用是：`ask: ["Bash"]` 这种**明写**要问的规则，`a` 也压不过它 ——
        // 那是对的，写了要问就是问了要问。
        const hit = evaluate([...deps.rules, ...deps.grants.list()], { tool: e.tool, input: e.input });
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

      /**
       * 人在提示上按了 `a`：把"这一次批准"翻成一条能反复命中的规则，记住，并说一声。
       *
       * ⚠️ **必须出声**。`a` 记住的到底是什么，按下去的那一刻是看不出来的
       * （同一句提示，`Edit` 记的是整个工具、`Bash` 记的是那一条命令）——
       * 不出声就是让人拿着一个自己不知道内容的授权往下走。
       */
      on('tool.consent', ($, e) => {
        if (e.granted !== 'always') return;
        const rule = rememberRule(e.tool, e.input);
        deps.grants.add(rule);
        $.ui.log(`已记住：本次会话不再询问 ${rule.raw}`);
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

/**
 * 把人刚批准的那一次调用，翻成一条能长期命中的 allow 规则。
 *
 * - `Bash` 记住的是**这一条命令**（归一后）。**不按前缀记**：`Bash(git:*)` 会把
 *   `git push` 一起放进来，而复刻对象在那条路上一直被打补丁（`cd src && npm test`
 *   必须按子命令存规则、多处前缀绕过被当安全缺陷修掉）。
 * - 其余工具记住的是**整个工具**：`Write` 的一次批准，意思就是"这一场会话别拦我写文件"。
 *
 * ⚠️ **不走 `parseRule`**：它会把 `Bash(:*)` 那样归一成"整个 Bash"，而这里的输入是
 * 一条**已经批过的**命令行，不需要（也不该）再过一遍规则语法的解释。
 */
function rememberRule(tool: string, input: unknown): Rule {
  if (tool === 'Bash') {
    const command = readCommand(input);
    if (command !== undefined) {
      const content = squeeze(command);
      return { raw: `Bash(${content})`, tool, content, decision: 'allow' };
    }
  }
  return { raw: tool, tool, decision: 'allow' };
}

/** 取 `command` 字段。取不到（缺、类型不对、空串）就当"这条命令记不住"，退回整工具。 */
function readCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const command = (input as Record<string, unknown>)['command'];
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}
