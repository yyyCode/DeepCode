// src/contract/agent.ts

/**
 * 组合面的契约类型（P4a）。**type-only、零 import** —— contract/ 的边界不破。
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
  /** **已解析**的允许清单。内核只照着它过滤，不做任何减法。 */
  readonly tools: readonly string[];
  /** 已解析的模型；undefined = 用会话自己的（= 父级那个）。 */
  readonly model?: string;
  readonly maxHops?: number;
};

export type AgentSpawnResult = {
  /** 子代理**最后一轮**模型说的话。中间的工具结果一个字都不在这儿。 */
  readonly text: string;
  readonly stopReason: string;
};
