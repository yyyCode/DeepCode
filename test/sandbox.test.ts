import { describe, expect, it } from 'vitest';
import { candidatePaths, sandboxRule, type SandboxConfig } from '../src/contract/sandbox';
import { parseRule, type Rule } from '../src/contract/policy';
import { checkSandbox } from '../src/core/nouns/sandbox';

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

describe('checkSandbox：方向与理由', () => {
  const HOME = '/home/u';
  const opts = { cwd: '/proj', home: HOME };
  const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
    enabled: true,
    deny: [],
    allow: [],
    ...over,
  });
  const reasonOf = (result: ReturnType<typeof checkSandbox>): string => {
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('沙箱没开：直接放行，规则一条都不看', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /etc/passwd', opts, config({ enabled: false, deny })).ok).toBe(true);
  });

  it('候选为空：不碰路径的命令不受影响', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('git status', opts, config({ deny })).ok).toBe(true);
  });

  it('deny 命中：拒绝，且**理由里带规则原文**', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    const reason = reasonOf(checkSandbox('rm -rf /etc/passwd', opts, config({ deny })));
    expect(reason).toContain('/etc/**');
    expect(reason).toContain('/etc/passwd');
  });

  it('白名单非空：圈外被拒，圈内放行', () => {
    const allow = [sandboxRule('/proj/**', 'allow', HOME)];
    expect(checkSandbox('rm -rf /elsewhere/x', opts, config({ allow })).ok).toBe(false);
    expect(checkSandbox('rm -rf /proj/x', opts, config({ allow })).ok).toBe(true);
  });

  it('白名单为空：只按 deny 判', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /proj/x', opts, config({ deny })).ok).toBe(true);
  });

  it('同一条路径既在白名单又被 deny：**deny 赢**', () => {
    const allow = [sandboxRule('/proj/**', 'allow', HOME)];
    const deny = [sandboxRule('/proj/secrets/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /proj/secrets/x', opts, config({ allow, deny })).ok).toBe(false);
  });

  it('相对路径按 `cwd` 解析', () => {
    const deny = [sandboxRule('/proj/out.txt', 'deny', HOME)];
    expect(checkSandbox('rm -rf ./out.txt', opts, config({ deny })).ok).toBe(false);
  });

  it('**已知漏口**：不带分隔符的相对文件名不是候选（`out.txt` 取不到，`./out.txt` 取得到）', () => {
    // 这是设计 §2.2 第 5 条明写的取舍：纯词一律不当候选，否则 `git commit -m "fix bug"`
    // 里的 `fix bug` 会解析成一个相对路径 —— 挂上白名单时，正常命令会被整条拒掉，
    // 那种假阳性比这个漏口更坏。**把它钉在这里，好过让它悄悄存在。**
    const deny = [sandboxRule('/proj/out.txt', 'deny', HOME)];
    expect(checkSandbox('rm -rf out.txt', opts, config({ deny })).ok).toBe(true);
    expect(checkSandbox('rm -rf ./out.txt', opts, config({ deny })).ok).toBe(false);
  });

  it('`~` 展开 —— 不展开的话一条 `~/.ssh/**` 会永远不命中', () => {
    const deny = [sandboxRule('~/.ssh/**', 'deny', HOME)];
    expect(checkSandbox('cat ~/.ssh/id_rsa', opts, config({ deny })).ok).toBe(false);
  });

  it('`..` 折掉 —— `/x/../etc/passwd` 与 `/etc/passwd` 等价', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('rm -rf /x/../etc/passwd', opts, config({ deny })).ok).toBe(false);
  });

  it('多条候选里只有一条越界就整条拒', () => {
    const deny = [sandboxRule('/etc/**', 'deny', HOME)];
    expect(checkSandbox('cp /proj/a /etc/b', opts, config({ deny })).ok).toBe(false);
  });
});
