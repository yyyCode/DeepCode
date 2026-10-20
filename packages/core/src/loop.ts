import type {
  ContentBlock,
  Message,
  ModelProvider,
  ToolResult,
  ToolSpec,
  Usage,
} from '@deepcode/contract/model-provider';
import type { Args, EventName, Result } from '@deepcode/contract/events';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { TurnReason } from '@deepcode/contract/turn';
import { CORE_ORIGIN, type Origin } from '@deepcode/contract/next';
import { withContext } from '@deepcode/contract/prompt-channel';
import { listTools } from './tool-list';

/** 一个 turn 内最多允许的"模型→工具→模型"往返次数，防止模型陷入死循环。 */
const MAX_HOPS = 25;

/**
 * 一个 turn 内允许被 `turn.stop` 拦下来的次数上限。
 *
 * 参考实现把这件事交给钩子自己看 `stop_hook_active`，那是把死循环的责任推给写钩子的人。
 * 内核自己兜一道：超了就**忽略 block 并出声** —— 不是静默忽略，
 * "我拦了 4 次你都不理"与"我拦了 4 次"对写钩子的人是两条不同的信息。
 */
export const MAX_STOP_BLOCKS = 3;

/**
 * 一步被输出长度上限截断之后，最多替它接几次（P8 设计 §3.2）。
 *
 * 数取 3 = 与 `MAX_STOP_BLOCKS` 同一个数，而那个数是**我们自己定的**（理由见上）。
 * 复刻对象的对应闸是 8（`2.1.143`）与 14（`2.1.286`）—— **我们没抄它们的数**。
 */
const MAX_CONTINUATIONS = 3;

/** 一步什么都没产出时最多重提示几次。复刻对象对"只回了思考块"的处置就是**一次**（`2.1.183`）。 */
const MAX_EMPTY_NUDGES = 1;

/** 续写时喂回去的话。它是一条**新的 user 消息**，也是模型真的看到的东西 —— 转录里留着。 */
const CONTINUE_PROMPT =
  '上一条回答被输出长度上限截断了。**接着往下写**：从断掉的地方继续，' +
  '不要重复已经写过的内容，也不要重新开头。';

/** 空步之后喂回去的话。同上，它也会留在转录里。 */
const NUDGE_PROMPT = '你上一步没有输出任何内容（只有思考，没有正文）。请直接给出回答。';

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
  /**
   * 每一轮结束时把用量报出去（与 `turn.complete` 是同一条数据）。
   *
   * 自动压缩的触发信号从这儿走，**不是**靠一个监听 `turn.complete` 的插件：插件拿不到
   * `dispatch`，而压缩前后要派 `session.compact`。
   */
  onUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimated: boolean;
  }) => void;
  /**
   * 这一轮真正推进请求里的那份工具清单（P9 §3.2）。
   *
   * 与 `onUsage` 同一条理由：插件拿不到 `dispatch`，而 `/context` 的账本是 CLI 的一屏。
   * 报的是**发出去的那一份**，不是 `/context` 现算的 —— 账本必须与真正的请求可比，
   * 否则它连自己那条"账要对得上"都做不到。
   */
  onTools?: (specs: readonly ToolSpec[]) => void;
};

/**
 * 跑一个完整 turn：把 messages 推进到模型不再要工具为止。messages 会被就地追加。
 *
 * 返回一个 `TurnReason`（见 `contract/turn.ts`）—— **产品语义**那一层，不是端点的步级串。
 * 调用方拿它决定退出码：一次性模式下"这一趟没做成"必须是个非零退出码，
 * 否则 `deepcode "..." && 下一步` 会带着错误悄悄往下走。
 */
