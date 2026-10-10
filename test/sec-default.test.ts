import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { parseRule, type Behavior, type Rule } from '../src/contract/policy';
import { createSecDefaultPlugin, UNCHECKED_DENY } from '../src/builtins/sec-default';
import { createHarness, seat } from './harness';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';

const HOME = '/home/u';

function rule(text: string, decision: Behavior): Rule {
  const parsed = parseRule(text, decision, HOME);
  if ('error' in parsed) throw new Error(`规则 "${text}" 本该解析成功：${parsed.error}`);
  return parsed;
}

type H = ReturnType<typeof createHarness>;

/** heldNotice 走 $.ui.log，这里把它记下来。 */
function world(): { h: H; logged: string[] } {
  const logged: string[] = [];
  const engine = {
    ui: {
      log: (line: string) => {
        logged.push(line);
      },
      notice: () => {},
      ask: async () => 'n',
    },
  } as unknown as EngineInterface;
  return { h: createHarness({ engine }), logged };
}

/** 下游（confirm）的答案。 */
function downstream(h: H, answer: unknown): H {
  h.on('builtin', 'confirm', 'tool.check', (() => answer) as EventHook);
  return h;
}

function check(h: H, tool: string, input: unknown) {
  return h.dispatch('tool.check', { tool, input }, CORE_ORIGIN);
}

