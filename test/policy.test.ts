import { describe, expect, it } from 'vitest';
import {
  LENIENCY,
  evaluate,
  fullyDeniedTools,
  isLooser,
  isSupported,
  matchesRule,
  parseRule,
  type Behavior,
  type Rule,
} from '../src/contract/policy';

const HOME = 'C:\\Users\\x';

/** 解析一条规则，断言没出错 —— 省掉每处判空的噪音。 */
function rule(text: string, decision: Behavior): Rule {
  const parsed = parseRule(text, decision, HOME);
  if ('error' in parsed) throw new Error(`规则 "${text}" 本该解析成功：${parsed.error}`);
  return parsed;
}

function call(tool: string, input: unknown) {
  return { tool, input };
}

describe('parseRule：形状', () => {
  it('工具名单独一条 = 该工具的所有调用', () => {
    expect(rule('Bash', 'allow')).toEqual({
      raw: 'Bash',
      tool: 'Bash',
      decision: 'allow',
    });
  });

  it('带括号的保留括号里的内容（deny 要按原文回报给人）', () => {
    expect(rule('Bash(git push:*)', 'deny')).toEqual({
      raw: 'Bash(git push:*)',
      tool: 'Bash',
      content: 'git push:*',
      decision: 'deny',
    });
  });

  it('raw 保留原样，content 已归一 —— 一个是给人看的，一个是拿来比的', () => {
    const parsed = rule('  Bash( git   push:* )  ', 'ask');
    expect(parsed.raw).toBe('  Bash( git   push:* )  ');
    expect(parsed.content).toBe('git push:*');
  });

  it('路径类规则里的 ~ 在解析时就展开成 home', () => {
    expect(rule('Read(~/.ssh/**)', 'deny').content).toBe('C:/Users/x/.ssh/**');
  });

  it('Bash 规则里的 ~ 不展开（那不是路径）', () => {
    expect(rule('Bash(~/x)', 'deny').content).toBe('~/x');
  });

  it.each([
    '',
    '   ',
    'Bash(',
    'Bash)',
    'Bash(git push',
    'Bash(git push))',
    'Bash()',
    '(git push)',
    '1Bash',
    'Ba-sh',
    'Bash(git (push)',
  ])('不合法的规则 %j 返回 error，不抛', (text) => {
    const parsed = parseRule(text, 'deny', HOME);
    expect(parsed).toHaveProperty('error');
    expect(typeof (parsed as { error: string }).error).toBe('string');
  });

  it('工具名可以带数字与下划线（首字符仍是字母）', () => {
    expect(rule('Web3', 'deny').tool).toBe('Web3');
    expect(rule('my_tool', 'deny').tool).toBe('my_tool');
    expect(rule('Web3(x)', 'deny').tool).toBe('Web3');
  });

  it('~x 不展开 —— ~ 只有落在分隔符前才是 home', () => {
    expect(rule('Read(~x/config)', 'deny').content).toBe('~x/config');
  });

  it('~ 单独一个就是 home', () => {
    expect(rule('Write(~)', 'deny').content).toBe('C:/Users/x');
  });

  it('规则里写 Windows 反斜杠的 ~\\ 也展开', () => {
    expect(rule('Read(~\\x)', 'deny').content).toBe('C:/Users/x/x');
  });

  it('规则路径里的连续分隔符折成一个', () => {
    expect(rule('Read(/x//y)', 'deny').content).toBe('/x/y');
  });

  it('规则路径里的连续空白也折叠', () => {
    expect(rule('Read(/x/a   b.txt)', 'deny').content).toBe('/x/a b.txt');
  });
});

