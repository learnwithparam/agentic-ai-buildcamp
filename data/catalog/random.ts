// A small seeded random number generator. The same seed always gives the same numbers,
// so every learner gets the same data and the same golden answers.

const UINT32_RANGE = 2 ** 32;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

// Noise around 1.0, for example 0.08 gives numbers between 0.92 and 1.08.
export function noiseAround(random: () => number, spread: number): number {
  return 1 + (random() * 2 - 1) * spread;
}

// Dates are plain text like 2026-11-20. Adding days keeps them in that form.
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}
