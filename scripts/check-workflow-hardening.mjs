#!/usr/bin/env node
// 工作流硬化检查。七条规则：H1–H4 见 P4e 设计 §2.1，H5–H7 见 P5d 设计 §2.2。
//
// ⚠️ 这是**文本扫描**，不是 YAML 解析器 —— 零运行时依赖是仓库的既有底线，
// 为七条规则引一个解析器不值。它看不见：动态拼出来的 `uses:`、YAML 锚点/复用块里的引用、
// job 之间的包含关系。**它是尽力而为的护栏，不是完备证明**（参考实现对自家那个 python
// 校验器说的也是同一句话）。这个边界写进了 README，不藏着。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT_DIR = (process.argv[2] ?? new URL('..', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const WORKFLOWS = join(ROOT_DIR, '.github', 'workflows');
const EGRESS = join(ROOT_DIR, '.github', 'egress-firewall.yaml');

const SHA_RE = /^[0-9a-f]{40}$/;
// 一行里最多一个 `uses:`，所以不用 /g —— 带 /g 的 test() 会自己推进 lastIndex，是个陷阱。
const USES_RE = /(?:^|\s)uses\s*:\s*['"]?([^'"\s]+)['"]?/;
const CHECKOUT_RE = /(?:^|\s)uses\s*:\s*['"]?actions\/checkout@/;
const CREDENTIALS_RE = /(?:^|\s)persist-credentials\s*:\s*['"]?false/;

/** agent job 唯一被允许的 runner（H5）。 */
const FIREWALL_RUNNER = 'ubuntu-24.04-firewall';
/** agent job 的标记行（H5 的第一次判定）。 */
const AGENT_MARKER = 'deepcode:agent-job';
/** 权限姿态标记行（H7）。它**必须**是注释：它是声明，不是给 shell 的参数。 */
const DENY_MARKER = '# deepcode:permission-mode deny-by-default';
/**
 * 明令禁用的自动放行开关（H7）。
 *
 * ⚠️ 这一条与参考实现**方向相反**，是刻意的：它要求 agent job "恰好 auto"，
 * 我们要求"恰好没有自动放行"。理由就是那句原话：**谁加自动放行开关谁就是在开倒车。**
 */
const AUTO_FLAGS = ['--yes', '--dangerously-skip-permissions', '--permission-mode auto'];

/** 剥掉行尾注释。`#` 前必须是行首或空白 —— 免得把值里的 `#` 当成注释。 */
function stripComment(line) {
  const hit = /(^|\s)#/.exec(line);
  return hit === null ? line : line.slice(0, hit.index + hit[1].length);
}

/**
 * 按 `jobs:` 之后那层（2 空格缩进的）键把文件切成一个个 job。
 *
 * 行号一律带在条目上：判词要指得出是哪一行，指不出行号的检查器会让人从头读一遍文件。
 * 切不出来（没有 `jobs:`、或者它下面一个键都没有）就返回空数组 —— 那不是错误，
 * H5/H7 只对 job 说话。
 */
function splitJobs(lines, rawLines) {
  const head = lines.findIndex((line) => /^jobs\s*:/.test(line));
  if (head === -1) return [];

  const jobs = [];
  let current = null;
  for (let i = head + 1; i < lines.length; i++) {
    // 顶层键（缩进 0）= `jobs:` 这一节到头了。不认这一条的话，`jobs:` 之后的东西
    // 会全部算进最后一个 job。
    if (/^[A-Za-z_]/.test(lines[i])) break;

    const key = /^ {2}([A-Za-z0-9_-]+)\s*:/.exec(lines[i]);
    if (key !== null) {
      if (current !== null) jobs.push(current);
      current = { name: key[1], at: i, lines: [], raw: [] };
      continue;
    }
    if (current !== null) {
      current.lines.push({ line: lines[i], i });
      current.raw.push({ line: rawLines[i], i });
    }
  }
  if (current !== null) jobs.push(current);
  return jobs;
}

/** `runs-on` 的值。返回 undefined 表示这一块里没写。 */
function runsOnOf(job) {
  for (const { line, i } of job.lines) {
    const hit = /^\s*runs-on\s*:\s*(.+?)\s*$/.exec(line);
    if (hit === null) continue;
    return { value: hit[1].replace(/^['"]|['"]$/g, ''), at: i };
  }
  return undefined;
}

const problems = [];

// 没有工作流不是错误（新克隆、或还没上前先本地跑一口）—— 与 check-boundaries 对缺失目录的处理同形。
if (!existsSync(WORKFLOWS)) {
  console.log('工作流硬化检查通过（没有工作流）');
  process.exit(0);
}

// ── H6：出口白名单（与单个工作流无关，所以放在按文件循环之外）────────────
// agent job 要能在一条被钉死的出网白名单里跑，那份白名单就得是个**仓库里的文件**。
// 三条规矩（参考实现写在文件头，照抄）：只在真的有 step 需要时加、写全名禁 `*`、注明用途。
if (!existsSync(EGRESS)) {
  problems.push(
    '.github/egress-firewall.yaml: 不存在 —— agent job 的出网白名单必须落成文件，才审得动',
  );
} else {
  // 注释先剥掉：这份文件的注释是**给人读的理由**（"这条是给 pnpm install 的"），
  // 不参与判定；而 `- host: x   # 用途` 这种行不剥的话，值里会拖一个注释尾巴。
  const lines = readFileSync(EGRESS, 'utf8').split(/\r?\n/).map(stripComment);

  const modeAt = lines.findIndex((line) => /^mode\s*:/.test(line));
  const mode = modeAt === -1 ? undefined : /^mode\s*:\s*(.+?)\s*$/.exec(lines[modeAt])[1];
  if (mode !== 'enforce') {
    problems.push(
      `.github/egress-firewall.yaml${modeAt === -1 ? '' : `:${modeAt + 1}`}: mode 必须是 enforce（现在是 ${mode ?? '没写'}）—— report 只是看着像在管`,
    );
  }

  const allowAt = lines.findIndex((line) => /^allow\s*:/.test(line));
  if (allowAt === -1) {
    problems.push('.github/egress-firewall.yaml: 没有 allow: 这一节 —— 白名单是空的还是忘了写，看不出来');
  } else {
    const allowIndent = lines[allowAt].length - lines[allowAt].trimStart().length;
    const entries = [];
    for (let i = allowAt + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      // 比 `allow:` 更浅、又不是列表项 = 这一节结束（比如文档末尾的另一个顶层键）。
      if (indent <= allowIndent && !line.trim().startsWith('-')) break;
      if (line.trim().startsWith('-')) entries.push({ line, at: i });
    }

    if (entries.length === 0) {
      problems.push(
        `.github/egress-firewall.yaml:${allowAt + 1}: allow: 是空的 —— 一个都不许出网与"忘了填"长得一样，写出来才分得开`,
      );
    }
    for (const { line, at } of entries) {
      // `*` 不是"一条宽规则"，是一条**永远往后放宽**的规则：上游换一个 CDN 域名，
      // 白名单一点没改，出口却自己开大了。要加哪一个就写哪一个。
      if (line.includes('*')) {
        problems.push(
          `.github/egress-firewall.yaml:${at + 1}: 白名单条目不许含 *（写成全名）：${line.trim()}`,
        );
      }
    }
  }
}

for (const name of readdirSync(WORKFLOWS)) {
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
  const file = join(WORKFLOWS, name);
  const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
  const rawLines = readFileSync(file, 'utf8').split(/\r?\n/);
  const lines = rawLines.map(stripComment);

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

  // H7（后半）：整份工作流里不许出现自动放行开关。
  //
  // 扫的是**剥过注释**的行 —— 能被执行的是命令，注释里的三个词不会放行任何东西。
  // （标记行是反过来的：`# deepcode:*` 本来就是注释，所以那两条从 rawLines 读。）
  lines.forEach((line, i) => {
    for (const flag of AUTO_FLAGS) {
      if (line.includes(flag)) {
        problems.push(`${rel}:${i + 1}: 禁用 ${flag} —— 谁加自动放行开关谁就是在开倒车`);
      }
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

  // ── H5 / H7：agent job ─────────────────────────────────────────────
  //
  // 怎么认出"调用 agent 的 job"（与参考实现的 `job_calls_claude` 对位）——三条里任一条成立：
  //   · job 里有 `# deepcode:agent-job` 标记行，或
  //   · job 的某个 `run:` 里出现 `deepcode` 命令，或
  //   · job 里写了权限姿态标记（第三条是自己加的：一行 `deny-by-default` 等于在说
  //     "我是 agent job"，那就不该再靠别的标记才管得住它）。
  for (const job of splitJobs(lines, rawLines)) {
    const postureCount = job.raw.filter((l) => l.line.trim().startsWith(DENY_MARKER)).length;
    const isAgent =
      job.raw.some((l) => l.line.includes(AGENT_MARKER)) ||
      // `- run: x` 与换行的 `run: x` 两种写法都要认（`(- )?` 这一截就是为它留的）。
      job.lines.some((l) => /^\s*(-\s*)?run\s*:/.test(l.line) && /\bdeepcode\b/.test(l.line)) ||
      postureCount > 0;
    if (!isAgent) continue;

    // H5：agent job 必须跑在防火墙 runner 上。**恰好**是它 —— 不是前缀、不是"含 firewall"。
    // 参考实现允许一张 EXEMPT_FROM_FIREWALL_RUNNER 豁免表；我们**不做** ——
    // 那张表的存在理由是"防火墙 runner 并非处处可用"，而我们只有一个 agent job。
    // 表会让例外变安静。
    const runsOn = runsOnOf(job);
    if (runsOn === undefined || runsOn.value !== FIREWALL_RUNNER) {
      problems.push(
        `${rel}:${(runsOn?.at ?? job.at) + 1}: agent job ${job.name} 的 runs-on 必须是 ${FIREWALL_RUNNER}（现在是 ${runsOn?.value ?? '没写'}）—— 防火墙 runner 是它唯一的出网边界`,
      );
    }

    // H7（前半）：权限姿态必须**显式**，且只有一处。
    // "只有一行"不是洁癖：两行意味着有一行是死的，而读的人不知道该信哪一行。
    if (postureCount !== 1) {
      problems.push(
        `${rel}:${job.at + 1}: agent job ${job.name} 必须恰好有一行 ${DENY_MARKER}（现在 ${postureCount} 行）—— 权限姿态是声明的，不是默认的`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('工作流硬化违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('工作流硬化检查通过');
