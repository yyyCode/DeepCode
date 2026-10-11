// src/core/nouns/agent.ts
import type { AgentSpawnRequest, AgentSpawnResult } from '../../contract/agent';
import type { EngineInterface } from '../../contract/engine';
import type { Args, EventName, Result } from '../../contract/events';
import type { Message, ModelProvider } from '../../contract/model-provider';
import { CORE_ORIGIN, type Origin } from '../../contract/next';
import type { DispatchFn } from '../dispatch';
import { runTurn, type LoopContext } from '../loop';

/**
 * 子代理名词：内层再跑一遍**同一个** `runTurn`。
 *
 * 不是子进程、不是第二个循环。换的只有三样：一份全新的 messages、一段 system prompt、
 * 一份更小的工具清单。于是"子代理不能做父级不能做的事"是**结构**，不是一条要人守的规则
 * —— 它走的是同一条 `dispatch`、同一条链，`tool.check` 是同一个函数调用。
 */
export function createAgentNoun(deps: {
  /** 延迟取 `$`：折叠完成之前它还不存在，而内层那一轮必须跑在折叠后的 `$` 上。 */
  engine: () => EngineInterface;
  provider: ModelProvider;
  /** signal 是**工厂**：abort 过的 signal 再也回不去，现取才等于"只掐这一次"。 */
  signal: () => AbortSignal;
  dispatch: () => DispatchFn;
}): EngineInterface['agent'] {
  return {
    async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
      const dispatch = deps.dispatch();

      // 派**在开跑之前**：订阅它的插件（将来的 SubagentStart 桥、telemetry）
      // 要在子代理动手之前就看得见。
      await dispatch(
        'agent.spawn',
        {
          name: req.name,
          task: req.task,
          ...(req.model === undefined ? {} : { model: req.model }),
        },
        CORE_ORIGIN,
      );

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
        tools: new Set(req.tools),
        // 覆盖而不是累加：要的就是"最后一段话"。空话不调（loop 里那处 `if (text)`），
        // 所以最后一轮只调了工具没说话时，留下的还是上一次说的话 —— 正是想要的。
        onText: (chunk) => {
          text = chunk;
        },
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.maxHops === undefined ? {} : { maxHops: req.maxHops }),
      };

      const stopReason = await runTurn(ctx, messages);
      return { text, stopReason };
    },
  };
}
