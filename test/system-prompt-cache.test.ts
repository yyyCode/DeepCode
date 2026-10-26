import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '../src/cli/system-prompt';
import {
  STATIC_PROMPT_SECTIONS,
  renderEnvironment,
  type PromptEnvironment,
} from '../src/cli/prompt-text';

const ENV: PromptEnvironment = {
  cwd: 'F:\\work\\app',
  gitRepo: true,
  platform: 'Windows',
  shell: 'bash',
  model: 'deepseek-chat',
  today: '2026-10-26',
};

/**
 * P13 的核心不变量：**静态段逐字节稳定，动态段每轮可重算**。
 *
 * 缓存命中靠的是前缀逐字节相同 —— 只要静态段里混进一个 cwd 或时间戳，
 * 整段缓存就作废。这里钉的不是某个具体字节数，而是"哪些东西允许出现在哪一段"。
 */
describe('系统提示的静态/动态边界（P13）', () => {
  it('静态前置逐字节稳定，并且是整段提示的前缀', () => {
    const first = assemblePrompt({
      environment: ENV,
      sections: [{ name: 'instructions', text: '项目甲的约定' }],
      offer: '审阅者：专挑毛病',
    });
    const second = assemblePrompt({
      environment: { ...ENV, cwd: 'D:\\work\\other', today: '2026-10-27' },
      sections: [{ name: 'instructions', text: '项目乙的约定' }],
      offer: '',
    });

    // 换项目、换日期，静态段一个字节都不许动。
    expect(second.staticText).toBe(first.staticText);
    expect(first.text.startsWith(first.staticText)).toBe(true);
    expect(first.text).toBe(`${first.staticText}\n\n${first.dynamicText}`);
    expect(second.dynamicText).not.toBe(first.dynamicText);
  });

  it('环境只进动态段：cwd / 日期 / 仓库状态都不在静态前缀里', () => {
    const built = assemblePrompt({ environment: ENV, sections: [], offer: '' });

    expect(built.staticText).not.toContain(ENV.cwd);
    expect(built.staticText).not.toContain(ENV.today);
    expect(built.dynamicText).toContain('工作目录：F:\\work\\app');
    expect(built.dynamicText).toContain('Git 仓库：是');
    expect(built.dynamicText).toContain('平台：Windows');
    expect(built.dynamicText).toContain('Shell：bash');
    expect(built.dynamicText).toContain('模型：deepseek-chat');
    expect(built.dynamicText).toContain('今天：2026-10-26');

    expect(built.pieces.find((piece) => piece.name === 'environment')?.cache).toBe('dynamic');
    expect(built.pieces.filter((piece) => piece.cache === 'static').length).toBeGreaterThan(0);
  });

  it('静态段在前、动态段在后；分节账仍然是 `text` 的那一份', () => {
    const built = assemblePrompt({
      environment: ENV,
      sections: [{ name: 'instructions', text: '项目约定' }],
      offer: '技能：写测试',
    });

    const names = built.pieces.map((piece) => piece.name);
    expect(names.indexOf('environment')).toBeGreaterThan(names.indexOf('output'));
    expect(names.indexOf('instructions')).toBeGreaterThan(names.indexOf('environment'));
    expect(names.at(-1)).toBe('offer');
    expect(built.text).toBe(built.pieces.map((piece) => piece.text).join('\n\n'));
    // 静态段与动态段的拼法必须与整段一致，否则账本上"静态 + 动态"对不上实际请求。
    expect(built.text).toBe([built.staticText, built.dynamicText].filter((text) => text !== '').join('\n\n'));
  });

  it('没有环境时退回 P12 的形状：不硬塞一段空环境', () => {
    const built = assemblePrompt({ sections: [{ name: 'instructions', text: '约定' }], offer: '' });
    expect(built.pieces.map((piece) => piece.name)).toEqual([
      ...STATIC_PROMPT_SECTIONS.map((section) => section.name),
      'instructions',
    ]);
    expect(built.dynamicText).toBe('约定');
    expect(built.text).toBe(`${built.staticText}\n\n${built.dynamicText}`);
  });

  it('环境渲染把"不是 Git 仓库"也如实写出来，不省略', () => {
    const text = renderEnvironment({ ...ENV, gitRepo: false });
    expect(text).toContain('Git 仓库：否');
  });

  it('静态分节真的装着那几条红线（不是占位符）', () => {
    const text = STATIC_PROMPT_SECTIONS.map((section) => section.text).join('\n');

    expect(text).toContain('范围');
    expect(text).toContain('可逆');
    expect(text).toContain('--amend');
    expect(text).toContain('force push');
    expect(text).toContain('Read');
    expect(text).toContain('Grep');
    expect(text).toContain('URL');
    expect(text).toContain('ERROR:');
  });
});
