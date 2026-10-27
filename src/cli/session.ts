import { join } from 'node:path';
import type { LayerStats } from '../contract/context-window';
import type { EngineInterface } from '../contract/engine';
import type { Message, ToolSpec } from '../contract/model-provider';
import type { Plugin } from '../contract/plugin';
import type { TurnReason } from '../contract/turn';
import { CORE_ORIGIN } from '../contract/next';
import { withContext } from '../contract/prompt-channel';
import { createEngine } from '../core/create';
import type { DispatchFn } from '../core/dispatch';
import { runTurn } from '../core/loop';
import type { UiSink } from '../core/nouns/ui';
import { listTools } from '../core/tool-list';
import { createProvider } from '../providers';
import type { Palette } from './ansi';
import type { ResumeTarget } from './args';
import { createSessionChanges, type SessionChanges } from './changes';
import { cliPlugins, type CliPluginBundle } from './plugins';
import { builtinMods, describeMods, loadMods, paneUnavailable } from './mods';
import { formatPane } from './diff-render';
import type { CommandDescription } from './commands';
import { applyManagedGateway, loadConfig, resolveSettings } from './config';
import { createCompactor, type Compactor } from './compact';
import { createContextWindow } from './context-window';
import { createPromptBuilder } from './system-prompt';
import { STATIC_PROMPT_TEXT, type PromptEnvironment } from './prompt-text';
import { isGitRepo, platformLabel, shellName, todayLabel } from './environment';
import { contextReport } from './context-view';
import { resolvePolicy, type ResolvedPolicy } from './settings';
import { discoverPlugins, loadPlugins } from './plugin-dir';
import { startMcp } from './mcp-runtime';
import { createMcpPlugin } from './mcp-plugin';
import { discoverAgents } from './agents';
import { BUILTIN_AGENTS } from './builtin-agents';
import { discoverSkills } from './skills';
import {
  createPersister,
  createTranscript,
  findTranscript,
  listTranscripts,
  sessionsDir,
  type Transcript,
} from './transcript';
import type { Renderer } from './render';
import type { TurnSignals } from './turns';

/**
 * 一个会话的全部装配 —— 从 `main.ts` 抽出来的那一段（P17）。
 *
 * 为什么要抽：这一段（读配置 → 权限 → 插件 → MCP → 引擎 → 系统提示 → 压缩 → 落盘）
 * **一行都不认识终端**，却写在 `main()` 里。网页界面要的是同一个会话，只换掉界面那一层。
 *
 * 两条边界：
 * - 这里不建 readline、不读历史文件、不印 banner、不跑 REPL —— 那些是终端的事；
 * - 这里接 `UiSink` 与 `Renderer` 而不是 `process.stdout` —— 网页传自己的实现。
 */

export type SessionInfo = {
  readonly model: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
};

export type SubmitOptions = {
  /**
   * `prompt.submit` 说这一行被吃掉了（`handled`）时，还送不送给模型。
   * 默认 `true`（交互式语义）；一次性模式传 `false` —— 它没有可继续的循环，
   * 把 `handled` 当真会得到一个静默什么都没做的调用（设计 §8 偏差 9）。
   */
  readonly honorHandled?: boolean;
  /** 跑完之后要不要问压缩器（`/compact` 的自动那一路）。默认 `true`。 */
  readonly afterTurn?: boolean;
};

export type Session = {
  readonly $: EngineInterface;
  readonly dispatch: DispatchFn;
  /** 与 `/clear`、REPL、网页共用的那**一个**数组引用。 */
  readonly messages: Message[];
  readonly turns: TurnSignals;
  readonly bundle: CliPluginBundle;
  readonly changes: SessionChanges;
  readonly info: SessionInfo;
  readonly policy: ResolvedPolicy;
  /** 会话落盘器。REPL 的依赖表要它（给了 `submit` 之后实际不再用）。 */
  readonly persist: (messages: readonly Message[]) => Promise<void>;
  /** 系统提示工厂。同理，给 REPL 的依赖表占位。 */
  readonly builder: ReturnType<typeof createPromptBuilder>;
  /** 跑一轮。`handled` 表示这一行被吃掉了、没有跑 turn。 */
  submit(text: string, options?: SubmitOptions): Promise<TurnReason | 'handled'>;
  /** 跑一条 `/命令`。返回值 = 该不该退出（与 REPL 同义）。 */
  runCommand(name: string, args: readonly string[]): Promise<boolean>;
  /** `session.end` + MCP 关闭。幂等。 */
  close(): Promise<void>;
};

