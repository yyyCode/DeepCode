#!/usr/bin/env node
/**
 * hookify 的 PreToolUse 钩子：stdin JSON → 读规则 → 求值 → stdout JSON / 退出码。
 *
 * **失败方向是 fail-closed，与参考实现相反。** 参考实现的 hookify 在 `finally` 里
 * `sys.exit(0)`，注释写着"钩子出错永远不该阻断操作"。我们的框架不是这么读的：
 * `classify`（src/cli/hook-run.ts:180-195）只认 exit 0 与 exit 2，**其余一律 fail，
 * 而 fail 与 block 一样翻成 deny**（src/cli/classic-hooks.ts:75-79）。
 *
 * 也就是说：这个脚本一崩，所有工具调用都会被拦下。我们接受这个代价 ——
 * 一个读不懂自己规则的守卫，比一个假装没事的守卫安全。代价写在 README 里。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuleError, evaluate, parseRule } from '../core/rules.mjs';

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
 * 非零 = fail = deny。这是本文件里唯一一处"拦下所有动作"的入口，
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

const verdict = evaluate(rules, String(input?.tool_name ?? ''), input?.tool_input);
if (verdict === undefined) process.exit(0);

// ⚠️ 理由是 `permissionDecisionReason`，**不是**参考实现的 `systemMessage`。
// 我们的 classify（src/cli/hook-run.ts:219）只读前者，后者会被静默忽略 ——
// 照抄参考实现会得到一个"拦下了但一句话不说"的钩子。
process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  })}\n`,
);
process.exit(0);
