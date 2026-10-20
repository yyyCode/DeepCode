import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 真起 `hook.mjs` 这个进程来测 —— 与 `hook-run.test.ts` / `plugin-e2e.test.ts`
 * 同一套做法。不静态 import 那几个 `.mjs`：它们不在 `tsconfig.json` 的 `include`
 * 里（`["packages","test","scripts","mods"]`，且没有 `allowJs`），import 过来 tsc 会红。
 */
const HOOK = fileURLToPath(new URL('../plugins/hookify/hooks/hook.mjs', import.meta.url));

const made: string[] = [];
afterEach(async () => {
  while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true });
});

/** 一个临时工程：`.deepcode/` 下按需写规则文件。返回它的根。 */
async function world(rules: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deepcode-hookify-'));
  made.push(root);
  if (Object.keys(rules).length > 0) {
    await mkdir(join(root, '.deepcode'), { recursive: true });
    for (const [name, text] of Object.entries(rules)) {
      await writeFile(join(root, '.deepcode', name), text);
    }
  }
  return root;
}

/** 跑一次钩子，喂进去的就是那份 stdin（`undefined` 会变成字面量 `undefined`，别用）。 */
async function spawnHook(
  input: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * `PreToolUse` 那一路 —— 绝大多数既有用例走的是这条。
 *
 * 这里的 `run(root, tool, toolInput)` 三参数签名**有意与改写前逐字一致**：
 * 下面那一整批用例一个字都不用改，而它们跑通就证明了"规则文件里省略 `event`
 * 等于 `PreToolUse`"这条向后兼容是真的。
 */
async function run(
  root: string,
  tool: string,
  toolInput: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await spawnHook({
    session_id: 's1',
    transcript_path: join(root, 't.jsonl'),
    cwd: root,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'u1',
  });
}

/** 任意事件。`extra` 是那个事件独有的那一个字段（`tool_response` / `prompt` / …）。 */
async function runEvent(
  root: string,
  event: string,
  extra: Record<string, unknown>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await spawnHook({
    session_id: 's1',
    transcript_path: join(root, 't.jsonl'),
    cwd: root,
    hook_event_name: event,
    ...extra,
  });
}

/**
 * 一条规则文件的正文。
 *
 * ⚠️ 样例 key 的长度是敏感的：`AKIA` 后面必须**正好 16 位** `[0-9A-Z]`。
 * `AKIAIOSFODNN7EXAMPLE` 是 AWS 文档里那只标准样例（20 位，正好），
 * 而随手编的 `AKIA1234567890ABCD` 只有 18 位 —— 配 `AKIA[0-9A-Z]{16}` 不匹配，
 * 会让一批断言因为"样例本身不命中"而以错误的方式变绿。
 */
const KEY = 'AKIAIOSFODNN7EXAMPLE';

function ruleFile(over: Partial<Record<string, string>> = {}): string {
  const fm: Record<string, string | undefined> = {
    name: 'no-aws-keys',
    tool: 'Write|Edit',
    field: 'content',
    operator: 'matches',
    pattern: 'AKIA[0-9A-Z]{16}',
    decision: 'deny',
    message: '文件里出现了形似 AWS access key 的东西',
    ...over,
  };
  return `---\n${Object.entries(fm)
    // 值为 undefined 的键**整行不写** —— 否则 `{ tool: undefined }` 会渲染成字面量
    // `tool: undefined`，那条"省略 tool"的用例就变成在测别的东西了。
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n`;
}

/** 从 stdout 里取判定。stdout 空或不是 JSON 时返回 undefined（不抛）。 */
function decisionOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
}

function reasonOf(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecisionReason?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecisionReason ?? '';
  } catch {
    return '';
  }
}

/** `notify` 走的那条通道 —— 与判定**不是**同一个字段。 */
function contextOf(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return '';
  }
}

/** stdout 里那个 `hookEventName` 回填的是哪个事件 —— 脚本该照抄 stdin 里的。 */
function eventOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string } };
    return parsed.hookSpecificOutput?.hookEventName;
  } catch {
    return undefined;
  }
}

