import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { IflytekAsrSettings } from './config';
import {
  audioExtension,
  type AsrInput,
  type AsrProvider,
  type FetchLike,
} from './asr';
import { encodeWav, MAX_SECONDS, parseWav, TARGET_RATE } from './asr-audio';

const UPLOAD_URL = 'https://upload-ost-api.xfyun.cn/file/upload';
const CREATE_URL = 'https://ost-api.xfyun.cn/v2/ost/pro_create';
const QUERY_URL = 'https://ost-api.xfyun.cn/v2/ost/query';
const POLL_INTERVAL_MS = 1_000;
/** 讯飞短音频也要 20 秒左右；排队时会更久，所以比本地/OpenAI 的 60 秒宽。 */
const TIMEOUT_MS = 120_000;

export type IflytekSignedHeaders = {
  readonly date: string;
  readonly digest: string;
  readonly authorization: string;
};

/**
 * 讯飞 HTTP 鉴权：对 host、date、request-line 和 body digest 做 HMAC-SHA256。
 * 每个不同的 host/path 都要重新签，不能复用上传请求的头。
 */
export function signIflytekRequest(input: {
  readonly url: string | URL;
  readonly body: Uint8Array;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly at?: Date;
}): IflytekSignedHeaders {
  const url = new URL(input.url);
  const date = (input.at ?? new Date()).toUTCString();
  const digest = `SHA-256=${createHash('sha256').update(input.body).digest('base64')}`;
  const origin = [
    `host: ${url.host}`,
    `date: ${date}`,
    `POST ${url.pathname}${url.search} HTTP/1.1`,
    `digest: ${digest}`,
  ].join('\n');
  const signature = createHmac('sha256', input.apiSecret)
    .update(origin)
    .digest('base64');

  return {
    date,
    digest,
    authorization:
      `api_key="${input.apiKey}", algorithm="hmac-sha256", ` +
      `headers="host date request-line digest", signature="${signature}"`,
  };
}

type MultipartPart =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly value: Uint8Array;
      readonly filename: string;
      readonly contentType: string;
    };

/**
 * 自己拼 multipart，而不是用 FormData：讯飞的 digest 签的是完整 body，
 * 必须能拿到最终字节。fixed boundary 也让测试可复现。
 */
