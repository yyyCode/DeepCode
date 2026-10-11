#!/usr/bin/env node
/**
 * hookify 的钩子：stdin JSON → 按 `hook_event_name` 分派 → 读规则 → 求值 →
 * stdout JSON / 退出码。四个事件共用这一个脚本（`hooks.json` 里各挂一次）。
 *
 * **失败方向是 fail-closed，与参考实现相反。** 参考实现的 hookify 在 `finally` 里
 * `sys.exit(0)`，注释写着"钩子出错永远不该阻断操作"。我们的框架不是这么读的：
 * `classify`（src/cli/hook-run.ts）只认 exit 0 与 exit 2，**其余一律 fail**。
 *
 * 但"失败"的代价**逐事件不同**（src/cli/classic-hooks.ts）：
 *
 * | 事件 | 这个脚本崩了的后果 |
 * | --- | --- |
 * | PreToolUse | 所有工具调用被拦下 —— 真正的停摆 |
 * | 另外三个 | 只 notice 一声，不注入、不 block —— 事件本身已经没有可拦的动作 |
 *
 * PreToolUse 那格的代价我们接受：一个读不懂自己规则的守卫，比一个假装没事的守卫安全。
 * 三段都写在 README 里。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENTS, RuleError, evaluate, parseRule } from '../core/rules.mjs';

const PREFIX = 'hookify.';
const SUFFIX = '.local.md';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 出任何说不清的事都走这儿：stderr 一句话 + 非零退出码。
 *
 * 非零 = fail。后果逐事件不同（见文件头那张表）：PreToolUse 上翻成 deny，
 * 另外三个事件上只是"喊一声，什么都不做"。这是本文件里唯一一处自己判自己失败的入口，
 * 所以每条调用都在说清"读不懂的是什么"。
 */
function die(message) {
  process.stderr.write(`hookify: ${message}\n`);
  process.exit(1);
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch (error) {
  die(`stdin 不是合法 JSON：${String(error)}`);
}

// 分派靠 stdin 里的 `hook_event_name`，不靠命令行参数 —— 钩子的命令行是用户在
// `hooks.json` 里写的，多一个参数就多一处会写岔的地方。读不出来 = 我们自己的
// `hooks.json` 与这个脚本对不上了，那是真故障，不是"没意见"。
const event = typeof input?.hook_event_name === 'string' ? input.hook_event_name : '';
if (!EVENTS.includes(event)) {
  die(`stdin 里的 hook_event_name 是 ${JSON.stringify(event)}，不在 ${EVENTS.join(' / ')} 里`);
}

// 逐事件给规则看的那个对象。字段名与 README 里那张表一一对应。
// ⚠️ PostToolUse 的 `tool_response` 是**我们桥出来的形状** `{ok, output}`，
// 不是参考实现那一个 —— 那份形状没核实过（见 src/cli/classic-hooks.ts 与 README）。
const subject =
  event === 'PreToolUse'
    ? input?.tool_input
    : event === 'PostToolUse'
      ? input?.tool_response
      : event === 'UserPromptSubmit'
        ? { prompt: input?.prompt }
        : { last_assistant_message: input?.last_assistant_message };

// 规则目录从 stdin 里的 cwd 拼，不从 process.cwd() 拼 ——
// 钩子进程的 cwd 不保证是会话根。
const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
const dir = join(cwd, '.deepcode');

let names = [];
try {
  names = (await readdir(dir)).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX)).sort();
} catch (error) {
  // 目录不存在 = 这个项目没配规则 = 常态，不是故障。别的读不动才是故障。
  if (error?.code !== 'ENOENT') die(`读不了规则目录 ${dir}：${String(error)}`);
}

const rules = [];
for (const name of names) {
  const path = join(dir, name);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    die(`读不了规则文件 ${path}：${String(error)}`);
  }
  try {
    const { rule, warnings } = parseRule(text, path);
    for (const warning of warnings) process.stderr.write(`hookify: ${warning}\n`);
    rules.push(rule);
  } catch (error) {
    if (error instanceof RuleError) die(error.message);
    throw error;
  }
}

const verdict = evaluate(rules, event, subject, String(input?.tool_name ?? ''));
if (verdict === undefined) process.exit(0);

// ⚠️ 拦停的理由是 `permissionDecisionReason`，**不是**参考实现的 `systemMessage`。
// 我们的 classify（src/cli/hook-run.ts）只读前者，后者会被静默忽略 ——
// 照抄参考实现会得到一个"拦下了但一句话不说"的钩子。
//
// `notify` 走的是另一条通道：`additionalContext`，也就是"说话"而不是"裁决"。
// 它是 PostToolUse / UserPromptSubmit 上唯一兑现得了的动作（工具已经跑完了 /
// 提示词已经要进去了），所以那两个事件上的规则只可能落在这里。
const payload =
  verdict.decision === 'notify'
    ? { additionalContext: verdict.reason }
    : { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason };

process.stdout.write(
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...payload } })}\n`,
);
process.exit(0);