describe('hookify：没有规则时什么都不做', () => {
  it('没有 .deepcode 目录 → 退出 0、stdout 空', async () => {
    const root = await world();
    const out = await run(root, 'Write', { file_path: 'a.txt', content: 'x' });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('有目录但没有 hookify.*.local.md → 同样退出 0', async () => {
    const root = await world({ 'settings.json': '{}' });
    const out = await run(root, 'Write', { file_path: 'a.txt', content: 'x' });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});

describe('hookify：命中与不命中', () => {
  it('命中 → deny，理由里有规则名、message 与正文', async () => {
    const root = await world({
      'hookify.no-keys.local.md': `${ruleFile()}\n要写就先把 key 换成占位符。\n`,
    });
    const out = await run(root, 'Write', { file_path: 'a.txt', content: `const k = "${KEY}";` });
    expect(out.code).toBe(0);
    expect(decisionOf(out.stdout)).toBe('deny');
    expect(reasonOf(out.stdout)).toContain('no-aws-keys');
    expect(reasonOf(out.stdout)).toContain('AWS access key');
    expect(reasonOf(out.stdout)).toContain('占位符');
  });

  it('不命中 → stdout 空（不是 deny）', async () => {
    const root = await world({ 'hookify.no-keys.local.md': ruleFile() });
    const out = await run(root, 'Write', { file_path: 'a.txt', content: '干净内容' });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('tool 不匹配 → 不生效（matcher 是 Write|Edit，这里是 Bash）', async () => {
    const root = await world({ 'hookify.no-keys.local.md': ruleFile() });
    const out = await run(root, 'Bash', { command: `echo ${KEY}` });
    expect(out.stdout.trim()).toBe('');
  });

  it('tool 写 * → 对所有工具生效', async () => {
    const root = await world({
      'hookify.no-keys.local.md': ruleFile({ tool: '*', field: 'command' }),
    });
    const out = await run(root, 'Bash', { command: `echo ${KEY}` });
    expect(decisionOf(out.stdout)).toBe('deny');
  });

  it('tool 省略 → 也是对所有工具生效（与 hooks.json 的 matcher 同一套语义）', async () => {
    const root = await world({
      'hookify.no-keys.local.md': ruleFile({ tool: undefined, field: 'command' }),
    });
    const out = await run(root, 'Bash', { command: `echo ${KEY}` });
    expect(decisionOf(out.stdout)).toBe('deny');
  });

  it('field 不存在 → 不匹配（不是错误）', async () => {
    const root = await world({ 'hookify.no-keys.local.md': ruleFile({ field: 'nope' }) });
    const out = await run(root, 'Write', { file_path: 'a.txt', content: KEY });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('field 是数组 → 不匹配（只取字符串）', async () => {
    const root = await world({ 'hookify.no-keys.local.md': ruleFile({ field: 'paths' }) });
    const out = await run(root, 'Write', { paths: [KEY] });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});

describe('hookify：五种 operator', () => {
  // [operator, pattern, 喂进去的值]
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['matches', 'AKIA[0-9A-Z]{16}', `xx ${KEY} yy`],
    ['contains', 'AKIA', `xx ${KEY} yy`],
    ['equals', 'exact', 'exact'],
    ['starts_with', 'AKIA', KEY],
    ['ends_with', 'EXAMPLE', KEY],
  ];

  for (const [operator, pattern, content] of CASES) {
    it(`${operator} 命中`, async () => {
      const root = await world({
        'hookify.r.local.md': ruleFile({ operator, pattern, field: 'content' }),
      });
      const out = await run(root, 'Write', { content });
      expect(decisionOf(out.stdout)).toBe('deny');
    });
  }

  it('equals 只认全等，不认子串', async () => {
    const root = await world({
      'hookify.r.local.md': ruleFile({ operator: 'equals', pattern: 'exact', field: 'content' }),
    });
    const out = await run(root, 'Write', { content: 'not-exact-at-all' });
    expect(out.stdout.trim()).toBe('');
  });

  it('starts_with 不认中间那段子串', async () => {
    const root = await world({
      'hookify.r.local.md': ruleFile({ operator: 'starts_with', pattern: 'AKIA', field: 'content' }),
    });
    const out = await run(root, 'Write', { content: `xx ${KEY}` });
    expect(out.stdout.trim()).toBe('');
  });
});

describe('hookify：ask 与 deny 的合成', () => {
  it('decision: ask → ask（不是 deny）', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile({ decision: 'ask' }) });
    const out = await run(root, 'Write', { content: KEY });
    expect(decisionOf(out.stdout)).toBe('ask');
  });

  it('decision 省略 → deny（默认是拧紧的那个）', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile({ decision: undefined }) });
    const out = await run(root, 'Write', { content: KEY });
    expect(decisionOf(out.stdout)).toBe('deny');
  });

  it('两条命中，一条 deny 一条 ask → deny 胜，理由只列 deny 那条', async () => {
    const root = await world({
      'hookify.a.local.md': ruleFile({ decision: 'ask', name: 'soft-one' }),
      'hookify.b.local.md': ruleFile({ decision: 'deny', name: 'hard-one' }),
    });
    const out = await run(root, 'Write', { content: KEY });
    expect(decisionOf(out.stdout)).toBe('deny');
    expect(reasonOf(out.stdout)).toContain('hard-one');
    expect(reasonOf(out.stdout)).not.toContain('soft-one');
  });

  it('文件名决定读取顺序，但换顺序不换判定（重排不换行为）', async () => {
    const rules = {
      'hookify.z.local.md': ruleFile({ decision: 'ask', name: 'soft-one' }),
      'hookify.a.local.md': ruleFile({ decision: 'deny', name: 'hard-one' }),
    };
    const root = await world(rules);
    const out = await run(root, 'Write', { content: KEY });
    expect(decisionOf(out.stdout)).toBe('deny');
  });
});

describe('hookify：失败方向是 fail-closed', () => {
  const BAD: ReadonlyArray<readonly [string, string]> = [
    ['frontmatter 没闭合', '---\nname: x\nfield: content\noperator: contains\npattern: x\n'],
    ['不以 --- 开头', 'name: x\n'],
    ['缺 name', '---\nfield: content\noperator: contains\npattern: x\nmessage: m\n---\n'],
    ['缺 message', '---\nname: x\nfield: content\noperator: contains\npattern: x\n---\n'],
    ['缺 field', '---\nname: x\noperator: contains\npattern: x\nmessage: m\n---\n'],
    ['operator 不认识', ruleFile({ operator: 'regex_but_typo' })],
    ['正则非法', ruleFile({ operator: 'matches', pattern: '([' })],
    ['decision: allow', ruleFile({ decision: 'allow' })],
    ['event 不认识', ruleFile({ event: 'PostToolUseMaybe' })],
  ];

  for (const [label, text] of BAD) {
    it(`${label} → 退出非零（框架把非零翻成 deny）`, async () => {
      const root = await world({ 'hookify.bad.local.md': text });
      const out = await run(root, 'Write', { content: 'x' });
      expect(out.code).not.toBe(0);
      expect(out.stderr).toContain('hookify:');
    });
  }

  it('decision: allow 的拒绝理由里点名 allow 表达不出来', async () => {
    const root = await world({ 'hookify.bad.local.md': ruleFile({ decision: 'allow' }) });
    const out = await run(root, 'Write', { content: 'x' });
    expect(out.stderr).toContain('allow');
    expect(out.stderr).toContain('只能拧紧');
  });

  it('stdin 不是 JSON → 退出非零（读不懂输入就别说"没问题"）', async () => {
    const root = await world();
    const out = await new Promise<{ code: number; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }));
      child.stdin.end('这不是 JSON');
    });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('不是合法 JSON');
  });

  it('**未知字段只告警、这条规则照常生效** —— 唯一一处收窄的例外', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile({ future_field: 'whatever' }) });
    const out = await run(root, 'Write', { content: KEY });
    expect(out.code).toBe(0);
    expect(decisionOf(out.stdout)).toBe('deny');
    expect(out.stderr).toContain('不认识的字段');
  });
});

