import { describe, expect, it } from 'vitest';
import type { Message } from '../src/contract/model-provider';
import { contextReport } from '../src/cli/context-view';
import { messageChars } from '../src/core/loop';
import type { CompactConfig } from '../src/cli/settings';

const CONFIG: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 6 };

/**
 * 分节的长度**刻意取 4 的倍数**：`estimateTokens` 是 `ceil(chars / 4)`，取整会让
 * "逐节之和 = 合计"在余数上差 1，于是这条测试就会因为一个跟账本无关的取整而红。
 */
const PIECES = [
  { name: 'base', text: '甲'.repeat(400) }, // 100
  { name: 'instructions', text: '乙'.repeat(120) }, // 30
];
const MESSAGES: Message[] = [
  { role: 'user', content: '丙'.repeat(80) }, // 80
  { role: 'assistant', content: [{ type: 'text', text: '丁'.repeat(40) }] }, // 40
];

/**
 * 按**行首**找那一节 —— 不能用 `includes`：账本抬头那句
 * 「（除「上次实测」外都是估的）」会把 `includes('上次实测')` 先截住。
 */
function line(lines: readonly string[], label: string): string {
  const found = lines.find((one) => one.trimStart().startsWith(label));
  // 找不到就报出来是"这一行没了"，比 `undefined` 打进断言里好读。
  return found ?? `（账本里没有以「${label}」开头的那一行）`;
}

describe('/context 账本：三节各自是估的，账要对得上', () => {
  it('逐节之和 = 系统提示那一行（两节都算进去了）', () => {
    const lines = contextReport({ pieces: PIECES, messages: MESSAGES, compact: CONFIG });
    const system = line(lines, '系统提示');
    expect(system).toContain('130 token');
    expect(system).toContain('base 100');
    expect(system).toContain('instructions 30');
  });

  it('系统提示 + 会话消息 = 合计（抽掉一节，合计就变）', () => {
    const full = contextReport({ pieces: PIECES, messages: MESSAGES, compact: CONFIG });
    const clean = contextReport({ pieces: PIECES, messages: [], compact: CONFIG });

    const piecesChars = PIECES.reduce((total, piece) => total + piece.text.length, 0);
    const all = piecesChars + messageChars(MESSAGES);
    expect(line(full, '合计')).toContain(
      // 自己算一遍同一个式子，钉的是"两节都进了合计"，不是函数里那几个数字。
      `${Math.ceil(all / 4)} token`,
    );
    expect(line(full, '会话消息')).toContain(`${Math.ceil(messageChars(MESSAGES) / 4)} token`);
    expect(line(full, '会话消息')).toContain('2 条');
    // 没有消息时合计就该变小 —— 反过来说明上一条不是拿一个常数对上的。
    expect(line(clean, '合计')).not.toContain(`${Math.ceil(all / 4)} token`);
  });

  it('阈值那一行把三个设置都亮出来（千分位是手写的）', () => {
    const lines = contextReport({
      pieces: PIECES,
      messages: MESSAGES,
      compact: { auto: true, atTokens: 100_000, keepTurns: 6 },
    });
    const threshold = line(lines, '阈值');
    expect(threshold).toContain('100,000 token'); // 手写千分位：10 万要能一眼读出来
    expect(threshold).toContain('自动压缩 开');
    expect(threshold).toContain('保留最近 6 轮');
  });

  it('估与实测分得清：端点报的标"端点报的"，估的标"估的"', () => {
    const measured = contextReport({
      pieces: PIECES,
      messages: MESSAGES,
      compact: CONFIG,
      lastUsage: { inputTokens: 1234, estimated: false },
    });
    expect(line(measured, '上次实测')).toContain('1,234 token（端点报的）');

    const guessed = contextReport({
      pieces: PIECES,
      messages: MESSAGES,
      compact: CONFIG,
      lastUsage: { inputTokens: 1_234, estimated: true },
    });
    expect(line(guessed, '上次实测')).toContain('估');
  });

  it('还没发过请求 / 一次性模式：该说"没有"就说"没有"，不编一个 0 出来', () => {
    const none = contextReport({ pieces: PIECES, messages: MESSAGES, compact: CONFIG });
    expect(line(none, '上次实测')).toContain('还没发过请求');

    const oneShot = contextReport({ pieces: undefined, messages: [], compact: CONFIG });
    expect(line(oneShot, '系统提示')).toContain('还没算过');
  });
});

describe('/context 的诚实底线：不报「还剩多少」', () => {
  it('除了那句声明，任何一行都不出现"还剩 / 剩余 / 剩下"', () => {
    const lines = contextReport({
      pieces: PIECES,
      messages: MESSAGES,
      compact: CONFIG,
      lastUsage: { inputTokens: 1234, estimated: false },
    });
    const report = lines.filter((one) => !one.startsWith('不报「还剩多少」'));
    expect(report.some((one) => /还剩|剩余|剩下/.test(one))).toBe(false);
    // 顺带把"没有模型窗口"这件事本身钉住：把这句话删掉，这条测试就该红。
    expect(lines.at(-1)).toContain('没有模型注册表');
  });
});
