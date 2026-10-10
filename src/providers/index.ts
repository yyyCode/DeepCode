import type { ModelProvider, ProviderKind } from '../contract/model-provider';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai'];

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

export type ProviderSettings = {
  readonly provider: ProviderKind;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
};

/** 只做一次分派。事件链与 agent loop 对换后端这件事一无所知。 */
export function createProvider(settings: ProviderSettings): ModelProvider {
  return settings.provider === 'openai'
    ? createOpenAIProvider(settings)
    : createAnthropicProvider(settings);
}
