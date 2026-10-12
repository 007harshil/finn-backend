// Record ids in the same shape the Flutter app generates
// (`prefix_<time36><rand36>`), so server- and client-created records look alike.

import { randomInt } from 'node:crypto';

export interface IdGenerator {
  next(prefix: string): string;
}

export const randomIds: IdGenerator = {
  next(prefix) {
    const time = (BigInt(Date.now()) * 1000n + BigInt(randomInt(0, 1000))).toString(36);
    let rand = '';
    for (let i = 0; i < 6; i++) rand += randomInt(0, 36).toString(36);
    return `${prefix}_${time}${rand}`;
  },
};

/** Deterministic generator for tests: `tx_1`, `tx_2`, ... */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
}
