import type { AgentSpawnRequest, AgentSpawnResult } from './agent';
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

export type SessionNoun = {
  id(): string;
  cwd(): string;
  root(): string;
  /** 会话级 AbortSignal：用户 Ctrl-C 时触发，用来掐断正在跑的外部命令。 */
  signal(): AbortSignal;
};

export type ToolNoun = {
  /**
   * **注册面**的名字：谁注册了 `tool.call {tool: X}`。
   * 子代理的白名单（`cli/subagents.ts` 的 `resolveTools`）吃它 —— 那里要的正是这个。
   * 模型真正能用的是它的子集，那一份在 `core/tool-list.ts`（P9 §3.1）。
   */
  list(): readonly string[];
  /**
   * 这个工具**是谁注册的**（插件名）。没人注册 → `undefined`。
   *
   * 报的是"**谁在应答它**"（链上最外层那个），不是"谁碰过它" —— `tool.call` 是一条链，
   * 一个名字可以有多个注册者。它在第三方插件被强制 `append` 座位这个结构下
   * 只可能是内建与第一方，所以**它不是安全边界，只是一条信息**（P9 §2.2）。
   */
  origin(name: string): string | undefined;
};

export type CommandNoun = { list(): readonly string[] };

export type ModelNoun = { stream(req: Parameters<ModelProvider['stream']>[0]): AsyncIterable<StreamEvent> };

/**
 * 子代理名词。
 *
 * **插件拿不到 `dispatch`**（hook 签名是 `($, e, next)`），而"跑一个内层 turn"
 * 必须要它 —— 所以这只能是名词。与 `$.model.stream` 同一个先例：
 * 名词是"内核能力的直接实现，不是事件"（MVP 设计 §10 偏差 5）。
 */
export type AgentNoun = {
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>;
};

/**
 * 技能名词：把正文过一遍 `skill.prompt` 这道缝。
 *
 * 这一对名词是"插件拿不到 dispatch"这条约束的**全部**代价：内核为此多开两个口子，
 * 而不是把 dispatch 漏给插件。
 */
export type SkillNoun = {
  load(req: { readonly name: string; readonly text: string }): Promise<{ readonly text: string }>;
};

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
  readonly agent: AgentNoun;
  readonly skill: SkillNoun;
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
