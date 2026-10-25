import type { ContextLayerConfig } from '../contract/context-window';
import type { Message, ToolResult } from '../contract/model-provider';
import { estimateTokens, messageChars } from './tokens';

/**
 * 五层压缩里**纯的**那一半（P11）。
 *
 * 这里不碰磁盘、不碰 provider、不碰渲染：第 1 层的写盘回调是参数，第 4 层的摘要
 * 由 `cli/context-window.ts` 调用后把正文传进来。于是测试与 benchmark 都能在没有
 * 文件系统、没有网络的条件下跑同一套算法。
 */

/** 结果可重新获取的工具。只有这些的老结果允许被清空（第 3 层）。 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'Write',
  'Edit',
]);

/** 被清空的老工具结果长什么样。模型看到它就知道"这里原来有内容"。 */
export const CLEARED_TOOL_RESULT = '[旧工具结果已清理]';

/**
 * 从尾部数第 `keepTurns` 条 `role:'user'` 消息的下标。
 * 一轮 = 一条 user 消息**及其之后**的一切。
 *
 * 返回 `undefined` = 没有可切的：历史不够、或切点正好在第 0 条（切了等于没切）。
 * 与 `cli/compact.ts` 的 `splitAt` 同一个判据，但这里是纯函数、不依赖 CLI。
 */
export function turnCut(messages: readonly Message[], keepTurns: number): number | undefined {
  if (keepTurns <= 0) return undefined;

  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== 'user') continue;
    seen += 1;
    if (seen === keepTurns) return index === 0 ? undefined : index;
  }
  return undefined;
}

/** 从消息里建 `toolUseId → 工具名`。第 3 层要靠它判断哪些结果可清。 */
export function toolNamesOf(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
    }
  }
  return names;
}

/** 这一轮请求的字符数：系统提示 + 工具清单 + 消息。三样就是请求里真有的东西。 */
export function requestChars(
  systemChars: number,
  toolChars: number,
  messages: readonly Message[],
): number {
  return systemChars + toolChars + messageChars(messages);
}

export function requestTokens(
  systemChars: number,
  toolChars: number,
  messages: readonly Message[],
): number {
  return estimateTokens(requestChars(systemChars, toolChars, messages));
}

/**
 * 第 1 层：挑出要落盘的结果下标。
 *
 * 两条判据合在一次选择里：
 * 1. 单个结果 > `toolResultMaxChars`；
 * 2. 同一条 tool 消息总量 > `toolMessageMaxChars` —— 从最大的开始继续外置，直到降下来。
 *
 * 预览按「预览长度 + 一段固定开销」估算，不调 `makePreview`：选择逻辑要保持纯且便宜。
 */
export function chooseExternalized(
  results: readonly ToolResult[],
  config: ContextLayerConfig,
): readonly number[] {
  const chosen = new Set<number>();
  const previewWeight = Math.max(0, config.toolResultPreviewChars) + 400;

  for (let index = 0; index < results.length; index++) {
    const content = results[index]?.content ?? '';
    if (content.length > config.toolResultMaxChars) chosen.add(index);
  }

  const effective = (index: number): number => {
    const content = results[index]?.content ?? '';
    return chosen.has(index) ? Math.min(content.length, previewWeight) : content.length;
  };
  const total = (): number => results.reduce((sum, _result, index) => sum + effective(index), 0);

  let size = total();
  while (size > config.toolMessageMaxChars) {
    let largest = -1;
    for (let index = 0; index < results.length; index++) {
      if (chosen.has(index)) continue;
      if (largest === -1 || (results[index]?.content.length ?? 0) > (results[largest]?.content.length ?? 0)) {
        largest = index;
      }
    }
    // 没有可再外置的了：总量就停在这儿。**不抛** —— 上下文管理失败不能弄挂一个 turn。
    if (largest === -1) break;
    chosen.add(largest);
    size = total();
  }

  return [...chosen].sort((a, b) => a - b);
}

/** 预览正文。路径写进去 —— 这是模型找回全文的唯一线索。 */
export function makePreview(
  content: string,
  path: string,
  config: ContextLayerConfig,
  toolName?: string,
): string {
  const limit = Math.max(0, config.toolResultPreviewChars);
  const shown = content.slice(0, limit);
  const omitted = content.length - shown.length;
  const how =
    toolName === 'Bash'
      ? '重新执行命令，或用 Read 读这个文件（offset / limit）'
      : '用 Read 读这个文件（offset / limit 指定行范围）';

  return (
    `[大工具结果已存盘] 完整内容 ${content.length} 字符，存于 ${path}。\n` +
    `下面只保留前 ${shown.length} 字符的预览${omitted > 0 ? `（其余 ${omitted} 字符已存盘）` : ''}：\n\n` +
    `${shown}\n\n` +
    `[预览结束] 需要后续内容时，${how}。`
  );
}

export type ExternalizeResult = {
  readonly results: readonly ToolResult[];
  readonly externalized: number;
  readonly externalizedChars: number;
};

