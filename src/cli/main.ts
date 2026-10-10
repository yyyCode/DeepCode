import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import { CORE_ORIGIN } from '../contract/next';
import { createEngine } from '../core/create';
import { runTurn } from '../core/loop';
import { createAnthropicProvider } from '../providers/anthropic';
import { cliPlugins } from './plugins';
import { createPromptSink } from './prompt';
import { HELP_TEXT, parseArgs, readVersion } from './args';
import { loadConfig, resolveSettings } from './config';
import { createRenderer } from './render';
import { startRepl } from './repl';
import { createTurnSignals } from './turns';

/** 项目指令文件。MVP 只看两层：项目与用户。嵌套懒加载是 P4 的事。 */
async function loadInstructions(root: string, home: string): Promise<string> {
  const parts: string[] = [];
  for (const file of [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'), join(home, '.deepcode', 'AGENTS.md')]) {
    if (existsSync(file)) {
      parts.push(`Contents of ${file}:\n\n${await readFile(file, 'utf8')}`);
    }
  }
  return parts.join('\n\n');
}

const SYSTEM_PROMPT = `你是 DeepCode，一个在用户终端里工作的编码助手。

工作方式：
- 需要看代码就用 Read / Glob / Grep，不要凭空猜文件内容。
- 改文件用 Edit（精确替换）或 Write（整体重写）；Write 覆盖已有文件前必须先 Read 过它。
- 需要跑测试、构建、git 就在 Bash 里跑。
- 工具失败会以 ERROR: 开头返回给你，那是信息不是崩溃 —— 读它、改方案、再试。

回答保持简短，说清楚你改了什么、为什么。`;

async function main(): Promise<void> {
  // 开关先处理，而且要在读配置、要 key 之前 —— `deepcode --help` 在没有 key 的机器上
  // 也该给出用法，而不是甩一句"缺少 API key"。
  const action = parseArgs(process.argv.slice(2));
  if (action.kind === 'help') {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (action.kind === 'version') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const root = resolve(process.cwd());
  const home = process.env.USERPROFILE ?? process.env.HOME ?? root;

  // 配置来源优先级：环境变量 > 项目级 > 用户级（见 cli/config.ts 的 resolveSettings）。
  const config = await loadConfig({ home, root });
  const userConfigPath = join(home, '.deepcode', 'config.json');
  const projectConfigPath = join(root, '.deepcode', 'config.json');

  const { apiKey, model, baseUrl, debug } = resolveSettings(process.env, config, (line) =>
    process.stderr.write(`${line}\n`),
  );
  if (!apiKey) {
    process.stderr.write(
      '缺少 API key。几种给法，优先级从高到低：\n' +
        '  1. 环境变量 ANTHROPIC_API_KEY=sk-ant-...（兼容端点也可以给 ANTHROPIC_AUTH_TOKEN）\n' +
        `  2. 项目级配置 ${projectConfigPath}，内容 {"apiKey": "sk-ant-..."}\n` +
        `  3. 用户级配置 ${userConfigPath}，内容同上\n`,
    );
    process.exitCode = 1;
    return;
  }

  const turns = createTurnSignals();
  const render = createRenderer();
  // readline 全进程只建这一次：REPL 的行输入与工具确认提示共用同一个实例。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  // 两条路都要挂：一次性模式下没有 readline 在转，而 REPL 里 Ctrl-C 是 readline
  // 先接住再抛出来的。onSigint 自带去重，重复收到一次不会误判成"连按两次"。
  process.on('SIGINT', turns.onSigint);
  rl.on('SIGINT', turns.onSigint);

  const prompt = createPromptSink(rl, { signalOf: () => turns.current() });
  const provider = createAnthropicProvider({ apiKey, model, baseUrl });

  const { $, dispatch } = await createEngine({
    // 清单见 cli/plugins.ts —— 其中 streamPlugin 是模型文本的出口。
    plugins: cliPlugins(render),
    provider,
    ui: { print: render.print, notice: render.notice, ask: prompt.ask },
    sessionInfo: { id: String(Date.now()), cwd: root, root },
    env: debug ? { ...process.env, DEEPCODE_DEBUG: '1' } : process.env,
    signal: () => turns.current(),
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  const instructions = await loadInstructions(root, home);
  const systemPrompt = instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT;

  const oneShot = action.text;

  if (oneShot) {
    // 一次性模式：`deepcode "改一下 X"`
    const messages: Message[] = [{ role: 'user', content: oneShot }];
    const signal = turns.begin();
    let reason = 'end_turn';
    try {
      reason = await runTurn(
        { $, provider, signal, dispatch, systemPrompt, turnIndex: 0 },
        messages,
      );
    } finally {
      turns.end();
    }
    render.newline();
    // 一次性模式要能进脚本：这一趟失败或被中断就是非零退出码，
    // 否则 `deepcode "..." && 下一步` 会带着错误悄悄往下走。
    if (reason === 'error') process.exitCode = 1;
    else if (reason === 'interrupted') process.exitCode = 130;
  } else {
    await startRepl({ $, dispatch, render, rl, systemPrompt, turns });
  }

  await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
  prompt.close();
}

main().catch((error) => {
  // 取 message 而不是整个 Error：String(error) 会带上 "Error: " 前缀，
  // 配着下面那句"启动失败"读起来就是"启动失败：Error: ..."。
  process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
