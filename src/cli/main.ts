import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../contract/model-provider';
import { CORE_ORIGIN } from '../contract/next';
import { createEngine } from '../core/create';
import { runTurn } from '../core/loop';
import { createProvider } from '../providers';
import { cliPlugins } from './plugins';
import { createPromptSink } from './prompt';
import { HELP_TEXT, parseArgs, readVersion } from './args';
import { createPalette } from './ansi';
import { createSessionChanges } from './changes';
import { loadConfig, resolveSettings } from './config';
import { createRenderer } from './render';
import { startRepl } from './repl';
import { createCompactor, type Compactor } from './compact';
import { resolvePolicy } from './settings';
import { discoverPlugins, loadPlugins } from './plugin-dir';
import { discoverAgents } from './agents';
import { discoverSkills } from './skills';
import { renderOffer } from './offer';
import { runPluginCommand } from './plugin-command';
import {
  createPersister,
  createTranscript,
  findTranscript,
  listTranscripts,
  sessionsDir,
  type Transcript,
} from './transcript';
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

/**
 * `--resume` 找不到会话时的说明。刻意把"找的是哪个目录"写进去并列出能接的 ——
 * 只说一句"没找到"会让人去猜路径（slug 分桶把会话藏在按 cwd 编的目录里）。
 */
