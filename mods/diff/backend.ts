import type { ModDeps } from '@deepcode/contract/mod';

/**
 * 后端抽象三层（P5 设计 §5.2，抄自 `03-mod-diff.md:384`）。
 *
 * 存在的理由只有一句话：**"git 只是默认实现"这句话要从一开始就成立。**
 * 等第二个 VCS 来了再抽，git 的名字已经渗进每一处调用点了 —— 而那正是参考实现
 * 特意先把这三层立起来的原因。
 *
 * 三层各管一件事：
 * - `BackendProbe`：**这台机器有没有它**（要能回答"没有"，然后 graceful 退场）；
 * - `BackendWords`：它对**人**说的话（"这不是一个 git 仓库"只有 git 会说）；
 * - `Backend`：两个调用 —— 便宜的与贵的。
 */

/** 一条改动。`status` 用 git 那套词，但**不是** git 的类型：别的后端照这个填。 */
export type PaneEntry = {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'untracked';
};

/** 一个文件算出来的增删行。`lines` 为 `null` = **没算**（太大 / 二进制），不是"没改动"。 */
export type PaneFileHunks = {
  readonly path: string;
  readonly lines: readonly { readonly kind: 'context' | 'del' | 'add'; readonly text: string }[] | null;
  readonly why?: string;
};

/**
 * 这个后端对**人**说的话。
 *
 * 单列一层而不是散在 `Backend` 里，是因为它与"怎么跑 git"无关，只与"怎么说人话"有关 ——
 * 换一个 VCS 时这一层整个换掉，那两段调用一个字不用动。
 */
export type BackendWords = {
  /** 后端名，出现在表头上（`工作区改动 · git`）。 */
  readonly name: string;
  /** 这块地方干净（没有未提交改动）。 */
  readonly clean: string;
  /** 问它逐文件改动、但它给不出（不是仓库 / 头一次提交之前）。 */
  readonly empty: string;
  /** 退化那句话说给**人**听：为什么不逐文件算了。 */
  readonly degraded: (files: number, limit: number) => string;
};

export type Backend = {
  readonly words: BackendWords;
  /**
   * **便宜**的那个：有几个文件、各是什么状态。
   *
   * ⚠️ 它必须先被调用，而且它的结果决定要不要调 `hunks()` —— 那是 §5.2
   * "先取小再决定要不要取大"这句判据的全部落点（闸门在 `pane.ts` 的 `buildPane` 里，
   * 但能这么做的前提是这一个调用足够便宜）。
   */
  list(): Promise<readonly PaneEntry[]>;
  /**
   * **贵**的那个：逐文件 hunk。**只在 `list()` 的结果没超阈值时才该被调用。**
   *
   * `paths` 一次给全，实现要争取一次子进程读完（参考实现 `fetch-hunks` 那条教训；
   * 我们这边是 git 的 pathspec 长度上限决定要不要分批）。
   */
  hunks(paths: readonly string[]): Promise<readonly PaneFileHunks[]>;
};

export type BackendProbe = {
  readonly name: string;
  /** 探针是**注入**的（装到 `ModDep.probe` 上），于是"没有它"能用一个夹具测出来。 */
  readonly probe: (deps: ModDeps) => boolean | Promise<boolean>;
  /** 探针说"有"之后才调它 —— 建后端的过程因此可以假设环境是齐的。 */
  readonly of: (deps: ModDeps) => Backend;
};

/**
 * 探针优先：第一个说"有"的就是它，后面的**根本不被问**（问一个已经有答案的问题只是浪费）。
 *
 * 都不说"有" → `undefined`，调用方降级。这与装载器 `probeOf` 是同一套语义，
 * 但**探针抛异常这一条不同**：装载器把"探针自己坏了"记成 `probe-failed`（那是我们的 bug），
 * 而这里让它**抛出去** —— 咽在这一层，那两种结局就没得分辨了。
 */
export async function backendOf(
  probes: readonly BackendProbe[],
  deps: ModDeps,
): Promise<Backend | undefined> {
  for (const candidate of probes) {
    if (await candidate.probe(deps)) return candidate.of(deps);
  }
  return undefined;
}
