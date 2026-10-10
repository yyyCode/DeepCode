import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../contract/model-provider';

/**
 * 一次会话的头部，JSONL 文件的第一行。
 * 带着真实的 `cwd`：slug 只是分桶，撞桶之后要靠这一行把别的目录认出来（见 `listTranscripts`）。
 */
export type SessionHeader = {
  readonly type: 'session';
  readonly v: number;
  readonly id: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly model: string;
  readonly provider: string;
};

export type Transcript = { readonly id: string; readonly path: string; readonly header: SessionHeader };

/** 格式版本。将来改结构时靠它择路，现在只写死。 */
const FORMAT_VERSION = 1;

/**
 * cwd 里每个非字母数字字符替换成一个 `-`。`F:\ts\DeepCode` → `F--ts-DeepCode`。
 *
 * **这是分桶，不是身份**：`F:/a` 与 `F:\a` 会落进同一个桶。因此每条转录都记着真实
 * `cwd`，查找时拿它做最终比对 —— 否则会把另一个目录的会话接上来。
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** 某个 cwd 的会话目录：`<home>/.deepcode/projects/<slug>/sessions`。 */
export function sessionsDir(home: string, cwd: string): string {
  return join(home, '.deepcode', 'projects', projectSlug(cwd), 'sessions');
}

/**
 * `20261011-034855-a1b2`：本地时间 + 2 字节随机十六进制。
 *
 * 刻意用本地时间的 `getFullYear()` 那一套，**不用 `toISOString()`** —— 后者是 UTC，
 * 用户按本地时间找会话会差 8 小时（东八区），文件名排序也对不上直觉。
 * 时间戳定长，所以文件名按字典序排就等于时间序。
 */
export function newSessionId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * 建一条新转录：建目录、写头部。头部只在创建时写一次，`--resume` 之后是往同一个文件追加。
 *
 * `mode: 0o600` 只在创建时生效：转录里有代码与文件内容，POSIX 上这是免费的保险
 * （Windows 基本忽略，但不吃亏）。
 */
export async function createTranscript(deps: {
  home: string;
  cwd: string;
  model: string;
  provider: string;
  now?: Date;
}): Promise<Transcript> {
  const now = deps.now ?? new Date();
  const dir = sessionsDir(deps.home, deps.cwd);
  const id = newSessionId(now);
  const path = join(dir, `${id}.jsonl`);
  const header: SessionHeader = {
    type: 'session',
    v: FORMAT_VERSION,
    id,
    cwd: deps.cwd,
    startedAt: now.getTime(),
    model: deps.model,
    provider: deps.provider,
  };

  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  return { id, path, header };
}

/**
 * 返回一个"把整个 messages 递进来、自己算增量"的落盘器。
 *
 * - `alreadySaved` 是"接上的历史已经躺在盘上了，别重写一遍"这次数之后的游标：
 *   第一次喂进来的整个数组里，前 `alreadySaved` 条不再写。
 * - 一次 `appendFile` 写完这一批：崩在中间只坏最后一行，而读取端本来就跳坏行。
 * - **写失败不抛**：转录是便利功能，磁盘满 / home 只读不该把整个会话带走。
 *   但也不能一声不吭，否则用户以为会话存着呢 —— 所以 `onError`（局部 `complained`）
 *   **只喊一次**，避免每个 turn 都刷屏。
 */
export function createPersister(
  transcript: Transcript | undefined,
  alreadySaved: number,
  onError?: (line: string) => void,
): (messages: readonly Message[]) => Promise<void> {
  let written = alreadySaved;
  let complained = false;

  return async (messages: readonly Message[]): Promise<void> => {
    // 没有转录（比如创建就失败、降级继续跑）时是 no-op。
    if (transcript === undefined) return;
    if (messages.length <= written) return;

    const batch = messages.slice(written);
    // 游标先推进：即便这次写失败也不重试这一批 —— 否则失败会永久堵住后续所有落盘。
    written = messages.length;
    const text = batch.map((message) => `${JSON.stringify({ type: 'message', message })}\n`).join('');

    try {
      await appendFile(transcript.path, text);
    } catch (error) {
      if (!complained) {
        complained = true;
        onError?.(`会话无法落盘（${transcript.path}）：${String(error)}`);
      }
    }
  };
}

/**
 * 读一条转录。逐行 `JSON.parse`，**坏行跳过**（最后一行可能被截断）。
 * 第一条 `type === 'session'` 的记录作为头部。
 */
export async function readTranscript(path: string): Promise<{ header?: SessionHeader; messages: Message[] }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { messages: [] };
  }

  const messages: Message[] = [];
  let header: SessionHeader | undefined;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过：半行 JSON 是进程死在写一半时的常态。
    }
    if (record === null || typeof record !== 'object') continue;

    const rec = record as { type?: unknown; message?: unknown };
    if (rec.type === 'session' && header === undefined) {
      header = record as SessionHeader;
    } else if (rec.type === 'message' && 'message' in rec) {
      messages.push(rec.message as Message);
    }
  }

  return header === undefined ? { messages } : { header, messages };
}

/**
 * 列当前目录下的会话，最近的在前（文件名倒序 = 时间倒序）。
 *
 * - 目录不存在返回 `[]`（首次运行是常态，不是错误）。
 * - 跳过**只有头、没有消息**的空壳：启动又立刻退出留下的，接上它没意义。
 * - 跳过 `header.cwd !== cwd` 的：slug 会撞桶，靠这一行把别的目录摘出去。
 *   比对照搬原字符串、不做大小写折叠 —— 把 `F:\TS\DeepCode` 当成 `F:\ts\DeepCode`
 *   接上，比"找不到"更让人困惑。
 */
export async function listTranscripts(home: string, cwd: string): Promise<Transcript[]> {
  const dir = sessionsDir(home, cwd);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files = names.filter((name) => name.endsWith('.jsonl')).sort().reverse();
  const out: Transcript[] = [];
  for (const name of files) {
    const path = join(dir, name);
    const { header, messages } = await readTranscript(path);
    if (header === undefined) continue;
    if (messages.length === 0) continue;
    if (header.cwd !== cwd) continue;
    out.push({ id: header.id, path, header });
  }
  return out;
}

/**
 * 找回一条转录：给了 id 就精确找，没给就取最近的。
 * 找不到返回 `undefined`（怎么措辞、什么退出码由 main 决定）。
 */
export async function findTranscript(deps: {
  home: string;
  cwd: string;
  id?: string;
}): Promise<{ transcript: Transcript; messages: Message[] } | undefined> {
  const transcripts = await listTranscripts(deps.home, deps.cwd);
  const match = deps.id === undefined ? transcripts[0] : transcripts.find((t) => t.id === deps.id);
  if (match === undefined) return undefined;

  const { messages } = await readTranscript(match.path);
  return { transcript: match, messages };
}
