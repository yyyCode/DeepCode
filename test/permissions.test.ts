import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import { parseRule, type Behavior, type Rule } from '../src/contract/policy';
import {
  createPermissionsPlugin,
  createSessionGrants,
  type SessionGrants,
} from '../src/builtins/permissions';
import { createHarness, seat } from './harness';
import type { EngineInterface } from '../src/contract/engine';
import type { EventHook } from '../src/contract/plugin';

const HOME = 'C:\\Users\\x';

function rule(text: string, decision: Behavior): Rule {
  const parsed = parseRule(text, decision, HOME);
  if ('error' in parsed) throw new Error(`规则 "${text}" 本该解析成功：${parsed.error}`);
  return parsed;
}

/**
 * 一个规则插件。`grants` 不给就现建一份 —— 要看"这次到底记住了什么"的几条
 * 自己建一份传进来，其余的不需要看见它。
 */
function plugin(rules: readonly Rule[], grants: SessionGrants = createSessionGrants()) {
  return createPermissionsPlugin({ rules, grants });
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
    seat(h, plugin([rule('Bash', 'deny')]), 'user');

    expect(await check(h, 'Write', { file_path: 'x' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Write',
    });
  });

  it('allow 规则把 confirm 的 ask 变成 allow，并带上规则原文', async () => {
    const h = withConfirm({ decision: 'ask', rule: '最小确认：Write' });
    seat(h, plugin([rule('Write', 'allow')]), 'user');

    expect(await check(h, 'Write', { file_path: 'x' })).toEqual({ decision: 'allow', rule: 'Write' });
  });

  it('allow 规则掀不翻下游的 deny —— 效力上限就是把 ask 变成 allow', async () => {
    const h = withConfirm({ decision: 'deny', rule: '未知工具 WebSearch，不在确认器的白名单里' });
    // 一条宽泛的 allow 若能把下游 deny 抹掉，confirm 的未知工具拒绝就白写了。
    seat(h, plugin([rule('WebSearch', 'allow')]), 'user');

    expect(await check(h, 'WebSearch', { query: 'x' })).toEqual({
      decision: 'deny',
      rule: '未知工具 WebSearch，不在确认器的白名单里',
    });
  });

  it('deny 规则赢过下游的 allow，并把规则原文报出来', async () => {
    const h = withConfirm({ decision: 'allow' });
    seat(h, plugin([rule('Bash(git push:*)', 'deny')]), 'user');

    expect(await check(h, 'Bash', { command: 'git push origin main' })).toEqual({
      decision: 'deny',
      rule: 'Bash(git push:*)',
    });
  });

  it('ask 规则压过下游的 allow', async () => {
    const h = withConfirm({ decision: 'allow' });
    seat(h, plugin([rule('Bash', 'ask')]), 'user');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'ask', rule: 'Bash' });
  });

  it('ask 规则不改写下游的 deny', async () => {
    const h = withConfirm({ decision: 'deny', rule: '未知工具' });
    seat(h, plugin([rule('Bash', 'ask')]), 'user');

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
    seat(h, plugin([rule('WebSearch', 'deny')]), 'user');

    expect(await describeTool(h, 'WebSearch')).toEqual({ hidden: true });
  });

  it('参数化 deny 绝不隐藏整个工具 —— 为拦一条命令藏掉 Bash 是灾难', async () => {
    const h = withDescribe(createHarness(), 'Bash', '真实的 Bash 描述');
    seat(h, plugin([rule('Bash(git push:*)', 'deny')]), 'user');

    expect(await describeTool(h, 'Bash')).toEqual({ description: '真实的 Bash 描述', inputSchema: {} });
  });

  it('被 allow 的工具照常给出描述', async () => {
    const h = withDescribe(createHarness(), 'Read', '真实的 Read 描述');
    seat(h, plugin([rule('Read', 'allow')]), 'user');

    expect(await describeTool(h, 'Read')).toEqual({ description: '真实的 Read 描述', inputSchema: {} });
  });

  it('同一个工具写两遍 deny 也只注册一次（不会因为重复而改变结果）', async () => {
    const h = withDescribe(createHarness(), 'Bash', '真实的 Bash 描述');
    seat(h, plugin([rule('Bash', 'deny'), rule('Bash', 'deny')]), 'user');

    expect(await describeTool(h, 'Bash')).toEqual({ hidden: true });
  });
});

