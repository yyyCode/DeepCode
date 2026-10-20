import { describe, expect, it } from 'vitest';
import { banner, shouldShowBanner } from '@deepcode/cli/banner';
import { createPalette } from '@deepcode/cli/ansi';
import { displayWidth } from '@deepcode/cli/width';
import { parseArgs } from '@deepcode/cli/args';

const info = {
  version: '1.2.3',
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
  root: '/repo',
  sessionId: 's-1',
};

/** 关掉色：**逐字节**断言的地方用这一支（开着色时比较的是纯文本，不是转义序列）。 */
const plain = (over: Partial<Parameters<typeof banner>[0]> = {}): string =>
  banner({ ...info, ...over }, createPalette(false)).join('\n');

describe('开场那一屏', () => {
  it('该说的四件事都在：我是谁、在跟谁说话、在哪个目录、这次能不能接上', () => {
    const text = plain();
    expect(text).toContain('DeepCode v1.2.3');
    expect(text).toContain('claude-sonnet-5-5（anthropic）');
    expect(text).toContain('/repo');
    expect(text).toContain('s-1');
    expect(text).toContain('--resume');
  });

  it('换过端点就把端点写出来；没换就不提这一茬', () => {
    expect(plain({ baseUrl: 'https://api.deepseek.com/v1' })).toContain(
      'https://api.deepseek.com/v1',
    );
    expect(plain()).not.toContain('http');
  });

  it('⚠️ 不落盘时说"接不上"，而不是摆一个 id 让人白试一次 --resume', () => {
    const text = plain({ sessionId: undefined });
    expect(text).toContain('不落盘');
    expect(text).not.toContain('--resume 能接上');
  });

  it('关掉色时逐字节就是纯文本：一个转义序列都不许有', () => {
    expect(plain({ baseUrl: 'https://x/v1' })).not.toContain('\u001b');
  });

  it('不画边框、不引整屏 —— 行内增强那三条禁令在这一屏上也成立', () => {
    // 框线字符一个都不出现（`▟▛` 是那个标志，不是框）。
    expect(plain()).not.toMatch(/[┌┐└┘─│├┤╭╮╰╯]/);
    // 更不许申请 alternate screen（那是整屏 TUI 的形态）。
    expect(plain()).not.toContain('1049');
  });

  it('色开着时标题加粗、标签压暗，而正文一个字不变', () => {
    const colored = banner({ ...info, baseUrl: 'https://x/v1' }, createPalette(true)).join('\n');
    expect(colored).toContain('\u001b[1m▟▛ DeepCode\u001b[0m');
    expect(colored).toContain('\u001b[2m模型    \u001b[0m');
    // 剥掉转义序列之后就等于关掉色的那一份 —— 上色不许多吐或吞掉任何一个字。
    expect(colored.replace(/\u001b\[\d+m/g, '')).toBe(plain({ baseUrl: 'https://x/v1' }));
  });

  it('⚠️ 没有提示词时才画 —— 而"没有提示词"就是**空串**，不是 undefined', () => {
    // 这条测的是"到底画不画"，不是"画出来什么"。第一版就是在这里栽的：
    // 判据写成 `text === undefined`，于是整屏字一个都没出现，而上面那几条
    // 全绿 —— 它们测的是 `banner()` 本身，不包含"有没有被叫到"。
    expect(shouldShowBanner('', true)).toBe(true);
    expect(shouldShowBanner('改一下 X', true)).toBe(false);
    expect(shouldShowBanner('', false)).toBe(false);
  });

  it('⚠️ 钉住那个陷阱：`parseArgs([])` 给的是空串 —— 判据跟着这个事实走', () => {
    const parsed = parseArgs([]);
    expect(parsed.kind).toBe('prompt');
    const text = parsed.kind === 'prompt' ? parsed.text : null;
    // 不是 `undefined`。任何用"没给提示词 = undefined"写的判据，都恒假。
    expect(text).toBe('');
    expect(shouldShowBanner(text!, true)).toBe(true);
  });

  it('三个标签把值对齐到同一列（按显示宽度算，不按字符数）', () => {
    const fields = banner(info, createPalette(false)).filter((line) => line.startsWith('  '));
    // `模型`（4 列）/ `工作区`（6 列）/ `会话`（4 列）三种标签，值都从第 11 列开始
    // —— 差一列，屏幕上就是三个参差不齐的值（而它们是这屏最该一眼扫到的东西）。
    const starts = ['claude-sonnet-5-5', '/repo', 's-1'].map((value, i) => {
      const line = fields[i]!;
      return displayWidth(line.slice(0, line.indexOf(value)));
    });
    expect(starts).toEqual([11, 11, 11]);
  });
});
