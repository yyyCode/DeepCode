import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleter, createLineQueue, planItems } from '@deepcode/cli/input';
import { HISTORY_LIMIT, historyPath, loadHistory } from '@deepcode/cli/history';
import { fakeReadline } from './harness';

const collect = async (queue: ReturnType<typeof createLineQueue>): Promise<readonly string[][]> => {
  const batches: string[][] = [];
  for (;;) {
    const batch = await queue.next();
    if (batch === null) return batches;
    batches.push([...batch]);
  }
};

describe('行队列 —— 空窗期与去抖', () => {
  it('⚠️ 队列建好之后到达的行都留得住（`echo … | deepcode` 的死因）', async () => {
    const fake = fakeReadline();
    const queue = createLineQueue(fake.rl, { windowMs: 0 });
    // 这一段就是 `main.ts` 里读设置 / 建转录 / 发现插件那一段空窗：
    // 行在这时候到达，而 REPL 还没开始读。
    fake.pushLine('/diff');
    fake.pushLine('/exit');
    fake.pushEof();

    expect(await collect(queue)).toEqual([['/diff', '/exit']]);
  });

  it('同一批到达的行合成一批；隔开来的各自成批', async () => {
    const fake = fakeReadline();
    const queue = createLineQueue(fake.rl, { windowMs: 0 });

    fake.pushLine('第一行');
    fake.pushLine('第二行');
    expect(await queue.next()).toEqual(['第一行', '第二行']);

    fake.pushLine('第三行');
    expect(await queue.next()).toEqual(['第三行']);
  });

  it('EOF 时**先把攒下的行交出去**，下一次问才给 null', async () => {
    const fake = fakeReadline();
    const queue = createLineQueue(fake.rl, { windowMs: 0 });
    fake.pushLine('半句话');
    fake.pushEof();

    expect(await queue.next()).toEqual(['半句话']);
    expect(await queue.next()).toBeNull();
  });
});

describe('一批行摊成"依次要做的事"', () => {
  it('⚠️ 粘贴 10 行只算**一次**提交（10 次里任何一次都可能让模型去改文件）', () => {
    const pasted = Array.from({ length: 10 }, (_, i) => `第 ${i} 行`);
    const items = planItems(pasted);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'prompt', text: pasted.join('\n'), more: false });
  });

  it('命令**就地切开**：正文先提交，命令再自己跑', () => {
    expect(planItems(['看看这个', '/diff', '接着聊'])).toEqual([
      { kind: 'prompt', text: '看看这个', more: false },
      { kind: 'command', name: 'diff', args: [] },
      { kind: 'prompt', text: '接着聊', more: false },
    ]);
  });

  it('脚本里连着的两条命令就是两条 —— 第二条不会变成第一条的参数', () => {
    expect(planItems(['/diff', '/exit'])).toEqual([
      { kind: 'command', name: 'diff', args: [] },
      { kind: 'command', name: 'exit', args: [] },
    ]);
  });

  it('命令带参数；空行不进正文', () => {
    expect(planItems(['  ', '/config  set  model  x', ''])).toEqual([
      { kind: 'command', name: 'config', args: ['set', 'model', 'x'] },
    ]);
  });

  it('行尾 `\\` 说"还有下一行"：批里还有就接上，没有就交给下一批', () => {
    expect(planItems(['第一行\\', '第二行'])).toEqual([
      { kind: 'prompt', text: '第一行\n第二行', more: false },
    ]);
    expect(planItems(['第一行\\'])).toEqual([
      { kind: 'prompt', text: '第一行', more: true },
    ]);
  });
});

describe('补全', () => {
  const commands = (): readonly string[] => ['diff', 'clear', 'help', 'exit'];
  const complete = createCompleter({
    commands,
    cwd: '/repo',
    // 注入假的目录读取：不碰真的磁盘，`@` 那一条判据才不依赖跑测试的这台机器。
    readDir: () => ['src/', 'README.md', 'a.ts'],
  });

  it('⚠️ `/` 补出来的名字与命令注册表**完全一致**', () => {
    const [hits] = complete('/');
    expect(hits).toEqual(commands().map((name) => `/${name}`));
  });

  it('`/` 按已经敲的字母筛；敲了空格就不管（那是在写参数）', () => {
    expect(complete('/c')[0]).toEqual(['/clear']);
    expect(complete('/diff x')[0]).toEqual([]);
  });

  it('`@` 补当前目录里的路径，目录带尾斜杠', () => {
    expect(complete('@')[0]).toEqual(['@src/', '@README.md', '@a.ts']);
    expect(complete('@a')[0]).toEqual(['@a.ts']);
    // 候选给的是**整行**（readline 用它替换 `rl.line`），所以正文那一截也在里面。
    expect(complete('看看 @RE')[0]).toEqual(['看看 @README.md']);
  });

  it('`@` 只铺 cwd 里的路 —— `..` 与绝对路径一个候选都不给', () => {
    expect(complete('@../')[0]).toEqual([]);
    expect(complete('@/etc/')[0]).toEqual([]);
  });

  it('认不出来的形状不瞎猜', () => {
    expect(complete('随便一句话')).toEqual([[], '随便一句话']);
  });
});

describe('历史文件', () => {
  it('落在用户级 home（**不是项目目录**），最近的在文件末尾', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deepcode-history-'));
    const history = await loadHistory(home, () => {});
    expect(history.entries).toEqual([]);

    // readline 就地 unshift：最近的在**前**。
    history.entries.push('第二条', '第一条');
    await history.save();

    const path = historyPath(home);
    expect(path).toBe(join(home, '.deepcode', 'history'));
    expect(readFileSync(path, 'utf8')).toBe('第一条\n第二条\n');

    // 再读一遍：最近的在最前面（上键先翻到它）。
    expect((await loadHistory(home, () => {})).entries).toEqual(['第二条', '第一条']);
  });

  it.runIf(process.platform !== 'win32')('权限 0600 —— 历史里装的是代码', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deepcode-history-mode-'));
    const history = await loadHistory(home, () => {});
    history.entries.push('export const x = 1;');
    await history.save();
    expect(statSync(historyPath(home)).mode & 0o777).toBe(0o600);
  });

  it('没写进去只喊一声，不抛 —— 历史丢了不影响干活', async () => {
    const lines: string[] = [];
    // 把 home 指到一个**文件**底下：`mkdir` 必失败（ENOTDIR）。
    const file = join(mkdtempSync(join(tmpdir(), 'deepcode-history-bad-')), 'not-a-dir');
    writeFileSync(file, '我是个文件，不是目录\n');
    const history = await loadHistory(join(file, 'x'), (line) => lines.push(line));
    history.entries.push('一条');
    await history.save();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('历史没写进');
  });

  it('上限就是 HISTORY_LIMIT 条', () => {
    expect(HISTORY_LIMIT).toBeGreaterThan(0);
  });
});
