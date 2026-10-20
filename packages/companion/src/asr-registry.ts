import { createOpenAiAsrProvider, type AsrProvider } from './asr';
import { createIflytekAsrProvider } from './asr-iflytek';
import { createLocalAsrProvider } from './asr-local';
import type { AsrSettings } from './config';

/**
 * 厂商注册表。新增一家就加一个分支和对应的 provider 文件；
 * 前端只认 /api/meta 的能力位，不需要知道背后是哪家。
 */
export function createAsrProvider(settings: AsrSettings): AsrProvider {
  switch (settings.provider) {
    case 'openai':
      return createOpenAiAsrProvider(settings);
    case 'local':
      return createLocalAsrProvider(settings);
    case 'iflytek':
      return createIflytekAsrProvider(settings);
  }
}
