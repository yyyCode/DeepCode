import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderKind } from '@deepcode/contract/model-provider';
import { isProviderKind, type ProviderSettings } from '@deepcode/providers';

/** 与 CLI 相同的默认模型；~/.deepcode/config.json 或环境变量会覆盖它。 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_PROVIDER: ProviderKind = 'anthropic';

type FileConfig = {
  apiKey?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  provider?: unknown;
  asr?: unknown;
};

/** OpenAI 兼容的 /audio/transcriptions 配置。与聊天模型分开：语音端点不是每个文本端点都有。 */
export type RemoteAsrSettings = {
  readonly provider: 'openai';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly language: string;
};

/** 进程内 SenseVoice：模型目录里放 model.int8.onnx（或 model.onnx）与 tokens.txt。 */
export type LocalAsrSettings = {
  readonly provider: 'local';
  readonly modelDir: string;
  readonly modelPath: string;
  readonly tokensPath: string;
  readonly language: string;
  readonly numThreads: number;
};

/** 讯飞极速录音转写：文件上传 + 任务轮询。 */
export type IflytekAsrSettings = {
  readonly provider: 'iflytek';
  readonly appId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** 控制 create 任务的 language_type：zh_cn 走自动中英，en_us 只识别英文。 */
  readonly language: 'zh_cn' | 'en_us';
};

export type AsrSettings = RemoteAsrSettings | LocalAsrSettings | IflytekAsrSettings;

const ASR_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ASR_DEFAULT_MODEL = 'whisper-1';
const ASR_DEFAULT_LANGUAGE = 'zh';
const ASR_DEFAULT_LOCAL_DIR = ['sensevoice-small-int8'];
const ASR_DEFAULT_NUM_THREADS = 2;
const ASR_MAX_NUM_THREADS = 8;
const LOCAL_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);

