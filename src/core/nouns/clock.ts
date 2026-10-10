import type { ClockNoun } from '../../contract/engine';

export function createClockNoun(): ClockNoun {
  return { now: () => Date.now() };
}
