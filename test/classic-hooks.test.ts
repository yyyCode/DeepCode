import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import type { Plugin } from '@deepcode/contract/plugin';
import type { ResolvedHookGroup } from '@deepcode/contract/classic';
import { registerHooks, type ClassicHooksDeps } from '@deepcode/cli/classic-hooks';
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
    uses: ['tool.check', 'tool.result', 'prompt.submit', 'turn.stop', 'session.start', 'session.end'],
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
    // 四条链尾：`tool.check` 是生产里那条 fail-closed，另外三条是 P4d 的三道缝
    // —— 手搭的 harness 拿不到 createEngine 的 coreImpls，得在这儿各给一份。
    coreImpls: {
      'tool.check': () => ({ decision: 'deny', rule: 'fail-closed' }) as const,
      'tool.result': () => ({}) as const,
      'prompt.submit': () => ({ handled: false }) as const,
      'turn.stop': () => ({}) as const,
    },
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

const RESULT = { tool: 'Write', input: { file_path: 'a.ts' }, toolUseId: 'tu_1', ok: true, output: 'ok' };

describe('PostToolUse → tool.result', () => {
  it('additionalContext 进了那条工具结果的 context', async () => {
    const h = mount([group('PostToolUse', 'say-context.mjs')], [], []);
    const result = await h.dispatch('tool.result', RESULT, CORE_ORIGIN);
    expect(result.context).toContain('改完记得跑 fmt');
  });

  it('喂给钩子的 stdin 里，tool_response 是**我们自己的**形状 {ok, output}', async () => {
    const h = mount([group('PostToolUse', 'echo-context.mjs')], [], []);
    const result = await h.dispatch(
      'tool.result',
      { ...RESULT, ok: false, output: 'ERROR: 写不动' },
      CORE_ORIGIN,
    );
    const seen = JSON.parse(result.context ?? '{}') as Record<string, any>;
    expect(seen.hook_event_name).toBe('PostToolUse');
    expect(seen.tool_name).toBe('Write');
    expect(seen.tool_use_id).toBe('tu_1');
    expect(seen.tool_input).toEqual({ file_path: 'a.ts' });
    expect(seen.tool_response).toEqual({ ok: false, output: 'ERROR: 写不动' });
  });

  it('**exit 2 降级成"说话"**：工具已经跑完了，这个拦停意图只能变成一段上下文', async () => {
    const h = mount([group('PostToolUse', 'block.mjs')], [], []);
    const result = await h.dispatch('tool.result', RESULT, CORE_ORIGIN);
    expect(result.context).toContain('.env');
  });

  it('钩子自己坏了：只吭一声，一个字节都不注入', async () => {
    const notices: string[] = [];
    const h = mount([group('PostToolUse', 'boom.mjs')], [], notices);
    const result = await h.dispatch('tool.result', RESULT, CORE_ORIGIN);
    expect(result).toEqual({});
    expect(notices.join('\n')).toContain('没有可拦的动作');
  });

  it('matcher 只在指定的工具上生效', async () => {
    const h = mount([group('PostToolUse', 'say-context.mjs', ['Write'])], [], []);
    expect((await h.dispatch('tool.result', RESULT, CORE_ORIGIN)).context).toContain('fmt');
    expect(await h.dispatch('tool.result', { ...RESULT, tool: 'Bash' }, CORE_ORIGIN)).toEqual({});
  });
});

