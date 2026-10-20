// packages/cli/src/subagents.ts
import type { AgentSpec, SkillSpec } from '@deepcode/contract/agent';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { Plugin } from '@deepcode/contract/plugin';
import { isNormalTurn } from '@deepcode/contract/turn';

export type SubagentsDeps = {
  /** **已解析**的 agent 名册。发现已在 main.ts 里做完 —— 装配是同步的（设计 §4.1）。 */
  readonly agents: readonly AgentSpec[];
  /** **已解析**的技能名册。 */
  readonly skills: readonly SkillSpec[];
  /** 会话那一份**基础** system prompt（不是拼完那份）。agent 正文为空时回落到它。 */
  readonly baseSystemPrompt: string;
};

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
 * 为什么住 `cli/` 而不是 `builtins/`：它要知道名册、要往屏幕上打通知
 * —— 这两样都是 REPL 侧的东西。`builtins/` 放的是"与 surface 无关的通用工具"。
 *
 * ⚠️ **它不再算"子代理能用哪些工具"，也不算"能派多深"**（P10）：那两样都要知道
 * "父级这一轮模型看得见什么"，而这份事实只存在于内核那几层正在跑的 loop 里。
 * 这里只把 agent 文件里写的 `tools` / `disallowedTools` 当**声明**交出去。
 */
export function createSubagentsPlugin(deps: SubagentsDeps): Plugin {
  return {
    name: 'subagents',
    // `uses` 的腔调照抄其余插件：事件写全名，**名词写名字本身**（`fs` / `ui` 那样），
    // 不写点号路径。所以是 `agent` / `skill`，不是 `agent.spawn` / `skill.load`。
    // 这里**不列 `tool`**：P10 之前它调过一次 `$.tool.list()`（算白名单），那次是自省、
    // 不是能力 —— 现在连那次也没有了，这个插件碰不到工具面。
    // ⚠️ `uses` 的越界检查**只对第三方插件生效**（`core/create.ts` 只把列进清单的插件
    // 包成 `makeThirdPartyOn`），所以这里写错不会报错、也不会拦你 —— 正因如此才要写对。
    uses: ['agent.offer', 'agent.spawn', 'tool.call', 'tool.describe', 'ui', 'agent', 'skill'],
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

      // ── 进度提示 ────────────────────────────────────────────────────────
      // 挂在 `agent.spawn` 上，不是挂在下面那个 `tool.call` 里：内核**只对真要开跑的
      // 那一次**派这个事件（深度超了的那次在它之前就返回了）。于是"被拒的那一次"
      // 屏幕上不会出现一行"派子代理 X"却再也不回来 —— 那是我第一版挪进来时打的假账。
      // 顺带把插件直派的子代理也照亮了：那条路径上没有 Task，也就没有别的地方出声。
      on('agent.spawn', ($, e, next) => {
        // 层数不在这儿说：它已经在回来那条通知里（设计 §5）。这里印的是 P10 之前那一行。
        $.ui.notice(`派子代理 ${e.name}：${firstLine(e.task)}`);
        return next(e);
      });

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

        // 模型分层的解析顺序：调用参数 → spec 自带的 → 父级（undefined = 适配器配置里那个）。
        const model = callModel ?? spec.model;
        // 正文为空 ⇒ 回落到会话的基础提示。**回落判断在这儿**，内核不知道这回事（设计 §2.3）。
        const systemPrompt =
          spec.prompt.trim() === ''
            ? `${deps.baseSystemPrompt}\n\n你是子代理「${spec.name}」：${spec.description}`
            : spec.prompt;

        // （"派子代理 X"那一条在上面的 `agent.spawn` hook 里 —— 那条通知现在由内核的
        // 事件驱动，见那里的理由。）

        // agent 文件里写的 `tools` / `disallowedTools` 当**声明**交给内核 —— 由它拿
        // 父级那一轮的面去求交（P10 设计 §3.2）。插件手上没有那份面，也不该猜。
        const result = await $.agent.spawn({
          name: spec.name,
          systemPrompt,
          task: prompt,
          ...(spec.tools === undefined ? {} : { allow: spec.tools }),
          ...(spec.disallowedTools === undefined ? {} : { deny: spec.disallowedTools }),
          ...(model === undefined ? {} : { model }),
          ...(spec.maxTurns === undefined ? {} : { maxHops: spec.maxTurns }),
        });

        // 内核拒了这次派生（今天只有一种：嵌套太深）。翻成工具层的一次 deny，
        // 与 P10 之前那条 deny 在屏幕上长得一模一样。
        if (!result.ok) return { deny: result.reason };

        $.ui.notice(`子代理 ${spec.name} 回来了（${result.stopReason}，第 ${result.depth} 层）`);

        // 子代理失败**不是**让父级整个 turn 炸掉，而是变成本次 tool.call 的错误结果
        // （设计 §5.3）：父级要知道"那个子代理没做完"并继续，而不是自己一起倒下。
        // `ERROR:` 前缀是 loop.ts 判 isError 的依据。
        //
        // ⚠️ 判据是 `isNormalTurn` 这个**白名单**，不是黑名单。P8 之前这里列的是
        // "哪几种算不正常"，于是 `truncated`（被长度上限砍断）不在名单里 —— 一个
        // 只写了一半的子代理把那半截当成完整答复交回父级，谁都不知道它没写完。
        // 正文照带回去：父级既看得见"它没做完"，也拿得到那半截内容。
        if (!isNormalTurn(result.stopReason)) {
          return {
            value: `ERROR: 子代理 ${spec.name} 未正常结束（${result.stopReason}）\n\n${result.text}`,
          };
        }
        return { value: result.text };
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

/** 通知里只放任务的第一行：它是一句进度提示，不是把 prompt 抄一遍。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
