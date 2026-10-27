import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResumeTarget } from '../args';
import { createPalette } from '../ansi';
import { createSession, SessionStartError, type Session } from '../session';
import { createTurnSignals } from '../turns';
import { createWebBus } from './bus';
import { createWebEventsPlugin } from './events';
import { createWebServer, type WebHost } from './server';
import { createWebUi } from './ui';

/**
 * `deepcode web` 的整个生命周期：装配会话 → 起服务 → 打印地址 → 等 Ctrl-C / `/exit`。
 *
 * 与终端那份的区别只有界面层：同一套插件、权限与工具链，`UiSink` 换成网页实现。
 */

export type WebCommandDeps = {
  readonly home: string;
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly settingsPath: string | undefined;
  readonly resume: ResumeTarget;
  readonly port: number | undefined;
  readonly open: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** 静态资源就住在源码旁边 —— 没有构建步骤，也就没有 `dist` 要抄一份。 */
const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url));

/** 打不开浏览器不是故障：地址已经打印了，用手粘一下就行。 */
function openBrowser(url: string, err: (line: string) => void): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (error) => {
      err(`打不开浏览器（${error.message}），地址已经在上面了。`);
    });
    child.unref();
  } catch (error) {
    err(`打不开浏览器（${String(error)}），地址已经在上面了。`);
  }
}

export async function runWebCommand(deps: WebCommandDeps): Promise<number> {
  const bus = createWebBus();
  const ui = createWebUi({ emit: bus.emit });
  const events = createWebEventsPlugin({ emit: bus.emit, onAskContext: ui.setAskContext });

  let session: Session;
  try {
    session = await createSession({
      home: deps.home,
      root: deps.root,
      env: deps.env,
      settingsPath: deps.settingsPath,
      // 一个进程一个会话。网页刷新靠事件回放恢复时间线，不是靠重连到旧转录 ——
      // `latest` 在"第一次运行"时会抛"找不到可以接上的会话"，而那不该挡住开工。
      resume: deps.resume,
      ui,
      render: ui,
      palette: createPalette(false),
      turns: createTurnSignals(),
      extraPlugins: [events],
      warnEarly: (line) => deps.err(line),
    });
  } catch (error) {
    if (!(error instanceof SessionStartError)) throw error;
    deps.err(error.message.replace(/\n$/, ''));
    return error.exitCode;
  }

  /** 正在跑的那一轮。它决定 `busy`（新提问 409），关闭时也要等它收尾。 */
  let turning: Promise<unknown> | undefined;
  let server: Awaited<ReturnType<typeof createWebServer>>;
  let closing: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      process.off('SIGINT', onSigint);
      // 先把正在跑的那一轮掐断，否则 `session.close` 会与它抢同一个引擎。
      session.turns.interrupt();
      await server.close();
      // 挂起的权限卡按 fallback 收场 —— 读不到答案 = 没同意。
      ui.close();
      await turning?.catch(() => undefined);
      await session.close();
      resolveDone();
    })();
    return closing;
  };

  const host: WebHost = {
    info: session.info,
    isBusy: () => turning !== undefined,
    submit: (text) => {
      const work = session.submit(text);
      turning = work.catch(() => undefined);
      return work.then(() => undefined).finally(() => {
        turning = undefined;
      });
    },
    runCommand: async (name, args) => {
      const exit = await session.runCommand(name, args);
      if (exit) void shutdown();
      return exit;
    },
    interrupt: () => {
      ui.abortAll('abort');
      session.turns.interrupt();
    },
    close: () => shutdown(),
  };

  server = await createWebServer({
    host,
    bus,
    answer: ui.answer,
    staticDir: STATIC_DIR,
    ...(deps.port === undefined ? {} : { port: deps.port }),
  });

  deps.out(`DeepCode web: ${server.url}`);
  deps.out('Ctrl-C 停止服务');
  if (deps.open) openBrowser(server.url, deps.err);

  // 忙的时候第一下 Ctrl-C 只掐断当前 turn（服务继续）；空闲时第一下就退出。
  // 一秒内连按第二下 = 强制退出 —— 与终端那条"同一个 turn 里再按一次"同义。
  let lastSigint = 0;
  const onSigint = (): void => {
    const now = Date.now();
    if (now - lastSigint < 1_000) {
      process.exit(130);
    }
    lastSigint = now;
    ui.abortAll('abort');
    if (!session.turns.interrupt()) void shutdown();
  };
  process.on('SIGINT', onSigint);

  await done;
  return 0;
}
