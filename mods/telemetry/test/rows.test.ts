import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatRow,
  telemetryPath,
  validateEntry,
  type TelemetryEntry,
} from '../rows';

/**
 * 这一组测的是**这份功能唯一的隐私闸门**：什么算"不是自由文本"。
 * 所以反面用例是逐条写的（每个值一种），不是一条 `it.each` 糊过去 ——
 * 每一种漏过去的形状都会是一次泄漏。
 */
describe('validateEntry：什么能记', () => {
  it('kind 是标识符、字段是数字 / 布尔 / 标识符 → 过', () => {
    const entry: TelemetryEntry = {
      kind: 'turn.complete',
      fields: {
        tool_name: 'Bash',
        mcp__x__y: 1,
        at: '2026-10-11T10:00:00.000Z',
        ok: true,
        n: 0,
      },
    };
    expect(validateEntry(entry)).toEqual({ ok: true, kind: 'turn.complete', fields: entry.fields });
  });

  it('没有 fields → 过，fields 是空对象', () => {
    expect(validateEntry({ kind: 'session.start' })).toEqual({
      ok: true,
      kind: 'session.start',
      fields: {},
    });
  });

  it('长度为 64 的 kind 过，65 不过', () => {
    expect(validateEntry({ kind: 'a'.repeat(64) }).ok).toBe(true);
    expect(validateEntry({ kind: 'a'.repeat(65) }).ok).toBe(false);
  });

  it('负数与小数都过（它们不是自由文本）', () => {
    expect(validateEntry({ kind: 'k', fields: { n: -1.5 } }).ok).toBe(true);
  });
});

describe('validateEntry：什么不许记', () => {
  const BAD_KIND: ReadonlyArray<readonly [string, unknown]> = [
    ['空串', ''],
    ['带空格', 'turn complete'],
    ['带中文', '转动'],
    ['以点开头', '.turn'],
    ['以横线开头', '-turn'],
    ['带斜杠（那就是路径）', 'a/b'],
    ['带引号', "turn'"],
    ['undefined', undefined],
    ['数字', 3],
    ['null', null],
  ];

  for (const [label, kind] of BAD_KIND) {
    it(`kind ${label} → 拒`, () => {
      const result = validateEntry({ kind } as TelemetryEntry);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('kind');
    });
  }

  it('字段名带空格 → 拒（连键名都不许是自由文本）', () => {
    const result = validateEntry({ kind: 'k', fields: { 'tool name': 'Bash' } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('字段名');
  });

  const BAD_VALUE: ReadonlyArray<readonly [string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['对象', { a: 1 }],
    ['数组', ['a']],
    ['带空格的字符串', 'git push'],
    ['带中文的字符串', '推送'],
    ['空串', ''],
  ];

  for (const [label, value] of BAD_VALUE) {
    it(`字段值是 ${label} → 拒，且连这条记录整条都不落`, () => {
      const result = validateEntry({ kind: 'k', fields: { tool: value } as never });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('tool');
    });
  }

  it('一条记录里坏了一个字段，好字段也救不回来', () => {
    const result = validateEntry({ kind: 'k', fields: { ok: true, path: 'a/b' } });
    expect(result.ok).toBe(false);
  });
});

describe('formatRow / telemetryPath', () => {
  it('一行一条、能被 JSON.parse 读回来', () => {
    const row = { at: '2026-10-11T10:00:00.000Z', seq: 7, kind: 'tool.result', fields: { ok: true } };
    const text = formatRow(row);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual(row);
  });

  it('两条拼在一起就是两行 jsonl', () => {
    const a = formatRow({ at: 'a', seq: 1, kind: 'k', fields: {} });
    const b = formatRow({ at: 'b', seq: 2, kind: 'k', fields: {} });
    expect((a + b).trimEnd().split('\n').map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
  });

  it('路径在**用户级**目录下 —— 与转录同一条道理，不跟仓库走', () => {
    expect(telemetryPath('/home/u')).toBe(join('/home/u', '.deepcode', 'telemetry.jsonl'));
  });
});
