import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify, expandHookCommand, runHook, type HookContext, type HookRun } from '../src/cli/hook-run';

const HOOKS_DIR = fileURLToPath(new URL('fixtures/hooks/', import.meta.url));
const NODE = JSON.stringify(process.execPath);

/** 钩子命令一律写成 `"<node>" ./x.mjs`，cwd 指到 fixture 目录 —— 平台无关。 */
function command(script: string): string {
  return `${NODE} ./${script}`;
}

function context(): HookContext {
  return { cwd: HOOKS_DIR, pluginRoot: HOOKS_DIR, projectDir: HOOKS_DIR, env: process.env };
}

function def(script: string, timeoutMs = 10_000) {
  return { command: command(script), timeoutMs };
}

/** 手工拼一次执行结果 —— `classify` 是纯函数，它的测试不该起进程。 */
function result(exitCode: number, extra: Partial<HookRun> = {}): HookRun {
  return { exitCode, stdout: '', stderr: '', failure: undefined, ...extra };
}

describe('expandHookCommand', () => {
  it('展开四个已知变量（参考实现的名字与我们自己的名字都认）', () => {
    const vars = { CLAUDE_PLUGIN_ROOT: 'C:\\p', DEEPCODE_PROJECT_DIR: '/w' };
    expect(expandHookCommand('node ${CLAUDE_PLUGIN_ROOT}/g.mjs', vars)).toBe('node C:\\p/g.mjs');
    expect(expandHookCommand('cd ${DEEPCODE_PROJECT_DIR} && x', vars)).toBe('cd /w && x');
  });

  it('不认识的变量原样留着，交给 shell 自己去处理（而不是悄悄换成空串）', () => {
    expect(expandHookCommand('echo ${SOMETHING_ELSE}', {})).toBe('echo ${SOMETHING_ELSE}');
    expect(expandHookCommand('echo $NOT_BRACED', {})).toBe('echo $NOT_BRACED');
  });
});

describe('classify：三个有定义的结果 + 其余一律失败', () => {
  it('exit 0 没话说 = silent', () => {
    expect(classify(result(0))).toEqual({ kind: 'silent' });
  });

  it('exit 0 + permissionDecision deny 读得出理由', () => {
    const say = result(0, {
      stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"有密钥"}}',
    });
    expect(classify(say)).toEqual({ kind: 'say', decision: 'deny', reason: '有密钥' });
  });

  it('exit 0 + ask 也读得出（ask 是收紧，不是放宽）', () => {
    const say = result(0, { stdout: '{"hookSpecificOutput":{"permissionDecision":"ask"}}' });
    expect(classify(say)).toEqual({ kind: 'say', decision: 'ask', reason: undefined });
  });

  it('exit 0 + allow **如实**报出来 —— 抹平发生在桥里，不在这里', () => {
    const say = result(0, { stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}' });
    expect(classify(say)).toEqual({ kind: 'say', decision: 'allow', reason: undefined });
  });

  it('exit 0 + 一段不是 JSON 的文本 = silent（文本照旧会被打印）', () => {
    expect(classify(result(0, { stdout: '随便说点什么' }))).toEqual({ kind: 'silent' });
  });

  it('exit 0 + JSON 但没有判定 = silent', () => {
    expect(classify(result(0, { stdout: '{"additionalContext":"x"}' }))).toEqual({ kind: 'silent' });
  });

  it('exit 2 = block，理由是 stderr', () => {
    expect(classify(result(2, { stderr: '不许写 .env' }))).toEqual({
      kind: 'block',
      reason: '不许写 .env',
    });
  });

  it('exit 2 但没给 stderr，也给得出一条理由', () => {
    expect(classify(result(2))).toEqual({ kind: 'block', reason: expect.stringContaining('退出码 2') });
  });

  it.each([1, 3, 127])('exit %i = fail（deny）', (code) => {
    expect(classify(result(code)).kind).toBe('fail');
  });

  it('起不来 / 超时 = fail，且原因是那个 failure', () => {
    expect(classify(result(-1, { failure: '超过 1 秒没结束，已杀掉' }))).toEqual({
      kind: 'fail',
      reason: '超过 1 秒没结束，已杀掉',
    });
  });

  it('判定值不是三个里头的任何一个 = fail（不是"当没说"）', () => {
    const say = result(0, { stdout: '{"hookSpecificOutput":{"permissionDecision":"maybe"}}' });
    expect(classify(say).kind).toBe('fail');
  });
});

describe('runHook：真的起进程', () => {
  it('exit 0 什么都不说', async () => {
    const ran = await runHook(def('ok.mjs'), {}, context());
    expect(ran.exitCode).toBe(0);
    expect(ran.failure).toBeUndefined();
    expect(classify(ran)).toEqual({ kind: 'silent' });
  });

  it('把事件做成 JSON 从 stdin 递进去，顺带把四个环境变量设好', async () => {
    const ran = await runHook(
      def('echo-stdin.mjs'),
      { tool_name: 'Write', tool_use_id: 'tu_1', hook_event_name: 'PreToolUse', session_id: 's1' },
      context(),
    );
    expect(ran.exitCode).toBe(0);
    const seen = JSON.parse(ran.stdout) as Record<string, string>;
    expect(seen.tool_name).toBe('Write');
    expect(seen.tool_use_id).toBe('tu_1');
    expect(seen.hook_event_name).toBe('PreToolUse');
    expect(seen.session_id).toBe('s1');
    // CLAUDE_* 是参考实现的名字，DEEPCODE_* 是我们的名字：两个都设，脚本怎么写的都能跑。
    expect(seen.plugin_root).toBe(HOOKS_DIR);
    expect(seen.project_dir).toBe(HOOKS_DIR);
  });

  it('exit 2 带着 stderr 回来', async () => {
    const ran = await runHook(def('block.mjs'), {}, context());
    expect(ran.exitCode).toBe(2);
    expect(classify(ran)).toEqual({ kind: 'block', reason: expect.stringContaining('.env') });
  });

  it('退出码 3 不是"没意见"', async () => {
    const ran = await runHook(def('boom.mjs'), {}, context());
    expect(ran.exitCode).toBe(3);
    expect(classify(ran).kind).toBe('fail');
  });

  it('超时会被杀掉，且理由是超时', async () => {
    const ran = await runHook(def('hang.mjs', 400), {}, context());
    // 报出来的秒数就是配的那个超时（400ms → 0.4 秒）。消息用人读得懂的单位，
    // 断言认这个数 —— 改成 "400" 的话它永远匹配不上。
    expect(ran.failure).toContain('0.4');
    expect(classify(ran).kind).toBe('fail');
  });

  it('命令起不来（不存在的可执行文件）也算失败，不是抛异常', async () => {
    const ran = await runHook(
      { command: 'definitely-not-a-real-binary-xyz', timeoutMs: 5_000 },
      {},
      context(),
    );
    // 平台相关：shell 可能自己起不来（'error' 事件 → failure），也可能起得来、
    // 把"找不到命令"当退出码报回来（POSIX 127 / cmd 1）。两条路都必须落到 fail ——
    // 这条守的是"不许抛出来、更不许当没意见"，不是"必须走哪条路"。
    expect(classify(ran).kind).toBe('fail');
  });
});