describe('匹配：Bash', () => {
  it('无参数 = 所有 Bash 调用', () => {
    expect(matchesRule(rule('Bash', 'deny'), call('Bash', { command: 'rm -rf /' }))).toBe(true);
  });

  it('带参数不带 :* = 精确匹配整条命令行', () => {
    const r = rule('Bash(git status)', 'allow');
    expect(matchesRule(r, call('Bash', { command: 'git status' }))).toBe(true);
    expect(matchesRule(r, call('Bash', { command: 'git status --short' }))).toBe(false);
  });

  it(':* 是 token 边界上的前缀，不是通配符', () => {
    const r = rule('Bash(git push:*)', 'deny');
    expect(matchesRule(r, call('Bash', { command: 'git push' }))).toBe(true);
    expect(matchesRule(r, call('Bash', { command: 'git push origin main' }))).toBe(true);
    expect(matchesRule(r, call('Bash', { command: 'git push --force' }))).toBe(true);
    // 这一条是本文件最要紧的断言：若把 `:` 当普通通配符，规则会要求命令行里
    // 真有一个冒号，而 `git push origin main` 没有 —— 规则永远不命中，安静地失效。
    expect(matchesRule(r, call('Bash', { command: 'git pushup' }))).toBe(false);
    expect(matchesRule(r, call('Bash', { command: 'git pull' }))).toBe(false);
    expect(matchesRule(r, call('Bash', { command: 'git push' + String.fromCharCode(9) + 'x' }))).toBe(true);
  });

  it('两侧空白与连续空白都不影响匹配', () => {
    const r = rule('Bash(git   push:*)', 'deny');
    expect(matchesRule(r, call('Bash', { command: '  git  push  origin  main  ' }))).toBe(true);
  });

  it('command 不是字符串（模型胡来）时静默不匹配，不抛', () => {
    const r = rule('Bash(git push:*)', 'deny');
    expect(matchesRule(r, call('Bash', { command: 42 }))).toBe(false);
    expect(matchesRule(r, call('Bash', undefined))).toBe(false);
    expect(matchesRule(r, call('Bash', {}))).toBe(false);
  });

  it('Bash(:*) 与 Bash 同义', () => {
    const r = rule('Bash(:*)', 'deny');
    expect(matchesRule(r, call('Bash', { command: 'ls' }))).toBe(true);
    // 同义必须"全同"：隐藏工具那一处认的是 content === undefined，
    // 只在匹配时等价的话，deny 了全部 Bash 却仍把 Bash 摆在模型眼前。
    expect(fullyDeniedTools([r])).toEqual(['Bash']);
  });

  it('冒号前的空白不影响：`git push :*` 与 `git push:*` 同义', () => {
    const r = rule('Bash(git push :*)', 'deny');
    expect(matchesRule(r, call('Bash', { command: 'git push' }))).toBe(true);
    expect(matchesRule(r, call('Bash', { command: 'git push origin main' }))).toBe(true);
  });
});

