#!/usr/bin/env node
// 工作流硬化检查。四条规则见 P4e 设计 §2.1。
//
// ⚠️ 这是**文本扫描**，不是 YAML 解析器 —— 零运行时依赖是仓库的既有底线，
// 为四条规则引一个解析器不值。它看不见：动态拼出来的 `uses:`、YAML 锚点/复用块里的引用、
// job 之间的包含关系。**它是尽力而为的护栏，不是完备证明**（参考实现对自家那个 python
// 校验器说的也是同一句话）。这个边界写进了 README，不藏着。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT_DIR = (process.argv[2] ?? new URL('..', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const WORKFLOWS = join(ROOT_DIR, '.github', 'workflows');

const SHA_RE = /^[0-9a-f]{40}$/;
// 一行里最多一个 `uses:`，所以不用 /g —— 带 /g 的 test() 会自己推进 lastIndex，是个陷阱。
const USES_RE = /(?:^|\s)uses\s*:\s*['"]?([^'"\s]+)['"]?/;
const CHECKOUT_RE = /(?:^|\s)uses\s*:\s*['"]?actions\/checkout@/;
const CREDENTIALS_RE = /(?:^|\s)persist-credentials\s*:\s*['"]?false/;

/** 剥掉行尾注释。`#` 前必须是行首或空白 —— 免得把值里的 `#` 当成注释。 */
function stripComment(line) {
  const hit = /(^|\s)#/.exec(line);
  return hit === null ? line : line.slice(0, hit.index + hit[1].length);
}

const problems = [];

// 没有工作流不是错误（新克隆、或还没上前先本地跑一口）—— 与 check-boundaries 对缺失目录的处理同形。
if (!existsSync(WORKFLOWS)) {
  console.log('工作流硬化检查通过（没有工作流）');
  process.exit(0);
}

for (const name of readdirSync(WORKFLOWS)) {
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
  const file = join(WORKFLOWS, name);
  const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map(stripComment);

  // H2：必须有显式的顶层 `permissions:`。
  // 顶层是**每个 job 的上限**，所以缺省最危险 —— 缺省 = 仓库默认 token 权限。
  if (!lines.some((line) => /^permissions\s*:/.test(line))) {
    problems.push(`${rel}: 缺顶层 permissions:（缺省 = 仓库默认 token 权限，太大）`);
  }

  // H3：禁 pull_request_target。它给不可信 PR 的代码一个带写 token 与 secrets 的上下文。
  lines.forEach((line, i) => {
    if (/^\s*pull_request_target\s*:/.test(line)) {
      problems.push(
        `${rel}:${i + 1}: 禁 pull_request_target（给不可信 PR 的代码写 token 与 secrets）`,
      );
    }
  });

  // 按 `- ` 把文件切成 step。`on: push: branches: - main` 这类内联列表也会被切开，
  // 但它们不含 `uses:`，对下面两条规则无害；代价是行号指向这一段的第一行。
  const steps = [];
  let current = [];
  lines.forEach((line, i) => {
    if (/^\s*-\s/.test(line) && current.length > 0) {
      steps.push(current);
      current = [];
    }
    current.push({ line, i });
  });
  if (current.length > 0) steps.push(current);

  for (const step of steps) {
    const first = step[0];
    if (first === undefined) continue;
    const body = step.map((s) => s.line).join('\n');

    // H4：checkout 必须 persist-credentials: false。
    // 否则 token 被写进 .git/config，后面任意一个 step 都能拿去推东西。
    if (CHECKOUT_RE.test(body) && !CREDENTIALS_RE.test(body)) {
      problems.push(`${rel}:${first.i + 1}: actions/checkout 没写 persist-credentials: false`);
    }

    // H1：第三方 action 必须钉 40 位 commit SHA。tag 会被上游重指 —— CI 的头号供应链风险。
    // `./` 开头的本地复合动作豁免（它就在这个仓库里，跟着 commit 一起被审）。
    for (const { line, i } of step) {
      const hit = USES_RE.exec(line);
      if (hit === null) continue;
      const spec = hit[1];
      if (spec.startsWith('./')) continue;
      const at = spec.lastIndexOf('@');
      const ref = at === -1 ? '' : spec.slice(at + 1);
      if (!SHA_RE.test(ref)) {
        problems.push(`${rel}:${i + 1}: ${spec} 没钉 commit SHA（tag 会被上游重指）`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('工作流硬化违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('工作流硬化检查通过');
