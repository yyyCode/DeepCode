import { createRequire } from 'node:module';
import type { LocalAsrSettings } from './config';
import {
  AsrUnavailableError,
  audioExtension,
  type AsrInput,
  type AsrProvider,
} from './asr';
import { MAX_SECONDS, parseWav, TARGET_RATE } from './asr-audio';

export { parseWav } from './asr-audio';

type SherpaStream = {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
};

type SherpaResult = { readonly text?: unknown };

type SherpaRecognizer = {
  createStream(): SherpaStream;
  decodeAsync?(stream: SherpaStream): Promise<SherpaResult>;
  decode?(stream: SherpaStream): void;
  getResult?(stream: SherpaStream): SherpaResult;
};

type SherpaRecognizerClass = {
  new (config: unknown): SherpaRecognizer;
  createAsync?(config: unknown): Promise<SherpaRecognizer>;
};

type SherpaModule = { OfflineRecognizer: SherpaRecognizerClass };

export type RecognizerFactory = (
  settings: LocalAsrSettings,
) => Promise<SherpaRecognizer>;

const require = createRequire(import.meta.url);

function loadSherpa(): SherpaModule {
  try {
    return require('sherpa-onnx-node') as SherpaModule;
  } catch (error) {
    throw new AsrUnavailableError(
      `本地语音识别运行时不可用（sherpa-onnx-node）：${(error as Error).message.slice(0, 300)}`,
    );
  }
}

async function loadRecognizer(settings: LocalAsrSettings): Promise<SherpaRecognizer> {
  const sherpa = loadSherpa();
  const config = {
    featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: settings.modelPath,
        language: settings.language,
        useInverseTextNormalization: 1,
      },
      tokens: settings.tokensPath,
      numThreads: settings.numThreads,
      provider: 'cpu',
      debug: 0,
    },
  };

  try {
    const Recognizer = sherpa.OfflineRecognizer;
    if (typeof Recognizer.createAsync === 'function') {
      return await Recognizer.createAsync(config);
    }
    return new Recognizer(config);
  } catch (error) {
    throw new AsrUnavailableError(
      `本地 ASR 模型加载失败：${(error as Error).message.slice(0, 300)}`,
    );
  }
}

async function decode(
  recognizer: SherpaRecognizer,
  stream: SherpaStream,
): Promise<SherpaResult> {
  if (typeof recognizer.decodeAsync === 'function') {
    return recognizer.decodeAsync(stream);
  }
  if (
    typeof recognizer.decode === 'function' &&
    typeof recognizer.getResult === 'function'
  ) {
    recognizer.decode(stream);
    return recognizer.getResult(stream);
  }
  throw new AsrUnavailableError('本地识别运行时缺少 decode 接口');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('已取消');
  error.name = 'AbortError';
  throw error;
}

/**
 * SenseVoice 走进程内 sherpa-onnx。第一次识别时才加载模型；同一时刻只解码一段，
 * 避免多个请求争用同一个 recognizer。模型缺失或运行时没装好会抛
 * `AsrUnavailableError`，由服务端返回 503。
 */
export function createLocalAsrProvider(
  settings: LocalAsrSettings,
  recognizerFactory: RecognizerFactory = loadRecognizer,
): AsrProvider {
  let recognizerPromise: Promise<SherpaRecognizer> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const getRecognizer = (): Promise<SherpaRecognizer> => {
    if (recognizerPromise === undefined) {
      recognizerPromise = recognizerFactory(settings).catch((error: unknown) => {
        // 模型可能是后装的；失败不缓存，下次请求再试。
        recognizerPromise = undefined;
        throw error;
      });
    }
    return recognizerPromise;
  };

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  return {
    name: 'local-sensevoice',

    async transcribe({ audio, mimeType, signal }: AsrInput) {
      if (audioExtension(mimeType) !== 'wav') {
        throw new Error('本地识别只接受 WAV 音频');
      }

      const samples = parseWav(audio);
      if (samples.length === 0) throw new Error('没有识别到音频');
      if (samples.length > TARGET_RATE * MAX_SECONDS) {
        throw new Error(`音频超过 ${MAX_SECONDS} 秒`);
      }

      return exclusive(async () => {
        throwIfAborted(signal);
        const recognizer = await getRecognizer();
        throwIfAborted(signal);

        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: TARGET_RATE });
        const result = await decode(recognizer, stream);
        throwIfAborted(signal);

        const text = typeof result.text === 'string' ? result.text : '';
        return { text: text.replace(/<\|[^|]*\|>/g, '').trim() };
      });
    },
  };
}
