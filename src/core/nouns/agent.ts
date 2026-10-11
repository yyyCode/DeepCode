// src/core/nouns/agent.ts
import type { AgentSpawnRequest, AgentSpawnResult } from '../../contract/agent';
import type { EngineInterface } from '../../contract/engine';
import type { Args, EventName, Result } from '../../contract/events';
import type { Message, ModelProvider } from '../../contract/model-provider';
import { CORE_ORIGIN, type Origin } from '../../contract/next';
import type { DispatchFn } from '../dispatch';
import { runTurn, type LoopContext } from '../loop';
import { listTools } from '../tool-list';

/**
 * 子代理名词：内层再跑一遍**同一个** `runTurn`。
 *
 * 不是子进程、不是第二个循环。换的只有三样：一份全新的 messages、一段 system prompt、
 * 一份更小的工具清单。于是"子代理不能做父级不能做的事"是**结构**，不是一条要人守的规则
 * —— 它走的是同一条 `dispatch`、同一条链，`tool.check` 是同一个函数调用。
 *
 * ⚠️ 上面那句话在 P10 之前**只有前半截成立**：那时的工具清单是调用方按**会话注册过哪些
 * 工具**算的，于是嵌套一层就能把被扣掉的面拿回来（P10 设计 §2.1 探针 A 实测：外层 2 个、
 * 内层 8 个）。现在这份面与"能派多深"都由这里按**当前这一轮**算 —— 事实在哪一层，
 * 判定就在哪一层。
 *
 * **面栈为什么只能是栈**：插件调 `$.agent.spawn` 时手上没有父面的任何线索（`$` 是引擎全局的），
 * 父面只存在于"此刻跑着的那几层 loop"里。串行执行（工具是一个一个跑的）下这个栈不会交错；
 * 一个插件若用 `Promise.all` 并发派，层级会算错 —— 今天没有这条路径（P10 设计 §3.3/§5）。
 */
const MAX_DEPTH = 3;

