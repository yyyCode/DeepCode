import type { ContentBlock, Message, ModelProvider, ToolSpec } from '../contract/model-provider';
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
};

/** 跑一个完整 turn：把 messages 推进到模型不再要工具为止。messages 会被就地追加。 */
export async function runTurn(ctx: LoopContext, messages: Message[]): Promise<void> {
  await ctx.dispatch('turn.start', { index: ctx.turnIndex }, CORE_ORIGIN);

  const tools = await describeTools(ctx);
  let stopReason = 'end_turn';

  for (let hop = 0; hop < MAX_HOPS; hop++) {
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
        })) {
          if (event.type === 'text') {
            text += event.text;
            await ctx.dispatch('turn.step', { delta: event.text }, CORE_ORIGIN);
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
        // 已经把部分文本推给用户了，重试会造成重复输出 —— 不再重试。
        if (text) break;
        if (attempt === 0) {
          ctx.$.logger.warn(`provider 出错，1 秒后重试一次：${failure}`);
          await sleep(1000);
        }
      }
    }

    // 重试后仍然失败：结束本 turn，但保留会话、不退出进程。
    if (failure !== undefined) {
      ctx.$.ui.notice(`本 turn 失败：${failure}（会话保留，可以继续输入）`);
      await ctx.dispatch('turn.complete', { stopReason: 'error', inputTokens: 0, outputTokens: 0 }, CORE_ORIGIN);
      return;
    }

    const assistantBlocks: ContentBlock[] = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    assistantBlocks.push(...blocks);
    messages.push({ role: 'assistant', content: assistantBlocks });

    if (toolUses.length === 0) break;

    for (const use of toolUses) {
      const output = await runOneTool(ctx, use);
      messages.push({
        role: 'tool',
        toolUseId: use.id,
        content: output.text,
        isError: output.isError,
      });
    }
  }

  await ctx.dispatch(
    'turn.complete',
    { stopReason, inputTokens: 0, outputTokens: 0 },
    CORE_ORIGIN,
  );
}

/** 抛 tool.check 判定 → 需要就问用户 → 抛 tool.call 执行。 */
async function runOneTool(
  ctx: LoopContext,
  use: Extract<ContentBlock, { type: 'tool_use' }>,
): Promise<{ text: string; isError: boolean }> {
  const check = await ctx.dispatch(
    'tool.check',
    { tool: use.name, input: use.input },
    CORE_ORIGIN,
  );

  if (check.decision === 'deny') {
    return { text: `ERROR: 已拒绝 —— ${check.rule ?? '没有给出理由'}`, isError: true };
  }

  if (check.decision === 'ask') {
    const answer = await ctx.$.ui.ask(`执行 ${use.name}? (y/N) `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      return { text: 'ERROR: 用户拒绝了这次操作', isError: true };
    }
  }

  const result = await ctx.dispatch(
    'tool.call',
    { tool: use.name, input: use.input, toolUseId: use.id },
    CORE_ORIGIN,
  );

  if ('deny' in result) {
    return { text: `ERROR: ${result.deny}`, isError: true };
  }

  const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  return { text, isError: text.startsWith('ERROR:') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 工具清单与描述都来自 tool.describe 事件 —— 内核里没有硬编码的工具表。 */
async function describeTools(ctx: LoopContext): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  for (const name of ctx.$.tool.list()) {
    try {
      const described = await ctx.dispatch('tool.describe', { tool: name }, CORE_ORIGIN);
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
