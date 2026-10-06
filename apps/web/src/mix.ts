// apps/web/src/mix.ts
//
// Pure scenario-mix helpers shared by the Scope screen (and unit-tested without a
// DOM). The mix must sum to 100 before the server will accept it; the UI shows the
// running total and blocks Preview until it's valid.

export function mixTotal(mix: Record<string, number>): number {
  return Object.values(mix).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

export function mixIsValid(mix: Record<string, number>): boolean {
  const entries = Object.values(mix);
  return entries.length > 0 && entries.every((v) => v >= 0) && Math.abs(mixTotal(mix) - 100) < 0.001;
}

/** An even split across the given scenarios summing to exactly 100 (remainder to the earliest). */
export function evenMix(scenarios: string[]): Record<string, number> {
  const n = scenarios.length;
  const out: Record<string, number> = {};
  if (n === 0) return out;
  const base = Math.floor(100 / n);
  scenarios.forEach((s, i) => (out[s] = base + (i < 100 - base * n ? 1 : 0)));
  return out;
}