export function buildMultipartBody(
  parts: readonly MultipartPart[],
  boundary = `----deepcode${randomUUID().replaceAll('-', '')}`,
): { readonly body: Buffer; readonly contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      chunks.push(Buffer.from(part.value));
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`),
      );
      chunks.push(Buffer.from(part.value));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromLattice(lattice: readonly unknown[]): string {
  let text = '';
  for (const segment of lattice) {
    const st = objectOf(objectOf(objectOf(segment)?.json_1best)?.st);
    const rt = Array.isArray(st?.rt) ? st.rt : [];
    for (const sentence of rt) {
      const ws = objectOf(sentence)?.ws;
      if (!Array.isArray(ws)) continue;
      for (const word of ws) {
        const cw = objectOf(word)?.cw;
        if (!Array.isArray(cw)) continue;
        const first = objectOf(cw[0]);
        if (typeof first?.w !== 'string' || first.w === '') continue;
        // 英文分词会拆成多个 w；中文之间不补空格，标点前后也不补。
        if (
          text !== '' &&
          /[A-Za-z0-9]$/.test(text) &&
          /^[A-Za-z0-9]/.test(first.w)
        ) {
          text += ' ';
        }
        text += first.w;
      }
    }
  }
  return text;
}

/** 优先用后处理后的 lattice；为空再退回原始 lattice2。 */
export function extractIflytekText(payload: unknown): string {
  const data = objectOf(objectOf(payload)?.data);
  const result = objectOf(data?.result);
  if (result === undefined) return '';
  const lattice = Array.isArray(result.lattice) ? result.lattice : [];
  const lattice2 = Array.isArray(result.lattice2) ? result.lattice2 : [];
  return (textFromLattice(lattice) || textFromLattice(lattice2)).trim();
}

function abortError(): Error {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function bodyJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function responseObject(
  text: string,
  status: number,
  what: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`讯飞 ${what} 返回的不是 JSON（HTTP ${status}）`);
  }
  const record = objectOf(parsed);
  if (record === undefined) {
    throw new Error(`讯飞 ${what} 返回的内容不是对象`);
  }
  if (record.code !== 0) {
    const message =
      typeof record.message === 'string' ? record.message.slice(0, 300) : '未知错误';
    throw new Error(`讯飞 ${what} 失败（code ${String(record.code)}）：${message}`);
  }
  return record;
}

export type IflytekProviderOptions = {
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly requestId?: () => string;
  readonly timeoutMs?: number;
};

/**
 * 讯飞极速录音转写（文件版）：
 * 上传 WAV → 创建任务 → 轮询 task_status 到 3/4 → 拼 lattice 文本。
 *
 * 只接受浏览器转好的 16 kHz 单声道 WAV。服务端再用 `encodeWav` 重写一遍，
 * 避免把 48 kHz / 立体声等浏览器没转干净的输入发给讯飞。
 */
export function createIflytekAsrProvider(
  settings: IflytekAsrSettings,
  fetchImpl: FetchLike = fetch,
  options: IflytekProviderOptions = {},
): AsrProvider {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? wait;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const requestId = options.requestId ?? randomUUID;

  async function post(input: {
    readonly url: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly what: string;
    readonly signal: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const signed = signIflytekRequest({
      url: input.url,
      body: input.body,
      apiKey: settings.apiKey,
      apiSecret: settings.apiSecret,
      at: now(),
    });
    const response = await fetchImpl(input.url, {
      method: 'POST',
      headers: {
        date: signed.date,
        digest: signed.digest,
        authorization: signed.authorization,
        'content-type': input.contentType,
      },
      body: input.body,
      signal: input.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new Error(
        `讯飞 ${input.what} 返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
      );
    }
    return responseObject(text, response.status, input.what);
  }

  async function upload(
    wav: Uint8Array,
    id: string,
    signal: AbortSignal,
  ): Promise<string> {
    const form = buildMultipartBody([
      {
        name: 'data',
        value: wav,
        filename: 'audio.wav',
        contentType: 'audio/wav',
      },
      { name: 'app_id', value: settings.appId },
      { name: 'request_id', value: id },
    ]);
    const payload = await post({
      url: UPLOAD_URL,
      body: form.body,
      contentType: form.contentType,
      what: '上传音频',
      signal,
    });
    const url = objectOf(payload.data)?.url;
    if (typeof url !== 'string' || url === '') {
      throw new Error('讯飞上传音频后没有返回文件地址');
    }
    return url;
  }

  async function createTask(
    audioUrl: string,
    audioSize: number,
    id: string,
    signal: AbortSignal,
  ): Promise<string> {
    const body = bodyJson({
      common: { app_id: settings.appId },
      business: {
        request_id: id,
        // 文档只列了 zh_cn；英文由 language_type=3 指定。
        language: 'zh_cn',
        domain: 'pro_ost_ed',
        accent: 'mandarin',
        language_type: settings.language === 'en_us' ? 3 : 1,
      },
      data: {
        audio_url: audioUrl,
        audio_src: 'http',
        audio_size: audioSize,
        format: 'audio/L16;rate=16000',
        encoding: 'wav',
      },
    });
    const payload = await post({
      url: CREATE_URL,
      body,
      contentType: 'application/json',
      what: '创建转写任务',
      signal,
    });
    const taskId = objectOf(payload.data)?.task_id;
    if (typeof taskId !== 'string' || taskId === '') {
      throw new Error('讯飞创建任务后没有返回 task_id');
    }
    return taskId;
  }

  async function query(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: string; readonly text: string }> {
    const body = bodyJson({
      common: { app_id: settings.appId },
      business: { task_id: taskId },
    });
    const payload = await post({
      url: QUERY_URL,
      body,
      contentType: 'application/json',
      what: '查询转写任务',
      signal,
    });
    const data = objectOf(payload.data);
    const status =
      typeof data?.task_status === 'number' || typeof data?.task_status === 'string'
        ? String(data.task_status)
        : '';
    return { status, text: extractIflytekText(payload) };
  }

  return {
    name: 'iflytek-file',
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,

    async transcribe({ audio, mimeType, signal }: AsrInput) {
      if (audioExtension(mimeType) !== 'wav') {
        throw new Error('讯飞识别只接受 WAV 音频');
      }
      const samples = parseWav(audio);
      if (samples.length === 0) throw new Error('没有识别到音频');
      if (samples.length > TARGET_RATE * MAX_SECONDS) {
        throw new Error(`音频超过 ${MAX_SECONDS} 秒`);
      }

      throwIfAborted(signal);
      const id = requestId();
      const wav = encodeWav(samples);
      const audioUrl = await upload(wav, id, signal);
      throwIfAborted(signal);
      const taskId = await createTask(audioUrl, wav.byteLength, id, signal);

      for (;;) {
        throwIfAborted(signal);
        const result = await query(taskId, signal);
        if (result.status === '3' || result.status === '4') {
          return { text: result.text };
        }
        if (result.status === '1' || result.status === '2') {
          await sleep(pollIntervalMs, signal);
          continue;
        }
        throw new Error(
          result.status === ''
            ? '讯飞查询结果里没有 task_status'
            : `讯飞任务状态异常：${result.status}`,
        );
      }
    },
  };
}