/** 读用户级配置。没有文件就是空对象；文件坏了就说清楚是哪个文件。 */
async function readFileConfig(home: string): Promise<FileConfig> {
  const path = join(home, '.deepcode', 'config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`读不了 ${path}：${(error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('顶层必须是一个对象');
    }
    return parsed as FileConfig;
  } catch (error) {
    throw new Error(`${path} 不是合法配置：${(error as Error).message}`);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 解析 provider 配置。优先级：环境变量 > ~/.deepcode/config.json > 默认值。
 *
 * 与 `@deepcode/cli` 的 config 读取有一小段重复。那边带着写入、托管层与字段拒绝，
 * 为四个字段拆共享包不划算 —— 等第二个「也要写配置」的消费者出现再抽。
 */
export async function resolveProviderSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSettings> {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const file = await readFileConfig(home);

  const apiKey =
    text(env.DEEPCODE_API_KEY) ?? text(env.ANTHROPIC_API_KEY) ?? text(file.apiKey);
  const model = text(env.DEEPCODE_MODEL) ?? text(file.model) ?? DEFAULT_MODEL;
  const baseUrl = text(env.DEEPCODE_BASE_URL) ?? text(file.baseUrl);
  const providerRaw = text(env.DEEPCODE_PROVIDER) ?? text(file.provider) ?? DEFAULT_PROVIDER;

  if (!isProviderKind(providerRaw)) {
    throw new Error(
      `provider 只能是 ${['anthropic', 'openai'].join(' / ')}，收到的是 ${String(providerRaw)}`,
    );
  }
  if (apiKey === undefined) {
    throw new Error(
      '没有配置 API key。设置环境变量 DEEPCODE_API_KEY，或写入 ~/.deepcode/config.json 的 "apiKey"。',
    );
  }

  return {
    provider: providerRaw,
    apiKey,
    model,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `~/models` 在 Windows 上也要认；相对路径按当前工作目录解析。 */
function expandHome(value: string, home: string): string {
  if (value === '~') return resolve(home);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(join(home, value.slice(2)));
  }
  return resolve(value);
}

async function resolveLocalModel(
  modelDirRaw: string,
  home: string,
): Promise<{ modelDir: string; modelPath: string; tokensPath: string }> {
  const modelDir = expandHome(modelDirRaw, home);
  const int8Path = join(modelDir, 'model.int8.onnx');
  const fp32Path = join(modelDir, 'model.onnx');
  const modelPath = (await exists(int8Path))
    ? int8Path
    : (await exists(fp32Path))
      ? fp32Path
      : undefined;
  const tokensPath = join(modelDir, 'tokens.txt');

  if (modelPath === undefined || !(await exists(tokensPath))) {
    throw new Error(
      `本地 ASR 模型不完整：${modelDir} 里需要 model.int8.onnx（或 model.onnx）和 tokens.txt。` +
        '运行 pnpm --filter @deepcode/companion asr:model 下载默认模型。',
    );
  }

  return { modelDir, modelPath, tokensPath };
}

/** 讯飞文件转写只认 zh_cn；英文通过 language_type=3 表达。 */
function iflytekLanguage(value: string | undefined): 'zh_cn' | 'en_us' {
  if (value === undefined) return 'zh_cn';
  const normalized = value.toLowerCase();
  if (normalized === 'auto' || normalized === 'zh' || normalized === 'zh_cn') {
    return 'zh_cn';
  }
  if (normalized === 'en' || normalized === 'en_us') return 'en_us';
  throw new Error(
    `讯飞 ASR 的 language 只能是 auto / zh / zh_cn / en / en_us，收到的是 ${value}`,
  );
}

function numThreads(value: unknown): number {
  if (value === undefined || value === '') return ASR_DEFAULT_NUM_THREADS;
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > ASR_MAX_NUM_THREADS
  ) {
    throw new Error(
      `ASR 的 numThreads 必须是 1 到 ${ASR_MAX_NUM_THREADS} 的整数，收到的是 ${String(value)}`,
    );
  }
  return parsed;
}

/**
 * 解析语音识别配置。**没有 apiKey（远程）或模型目录（本地）就是没开启**，
 * 前端据此隐藏麦克风。
 *
 * 优先级与聊天配置一致：环境变量 > ~/.deepcode/config.json > 默认值。
 * ASR 单独放一个 `asr` 对象，不和聊天模型的字段混用 —— DeepSeek 这类文本端点
 * 并没有 /audio/transcriptions，拿它的 key 去发音频只会得到 404。
 *
 * 显式 `provider: "local"` 时 apiKey 不需要；不写 provider 时沿用旧行为：
 * 有 apiKey 就是 openai，有 modelDir 就是 local，两者都没有则关闭。
 */
export async function resolveAsrSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AsrSettings | undefined> {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const file = await readFileConfig(home);

  const raw = file.asr;
  let asr: Record<string, unknown> = {};
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('~/.deepcode/config.json 里的 "asr" 必须是一个对象');
    }
    asr = raw as Record<string, unknown>;
  }

  const apiKey = text(env.DEEPCODE_ASR_API_KEY) ?? text(asr.apiKey);
  const appId = text(env.DEEPCODE_ASR_APP_ID) ?? text(asr.appId);
  const apiSecret = text(env.DEEPCODE_ASR_API_SECRET) ?? text(asr.apiSecret);
  const modelDirRaw = text(env.DEEPCODE_ASR_MODEL_DIR) ?? text(asr.modelDir);
  const providerRaw = text(env.DEEPCODE_ASR_PROVIDER) ?? text(asr.provider);
  const languageRaw = text(env.DEEPCODE_ASR_LANGUAGE) ?? text(asr.language);
  const language = languageRaw ?? ASR_DEFAULT_LANGUAGE;

  let provider: 'openai' | 'local' | 'iflytek';
  if (providerRaw === undefined) {
    // 同时有 appId + apiSecret 时按讯飞；只有 key 的老配置仍按 OpenAI。
    if (appId !== undefined && apiSecret !== undefined) provider = 'iflytek';
    else if (apiKey !== undefined) provider = 'openai';
    else if (modelDirRaw !== undefined) provider = 'local';
    else return undefined;
  } else if (
    providerRaw === 'openai' ||
    providerRaw === 'local' ||
    providerRaw === 'iflytek'
  ) {
    provider = providerRaw;
  } else {
    throw new Error(
      `ASR 的 provider 只能是 openai / local / iflytek，收到的是 ${providerRaw}`,
    );
  }

  if (provider === 'iflytek') {
    if (appId === undefined || apiKey === undefined || apiSecret === undefined) {
      throw new Error(
        'ASR provider 是 iflytek，但缺少 appId / apiKey / apiSecret。' +
          '设置 DEEPCODE_ASR_APP_ID、DEEPCODE_ASR_API_KEY、DEEPCODE_ASR_API_SECRET，' +
          '或写进 ~/.deepcode/config.json 的 "asr"。',
      );
    }
    return {
      provider: 'iflytek',
      appId,
      apiKey,
      apiSecret,
      language: iflytekLanguage(languageRaw),
    };
  }

  if (provider === 'local') {
    if (!LOCAL_LANGUAGES.has(language)) {
      throw new Error(
        `本地 ASR 的 language 只能是 ${[...LOCAL_LANGUAGES].join(' / ')}，收到的是 ${language}`,
      );
    }
    const dir = modelDirRaw ?? join(home, '.deepcode', 'models', 'asr', ...ASR_DEFAULT_LOCAL_DIR);
    const model = await resolveLocalModel(dir, home);
    return {
      provider: 'local',
      ...model,
      language,
      numThreads: numThreads(
        text(env.DEEPCODE_ASR_NUM_THREADS) ?? asr.numThreads,
      ),
    };
  }

  if (apiKey === undefined) {
    throw new Error(
      'ASR provider 是 openai，但没有配置 apiKey。设置 DEEPCODE_ASR_API_KEY 或 ~/.deepcode/config.json 的 "asr.apiKey"。',
    );
  }

  const baseUrl =
    text(env.DEEPCODE_ASR_BASE_URL) ?? text(asr.baseUrl) ?? ASR_DEFAULT_BASE_URL;
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`ASR 的 baseUrl 不是合法 URL：${baseUrl}`);
  }

  return {
    provider: 'openai',
    apiKey,
    baseUrl,
    model: text(env.DEEPCODE_ASR_MODEL) ?? text(asr.model) ?? ASR_DEFAULT_MODEL,
    language,
  };
}