export async function runTurn(ctx: LoopContext, messages: Message[]): Promise<TurnReason> {
  await ctx.dispatch('turn.start', { index: ctx.turnIndex }, CORE_ORIGIN);

  // 工具清单的**唯一一份**（`core/tool-list.ts`）：模型拿到的、`/help` 列的、`/tools` 列的
  // 与账本算的是同一个函数的结果（P9 §3.1）。`onTools` 把这一份原样报给账本。
  const { specs: tools } = await listTools({
    $: ctx.$,
    dispatch: ctx.dispatch,
    ...(ctx.tools === undefined ? {} : { tools: ctx.tools }),
  });
  ctx.onTools?.(tools);
  const maxHops = ctx.maxHops ?? MAX_HOPS;
  // 端点的**步级**停止原因。它只活在这个函数里，一步都不许漏到 `turn.complete` 上
  // —— 那一层是产品语义，翻译只有 `reasonOf` 那一处。
  let lastStep = 'end_turn';
  // 跑满 hop 就是撞墙了。不区分的话调用方分不清"模型说完了"与"到上限了" ——
  // 子代理那一侧会把两种情况都当正常结束，然后拿一段被截断的话当结论。
  let exhausted = true;
  // 已经因为 `turn.stop` 被拦住过几次。上限见 MAX_STOP_BLOCKS。
  let blocked = 0;
  // 截断续写了几次、空步重提示了几次。上限见上面两个常量。
  let continuations = 0;
  let nudges = 0;
  // 因为截断而断续写下来的那几段拼起来的一份。**只跨相邻的续写步**：走进工具分支就清掉
  // （对话已经翻页了），见下面 onText 那一处的理由。
  let carried = '';
  // 最后一步是不是"什么都没产出"。收场理由要用它。
  let lastEmpty = false;

  // 两处收场（失败与正常）共用这一份 —— 原先它们各自写死 `inputTokens: 0`，
  // 于是 `turn.complete` 长期在报假账，而压缩器唯一的信号就是它。
  let usage: Usage | undefined;
  const complete = async (reason: TurnReason): Promise<void> => {
    const tokens = turnUsage(usage, ctx.systemPrompt, messages);
    ctx.onUsage?.(tokens);
    await ctx.dispatch(
      'turn.complete',
      // 估的时候才带这个字段：带上一个 `false` 会让"端点报了"与"我们猜的"长得一模一样，
      // 而消费端要把这两件事分开。
      tokens.estimated
        ? {
            stopReason: reason,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            usageEstimated: true,
          }
        : { stopReason: reason, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens },
      CORE_ORIGIN,
    );
  };

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
      usage = undefined; // 与 text 同一个道理：重试的那一次不该继承上一次的用量

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
            lastStep = event.stopReason;
            usage = event.usage;
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
      // 已经吐给用户的那几段字**要留在对话里**：屏幕上显示了、转录里却一个字都没有，
      // 那叫记录撒谎（P8 设计 §3.4；改之前这一段确实在 `messages` 里什么都不剩）。
      //
      // 只推 text，**绝不推 tool_use**：这次工具根本没跑，一个没有配对 tool_result 的
      // tool_use block 会让下一次请求的 messages 非法。适配器只在参数收齐之后才发
      // tool_use，所以"半个工具调用"到不了这儿 —— 这句是留给下一个改适配器的人的。
      //
      // 也不给它加"（不完整）"这类注记：模型说过的话就是它说过的话，往正文里掺一句我们
      // 自己的话就是篡改转录。"不完整"由**收场理由 + 下面这条通知**承担。
      if (text !== '') {
        messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
        // 子代理那一侧也拿得到这半句：它回给父级的是"ERROR: 未正常结束（error）+ 正文"。
        ctx.onText?.(carried + text);
      }
      ctx.$.ui.notice(
        interrupted
          ? '这一回合已被中断（会话保留，可以继续输入）'
          : `本 turn 失败：${failure}（会话保留，可以继续输入）`,
      );
      await complete(interrupted ? 'interrupted' : 'error');
      return interrupted ? 'interrupted' : 'error';
    }

    const assistantBlocks: ContentBlock[] = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    assistantBlocks.push(...blocks);
    // 全空的一步**不往对话里塞**：一条 `content: []` 的 assistant 消息既没信息，又会随
    // 下一次请求原样发出去（P8 设计 §3.3；这条是实测的 —— 改之前它确实躺在 `messages` 里）。
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    }
    // 只在有话说时调：空话会把"上一轮的话"冲掉（子代理那边用的是覆盖式收集器）。
    // 带上 `carried`：续写出来的第二段与第一段是**同一句话**，而那个收集器是覆盖式的，
    // 只给它最后那半截就等于把前半句丢了。
    if (text) ctx.onText?.(carried + text);

    lastEmpty = text === '' && blocks.length === 0;

    if (toolUses.length === 0) {
      // ① 被输出长度上限截断：**这不是收手**，把它接着写完（P8 设计 §3.2）。
      if (lastStep === 'max_tokens' && continuations < MAX_CONTINUATIONS) {
        continuations += 1;
        carried += text;
        // 每一次都出声：这里多花的是**一次真的模型请求**，不许悄悄花。
        ctx.$.ui.notice(
          `这一轮被输出长度上限截断，接着往下写（第 ${continuations}/${MAX_CONTINUATIONS} 次）`,
        );
        messages.push({ role: 'user', content: CONTINUE_PROMPT });
        continue;
      }
      // ② 什么都没产出（可能只回了思考块）：重提示一次。顺序上排在收手之前 ——
      //    一步没产出的模型不是"准备收手"，不该由 `turn.stop` 那道缝来裁决。
      if (lastEmpty && nudges < MAX_EMPTY_NUDGES) {
        nudges += 1;
        ctx.$.ui.notice('模型这一步什么都没产出（可能只回了思考块），重提示一次。');
        messages.push({ role: 'user', content: NUDGE_PROMPT });
        continue;
      }
      // ③ 这才轮到"模型说完了" —— 但钩子可能不许它收手（Ralph 式循环的落点）。
      const stopped = await ctx.dispatch(
        'turn.stop',
        { stopHookActive: blocked > 0, lastMessage: text },
        CORE_ORIGIN,
      );
      const keepGoing = stopped.block?.trim() ?? '';
      if (keepGoing !== '') {
        if (blocked < MAX_STOP_BLOCKS) {
          blocked += 1;
          // 作为**一条新的 user 消息**推进去：它是"还没干完，接着干"的指令，
          // 本来就该是新一轮的输入。`continue` 走下一跳。
          messages.push({ role: 'user', content: keepGoing });
          continue;
        }
        ctx.$.ui.notice(`钩子第 ${MAX_STOP_BLOCKS} 次不让收手，已忽略（再往下就该是死循环了）`);
      }
      // 真要收在这儿了：如果是 ① / ② 用尽，得说清楚 —— 否则屏幕上只有一段没头没尾的
      // 回答（或者干脆什么都没有），没人知道为什么停在这儿。
      if (lastStep === 'max_tokens') {
        ctx.$.ui.notice(
          `已续写 ${MAX_CONTINUATIONS} 次仍然被长度上限截断，就此收手 —— 上面那段回答是半截的。`,
        );
      } else if (lastEmpty) {
        ctx.$.ui.notice('模型两次都没有产出任何内容，这一轮就此结束。');
      }
      exhausted = false;
      break;
    }

    // 对话翻页了（去调工具）：前面那半句不再接在这句话头上。
    carried = '';
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
  // 跑满压过一切：撞墙比"最后那一步为什么停"更该说。
  const reason: TurnReason = exhausted ? 'max_hops' : reasonOf(lastStep, lastEmpty);
  await complete(reason);
  return reason;
}