export function createAgentNoun(deps: {
  /** 延迟取 `$`：折叠完成之前它还不存在，而内层那一轮必须跑在折叠后的 `$` 上。 */
  engine: () => EngineInterface;
  provider: ModelProvider;
  /** signal 是**工厂**：abort 过的 signal 再也回不去，现取才等于"只掐这一次"。 */
  signal: () => AbortSignal;
  dispatch: () => DispatchFn;
}): EngineInterface['agent'] {
  /** 正在跑的那几层 loop 各自的面（模型看得见的工具名）。**长度 = 已经在第几层。** */
  const faces: ReadonlySet<string>[] = [];
  /** 与面栈同生共死 —— 只用来在拒绝消息里说清"谁派的谁"。 */
  const names: string[] = [];

  /**
   * 一份面 = 注册面再过三道（本次限制 / `hidden` / 有注册描述）之后剩下的名字。
   *
   * 算法只有一份（`core/tool-list.ts` 的 `listTools`，P9 立的），这里不另起一套：
   * "模型这一轮看得见什么"与"子代理该继承什么"是同一个问题。
   */
  async function faceOf(only?: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    const { specs } = await listTools({
      $: deps.engine(),
      dispatch: deps.dispatch(),
      ...(only === undefined ? {} : { tools: only }),
    });
    return new Set(specs.map((spec) => spec.name));
  }

  return {
    async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
      // 深度先判、且判在**这里**：所有路径（`Task`、插件直派、将来的任何入口）都从这一行过。
      // 装在调用方那儿的保险丝只挡得住那一个调用方 —— 复刻对象栽过同一个形状
      // （它的前台路径一度比后台松），P10 设计 §2.1 探针 B 是我们的实测。
      if (faces.length >= MAX_DEPTH) {
        return {
          ok: false,
          reason: `嵌套太深了（${[...names, req.name].join(' → ')}，上限 ${MAX_DEPTH} 层）`,
        };
      }
      const depth = faces.length + 1;

      const dispatch = deps.dispatch();

      // 派**在开跑之前**：订阅它的插件（将来的 SubagentStart 桥、telemetry）
      // 要在子代理动手之前就看得见。`depth` 是那份事实的一部分（P10 设计 §3.5）。
      await dispatch(
        'agent.spawn',
        {
          name: req.name,
          task: req.task,
          ...(req.model === undefined ? {} : { model: req.model }),
          depth,
        },
        CORE_ORIGIN,
      );

      // 栈顶就是"父级这一轮的面"；栈底那一格由这里现算（会话这一层没有白名单，
      // 所以它等于"模型看得见的全部"）。
      const parent = faces.at(-1) ?? (await faceOf());

      // `allow` 是**求交**不是替换：写在一个 agent 文件里的 `tools` 只能把面缩小，
      // 不能靠派一层子代理把被扣掉的工具拿回来（P10 设计 §3.2）。
      for (const name of req.allow ?? []) {
        if (!parent.has(name)) {
          deps
            .engine()
            .logger.debug(`子代理 ${req.name} 要的工具 ${name} 不在父级这一轮的面里，已丢掉。`);
        }
      }
      const requested =
        req.allow === undefined
          ? parent
          : new Set([...parent].filter((name) => req.allow?.includes(name) === true));
      const allowed =
        req.deny === undefined
          ? requested
          : new Set([...requested].filter((name) => req.deny?.includes(name) !== true));

      // 这一轮模型真正看得见的那一份（再过一次 `hidden` 与"没注册描述"两道）。
      // 用它当内层的白名单，于是"父级看不见的"在子代理里连点名也够不着（P10 设计 §3.1）。
      const face = await faceOf(allowed);

      // 子代理说的话不往屏幕上流，理由不是"省事"：它是父级那一轮的一个工具调用，
      // 让它自己的文本混进输出，用户会以为那是回答。
      //
      // 只能从 dispatch 这一层拦：`cli-stream` 是**拿自己的 render 闭包**直接写屏幕的
      // （cli/stream.ts），换一个安静的 `$` 根本拦不住它。
      //
      // **只吞 turn.step，其余一律照发**：
      // - `tool.*` 必须照发 —— 子代理改的文件要进 `/diff`（createChangesPlugin 记的账）。
      //   静音静的是**屏幕**，不是**事实**。
      // - `turn.start` / `turn.complete` 也必须照发 —— 它们记的是"这里真跑过一轮"。
      const silent: DispatchFn = <N extends EventName>(
        event: N,
        args: Args<N>,
        origin: Origin,
      ): Promise<Result<N>> =>
        event === 'turn.step' ? Promise.resolve({} as never) : dispatch(event, args, origin);

      let text = '';
      const messages: Message[] = [{ role: 'user', content: req.task }];
      const ctx: LoopContext = {
        $: deps.engine(),
        provider: deps.provider,
        signal: deps.signal(),
        dispatch: silent,
        systemPrompt: req.systemPrompt,
        // 子代理自己那本账从 0 开始。
        turnIndex: 0,
        tools: face,
        // 覆盖而不是累加：要的就是"最后一段话"。空话不调（loop 里那处 `if (text)`），
        // 所以最后一轮只调了工具没说话时，留下的还是上一次说的话 —— 正是想要的。
        onText: (chunk) => {
          text = chunk;
        },
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.maxHops === undefined ? {} : { maxHops: req.maxHops }),
      };

      faces.push(face);
      names.push(req.name);
      try {
        const stopReason = await runTurn(ctx, messages);
        return { ok: true, text, stopReason, depth };
      } finally {
        // 抛出去（Ctrl-C 打的是整条链）也要把这一层摘掉：栈里留一格，父级从此少一层
        // 可用深度，而且"这一层还在跑"会一直是假的。
        names.pop();
        faces.pop();
      }
    },
  };
}
