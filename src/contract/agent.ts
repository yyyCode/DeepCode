// src/contract/agent.ts

import type { TurnReason } from './turn';

/**
 * 组合面的契约类型（P4a）。**type-only、只引同目录** —— contract/ 的边界不破。
 *
 * 这里有两族，别混：
 * - `AgentSpec` / `SkillSpec` 是**策略侧**的中间表示 —— 从文件里读出来的东西。
 * - `AgentSpawnRequest` / `AgentSpawnResult` 是**内核唯一认识**的那两样，
 *   它们里面的字段**全是已经解析好的**：内核对"省略 tools 是什么意思"一无所知。
 */

export type AgentSpec = {
  readonly name: string;
  /** 路由就靠这一行（模型看到的是它，不是这个文件）。 */
  readonly description: string;
  /** markdown 正文。**为空时回落到会话的基础 system prompt**（设计 §5.1）。 */
  readonly prompt: string;
  /** 白名单。**省略 = 继承父级全部工具**；给了 = 只有列出的能用。 */
  readonly tools?: readonly string[];
  /** 在白名单之上再扣一层。 */
  readonly disallowedTools?: readonly string[];
  /** `'inherit'` | 别名 | 完整 id。省略 = inherit。 */
  readonly model?: string;
  /** 本子代理单次调用的最大往返次数，省略 = loop 的 MAX_HOPS。 */
  readonly maxTurns?: number;
  /**
   * **作者声明**这个 agent 的工具面全是只读的（P15）。只有 `Explore` 会用它。
   *
   * 它放不放宽任何权限：`Task` 照旧能派它，`tools` 照旧收窄。它只是一个**资格**，
   * 而且内核不信任这个布尔 —— 真派的时候会拿这一轮的实际面逐个核对
   * （`core/nouns/agent.ts`）。声明 `readOnly` 却没写 `tools` 的 agent 在发现阶段
   * 会丢掉这个标志：省略 `tools` 等于继承父面，其中可能就有写工具。
   */
  readonly readOnly?: boolean;
};

export type SkillSpec = {
  readonly name: string;
  readonly description: string;
  /** SKILL.md 的正文（渐进式披露的第二层）。 */
  readonly body: string;
  /**
   * 这个技能自己的目录。
   *
   * **第三层要靠它**：第三层是"模型自己去读 `references/`"，而模型得先知道
   * 那个目录在哪 —— `Skill` 工具的结果里会把路径一块儿给它。
   */
  readonly dir: string;
};

export type AgentSpawnRequest = {
  /** 用于日志与错误消息。 */
  readonly name: string;
  /** **已解析**的系统提示词（回落已经算完）。内核不再做回落判断。 */
  readonly systemPrompt: string;
  readonly task: string;
  /**
   * 只许这些。**省略 = 继承父级那一轮的面**。
   *
   * ⚠️ 这里给的是**声明**，不是"已解析的清单"（P10 之前是后者，那是个错的分工）：
   * 只有内核知道"父级这一轮模型看得见什么"，而这个面只存在于"此刻跑着的那几层 loop"里。
   * 内核拿它与父面**求交** —— 于是它只会更小，不会更大（P10 设计 §3.2）。
   */
  readonly allow?: readonly string[] | undefined;
  /** 在 `allow` 之上再扣一层。同样是声明。 */
  readonly deny?: readonly string[] | undefined;
  /** 已解析的模型；undefined = 用会话自己的（= 父级那个）。 */
  readonly model?: string;
  readonly maxHops?: number;
  /**
   * 要求这次派生**只能**落在只读面上（P15，`Explore` 专用）。
   *
   * 内核在算出这一轮真正的面之后、派 `agent.spawn` 之前核对：面里任何一个工具没有
   * 声明 `readOnly: true`，这次派生就被拒。因此它是**验证请求**，不是放行开关 ——
   * 声明它不会让任何工具变得可写或可读，只会让不满足的那次跑不起来（fail-closed）。
   */
  readonly readOnly?: boolean;
};

/**
 * 派一次子代理的结局。
 *
 * 两个分支而不是一个可空的结果：**拒绝是内核给出的**（嵌套深度是内核的事实，
 * 见 P10 设计 §3.3/§3.4），所以类型必须能表达"这次压根没跑"。
 * 形状与复刻对象的 `$.agent.spawn` 同构（它返回 `{ model, agentId }` 或 `{ deny }`）。
 */
export type AgentSpawnResult =
  | {
      /** 子代理**最后一轮**模型说的话。中间的工具结果一个字都不在这儿。 */
      readonly text: string;
      /**
       * 子代理这一轮**为什么收场**（产品语义，见 `./turn`）。
       *
       * 消费方（`cli/subagents.ts`）照 `isNormalTurn` 判"它干完了没有" —— 白名单。
       * P8 之前这里是 `string` 且消费方用黑名单，于是 `truncated`（被截断）被当成正常结束。
       */
      readonly stopReason: TurnReason;
      /** 这是第几层（1 = 会话直接派的）。内核手上就有，白送。 */
      readonly depth: number;
      readonly ok: true;
    }
  | {
      /** 没跑。今天只有一种：嵌套太深（消息里带名字链与上限）。 */
      readonly reason: string;
      readonly ok: false;
    };
