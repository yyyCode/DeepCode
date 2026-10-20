import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenAiAsrProvider,
  type AsrProvider,
  type FetchLike,
} from '@deepcode/companion/asr';
import {
  createIflytekAsrProvider,
  extractIflytekText,
  signIflytekRequest,
} from '@deepcode/companion/asr-iflytek';
import {
  createLocalAsrProvider,
  parseWav,
} from '@deepcode/companion/asr-local';
import {
  resolveAsrSettings,
  type AsrSettings,
  type IflytekAsrSettings,
  type RemoteAsrSettings,
} from '@deepcode/companion/config';
import { MAX_AUDIO_BYTES, MAX_MESSAGE } from '@deepcode/companion/types';

const supported = Number(process.versions.node.split('.')[0] ?? 0) >= 22;

function tempHome(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepcode-asr-config-'));
  mkdirSync(join(dir, '.deepcode'), { recursive: true });
  writeFileSync(join(dir, '.deepcode', 'config.json'), JSON.stringify(config));
  return dir;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

function monoWav(samples: readonly number[], sampleRate = 16_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  });
  return bytes;
}

describe('resolveAsrSettings：独立配置，没 key 就是关', () => {
  it('文件里的 asr 生效；环境变量逐项盖过它', async () => {
    const home = tempHome({
      asr: {
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
        language: 'en',
      },
    });
    try {
      expect(await resolveAsrSettings({ USERPROFILE: home, HOME: home })).toEqual({
        provider: 'openai',
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
        language: 'en',
      });

      const env = {
        USERPROFILE: home,
        HOME: home,
        DEEPCODE_ASR_API_KEY: 'env-key',
        DEEPCODE_ASR_MODEL: 'env-model',
        DEEPCODE_ASR_LANGUAGE: 'ja',
      };
      expect(await resolveAsrSettings(env)).toEqual({
        provider: 'openai',
        apiKey: 'env-key',
        // baseUrl 没给环境变量，继续用文件里的。
        baseUrl: 'https://file.example/v1',
        model: 'env-model',
        language: 'ja',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('没有 apiKey = 不启用', async () => {
    const home = tempHome({ apiKey: '只给聊天用的 key' });
    try {
      expect(await resolveAsrSettings({ USERPROFILE: home, HOME: home })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('asr 不是对象、baseUrl 不是 URL 都会明确报错', async () => {
    const badShape = tempHome({ asr: 'nope' });
    const badUrl = tempHome({ asr: { apiKey: 'k', baseUrl: 'not a url' } });
    try {
      await expect(
        resolveAsrSettings({ USERPROFILE: badShape, HOME: badShape }),
      ).rejects.toThrow('"asr" 必须是一个对象');
      await expect(
        resolveAsrSettings({ USERPROFILE: badUrl, HOME: badUrl }),
      ).rejects.toThrow('不是合法 URL');
    } finally {
      rmSync(badShape, { recursive: true, force: true });
      rmSync(badUrl, { recursive: true, force: true });
    }
  });

  it('provider=local：不需要 key，默认目录、线程数，环境变量能盖过', async () => {
    const home = tempHome({ asr: { provider: 'local', language: 'auto' } });
    const dir = join(home, '.deepcode', 'models', 'asr', 'sensevoice-small-int8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.int8.onnx'), '');
    writeFileSync(join(dir, 'tokens.txt'), '');
    try {
      await expect(
        resolveAsrSettings({ USERPROFILE: home, HOME: home }),
      ).resolves.toEqual({
        provider: 'local',
        modelDir: dir,
        modelPath: join(dir, 'model.int8.onnx'),
        tokensPath: join(dir, 'tokens.txt'),
        language: 'auto',
        numThreads: 2,
      });

      const env = {
        USERPROFILE: home,
        HOME: home,
        DEEPCODE_ASR_LANGUAGE: 'en',
        DEEPCODE_ASR_NUM_THREADS: '4',
      };
      await expect(resolveAsrSettings(env)).resolves.toMatchObject({
        provider: 'local',
        language: 'en',
        numThreads: 4,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('本地模型文件缺失时明确说缺什么', async () => {
    const home = tempHome({ asr: { provider: 'local' } });
    try {
      await expect(
        resolveAsrSettings({ USERPROFILE: home, HOME: home }),
      ).rejects.toThrow('本地 ASR 模型不完整');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('provider=iflytek：三把密钥缺一不可，语言归一化', async () => {
    const home = tempHome({
      asr: {
        provider: 'iflytek',
        appId: 'app-id',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      },
    });
    try {
      await expect(
        resolveAsrSettings({ USERPROFILE: home, HOME: home }),
      ).resolves.toEqual({
        provider: 'iflytek',
        appId: 'app-id',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
        language: 'zh_cn',
      });
      await expect(
        resolveAsrSettings({
          USERPROFILE: home,
          HOME: home,
          DEEPCODE_ASR_LANGUAGE: 'en',
        }),
      ).resolves.toMatchObject({ language: 'en_us' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    const missing = tempHome({
      asr: { provider: 'iflytek', appId: 'app-id', apiKey: 'api-key' },
    });
    try {
      await expect(
        resolveAsrSettings({ USERPROFILE: missing, HOME: missing }),
      ).rejects.toThrow('缺少 appId / apiKey / apiSecret');
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });
});

describe('OpenAI 兼容转写：请求形状与错误', () => {
  const settings: RemoteAsrSettings = {
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1/',
    model: 'whisper-1',
    language: 'zh',
  };
  const signal = new AbortController().signal;

  it('发到 /audio/transcriptions，文件后缀按类型推，key 只进 Authorization', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fakeFetch: FetchLike = async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(JSON.stringify({ text: ' 你好 ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = createOpenAiAsrProvider(settings, fakeFetch);
    const result = await provider.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm;codecs=opus',
      signal,
    });

    expect(result).toEqual({ text: '你好' });
    expect(seenUrl).toBe('https://example.com/v1/audio/transcriptions');
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

    const form = seenInit?.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('zh');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.webm');
  });

  it('language 为空就不发；不支持的类型在发请求前就拒绝', async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    };
    const provider = createOpenAiAsrProvider({ ...settings, language: '' }, fakeFetch);

    await provider.transcribe({
      audio: new Uint8Array([1]),
      mimeType: 'audio/mp4',
      signal,
    });
    expect(calls).toBe(1);

    await expect(
      provider.transcribe({ audio: new Uint8Array([1]), mimeType: 'text/plain', signal }),
    ).rejects.toThrow('不支持的音频类型');
    expect(calls).toBe(1);
  });

  it('上游非 2xx 与缺 text 都变成明确错误', async () => {
    const unauthorized = createOpenAiAsrProvider(
      settings,
      async () => new Response('no key', { status: 401 }),
    );
    await expect(
      unauthorized.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm', signal }),
    ).rejects.toThrow('ASR 服务返回 401');

    const shapeless = createOpenAiAsrProvider(
      settings,
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      shapeless.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm', signal }),
    ).rejects.toThrow('没有 text');
  });
});

describe('讯飞极速录音转写 provider', () => {
  const settings: IflytekAsrSettings = {
    provider: 'iflytek',
    appId: 'app-id',
    apiKey: 'api-key',
    apiSecret: 'api-secret',
    language: 'zh_cn',
  };
  const signal = new AbortController().signal;

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('上传 → 建任务 → 轮询，签名与请求体完整', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let queryCount = 0;
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith('/file/upload')) {
        return jsonResponse({
          code: 0,
          data: { url: 'https://upload.example/audio.wav' },
        });
      }
      if (String(url).endsWith('/pro_create')) {
        return jsonResponse({ code: 0, data: { task_id: 'task-1' } });
      }
      queryCount += 1;
      if (queryCount === 1) {
        return jsonResponse({ code: 0, data: { task_status: '2' } });
      }
      return jsonResponse({
        code: 0,
        data: {
          task_status: '4',
          result: {
            lattice: [
              {
                json_1best: {
                  st: {
                    rt: [
                      { ws: [{ cw: [{ w: '听说' }] }, { cw: [{ w: '。' }] }] },
                    ],
                  },
                },
              },
            ],
          },
        },
      });
    };

    const provider = createIflytekAsrProvider(settings, fakeFetch, {
      now: () => new Date('2026-10-21T00:00:00Z'),
      sleep: async () => undefined,
      requestId: () => 'req-1',
    });
    const result = await provider.transcribe({
      audio: monoWav([0, 0.1]),
      mimeType: 'audio/wav',
      signal,
    });

    expect(result).toEqual({ text: '听说。' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://upload-ost-api.xfyun.cn/file/upload',
      'https://ost-api.xfyun.cn/v2/ost/pro_create',
      'https://ost-api.xfyun.cn/v2/ost/query',
      'https://ost-api.xfyun.cn/v2/ost/query',
    ]);

    const upload = calls[0]!;
    const headers = upload.init.headers as Record<string, string>;
    expect(headers.date).toBe('Wed, 21 Oct 2026 00:00:00 GMT');
    expect(headers.digest).toMatch(/^SHA-256=/);
    expect(headers.authorization).toContain('api_key="api-key"');
    expect(headers['content-type']).toContain('multipart/form-data; boundary=');
    const uploadBody = Buffer.from(upload.init.body as Uint8Array).toString('utf8');
    expect(uploadBody).toContain('name="data"; filename="audio.wav"');
    expect(uploadBody).toContain('name="app_id"');
    expect(uploadBody).toContain('req-1');

    const createBody = JSON.parse(
      Buffer.from(calls[1]!.init.body as Uint8Array).toString('utf8'),
    ) as {
      business: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(createBody.business).toMatchObject({
      request_id: 'req-1',
      language: 'zh_cn',
      domain: 'pro_ost_ed',
      accent: 'mandarin',
      language_type: 1,
    });
    expect(createBody.data).toMatchObject({
      audio_url: 'https://upload.example/audio.wav',
      audio_src: 'http',
      format: 'audio/L16;rate=16000',
      encoding: 'wav',
    });

    const queryBody = JSON.parse(
      Buffer.from(calls[2]!.init.body as Uint8Array).toString('utf8'),
    ) as { business: Record<string, unknown> };
    expect(queryBody.business).toEqual({ task_id: 'task-1' });
  });

  it('签名按 host / date / request-line / digest 拼 origin', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const signed = signIflytekRequest({
      url: 'https://ost-api.xfyun.cn/v2/ost/query',
      body,
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      at: new Date('2026-10-21T00:00:00Z'),
    });
    const date = 'Wed, 21 Oct 2026 00:00:00 GMT';
    const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
    const origin =
      `host: ost-api.xfyun.cn\ndate: ${date}\n` +
      `POST /v2/ost/query HTTP/1.1\ndigest: ${digest}`;
    const signature = createHmac('sha256', 'api-secret')
      .update(origin)
      .digest('base64');

    expect(signed).toEqual({
      date,
      digest,
      authorization:
        'api_key="api-key", algorithm="hmac-sha256", ' +
        `headers="host date request-line digest", signature="${signature}"`,
    });
  });

  it('上游 code 非 0 报错；非 WAV 在发请求前拒绝', async () => {
    let calls = 0;
    const provider = createIflytekAsrProvider(settings, async () => {
      calls += 1;
      return jsonResponse({ code: 10001, message: 'bad audio' });
    });

    await expect(
      provider.transcribe({ audio: monoWav([0]), mimeType: 'audio/wav', signal }),
    ).rejects.toThrow('讯飞 上传音频 失败（code 10001）：bad audio');
    expect(calls).toBe(1);

    await expect(
      provider.transcribe({
        audio: new Uint8Array([1]),
        mimeType: 'audio/webm',
        signal,
      }),
    ).rejects.toThrow('只接受 WAV');
    expect(calls).toBe(1);
  });

  it('lattice 为空时退回 lattice2', () => {
    const text = extractIflytekText({
      data: {
        result: {
          lattice: [],
          lattice2: [
            {
              json_1best: {
                st: {
                  rt: [
                    {
                      ws: [
                        { cw: [{ w: '你' }] },
                        { cw: [{ w: '' }] },
                        { cw: [{ w: '好' }] },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    expect(text).toBe('你好');

    expect(
      extractIflytekText({
        data: {
          result: {
            lattice: [
              {
                json_1best: {
                  st: {
                    rt: [
                      {
                        ws: [
                          { cw: [{ w: 'hello' }] },
                          { cw: [{ w: 'world' }] },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      }),
    ).toBe('hello world');
  });
});

describe('本地 SenseVoice provider', () => {
  const settings = {
    provider: 'local' as const,
    modelDir: '/models/sensevoice',
    modelPath: '/models/sensevoice/model.int8.onnx',
    tokensPath: '/models/sensevoice/tokens.txt',
    language: 'zh',
    numThreads: 2,
  };
  const signal = new AbortController().signal;

  it('WAV 解码成 16 kHz 单声道，结果去掉 SenseVoice 标签', async () => {
    let accepted: Float32Array | undefined;
    const provider = createLocalAsrProvider(settings, async () => ({
      createStream: () => ({
        acceptWaveform: ({ samples }) => {
          accepted = samples;
        },
      }),
      decodeAsync: async () => ({ text: '<|zh|>你好<|NEUTRAL|>' }),
    }));

    const result = await provider.transcribe({
      audio: monoWav([-1, 0, 0.5]),
      mimeType: 'audio/wav',
      signal,
    });

    expect(result).toEqual({ text: '你好' });
    expect(accepted).toHaveLength(3);
    expect(accepted?.[0]).toBeCloseTo(-1, 3);
    expect(accepted?.[1]).toBe(0);
    expect(accepted?.[2]).toBeCloseTo(0.5, 3);
  });

  it('非 WAV 直接拒绝；并发请求串行解码', async () => {
    let active = 0;
    let maxActive = 0;
    const provider = createLocalAsrProvider(settings, async () => ({
      createStream: () => ({ acceptWaveform: () => undefined }),
      decodeAsync: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        active -= 1;
        return { text: '好' };
      },
    }));

    await expect(
      provider.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm', signal }),
    ).rejects.toThrow('只接受 WAV');

    const audio = monoWav([0.1]);
    await Promise.all([
      provider.transcribe({ audio, mimeType: 'audio/wav', signal }),
      provider.transcribe({ audio, mimeType: 'audio/wav', signal }),
    ]);
    expect(maxActive).toBe(1);
  });
});

describe.skipIf(!supported)('陪伴端 HTTP：/api/asr', () => {
  let store: import('@deepcode/companion/store').CompanionStore;
  let server: Server;
  let base = '';
  let dir = '';
  let settings: AsrSettings | undefined = {
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1',
    model: 'whisper-1',
    language: 'zh',
  };
  let transcribe: AsrProvider['transcribe'] = async () => ({ text: '你好' });
  const provider: AsrProvider = {
    name: 'fake',
    transcribe: (input) => transcribe(input),
  };

  function post(body: Uint8Array | string, type: string): Promise<Response> {
    return fetch(`${base}/api/asr`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
  }

  async function meta(): Promise<{ features: { asr: boolean; asrWav: boolean } }> {
    return (await (await fetch(`${base}/api/meta`)).json()) as {
      features: { asr: boolean; asrWav: boolean };
    };
  }

  beforeAll(async () => {
    const { openCompanionDb } = await import('@deepcode/companion/db');
    const { createCompanionServer } = await import('@deepcode/companion/server');
    dir = mkdtempSync(join(tmpdir(), 'deepcode-companion-asr-'));
    store = openCompanionDb({ file: join(dir, 'local.db'), mode: 'local' });

    server = createCompanionServer({
      store,
      mode: 'local',
      resolveAsrSettings: async () => settings,
      asrProviderFactory: () => provider,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    settings = {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
      model: 'whisper-1',
      language: 'zh',
    };
    transcribe = async () => ({ text: '你好' });
  });

  it('成功：返回去空白文本，provider 收到原始字节与主类型', async () => {
    let seen: { audio: Uint8Array; mimeType: string } | undefined;
    transcribe = async (input) => {
      seen = { audio: input.audio, mimeType: input.mimeType };
      return { text: ' 你好 ' };
    };

    const response = await post(new Uint8Array([1, 2, 3]), 'audio/webm;codecs=opus');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: '你好' });
    expect(seen?.mimeType).toBe('audio/webm');
    expect([...(seen?.audio ?? [])]).toEqual([1, 2, 3]);
    expect((await meta()).features).toEqual({ asr: true, asrWav: false });
  });

  it('本地模式：meta 要求 WAV，非 WAV 直接 415', async () => {
    settings = {
      provider: 'local',
      modelDir: '/models/sensevoice',
      modelPath: '/models/sensevoice/model.int8.onnx',
      tokensPath: '/models/sensevoice/tokens.txt',
      language: 'zh',
      numThreads: 2,
    };

    expect((await meta()).features).toEqual({ asr: true, asrWav: true });
    expect((await post(new Uint8Array([1]), 'audio/webm')).status).toBe(415);
    expect((await post(new Uint8Array([1]), 'audio/wav')).status).toBe(200);
  });

  it('讯飞模式：meta 要求 WAV，非 WAV 直接 415', async () => {
    settings = {
      provider: 'iflytek',
      appId: 'app-id',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      language: 'zh_cn',
    };

    expect((await meta()).features).toEqual({ asr: true, asrWav: true });
    expect((await post(new Uint8Array([1]), 'audio/webm')).status).toBe(415);
    expect((await post(new Uint8Array([1]), 'audio/wav')).status).toBe(200);
  });

  it('类型不对 415，空音频 400，太大 413', async () => {
    expect((await post('hello', 'text/plain')).status).toBe(415);
    expect((await post(new Uint8Array(0), 'audio/webm')).status).toBe(400);
    expect(
      (await post(new Uint8Array(MAX_AUDIO_BYTES + 1), 'audio/webm')).status,
    ).toBe(413);
  });

  it('没配置 503，并且 meta 说没有这个能力', async () => {
    settings = undefined;
    expect((await meta()).features.asr).toBe(false);
    expect((await post(new Uint8Array([1]), 'audio/webm')).status).toBe(503);
  });

  it('上游失败 502；超长文本按 MAX_MESSAGE 截断', async () => {
    transcribe = async () => {
      throw new Error('upstream down');
    };
    expect((await post(new Uint8Array([1]), 'audio/webm')).status).toBe(502);

    transcribe = async () => ({ text: 'x'.repeat(MAX_MESSAGE + 10) });
    const response = await post(new Uint8Array([1]), 'audio/webm');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };
    expect(body.text).toHaveLength(MAX_MESSAGE);
  });

  it('同一用户并发时第二条被挡住，第一条照常完成', async () => {
    let release!: () => void;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    transcribe = async () => {
      startedResolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { text: '好' };
    };

    const first = post(new Uint8Array([1]), 'audio/webm');
    await started;
    expect((await post(new Uint8Array([2]), 'audio/webm')).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it('GET 不接受', async () => {
    expect((await fetch(`${base}/api/asr`)).status).toBe(405);
  });
});
