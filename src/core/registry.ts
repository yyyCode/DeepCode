import { tierIndex, type Tier } from '../contract/tier';
import type { EventHook } from '../contract/plugin';

export type Registration = {
  readonly plugin: string;
  readonly tier: Tier;
  readonly pattern: string;
  readonly matcher?: Record<string, unknown>;
  readonly hook: EventHook;
  /**
   * 插件装载顺序：该插件**第一次**注册时分配，之后不再变。
   * 同 tier 内先按它排，把同一个插件的 hook 聚成一组 —— 见 hooksFor。
   */
  readonly pluginOrder: number;
  /** 同一插件内多次注册按注册顺序嵌套，先注册者在最外层。 */
  readonly seq: number;
};

/**
 * pattern 匹配：精确名 / `*` / `noun.*` / 取反 `!pattern`。
 * 取反是给 glob hook 用的：`on('!tool.*', ...)` 表示"除工具调用外的所有事件"。
 */
export function matchesPattern(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return !matchesPattern(pattern.slice(1), event);
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

/** matcher 是浅比较：`{ tool: 'Read' }` 只对 `e.tool === 'Read'` 的调用生效。 */
export function matchesMatcher(
  matcher: Record<string, unknown> | undefined,
  e: Record<string, unknown>,
): boolean {
  if (!matcher) return true;
  return Object.entries(matcher).every(([key, value]) => e[key] === value);
}

/**
 * 链上的权威序：tier 由外到内 → 同 tier 内按插件装载顺序 → 同插件内按注册先后。
 *
 * `hooksFor`（决定**谁先应答**）与 `matcherOwner`（决定**这个工具是谁的**）
 * 共用它 —— 两处对"谁是第一个"必须是同一个答案，各写一份迟早会漂。
 */
function byChainOrder(a: Registration, b: Registration): number {
  return (
    tierIndex(a.tier) - tierIndex(b.tier) ||
    a.pluginOrder - b.pluginOrder ||
    a.seq - b.seq
  );
}

export class Registry {
  private readonly regs: Registration[] = [];
  private seq = 0;
  /** plugin → 装载顺序。Map 的 size 天然是"下一个空位"，不需要第二个计数器。 */
  private readonly pluginOrders = new Map<string, number>();

  register(input: {
    plugin: string;
    tier: Tier;
    pattern: string;
    matcher?: Record<string, unknown>;
    hook: EventHook;
  }): Registration {
    const reg: Registration = {
      ...input,
      pluginOrder: this.orderOf(input.plugin),
      seq: this.seq++,
    };
    this.regs.push(reg);
    return reg;
  }

  private orderOf(plugin: string): number {
    const known = this.pluginOrders.get(plugin);
    if (known !== undefined) return known;
    const assigned = this.pluginOrders.size;
    this.pluginOrders.set(plugin, assigned);
    return assigned;
  }

  all(): readonly Registration[] {
    return this.regs;
  }

  /**
   * 取某事件的 hook，按 tier 由外到内；**同 tier 内按插件装载顺序分组**，
   * 同插件内按注册先后。三级键的顺序不能换：tier 是权威序，比"谁先注册"更高。
   *
   * 中间那一级不是装饰。少了它，一个插件运行期懒注册的 hook 会插到别的插件后面去，
   * 而"同 plugin 先注册者最外层"这条规则就只在"所有插件一次性注册完"时成立 ——
   * 那是个碰巧，不是个保证。
   */
  hooksFor(event: string, e: Record<string, unknown>): readonly Registration[] {
    return this.regs
      .filter((r) => matchesPattern(r.pattern, event) && matchesMatcher(r.matcher, e))
      .sort(byChainOrder);
  }

  /**
   * 某个 matcher 取值**是谁的** —— 插件名。没人注册 → `undefined`。
   *
   * 键序与 `hooksFor` 完全一样（`byChainOrder`），因为这里要回答的是
   * "**谁在应答它**"，不是"谁碰过它"：`tool.call {tool:'Write'}` 是**一条链**，
   * `session-changes` 与 `tool-write` 都挂在上面 —— 报第一个（最外层、先应答的那个）
   * 才有意义，报"最后注册的那个"是错的。
   */
  matcherOwner(pattern: string, key: string, value: string): string | undefined {
    const owner = this.regs
      .filter((r) => r.pattern === pattern && r.matcher?.[key] === value)
      .sort(byChainOrder)[0];
    return owner?.plugin;
  }

  /**
   * 撤回某个插件的全部注册，返回撤掉的条数。
   *
   * 给第三方插件的 `uses` 越界用：越界即**整个插件不装**（设计 §4.3）。
   * 只丢越界那一条的话，插件里其余部分会半死不活地继续生效 ——
   * 而人对"我写了五条规则"的心智模型是"要么都生效要么都不生效"。
   *
   * `pluginOrders` 里那个槽位**不动**：它只是个排序序号，留着不影响别人；
   * 而且同一个插件也不会再注册了 —— 它的 `on` 已经被封。
   */
  revoke(plugin: string): number {
    let removed = 0;
    for (let i = this.regs.length - 1; i >= 0; i--) {
      if (this.regs[i]?.plugin === plugin) {
        this.regs.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 从注册面反推某类 matcher 的取值集合。
   * `$.tool.list()` 与 `$.command.list()` 靠它实现 —— 工具是自己注册进来的，
   * 不是内核里的一张硬编码表。
   */
  matcherValues(pattern: string, key: string): readonly string[] {
    const seen = new Set<string>();
    for (const r of this.regs) {
      if (r.pattern !== pattern) continue;
      const value = r.matcher?.[key];
      if (typeof value === 'string') seen.add(value);
    }
    return [...seen];
  }
}