/**
 * 步级 → 轮级。**唯一一处**翻译，别在别的地方再看端点的串（P8 设计 §3.1）。
 *
 * 没建模的步级值一律归 `answer`：从产品视角看它就是"模型说完了"。至于供应商管这件事叫
 * `end_turn`、`pause_turn` 还是别的，与我们无关 —— 那正是把两层分开要买的东西
 * （复刻对象自己都说不清 `pause_turn` 的语义，见 `12-execution-loop.md` 存疑 4）。
 */
function reasonOf(step: string, empty: boolean): TurnReason {
  if (step === 'max_tokens') return 'truncated';
  if (step === 'refusal') return 'refusal';
  return empty ? 'empty' : 'answer';
}

/**
 * 一段文本的 token 数**粗估**。参数是**字符数**不是文本 —— 两处调用方手里本来就是长度。
 *
 * ⚠️ 它是估计，不是测量：中英混排会失真（中文一个字约 1–2 个 token，不是 0.25 个）。
 * 之所以留着它，是因为"什么都不报"比"报一个标出来的估计"更坏 —— 前者让消费端
 * 以为上下文是空的。
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 一个消息数组的**字符数**。工具结果与工具入参都算进去 —— 它们也是要占窗口的东西。 */
export function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      total += message.content.length;
    } else if (message.role === 'tool') {
      for (const result of message.results) total += result.content.length;
    } else {
      for (const block of message.content) {
        total +=
          block.type === 'text' ? block.text.length : JSON.stringify(block.input ?? {}).length;
      }
    }
  }
  return total;
}

