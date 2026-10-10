/** core 落到一个只声明未实现的事件时抛出。被 dispatch 捕获后降级，同一事件名只警告一次。 */
export class NotImplementedError extends Error {
  constructor(event: string) {
    super(`event not implemented in MVP: ${event}`);
    this.name = 'NotImplementedError';
  }
}

/** 某个 hook 超过 HOOK_BUDGET.ms 时抛出，用来把它从链上摘掉。 */
export class BudgetExceeded extends Error {
  constructor(ms: number) {
    super(`hook exceeded budget of ${ms}ms`);
    this.name = 'BudgetExceeded';
  }
}

/** pending 的 hook 超时后不等于停止运行 —— 只要没人 await 它的结果，它的副作用仍会继续。MVP 接受这一点。 */
export function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