export type SessionDeps = {
  readonly home: string;
  readonly root: string;
  /** 生效环境变量的基线（CLI 传 `process.env`）。 */
  readonly env: Record<string, string | undefined>;
  readonly settingsPath: string | undefined;
  readonly resume: ResumeTarget;
  /** 引擎与插件问人/说话的那一面。 */
  readonly ui: UiSink;
  /** 终端渲染器或网页实现。 */
  readonly render: Renderer;
  readonly palette: Palette;
  /** 中断信号。由调用方建 —— 终端要在建 readline 之前就挂 SIGINT。 */
  readonly turns: TurnSignals;
  /**
   * 装配早期的警告（读连接配置、权限设置）。终端传 stderr；网页可以传界面那一面。
   * 省略 = 走 `render.notice`。
   */
  readonly warnEarly?: (line: string) => void;
  /**
   * 额外插件（P17：网页的事件插件）。**排在 `confirmPlugin` 之前** ——
   * 与 MCP 桥接同一条顺序约束，见 `cli/plugins.ts` 里那段注释。
   */
  readonly extraPlugins?: readonly Plugin[];
};

/** 启动期的失败：调用方打印 `message`、用 `exitCode` 退出。 */
export class SessionStartError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = 'SessionStartError';
  }
}

/**
 * `--resume` 找不到会话时的说明。刻意把"找的是哪个目录"写进去并列出能接的 ——
 * 只说一句"没找到"会让人去猜路径（slug 分桶把会话藏在按 cwd 编的目录里）。
 */
