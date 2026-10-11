import { spawn, type ChildProcess } from 'node:child_process';

import type { ResolvedHookDef } from '../contract/classic';

/**
 * classic 钩子的执行面 —— 全项目**唯一**一处 `spawn`。
 *
 * 分两个函数：`runHook` 只管跑与收集（IO），`classify` 只管把结果读成判定（纯函数）。
 * 分开是为了判定能被穷举测试 —— "退出码 2 拦住了"这条出口标准要是只能靠起进程验，
 * 就永远只能测到几条幸运路径。
 */

export type HookRun = {
  /** 退出码。`-1` = 根本没跑起来（起不来、超时、被信号杀）。 */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 起不来 / 超时 / 被信号杀的原因。有它一律 deny。 */
  readonly failure: string | undefined;
};

/** 输出上限。一个往 stdout 灌无限数据的钩子不该让 CLI 吃光内存。 */
const OUTPUT_CAP = 64 * 1024;

export type HookContext = {
  /** 起钩子的工作目录。今天与 `projectDir` 同值（root = cwd），分开写是为了不让这个巧合变成前提。 */
  readonly cwd: string;
  /** 插件自己的目录：`${CLAUDE_PLUGIN_ROOT}` 指向它。 */
  readonly pluginRoot: string;
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
};

export type HookVerdict =
  /** 没意见。链交给下层。 */
  | { readonly kind: 'silent' }
  /**
   * 有意见。`allow` **也如实报出来** —— 抹平（第三方不许放行）发生在桥里
   * （`classic-hooks.ts`），不在这里。分类器只负责读，不负责定政策，
   * 于是"钩子说了什么"与"我们采纳哪部分"是两件可以分别测的事。
   */
  | {
      readonly kind: 'say';
      readonly decision: 'allow' | 'ask' | 'deny';
      readonly reason: string | undefined;
    }
  /** exit 2：拦住，理由给模型看。 */
  | { readonly kind: 'block'; readonly reason: string }
  /** 其余一切（exit 1/3/…、超时、起不来、判定读不出来）：一律 deny。 */
  | { readonly kind: 'fail'; readonly reason: string };

const DECISIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny']);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 展开命令里的 `${VAR}`。
 *
 * 不认识的变量**原样留着**，交给 shell 自己去处理 —— 换成空串的话，
 * 一个写错了变量名的钩子会变成一条语义完全不同的命令，而且没人看得出来。
 */
