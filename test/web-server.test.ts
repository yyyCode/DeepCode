import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createWebBus } from '../src/cli/web/bus';
import { createWebServer, type WebHost } from '../src/cli/web/server';

const TOKEN = 'a'.repeat(32);

function fakeHost() {
  const calls = {
    submit: [] as string[],
    commands: [] as { name: string; args: string[] }[],
    interrupts: 0,
    closed: 0,
  };
  let busy = false;
  const host: WebHost = {
    info: { model: 'stub', provider: 'stub', cwd: '/tmp/x', sessionId: 's1' },
    isBusy: () => busy,
    submit: async (text) => {
      calls.submit.push(text);
    },
    runCommand: async (name, args) => {
      calls.commands.push({ name, args: [...args] });
      return false;
    },
    interrupt: () => {
      calls.interrupts += 1;
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  return { host, calls, setBusy: (value: boolean) => (busy = value) };
}

let staticDir: string;

beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'deepcode-web-'));
  await writeFile(join(staticDir, 'index.html'), '<title>DeepCode</title>');
  await writeFile(join(staticDir, 'app.js'), 'console.log(1)');
  await writeFile(join(staticDir, 'style.css'), 'body{}');
});

afterAll(async () => {
  await rm(staticDir, { recursive: true, force: true });
});

async function start(over: { answer?: (id: string, value: string) => boolean } = {}) {
  const bus = createWebBus();
  const fake = fakeHost();
  const server = await createWebServer({
    host: fake.host,
    bus,
    answer: over.answer ?? (() => false),
    staticDir,
    token: TOKEN,
  });
  return { server, bus, ...fake, base: `http://127.0.0.1:${server.port}` };
}

async function withServer(
  fn: (ctx: Awaited<ReturnType<typeof start>>) => Promise<void>,
  over: { answer?: (id: string, value: string) => boolean } = {},
): Promise<void> {
  const ctx = await start(over);
  try {
    await fn(ctx);
  } finally {
    await ctx.server.close();
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deepcode-token': TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** 绕开 fetch 对 Host/Origin 的限制（它们不在 fetch 的可写头名单里）。 */
function raw(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('createWebServer', () => {
  it('token 缺失或不对 → 401', async () => {
    await withServer(async ({ server, base }) => {
      expect((await fetch(`${base}/`)).status).toBe(401);
      expect((await fetch(`${base}/?t=nope`)).status).toBe(401);
      expect((await fetch(`${base}/events`)).status).toBe(401);
      expect(server.url).toContain(`?t=${TOKEN}`);
    });
  });

  it('Host 不是本机 → 403（DNS rebinding）', async () => {
    await withServer(async ({ server }) => {
      const res = await raw(server.port, {
        path: `/?t=${TOKEN}`,
        headers: { host: 'evil.test' },
      });
      expect(res.status).toBe(403);
    });
  });

  it('POST 的 Origin 不对 → 403；同源可以', async () => {
    await withServer(async ({ server, base }) => {
      const bad = await raw(server.port, {
        method: 'POST',
        path: '/api/prompt',
        headers: {
          host: `127.0.0.1:${server.port}`,
          origin: 'http://evil.test',
          'content-type': 'application/json',
          'x-deepcode-token': TOKEN,
        },
        body: JSON.stringify({ text: '你好' }),
      });
      expect(bad.status).toBe(403);

      const good = await post(base, '/api/prompt', { text: '你好' }, {
        origin: `http://127.0.0.1:${server.port}`,
      });
      expect(good.status).toBe(202);
    });
  });

  it('静态资源只认白名单三个名字，其余 404', async () => {
    await withServer(async ({ server, base }) => {
      const js = await fetch(`${base}/app.js`);
      expect(js.status).toBe(200);
      expect(await js.text()).toBe('console.log(1)');

      const css = await fetch(`${base}/style.css`);
      expect(css.status).toBe(200);

      expect((await fetch(`${base}/package.json`)).status).toBe(404);
      const traversal = await raw(server.port, { path: '/../package.json' });
      expect(traversal.status).toBe(404);
    });
  });

  it('首页要 token，且带着 CSP', async () => {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/?t=${TOKEN}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>DeepCode</title>');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    });
  });

  it('POST /api/prompt：202 并触发 submit；空文本 400；忙 409', async () => {
    await withServer(async ({ base, calls, setBusy }) => {
      expect((await post(base, '/api/prompt', { text: '  ' })).status).toBe(400);

      const ok = await post(base, '/api/prompt', { text: '改一下 README' });
      expect(ok.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls.submit).toEqual(['改一下 README']);

      setBusy(true);
      expect((await post(base, '/api/prompt', { text: '再问一句' })).status).toBe(409);
    });
  });

  it('以 / 开头走 runCommand，参数按空白拆开', async () => {
    await withServer(async ({ base, calls }) => {
      expect((await post(base, '/api/prompt', { text: '/diff a b' })).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls.commands).toEqual([{ name: 'diff', args: ['a', 'b'] }]);
      expect(calls.submit).toEqual([]);
    });
  });

  it('/api/answer：未知 id 409；命中 202', async () => {
    let answered: { id: string; value: string } | undefined;
    await withServer(
      async ({ base }) => {
        expect((await post(base, '/api/answer', { id: 'a9', value: 'y' })).status).toBe(409);
        expect((await post(base, '/api/answer', { id: 'a1', value: 'y' })).status).toBe(202);
        expect(answered).toEqual({ id: 'a1', value: 'y' });
      },
      {
        answer: (id, value) => {
          answered = { id, value };
          return id === 'a1';
        },
      },
    );
  });

  it('/api/interrupt 调 host.interrupt', async () => {
    await withServer(async ({ base, calls }) => {
      expect((await post(base, '/api/interrupt', {})).status).toBe(202);
      expect(calls.interrupts).toBe(1);
    });
  });

  it('SSE：先 hello 与回放，再实时事件', async () => {
    await withServer(async ({ base, bus }) => {
      bus.emit({ type: 'log', level: 'info', text: '早先的一条' });

      const controller = new AbortController();
      const response = await fetch(`${base}/events?t=${TOKEN}`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';

      const readUntil = async (needle: string): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (!text.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`等不到 ${needle}，收到的：${text}`);
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`流结束了，没等到 ${needle}：${text}`);
          text += decoder.decode(chunk.value, { stream: true });
        }
      };

      await readUntil('event: hello');
      await readUntil('早先的一条');

      bus.emit({ type: 'delta', text: '实时' });
      await readUntil('实时');
      expect(text).toContain('id: 2');

      controller.abort();
    });
  });
});