export async function describeResumeFailure(
  home: string,
  cwd: string,
  id: string | undefined,
): Promise<string> {
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

export async function createSession(deps: SessionDeps): Promise<Session> {
  const { home, root, env, ui, render } = deps;
  const turns = deps.turns;
  const warnEarly = deps.warnEarly ?? ((line: string) => render.notice(line));
  /**
   * 一条给人看的警告。**所有**这类出口都走它，而不是直接写 `process.stderr` ——
   * stderr 与 stdout 在终端里是同一块屏幕，而活动区（P6a）是一块被借走、随时会被
   * 重画的区域。绕过渲染器写出去的每一个字节都可能糊在那半行小圆圈后面。
   */
  const warnLine = (line: string): void => render.notice(line);

  // 配置来源优先级：环境变量 > 项目级 > 用户级（见 cli/config.ts 的 resolveSettings）。
  const config = await loadConfig({ home, root });
  const userConfigPath = join(home, '.deepcode', 'config.json');
  const projectConfigPath = join(root, '.deepcode', 'config.json');

  const settings = resolveSettings(env, config, warnEarly);
  const { apiKey, debug, provider } = settings;
  if (!apiKey) {
    throw new SessionStartError(
      '缺少 API key。几种给法，优先级从高到低：\n' +
        '  1. 环境变量 ANTHROPIC_API_KEY=sk-ant-...（兼容端点也可以给 ANTHROPIC_AUTH_TOKEN）\n' +
        `  2. 项目级配置 ${projectConfigPath}，内容 {"apiKey": "sk-ant-..."}\n` +
        `  3. 用户级配置 ${userConfigPath}，内容同上\n`,
    );
  }

  // 权限设置与连接配置是两套：config.json 管连接（环境变量 > 项目级 > 用户级），
  // settings.json 管权限（user < project < local < flag < policy，**刻意没有环境变量层**）。
  // 放在"缺 key"之后：没 key 就该报缺 key，轮不到读权限文件。
  const policy = await resolvePolicy({
    home,
    root,
    settingsPath: deps.settingsPath,
    managedPath: env.DEEPCODE_MANAGED_SETTINGS,
    env,
    warn: warnEarly,
  });

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
  if (deps.resume.kind !== 'none') {
    const wanted = deps.resume.kind === 'id' ? deps.resume.id : undefined;
    const found = await findTranscript({ home, cwd: root, id: wanted });
    if (!found) {
      throw new SessionStartError(await describeResumeFailure(home, root, wanted));
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
    env,
    warn: warnLine,
  });

  // ── 名册 ──
  // 发现是异步的、装配是同步的（`cliPlugins` 是同步函数），所以发现放在这儿：
  // 结果是两张**已经解析好**的名册，以参数进 `cliPlugins`（设计 §4.1）。
  // 只有判为 `loaded` 的插件贡献名册 —— 被 deny 的、项目级没 enable 的、清单坏掉的，
  // 它们的 agent 也不该出现。
  const pluginDirs = found.loaded.map((plugin) => ({ name: plugin.name, dir: plugin.dir }));
  const agents = await discoverAgents({
    root,
    home,
    plugins: pluginDirs,
    // 开箱类型优先级最低：同名文件赢，内置静默让位（见 discoverAgents 的注释）。
    builtins: BUILTIN_AGENTS,
    warn: warnLine,
  });
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
  // 五层压缩的最近一次投影统计（P11）。与 `lastTools` 同一种写法：闭包先占位，
  // 第一次真正发请求之后才填得上。
  let lastProjection: LayerStats | undefined;

  const providerAdapter = createProvider({ provider, apiKey, model, baseUrl });
  // 引擎与插件看到的是**同一份** env —— 分开算两次，`config.describe` 报出来的来源
  // 就可能与 `resolveSettings` 实际用的不是一回事（`DEEPCODE_DEBUG` 那条尤其）。
  const engineEnv = debug ? { ...env, DEEPCODE_DEBUG: '1' } : env;

  // ── MCP（P16）──
  // ⚠️ 连接必须在 `createEngine` **之前**完成：`tool.list()` 是注册面的快照，
  // 工具得在装配期就注册好。一台 server 起不来只影响它自己 —— 警告一条，会话照常。
  //
  // 用户级配置已在 `resolvePolicy` 里筛过（只有 user 层能启动进程）；这里只额外读
  // 已发现插件自己的 `.mcp.json`。`debug` 那条线直写 stderr：MCP 的调试行不进模型上下文。
  const mcp = await startMcp({
    home,
    root,
    env: engineEnv,
    userServers: policy.mcpServers,
    plugins: found.loaded,
    warn: warnLine,
    ...(debug ? { debug: (line: string) => process.stderr.write(`${line}\n`) } : {}),
  });
  // 兜底关闭：`close()` 正常走到 `session.end` 之后还有一次显式关闭；
  // 这条只在异常退出路径上兜住子进程。`close()` 幂等，且 SIGTERM 是同步发出的。
  process.once('exit', () => {
    void mcp.close();
  });

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
    builtinMods((paneModel) => formatPane(paneModel, deps.palette, changes.list(), root)),
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
    palette: deps.palette,
    env: engineEnv,
    policy,
    home,
    // 与 `session.start` 派发出去的那个是同一个（上面 `transcript?.id ?? Date.now()`）。
    sessionId,
    warn: warnLine,
    agents,
    skills,
    // 基础那份，不是拼完那份 —— 拼完那份里含着下面这节清单（见 offer.ts 的注释）。
    baseSystemPrompt: STATIC_PROMPT_TEXT,
    mods: modPlugins,
    paneLoaded: paneMiss === undefined,
    ...(paneMiss === undefined ? {} : { paneUnavailable: paneMiss }),
    discovered: thirdParty,
    mcp: createMcpPlugin(mcp),
    extraPlugins: deps.extraPlugins ?? [],
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
        layers: lastProjection,
        // 记忆的账由它自己记（扫描发生在 `prompt.section` 里），这里只取最近一次。
        memory: bundle.memory.stats(),
      }),
    // `/tools` 与 `/help` 的工具那一行共用它 —— 与 `describeCommand` 同一个延迟取的位置，
    // 同一条理由（要 `dispatch`，而插件拿不到）。
    toolListing: async () => await listTools({ $, dispatch }),
    reseed: (length) => persist.reseed(length),
    describeCommand: async (name) => (await commandDescriber?.(name)) ?? { kind: 'missing' },
  });
  const { $, dispatch } = await createEngine({
    // 清单见 cli/plugins.ts —— 其中 streamPlugin 是模型文本的出口。
    plugins: bundle.plugins,
    // 座位由 CLI 钉，引擎不认插件自述的权威。
    seating: bundle.seating,
    // 第三方插件的名字：引擎据此把它们的座位**强制**成 append，并给它们一块包装过的 `on`。
    thirdParty: bundle.thirdParty,
    provider: providerAdapter,
    ui: { print: render.print, notice: render.notice, ask: ui.ask },
    sessionInfo: { id: sessionId, cwd: root, root },
    env: engineEnv,
    // 沙箱：五层设置里读出来的规则 + `~` 展开用的 home。省略 = 没有闸。
    sandbox: { config: policy.sandbox, home },
    signal: () => turns.current(),
  });

  await dispatch('session.start', { sessionId: $.session.id(), cwd: root, root }, CORE_ORIGIN);

  // 系统提示的**每轮重算**（P7 §3.2）。理由与代价写在 `cli/system-prompt.ts` 顶部；
  // 它要 `dispatch`，所以只能在这儿建 —— 与压缩器同一个道理。
  //
  // 环境只探测一次（P13）：cwd / 模型在会话中不会变；Git 仓库状态一般也不会变。
  // 日期按启动那天记 —— 跨午夜的会话会老一天，这是刻意的取舍：每轮重算日期会让
  // 动态尾巴无谓地翻动，而"今天"差一天的代价远小于缓存失效。
  const environment: PromptEnvironment = {
    cwd: root,
    gitRepo: await isGitRepo(root),
    platform: platformLabel(),
    shell: shellName(),
    model,
    today: todayLabel(),
  };
  const builder = createPromptBuilder({ dispatch, environment: () => environment });

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

  // 五层压缩（P11）：第 1 层的落盘要 `$.fs` 与会话 id，第 2–4 层的投影要 provider。
  // 第 5 层仍然是上面那个 compactor —— 两个对象的分工写在 `cli/context-window.ts` 顶部。
  const contextWindow = createContextWindow({
    home,
    cwd: root,
    sessionId: $.session.id(),
    fs: $.fs,
    provider: providerAdapter,
    config: policy.compact,
    warn: (line) => render.notice(line),
  });

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

  let turnIndex = 0;

  const submit = async (
    text: string,
    options: SubmitOptions = {},
  ): Promise<TurnReason | 'handled'> => {
    // prompt.submit 是留给 P1 的钩子点（斜杠展开、prompt.fill、附件）。
    // core 返回 { handled: false }，所以 MVP 里它什么都不做 —— 但它真的被抛出来了，
    // 而不是躺在 contract 里没人碰。
    const submitted = await dispatch('prompt.submit', { text }, CORE_ORIGIN);
    if ((options.honorHandled ?? true) && submitted.handled) return 'handled';

    // 拼进**用户那条消息**，不是另插一条：两条连续的 user 消息是某些端点会拒的形状，
    // 我们没有理由为了一句补充说明去踩这个坑。代价是转录里也含这段 —— 这是对的，
    // 模型当时看到的就是这个。
    messages.push({ role: 'user', content: withContext(text, submitted.context) });

    const signal = turns.begin();
    let reason: TurnReason = 'error';
    try {
      // 系统提示**每轮重算**（P7 §3.2）。放在 try 里面：它要读盘（指令文件），
      // 读不动也要走下面那一套收尾，不能把一个 turn 挂在半路。
      const prompt = await builder.build();
      // 拆分是**可选**的：只有文本的调用方（以及测试）照旧走单一字符串。
      const systemParts =
        prompt.staticText === undefined || prompt.dynamicText === undefined
          ? undefined
          : { static: prompt.staticText, dynamic: prompt.dynamicText };
      // 开始转 spinner：模型第一个增量（或本 turn 结束）到来时会被停掉。
      render.thinking();
      reason = await runTurn(
        {
          $,
          provider: { name: 'repl', stream: (req) => $.model.stream(req) },
          signal,
          dispatch,
          systemPrompt: prompt.text,
          ...(systemParts === undefined ? {} : { systemParts }),
          turnIndex: turnIndex++,
          onUsage: (usage) => compactor?.note(usage),
          onTools: (specs) => {
            lastTools = specs;
          },
          contextWindow,
          onProjection: (stats) => {
            lastProjection = stats;
          },
        },
        messages,
      );
    } finally {
      // 失败也要归零：留着 busy=true 会让下一次 Ctrl-C 变成"掐一个已经结束的 turn"。
      turns.end();
      // 每个 turn 收尾都补一个换行、并把新增消息落盘 —— 放在 finally 里，
      // 出错/被中断的那一轮也照样收尾。newline 只在这里调一次，别在外面再来一遍。
      render.newline();
      await persist(messages);
      // 落盘之后再判压缩：压完要 `reseed` 游标，而游标是落盘器自己的状态。
      if (options.afterTurn ?? true) await compactor?.afterTurn();
    }
    return reason;
  };

  const runCommand = async (name: string, args: readonly string[]): Promise<boolean> => {
    const result = await dispatch('command.run', { name, args }, CORE_ORIGIN);
    if (result.handled) return name === 'exit';
    render.notice(`未知命令：/${name}`);
    return false;
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await dispatch('session.end', { reason: 'exit' }, CORE_ORIGIN);
      } finally {
        // `session.end` 之后关：插件可能还想在那条事件里说话。幂等，与 exit 那条兜底共存。
        // 放在 finally 里：一条插件把 session.end 抛坏了，子进程也不能跟着漏。
        await mcp.close();
      }
    })();
    return closing;
  };

  return {
    $,
    dispatch,
    messages,
    turns,
    bundle,
    changes,
    policy,
    persist,
    builder,
    submit,
    runCommand,
    close,
    info: {
      model,
      provider,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      sessionId,
      cwd: root,
      ...(transcript === undefined ? {} : { transcriptPath: transcript.path }),
    },
  };
}
