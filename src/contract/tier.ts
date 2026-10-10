/**
 * tier 权威序：越靠外权威越高。
 *
 * prepend > user > append > builtin > core
 *
 * MVP 实际只有 builtin（内建插件）与 core（内核）两层落座，其余三层留空给 P2。
 * 但五个常量与比较函数必须一次到位 —— 否则 P2 的 sec-default 守门器会推倒重来。
 */
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const;

export type Tier = (typeof TIERS)[number];

/** next.to() 的合法目标：不能向上跳，因此排除 prepend 与 user。 */
export type TargetTier = Exclude<Tier, 'prepend' | 'user'>;

const OUTERMOST_FIRST: Record<Tier, number> = {
  prepend: 0,
  user: 1,
  append: 2,
  builtin: 3,
  core: 4,
};

/** a 是否比 b 更靠外（权威更高）。 */
export function isOuterThan(a: Tier, b: Tier): boolean {
  return OUTERMOST_FIRST[a] < OUTERMOST_FIRST[b];
}

/** 用于排序：数字越小越靠外。 */
export function tierIndex(t: Tier): number {
  return OUTERMOST_FIRST[t];
}