describe('permissions：按了 a 之后记住了什么', () => {
  /** 一个场面：下游答案是 `coreAnswer`、规则层是空的，`$.ui.log` 的话收进 `logs`。 */
  function scene(coreAnswer: unknown, rules: readonly Rule[] = []) {
    const grants = createSessionGrants();
    const logs: string[] = [];
    const engine: Partial<EngineInterface> = {
      ui: { log: (line: string) => logs.push(line), notice: () => {}, ask: async () => 'n' },
    };
    const h = createHarness({ coreImpls: { 'tool.check': () => coreAnswer as never }, engine });
    seat(h, plugin(rules, grants), 'user');
    return { h, grants, logs };
  }

  function consent(h: H, tool: string, input: unknown, granted: 'once' | 'always') {
    return h.dispatch('tool.consent', { tool, input, toolUseId: 'tu_1', granted }, CORE_ORIGIN);
  }

  it('Bash 记的是**那一条命令**：同一条不再问，换一条照样问', async () => {
    const { h, grants, logs } = scene({ decision: 'ask', rule: '最小确认：Bash' });

    await consent(h, 'Bash', { command: 'pnpm test' }, 'always');

    expect(grants.list().map((r) => r.raw)).toEqual(['Bash(pnpm test)']);
    expect(await check(h, 'Bash', { command: 'pnpm test' })).toEqual({
      decision: 'allow',
      rule: 'Bash(pnpm test)',
    });
    // 不按前缀记的理由就在这里：`pnpm` 这一前缀放行等于把 `pnpm publish` 一起放了。
    expect(await check(h, 'Bash', { command: 'pnpm publish' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Bash',
    });
    // 记住了什么必须当场说出来 —— 同一句提示，记的东西因工具而异。
    expect(logs).toEqual(['已记住：本次会话不再询问 Bash(pnpm test)']);
  });

  it('命令里的连续空白按既有归一折叠：写法不同仍算同一条', async () => {
    const { h } = scene({ decision: 'ask', rule: '最小确认：Bash' });

    await consent(h, 'Bash', { command: 'pnpm   test' }, 'always');

    expect(await check(h, 'Bash', { command: 'pnpm test' })).toEqual({
      decision: 'allow',
      rule: 'Bash(pnpm test)',
    });
  });

  it('其余工具记的是**整个工具**', async () => {
    const { h, grants } = scene({ decision: 'ask', rule: '最小确认：Write' });

    await consent(h, 'Write', { file_path: 'a.ts' }, 'always');

    expect(grants.list().map((r) => r.raw)).toEqual(['Write']);
    // 换个文件也照样放行 —— 一次批准 = 这一场会话别拦我写文件。
    expect(await check(h, 'Write', { file_path: 'b.ts' })).toEqual({ decision: 'allow', rule: 'Write' });
  });

  it('`y`（只放行这一次）什么都不记', async () => {
    const { h, grants, logs } = scene({ decision: 'ask', rule: '最小确认：Bash' });

    await consent(h, 'Bash', { command: 'ls' }, 'once');

    expect(grants.list()).toEqual([]);
    expect(logs).toEqual([]);
    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Bash',
    });
  });

  it('同一条按两遍 a 只留一份 —— `/permissions` 不该被重复项撑长', async () => {
    const { h, grants } = scene({ decision: 'ask', rule: '最小确认：Bash' });

    await consent(h, 'Bash', { command: 'ls' }, 'always');
    await consent(h, 'Bash', { command: 'ls' }, 'always');

    expect(grants.list().map((r) => r.raw)).toEqual(['Bash(ls)']);
  });

  it('记住的也翻不过下游的 deny —— 效力上限仍是"把 ask 变成 allow"', async () => {
    const { h } = scene({ decision: 'deny', rule: '未知工具 WebSearch' });

    await consent(h, 'WebSearch', { query: 'x' }, 'always');

    expect(await check(h, 'WebSearch', { query: 'x' })).toEqual({
      decision: 'deny',
      rule: '未知工具 WebSearch',
    });
  });

  it('明写要问的规则，a 也压不过它（更严的永远赢，与规则写在哪一层无关）', async () => {
    const { h } = scene({ decision: 'allow' }, [rule('Bash', 'ask')]);

    await consent(h, 'Bash', { command: 'ls' }, 'always');

    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'ask', rule: 'Bash' });
  });

  it('忘掉之后立刻恢复逐条问（`/permissions forget` 的底座）', async () => {
    const { h, grants } = scene({ decision: 'ask', rule: '最小确认：Bash' });

    await consent(h, 'Bash', { command: 'ls' }, 'always');
    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({ decision: 'allow', rule: 'Bash(ls)' });

    grants.clear();
    expect(await check(h, 'Bash', { command: 'ls' })).toEqual({
      decision: 'ask',
      rule: '最小确认：Bash',
    });
  });
});
