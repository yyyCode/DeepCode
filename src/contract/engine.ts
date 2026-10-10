import type { Message, ModelProvider, StreamEvent, ToolSpec } from './model-provider';

export type UiNoun = {
  log(line: string): void;
  notice(line: string): void;
  ask(question: string): Promise<string>;
};

export type FsNoun = {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<readonly string[]>;
  stat(path: string): Promise<{ readonly size: number; readonly isDirectory: boolean }>;
};

export type ProcessNoun = {
  run(
    command: string,
    opts: { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
};

export type StoreNoun = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
};

export type ClockNoun = { now(): number };

export type LoggerNoun = { debug(line: string): void; warn(line: string): void };

export type SessionNoun = { id(): string; cwd(): string; root(): string };

export type ToolNoun = { list(): readonly string[] };

export type CommandNoun = { list(): readonly string[] };

export type ModelNoun = { stream(req: Parameters<ModelProvider['stream']>[0]): AsyncIterable<StreamEvent> };

/**
 * 内核名词。
 *
 * 注意：MVP 的 $ 是这些名词的**直接实现，不是事件** —— 架构文档里
 * `$.<noun>.<method>()` 本身也是一次 dispatch（OpEventOf，59 个），MVP 把这层省掉了。
 * 代价是 P2 之前无法在最内层拦截 process.run（沙箱的落点）。见设计文档 §10 偏差 5。
 */
export interface CoreEngineInterface {
  readonly session: SessionNoun;
  readonly tool: ToolNoun;
  readonly command: CommandNoun;
  readonly model: ModelNoun;
  readonly fs: FsNoun;
  readonly process: ProcessNoun;
  readonly store: StoreNoun;
  readonly clock: ClockNoun;
  readonly ui: UiNoun;
  readonly logger: LoggerNoun;
}

/**
 * 插件可以通过声明合并往 $ 上加名词（jQuery 往 $.fn 上加东西的做法）：
 *
 *   declare module '../contract/engine' {
 *     interface EngineInterface { telemetry: Telemetry }
 *   }
 */
export interface EngineInterface extends CoreEngineInterface {}

export type { Message, ToolSpec, StreamEvent, ModelProvider };