/** 这一轮的用量。端点报了就报真的；没报就估算并**标出来**。 */
function turnUsage(
  usage: Usage | undefined,
  systemPrompt: string,
  messages: readonly Message[],
): { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean } {
  if (usage !== undefined) {
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: false };
  }
  return {
    inputTokens: estimateTokens(systemPrompt.length + messageChars(messages)),
    outputTokens: 0,
    estimated: true,
  };
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
    // 三个答案：`y` 放行这一次、`a` 放行**本次会话这一类**、其余一律算拒绝
    // （沿用 P1 那句"按别的键都算拒绝"，fail-closed 的方向不动）。
    //
    // 内核交出去的是**选项**（值 + 文案），不是一行拼好的提示语：菜单长什么样、
    // 光标停在哪儿，是界面的事。第一项就是光标默认停的那一项（回车即放行这一次），
    // `fallback` 单列出来 —— "没人回答"与"人挑了拒绝"是同一件事，但落点必须写死，
    // 不能靠选项顺序去推。
    //
    // 为什么问人的是**内核**而不是链上某一层：只有整条 `tool.check` 链跑完，
    // "要不要问"才是确定的 —— 托管策略判死的调用，不该先问一遍人再告诉他不算。
    const answer = await ctx.$.ui.ask(`执行 ${use.name}?`, {
      choices: [
        { value: 'y', label: '允许这一次' },
        { value: 'a', label: '本次会话总是允许' },
        { value: 'n', label: '拒绝' },
      ],
      fallback: 'n',
    });
    const said = answer.trim().toLowerCase();
    const once = said === 'y' || said === 'yes';
    const always = said === 'a' || said === 'all';
    if (!once && !always) {
      return { toolUseId: use.id, content: 'ERROR: 用户拒绝了这次操作', isError: true };
    }
    // 内核只把"人说了什么"报出去 —— 翻成规则、记住、下次据此裁决，是 `permissions` 的事。
    await ctx.dispatch(
      'tool.consent',
      { tool: use.name, input: use.input, toolUseId: use.id, granted: always ? 'always' : 'once' },
      CORE_ORIGIN,
    );
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
  // 沿用既有那条判据（原先直接写在这一行的 `isError` 里）：工具自己报错时返回一段
  // 以 `ERROR:` 开头的正文。另立一套会让同一件事有两个判据。
  const ok = !content.startsWith('ERROR:');

  const observed = await ctx.dispatch(
    'tool.result',
    { tool: use.name, input: use.input, toolUseId: use.id, ok, output: content },
    CORE_ORIGIN,
  );

  return { toolUseId: use.id, content: withContext(content, observed.context), isError: !ok };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
