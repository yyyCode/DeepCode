import type { CoreEngineInterface, EngineInterface, ModelProvider } from '../../contract/engine';
import type { Registry } from '../registry';
import type { DispatchFn } from '../dispatch';
import { createAgentNoun } from './agent';
import { createClockNoun } from './clock';
import { createFsNoun } from './fs';
import { createLoggerNoun } from './logger';
import { createProcessNoun } from './process';
import { createSkillNoun } from './skill';
import { createStoreNoun } from './store';
import { createUiNoun, type UiSink } from './ui';

export type CoreNounsDeps = {
  provider: ModelProvider;
  ui: UiSink;
  sessionInfo: { id: string; cwd: string; root: string };
  env: NodeJS.ProcessEnv;
  /**
   * 会话 signal 的**工厂**，不是 signal 本身。
   *
   * 一个 AbortSignal 一旦 abort 就再也回不去。若在构造时就把一个 signal 定死，
   * 用户按一次 Ctrl-C 之后，往后每个 turn 都会拿着一个已经 aborted 的 signal 去
   * fetch —— 于是第一次中断就永久废掉整个会话，而 loop 那边还在说
   * "会话保留，可以继续输入"。传工厂、每个 turn 现取一个，中断才等于"掐断这一次"。
   */
  signal: () => AbortSignal;
};

export type CoreNounsRefs = {
  /**
   * 延迟取 `$`。
   *
   * 它要到 `createEngine` 的折叠完成之后才存在 —— 而 `agent` 名词要在内层跑一轮，
   * 那一轮必须拿**折叠后**的 `$`（引擎自己的 hook 那时才都挂上去了），
   * 不是 `createCoreNouns` 手里这份还只有内核名词的半成品。
   * 与 `DispatcherDeps.engine`（core/dispatch.ts:19）同一个形状、同一条理由。
   */
  readonly engine: () => EngineInterface;
  /** 同理：dispatch 也是 createEngine 建完才有的。 */
  readonly dispatch: () => DispatchFn;
};

/**
 * `registry` 与 `refs` 是第二、第三个参数而不是 deps 的字段：两者都由 createEngine 自建，
 * 调用方（cli/main.ts）不该也不可能有它们。
 */
export function createCoreNouns(
  deps: CoreNounsDeps,
  registry: Registry,
  refs: CoreNounsRefs,
): CoreEngineInterface {
  return {
    session: {
      id: () => deps.sessionInfo.id,
      cwd: () => deps.sessionInfo.cwd,
      root: () => deps.sessionInfo.root,
      signal: deps.signal,
    },
    // 工具清单不是硬编码表：它来自注册面上 `tool.call` 的 matcher 取值。
    tool: { list: () => registry.matcherValues('tool.call', 'tool') },
    command: { list: () => registry.matcherValues('command.run', 'name') },
    model: { stream: (req) => deps.provider.stream(req) },
    agent: createAgentNoun({
      engine: refs.engine,
      provider: deps.provider,
      signal: deps.signal,
      dispatch: refs.dispatch,
    }),
    skill: createSkillNoun({ dispatch: refs.dispatch }),
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    clock: createClockNoun(),
    ui: createUiNoun(deps.ui),
    logger: createLoggerNoun(deps.env),
  };
}
