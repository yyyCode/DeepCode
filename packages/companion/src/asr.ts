import type { RemoteAsrSettings } from './config';

/**
 * 浏览器 MediaRecorder 能产出的几种容器。OpenAI 兼容端点按扩展名判断格式，
 * 所以这里是「Content-Type → 文件名后缀」的唯一映射；不在表里的类型直接拒绝，
 * 免得把一段无法识别的字节丢给上游。
 *
 * Safari 走 audio/mp4，Chrome/Edge/Firefox 走 audio/webm，两者都在表里。
 */
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
};

/** 去掉 `;codecs=opus` 之类的参数，只按主类型判断。 */
export function audioExtension(mimeType: string): string | undefined {
  const base = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return AUDIO_EXTENSIONS[base];
}

export type AsrInput = {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly signal: AbortSignal;
};

export type AsrProvider = {
  readonly name: string;
  /** 服务端整体等待上限；不写就用 60 秒。讯飞文件版需要更久。 */
  readonly timeoutMs?: number;
  transcribe(input: AsrInput): Promise<{ readonly text: string }>;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 本地运行时/模型没准备好。服务端把它翻译成 503，而不是上游失败 502。 */
export class AsrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrUnavailableError';
  }
}

/**
 * OpenAI 兼容的语音转写：`POST {baseUrl}/audio/transcriptions`，multipart 里放
 * `file`、`model`、可选的 `language`。Whisper、SiliconFlow、自建的
 * faster-whisper-server 大多都认这一套。
 *
 * `fetchImpl` 只为测试注入：生产直接用 Node 22 自带的 fetch。
 */
export function createOpenAiAsrProvider(
  settings: RemoteAsrSettings,
  fetchImpl: FetchLike = fetch,
): AsrProvider {
  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  return {
    name: 'openai-compatible',

    async transcribe({ audio, mimeType, signal }) {
      const extension = audioExtension(mimeType);
      if (extension === undefined) {
        throw new Error(`不支持的音频类型：${mimeType}`);
      }

      const form = new FormData();
      form.append('file', new Blob([audio], { type: mimeType }), `audio.${extension}`);
      form.append('model', settings.model);
      if (settings.language.trim() !== '') form.append('language', settings.language.trim());
      form.append('response_format', 'json');

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: form,
        signal,
      });

      if (!response.ok) {
        // 只截一小段上游说明，够定位问题；不把整个响应体丢进日志或客户端。
        const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
        throw new Error(
          `ASR 服务返回 ${response.status}${detail === '' ? '' : `：${detail}`}`,
        );
      }

      const data: unknown = await response.json();
      if (
        data === null ||
        typeof data !== 'object' ||
        typeof (data as { text?: unknown }).text !== 'string'
      ) {
        throw new Error('ASR 服务返回的内容里没有 text');
      }

      return { text: (data as { text: string }).text.trim() };
    },
  };
}
