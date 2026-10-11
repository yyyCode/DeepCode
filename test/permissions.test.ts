import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { parseRule, type Behavior, type Rule } from '../src/contract/policy';
import { createPermissionsPlugin } from '../src/builtins/permissions';
import { createHarness, seat } from './harness';
import type { EventHook } from '../src/contract/plugin';

const HOME = 'C:\\Users\\x';

function rule(text: string, decision: Behavior): Rule {
  const parsed = parseRule(text, decision, HOME);
  if ('error' in parsed) throw new Error(`规则 "${text}" 本该解析成功：${parsed.error}`);
  return parsed;
}

type H = ReturnType<typeof createHarness>;

/** 把 confirm 的答案固定在 core 上，于是"规则如何与下游合并"成了唯一的变量。 */
function withConfirm(answer: unknown): H {
  return createHarness({ coreImpls: { 'tool.check': () => answer as never } });
}

function check(h: H, tool: string, input: unknown) {
  return h.dispatch('tool.check', { tool, input, toolUseId: 'tu_1' }, CORE_ORIGIN);
}

function describeTool(h: H, tool: string) {
  return h.dispatch('tool.describe', { tool }, CORE_ORIGIN);
}

describe('permissions：规则判定', () => {
  it('没命中任何规则时原样下沉 —— 与 P1 逐条一致', async () => {
    const h = withConfirm({ decision: 'ask', rule: '最小确认：Write' });
    seat(h, createPermissionsPlugin({ rules: [rule('Bash', 'deny')] }), 'user');

    expect(await check(h, 'Write', { file_path: 'x' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Write',
    });
  });

  it('allow 规则把 confirm 的 ask 变成 allow，并带上规则原文', async () => {
    const h = withConfirm({ decision: 'ask', rule: '最小确认：Write' });
    seat(h, createPermissionsPlugin({ rules: [rule('Write', 'allow')] }), 'user');

    expect(await check(h, 'Write', { file_path: 'x' })).toEqual({ decision: 'allow', rule: 'Write' });
  });

  it('allow 规则掀不翻下游的 deny —— 效力上限就是把 ask 变成 allow', async () => {
    const h = withConfirm({ decision: 'deny', rule: '未知工具 WebSearch，不在确认器的白名单里' });
    // 一条宽泛的 allow 若能把下游 deny 抹掉，confirm 的未知工具拒绝就白写了。
    seat(h, createPermissionsPlugin({ rules: [rule('WebSearch', 'allow')] }), 'user');

    expect(await check(h, 'WebSearch', { query: 'x' })).toEqual({
      decision: 'deny',
      rule: '未知工具 WebSearch，不在确认器的白名单里',
    });
  });

  it('deny 规则赢过下游的 allow，并把规则原文报出来', async () => {
    const h = withConfirm({ decision: 'allow' });
    seat(h, createPermissionsPlugin({ rules: [rule('Bash(git push:*)', 'deny')] }), 'user');

    expect(await check(h, 'Bash', { command: 'git push origin main' })).toEqual({
      decision: 'deny',
      rule: 'Bash(git push:*)',
    });
  });

  it('ask 规则压过下游的 allow', async () => {
    const h = withConfirm({ decision: 'allow' });
    seat(h, createPermissionsPlugin({ rules: [rule('Bash', 'ask')] }), 'user');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'ask', rule: 'Bash' });
  });

  it('ask 规则不改写下游的 deny', async () => {
    const h = withConfirm({ decision: 'deny', rule: '未知工具' });
    seat(h, createPermissionsPlugin({ rules: [rule('Bash', 'ask')] }), 'user');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'deny', rule: '未知工具' });
  });
});

describe('permissions：工具可见性', () => {
  /** 给某工具挂一个"真实的"描述，用来看它有没有被抢答掉。 */
  function withDescribe(h: H, tool: string, description: string): H {
    h.on('builtin', `real-${tool}`, 'tool.describe', { tool }, (() => ({
      description,
      inputSchema: {},
    })) as EventHook);
    return h;
  }

  it('整工具 deny 让 tool.describe 抢先答 hidden，真描述跑不到', async () => {
    const h = withDescribe(createHarness(), 'WebSearch', '真实的 WebSearch 描述');
    seat(h, createPermissionsPlugin({ rules: [rule('WebSearch', 'deny')] }), 'user');

    expect(await describeTool(h, 'WebSearch')).toEqual({ hidden: true });
  });

  it('参数化 deny 绝不隐藏整个工具 —— 为拦一条命令藏掉 Bash 是灾难', async () => {
    const h = withDescribe(createHarness(), 'Bash', '真实的 Bash 描述');
    seat(h, createPermissionsPlugin({ rules: [rule('Bash(git push:*)', 'deny')] }), 'user');

    expect(await describeTool(h, 'Bash')).toEqual({ description: '真实的 Bash 描述', inputSchema: {} });
  });

  it('被 allow 的工具照常给出描述', async () => {
    const h = withDescribe(createHarness(), 'Read', '真实的 Read 描述');
    seat(h, createPermissionsPlugin({ rules: [rule('Read', 'allow')] }), 'user');

    expect(await describeTool(h, 'Read')).toEqual({ description: '真实的 Read 描述', inputSchema: {} });
  });

  it('同一个工具写两遍 deny 也只注册一次（不会因为重复而改变结果）', async () => {
    const h = withDescribe(createHarness(), 'Bash', '真实的 Bash 描述');
    seat(h, createPermissionsPlugin({ rules: [rule('Bash', 'deny'), rule('Bash', 'deny')] }), 'user');

    expect(await describeTool(h, 'Bash')).toEqual({ hidden: true });
  });
});
