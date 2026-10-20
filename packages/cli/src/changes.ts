import { resolve } from 'node:path';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { Plugin } from '@deepcode/contract/plugin';

/**
 * 一次文件快照。`skipped` 是"拿不到内容但也不该崩"的那一类 ——
 * 太大、是目录、读不动都退化成它，绝不让工具调用因为记录而挂掉。
 */
export type Snapshot =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'skipped'; readonly why: string };

export type FileChange = {
  /** 已 resolve 的绝对路径。 */
  readonly path: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
};

export type SessionChanges = {
  record(change: FileChange): void;
  list(): readonly FileChange[];
  size(): number;
};

/**
 * 文件超过这个大小就不读内容（只留一个 skipped 标记）。
 * MVP 设计没有路径围栏，模型完全可能写到一个几百 MB 的文件上 ——
 * 把两边都读进内存是能把进程干掉的事。读之前先 stat，别先读再判大小。
 */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

export function createSessionChanges(): SessionChanges {
  // key 是 resolve 后的绝对路径。Map 的插入顺序就是"第一次改动"的顺序，
  // 比按文件名排更有信息量 —— `/diff` 因此按用户实际改动的先后列出。
  const byPath = new Map<string, FileChange>();

  return {
    record(change) {
      const previous = byPath.get(change.path);
      if (!previous) {
        byPath.set(change.path, change);
        return;
      }
      // 同一路径的多次改动合并成一条：保留第一次的 before、用最后一次的 after，
      // `/diff` 看到的是"这一整场会话对这个文件的净改动"。
      // （Map.set 改已有键不会挪动插入位置，所以"第一次改动"的顺序仍保住。）
      byPath.set(change.path, { path: change.path, before: previous.before, after: change.after });
    },
    list() {
      return [...byPath.values()];
    },
    size() {
      return byPath.size;
    },
  };
}

/**
 * 挂在 `tool.call` 上的**外层** hook（`Write` / `Edit` 各一条）。
 *
 * 顺序约束：它必须排在 coreTools **前面**（见 cli/plugins.ts）。同 tier 内先装载者在外层，
 * 而它要在 tool-write 自己的 hook 跑之前抢到文件的原样 —— 晚一步，`next` 回来时文件
 * 已经写完了，`before` 就成了 `after` 的副本，`/diff` 永远空白。
 *
 * 记录方式刻意不去改 Write/Edit 工具：工具不需要知道"会话改动"这回事，
 * P3 换一批工具这里一行不用动。
 */
export function createChangesPlugin(changes: SessionChanges): Plugin {
  return {
    name: 'session-changes',
    uses: ['tool.call', 'fs'],

    register(on) {
      for (const tool of ['Write', 'Edit'] as const) {
        on('tool.call', { tool }, async ($, e, next) => {
          const target = filePathOf(e.input);
          if (target === undefined) return next(e);

          const path = resolve(target);
          // 必须先读 before 再 next：next 回来的时候文件已经写完了。
          const before = await snapshot($, path);
          const result = await next(e);
          // 只记成功。失败（含"覆盖已有文件前必须先 Read"那道拦截）不留痕迹，
          // 否则 `/diff` 会显示一堆没发生过的改动。
          if (!isFailure(result)) {
            changes.record({ path, before, after: await snapshot($, path) });
          }
          return result;
        });
      }
    },
  };
}

/** `input.file_path` 是非空字符串才认；其余一律当作"没有目标路径"。 */
function filePathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const filePath = (input as { readonly file_path?: unknown }).file_path;
  return typeof filePath === 'string' && filePath !== '' ? filePath : undefined;
}

/**
 * `tool.call` 的失败约定（见 loop.ts 的 runOneTool）：
 * - 不是对象 → 失败（hook 返回了 undefined 之类）；
 * - `{ deny }` → 工具根本没执行（未知工具 / 被拒绝）；
 * - `{ value: 'ERROR: ...' }` → 工具执行了但报了错。
 * 三种都不是"改动发生了"，一条都不该记。
 */
function isFailure(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return true;
  const r = result as { readonly value?: unknown; readonly deny?: unknown };
  if (typeof r.deny === 'string') return true;
  return typeof r.value === 'string' && r.value.startsWith('ERROR:');
}

/**
 * 读一份快照，**绝不抛**。读不动、太大、是目录都退化成 `skipped`，
 * 而不是让工具调用崩掉。
 */
async function snapshot($: EngineInterface, path: string): Promise<Snapshot> {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'absent' };

    const info = await $.fs.stat(path);
    if (info.isDirectory) return { kind: 'skipped', why: '是目录' };
    // 先看 size 再决定读不读：超限的文件不读进内存。
    if (info.size > MAX_SNAPSHOT_BYTES) return { kind: 'skipped', why: '文件太大' };

    return { kind: 'text', text: await $.fs.read(path) };
  } catch {
    return { kind: 'skipped', why: '读不动' };
  }
}
