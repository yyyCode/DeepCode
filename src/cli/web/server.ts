import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo } from '../session';
import type { WebBus } from './bus';

/**
 * 本地 HTTP 服务：SSE 只下行，POST 只上行。
 *
 * 安全边界（spec §8）：
 * - 只 `listen(127.0.0.1)`，没有 `--host`；
 * - 每个请求校验 `Host`，POST 若带 `Origin` 也校验 —— 挡 DNS rebinding；
 * - token 用定长比较；静态资源按**文件名白名单**直读，不拼用户路径。
 */

export type WebHost = {
  readonly info: SessionInfo;
  isBusy(): boolean;
  submit(text: string): Promise<void>;
  runCommand(name: string, args: readonly string[]): Promise<boolean>;
  interrupt(): void;
  close(): Promise<void>;
};

export type WebServer = {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
};

export type WebServerDeps = {
  readonly host: WebHost;
  readonly bus: WebBus;
  readonly answer: (id: string, value: string) => boolean;
  /** 静态资源目录。测试注入临时目录。 */
  readonly staticDir: string;
  /** 测试可以钉死；省略 = 每次启动随机 32 位十六进制。 */
  readonly token?: string;
  /** 0 = 系统分配空闲端口。 */
  readonly port?: number;
  readonly hostname?: string;
};

const BODY_LIMIT = 1024 * 1024;
const MIME: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};
/** 只认这三个文件名，不拼用户路径 —— 没有目录穿越面。 */
const STATIC_FILES = new Set(Object.keys(MIME));

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT) throw new HttpError(413, '请求体超过 1 MiB');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是一个对象');
  }
  return parsed as Record<string, unknown>;
}

/** `/命令 参数` 的拆法。与终端那边认的是同一件东西（以 `/` 开头就是命令）。 */
function splitCommand(text: string): { name: string; args: string[] } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return undefined;
  const rest = match[2]?.trim() ?? '';
  return { name: match[1]!, args: rest === '' ? [] : rest.split(/\s+/) };
}

export async function createWebServer(deps: WebServerDeps): Promise<WebServer> {
  const hostname = deps.hostname ?? '127.0.0.1';
  const token = deps.token ?? randomBytes(16).toString('hex');
  const expectedHosts = new Set<string>();
  /** Origin 带协议，与 Host 不是同一张表 —— 混用会让每一个真正的浏览器请求都 403。 */
  const expectedOrigins = new Set<string>();
  let boundPort = deps.port ?? 0;

  const sameToken = (given: string | undefined): boolean => {
    if (given === undefined) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** 查询参数里的 token（GET / 与 SSE）。 */
  const queryToken = (url: URL): string | undefined => url.searchParams.get('t') ?? undefined;

  /** POST：头部 token + Host/Origin。 */
  const checkPost = (req: IncomingMessage): void => {
    const given = req.headers['x-deepcode-token'];
    if (!sameToken(Array.isArray(given) ? given[0] : given)) {
      throw new HttpError(401, 'token 不对');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !expectedOrigins.has(origin.toLowerCase())) {
      throw new HttpError(403, 'Origin 不对');
    }
  };

  const serveStatic = async (res: ServerResponse, name: string): Promise<void> => {
    if (!STATIC_FILES.has(name)) return sendText(res, 404, '没有这个东西');
    let body: Buffer;
    try {
      body = await readFile(join(deps.staticDir, name));
    } catch {
      return sendText(res, 404, '没有这个东西');
    }
    res.writeHead(200, {
      'content-type': MIME[name]!,
      'content-length': body.length,
      ...SECURITY_HEADERS,
      ...(name === 'index.html' ? { 'content-security-policy': CSP } : {}),
    });
    res.end(body);
  };

  const serveEvents = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // 本机不需要，但一旦有人拿反向代理转一手，没有它缓冲会把事件攒成一坨。
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        model: deps.host.info.model,
        provider: deps.host.info.provider,
        cwd: deps.host.info.cwd,
        sessionId: deps.host.info.sessionId,
        busy: deps.host.isBusy(),
        replayTruncated: deps.bus.truncated,
      })}\n\n`,
    );
    for (const event of deps.bus.replay()) {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    // 回放与订阅在同一个同步段里：中间没有 await，事件插不进来。
    const unsubscribe = deps.bus.subscribe((event) => {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // 本机用不上心跳；真正的 SSE 客户端与将来可能的代理都认这一行。
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref?.();
    const done = (): void => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on('close', done);
    res.on('close', done);
  };

  const handlePost = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    checkPost(req);
    const type = req.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type 必须是 application/json');
    }
    const body = parseJson(await readBody(req));

    if (path === '/api/prompt') {
      const text = body['text'];
      if (typeof text !== 'string' || text.trim() === '') {
        throw new HttpError(400, 'text 不能为空');
      }
      if (deps.host.isBusy()) throw new HttpError(409, '正在跑一个 turn，等它结束');
      const command = splitCommand(text);
      sendJson(res, 202, { ok: true });
      if (command !== undefined) {
        void deps.host.runCommand(command.name, command.args).catch((error: unknown) => {
          deps.bus.emit({ type: 'log', level: 'warn', text: `命令失败：${String(error)}` });
        });
      } else {
        void deps.host.submit(text).catch((error: unknown) => {
          deps.bus.emit({ type: 'log', level: 'warn', text: `这一轮失败：${String(error)}` });
        });
      }
      return;
    }

    if (path === '/api/answer') {
      const id = body['id'];
      const value = body['value'];
      if (typeof id !== 'string' || typeof value !== 'string') {
        throw new HttpError(400, 'id / value 必须是字符串');
      }
      if (!deps.answer(id, value)) throw new HttpError(409, '没有这个问题，或这个选项不在选项里');
      return sendJson(res, 202, { ok: true });
    }

    if (path === '/api/interrupt') {
      deps.host.interrupt();
      return sendJson(res, 202, { ok: true });
    }

    throw new HttpError(404, '没有这个接口');
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const givenHost = (req.headers.host ?? '').toLowerCase();
        if (!expectedHosts.has(givenHost)) throw new HttpError(403, 'Host 不对');

        if (req.method === 'GET') {
          if (url.pathname === '/' ) {
            if (!sameToken(queryToken(url))) throw new HttpError(401, 'token 不对');
            return await serveStatic(res, 'index.html');
          }
          if (url.pathname === '/events') {
            if (!sameToken(queryToken(url))) throw new HttpError(401, 'token 不对');
            return serveEvents(req, res);
          }
          const name = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
          return await serveStatic(res, name);
        }

        if (req.method === 'POST') return await handlePost(req, res, url.pathname);

        throw new HttpError(405, '只认 GET / POST');
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address !== null && typeof address === 'object') boundPort = address.port;

  // Host / Origin 校验用的两个来源。端口要到 listen 之后才知道（0 = 系统分配）。
  for (const name of [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]) {
    expectedHosts.add(name.toLowerCase());
    expectedOrigins.add(`http://${name}`.toLowerCase());
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    return closing;
  };

  return {
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}/?t=${token}`,
    close,
  };
}
