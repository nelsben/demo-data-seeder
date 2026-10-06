// packages/core/src/sample.ts
//
// Sampling/apportionment primitives the plan + generate stages build on, layered
// on the deterministic RNG (lib/rng.ts). Two flavors:
//   - apportion / assignByMix are PURE (no rng): a percentage mix → exact integer
//     counts that sum to the total (largest-remainder / Hamilton method). Plan math
//     must be reproducible AND exact — 34/33/33 of 12 must total 12, never 11 or 13.
//   - backdateIso / spreadDates manufacture realistic timestamps from an injected
//     `asOf` (never Date.now), so signal cadence drives the velocity classifier
//     (Dark/Stalling/Accelerating/Steady) instead of every record landing "today".

import type { Rng } from "./rng.js";

const DAY_MS = 86_400_000;

/**
 * Apportion an integer `total` across buckets weighted by `weights`, returning
 * integer counts that sum EXACTLY to total (Hamilton largest-remainder). Ties in
 * the remainder break toward the earlier index (deterministic). Zero/negative
 * total ⇒ all zeros; all-zero weights ⇒ even-ish spread by index.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const t = Math.max(0, Math.floor(total));
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (t === 0) return new Array(n).fill(0);
  if (sum <= 0) {
    // no signal in weights → spread as evenly as possible, remainder to earliest indices
    const base = Math.floor(t / n);
    const out = new Array(n).fill(base);
    for (let i = 0; i < t - base * n; i++) out[i]!++;
    return out;
  }
  const exact = weights.map((w) => (Math.max(0, w) / sum) * t);
  const floors = exact.map((x) => Math.floor(x));
  let remaining = t - floors.reduce((a, b) => a + b, 0);
  // distribute the leftover to the largest fractional remainders (ties → lower index)
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) out[order[k]!.i]!++;
  return out;
}

/**
 * Apportion `total` units across NAMED buckets by their weights (e.g. a
 * scenarioMix `{at-risk-budget:34, healthy-tech:33, rfp-gated:33}` over 12 units →
 * exact integer counts summing to 12). Key order is preserved for determinism.
 */
export function assignByMix(total: number, mix: Readonly<Record<string, number>>): Record<string, number> {
  const keys = Object.keys(mix);
  const counts = apportion(total, keys.map((k) => mix[k]!));
  const out: Record<string, number> = {};
  keys.forEach((k, i) => (out[k] = counts[i]!));
  return out;
}

/** Expand named counts into a flat, deterministic list (e.g. {a:2,b:1} → ['a','a','b']). */
export function expandCounts(counts: Readonly<Record<string, number>>): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(k);
  return out;
}

/** `asOf` minus `daysAgo` days as an ISO 8601 string. Pure (asOf injected, never Date.now). */
export function backdateIso(asOf: string, daysAgo: number): string {
  const base = new Date(asOf).getTime();
  return new Date(base - Math.round(daysAgo * DAY_MS)).toISOString();
}

export interface SpreadOpts {
  /** How many days back the earliest timestamp may fall. */
  spanDays: number;
  /** Bias: 'accelerating' clusters recent, 'stalling' clusters old, 'steady' uniform. */
  shape?: "steady" | "accelerating" | "stalling";
}

/**
 * Produce `count` backdated ISO timestamps within [asOf - spanDays, asOf], jittered
 * by the rng and returned oldest-first. The `shape` biases clustering so the
 * downstream velocity classifier reads the intended trajectory.
 */
export function spreadDates(rng: Rng, asOf: string, count: number, opts: SpreadOpts): string[] {
  const { spanDays, shape = "steady" } = opts;
  if (count <= 0) return [];
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    // base position in [0,1], 0 = oldest, 1 = newest
    let p = count === 1 ? 0.5 : i / (count - 1);
    if (shape === "accelerating") p = 1 - (1 - p) * (1 - p); // concave → mass toward NEWER (rising cadence)
    else if (shape === "stalling") p = p * p; // convex → mass toward OLDER (recent gap / going quiet)
    const jitter = (rng.next() - 0.5) * (1 / Math.max(count, 2)); // ± part of one gap
    const clamped = Math.min(1, Math.max(0, p + jitter));
    const daysAgo = (1 - clamped) * spanDays;
    points.push(daysAgo);
  }
  return points
    .sort((a, b) => b - a) // oldest (largest daysAgo) first
    .map((d) => backdateIso(asOf, d));
}