describe('hookify：省略 event 等于 PreToolUse', () => {
  it('规则文件里一个字都不写 event，照样只在 PreToolUse 上生效', async () => {
    // 上面那一整批用例（`ruleFile()` 从来不写 event）跑通就是这条的证明；
    // 这一条把它挑明，让它从"因为大家都没写"变成一条有名字的断言。
    const root = await world({ 'hookify.r.local.md': ruleFile() });
    expect(decisionOf((await run(root, 'Write', { content: KEY })).stdout)).toBe('deny');
  });

  it('明写 event: PreToolUse 与省略它完全等价', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile({ event: 'PreToolUse' }) });
    const out = await run(root, 'Write', { content: KEY });
    expect(decisionOf(out.stdout)).toBe('deny');
    expect(eventOf(out.stdout)).toBe('PreToolUse');
  });
});

describe('hookify：逐事件词表 —— 只有兑现得了的词才许写', () => {
  // 四个事件 × 各自不许的词。PreToolUse 上不许的是 allow（只能拧紧不能拧松），
  // 另外三个上不许的是"拒绝"与"提问"（那个点上兑现不了），Stop 上还多一个 notify
  // （那里没有"说话"的通道）。
  const ILLEGAL: ReadonlyArray<readonly [string, string]> = [
    ['PreToolUse', 'allow'],
    ['PostToolUse', 'deny'],
    ['PostToolUse', 'ask'],
    ['PostToolUse', 'allow'],
    ['UserPromptSubmit', 'deny'],
    ['UserPromptSubmit', 'ask'],
    ['UserPromptSubmit', 'allow'],
    ['Stop', 'ask'],
    ['Stop', 'allow'],
    ['Stop', 'notify'],
  ];

  it.each(ILLEGAL)('%s 上写 decision: %s → 拒绝，并点名这个事件能表达什么', async (event, decision) => {
    const root = await world({ 'hookify.bad.local.md': ruleFile({ event, decision }) });
    const out = await runEvent(root, event, {});
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('hookify:');
    expect(out.stderr).toContain(event);
    expect(out.stderr).toContain('decision');
    expect(out.stderr).toContain('能表达的是');
  });

  // 每格一条具体的话，防的是"四个事件共用一句放之四海皆准的解释" —— 那种话在
  // Stop 上一定是错的（那里被拒的不是 deny）。
  it('理由逐事件不同：Stop 上不会说成"工具已经跑完了"', async () => {
    const root = await world({ 'hookify.bad.local.md': ruleFile({ event: 'Stop', decision: 'ask' }) });
    const out = await runEvent(root, 'Stop', {});
    expect(out.stderr).toContain('收手');
    expect(out.stderr).not.toContain('工具已经跑完');
  });

  it('PostToolUse 上说清是"工具已经跑完"，并点出 notify 这条出路', async () => {
    const root = await world({
      'hookify.bad.local.md': ruleFile({ event: 'PostToolUse', decision: 'deny' }),
    });
    const out = await runEvent(root, 'PostToolUse', {});
    expect(out.stderr).toContain('工具已经跑完');
    expect(out.stderr).toContain('notify');
  });

  // 合法的那几条：`decision` 落进哪条通道（判定 vs 说话）由事件决定，不看人写了什么。
  const LEGAL: ReadonlyArray<readonly [string, string, string, string, Record<string, unknown>]> = [
    ['PreToolUse', 'deny', 'content', `写的文件里有 ${KEY}`, { tool_name: 'Write', tool_input: { content: `const k = "${KEY}";` } }],
    ['PreToolUse', 'ask', 'content', `写的文件里有 ${KEY}`, { tool_name: 'Write', tool_input: { content: `const k = "${KEY}";` } }],
    ['PostToolUse', 'notify', 'output', `命令的输出里有 ${KEY}`, { tool_response: { ok: false, output: `boom ${KEY}` } }],
    ['UserPromptSubmit', 'notify', 'prompt', `你这句话里有 ${KEY}`, { prompt: `帮我看看 ${KEY} 是不是泄漏了` }],
    ['Stop', 'deny', 'last_assistant_message', `刚才那句里有 ${KEY}`, { last_assistant_message: `我把它写进 a.ts 了：${KEY}` }],
  ];

  it.each(LEGAL)(
    '%s + %s 解析通过，且落进该事件那条通道',
    async (event, decision, field, message, stdin) => {
      const root = await world({
        // `tool` 一律省略 = 对所有工具生效；只有 PreToolUse 会去看它。
        'hookify.r.local.md': ruleFile({
          event,
          decision,
          field,
          operator: 'contains',
          pattern: 'AKIA',
          message,
          tool: undefined,
        }),
      });
      const out = await runEvent(root, event, stdin);
      expect(out.code).toBe(0);
      expect(eventOf(out.stdout)).toBe(event);
      if (decision === 'notify') {
        // 说话那条通道：`additionalContext`，且**没有**判定字段 —— 免得一个
        // `notify` 被读成裁决。
        expect(contextOf(out.stdout)).toContain(message);
        expect(decisionOf(out.stdout)).toBeUndefined();
      } else {
        expect(decisionOf(out.stdout)).toBe(decision);
        expect(reasonOf(out.stdout)).toContain(message);
      }
    },
  );
});

