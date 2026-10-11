import type { ToolSpec } from '../contract/model-provider';
import type { EngineInterface } from '../contract/engine';
import { CORE_ORIGIN } from '../contract/next';
import type { DispatchFn } from './dispatch';

/**
 * **模型这一轮能用的工具** —— 那一份清单的唯一算法（P9 设计 §3.1）。
 *
 * 它以前是 `loop.ts` 里的私有 `describeTools`，而"有哪些工具"这件事同时有三个消费者：
 * 模型（请求里的 `tools`）、`/help`（打的是注册面的 `$.tool.list()`）、`/context`（一个字都没算）。
 * 三处里两处看到的不是同一份 —— 复刻对象那句「在列表里 ≠ 能跑」正是这个形状
 * （`13-tool-system.md` A5）。搬出来是为了让它们**共用一个函数**，不是为了多一个文件。
 *
 * ⚠️ 与 `$.tool.list()` 的分工（两个都要，别拿一个替另一个）：
 * - `$.tool.list()` 是**注册面**：谁注册了 `tool.call {tool: X}`。它是这里的**输入**
 *   （下面那行 `for` 就是从它数起的），`/help` 在没注入清单时会退回它并当场标明"未过滤"。
 * - 这里是**模型面**：注册面再过滤两道（白名单、`hidden`、没注册描述）之后剩下的那一份。
 *
 * P10 之前子代理的白名单吃的是注册面（`cli/subagents.ts` 那个 `resolveTools`），于是
 * "父级这一轮看得见什么"根本没人算 —— 嵌套一层就把被扣掉的面拿回来了（P10 设计 §2.1
 * 探针 A 实测）。现在派子代理也走**这一个**函数：`core/nouns/agent.ts` 拿父级那一轮
 * 的面当白名单再算一次。**模型面只有一份算法**这句话，从 P10 起对子代理也成立。
 */
export type ToolListing = {
  /** 模型能看到的，顺序 = `$.tool.list()` 的顺序（= 注册顺序）。 */
  readonly specs: readonly ToolSpec[];
  /**
   * 不在可见清单里的，**逐个带原因**。
   *
   * 「隐身」与「故障」必须分得开（`cli/commands.ts:196` 那条注释）：
   * 白名单外与被规则隐藏是**设计**，没注册描述是**故障** —— 三句措辞本身就是判据，
   * `test/tool-list.test.ts` 钉的是它们。所以别为了省事把它们合并成一句。
   */
  readonly skipped: readonly { readonly name: string; readonly why: string }[];
};

/** 白名单外 —— 这是设计（子代理的工具面），不是故障。 */
const WHY_NOT_IN_LIST = '不在本次的工具清单里';
/** 被权限规则整工具 deny 掉 —— 也是设计（策略不让它露面）。 */
const WHY_HIDDEN = '被权限规则隐藏';
/** 没有注册描述 —— 这一条是故障，措辞里得说出来，不然读的人会当它是前两类。 */
const WHY_NO_DESCRIPTION = '没有注册描述（tool.describe 无人应答 —— 这是故障）';

export async function listTools(deps: {
  readonly $: EngineInterface;
  readonly dispatch: DispatchFn;
  /** 子代理的白名单。省略 = 不筛（会话主循环走的是这一支）。 */
  readonly tools?: ReadonlySet<string>;
}): Promise<ToolListing> {
  const specs: ToolSpec[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const name of deps.$.tool.list()) {
    // 与下面 `hidden` 那一条同源：**安静**略去，一条 debug。
    // 这不是"没注册描述"（那是故障，要 warn），是"这个子代理不许用"。
    if (deps.tools !== undefined && !deps.tools.has(name)) {
      deps.$.logger.debug(`工具 ${name} 不在本次的工具清单里，不进模型可见列表。`);
      skipped.push({ name, why: WHY_NOT_IN_LIST });
      continue;
    }
    try {
      const described = await deps.dispatch('tool.describe', { tool: name }, CORE_ORIGIN);
      // 被权限规则整工具 deny 掉的：**安静**略去（一条 debug）。这不是"没注册描述"
      // —— 那是故障，要 warn —— 而是"策略不让它露面"。两件事混在一起，
      // 会让人以为某个插件坏了。
      if ('hidden' in described) {
        deps.$.logger.debug(`工具 ${name} 被权限规则隐藏，不进模型可见清单。`);
        skipped.push({ name, why: WHY_HIDDEN });
        continue;
      }
      specs.push({
        name,
        description: described.description,
        inputSchema: described.inputSchema,
      });
    } catch (error) {
      deps.$.logger.warn(`工具 ${name} 没有注册描述，已从模型可见列表中略去：${String(error)}`);
      skipped.push({ name, why: WHY_NO_DESCRIPTION });
    }
  }

  return { specs, skipped };
}

/**
 * 一个工具在请求里占的**字符数**：名字 + 描述 + schema 的 JSON。
 *
 * 与 `messageChars`（`core/loop.ts`）同一个口径、同一个用途：它们都是"要占窗口的东西"，
 * 换算成 token 的那一步由调用方走 `estimateTokens` —— 两处必须用**同一个**换算，
 * 账本的 `合计` 才对得上（P9 设计 §3.2 口径 1）。
 *
 * 计数里含 `JSON.stringify` 带上来的那几个键名（约几十字符），这不是精确的线上字节数：
 * 适配器怎么序列化是它的事（`providers/anthropic.ts` / `openai.ts` 各自不同）。
 * 这一份是**估**，全账本都是估的 —— 掺一点结构性开销比假装精确好。
 */
export function toolSpecChars(spec: ToolSpec): number {
  return spec.name.length + spec.description.length + JSON.stringify(spec.inputSchema).length;
}

export function toolsChars(specs: readonly ToolSpec[]): number {
  return specs.reduce((total, spec) => total + toolSpecChars(spec), 0);
}
