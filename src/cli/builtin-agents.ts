import type { AgentSpec } from '../contract/agent';

/**
 * 开箱可用的三个子代理类型（P15）。
 *
 * **优先级最低**：由 `discoverAgents` 的 `builtins` 参数在项目级 / 用户级 / 插件级
 * 之后合并；同名时文件赢，内置**静默**让位（覆盖一个内置类型是预期行为，不是落选）。
 *
 * 三个都不写死 `model`：`haiku` 这类别名只在某个供应商的端点上成立，而这个项目
 * 同时支持 Anthropic 与 OpenAI 兼容端点。要换模型，在项目 / 用户 agent 文件里写
 * `model`，或者由 `Task` 的调用参数覆盖。
 *
 * `explore` / `plan` 的正文是**整份替换**（P10 的硬隔离），所以它们看不到 `AGENTS.md`。
 * 要求它们守项目规矩，得在自定义 agent 文件里重述，或者用省略正文的 `general-purpose`
 * —— 它回落到会话基础提示，但仍然不含指令文件。这条代价写在 P15 设计 §6。
 */
export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  {
    name: 'explore',
    description:
      '只读探索：定位文件、梳理调用链与数据流，回报带 path:line 的结论。独立任务可以用 Explore 并发派。',
    prompt: `你是只读探索子代理。只使用工具清单里的工具（Read / Glob / Grep）；清单里没有的，说明做不到，不要硬试。

任务：在代码库里定位与任务相关的文件与代码，梳理调用链与数据流。
做法：先用 Glob / Grep 缩小范围，再用 Read 读关键文件；不要猜文件内容，不要请求写盘。
回报：只给结论与证据，引用位置用 path:line。不要把读到的整段代码抄回来 —— 父级只要它能据以行动的部分。`,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
    maxTurns: 12,
  },
  {
    name: 'plan',
    description: '只读调研并产出实施计划：涉及文件、现状、步骤、验证方式、风险与未确认项。',
    prompt: `你是只读调研子代理。只使用 Read / Glob / Grep。

任务：为一项改动收集事实，产出一份可执行的实施计划。
计划必须包含：涉及文件（path:line）、现状、步骤、验证方式、风险与未确认项。
不要写文件；需要更多信息就用工具去读。结论要能让另一个代理直接照着做。`,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
    maxTurns: 16,
  },
  {
    name: 'general-purpose',
    description: '通用子代理：需要读写文件、执行命令或多步完成的任务（串行，用 Task 派）。',
    // 空正文 ⇒ 回落到会话基础提示 + 一句身份说明（P10 的既有回落）。
    prompt: '',
    // 省略 tools ⇒ 继承父级这一轮的面（含 Task / Explore），递归由深度上限兜底。
  },
];
