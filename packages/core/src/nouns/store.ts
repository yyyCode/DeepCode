import type { StoreNoun } from '@deepcode/contract/engine';

/** MVP 用内存 Map。落盘与 --resume 是 P1 的事。 */
export function createStoreNoun(): StoreNoun {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}
