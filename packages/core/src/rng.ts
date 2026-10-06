// packages/core/src/rng.ts
//
// Deterministic, seedable RNG for the seeder — promoted to TS (was packages/engine/src/lib/rng.js; moved to core in M2)
// (algorithm UNCHANGED: mulberry32 + FNV-1a deriveSeed). Verified byte-identical
// output to the original by the seed-stability test.
//
// WHY (app-architecture §2, architecture-sketch §2.4/§8): the seeder is
// "deterministic by default" — same --seed + same config ⇒ same org. Every draw
// in the generation path MUST thread through this module. NEVER call
// Math.random() / Date.now() / uuid() in the generation path — those are the
// silent reproducibility-invalidators; the seed-stability test fails on them.
//
// The rng is passed EXPLICITLY as a function argument, never module-global, so
// every pure generator is testable in isolation (app-architecture §2, Mode 1).

/** Weighted-pick item: a value and any positive weight (weights need not sum to 1). */
export interface WeightedItem<T> {
  value: T;
  weight: number;
}

/** The helper-bearing RNG instance the generators consume. */
export interface Rng {
  readonly seed: number;
  /** Next float in [0, 1); advances the stream. */
  next(): number;
  /** Integer in [min, max] INCLUSIVE (swaps args if min > max). */
  int(min: number, max: number): number;
  /** Float in [min, max); defaults to [0, 1). */
  float(min?: number, max?: number): number;
  /** Coin flip; `probabilityTrue` is the chance of true (default 0.5). */
  bool(probabilityTrue?: number): boolean;
  /** Uniformly pick one element; throws on an empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Weighted pick; throws if the list is empty or total weight ≤ 0. */
  weighted<T>(items: ReadonlyArray<WeightedItem<T>>): T;
  /** Fisher-Yates shuffle into a NEW array (does not mutate input). */
  shuffle<T>(arr: readonly T[]): T[];
  /** Pick n distinct elements (clamped to length), order randomized. */
  sample<T>(arr: readonly T[], n: number): T[];
  /** Derive an independent child stream from this seed + label parts. */
  derive(...parts: Array<number | string>): Rng;
}

/**
 * mulberry32 — returns a function yielding the next float in [0, 1) and
 * advancing the internal 32-bit state. Pure given its starting state. Identical
 * output across Node versions/platforms (tiny uint32 state, no deps).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0; // coerce to uint32 so negatives/large ints are safe
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * deriveSeed — fold a root seed plus label parts into a stable uint32 sub-seed
 * (FNV-1a-style mix; cheap, good for stream separation, NOT cryptographic). Same
 * inputs ⇒ same sub-seed, so per-arc/per-record streams are reproducible and
 * independent (adding a draw to one stream never shifts another's output).
 */
export function deriveSeed(rootSeed: number, ...parts: Array<number | string>): number {
  let h = (rootSeed >>> 0) ^ 0x811c9dc5;
  for (const part of parts) {
    const str = String(part);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193); // 32-bit FNV prime
    }
    h ^= 0x2c; // separator so ('ab','c') and ('a','bc') don't collide
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * seedFromString — hash a memorable string to a uint32 root seed
 * (app-architecture §2 "seedFromString" graft). `seedFromString("meridian-q3")`
 * lets a run be named instead of numbered while staying fully deterministic.
 */
export function seedFromString(s: string): number {
  return deriveSeed(0, s);
}

/**
 * makeRng — wrap a mulberry32 stream with the helpers the generators use. The
 * ORDER of helper calls is part of the determinism contract: change the call
 * order and you change the dataset (by design).
 */
export function makeRng(seed = 42): Rng {
  const next = mulberry32(seed);

  function int(min: number, max: number): number {
    if (min > max) [min, max] = [max, min];
    return min + Math.floor(next() * (max - min + 1));
  }

  function float(min = 0, max = 1): number {
    return min + next() * (max - min);
  }

  function bool(probabilityTrue = 0.5): boolean {
    return next() < probabilityTrue;
  }

  function pick<T>(arr: readonly T[]): T {
    if (!arr || arr.length === 0) throw new Error("rng.pick: cannot pick from an empty array");
    return arr[int(0, arr.length - 1)]!;
  }

  function weighted<T>(items: ReadonlyArray<WeightedItem<T>>): T {
    if (!items || items.length === 0) throw new Error("rng.weighted: cannot pick from an empty list");
    let total = 0;
    for (const it of items) total += it.weight;
    if (total <= 0) throw new Error("rng.weighted: total weight must be > 0");
    let roll = next() * total;
    for (const it of items) {
      roll -= it.weight;
      if (roll < 0) return it.value;
    }
    return items[items.length - 1]!.value; // float fallthrough guard
  }

  function shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  function sample<T>(arr: readonly T[], n: number): T[] {
    return shuffle(arr).slice(0, Math.max(0, Math.min(n, arr.length)));
  }

  function derive(...parts: Array<number | string>): Rng {
    return makeRng(deriveSeed(seed, ...parts));
  }

  return { seed, next, int, float, bool, pick, weighted, shuffle, sample, derive };
}

export default makeRng;
