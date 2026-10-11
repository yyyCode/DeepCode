import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message, ToolSpec } from '../contract/model-provider';
import type { TurnReason } from '../contract/turn';
import { CORE_ORIGIN } from '../contract/next';
import { withContext } from '../contract/prompt-channel';
import { createEngine } from '../core/create';
import { runTurn } from '../core/loop';
import { listTools } from '../core/tool-list';
import { createProvider } from '../providers';
import { cliPlugins } from './plugins';
import { builtinMods, describeMods, loadMods, paneUnavailable } from './mods';
import { formatPane } from './diff-render';
import { createPromptSink } from './prompt';
import { HELP_TEXT, parseArgs, readVersion } from './args';
import { createPalette } from './ansi';
import { banner, shouldShowBanner } from './banner';
import { createSessionChanges } from './changes';
import { exitLines } from './tally';
import { createCompleter, createLineQueue } from './input';
import { HISTORY_LIMIT, loadHistory } from './history';
// 只是类型：`/help` 那个延迟取的位置要它（见下面 commandDescriber）。
import type { CommandDescription } from './commands';
import { applyManagedGateway, loadConfig, resolveSettings } from './config';
import { createRenderer } from './render';
import { startRepl } from './repl';
import { createCompactor, type Compactor } from './compact';
import { createPromptBuilder } from './system-prompt';
import { contextReport } from './context-view';
import { resolvePolicy } from './settings';
import { discoverPlugins, loadPlugins } from './plugin-dir';
import { discoverAgents } from './agents';
import { discoverSkills } from './skills';
import { runPluginCommand } from './plugin-command';
import { runConfigCommand } from './config-cli';
import {
  createPersister,
  createTranscript,
  findTranscript,
  listTranscripts,
  sessionsDir,
  type Transcript,
} from './transcript';
import { createTurnSignals } from './turns';

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
      // 落点只认**用户层**的设置（设计 §0 决策 3）—— 与下面 discoverPlugins 的
      // `enabledInstalled` 是同一份名单，两个入口必须一致。
      enabledByUser: pluginPolicy.plugins.enableByUser,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  // `deepcode config list / set`：同样在"读配置、要 key"**之前**。
  // 它读配置是为了看/改配置本身，没有理由先要一把 key —— 而"我现在配的是什么"
  // 恰恰是配错了 key 的人最想敲的一句话。
  if (action.kind === 'config') {
    process.exitCode = await runConfigCommand({
      action,
      home,
      root,
      env: process.env,
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
  const { apiKey, debug, provider } = settings;
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
  /**
   * 一条给人看的警告。**所有**这类出口都走它，而不是直接写 `process.stderr` ——
   * stderr 与 stdout 在终端里是同一块屏幕，而活动区（P6a）是一块被借走、随时会被
   * 重画的区域。绕过渲染器写出去的每一个字节都可能糊在那半行小圆圈后面。
   */
  const warnLine = (line: string): void => render.notice(line);

  // 托管层把出网位置钉死（P5d）。放在 `resolvePolicy` 之后、建引擎之前 ——
  // 这块内容只有读设置时才存在，而引擎一建就拿着 `baseUrl` 了。
  // 个人配置能改"发给谁"（apiKey），"发给哪"是组织的事：与 sandbox 白名单、托管指令同一条。
  const gateway = applyManagedGateway(settings, policy.gateway);
  const { model, baseUrl } = gateway.config;
  if (gateway.pinned.length > 0) {
    // **必须看得见** —— 与托管指令、托管遥测同一条：一条被悄悄改掉的端点，
    // 会让人对着 401 查半天，而真正发生的事是"你的请求根本没发去你以为的地方"。
    render.notice(`⚠️ 托管策略钉住了出网位置：${gateway.pinned.join('、')}（个人配置改不动）。`);
  }
  // ── 输入面（P6d）──
  // 历史先读出来：readline 要它在建实例时就给（`history` / `historySize` 两个选项）。
  // 交出去的是那个数组**本身**，readline 就地往里加，退出时存的与上键翻的是同一份。
  const history = await loadHistory(home, warnLine);
  // 补全：命令名册要等 `createEngine` 之后才拿得到（`$.command.list()`），
  // 而 completer 必须在建实例时就给 —— 所以这里又是一个延迟取的位置，
  // 与 compactor / commandDescriber 同一种写法。
  let lookupCommands: () => readonly string[] = () => [];
  const completer = createCompleter({ commands: () => lookupCommands(), cwd: root });

  // readline 全进程只建这一次：REPL 的行输入与工具确认提示共用同一个实例。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    completer,
    history: history.entries,
    historySize: HISTORY_LIMIT,
  });
  // ⚠️ 行队列**必须**在 rl 建好之后立刻挂上。从这一刻到 REPL 开始读之间有一大段 await
  // （读设置、建转录、发现插件），管道里的输入落在那段空窗里就会被 readline 丢掉
  // —— `echo '/diff' | deepcode` 当时什么都不做，行队列就是为这个空窗建的（P6d）。
  const lines = createLineQueue(rl);
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
    warn: warnLine,
  });
  const thirdParty = await loadPlugins(found.loaded, {
    projectDir: root,
    session: { id: sessionId, transcriptPath: transcript?.path },
    env: process.env,
    warn: warnLine,
  });

  // ── 名册 ──
  // 发现是异步的、装配是同步的（`cliPlugins` 是同步函数），所以发现放在这儿：
  // 结果是两张**已经解析好**的名册，以参数进 `cliPlugins`（设计 §4.1）。
  // 只有判为 `loaded` 的插件贡献名册 —— 被 deny 的、项目级没 enable 的、清单坏掉的，
  // 它们的 agent 也不该出现。
  const pluginDirs = found.loaded.map((plugin) => ({ name: plugin.name, dir: plugin.dir }));
  const agents = await discoverAgents({ root, home, plugins: pluginDirs, warn: warnLine });
  const skills = await discoverSkills({ root, home, plugins: pluginDirs, warn: warnLine });

  // 压缩器要到 `createEngine` **之后**才建得出来（它需要 `dispatch`），而 `/compact`
  // 这条命令在 `cliPlugins` 里注册 —— 所以这里先留一个延迟取的位置，
  // 与 core/nouns 里那两个 `refs` 同一种写法。
  let compactor: Compactor | undefined;

  // 同一个道理：`/help` 要派发 `command.describe` 才打得出每条命令的一句话，
  // 而插件拿不到 dispatch（`contract/engine.ts:59-64`）。CLI 有 `dispatch`，
  // 但那是 `createEngine` 的返回值 —— 所以又是一个延迟取的位置。
  let commandDescriber: ((name: string) => Promise<CommandDescription>) | undefined;

  // ⚠️ 模型这一轮**真的带出去**的那份工具清单（P9 §3.2）。由 `runTurn` 的 `onTools` 报回来，
  // 不是 `/context` 现算的 —— 账本报的必须与真正的请求可比，否则它那条"账要对得上"
  // 还是做不到（实测：漏掉工具那一份时，账本报 11 token，真实请求约 448）。
  // 与 `compactor` 同一种写法：`cliPlugins` 的闭包先占位，`createEngine` 之后才填得上。
  let lastTools: readonly ToolSpec[] | undefined;

  const providerAdapter = createProvider({ provider, apiKey, model, baseUrl });
  // 引擎与插件看到的是**同一份** env —— 分开算两次，`config.describe` 报出来的来源
  // 就可能与 `resolveSettings` 实际用的不是一回事（`DEEPCODE_DEBUG` 那条尤其）。
  const engineEnv = debug ? { ...process.env, DEEPCODE_DEBUG: '1' } : process.env;

  // 内建 mod：`loadMods` 自己不认识任何一个 mod（清单是参数），于是"缺依赖会怎样"
  // 这条路是**被测试覆盖的**而不是靠人记得。降级必须看得见 —— 下面这几行就是那个出口。
  const { plugins: modPlugins, report } = await loadMods(
    {
      root,
      home,
      sessionId,
      warn: warnLine,
      telemetry: policy.telemetry,
      policyRules: policy.policyRules,
      managedInstructions: policy.instructions,
    },
    // 渲染器从这儿注入：`Palette` 与 `changes` 都住在这边，而 mod 不许认识它们
    // （`mods/diff/index.ts` 顶部那段）。`changes.list()` 每次现取，快照会过期。
    builtinMods((model) => formatPane(model, palette, changes.list(), root)),
  );
  for (const line of describeMods(report)) warnLine(line);
  // ⚠️ `/diff` 的应答者由内建 mod `diff` 与 CLI **二选一**。这一行就是那个开关：
  // 装了 mod 就 CLI 不注册，没装（这台机器没有 git）就 CLI 接管并说出原因。
  const paneMiss = paneUnavailable(report);

  const bundle = cliPlugins({
    render,
    changes,
    messages,
    root,
    palette,
    env: engineEnv,
    policy,
    home,
    // 与 `session.start` 派发出去的那个是同一个（上面 `transcript?.id ?? Date.now()`）。
    sessionId,
    warn: warnLine,
    agents,
    skills,
    // 基础那份，不是拼完那份 —— 拼完那份里含着下面这节清单（见 offer.ts 的注释）。
    baseSystemPrompt: SYSTEM_PROMPT,
    mods: modPlugins,
    paneLoaded: paneMiss === undefined,
    ...(paneMiss === undefined ? {} : { paneUnavailable: paneMiss }),
    discovered: thirdParty,
    pluginDeny: policy.plugins.deny,
    compact: async (instructions) => {
      await compactor?.run('manual', instructions);
    },
    // 账本现算：系统提示那一节要**最近一次建出来的**那份（下面 `builder`），
    // 压缩阈值与"上次实测"分别来自 `policy` 与压缩器 —— 四样都在 CLI 手里。
    // ⚠️ `builder` 在**下面**建（它要 `dispatch`），而这个闭包只在有人敲 `/context`
    // 时才跑，那时它早就有了（与 `compactor` 同一个生命周期）。
    context: () =>
      contextReport({
        pieces: builder.last()?.pieces,
        // 三样都是"最近一次真的发生的事"：系统提示取最近一次建出来的分节，
        // 工具清单取最近一次发出去的那一份，消息就是手里这个数组。
        tools: lastTools,
        messages,
        compact: policy.compact,
        lastUsage: compactor?.usage(),
      }),
    // `/tools` 与 `/help` 的工具那一行共用它 —— 与 `describeCommand` 同一个延迟取的位置，
    // 同一条理由（要 `dispatch`，而插件拿不到）。
    toolListing: async () => await listTools({ $, dispatch }),
    reseed: (length) => persist.reseed(length),
    describeCommand: async (name) => await commandDescriber?.(name) ?? { kind: 'missing' },
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
    env: engineEnv,
    // 沙箱：五层设置里读出来的规则 + `~` 展开用的 home。省略 = 没有闸。
    sandbox: { config: policy.sandbox, home },
    signal: () => turns.current(),
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  // 系统提示的**每轮重算**（P7 §3.2）。理由与代价写在 `cli/system-prompt.ts` 顶部；
  // 它要 `dispatch`，所以只能在这儿建 —— 与压缩器同一个道理。
  const builder = createPromptBuilder({ base: SYSTEM_PROMPT, dispatch });

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

  // 有了 `dispatch`，`$` 就是真的了 —— 补全那个延迟取的位置也填得上。
  // 名单**现取**（`$.command.list()`），不另抄一份：抄的那份迟早落后。
  lookupCommands = () => $.command.list();

  // 有了 `dispatch`，`/help` 那个延迟取的位置也就填得上了。
  commandDescriber = async (name) => {
    try {
      const described = await dispatch('command.describe', { name }, CORE_ORIGIN);
      return 'hidden' in described
        ? { kind: 'hidden' }
        : {
            kind: 'described',
            description: described.description,
            ...(described.usage === undefined ? {} : { usage: described.usage }),
          };
    } catch {
      // core 那条 impl **抛** —— "没注册描述"是故障不是"没描述"（与 tool.describe 同形）。
      // 在这里译成一个正常返回值，好让 `/help` 能一边列名字一边提醒一声。
      return { kind: 'missing' };
    }
  };

  // 系统提示不在这里拼了（P7 §3.2）：`builder` 每轮重算一次，理由与那两个使用点
  // 见下面。这一段原来是三行拼接（base + `prompt.section` + 清单），搬进了
  // `cli/system-prompt.ts` —— 拼法一个字没变，变的是**多久拼一次**。
  const oneShot = action.text;

  /**
   * 是不是真的有人在敲。REPL 与开场那一屏共用这一个判断（只算一次，
   * 两处各算一遍迟早会不一致）。管道、CI、`deepcode "…"` 都不是交互 ——
   * 那时**不画开场白**：管道那头没有人在等，多几行就是把脚本的输出弄脏。
   */
  const interactive = Boolean(process.stdin.isTTY);

  // 开场那一屏（P6d 的收尾）。放在这儿：会话与 mods 的降级提醒都已经出完，
  // 它是最后一条"开始之前"的信息，紧跟着就是提示符。
  // 判据在 `shouldShowBanner` 里 —— `oneShot` 是**空串**不是 `undefined`
  // （`parseArgs` 给的就是 `rest.join(' ').trim()`），写错这一处会让整屏字消失。
  if (shouldShowBanner(oneShot, interactive)) {
    for (const line of banner(
      {
        version: readVersion(),
        model,
        provider,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        root,
        ...(transcript === undefined ? {} : { sessionId: transcript.id }),
      },
      palette,
    )) {
      // 走渲染器而不是直接写 stdout：活动区是一块随时会被重画的区域，
      // 绕过它的每一个字节都可能糊在那半行小圆圈后面（`warnLine` 踩过这个坑）。
      render.print(line);
    }
  }

  if (oneShot) {
    // 一次性模式：`deepcode "改一下 X"`
    // 只采纳 `context`，**忽略 `handled`**：那个字段的语义是"这一行输入被吃掉了，
    // 别送给模型"，而一次性模式没有可以"继续"的交互循环 —— 把它当真会得到一个
    // 静默什么都没做、退出码 0 的调用（设计 §8 偏差 9）。
    const submitted = await dispatch('prompt.submit', { text: oneShot }, CORE_ORIGIN);
    messages.push({ role: 'user', content: withContext(oneShot, submitted.context) });
    const signal = turns.begin();
    // 初值取不到（`runTurn` 一抛错就整个抛出去，下面那两行根本轮不上），写它是为了让
    // 这个变量一开始就站在**轮级**那一层 —— 它下面只有白名单一种判据，初值不该是个
    // 端点串（P8 之前这里写的是 `'end_turn'`）。
    let reason: TurnReason = 'error';
    render.thinking();
    try {
      reason = await runTurn(
        // 一次性模式也现算一份：它就是"这一轮"，没有第二轮的余地。
        { $, provider: providerAdapter, signal, dispatch, systemPrompt: (await builder.build()).text, turnIndex: 0 },
        messages,
      );
    } finally {
      turns.end();
      render.newline();
    }
    await persist(messages);
    // 一次性模式要能进脚本：这一趟失败或被中断就是非零退出码，
    // 否则 `deepcode "..." && 下一步` 会带着错误悄悄往下走。
    //
    // ⚠️ **白名单**：除 `answer` 之外一律非零，不再逐个列（P8 设计 §3.5）。
    // 列黑名单的下场已经有过一次：旧写法只认 error / interrupted / max_hops，
    // 于是被长度上限**截断**的那一趟（`truncated`）带着半截结果、以退出码 0 走掉了。
    // 写成白名单以后，将来多一种收场方式时它**默认**是非零 —— 要让脚本继续往下走，
    // 得专门说明理由。
    if (reason === 'interrupted') process.exitCode = 130;
    else if (reason !== 'answer') process.exitCode = 1;
  } else {
    await startRepl({
      $,
      dispatch,
      render,
      rl,
      lines,
      palette,
      interactive,
      // 每一轮现算一次（P7 §3.2）：会话中改 `AGENTS.md` 当场生效，压缩之后注入面
      // 也重新求值 —— 后者正是"压缩后重新装载约定"那条能成立的前提。
      systemPrompt: async () => (await builder.build()).text,
      turns,
      messages,
      persist,
      onUsage: (usage) => compactor?.note(usage),
      // 账本吃的那一份（见上面 `lastTools` 那段）。
      onTools: (specs) => {
        lastTools = specs;
      },
      afterTurn: async () => {
        await compactor?.afterTurn();
      },
    });
  }

  // 历史落盘（P6d）。**在退出摘要之前** —— 它自己可能喊一声"没写进去"，
  // 而那一屏是最后要在屏幕上留住的东西。放摘要后面的话，那声警告会跑到它下面去。
  await history.save();

  // 退出那一屏（P6c）：干了多少、改了哪些、转录在哪儿。
  //
  // 三个数字来自**同一本账**：`bundle.tally`（每轮摘要也读它）与 `changes`（`/diff` 读它）。
  // 各算一份的话，屏幕上那行迟早与 `/diff` 对不上。
  //
  // `settle` 而不是 `print`：它要先抹掉活动区再落这几行。非 TTY 下 settle 是 no-op ——
  // 于是管道里这一屏**一个字节都不产出**，与 P6a 之前逐字节相同（render.ts 顶部那条纪律）。
  render.settle(
    exitLines(bundle.tally, changes.list(), palette, {
      root,
      ...(transcript === undefined ? {} : { transcriptPath: transcript.path }),
    }),
  );

  await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
  prompt.close();
}

main().catch((error) => {
  // 取 message 而不是整个 Error：String(error) 会带上 "Error: " 前缀，
  // 配着下面那句"启动失败"读起来就是"启动失败：Error: ..."。
  process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