async function describeResumeFailure(home: string, cwd: string, id: string | undefined): Promise<string> {
  const all = await listTranscripts(home, cwd);
  const where = `（找的是 ${sessionsDir(home, cwd)}）`;
  if (all.length === 0) {
    return id === undefined
      ? `这个目录还没有可以接上的会话${where}。\n`
      : `找不到会话 ${id}。这个目录下没有任何可以接上的会话${where}。\n`;
  }
  const ids = all.map((t) => `  ${t.id}  ${new Date(t.header.startedAt).toLocaleString()}`).join('\n');
  return `找不到可以接上的会话${id === undefined ? '' : ` ${id}`}${where}。可以接的有：\n${ids}\n`;
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

  // 子命令在**读配置、要 key 之前**处理：`deepcode plugin validate ./x` 在没有 key 的
  // 机器上也是条正经命令，不该被一句"缺少 API key"挡回去（与 --help 同一条道理）。
  if (action.kind === 'plugin') {
    // 这个分支不认 `--settings=`（它只在 prompt 变体上）—— 托管路径照旧生效，
    // 因为插件名单的 deny 侧必须包括托管层。
    const pluginPolicy = await resolvePolicy({
      home,
      root,
      managedPath: process.env.DEEPCODE_MANAGED_SETTINGS,
      warn: (line) => process.stderr.write(`${line}\n`),
    });
    process.exitCode = await runPluginCommand({
      action,
      home,
      root,
      enabled: pluginPolicy.plugins.enable.map((rule) => rule.name),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  // 配置来源优先级：环境变量 > 项目级 > 用户级（见 cli/config.ts 的 resolveSettings）。
  const config = await loadConfig({ home, root });
  const userConfigPath = join(home, '.deepcode', 'config.json');
  const projectConfigPath = join(root, '.deepcode', 'config.json');

  const settings = resolveSettings(process.env, config, (line) => process.stderr.write(`${line}\n`));
  const { apiKey, model, baseUrl, debug, provider } = settings;
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

  // 权限设置与连接配置是两套：config.json 管连接（环境变量 > 项目级 > 用户级），
  // settings.json 管权限（user < project < local < flag < policy，**刻意没有环境变量层**）。
  // 放在"缺 key"之后：没 key 就该报缺 key，轮不到读权限文件。
  const policy = await resolvePolicy({
    home,
    root,
    settingsPath: action.settings,
    managedPath: process.env.DEEPCODE_MANAGED_SETTINGS,
    warn: (line) => process.stderr.write(`${line}\n`),
  });

  const turns = createTurnSignals();
  const palette = createPalette();
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

  const prompt = createPromptSink(rl, {
    signalOf: () => turns.current(),
    palette,
    // 确认提示落笔前停 spinner（否则"思考中"粘在提示符前面）。
    beforeAsk: () => render.newline(),
  });

  // messages 只建这一份：同时交给 REPL（经 startRepl）与 /clear（经 cliPlugins）——
  // 同一个数组引用，/clear 才清得动 REPL 手里的历史。
  const messages: Message[] = [];
  const changes = createSessionChanges();

  // ── 会话落盘 / 接上旧会话 ──
  // 顺序：这段在"缺 key 报错"**之后**（没 key 就该报缺 key，轮不到找会话），
  // 又在建引擎**之前**（接上历史要先进 messages，引擎装载时就带着它）。
  // 落盘失败不能拖垮产品：~/.deepcode 只读、磁盘满，都与"能不能干活"无关（设计 §2.5）。
  let transcript: Transcript | undefined;
  let alreadySaved = 0;
  if (action.resume.kind !== 'none') {
    const wanted = action.resume.kind === 'id' ? action.resume.id : undefined;
    const found = await findTranscript({ home, cwd: root, id: wanted });
    if (!found) {
      process.stderr.write(await describeResumeFailure(home, root, wanted));
      process.exitCode = 1;
      // 必须关掉 readline：它是这个进程里唯一把事件循环吊住的东西，
      // 不关的话 `deepcode --resume`（真终端里也一样）报完错会挂在那儿等输入，
      // 而不是退出。（计划示意里漏了这一步。）
      prompt.close();
      return;
    }
    transcript = found.transcript;
    messages.push(...found.messages);
    alreadySaved = messages.length; // 这几条已经在盘上了，别再写一遍。
    render.notice(`已接上会话 ${found.transcript.id}（${found.messages.length} 条消息）。`);
  } else {
    try {
      transcript = await createTranscript({ home, cwd: root, model, provider });
    } catch (error) {
      // 降级继续跑：没有转录就是个少了便利的会话，不是开不了工。
      render.notice(`会话不会落盘（建不了转录文件：${String(error)}），这次 --resume 用不了。`);
    }
  }
  const persist = createPersister(transcript, alreadySaved, (line) => render.notice(line));

  // 会话 id 在这里先算出来：插件钩子的 stdin 里要有它，而 createEngine 里也要有它 ——
  // 两处各写一遍 `?? String(Date.now())` 的话，那两次 Date.now() 可以差一毫秒，
  // 于是一个会话会有两个 id。
  const sessionId = transcript?.id ?? String(Date.now());

  // ── 插件目录 ──
  // 发现（只读清单）与装载（import 入口）分两步：`plugin list` / `validate` 只做前者。
  // 这一条线是"看一眼"与"让它跑"的分界。
  const found = await discoverPlugins({
    home,
    root,
    enabled: policy.plugins.enable.map((rule) => rule.name),
    // 落点只认用户层的名单 —— 与上面那行**不是同一个东西**，别合并（设计 §0 决策 3）。
    enabledInstalled: policy.plugins.enableByUser,
    warn: (line) => process.stderr.write(`${line}\n`),
  });
  const thirdParty = await loadPlugins(found.loaded, {
    projectDir: root,
    session: { id: sessionId, transcriptPath: transcript?.path },
    env: process.env,
    warn: (line) => process.stderr.write(`${line}\n`),
  });

  // ── 名册 ──
  // 发现是异步的、装配是同步的（`cliPlugins` 是同步函数），所以发现放在这儿：
  // 结果是两张**已经解析好**的名册，以参数进 `cliPlugins`（设计 §4.1）。
  // 只有判为 `loaded` 的插件贡献名册 —— 被 deny 的、项目级没 enable 的、清单坏掉的，
  // 它们的 agent 也不该出现。
  const warnLine = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const pluginDirs = found.loaded.map((plugin) => ({ name: plugin.name, dir: plugin.dir }));
  const agents = await discoverAgents({ root, home, plugins: pluginDirs, warn: warnLine });
  const skills = await discoverSkills({ root, home, plugins: pluginDirs, warn: warnLine });

  // 压缩器要到 `createEngine` **之后**才建得出来（它需要 `dispatch`），而 `/compact`
  // 这条命令在 `cliPlugins` 里注册 —— 所以这里先留一个延迟取的位置，
  // 与 core/nouns 里那两个 `refs` 同一种写法。
  let compactor: Compactor | undefined;

  const providerAdapter = createProvider({ provider, apiKey, model, baseUrl });
  const bundle = cliPlugins({
    render,
    changes,
    messages,
    root,
    palette,
    policy,
    home,
    agents,
    skills,
    // 基础那份，不是拼完那份 —— 拼完那份里含着下面这节清单（见 offer.ts 的注释）。
    baseSystemPrompt: SYSTEM_PROMPT,
    discovered: thirdParty,
    pluginDeny: policy.plugins.deny,
    compact: async () => {
      await compactor?.run('manual');
    },
  });
  const { $, dispatch } = await createEngine({
    // 清单见 cli/plugins.ts —— 其中 streamPlugin 是模型文本的出口。
    plugins: bundle.plugins,
    // 座位由 CLI 钉，引擎不认插件自述的权威。
    seating: bundle.seating,
    // 第三方插件的名字：引擎据此把它们的座位**强制**成 append，并给它们一块包装过的 `on`。
    thirdParty: bundle.thirdParty,
    provider: providerAdapter,
    ui: { print: render.print, notice: render.notice, ask: prompt.ask },
    sessionInfo: { id: sessionId, cwd: root, root },
    env: debug ? { ...process.env, DEEPCODE_DEBUG: '1' } : process.env,
    // 沙箱：五层设置里读出来的规则 + `~` 展开用的 home。省略 = 没有闸。
    sandbox: { config: policy.sandbox, home },
    signal: () => turns.current(),
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  // 压缩器：它要 messages / provider / dispatch / persist —— 四样这时候都齐了。
  compactor = createCompactor({
    messages,
    provider: providerAdapter,
    dispatch,
    persist,
    config: policy.compact,
    warn: (line) => render.notice(line),
    signal: () => turns.current(),
  });

  const instructions = await loadInstructions(root, home);
  // 能派什么、能加载什么，报给模型（设计 §7）。模型看到的是一行 description，不是文件。
  const offer = await dispatch('agent.offer', {}, CORE_ORIGIN);
  const systemPrompt = [SYSTEM_PROMPT, instructions ?? '', renderOffer(offer)]
    .filter((part) => part !== '')
    .join('\n\n');

  const oneShot = action.text;

  if (oneShot) {
    // 一次性模式：`deepcode "改一下 X"`
    messages.push({ role: 'user', content: oneShot });
    const signal = turns.begin();
    let reason = 'end_turn';
    render.thinking();
    try {
      reason = await runTurn(
        { $, provider: providerAdapter, signal, dispatch, systemPrompt, turnIndex: 0 },
        messages,
      );
    } finally {
      turns.end();
      render.newline();
    }
    await persist(messages);
    // 一次性模式要能进脚本：这一趟失败或被中断就是非零退出码，
    // 否则 `deepcode "..." && 下一步` 会带着错误悄悄往下走。
    if (reason === 'error') process.exitCode = 1;
    else if (reason === 'interrupted') process.exitCode = 130;
    // 撞上 hop 上限就是"这趟没做完"。与 error 一样是非零 —— 不能悄悄退 0。
    else if (reason === 'max_hops') process.exitCode = 1;
  } else {
    await startRepl({
      $,
      dispatch,
      render,
      rl,
      systemPrompt,
      turns,
      messages,
      persist,
      onUsage: (usage) => compactor?.note(usage),
      afterTurn: async () => {
        await compactor?.afterTurn();
      },
    });
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