describe('sec-default：持有裁决', () => {
  const POLICY = rule('Bash(git push:*)', 'deny');

  it('策略没提到这次调用 → 原样放行下游的答案', async () => {
    const { h, logged } = world();
    downstream(h, { decision: 'ask', rule: '最小确认：Bash' });
    seat(h, createSecDefaultPlugin({ rules: [POLICY] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Bash',
    });
    expect(logged).toEqual([]);
  });

  it('下层放宽成 allow，策略 deny 推翻它并报出规则原文', async () => {
    const { h, logged } = world();
    downstream(h, { decision: 'allow', rule: 'Bash' });
    seat(h, createSecDefaultPlugin({ rules: [POLICY] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'git push origin main' })).toEqual({
      decision: 'deny',
      rule: 'Bash(git push:*)',
    });
    expect(logged.join('\n')).toContain('Bash(git push:*)');
    expect(logged.join('\n')).toContain('deny');
  });

  it('user 层有个插件无条件放行，策略 deny 仍赢（验收标准 2 的字面形态）', async () => {
    const { h } = world();
    // 一个"个人插件"：不管问它什么工具，一律 allow。这正是"个人插件放宽不了组织策略"
    // 那句话里被打的那个东西 —— 用真插件而不是用桩，免得测的是自己搭的脚手架。
    h.on('user', 'personal-mod', 'tool.check', (() => ({
      decision: 'allow',
      rule: '个人插件的 allow',
    })) as EventHook);
    seat(h, createSecDefaultPlugin({ rules: [rule('Write(~/.npmrc)', 'deny')] }), 'prepend');

    expect(await check(h, 'Write', { file_path: '/home/u/.npmrc' })).toEqual({
      decision: 'deny',
      rule: 'Write(~/.npmrc)',
    });
  });

  it('下层放宽成 ask 也拦', async () => {
    const { h } = world();
    downstream(h, { decision: 'ask', rule: '最小确认：Bash' });
    seat(h, createSecDefaultPlugin({ rules: [POLICY] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'git push origin main' })).toEqual({
      decision: 'deny',
      rule: 'Bash(git push:*)',
    });
  });

  it('下层比策略更严时不插手', async () => {
    const { h, logged } = world();
    downstream(h, { decision: 'deny', rule: '未知工具' });
    seat(h, createSecDefaultPlugin({ rules: [rule('Bash', 'ask')] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'deny', rule: '未知工具' });
    expect(logged).toEqual([]);
  });

  it('下层同样严（都是 deny）时不插手，保住下层更具体的规则名', async () => {
    const { h } = world();
    downstream(h, { decision: 'deny', rule: 'confirm 自己拒的' });
    seat(h, createSecDefaultPlugin({ rules: [rule('Bash', 'deny')] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'deny',
      rule: 'confirm 自己拒的',
    });
  });

  it('策略是 allow、下层是 ask 时不插手 —— 守门器不替个人取消他自己多要的那次询问', async () => {
    const { h, logged } = world();
    downstream(h, { decision: 'ask', rule: '最小确认：Bash' });
    seat(h, createSecDefaultPlugin({ rules: [rule('Bash', 'allow')] }), 'prepend');

    // 若按"策略是最高权威、两个方向都赢"来写，这一条会变成 allow ——
    // 那就等于给策略文件开了一个自动放行开关，与安全底线直接冲突。
    expect(await check(h, 'Bash', { command: 'rm -rf /' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Bash',
    });
    expect(logged).toEqual([]);
  });

  it('策略是 allow、下层也是 allow 时无事发生', async () => {
    const { h } = world();
    downstream(h, { decision: 'allow', rule: 'Bash' });
    seat(h, createSecDefaultPlugin({ rules: [rule('Bash', 'allow')] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'allow', rule: 'Bash' });
  });
});

describe('sec-default：失败行为', () => {
  it('自己内部抛错 → 兜底成 deny，不能指望 dispatch 的故障隔离替它兜', async () => {
    const { h, logged } = world();
    downstream(h, { decision: 'ask', rule: '最小确认：Bash' });
    // 一个"装载时无害、裁决时才炸"的规则：注册期的 fullyDeniedTools 只读 decision
    // （不是 deny 就短路了），而裁决期的 matchesRule 要读 content。炸点因此正好落在
    // hook 里 —— 也就是 dispatch 的故障隔离会静静跳过、保护会无声消失的那一段。
    // 直接传 null 不行：那会在注册期就炸，属于"启动即失败"，不是这条用例要钉的东西。
    const trap = {
      raw: 'Bash',
      tool: 'Bash',
      decision: 'ask',
      get content(): string | undefined {
        throw new TypeError('规则对象坏了');
      },
    } as unknown as Rule;
    seat(h, createSecDefaultPlugin({ rules: [trap] }), 'prepend');

    // 这一条是整套设计里最容易被写漏的一处：dispatch 的故障隔离会把抛错的 hook
    // 跳过并继续跑下层，于是守门器的保护会**无声消失**，而 confirm 照常给出 ask。
    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'deny',
      rule: UNCHECKED_DENY,
    });
    expect(logged.join('\n')).toContain(UNCHECKED_DENY);
  });

  it('拿不到下游答案（链尾没人应答）时也是 deny，不是放行', async () => {
    const { h } = world();
    // 没有 coreImpls['tool.check'] → next(e) 抛 NotImplementedError
    seat(h, createSecDefaultPlugin({ rules: [] }), 'prepend');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'deny',
      rule: UNCHECKED_DENY,
    });
  });
});

describe('sec-default：整工具 deny 也隐藏工具', () => {
  it('策略里的整工具 deny 抢先答 hidden', async () => {
    const { h } = world();
    h.on('builtin', 'real', 'tool.describe', { tool: 'WebSearch' }, (() => ({
      description: '真实的 WebSearch',
      inputSchema: {},
    })) as EventHook);
    seat(h, createSecDefaultPlugin({ rules: [rule('WebSearch', 'deny')] }), 'prepend');

    expect(await h.dispatch('tool.describe', { tool: 'WebSearch' }, CORE_ORIGIN)).toEqual({
      hidden: true,
    });
  });

  it('参数化 deny 不隐藏工具', async () => {
    const { h } = world();
    h.on('builtin', 'real', 'tool.describe', { tool: 'Bash' }, (() => ({
      description: '真实的 Bash',
      inputSchema: {},
    })) as EventHook);
    seat(h, createSecDefaultPlugin({ rules: [rule('Bash(git push:*)', 'deny')] }), 'prepend');

    expect(await h.dispatch('tool.describe', { tool: 'Bash' }, CORE_ORIGIN)).toEqual({
      description: '真实的 Bash',
      inputSchema: {},
    });
  });
});
