import { describe, expect, it } from 'vitest';
import {
  BRIDGED_EVENTS,
  CLASSIC_EVENTS,
  isBridged,
  isClassicEvent,
  parseMatcher,
} from '@deepcode/contract/classic';

describe('classic 事件目录', () => {
  // 33 这个数在设计文档里出现过（"33 个 classic 事件"）。加一个事件就得改这里，
  // 于是"文档说 33、代码里 40"这种事不会悄悄发生。
  it('恰好 33 个，且不重复', () => {
    expect(CLASSIC_EVENTS.length).toBe(33);
    expect(new Set(CLASSIC_EVENTS).size).toBe(33);
  });

  it('认得出白名单里的名字，认不出别的', () => {
    expect(isClassicEvent('PreToolUse')).toBe(true);
    expect(isClassicEvent('SessionStart')).toBe(true);
    expect(isClassicEvent('tool.call')).toBe(false);
    expect(isClassicEvent('pretooluse')).toBe(false);
  });

  it('桥接的恰好六个，且都真的在事件目录里', () => {
    const bridged = Object.keys(BRIDGED_EVENTS);
    expect(bridged.sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    for (const event of bridged) expect(isClassicEvent(event)).toBe(true);
  });

  it('桥接的目标全是我们已有的事件', () => {
    expect(BRIDGED_EVENTS.PreToolUse).toBe('tool.check');
    expect(BRIDGED_EVENTS.PostToolUse).toBe('tool.result');
    expect(BRIDGED_EVENTS.UserPromptSubmit).toBe('prompt.submit');
    expect(BRIDGED_EVENTS.Stop).toBe('turn.stop');
    expect(BRIDGED_EVENTS.SessionStart).toBe('session.start');
    expect(BRIDGED_EVENTS.SessionEnd).toBe('session.end');
  });

  it('未桥接的 27 个事件认得出是 classic、但认得出没桥接', () => {
    const unbridged = CLASSIC_EVENTS.filter((event) => !isBridged(event));
    expect(unbridged.length).toBe(27);
    expect(unbridged).toContain('PostToolUseFailure');
    expect(isBridged('PostToolUseFailure')).toBe(false);
  });
});

describe('parseMatcher', () => {
  it('* 是"全部"', () => {
    expect(parseMatcher('*')).toBe('*');
    expect(parseMatcher('  *  ')).toBe('*');
  });

  it('精确名', () => {
    expect(parseMatcher('Write')).toEqual(['Write']);
    expect(parseMatcher('mcp__plugin_asana_tool')).toEqual(['mcp__plugin_asana_tool']);
  });

  it('A|B 拆开，两侧空白不管', () => {
    expect(parseMatcher('Write|Edit')).toEqual(['Write', 'Edit']);
    expect(parseMatcher('Write | Edit | Bash')).toEqual(['Write', 'Edit', 'Bash']);
  });

  it.each(['mcp__.*__delete.*', '.*', 'Write|.*', '^Write$', 'Write(1)', 'a b'])(
    '正则形态 %j 判成 regex —— 不放大到所有工具',
    (matcher) => {
      expect(parseMatcher(matcher)).toBe('regex');
    },
  );

  it('只有竖线没有名字，也是 regex（不是"零个工具"）', () => {
    // 返回空数组会被读成"只对零个工具生效"，那是个安静的失效；判成 regex 会被跳过并警告。
    expect(parseMatcher('||')).toBe('regex');
  });
});
