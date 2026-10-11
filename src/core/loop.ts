import type {
  ContentBlock,
  Message,
  ModelProvider,
  ToolResult,
  ToolSpec,
} from '../contract/model-provider';
import type { Args, EventName, Result } from '../contract/events';
import type { EngineInterface } from '../contract/engine';
import { CORE_ORIGIN, type Origin } from '../contract/next';

/** 一个 turn 内最多允许的"模型→工具→模型"往返次数，防止模型陷入死循环。 */
const MAX_HOPS = 25;

export type LoopContext = {
  $: EngineInterface;
  provider: ModelProvider;
  signal: AbortSignal;
  dispatch: <N extends EventName>(event: N, args: Args<N>, origin: Origin) => Promise<Result<N>>;
  systemPrompt: string;
  turnIndex: number;
  /**
   * 允许调用的工具。**undefined = 不筛**（会话主循环就是这一支）。
   *
   * 子代理的白名单落在这里。它在**两个**地方被认：
   * `describeTools` 管"看不见"、`runOneTool` 管"够不着" —— 少任何一个都是纸糊的，
   * 因为"看不见"拦不住一个被点名调用的工具（P3 的 todo 插件栽过这一次）。
   */
  tools?: ReadonlySet<string>;
  /** 覆盖 MAX_HOPS。子代理的 maxTurns 落在这里。 */
  maxHops?: number;
  /** 覆盖适配器配置里的 model。省略 = 用配置的那个（= 父级那个）。 */
  model?: string;
  /** 每一轮模型说的话（只在非空时调）。主循环不传 —— 它直接走 turn.step 就出去了。 */
  onText?: (text: string) => void;
};

/**
 * 跑一个完整 turn：把 messages 推进到模型不再要工具为止。messages 会被就地追加。
 *
 * 返回结束时那个 stopReason（'end_turn' / 模型给的 / 'error' / 'interrupted'），
 * 调用方拿它决定退出码 —— 一次性模式下"这一趟失败了"必须是个非零退出码，
 * 否则 `deepcode "..." && 下一步` 会带着错误悄悄往下走。
 */
export async function runTurn(ctx: LoopContext, messages: Message[]): Promise<string> {
  await ctx.dispatch('turn.start', { index: ctx.turnIndex }, CORE_ORIGIN);

  const tools = await describeTools(ctx);
  const maxHops = ctx.maxHops ?? MAX_HOPS;
  let stopReason = 'end_turn';
  // 跑满 hop 就是撞墙了。不区分的话调用方分不清"模型说完了"与"到上限了" ——
  // 子代理那一侧会把两种情况都当正常结束，然后拿一段被截断的话当结论。
  let exhausted = true;

  for (let hop = 0; hop < maxHops; hop++) {
    const blocks: ContentBlock[] = [];
    const toolUses: Extract<ContentBlock, { type: 'tool_use' }>[] = [];
    let text = '';
    let failure: string | undefined;

    // provider 网络错 / 限流：退避重试一次。见设计文档 §5.1。
    for (let attempt = 0; attempt < 2; attempt++) {
      // 每次尝试都清空累积器。不清的话，第一次尝试里已经收到的 tool_use
      // block 会被第二次重放一遍，同一个工具被调用两次。
      // （能走到重试就说明这次一个字符都没流出去，见下面的 `if (text) break`，
      //  所以清空是安全的 —— 用户还没看到任何东西。）
      blocks.length = 0;
      toolUses.length = 0;
      text = '';

      try {
        for await (const event of ctx.provider.stream({
          system: ctx.systemPrompt,
          messages,
          tools,
          signal: ctx.signal,
          model: ctx.model,
        })) {
          if (event.type === 'text') {
            text += event.text;
            // 空增量不必往外抛：它写不出任何字节，却会让渲染器多处理一次。
            if (event.text !== '') {
              await ctx.dispatch('turn.step', { delta: event.text }, CORE_ORIGIN);
            }
          } else if (event.type === 'tool_use') {
            const block = {
              type: 'tool_use' as const,
              id: event.id,
              name: event.name,
              input: event.input,
            };
            blocks.push(block);
            toolUses.push(block);
          } else {
            stopReason = event.stopReason;
          }
        }
        failure = undefined;
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // 用户中断不是 provider 故障：别退避重试、也别打"provider 出错"的日志 ——
        // 重试只会拿着同一个已 abort 的 signal 立刻再失败一次，白等一秒还误导人。
        if (ctx.signal.aborted) break;
        // 已经把部分文本推给用户了，重试会造成重复输出 —— 不再重试。
        if (text) break;
        if (attempt === 0) {
          ctx.$.logger.warn(`provider 出错，1 秒后重试一次：${failure}`);
          await sleep(1000);
        }
      }
    }

    // 重试后仍然失败（或被中断）：结束本 turn，但保留会话、不退出进程。
    if (failure !== undefined) {
      const interrupted = ctx.signal.aborted;
      ctx.$.ui.notice(
        interrupted
          ? '这一回合已被中断（会话保留，可以继续输入）'
          : `本 turn 失败：${failure}（会话保留，可以继续输入）`,
      );
      await ctx.dispatch(
        'turn.complete',
        { stopReason: interrupted ? 'interrupted' : 'error', inputTokens: 0, outputTokens: 0 },
        CORE_ORIGIN,
      );
      return interrupted ? 'interrupted' : 'error';
    }

    const assistantBlocks: ContentBlock[] = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    assistantBlocks.push(...blocks);
    messages.push({ role: 'assistant', content: assistantBlocks });
    // 只在有话说时调：空话会把"上一轮的话"冲掉（子代理那边用的是覆盖式收集器）。
    if (text) ctx.onText?.(text);

    if (toolUses.length === 0) {
      exhausted = false;
      break;
    }

    // 工具仍然**串行**执行：并行 Bash 的交错输出对用户没有任何好处，不确定性倒是白送的。
    // 但结果**汇总成一条**消息 —— 一轮里模型要的几个工具是同一件事的几个面，
    // 拆成多条消息会让支持并行工具调用的端点以为这是几轮（设计 §5）。
    const results: ToolResult[] = [];
    for (const use of toolUses) {
      results.push(await runOneTool(ctx, use));
    }
    messages.push({ role: 'tool', results });
  }

  // 走到这儿说明要么跑满、要么模型自己收手（`exhausted = false`）。
  if (exhausted) stopReason = 'max_hops';

  await ctx.dispatch(
    'turn.complete',
    { stopReason, inputTokens: 0, outputTokens: 0 },
    CORE_ORIGIN,
  );
  return stopReason;
}

