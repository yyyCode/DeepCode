// src/cli/subagents.ts
import type { AgentSpec, SkillSpec } from '../contract/agent';
import type { EngineInterface } from '../contract/engine';
import type { Plugin } from '../contract/plugin';

export type SubagentsDeps = {
  /** **已解析**的 agent 名册。发现已在 main.ts 里做完 —— 装配是同步的（设计 §4.1）。 */
  readonly agents: readonly AgentSpec[];
  /** **已解析**的技能名册。 */
  readonly skills: readonly SkillSpec[];
  /** 会话那一份**基础** system prompt（不是拼完那份）。agent 正文为空时回落到它。 */
  readonly baseSystemPrompt: string;
};

/**
 * 白名单能表达"允许不允许"，表达不了"允许几次"。一次失控的递归要花真钱 ——
 * 这不是策略，是保险丝（设计 §8）。顶层 Task 的 depth = 1。
 */
const MAX_DEPTH = 3;

/** 子代理没正常结束的三种 stopReason。其余（end_turn / max_tokens / 端点自定义的）都当正常。 */
const ABNORMAL_STOP = new Set(['error', 'interrupted', 'max_hops']);

const TASK_DESCRIPTION =
  '派一个子代理去独立完成一件事。它**看不到**你和我现在的对话，只能看到 prompt 里写的内容 —— ' +
  '把任务说清楚：要它做什么、看哪些文件、回报什么。可用子代理见系统提示词里的清单，' +
  'subagent_type 必须与那里写的名字完全一致。';

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    subagent_type: { type: 'string', description: '名册里的 agent 名字，精确匹配' },
    prompt: { type: 'string', description: '交给子代理的全部任务说明' },
    model: { type: 'string', description: '可选：覆盖这个 agent 用的模型' },
  },
  required: ['subagent_type', 'prompt'],
};

const SKILL_DESCRIPTION =
  '按名字把一个技能的知识正文加载进当前上下文。可用技能见系统提示词里的清单' +
  '（不在这里重复第二份）。正文里提到的 references/ 等资源自己用 Read 去读 —— ' +
  '结果里会给出这个技能的目录。';

const SKILL_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', description: '技能名，精确匹配' } },
  required: ['name'],
};

/**
 * 组合面的第一方插件：应答 `agent.offer`、注册 `Task` 与 `Skill` 两个工具。
 *
 * 为什么住 `cli/` 而不是 `builtins/`：它要知道名册、要往屏幕上打通知、要维护一个嵌套
 * 深度栈 —— 这三样都是 REPL 侧的东西。`builtins/` 放的是"与 surface 无关的通用工具"。
 */
