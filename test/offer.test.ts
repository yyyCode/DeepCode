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
        '可用子代理（用 Task 派发；只读的也可以用 Explore 并发派，subagent_type 填名字）：',
        '- explorer: 深入探索代码库（tools: Read, Grep）',
        '',
        '派发口径：独立、只读的探索优先用 Explore 并发派（同一条回复里可以发多个）；' +
          '要写盘或有先后依赖的用 Task，串行。几条工具调用就能做完的小任务不要派；' +
          '不要让两个子代理改同一个文件。',
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

  it('只读的 agent 印「只读」，与 tools 一起', () => {
    const text = renderOffer({
      agents: [{ name: 'explore', description: 'd', tools: ['Read'], readOnly: true }],
      skills: [],
    });
    expect(text).toContain('- explore: d（只读；tools: Read）');
  });

  it('只读但没有 tools（理论上不会走到）只印「只读」', () => {
    const text = renderOffer({
      agents: [{ name: 'x', description: 'd', readOnly: true }],
      skills: [],
    });
    expect(text).toContain('- x: d（只读）');
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