/**
 * 第 1 层：把选中的结果交给 `write` 落盘，并替换成预览。
 *
 * `write` 返回 `undefined` = 写失败（写盘是便利功能，不该把 turn 弄挂）——
 * 那一条原样保留完整内容。这是本层唯一一处 fail-open，与压缩器「压不成就不压」
 * 同一个方向。
 */
export async function externalizeLargeResults(
  results: readonly ToolResult[],
  names: ReadonlyMap<string, string>,
  config: ContextLayerConfig,
  write: (toolUseId: string, content: string) => Promise<string | undefined>,
): Promise<ExternalizeResult> {
  const chosen = new Set(chooseExternalized(results, config));
  if (chosen.size === 0) return { results, externalized: 0, externalizedChars: 0 };

  const next: ToolResult[] = [];
  let externalized = 0;
  let externalizedChars = 0;

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result === undefined) continue;
    if (!chosen.has(index)) {
      next.push(result);
      continue;
    }

    const path = await write(result.toolUseId, result.content);
    if (path === undefined) {
      next.push(result); // fail-open：写不进去就把完整内容留着
      continue;
    }

    next.push({
      ...result,
      content: makePreview(result.content, path, config, names.get(result.toolUseId)),
    });
    externalized += 1;
    externalizedChars += result.content.length;
  }

  return { results: next, externalized, externalizedChars };
}

/** 第 2 层的结果。`messages` 是新数组；原数组一条不动。 */
export type SnipResult = {
  readonly messages: readonly Message[];
  readonly removed: number;
};

/**
 * 第 2 层：砍掉切点之前的整轮对话，把边界标记**并进**切点后的第一条 user 消息。
 *
 * 合并而不是单插一条 user 消息：连续两条 user 是某些端点会拒的形状（`cli/repl.ts`）。
 */
export function snipOld(messages: readonly Message[], keepTurns: number): SnipResult {
  const cut = turnCut(messages, keepTurns);
  if (cut === undefined) return { messages, removed: 0 };

  const tail = messages.slice(cut);
  const marker =
    `[上下文清理] 更早的 ${cut} 条消息已不在本次请求里（完整历史仍在转录）。` +
    `以下是最近 ${keepTurns} 轮：`;
  const first = tail[0];

  if (first?.role === 'user') {
    return {
      messages: [
        { role: 'user', content: `${marker}\n\n${first.content}` },
        ...tail.slice(1),
      ],
      removed: cut,
    };
  }

  return { messages: [{ role: 'user', content: marker }, ...tail], removed: cut };
}

export type MicroResult = {
  readonly messages: readonly Message[];
  readonly cleared: number;
};

/**
 * 第 3 层：保留最近 `keepRecent` 个可重新获取的工具结果，其余清成标记。
 *
 * 不可重新获取的工具（`Task`、子 Agent 等）**永远不清** —— 它们的推理过程不可重复。
 * 已经清过的结果不再参与「最近 N 个」的计数，否则旧标记会把真正需要保留的结果挤出去。
 */
export function microCompact(messages: readonly Message[], keepRecent: number): MicroResult {
  const names = toolNamesOf(messages);
  const compactable: string[] = [];

  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const result of message.results) {
      if (result.content === CLEARED_TOOL_RESULT) continue;
      const name = names.get(result.toolUseId);
      if (name !== undefined && COMPACTABLE_TOOLS.has(name)) compactable.push(result.toolUseId);
    }
  }

  const keep = Math.max(0, keepRecent);
  const clear = new Set(compactable.slice(0, Math.max(0, compactable.length - keep)));
  if (clear.size === 0) return { messages, cleared: 0 };

  let cleared = 0;
  const next = messages.map((message) => {
    if (message.role !== 'tool') return message;
    let touched = false;
    const results = message.results.map((result) => {
      if (!clear.has(result.toolUseId)) return result;
      touched = true;
      cleared += 1;
      return { ...result, content: CLEARED_TOOL_RESULT, isError: false };
    });
    return touched ? { role: 'tool' as const, results } : message;
  });

  return { messages: next, cleared };
}

export type CollapseResult = {
  readonly messages: readonly Message[];
  readonly removed: number;
};

/**
 * 第 4 层：用一段摘要替换更早的整轮对话。**只用于读时投影** ——
 * 调用方拿它算「这一次请求发什么」，原始 `messages` 一个字不动。
 *
 * 摘要与切点后的第一条 user 消息合并，理由与第 2 层相同。
 */
export function collapseOld(
  messages: readonly Message[],
  keepTurns: number,
  summary: string,
): CollapseResult | undefined {
  const cut = turnCut(messages, keepTurns);
  if (cut === undefined) return undefined;

  const head = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const block =
    `[更早对话的投影摘要] 以下是前 ${head.length} 条消息的摘要` +
    `（原文仍在转录里，本次请求不带）：\n\n${summary}`;
  const first = tail[0];

  if (first?.role === 'user') {
    return {
      messages: [{ role: 'user', content: `${block}\n\n${first.content}` }, ...tail.slice(1)],
      removed: head.length,
    };
  }

  return { messages: [{ role: 'user', content: block }, ...tail], removed: head.length };
}
