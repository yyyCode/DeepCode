import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 真跑一遍 `deepcode web --no-open`：起进程、从 stdout 接住地址、拿它去取页面。
 *
 * 这一条守的是"静态资源真的在源码旁边、路径拼得对"—— 单测用临时目录注入
 * `staticDir`，恰好绕开了真实路径。也守 `main.ts` 里那条分支没被别的东西挡住。
 */

const BIN = resolve(process.cwd(), 'bin', 'deepcode.mjs');

let child: ChildProcessWithoutNullStreams;
let home: string;
let url: string;
let output = '';
let errors = '';

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'deepcode-web-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-web-test',
  };
  for (const name of [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'DEEPCODE_MODEL',
    'DEEPCODE_DEBUG',
    'DEEPCODE_PROVIDER',
  ]) {
    delete env[name];
  }

  child = spawn(process.execPath, [BIN, 'web', '--no-open'], { cwd: process.cwd(), env });

  url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`20 秒没等到地址：\n${output}\n${errors}`));
    }, 20_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /DeepCode web: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl(match[1]!);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（${String(code)}）：\n${output}\n${errors}`));
    });
  });
}, 30_000);

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000))]);
  }
  if (home !== undefined && existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('deepcode web 起得来、页面拿得到', () => {
  it('带 token 的首页是那份 HTML', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>DeepCode</title>');
  });

  it('app.js 与 style.css 都从源码旁边直接读出来', async () => {
    const script = await fetch(new URL('/app.js', url));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');

    const style = await fetch(new URL('/style.css', url));
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toContain('text/css');
  });

  it('不带 token / token 不对 → 401', async () => {
    expect((await fetch(new URL('/', url))).status).toBe(401);
    const wrong = new URL(url);
    wrong.searchParams.set('t', 'not-the-token');
    expect((await fetch(wrong)).status).toBe(401);
  });

  it('/events 先发 hello，带着模型与忙闲状态', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(new URL(`/events?t=${new URL(url).searchParams.get('t')!}`, url), {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const first = await reader.read();
      controller.abort();
      const text = Buffer.from(first.value ?? new Uint8Array()).toString('utf8');
      expect(text).toContain('event: hello');
      expect(text).toContain('"busy":false');
    } finally {
      clearTimeout(timer);
    }
  });
});
