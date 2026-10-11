/**
 * CI 里的 agent 冒烟：一个真装配的引擎，跑一个真 turn，落在非 TTY 的 fail-closed 上。
 *
 * 它存在的理由不是"又多测了一遍" —— 是让 `.github/workflows/ci.yml` 里那个 agent job
 * **有对象**（H5/H6/H7 三条硬化规则要有一个真的 job 管着），顺带把"fail-closed 在 CI
 * 这种非 TTY 环境里也成立"从一句设计文档里的话变成每天跑一次的事实。
 *
 * 为什么这个脚本不在 `test/` 下：它是一条**流水线步骤**，判据由退出码给（0 / 1 + 一行原因），
 * 与 vitest 的收集机制无关。装一个假 provider，所以不花 token、不联网。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Message } from '../src/contract/model-provider';
import { createEngine } from '../src/core/create';
import type { DispatchFn } from '../src/core/dispatch';
import { runTurn } from '../src/core/loop';
import { confirmPlugin } from '../src/builtins/confirm';
import { coreTools } from '../src/builtins/tools';
import { createPromptSink } from '../src/cli/prompt';
import { scriptedProvider } from '../test/harness';

const failures: string[] = [];
const reasons: string[] = [];

/**
 * 非 TTY 是**这个脚本的判据本身**，不是环境细节。
 *
 * TTY 下 `prompt.ask` 会真的去等一行输入：那会把一次冒烟变成一次挂起，而且能拿到的
 * 结论也不是我们要证的那一条。所以先挡住，并把怎么跑写在话里 —— 而不是悄悄换一条路
 * 走下去（那样打印出来的"通过"证明的是另一件事）。
 */
if (process.stdin.isTTY) {
  process.stderr.write(
    '这个脚本判的是"非 TTY 下 fail-closed"，TTY 下它会真的等你敲一行。用管道跑：\n' +
      '  echo | pnpm exec tsx scripts/agent-smoke.ts\n',
  );
  process.exit(1);
}

const workdir = await mkdtemp(join(tmpdir(), 'deepcode-agent-smoke-'));
const target = join(workdir, 'smoke-target.txt');
const readable = join(workdir, '已经有的文件.txt');
await writeFile(readable, '这一行是从盘上读到的\n', 'utf8');

// readline 只建这一次，与 `cli/main.ts` 同一条：确认提示复用调用方那**一个**实例。
// `interactive` **不写死**，让 `prompt.ts` 自己按 `process.stdin.isTTY` 判 —— 上面那道
// 闸保证了这里必是非 TTY，于是这行代码走的是**生产里 CI 走的那一条**。
const controller = new AbortController();
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const sink = createPromptSink(rl, { signalOf: () => controller.signal });

const asked: string[] = [];
const answers: string[] = [];

const provider = scriptedProvider([
  [
    { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: target, content: '不该被写出来\n' } },
    { type: 'done', stopReason: 'tool_use' },
  ],
  [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: readable } },
    { type: 'done', stopReason: 'tool_use' },
  ],
  [{ type: 'text', text: '看过了。' }, { type: 'done', stopReason: 'end_turn' }],
]);

const { $, dispatch } = await createEngine({
  // 真内建工具 + 真确认器。confirm 坐 builtin，它答 'ask'，把决定交给 `$.ui.ask` ——
  // 这一跳正是"非 TTY 下没人能确认"要落地的地方。
  plugins: [...coreTools, confirmPlugin],
  provider,
  ui: {
    print: () => {},
    notice: (line) => reasons.push(line),
    ask: async (question) => {
      asked.push(question);
      const answer = await sink.ask(question);
      answers.push(answer);
      return answer;
    },
  },
  sessionInfo: { id: 'agent-smoke', cwd: workdir, root: workdir },
  env: process.env,
  signal: () => controller.signal,
});

/** 派发流水账：光断言"拒绝了"有个洞 —— 一个整个摊掉的引擎也什么都"拒绝"。 */
const seen: string[] = [];
const record: DispatchFn = async (event, args, origin, skipPlugin) => {
  seen.push(event);
  return await dispatch(event, args, origin, skipPlugin);
};

function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

try {
  // 与 `cli/main.ts` 同一处派发 —— 少了它，"引擎转起来了"就没有第一笔账。
  await record('session.start', { sessionId: 'agent-smoke', cwd: workdir, root: workdir }, CORE_ORIGIN);

  const messages: Message[] = [{ role: 'user', content: '写个文件，然后把已有的那个读一遍' }];
  await runTurn(
    {
      $,
      provider,
      signal: controller.signal,
      dispatch: record,
      systemPrompt: '你是 DeepCode。',
      turnIndex: 0,
    },
    messages,
  );

  // ── 一、那个 halt 掉的动作真的没发生 ──
  check(
    !existsSync(target),
    `Write 被拒绝之后文件**仍然**出现在盘上：${target}（fail-closed 漏了）`,
  );
  check(asked.length === 1, `确认提示问了 ${asked.length} 次，应该只有 Write 那一次（Read 是只读的）`);
  check(
    answers[0] === 'n',
    `非 TTY 下 ask 答的是 ${JSON.stringify(answers[0])}，必须是 'n' —— 没人能确认就是没同意`,
  );

  const toolMessages = messages.filter((m) => m.role === 'tool');
  const first = toolMessages[0];
  check(first !== undefined, '这一轮一条 tool 消息都没有 —— 引擎根本没跑到工具那一步');
  if (first !== undefined) {
    const result = first.results[0];
    check(
      result !== undefined && result.isError === true && result.content.includes('拒绝'),
      `被拒的 Write 应该回灌一条 isError 的结果，实际是 ${JSON.stringify(result)}`,
    );
  }

  // ── 二、链是活的（这一条是上一条的对照，不能省）──
  // 只证"拒绝了"的话，一个把每一步都拒绝掉的破引擎照样能让脚本全绿。
  // Read 走的是同一条链、同一个 confirm，它必须**真的执行**。
  const second = toolMessages[1];
  check(second !== undefined, 'Read 那一轮没进到工具消息 —— 链在半路断了');
  if (second !== undefined) {
    const result = second.results[0];
    check(
      result !== undefined && result.isError !== true && result.content.includes('盘上读到的'),
      `Read 应该真的执行并回灌文件内容，实际是 ${JSON.stringify(result)}`,
    );
  }

  // ── 三、三条账都对得上 ──
  for (const event of ['session.start', 'tool.check', 'tool.call']) {
    check(seen.includes(event), `这一趟没有派发过 ${event} —— 那条链没有真的转起来`);
  }
  const checks = seen.filter((event) => event === 'tool.check').length;
  const calls = seen.filter((event) => event === 'tool.call').length;
  check(checks === 2, `tool.check 派发了 ${checks} 次，两个工具各该过一次闸`);
  check(calls === 1, `tool.call 派发了 ${calls} 次 —— 被拒的那个不该够得着 tool.call`);

  for (const line of reasons) check(!line.includes('失败'), `引擎报了失败：${line}`);
} finally {
  sink.close();
  await rm(workdir, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    'agent 冒烟不通过：\n' + failures.map((line) => `  ✗ ${line}`).join('\n') + '\n',
  );
  process.exit(1);
}
process.stdout.write('[agent-smoke] 通过：非 TTY 下 Write 被拒（fail-closed 落在链尾），Read 走通了 tool.call。\n');
// readline 关掉之后进程本该自己退，但 stdin 是个管道时不必赌这一手 —— 判据由退出码给。
process.exit(0);
