import type { ClockNoun } from '@deepcode/contract/engine';

export function createClockNoun(): ClockNoun {
  return { now: () => Date.now() };
}
