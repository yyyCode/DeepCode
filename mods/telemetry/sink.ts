import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  formatRow,
  telemetryPath,
  validateEntry,
  type TelemetryEntry,
  type TelemetryRow,
} from './rows';

/**
 * 遥测的写盘面 —— 全项目**第二处**直接写文件的地方（第一处是转录）。
 *
 * IO 全部注入（`append` / `mkdir` / `now`）：于是"关掉时零输出"这条能被测
 * （用一个会抛的 `mkdir` 断言它根本没被调用），而不是靠读代码相信。
 *
 * ⚠️ 与转录同一条取向、但**更硬**：遥测坏掉不该让会话坏掉，所以写失败只吭一声、
 * 之后再不重试。差别在于转录那边一条 `onError` 只管打日志，这里连"要不要打"
 * 都由 sink 自己记着（否则每个批次都会刷一次屏）。
 */

/** 缓冲多少行冲一次。够小，一次会话里能落几批；够大，不至于每记一条就一次系统调用。 */
export const BATCH_SIZE = 20;

export type TelemetrySink = {
  /** 记一条。**同步返回** —— 它挂在链上，不该让任何一次工具调用等磁盘。 */
  record(entry: TelemetryEntry): void;
  /** 把缓冲区写下去。`session.end` 与测试用。 */
  flush(): Promise<void>;
  readonly stats: {
    readonly written: number;
    readonly rejected: number;
    readonly lastReject: string | undefined;
    readonly lastError: string | undefined;
    readonly path: string;
  };
};

export type TelemetrySinkDeps = {
  readonly home: string;
  readonly enabled: boolean;
  readonly warn: (line: string) => void;
  /** 测试注入用；生产省略。 */
  readonly mkdir?: (path: string) => Promise<void>;
  readonly append?: (path: string, text: string) => Promise<void>;
  readonly now?: () => Date;
};

export function createTelemetrySink(deps: TelemetrySinkDeps): TelemetrySink {
  const path = telemetryPath(deps.home);
  const doMkdir = deps.mkdir ?? (async (dir: string) => void (await mkdir(dir, { recursive: true })));
  // `mode: 0o600` 只在文件**被创建**那一次生效（与转录同一个写法与同一个理由）：
  // 遥测里是行为记录，POSIX 上这是免费的保险（Windows 基本忽略，但不吃亏）。
  const doAppend =
    deps.append ??
    (async (file: string, text: string) => void (await appendFile(file, text, { mode: 0o600 })));
  const now = deps.now ?? (() => new Date());

  let buffer: string[] = [];
  let written = 0;
  let rejected = 0;
  let lastReject: string | undefined;
  let lastError: string | undefined;
  /** 目录建过了没。只在第一次真要写的时候建。 */
  let prepared = false;
  let complainedReject = false;
  let complainedWrite = false;
  let seq = 0;

  const flush = async (): Promise<void> => {
    // 关掉时**一个系统调用都不发**：连 mkdir 都不许调到（出口标准 4）。
    if (!deps.enabled) return;
    if (buffer.length === 0) return;
    const text = buffer.join('');
    // 缓冲先清空、游标先推进：即便这次写失败也不重试这一批 ——
    // 否则失败会永久堵住后续所有的记录（与转录那边同一个理由）。
    buffer = [];

    try {
      if (!prepared) {
        // 目录只在第一次真要写的时候建 —— "关掉时零输出"那条测的就是它有没有被调到。
        await doMkdir(dirname(path));
        prepared = true;
      }
      await doAppend(path, text);
      written += text.split('\n').length - 1;
    } catch (error) {
      lastError = String(error);
      if (!complainedWrite) {
        complainedWrite = true;
        deps.warn(`遥测写不进去（${path}）：${lastError} —— 会话照常，之后不再提。`);
      }
    }
  };

  return {
    record(entry: TelemetryEntry): void {
      if (!deps.enabled) return;

      const result = validateEntry(entry);
      if (!result.ok) {
        rejected += 1;
        lastReject = result.reason;
        // 只在第一次响：一条规则写错了会被每一次工具调用带上，每次都喊就是刷屏。
        if (!complainedReject) {
          complainedReject = true;
          deps.warn(`遥测丢了一条记录：${result.reason} —— 之后同类的不再提。`);
        }
        return;
      }

      seq += 1;
      const row: TelemetryRow = { at: now().toISOString(), seq, kind: result.kind, fields: result.fields };
      buffer.push(formatRow(row));
      // 满了就冲，**不 await** —— 挂在链上的这一手不该让工具调用等磁盘。
      if (buffer.length >= BATCH_SIZE) void flush();
    },

    flush,

    get stats() {
      return { written, rejected, lastReject, lastError, path };
    },
  };
}
