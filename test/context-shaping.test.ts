import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_LAYERS } from '../src/contract/context-window';
import type { Message, ToolResult } from '../src/contract/model-provider';
import {
  CLEARED_TOOL_RESULT,
  chooseExternalized,
  collapseOld,
  externalizeLargeResults,
  makePreview,
  microCompact,
  snipOld,
  turnCut,
} from '../src/core/context-shaping';
import { messageChars } from '../src/core/tokens';

const FILLER = '细节'.repeat(10);

/** 一轮 = user + assistant（含一个 tool_use）+ tool 结果。 */
function toolTurn(index: number, toolName = 'Read', chars = 0): Message[] {
  return [
    { role: 'user', content: `问题${index}：${FILLER}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `回答${index}` },
        { type: 'tool_use', id: `u${index}`, name: toolName, input: { file_path: `f${index}` } },
      ],
    },
    {
      role: 'tool',
      results: [
        {
          toolUseId: `u${index}`,
          content: chars > 0 ? 'x'.repeat(chars) : `结果${index}：${FILLER}`,
          isError: false,
        },
      ],
    },
  ];
}

function turns(count: number, toolName = 'Read', chars = 0): Message[] {
  const out: Message[] = [];
  for (let index = 1; index <= count; index++) out.push(...toolTurn(index, toolName, chars));
  return out;
}

const serialized = (messages: readonly Message[]): string => JSON.stringify(messages);

describe('turnCut：切点落在轮边界', () => {
  it('保留最近 N 轮，切在倒数第 N 条 user 消息上', () => {
    expect(turnCut(turns(10), 3)).toBe(21);
  });

  it('历史不够 / 切点在第 0 条 → undefined', () => {
    expect(turnCut(turns(2), 3)).toBeUndefined();
    expect(turnCut(turns(3), 3)).toBeUndefined();
  });
});

describe('第 2 层 snipOld：砍整轮、合并边界标记', () => {
  it('移除切点前的消息，标记并进切点后的第一条 user 消息', () => {
    const original = turns(10);
    const before = serialized(original);
    const out = snipOld(original, 3);

    expect(out.removed).toBe(21);
    expect(out.messages).toHaveLength(9); // 3 轮 × 3 条
    const first = out.messages[0];
    expect(first?.role).toBe('user');
    const text = first?.role === 'user' ? first.content : '';
    expect(text).toContain('上下文清理');
    expect(text).toContain('问题8'); // 倒数第 3 轮的第一条 user
    // 没有多插一条 user：标记与原消息合并了。
    expect(out.messages.filter((m) => m.role === 'user')).toHaveLength(3);
    // 原数组一个字不动。
    expect(serialized(original)).toBe(before);
  });

  it('没有可切的历史 → 原样返回', () => {
    const original = turns(2);
    expect(snipOld(original, 3)).toEqual({ messages: original, removed: 0 });
  });
});

describe('第 3 层 microCompact：只清可重新获取的结果，保留最近 N 个', () => {
  it('Read 清、Task 不清；tool_use/tool_result 配对保持', () => {
    const original: Message[] = [
      ...toolTurn(100, 'Task', 5_000),
      ...turns(8, 'Read', 100),
    ];
    const before = serialized(original);

    const out = microCompact(original, 5);

    // 8 个可清结果里保留最近 5 个，清掉前 3 个。
    expect(out.cleared).toBe(3);
    const results = out.messages
      .filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
      .map((m) => m.results[0]!);
    expect(results[0]!.content).toHaveLength(5_000); // Task 不在可清集合里
    expect(results[1]!.content).toBe(CLEARED_TOOL_RESULT);
    expect(results[3]!.content).toBe(CLEARED_TOOL_RESULT);
    expect(results[8]!.content).not.toBe(CLEARED_TOOL_RESULT);
    // 配对：toolUseId 一个不少。
    expect(results.map((r) => r.toolUseId)).toEqual([
      'u100',
      ...Array.from({ length: 8 }, (_, i) => `u${i + 1}`),
    ]);
    // 原数组一个字不动。
    expect(serialized(original)).toBe(before);
  });
});

describe('第 4 层 collapseOld：摘要投影，不改原历史', () => {
  it('用摘要替换 head，并与 tail 的第一条 user 合并', () => {
    const original = turns(10);
    const before = serialized(original);
    const out = collapseOld(original, 3, '这是摘要正文');

    expect(out?.removed).toBe(21);
    expect(out?.messages).toHaveLength(9);
    const first = out?.messages[0];
    expect(first?.role).toBe('user');
    const text = first?.role === 'user' ? first.content : '';
    expect(text).toContain('投影摘要');
    expect(text).toContain('这是摘要正文');
    expect(text).toContain('问题8');
    expect(out?.messages.filter((m) => m.role === 'user')).toHaveLength(3);
    expect(serialized(original)).toBe(before);
  });

  it('没有可折叠的历史 → undefined', () => {
    expect(collapseOld(turns(2), 3, '摘要')).toBeUndefined();
  });
});

describe('第 1 层：选择与预览', () => {
  const result = (id: string, chars: number): ToolResult => ({
    toolUseId: id,
    content: 'x'.repeat(chars),
    isError: false,
  });

  it('单结果超过阈值就外置', () => {
    const chosen = chooseExternalized(
      [result('a', 60_000), result('b', 100), result('c', 100)],
      DEFAULT_CONTEXT_LAYERS,
    );
    expect(chosen).toEqual([0]);
  });

  it('单条消息总量超限时，从最大的开始继续外置', () => {
    const chosen = chooseExternalized(
      [result('a', 40_000), result('b', 40_000), result('c', 40_000)],
      { ...DEFAULT_CONTEXT_LAYERS, toolResultMaxChars: 50_000, toolMessageMaxChars: 100_000 },
    );
    // 三个都没超过单结果阈值，但总量 120K > 100K；外置一个就够降下来。
    expect(chosen).toEqual([0]);
  });

  it('预览带路径、长度信息与恢复建议', () => {
    const preview = makePreview('甲'.repeat(10_000), 'C:/tmp/big.txt', DEFAULT_CONTEXT_LAYERS, 'Read');
    expect(preview).toContain('大工具结果已存盘');
    expect(preview).toContain('C:/tmp/big.txt');
    expect(preview).toContain('10000 字符');
    expect(preview).toContain('offset');
    // 预览本身远小于原文。
    expect(preview.length).toBeLessThan(3_000);

    const bash = makePreview('x'.repeat(10_000), 'C:/tmp/bash.txt', DEFAULT_CONTEXT_LAYERS, 'Bash');
    expect(bash).toContain('重新执行命令');
  });

  it('外置：全文交给 write，消息里只留预览；写失败则原样保留', async () => {
    const written: { id: string; content: string }[] = [];
    const ok = await externalizeLargeResults(
      [result('u1', 60_000), result('u2', 10)],
      new Map([['u1', 'Read']]),
      DEFAULT_CONTEXT_LAYERS,
      async (id, content) => {
        written.push({ id, content });
        return `C:/tmp/${id}.txt`;
      },
    );
    expect(written).toEqual([{ id: 'u1', content: 'x'.repeat(60_000) }]);
    expect(ok.externalized).toBe(1);
    expect(ok.externalizedChars).toBe(60_000);
    expect(ok.results[0]?.content).toContain('C:/tmp/u1.txt');
    expect(ok.results[0]?.content.length).toBeLessThan(3_000);
    expect(ok.results[1]?.content).toBe('x'.repeat(10));

    const failed = await externalizeLargeResults(
      [result('u1', 60_000)],
      new Map(),
      DEFAULT_CONTEXT_LAYERS,
      async () => undefined,
    );
    expect(failed.externalized).toBe(0);
    expect(failed.results[0]?.content).toBe('x'.repeat(60_000));
  });
});

describe('五层是单调减负的阶梯', () => {
  it('逐层套用之后字符数只降不升', () => {
    // 12 轮，每轮 30K 工具结果：第 1 层外置一批，第 2 层砍轮次，第 3 层清老结果，
    // 第 4 层折叠。每一层都必须真的变小。
    const raw = turns(12, 'Read', 30_000);
    const afterL1 = raw.map((message) =>
      message.role === 'tool'
        ? {
            ...message,
            results: message.results.map((r) => ({
              ...r,
              content: makePreview(r.content, 'C:/tmp/x.txt', DEFAULT_CONTEXT_LAYERS, 'Read'),
            })),
          }
        : message,
    );
    const afterL2 = snipOld(afterL1, 4).messages;
    const afterL3 = microCompact(afterL2, 1).messages;
    const collapsed = collapseOld(afterL3, 2, '摘要');
    expect(collapsed).toBeDefined();
    const afterL4 = collapsed?.messages ?? [];

    const sizes = [raw, afterL1, afterL2, afterL3, afterL4].map(messageChars);
    for (let index = 1; index < sizes.length; index++) {
      expect(sizes[index]!).toBeLessThan(sizes[index - 1]!);
    }
  });
});
