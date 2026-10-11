import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Plugin } from '../src/contract/plugin';
import type { ResolvedHookGroup } from '../src/contract/classic';
import { registerHooks, type ClassicHooksDeps } from '../src/cli/classic-hooks';
import { createHarness, seat } from './harness';

const HOOKS_DIR = fileURLToPath(new URL('fixtures/hooks/', import.meta.url));
const NODE = JSON.stringify(process.execPath);

function group(
  event: ResolvedHookGroup['event'],
  script: string,
  tools?: readonly string[],
  timeoutMs = 10_000,
): ResolvedHookGroup {
  return { event, tools, hooks: [{ command: `${NODE} ./${script}`, timeoutMs }] };
}

/** 把插件装进 harness：生产的 plugin-dir.ts 拼出来的就是这样一个对象。 */
function mount(groups: readonly ResolvedHookGroup[], lines: string[], notices: string[]) {
  const deps: ClassicHooksDeps = {
    plugin: 'secret-guard',
    dir: HOOKS_DIR,
    groups,
    cwd: HOOKS_DIR,
    projectDir: HOOKS_DIR,
    session: { id: 's1', transcriptPath: '/tmp/t.jsonl' },
    env: process.env,
  };
  const plugin: Plugin = {
    name: 'secret-guard',
    uses: ['tool.check', 'session.start', 'session.end'],
    register: (on) => registerHooks(on, deps),
  };
  const h = createHarness({
    engine: {
      ui: {
        log: (line: string) => lines.push(line),
        notice: (line: string) => notices.push(line),
        ask: async () => '',
      },
    },
    coreImpls: { 'tool.check': () => ({ decision: 'deny', rule: 'fail-closed' }) as const },
  });
  seat(h, plugin, 'append');
  return h;
}

const WRITE = { tool: 'Write', input: { file_path: 'a.ts' }, toolUseId: 'tu_1' };

describe('PreToolUse → tool.check', () => {
  it('钩子没意见时，判定交回下层（这里落在 fail-closed 的链尾）', async () => {
    const h = mount([group('PreToolUse', 'ok.mjs')], [], []);
    const result = await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    expect(result).toEqual({ decision: 'deny', rule: 'fail-closed' });
  });

  it('退出码 2 → deny，stderr 原样进规则名（模型看得见的那句）', async () => {
    const h = mount([group('PreToolUse', 'block.mjs')], [], []);
    const result = await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    expect(result.decision).toBe('deny');
    expect(result.rule).toContain('secret-guard');
    expect(result.rule).toContain('.env');
  });

  it('JSON 里的 deny 也拦得住，理由取 permissionDecisionReason', async () => {
    const h = mount([group('PreToolUse', 'say-deny.mjs')], [], []);
    const result = await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    expect(result.decision).toBe('deny');
    expect(result.rule).toContain('仓库里不许出现密钥');
  });

  it('ask 是收紧，照样生效', async () => {
    const h = mount([group('PreToolUse', 'say-ask.mjs')], [], []);
    expect((await h.dispatch('tool.check', WRITE, CORE_ORIGIN)).decision).toBe('ask');
  });

  it('**allow 被无视**：第三方钩子不许放行，判定原封不动交给下层', async () => {
    const lines: string[] = [];
    const h = mount([group('PreToolUse', 'say-allow.mjs')], lines, []);
    const result = await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    // 关键：不是 allow，而是"这次 allow 不存在"—— 下层（fail-closed 链尾）照常裁决。
    expect(result).toEqual({ decision: 'deny', rule: 'fail-closed' });
    expect(lines.join('\n')).toContain('只能拧紧');
  });

  it('退出码 3 是 fail，也就是 deny（不是"没意见"）', async () => {
    const h = mount([group('PreToolUse', 'boom.mjs')], [], []);
    expect((await h.dispatch('tool.check', WRITE, CORE_ORIGIN)).decision).toBe('deny');
  });

  it('matcher 只在指定的工具上生效', async () => {
    const h = mount([group('PreToolUse', 'block.mjs', ['Write'])], [], []);
    expect((await h.dispatch('tool.check', WRITE, CORE_ORIGIN)).decision).toBe('deny');
    const bash = await h.dispatch('tool.check', { ...WRITE, tool: 'Bash' }, CORE_ORIGIN);
    expect(bash).toEqual({ decision: 'deny', rule: 'fail-closed' });
  });

  it('一组里的多条钩子串行，第一条拦下就不再跑第二条', async () => {
    const lines: string[] = [];
    const h = mount(
      [
        {
          event: 'PreToolUse',
          tools: undefined,
          hooks: [
            { command: `${NODE} ./block.mjs`, timeoutMs: 10_000 },
            { command: `${NODE} ./say-deny.mjs`, timeoutMs: 10_000 },
          ],
        },
      ],
      lines,
      [],
    );
    const result = await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    expect(result.rule).toContain('.env'); // 第一条的理由
    expect(result.rule).not.toContain('仓库里不许'); // 第二条没跑
  });

  it('钩子往 stdout 写的**纯文本**照旧打给人看', async () => {
    const lines: string[] = [];
    const h = mount([group('PreToolUse', 'plain-text.mjs')], lines, []);
    // 纯文本 stdout 读不出判定，classify 当它没意见 —— 但这句话是给人看的，要打。
    await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    expect(lines.join('\n')).toContain('改完记得跑 fmt');
  });

  it('stdout 是**带判定的 JSON** 时不回显 —— 它是协议，不是给人看的话', async () => {
    const lines: string[] = [];
    const h = mount([group('PreToolUse', 'say-deny.mjs')], lines, []);
    await h.dispatch('tool.check', WRITE, CORE_ORIGIN);
    // 这一条是防回显的：理由走 result.rule（模型看得见的那句），不该再原样打一行 JSON 到屏幕上。
    const said = lines.join('\n');
    expect(said).not.toContain('hookSpecificOutput');
    expect(said).not.toContain('permissionDecision');
  });
});

describe('SessionStart / SessionEnd → 只通知，不拦', () => {
  it('钩子自己报错时只通知，主流程照常往下', async () => {
    const notices: string[] = [];
    const h = mount([group('SessionStart', 'boom.mjs')], [], notices);
    await h.dispatch(
      'session.start',
      { sessionId: 's1', cwd: HOOKS_DIR, root: HOOKS_DIR },
      CORE_ORIGIN,
    );
    const said = notices.join('\n');
    expect(said).toContain('secret-guard');
    expect(said).toContain('退出码 3');
    expect(said).toContain('不影响主流程');
  });

  it('连不起来（超时）也只是一条通知 —— 这条与 PreToolUse 上的同一种失败走向完全相反', async () => {
    const notices: string[] = [];
    const h = mount([group('SessionStart', 'hang.mjs', undefined, 300)], [], notices);
    await h.dispatch(
      'session.start',
      { sessionId: 's1', cwd: HOOKS_DIR, root: HOOKS_DIR },
      CORE_ORIGIN,
    );
    expect(notices.join('\n')).toContain('没跑成');
  });

  it('exit 2 在这两个事件上也不阻断任何东西 —— 没有可阻断的动作', async () => {
    const h = mount([group('SessionEnd', 'block.mjs')], [], []);
    const result = await h.dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
    expect(result).toEqual({});
  });
});
