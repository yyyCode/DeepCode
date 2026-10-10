import { tierIndex, type Tier } from '../contract/tier';
import type { EventHook } from '../contract/plugin';

export type Registration = {
  readonly plugin: string;
  readonly tier: Tier;
  readonly pattern: string;
  readonly matcher?: Record<string, unknown>;
  readonly hook: EventHook;
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

export class Registry {
  private readonly regs: Registration[] = [];
  private seq = 0;

  register(input: {
    plugin: string;
    tier: Tier;
    pattern: string;
    matcher?: Record<string, unknown>;
    hook: EventHook;
  }): Registration {
    const reg: Registration = { ...input, seq: this.seq++ };
    this.regs.push(reg);
    return reg;
  }

  all(): readonly Registration[] {
    return this.regs;
  }

  /** 取某事件的 hook，按 tier 由外到内、同 tier 按注册先后排序。 */
  hooksFor(event: string, e: Record<string, unknown>): readonly Registration[] {
    return this.regs
      .filter((r) => matchesPattern(r.pattern, event) && matchesMatcher(r.matcher, e))
      .sort((a, b) => tierIndex(a.tier) - tierIndex(b.tier) || a.seq - b.seq);
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
