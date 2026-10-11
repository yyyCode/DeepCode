// test/offer.test.ts
import { describe, expect, it } from 'vitest';
import { renderOffer } from '../src/cli/offer';

const AGENT = { name: 'explorer', description: '深入探索代码库', tools: ['Read', 'Grep'] as const };
const SKILL = { name: 'design-notes', description: '本项目的设计口径' };

describe('renderOffer', () => {
  it('两节都在，格式是给模型看的那种直白清单', () => {
    const text = renderOffer({ agents: [AGENT], skills: [SKILL] });
    expect(text).toBe(
      [
        '可用子代理（用 Task 工具派发，subagent_type 填名字）：',
        '- explorer: 深入探索代码库（tools: Read, Grep）',
        '',
        '可用技能（用 Skill 工具按名加载）：',
        '- design-notes: 本项目的设计口径',
      ].join('\n'),
    );
  });

  it('省略 tools 的 agent 不印 tools 那一截', () => {
    const text = renderOffer({ agents: [{ name: 'plain', description: 'd' }], skills: [] });
    expect(text).toContain('- plain: d');
    expect(text).not.toContain('tools:');
  });

  it('只有一边时不打另一边的标题', () => {
    const text = renderOffer({ agents: [AGENT], skills: [] });
    expect(text).toContain('可用子代理');
    expect(text).not.toContain('可用技能');
  });

  it('两边都空 → 空串（别给空白加标题）', () => {
    expect(renderOffer({ agents: [], skills: [] })).toBe('');
  });
});
