import type { Backend, BackendWords, PaneEntry, PaneFileHunks } from './backend';
import type { DiffLine } from './lines';

/**
 * pane 的**模型** —— 全是纯数据（P5 设计 §5.2，抄自 `03-mod-diff.md:388`）。
 *
 * 三条性质，每条都有用例：
 *
 * 1. **不可变**：所有字段 `readonly`，派生只走纯函数，没有一处就地改。
 *    于是"同一份改动算两次，模型逐字节相同"是可以断言的（§5.3 判据三）。
 * 2. **颜色不在里面**：哪一行是 add / del 是**数据**，怎么上色是 `packages/cli/src/diff-render.ts`
 *    的事。这个 mod 连 `Palette` 这三个字都不许出现（边界规则）。
 * 3. **退化是模型的一个**字段**，不是一次异常**：`detailed` + `why` 让"我只看了一眼摘要"
 *    与"我看清了每一行"在下游分得开 —— 而 `lines: null` 说的是**没算过**，
 *    不是"没有改动"。这两个混起来，用户会把"没算"读成"没改"。
 */

/**
 * 逐文件算 hunk 的**文件数**上限。超过就只给总数与文件名。
 *
 * 参考实现那一档是 `MAX_FILES_FOR_DETAILS(500)`（`03-mod-diff.md:351`），我们取 50：
 * 我们**没有**噪声文件折叠（见计划"刻意不做"），而一个终端里 50 个文件的逐行 diff
 * 已经没人看得完了。阈值小一点，退化那条路才会真的被走到 —— 一条永远走不到的路
 * 等于没有。
 */
export const FILE_LIMIT = 50;

export type PaneFile = {
  readonly path: string;
  readonly status: PaneEntry['status'];
  /** 逐文件 hunk。退化时是 `null` —— **没算过**，不是"没有改动"。 */
  readonly lines: readonly DiffLine[] | null;
  /** `lines` 为 `null` 时说明为什么看不了（"文件太大"之类）。 */
  readonly why?: string;
};

export type PaneSection = {
  readonly title: string;
  readonly files: readonly PaneFile[];
};

export type PaneModel = {
  /** 哪个后端答的（`git`）。纯报告用 —— 渲染器拿它写表头。 */
  readonly backend: string;
  /** 表头的第一句（`工作区改动` / `工作区干净`）。 */
  readonly headline: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  /** 逐文件算过没有。退化时 `false`，那时上两个数字是 0 —— 看这里，别看 0 猜。 */
  readonly detailed: boolean;
  /** 退化时要说给用户的那句人话；没退化是 `undefined`。 */
  readonly why?: string;
  readonly sections: readonly PaneSection[];
};

export type PaneDeps = {
  readonly backend: Backend;
};

/**
 * 表头那几个数字，**从文件列表派生**。
 *
 * 纯函数的意义：渲染几次都不会变，而"同一份改动 → 同一份模型"这条判据
 * 正是靠"所有可变的都从不变的那一份推"来成立的。
 */
export function headerTotalsOf(files: readonly PaneFile[]): {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const line of file.lines ?? []) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'del') removed++;
    }
  }
  return { files: files.length, added, removed };
}

/**
 * 看得清的和只剩名字的。纯函数，**不改变顺序** —— 谁先谁后是后端的判定，
 * 这里只按位置切一刀。
 */
export function partitionOf(
  files: readonly PaneFile[],
): { readonly shown: readonly PaneFile[]; readonly rest: number } {
  return {
    shown: files.slice(0, FILE_LIMIT),
    rest: Math.max(0, files.length - FILE_LIMIT),
  };
}

/**
 * 向一个后端要一块 pane。
 *
 * ⚠️ **性能闸就在下面那个 `if` 的位置上**，这是本文件最重要的一行：
 *
 * ```
 *   list()   ← 便宜：只问"有几个文件、各是什么状态"
 *      ↓  超阈值就**到此为止**
 *   hunks()  ← 贵：一次子进程把所有文件的逐行改动读回来
 * ```
 *
 * **先取小再决定要不要取大**（§5.2）。把 `if` 挪到 `hunks()` 之后，行为上"看不出来"
 * —— 输出还是退化的样子，只是白跑了一次最贵的调用，而一个改了 600 个文件的仓库
 * 会因此卡住好几秒。所以那一条得由测试钉住（见 `test/pane.test.ts` 第 5 条：
 * 退化时 `hunks` 里放一个 `throw`，跑通即算过）。
 */
export async function buildPane(deps: PaneDeps): Promise<PaneModel> {
  const { backend } = deps;
  const words = backend.words;

  const entries = await backend.list();
  if (entries.length === 0) {
    return {
      backend: words.name,
      headline: words.clean,
      files: 0,
      added: 0,
      removed: 0,
      detailed: true,
      sections: [],
    };
  }

  if (entries.length > FILE_LIMIT) return degradedPane(words, entries);

  const hunks = await backend.hunks(entries.map((entry) => entry.path));
  return detailedPane(words, entries, hunks);
}

function fileOf(entry: PaneEntry, hunks: readonly PaneFileHunks[]): PaneFile {
  const found = hunks.find((hunk) => hunk.path === entry.path);
  // 后端没提这个文件（`hunks` 漏了一格）时，按"没算过"报，**不按"没改动"报**：
  // 前者会让人去查，后者会让人以为这就是全部。
  if (found === undefined) {
    return { path: entry.path, status: entry.status, lines: null, why: '后端没有给出这个文件' };
  }
  return {
    path: entry.path,
    status: entry.status,
    lines: found.lines,
    ...(found.why === undefined ? {} : { why: found.why }),
  };
}

function detailedPane(
  words: BackendWords,
  entries: readonly PaneEntry[],
  hunks: readonly PaneFileHunks[],
): PaneModel {
  const files = entries.map((entry) => fileOf(entry, hunks));
  const totals = headerTotalsOf(files);
  return {
    backend: words.name,
    headline: '工作区改动',
    ...totals,
    detailed: true,
    sections: [{ title: '工作区未提交', files }],
  };
}

/**
 * 退化的那一份：**只给总数与文件名**，`lines` 全是 `null`。
 *
 * 刻意不填 `added` / `removed`：那两个数要算就得跑最贵的那个调用，而退化的理由
 * 正是"文件太多，不值得跑"。填 0 是**编**，填 `null` 是"没算"。
 * 于是模型里它们保持 0，而 `detailed: false` 是读的人该看的那个字。
 */
function degradedPane(words: BackendWords, entries: readonly PaneEntry[]): PaneModel {
  const files: PaneFile[] = entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    lines: null,
    why: '文件太多，没逐文件算改动',
  }));
  return {
    backend: words.name,
    headline: '工作区改动',
    files: files.length,
    added: 0,
    removed: 0,
    detailed: false,
    why: words.degraded(files.length, FILE_LIMIT),
    sections: [{ title: '工作区未提交', files }],
  };
}
