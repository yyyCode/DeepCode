import { describe, expect, it } from 'vitest';
import { candidatePaths, sandboxRule } from '../src/contract/sandbox';
import { parseRule, type Rule } from '../src/contract/policy';

/**
 * 候选提取只是**切分**，不是 shell 解析 —— 它不认识变量、命令替换、`cd &&`。
 * 这一节钉的是"我们想得到的写法都取到了"，不是"取全了"。
 */
describe('candidatePaths：只切分，不解析', () => {
  it('不碰路径的命令：一个候选都没有', () => {
    expect(candidatePaths('ls -la')).toEqual([]);
    expect(candidatePaths('git status')).toEqual([]);
    expect(candidatePaths('npm run build')).toEqual([]);
  });

  it('绝对路径、相对路径、`~` 开头的都算候选，且**原样**返回（不展开、不归一）', () => {
    expect(candidatePaths('rm -rf /tmp/x')).toEqual(['/tmp/x']);
    expect(candidatePaths('rm -rf ~/.ssh')).toEqual(['~/.ssh']);
    expect(candidatePaths('cat ./a/b.txt')).toEqual(['./a/b.txt']);
  });

  it('带路径的命令名本身是候选', () => {
    expect(candidatePaths('/usr/bin/rm -rf /x')).toEqual(['/usr/bin/rm', '/x']);
  });

  it('纯词不当候选 —— 否则 `git commit -m "fix bug"` 会被整条拒掉', () => {
    expect(candidatePaths('git commit -m "fix bug"')).toEqual([]);
  });

  it('纯旗标跳过', () => {
    expect(candidatePaths('rm -rf /x')).toEqual(['/x']);
  });

  it('重定向目标无条件算，哪怕它是个纯词', () => {
    expect(candidatePaths('echo x > out.txt')).toEqual(['out.txt']);
    expect(candidatePaths('echo x >> out.txt')).toEqual(['out.txt']);
    expect(candidatePaths('echo x >/tmp/o')).toEqual(['/tmp/o']);
    expect(candidatePaths('echo x 2>/tmp/e')).toEqual(['/tmp/e']);
  });

  it('旗标里挂着的路径要拆出来 —— 否则 `--out=/etc/passwd` 能安静地绕过 `/etc/**`', () => {
    expect(candidatePaths('git commit --file=/etc/msg')).toEqual(['/etc/msg']);
  });

  it('引号内的空白不切，引号本身剥掉', () => {
    expect(candidatePaths('cp "/a b/c" /d')).toEqual(['/a b/c', '/d']);
  });

  it('反斜杠分隔（Windows 写法）也算', () => {
    expect(candidatePaths('type C:\\Windows\\win.ini')).toEqual(['C:\\Windows\\win.ini']);
  });
});

/**
 * 沙箱的规则归一必须与权限链**逐字节相同**。
 *
 * 分叉的那一天，症状是"同一条规则在权限链认、在沙箱不认" —— 一种最难查的错。
 * 这里拿裸路径（沙箱的写法）与 `Write(...)` 形式的规则（权限链的写法）对拍。
 */
describe('两套归一不分叉', () => {
  const HOME = '/home/u';

  it('裸路径产生的 Rule 与 `Write(<路径>)` 产生的 Rule 逐字段相同', () => {
    const mine = sandboxRule('~\\SSH\\**', 'deny', HOME);
    const theirs = parseRule('Write(~\\SSH\\**)', 'deny', HOME);
    expect('error' in theirs).toBe(false);
    expect(mine.tool).toBe('Write');
    expect(mine.content).toBe((theirs as Rule).content);
  });

  it('连续斜杠与重复空白也归成同一个形状', () => {
    expect(sandboxRule('/etc//passwd', 'deny', HOME).content).toBe('/etc/passwd');
    expect(sandboxRule('/a/  b', 'deny', HOME).content).toBe('/a/ b');
  });
});
