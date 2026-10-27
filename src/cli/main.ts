import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createPromptSink } from './prompt';
import { HELP_TEXT, parseArgs, readVersion } from './args';
import { createPalette } from './ansi';
import { banner, shouldShowBanner } from './banner';
import { exitLines } from './tally';
import { createCompleter, createLineQueue } from './input';
import { HISTORY_LIMIT, loadHistory } from './history';
import { createRenderer } from './render';
import { startRepl } from './repl';
import { resolvePolicy } from './settings';
import { runPluginCommand } from './plugin-command';
import { runConfigCommand } from './config-cli';
import { runWebCommand } from './web/command';
import { createTurnSignals } from './turns';
// 会话装配整段在 session.ts（P17）。main 只管终端那一层。
import { createSession, SessionStartError, type Session } from './session';

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
      // mcpServers 里的 `${VAR}` 要用它展开。不给的话，命令行 `/mcp` 报出来的
      // 与 prompt 里启动的会是两份不同的配置 —— 同一份文件，两个答案。
      env: process.env,
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

  // `deepcode web`：本地网页界面。与 config / plugin 一样，在建 readline 之前分流 ——
  // 那个界面不需要终端的行输入，也不需要把它从管道里抢走。
  if (action.kind === 'web') {
    process.exitCode = await runWebCommand({
      home,
      root,
      env: process.env,
      // 网页暂不认 `--settings=`（参数解析里也没放它进来）。
      settingsPath: undefined,
      resume: { kind: 'none' },
      port: action.port,
      open: action.open,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  // 配置、key、权限、插件、MCP、引擎、系统提示、压缩、落盘 —— 全部在 `createSession`
  // 里（P17 起与网页界面共用）。这里只留终端自己那几样：readline、历史、SIGINT、banner。

  const turns = createTurnSignals();
  const palette = createPalette();
  const render = createRenderer();
  /**
   * 一条给人看的警告。**所有**这类出口都走它，而不是直接写 `process.stderr` ——
   * stderr 与 stdout 在终端里是同一块屏幕，而活动区（P6a）是一块被借走、随时会被
   * 重画的区域。绕过渲染器写出去的每一个字节都可能糊在那半行小圆圈后面。
   */
  const warnLine = (line: string): void => render.notice(line);

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

  // 会话那一整段装配（配置、key、权限、插件、MCP、引擎、系统提示、压缩、落盘）在
  // `cli/session.ts` 里 —— P17 起与网页界面共用。这里只接终端自己的东西。
  let session: Session;
  try {
    session = await createSession({
      home,
      root,
      env: process.env,
      settingsPath: action.settings,
      resume: action.resume,
      ui: prompt,
      render,
      palette,
      turns,
      // 会话建起来之前的警告（读连接配置、权限设置）：终端里就是 stderr，
      // 与抽出去之前逐字节相同 —— 网页传它自己的那一面。
      warnEarly: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    if (!(error instanceof SessionStartError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    // 必须关掉 readline：它是这个进程里唯一把事件循环吊住的东西，
    // 不关的话 `deepcode --resume`（真终端里也一样）报完错会挂在那儿等输入，
    // 而不是退出。
    prompt.close();
    return;
  }
  const { $, dispatch, messages, bundle } = session;
  const { model, provider, baseUrl, transcriptPath } = session.info;

  // 有了 `dispatch`，补全那个延迟取的位置就填得上了。
  // 名单**现取**（`$.command.list()`），不另抄一份：抄的那份迟早落后。
  lookupCommands = () => $.command.list();

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
        // 只有真的落上盘才报 id —— 与抽出去之前一致（建不了转录时那串是时间戳）。
        ...(transcriptPath === undefined ? {} : { sessionId: session.info.sessionId }),
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
    // 静默什么都没做、退出码 0 的调用（设计 §8 偏差 9）。压缩的自动那一路同理：
    // 只跑这一轮，没有"之后"。
    const reason = await session.submit(oneShot, { honorHandled: false, afterTurn: false });
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
      systemPrompt: async () => await session.builder.build(),
      turns,
      messages,
      persist: session.persist,
      // turn 的开始/结束、落盘与压缩交给会话（与网页同一条路）。
      submit: (text) => session.submit(text),
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
    exitLines(bundle.tally, session.changes.list(), palette, {
      root,
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    }),
  );

  // `session.end` + MCP 关闭。`session.end` 之后关：插件可能还想在那条事件里说话。
  // 幂等，与 `session.ts` 里那条 `exit` 兜底共存。
  await session.close();
  prompt.close();
}

main().catch((error) => {
  // 取 message 而不是整个 Error：String(error) 会带上 "Error: " 前缀，
  // 配着下面那句"启动失败"读起来就是"启动失败：Error: ..."。
  process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