describe('UserPromptSubmit → prompt.submit', () => {
  it('additionalContext 进了 prompt.submit 的 context', async () => {
    const h = mount([group('UserPromptSubmit', 'say-context.mjs')], [], []);
    const result = await h.dispatch('prompt.submit', { text: '帮我看下这个' }, CORE_ORIGIN);
    expect(result.context).toContain('改完记得跑 fmt');
  });

  it('喂进去的 prompt 就是用户那一行', async () => {
    const h = mount([group('UserPromptSubmit', 'echo-context.mjs')], [], []);
    const result = await h.dispatch('prompt.submit', { text: '帮我看下这个' }, CORE_ORIGIN);
    const seen = JSON.parse(result.context ?? '{}') as Record<string, unknown>;
    expect(seen.hook_event_name).toBe('UserPromptSubmit');
    expect(seen.prompt).toBe('帮我看下这个');
  });

  it('**`handled` 不会被冲掉**：内层的判定与我们的上下文并存', async () => {
    const h = mount([group('UserPromptSubmit', 'say-context.mjs')], [], []);
    // 内层（builtin）说"这一行我吃掉了"，外层（classic，append）只补一段话。
    // 冲掉 handled 的后果是一个本意要吃掉这一行的插件静默失效。
    h.on('builtin', 'swallower', 'prompt.submit', () => ({ handled: true }) as const);
    const result = await h.dispatch('prompt.submit', { text: 'x' }, CORE_ORIGIN);
    expect(result.handled).toBe(true);
    expect(result.context).toContain('fmt');
  });

  it('钩子没话说时，内层的结果原样返回（不凭空造一个 {context: undefined}）', async () => {
    const h = mount([group('UserPromptSubmit', 'ok.mjs')], [], []);
    h.on('builtin', 'swallower', 'prompt.submit', () => ({ handled: true }) as const);
    expect(await h.dispatch('prompt.submit', { text: 'x' }, CORE_ORIGIN)).toEqual({ handled: true });
  });
});

describe('Stop → turn.stop', () => {
  const STOP = { stopHookActive: false, lastMessage: '我干完了' };

  it('deny 变成 block —— "不允许停止"本来就是一次拒绝', async () => {
    const h = mount([group('Stop', 'say-deny.mjs')], [], []);
    const result = await h.dispatch('turn.stop', STOP, CORE_ORIGIN);
    expect(result.block).toContain('仓库里不许出现密钥');
  });

  it('exit 2 在 Stop 上也拦得住（走的同样是那条降级路）', async () => {
    const h = mount([group('Stop', 'block.mjs')], [], []);
    expect((await h.dispatch('turn.stop', STOP, CORE_ORIGIN)).block).toContain('.env');
  });

  it('allow 在这里表达不出来：不 block，但**喊一声**', async () => {
    const lines: string[] = [];
    const h = mount([group('Stop', 'say-allow.mjs')], lines, []);
    expect(await h.dispatch('turn.stop', STOP, CORE_ORIGIN)).toEqual({});
    expect(lines.join('\n')).toContain('表达不出来');
  });

  it('钩子坏了也不 block —— 模型已经说完话了，没有东西可拦', async () => {
    const notices: string[] = [];
    const h = mount([group('Stop', 'boom.mjs')], [], notices);
    expect(await h.dispatch('turn.stop', STOP, CORE_ORIGIN)).toEqual({});
    expect(notices.join('\n')).toContain('没有可拦的动作');
  });

  it('喂进去的是 stop_hook_active 与 last_assistant_message —— 不是别的什么', async () => {
    const h = mount([group('Stop', 'stop-echo-deny.mjs')], [], []);
    const result = await h.dispatch(
      'turn.stop',
      { stopHookActive: true, lastMessage: '我干完了' },
      CORE_ORIGIN,
    );
    // 理由里编着钩子实际收到的三个字段。恒 deny 的钩子也能把 turn 拦下来，
    // 所以"拦住了"本身证明不了映射是对的 —— 得看这一段。
    expect(result.block).toContain('event=Stop');
    expect(result.block).toContain('stop_hook_active=true');
    expect(result.block).toContain('last=我干完了');
  });

  it('只给了 additionalContext 的钩子在 Stop 上**不会被当成 block** —— 说话不等于命令', async () => {
    const lines: string[] = [];
    const h = mount([group('Stop', 'say-context.mjs')], lines, []);
    expect(await h.dispatch('turn.stop', STOP, CORE_ORIGIN)).toEqual({});
    expect(lines.join('\n')).toContain('Stop 上表达不出来');
  });

  it('下层也拦了的话，用**下层**的文本 —— 我们只是补一个空的', async () => {
    const h = mount([group('Stop', 'say-deny.mjs')], [], []);
    h.on('builtin', 'deeper', 'turn.stop', () => ({ block: '下层的话' }) as const);
    expect((await h.dispatch('turn.stop', STOP, CORE_ORIGIN)).block).toBe('下层的话');
  });
});