/** 抛 tool.check 判定 → 需要就问用户 → 抛 tool.call 执行。 */
async function runOneTool(
  ctx: LoopContext,
  use: Extract<ContentBlock, { type: 'tool_use' }>,
): Promise<ToolResult> {
  // 白名单的第二个落点，**在 tool.check 之前**：清单外的工具根本走不到权限链上。
  // 只做"看不见"不够 —— 模型可以照样点名一个它没见过的工具，插件也可以替你应答它。
  if (ctx.tools !== undefined && !ctx.tools.has(use.name)) {
    return {
      toolUseId: use.id,
      content: `ERROR: 已拒绝 —— 工具 ${use.name} 不在本次的工具清单里（可用：${[...ctx.tools].join(', ')}）`,
      isError: true,
    };
  }

  const check = await ctx.dispatch(
    'tool.check',
    { tool: use.name, input: use.input, toolUseId: use.id },
    CORE_ORIGIN,
  );

  if (check.decision === 'deny') {
    return { toolUseId: use.id, content: `ERROR: 已拒绝 —— ${check.rule ?? '没有给出理由'}`, isError: true };
  }

  if (check.decision === 'ask') {
    const answer = await ctx.$.ui.ask(`执行 ${use.name}? (y/N) `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      return { toolUseId: use.id, content: 'ERROR: 用户拒绝了这次操作', isError: true };
    }
  }

  const result = await ctx.dispatch(
    'tool.call',
    { tool: use.name, input: use.input, toolUseId: use.id },
    CORE_ORIGIN,
  );

  if ('deny' in result) {
    return { toolUseId: use.id, content: `ERROR: ${result.deny}`, isError: true };
  }

  const content = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  return { toolUseId: use.id, content, isError: content.startsWith('ERROR:') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 工具清单与描述都来自 tool.describe 事件 —— 内核里没有硬编码的工具表。 */
async function describeTools(ctx: LoopContext): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  for (const name of ctx.$.tool.list()) {
    // 与下面的 `hidden` 同一条：**安静**略去，一条 debug。
    // 这不是"没注册描述"（那是故障，要 warn），是"这个子代理不许用"。
    if (ctx.tools !== undefined && !ctx.tools.has(name)) {
      ctx.$.logger.debug(`工具 ${name} 不在本次的工具清单里，不进模型可见列表。`);
      continue;
    }
    try {
      const described = await ctx.dispatch('tool.describe', { tool: name }, CORE_ORIGIN);
      // 被权限规则整工具 deny 掉的：**安静**略去（一条 debug）。这不是"没注册描述"
      // —— 那是故障，要 warn —— 而是"策略不让它露面"。两件事混在一起，
      // 会让人以为某个插件坏了。
      if ('hidden' in described) {
        ctx.$.logger.debug(`工具 ${name} 被权限规则隐藏，不进模型可见清单。`);
        continue;
      }
      specs.push({
        name,
        description: described.description,
        inputSchema: described.inputSchema,
      });
    } catch (error) {
      ctx.$.logger.warn(`工具 ${name} 没有注册描述，已从模型可见列表中略去：${String(error)}`);
    }
  }
  return specs;
}