export function expandHookCommand(command: string, vars: Readonly<Record<string, string>>): string {
  return command.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (whole, name: string) => vars[name] ?? whole,
  );
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n…（输出被截断，超过 ${OUTPUT_CAP} 字符）`;
}

/**
 * 杀掉整棵进程树。
 *
 * Windows 上 `shell: true` 起的是 `cmd.exe`，真正的钩子是它的**孙**进程 ——
 * `child.kill()` 只打得到 `cmd.exe` 那一层，钩子活着、stdout/stderr 管道就不关。
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // `/T` 连整棵树一起收。taskkill 自己不存在的概率约等于零，但仍接住 'error'：
    // 没人接的 'error' 在 Node 里是抛异常，而超时路径上最不该有的就是异常。
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => {},
    );
    return;
  }
  child.kill('SIGKILL');
}

/**
 * 跑一个钩子。
 *
 * `shell: true`：命令是**用户自己写的 shell 片段**（`node guard.mjs && echo ok`），
 * 不当参数数组解析。与 `$.process.run` 同一个取向。
 */
export async function runHook(
  def: ResolvedHookDef,
  input: unknown,
  context: HookContext,
): Promise<HookRun> {
  let payload: string;
  try {
    payload = JSON.stringify(input);
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: '', failure: `钩子输入转不成 JSON：${message(error)}` };
  }

  const vars: Record<string, string> = {
    // 参考实现的名字 + 我们自己的名字，两组都给：照着文档写的钩子与照着 README 写的钩子都能跑。
    CLAUDE_PLUGIN_ROOT: context.pluginRoot,
    DEEPCODE_PLUGIN_ROOT: context.pluginRoot,
    CLAUDE_PROJECT_DIR: context.projectDir,
    DEEPCODE_PROJECT_DIR: context.projectDir,
  };
  // 参考实现还有个 CLAUDE_ENV_FILE（一个可以写环境变量的文件），
  // 我们**不设也不写**，如实缺着 —— 见设计 §11。用了它的钩子会拿到空字符串，与未定义同效。
  const env: NodeJS.ProcessEnv = { ...context.env, ...vars };

  return await new Promise<HookRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let failure: string | undefined;
    let settled = false;

    const child = spawn(expandHookCommand(def.command, vars), {
      cwd: context.cwd,
      env,
      shell: true,
      windowsHide: true,
    });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: cap(stdout), stderr: cap(stderr), failure });
    };

    const timer = setTimeout(() => {
      failure = `超过 ${def.timeoutMs / 1000} 秒没结束，已杀掉`;
      // 不用 SIGTERM"请它体面退出"：钩子冻住主流程时，宽限期是奢侈品。
      // 与 $.process.run 的取向一致。
      killTree(child);
      // **立刻定案，不等 'close'。** 超时要拦的就是"钩子把 CLI 冻住"，
      // 而收尸能不能成功是另一件事（Windows 上管道可能被孙进程攥着不放）。
      // 等收尸等于把这条超时交给了它本来要防的那个失败。
      finish(-1);
    }, def.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      failure = `起不来：${error.message}`;
      finish(-1);
    });
    child.on('close', (code, signal) => {
      if (failure === undefined && signal !== null) failure = `被信号 ${signal} 干掉`;
      finish(code ?? -1);
    });

    if (child.stdin) {
      // 不读 stdin 的钩子会让这次写变成 EPIPE。那是它的事，不是我们的错，
      // 但没人接的 'error' 事件在 Node 里是**抛异常**。
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    }
  });
}

/**
 * 把一次执行读成判定。
 *
 * 三个有定义的结果：`exit 0`（silent / say）、`exit 2`（block）。
 * 其余一切 —— 别的退出码、超时、起不来、判定值读不出来 —— **一律 fail**。
 * 这条方向不能反：一个坏掉的钩子必须让动作停下来，不能让它悄悄通过（设计 §7）。
 */
export function classify(result: HookRun): HookVerdict {
  if (result.failure !== undefined) return { kind: 'fail', reason: result.failure };
  if (result.exitCode === 2) {
    const reason = result.stderr.trim();
    return { kind: 'block', reason: reason === '' ? '钩子以退出码 2 拦下，但没有给出理由' : reason };
  }
  if (result.exitCode !== 0) {
    return { kind: 'fail', reason: `钩子以退出码 ${result.exitCode} 结束（只有 0 与 2 是有定义的结果）` };
  }

  // exit 0：stdout 可能是纯文本，也可能是带判定的 JSON。读不出来就当它没意见 ——
  // 纯文本本来就是这样用的（往转录里写一行说明）。
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { kind: 'silent' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'silent' };

  const record = parsed as Record<string, unknown>;
  const inner = record.hookSpecificOutput;
  const holder =
    typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : record;
  const decision = holder.permissionDecision ?? record.permissionDecision;
  if (decision === undefined) return { kind: 'silent' };

  if (typeof decision !== 'string' || !DECISIONS.has(decision)) {
    // 说不认识的话 ≠ 没意见。读不出来就 deny —— 与"退出码只认 0 与 2"同一条方向。
    return { kind: 'fail', reason: `钩子给的判定读不出来：${JSON.stringify(decision)}` };
  }

  const rawReason = holder.permissionDecisionReason ?? record.permissionDecisionReason;
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason : undefined;
  return { kind: 'say', decision: decision as 'allow' | 'ask' | 'deny', reason };
}
