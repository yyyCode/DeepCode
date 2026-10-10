import type { CoreEngineInterface, ModelProvider } from '../../contract/engine';
import type { Registry } from '../registry';
import { createClockNoun } from './clock';
import { createFsNoun } from './fs';
import { createLoggerNoun } from './logger';
import { createProcessNoun } from './process';
import { createStoreNoun } from './store';
import { createUiNoun, type UiSink } from './ui';

export type CoreNounsDeps = {
  provider: ModelProvider;
  ui: UiSink;
  sessionInfo: { id: string; cwd: string; root: string };
  env: NodeJS.ProcessEnv;
};

/**
 * registry 是第二个参数而不是 deps 的字段：它由 createEngine 自建，
 * 调用方（cli/main.ts）不该也不可能有它。
 */
export function createCoreNouns(deps: CoreNounsDeps, registry: Registry): CoreEngineInterface {
  return {
    session: {
      id: () => deps.sessionInfo.id,
      cwd: () => deps.sessionInfo.cwd,
      root: () => deps.sessionInfo.root,
    },
    // 工具清单不是硬编码表：它来自注册面上 `tool.call` 的 matcher 取值。
    tool: { list: () => registry.matcherValues('tool.call', 'tool') },
    command: { list: () => registry.matcherValues('command.run', 'name') },
    model: { stream: (req) => deps.provider.stream(req) },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    clock: createClockNoun(),
    ui: createUiNoun(deps.ui),
    logger: createLoggerNoun(deps.env),
  };
}