export function createSubagentsPlugin(deps: SubagentsDeps): Plugin {
  /**
   * 只用来在错误消息里说清是"谁派的谁"。
   *
   * **闭包里的栈，不是模块级变量**：模块级的会跨测试泄漏（设计 §8）。
   * 又因为工具是串行执行的（`core/loop.ts`），这个栈不会交错，不需要栈帧栈那类东西。
   */
  const stack: string[] = [];

  return {
    name: 'subagents',
    // `uses` 的腔调照抄其余插件：事件写全名，**名词写名字本身**（`fs` / `ui` 那样），
    // 不写点号路径。所以是 `agent` / `skill`，不是 `agent.spawn` / `skill.load`。
    // 这里**不列 `tool`**：`resolveTools` 里那次 `$.tool.list()` 是自省，不是能力 ——
    // `builtins/commands.ts` 同样调它，`uses` 也只有 `['command.run', 'ui']`。
    // ⚠️ `uses` 的越界检查**只对第三方插件生效**（`core/create.ts` 只把列进清单的插件
    // 包成 `makeThirdPartyOn`），所以这里写错不会报错、也不会拦你 —— 正因如此才要写对。
    uses: ['agent.offer', 'tool.call', 'tool.describe', 'ui', 'agent', 'skill'],
    register(on) {
      on('agent.offer', () => ({
        agents: deps.agents.map((spec) => ({
          name: spec.name,
          description: spec.description,
          // 印的是**文件里写的**那份白名单，不是解析后的：省略 = 继承全部，
          // 真解析出来会随会话此刻的工具表变，印一份会变的清单没有意义（设计 §7）。
          ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        })),
        skills: deps.skills.map((spec) => ({ name: spec.name, description: spec.description })),
      }));

      // ── Task ────────────────────────────────────────────────────────────
      on('tool.describe', { tool: 'Task' }, () => ({
        description: TASK_DESCRIPTION,
        inputSchema: TASK_SCHEMA,
      }));

      on('tool.call', { tool: 'Task' }, async ($, e) => {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        const callModel =
          typeof input.model === 'string' && input.model.trim() !== '' ? input.model : undefined;

        // 派一个没任务的子代理没有意义（设计 §11）。
        if (prompt.trim() === '') {
          return { deny: 'Task 的 prompt 是空的 —— 子代理看不到别的上下文，没有任务它无从下手' };
        }

        // **精确匹配**，不做前缀、不做模糊（设计 §7.1）：对不上就把可选名字列出来。
        const spec = deps.agents.find((candidate) => candidate.name === type);
        if (spec === undefined) {
          return {
            deny:
              deps.agents.length === 0
                ? `没有可派的子代理（subagent_type=${type}）：这个会话一个 agent 都没装`
                : `没有叫 ${type} 的子代理。可选的：${deps.agents.map((a) => a.name).join(', ')}`,
          };
        }

        if (stack.length >= MAX_DEPTH) {
          return {
            deny: `嵌套太深了（${[...stack, spec.name].join(' → ')}，上限 ${MAX_DEPTH} 层）`,
          };
        }

        // 模型分层的解析顺序：调用参数 → spec 自带的 → 父级（undefined = 适配器配置里那个）。
        const model = callModel ?? spec.model;
        // 正文为空 ⇒ 回落到会话的基础提示。**回落判断在这儿**，内核不知道这回事（设计 §2.3）。
        const systemPrompt =
          spec.prompt.trim() === ''
            ? `${deps.baseSystemPrompt}\n\n你是子代理「${spec.name}」：${spec.description}`
            : spec.prompt;

        stack.push(spec.name);
        $.ui.notice(`派子代理 ${spec.name}（第 ${stack.length} 层）：${firstLine(prompt)}`);
        try {
          const result = await $.agent.spawn({
            name: spec.name,
            systemPrompt,
            task: prompt,
            tools: resolveTools(spec, $),
            ...(model === undefined ? {} : { model }),
            ...(spec.maxTurns === undefined ? {} : { maxHops: spec.maxTurns }),
          });

          $.ui.notice(`子代理 ${spec.name} 回来了（${result.stopReason}）`);

          // 子代理失败**不是**让父级整个 turn 炸掉，而是变成本次 tool.call 的错误结果
          // （设计 §5.3）：父级要知道"那个子代理失败了"并继续，而不是自己一起倒下。
          // `ERROR:` 前缀是 loop.ts 判 isError 的依据。
          if (ABNORMAL_STOP.has(result.stopReason)) {
            return {
              value: `ERROR: 子代理 ${spec.name} 未正常结束（${result.stopReason}）\n\n${result.text}`,
            };
          }
          return { value: result.text };
        } finally {
          stack.pop();
        }
      });

      // ── Skill ───────────────────────────────────────────────────────────
      on('tool.describe', { tool: 'Skill' }, () => ({
        description: SKILL_DESCRIPTION,
        inputSchema: SKILL_SCHEMA,
      }));

      on('tool.call', { tool: 'Skill' }, async ($, e) => {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name : '';

        // 点名不存在的技能 = deny + 列出可用名：不静默失败、不猜、不做前缀匹配（设计 §10.2）。
        const spec = deps.skills.find((candidate) => candidate.name === name);
        if (spec === undefined) {
          return {
            deny:
              deps.skills.length === 0
                ? `没有可加载的技能（name=${name}）：这个会话一个技能都没装`
                : `没有叫 ${name} 的技能。可选的：${deps.skills.map((s) => s.name).join(', ')}`,
          };
        }

        // 过一遍 `skill.prompt` 这道**变换缝**（链尾无人应答 = 原文通过，设计 §10.3）。
        const loaded = await $.skill.load({ name: spec.name, text: spec.body });

        // 第三层（references/ 等）我们一行代码都不写：把目录交给模型，它用 Read 自己取
        // （设计 §10.1）。这就是"第三层是白送的"落到代码上的全部内容。
        return { value: `${loaded.text}\n\n（这个技能的目录：${spec.dir}）` };
      });
    },
  };
}

/**
 * 白名单解析就是一行减法，归插件 —— 内核只收解析后的结果（设计 §6.1）：
 *   1. 省略 `tools` ⇒ 继承父级全部工具
 *   2. 给出 `tools` ⇒ 白名单，清单外的调不通
 *   3. `disallowedTools` 在白名单之上再扣一层
 *
 * "继承父级全部"听着宽，但**"全权"指的是工具面、不是免确认**：一个省略 tools 的子代理
 * 去写文件，照样要走同一条 `tool.check` 链（confirm 在 builtin、个人规则在 user、
 * 守门器在 prepend，一个都不少）。C2 有一条出口标准专门钉它。
 */
function resolveTools(spec: AgentSpec, $: EngineInterface): readonly string[] {
  const inherited = spec.tools ?? $.tool.list();
  const denied = spec.disallowedTools;
  if (denied === undefined) return [...inherited];
  return inherited.filter((tool) => !denied.includes(tool));
}

/** 通知里只放任务的第一行：它是一句进度提示，不是把 prompt 抄一遍。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
