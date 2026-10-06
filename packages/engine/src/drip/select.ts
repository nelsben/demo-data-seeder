// packages/engine/src/drip/select.ts
//
// The drip's DAY PLAN: which open deals get a new beat today. Deterministic — same
// (seed, day, candidates) always yields the same picks, so a re-run of the same day (before any
// insert happens) previews identically and a scheduler can safely retry. Pure: takes the candidate
// list the op already read from the org (candidates.ts), never queries anything itself.
//
// Preference order: OLDEST last-interaction date first (the deal that's gone quietest is the one
// that most needs a touch), weighted by the deal's ARC — an arc whose story wants regular motion
// (at-risk-budget escalating, a churn risk needing attention) outranks one that's meant to read
// quiet most days (stalled-portfolio — see beats.ts's "2 days in 3" gate, which independently skips
// authoring even on a day it WAS selected). A small seeded jitter breaks exact ties deterministically
// without ever overriding the recency/arc ordering (kept two orders of magnitude below one day of
// weighted recency, even at the lowest arc weight, so it can only settle a genuine tie).

import type { DripCandidate } from "./types.js";

/** Per-arc "does this story want regular motion?" weight. Arcs not listed get the default (1.0) — an
 *  unrecognized/reconstructed-with-no-origin ("unknown") arc is treated as neutral, never penalized. */
const ARC_MOTION_WEIGHT: Record<string, number> = {
  "at-risk-budget": 1.2,
  "churning-account": 1.15,
  "healthy-tech": 1.1,
  "rfp-gated": 1.0,
  "stalled-portfolio": 0.5, // paired with beats.ts's independent "quiet 2 days in 3" gate
};
const DEFAULT_ARC_WEIGHT = 1.0;

export function arcMotionWeight(arc: string): number {
  return ARC_MOTION_WEIGHT[arc] ?? DEFAULT_ARC_WEIGHT;
}

/** Whole days between an ISO date/timestamp and the plan day (clamped ≥ 0 — a candidate with a
 *  future-looking timestamp, e.g. bad data, never gets a negative "very fresh" score). */
function daysSince(iso: string, day: string): number {
  const from = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** Deterministic FNV-1a-derived fraction in [0, 1) for (seed, day, oppId) — same inputs, same output,
 *  every process/platform (no Math.random, no Date.now). Used only as a sub-day tiebreak. */
export function seededFraction(seed: string | number, ...parts: string[]): number {
  const input = `${seed}|${parts.join("|")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export interface SelectDayPlanOptions {
  seed: string | number;
  /** ISO date (YYYY-MM-DD) — "today". */
  day: string;
  /** Max deals to pick (the op's --accounts, default 3). */
  accounts: number;
}

/** Pick today's deals: score = daysSinceLastInteraction × arcMotionWeight + a sub-1-day seeded jitter
 *  (so it can only break ties, never reorder around a whole day of real recency), sorted descending,
 *  final tiebreak by oppId so the ordering is total even on an exact score tie. Never returns more
 *  than `opts.accounts`, and returns [] for accounts ≤ 0 or no candidates. */
export function selectDayPlan(candidates: readonly DripCandidate[], opts: SelectDayPlanOptions): DripCandidate[] {
  const n = Math.max(0, Math.floor(opts.accounts));
  if (n === 0 || candidates.length === 0) return [];

  const scored = candidates.map((c) => {
    const recency = daysSince(c.lastInteractionDate, opts.day);
    const weight = arcMotionWeight(c.arc);
    const jitter = seededFraction(opts.seed, opts.day, c.oppId) * 0.005; // tiebreak only — never a day's worth of weight
    return { c, score: recency * weight + jitter };
  });

  scored.sort((a, b) => b.score - a.score || a.c.oppId.localeCompare(b.c.oppId));
  return scored.slice(0, n).map((s) => s.c);
}