describe('匹配：路径 glob', () => {
  it('* 只跨一段', () => {
    const r = rule('Read(~/.ssh/*)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: 'C:\\Users\\x\\.ssh\\id_rsa' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: 'C:\\Users\\x\\.ssh\\sub\\id_rsa' }))).toBe(false);
  });

  it('** 跨段，也吃零段', () => {
    const r = rule('Read(~/.ssh/**)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: 'C:/Users/x/.ssh/id_rsa' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: 'C:\\Users\\x\\.ssh\\a\\b' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: 'C:/Users/x/.ssh' }))).toBe(false);
  });

  it('a/**/b 要能匹配 a/b', () => {
    const r = rule('Read(/x/**/b)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: '/x/b' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: '/x/y/b' }))).toBe(true);
  });

  it('不匹配 ~/.sshx —— 前缀不能越界', () => {
    const r = rule('Read(~/.ssh/**)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: 'C:/Users/x/.sshx/id_rsa' }))).toBe(false);
  });

  it('分隔符两侧归一：规则写反斜杠、调用给正斜杠也要命中', () => {
    const r = rule('Edit(C:\\Users\\x\\.npmrc)', 'deny');
    expect(matchesRule(r, call('Edit', { file_path: 'C:/Users/x/.npmrc' }))).toBe(true);
  });

  it('调用侧连续分隔符也折成一个 —— 只折规则侧会让规则安静地不命中', () => {
    const r = rule('Read(/srv/data/.ssh/**)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: '/srv/data//.ssh/id_rsa' }))).toBe(true);
  });

  it('Write 与 Edit 也走路径匹配', () => {
    expect(
      matchesRule(rule('Write(**/secrets.json)', 'deny'), call('Write', { file_path: 'a/b/secrets.json' })),
    ).toBe(true);
  });

  it('相对路径不命中绝对路径的规则（有意为之，/permissions 会说明）', () => {
    expect(matchesRule(rule('Write(~/.npmrc)', 'deny'), call('Write', { file_path: '.npmrc' }))).toBe(false);
  });

  it('file_path 不是字符串时静默不匹配', () => {
    expect(matchesRule(rule('Read(~/.ssh/**)', 'deny'), call('Read', {}))).toBe(false);
  });

  it('工具名不同就不匹配', () => {
    expect(
      matchesRule(rule('Read(~/.npmrc)', 'deny'), call('Write', { file_path: 'C:/Users/x/.npmrc' })),
    ).toBe(false);
  });

  it('点号是字面量，不是"任意字符"', () => {
    const r = rule('Read(/x/a.c.txt)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: '/x/a.c.txt' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: '/x/aXc.txt' }))).toBe(false);
  });

  it('方括号是字面量，不是字符类', () => {
    const r = rule('Read(/x/[ab].txt)', 'deny');
    expect(matchesRule(r, call('Read', { file_path: '/x/[ab].txt' }))).toBe(true);
    expect(matchesRule(r, call('Read', { file_path: '/x/a.txt' }))).toBe(false);
  });

  it('加号、竖线、花括号也是字面量', () => {
    expect(matchesRule(rule('Read(/x/a+b)', 'deny'), call('Read', { file_path: '/x/a+b' }))).toBe(true);
    expect(matchesRule(rule('Read(/x/a+b)', 'deny'), call('Read', { file_path: '/x/ab' }))).toBe(false);
    expect(matchesRule(rule('Read(/x/a|b)', 'deny'), call('Read', { file_path: '/x/a|b' }))).toBe(true);
    expect(matchesRule(rule('Read(/x/a{b})', 'deny'), call('Read', { file_path: '/x/a{b}' }))).toBe(true);
  });
});

describe('isSupported：其它工具带括号 = 永不命中', () => {
  it('Bash 与三个路径工具支持参数', () => {
    expect(isSupported(rule('Bash(git push:*)', 'deny'))).toBe(true);
    expect(isSupported(rule('Read(~/.ssh/**)', 'deny'))).toBe(true);
    expect(isSupported(rule('Write(~/.npmrc)', 'deny'))).toBe(true);
    expect(isSupported(rule('Edit(~/.npmrc)', 'deny'))).toBe(true);
  });

  it('不带括号的永远支持', () => {
    expect(isSupported(rule('WebSearch', 'deny'))).toBe(true);
  });

  it('其它工具带括号：不支持，加载时要吼一次', () => {
    expect(isSupported(rule('Grep(rm -rf)', 'deny'))).toBe(false);
    expect(isSupported(rule('Glob(*.ts)', 'deny'))).toBe(false);
  });

  it('不支持的规则也确实永不命中（不是"支持但没实现"）', () => {
    expect(matchesRule(rule('Grep(rm -rf)', 'deny'), call('Grep', { pattern: 'rm -rf' }))).toBe(false);
  });
});

describe('evaluate：固定的 deny > ask > allow', () => {
  const rules = [
    rule('Bash', 'allow'),
    rule('Bash(git push:*)', 'ask'),
    rule('Bash(git push --force:*)', 'deny'),
  ];

  it('三条都命中时 deny 赢', () => {
    expect(evaluate(rules, call('Bash', { command: 'git push --force origin main' }))).toEqual({
      decision: 'deny',
      rule: 'Bash(git push --force:*)',
    });
  });

  it('把数组倒过来，结果一模一样 —— 重排配置不该换行为', () => {
    expect(evaluate([...rules].reverse(), call('Bash', { command: 'git push --force origin main' }))).toEqual({
      decision: 'deny',
      rule: 'Bash(git push --force:*)',
    });
  });

  it('deny 不命中时 ask 赢', () => {
    expect(evaluate(rules, call('Bash', { command: 'git push origin main' }))).toEqual({
      decision: 'ask',
      rule: 'Bash(git push:*)',
    });
  });

  it('只有 allow 命中时才 allow', () => {
    expect(evaluate(rules, call('Bash', { command: 'git status' }))).toEqual({
      decision: 'allow',
      rule: 'Bash',
    });
  });

  it('一条都不命中 = undefined（原样交给下游）', () => {
    expect(evaluate(rules, call('Read', { file_path: 'x' }))).toBeUndefined();
    expect(evaluate([], call('Bash', { command: 'ls' }))).toBeUndefined();
  });

  it('同一档里按数组顺序取第一条，规则名要能对上号', () => {
    const two = [rule('Bash(git:*)', 'deny'), rule('Bash(git push:*)', 'deny')];
    expect(evaluate(two, call('Bash', { command: 'git push' }))?.rule).toBe('Bash(git:*)');
  });
});

describe('isLooser / LENIENCY', () => {
  it('宽松序：deny < ask < allow', () => {
    expect(LENIENCY).toEqual({ deny: 0, ask: 1, allow: 2 });
  });

  it('方向', () => {
    expect(isLooser('allow', 'ask')).toBe(true);
    expect(isLooser('ask', 'deny')).toBe(true);
    expect(isLooser('allow', 'deny')).toBe(true);
    expect(isLooser('ask', 'ask')).toBe(false);
    expect(isLooser('deny', 'deny')).toBe(false);
    expect(isLooser('deny', 'allow')).toBe(false);
    expect(isLooser('ask', 'allow')).toBe(false);
    expect(isLooser('allow', 'allow')).toBe(false);
  });
});

describe('fullyDeniedTools：只有整工具 deny 才算', () => {
  it('带括号的 deny 不隐藏工具', () => {
    expect(
      fullyDeniedTools([
        rule('Bash(git push:*)', 'deny'),
        rule('WebSearch', 'deny'),
        rule('Bash', 'allow'),
        rule('Read', 'deny'),
      ]),
    ).toEqual(['WebSearch', 'Read']);
  });

  it('同一个工具写两遍只出现一次', () => {
    expect(fullyDeniedTools([rule('Bash', 'deny'), rule('Bash', 'deny')])).toEqual(['Bash']);
  });

  it('ask / allow 都不隐藏', () => {
    expect(fullyDeniedTools([rule('Bash', 'ask'), rule('Read', 'allow')])).toEqual([]);
    expect(fullyDeniedTools([])).toEqual([]);
  });
});
