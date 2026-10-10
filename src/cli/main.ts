import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import { CORE_ORIGIN } from '../contract/next';
import { createEngine } from '../core/create';
import { runTurn } from '../core/loop';
import { createAnthropicProvider } from '../providers/anthropic';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { createPromptSink } from './prompt';
import { createRenderer } from './render';
import { startRepl } from './repl';

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
  const args = process.argv.slice(2);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('缺少 ANTHROPIC_API_KEY 环境变量。\n');
    process.exitCode = 1;
    return;
  }

  const root = resolve(process.cwd());
  const home = process.env.USERPROFILE ?? process.env.HOME ?? root;
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  });

  const render = createRenderer();
  // readline 全进程只建这一次：REPL 的行输入与工具确认提示共用同一个实例。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const prompt = createPromptSink(rl);
  const provider = createAnthropicProvider({
    apiKey,
    model: process.env.DEEPCODE_MODEL ?? 'claude-sonnet-4-5',
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });

  const { $, dispatch } = await createEngine({
    plugins: [...coreTools, confirmPlugin, commandsPlugin],
    provider,
    ui: { print: render.print, notice: render.notice, ask: prompt.ask },
    sessionInfo: { id: String(Date.now()), cwd: root, root },
    env: process.env,
    signal: controller.signal,
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  const instructions = await loadInstructions(root, home);
  const systemPrompt = instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT;

  const oneShot = args.join(' ').trim();

  if (oneShot) {
    // 一次性模式：`deepcode "改一下 X"`
    const messages: Message[] = [{ role: 'user', content: oneShot }];
    await runTurn(
      { $, provider, signal: controller.signal, dispatch, systemPrompt, turnIndex: 0 },
      messages,
    );
    render.newline();
  } else {
    await startRepl({ $, dispatch, render, rl, systemPrompt, signal: controller.signal });
  }

  await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
  prompt.close();
}

main().catch((error) => {
  process.stderr.write(`启动失败：${String(error)}\n`);
  process.exitCode = 1;
});