describe('hookify：事件必须对上', () => {
  it('一条 PreToolUse 的规则在 PostToolUse 上不命中', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile({ field: 'output' }) });
    const out = await runEvent(root, 'PostToolUse', { tool_response: { ok: true, output: KEY } });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('一条 PostToolUse 的规则在 PreToolUse 上不命中', async () => {
    const root = await world({
      'hookify.r.local.md': ruleFile({ event: 'PostToolUse', field: 'output', decision: undefined }),
    });
    const out = await run(root, 'Write', { content: KEY });
    expect(out.stdout.trim()).toBe('');
  });

  it('别的三个事件上没有工具可筛：写了 tool 的规则在那儿**永不命中**', async () => {
    // 静默放过它会让人以为这条筛选条件生效了 —— 那是一句兑现不了的承诺。
    const root = await world({
      'hookify.r.local.md': ruleFile({
        event: 'PostToolUse',
        tool: 'Write',
        field: 'output',
        decision: undefined,
      }),
    });
    const out = await runEvent(root, 'PostToolUse', { tool_response: { ok: true, output: KEY } });
    expect(out.stdout.trim()).toBe('');
  });

  it('field 取的是**这个事件**的载荷：PostToolUse 的 field: content 取不到东西', async () => {
    const root = await world({
      'hookify.r.local.md': ruleFile({ event: 'PostToolUse', field: 'content', decision: undefined }),
    });
    // `tool_response` 里没有 `content` 这个键 —— 不匹配，不是错误。
    const out = await runEvent(root, 'PostToolUse', { tool_response: { ok: true, output: KEY } });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('`ok` 是布尔不是字符串 → 拿它当 field 的规则不命中（只取字符串）', async () => {
    const root = await world({
      'hookify.r.local.md': ruleFile({
        event: 'PostToolUse',
        field: 'ok',
        operator: 'equals',
        pattern: 'true',
        decision: undefined,
      }),
    });
    const out = await runEvent(root, 'PostToolUse', { tool_response: { ok: true, output: 'x' } });
    expect(out.stdout.trim()).toBe('');
  });

  it('stdin 里的 hook_event_name 不在四个事件里 → 退出非零（我们自己的清单写岔了）', async () => {
    const root = await world({ 'hookify.r.local.md': ruleFile() });
    const out = await runEvent(root, 'PreToolUseMaybe', {});
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('hook_event_name');
    expect(out.stderr).toContain('PreToolUseMaybe');
  });

  it('压根没有 hook_event_name → 同样退出非零', async () => {
    const root = await world();
    const out = await spawnHook({ session_id: 's1', cwd: root, tool_name: 'Write' });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('hook_event_name');
  });
});
