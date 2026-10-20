import { describe, expect, it } from 'vitest';
import { createPalette } from '@deepcode/cli/ansi';
import type { FileChange } from '@deepcode/cli/changes';
import { changeStat, formatChange } from '@deepcode/cli/diff-render';
import { previewLines, stat } from '@deepcode/cli/preview-view';
import { createTally, exitLines, formatElapsed, formatTokens } from '@deepcode/cli/tally';

const plain = createPalette(false);
const root = '/repo';

const text = (value: string): { readonly kind: 'text'; readonly text: string } => ({
  kind: 'text',
  text: value,
});

function change(before: FileChange['before'], after: FileChange['after']): FileChange {
  return { path: '/repo/a.ts', before, after };
}

describe('账本 —— 两个数是给人看的量级', () => {
  it('token 数：过千才缩，缩了留一位小数', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
  });

  it('耗时：一分钟以下给秒，过了给 `2m12s`', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(8400)).toBe('8.4s');
    expect(formatElapsed(59_900)).toBe('59.9s');
    expect(formatElapsed(60_000)).toBe('1m0s');
    expect(formatElapsed(132_000)).toBe('2m12s');
  });
});

describe('改动面 —— `+3 −1` 与确认框', () => {
  it('两个数都是 0 时说"没有净改动"，而不是印一截空白', () => {
    expect(stat(0, 0, plain)).toBe('没有净改动');
    expect(stat(3, 0, plain)).toBe('+3');
    expect(stat(0, 1, plain)).toBe('−1');
    expect(stat(3, 1, plain)).toBe('+3 −1');
  });

  it('⚠️ `+N −M` 与 `/diff` 那块数出来的**一模一样**（同一份数据、同一套 diff）', () => {
    const one = change(text('a\nb\nc'), text('a\nB\nc\nd'));
    const counted = changeStat(one);
    expect(counted).toBeDefined();

    // 拿 `/diff` 真正印出来的那一屏回数一遍：`+` / `-` 开头的正文行。
    // 表头那两行（`--- a/…` / `+++ b/…`）不算。
    const pane = formatChange(one, root, plain).split('\n');
    const added = pane.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const removed = pane.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
    expect(counted).toEqual({ added, removed });
  });

  it('拿不到内容（skipped）就**给不出数字**，绝不编一个 `+0 −0`', () => {
    expect(changeStat(change({ kind: 'skipped', why: '文件太大' }, text('x')))).toBeUndefined();
    expect(changeStat(change(text('x'), { kind: 'skipped', why: '是目录' }))).toBeUndefined();
  });

  it('新文件整篇都是加行', () => {
    expect(changeStat(change({ kind: 'absent' }, text('a\nb')))).toEqual({ added: 2, removed: 0 });
  });

  it('确认框：Bash 给命令本身', () => {
    const lines = previewLines('Bash', { command: 'pnpm test' }, plain);
    expect(lines.join('\n')).toContain('Bash  $ pnpm test');
  });

  it('确认框：Edit 给出 `− 旧 / + 新` 两截与 `+1 −1`', () => {
    const lines = previewLines('Edit', { file_path: 'a.ts', old_string: 'b', new_string: 'B' }, plain);
    const all = lines.join('\n');
    expect(all).toContain('Edit  a.ts  +1 −1');
    expect(all).toContain('  - b');
    expect(all).toContain('  + B');
  });

  it('确认框：Write 只给头三行，但**说清后面还有多少**', () => {
    const content = Array.from({ length: 7 }, (_, i) => `第 ${i} 行`).join('\n');
    const all = previewLines('Write', { file_path: 'a.ts', content }, plain).join('\n');
    expect(all).toContain('Write  a.ts  7 行');
    expect(all).toContain('+ 第 2 行');
    expect(all).not.toContain('第 3 行');
    expect(all).toContain('… 还有 4 行');
  });

  it('开着色时确认框真的上色了（关掉色则逐字节纯文本）', () => {
    const colored = createPalette(true);
    expect(previewLines('Bash', { command: 'ls' }, colored).join('\n')).toContain('\u001b[1m');
    expect(previewLines('Bash', { command: 'ls' }, plain).join('\n')).not.toContain('\u001b[');
  });
});

describe('退出摘要 —— 与每轮摘要、/diff 同一本账', () => {
  const options = { root, now: () => 12_400 };

  it('没改过文件就不提"改了几个文件"，也不列那行名字', () => {
    const tally = { ...createTally(() => 0), toolCalls: 2, tokens: 1500, sessionStartedAt: 1000 };
    const lines = exitLines(tally, [], plain, options);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  ⎿  本次会话 2 次工具调用 · 1.5k tokens · 11.4s');
  });

  it('改过就把文件名列出来 —— 那是退出时最想再看一眼的东西', () => {
    const tally = { ...createTally(() => 0), toolCalls: 7, tokens: 4200, sessionStartedAt: 1000 };
    const lines = exitLines(tally, [change(text('a'), text('b'))], plain, {
      ...options,
      transcriptPath: '/home/u/.deepcode/sessions/x/s1.jsonl',
    });
    expect(lines[0]).toContain('本次会话 7 次工具调用 · 改 1 个文件 · 4.2k tokens');
    expect(lines[1]).toContain('改了：a.ts');
    expect(lines[2]).toContain('转录：/home/u/.deepcode/sessions/x/s1.jsonl（--resume 可以接上）');
  });

  it('⚠️ 只要有一轮是**估**的，退出时那个 token 数就标上 `（估）`', () => {
    const tally = { ...createTally(() => 0), tokens: 900, estimated: true, sessionStartedAt: 1000 };
    expect(exitLines(tally, [], plain, options)[0]).toContain('900 tokens（估）');
  });

  it('会话开始时长为 0（时钟没走过）不会印出一个荒唐的数字', () => {
    const tally = createTally(() => 0);
    expect(exitLines(tally, [], plain, options)[0]).toContain('0.0s');
  });
});
