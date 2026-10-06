// packages/engine/src/plan/plan.ts
//
// The PURE plan stage: (ScopeParams, CapabilityProfile, TargetPack) → a BundlePlan
// that is a complete, deterministic blueprint of what to generate. No I/O, no LLM,
// no Math.random/Date.now (asOf injected). Same inputs ⇒ byte-identical plan.
//
// Responsibilities (target-agnostic):
//   - validate the scenario mix against the pack's declared scenarios
//   - clamp requested volume to the live record budget (and flag it)
//   - apportion volume across scenarios to EXACT integer counts
//   - assign each unit a sub-seed + sampled variability traits (industry, band, …)
//   - resolve the Data Cloud branch from scope + profile

import {
  type ScopeParams,
  type CapabilityProfile,
  type TargetPack,
  type DcMode,
  type Rng,
  BundlePlan,
  makeRng,
  seedFromString,
  deriveSeed,
  assignByMix,
  expandCounts,
} from "@dataseed/core";

/**
 * Spread a weighted dimension's values across N units PROPORTIONAL to weight (largest-remainder
 * apportionment), then deterministically shuffle the assignment. Replaces an iid per-unit weighted
 * draw so a SMALL foreground sample SPANS the dimension's values — multiple deal-size bands, regions —
 * instead of clustering (the realism audit's "amounts all in one band; an $8K deal ran a full enterprise
 * saga" tell). Strictly more representative of the declared distribution than iid for small N; for large N
 * it converges to the same distribution. Deterministic in `rng`.
 */
function stratifiedAssign(values: { value: string; weight: number }[], n: number, rng: Rng): string[] {
  if (n <= 0 || values.length === 0) return [];
  const total = values.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return Array.from({ length: n }, () => values[0]!.value);
  // Largest-remainder: floor each value's exact quota, then hand the leftover slots to the biggest remainders.
  const exact = values.map((v) => (Math.max(0, v.weight) / total) * n);
  const counts = exact.map((e) => Math.floor(e));
  let assigned = counts.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => ({ i, rem: e - Math.floor(e) })).sort((a, b) => b.rem - a.rem);
  for (let k = 0; assigned < n; k++, assigned++) counts[order[k % order.length]!.i]!++;
  const pool: string[] = [];
  counts.forEach((c, i) => {
    for (let j = 0; j < c; j++) pool.push(values[i]!.value);
  });
  return rng.shuffle(pool);
}

function resolveSeed(seed: ScopeParams["seed"]): number {
  return typeof seed === "string" ? seedFromString(seed) : seed >>> 0;
}

function resolveWithDc(dc: DcMode, profile: CapabilityProfile): boolean {
  if (dc === "on") return true;
  if (dc === "off") return false;
  return !!profile.dataCloud?.available; // auto → follow the org
}

/** The largest sales-rep User pool a demo org realistically needs — bounds alias/role uniqueness + license burn. */
const MAX_USER_POOL = 50;

/**
 * Resolve the requested User-pool size against the org (mirrors resolveWithDc). 0 unless the request
 * opts in AND the org exposes the User object — then clamp to [1, MAX_USER_POOL]. NOTE: `present` is the
 * only object-level signal the profile carries (it's ~always true for the standard User object), so this
 * is a courtesy gate, NOT real protection — the genuine safety net is that OwnerId is a soft lookup, so
 * a license-tight org that can't actually seat the pool degrades cleanly to running-user ownership.
 */
function resolveUserPoolSize(scope: ScopeParams, profile: CapabilityProfile): number {
  if (scope.userPoolSize <= 0) return 0;
  const userPresent = profile.objects.find((o) => o.apiName === "User")?.present ?? (profile.objects.length === 0); // fail-open on an empty profile
  if (!userPresent) return 0;
  return Math.min(MAX_USER_POOL, scope.userPoolSize);
}

export function planBundle(
  scope: ScopeParams,
  profile: CapabilityProfile,
  pack: TargetPack,
  asOf: string,
): BundlePlan {
  // 1. Scenario membership is the pack's vocabulary; core only checked the sum=100.
  const unknown = Object.keys(scope.scenarioMix).filter((s) => !pack.scenarios.includes(s));
  if (unknown.length) {
    throw new Error(`scenarioMix references scenarios not in pack "${pack.id}": ${unknown.join(", ")} (valid: ${pack.scenarios.join(", ")})`);
  }

  const rootSeed = resolveSeed(scope.seed);

  // 2. Clamp foreground volume to the live record budget.
  const requestedVolume = scope.volume;
  let volume = requestedVolume;
  let budgetCapped = false;
  if (profile.recordBudget != null && pack.recordsPerUnitEstimate > 0) {
    const maxUnits = Math.floor(profile.recordBudget / pack.recordsPerUnitEstimate);
    if (maxUnits < volume) {
      volume = Math.max(0, maxUnits);
      budgetCapped = true;
    }
  }

  // 2b. Plan the background/bulk population (cheaper per entity), clamped to the budget LEFT after
  // foreground volume. A pack without recordsPerPopulationUnitEstimate has no bulk tier → population 0.
  // The per-account cost = the structural base + the wider-graph delta scaled by bulkDensity (Phase 4E),
  // so a denser run clamps to fewer accounts and the budget tracks the knob.
  const baseBulk = pack.recordsPerPopulationUnitEstimate ?? 0;
  const bulkEstimate = baseBulk + scope.bulkDensity * (pack.recordsPerPopulationUnitFullDensityDelta ?? 0);
  let population = baseBulk > 0 ? scope.population : 0;
  if (population > 0 && profile.recordBudget != null) {
    const remaining = Math.max(0, profile.recordBudget - volume * pack.recordsPerUnitEstimate);
    const maxBulk = Math.floor(remaining / bulkEstimate);
    if (maxBulk < population) {
      population = Math.max(0, maxBulk);
      budgetCapped = true;
    }
  }

  // 2c. Resolve the shared sales-rep User pool (profile-gated, clamped). A shared once-seeded catalog
  // (like products/campaigns), so it adds a FLAT term to the estimate — not a per-account multiplier.
  const userPoolSize = population > 0 ? resolveUserPoolSize(scope, profile) : 0;

  // 3. Exact integer apportionment across scenarios.
  const scenarioCounts = assignByMix(volume, scope.scenarioMix);
  const flat = expandCounts(scenarioCounts); // length === volume

  // 4. Per-unit blueprint: sub-seed + sampled traits. Each variability dimension is STRATIFIED across the
  // foreground units (proportional spread, not iid) so a small demo spans bands/regions instead of clustering;
  // the per-unit sub-seed still drives all downstream generation (order-independent, byte-stable).
  const dims = Object.keys(pack.variability);
  const traitRng = makeRng(rootSeed).derive("traits");
  const dimAssign: Record<string, string[]> = {};
  for (const dim of dims) {
    dimAssign[dim] = stratifiedAssign(
      pack.variability[dim]!.map((v) => ({ value: v.value, weight: v.weight })),
      volume,
      traitRng.derive(dim),
    );
  }
  const units = flat.map((scenario, index) => {
    const seed = deriveSeed(rootSeed, "unit", index);
    const traits: Record<string, string> = {};
    for (const dim of dims) traits[dim] = dimAssign[dim]![index]!;
    return { index, scenario, seed, traits };
  });

  return BundlePlan.parse({
    pack: pack.id,
    mode: scope.mode,
    withDc: resolveWithDc(scope.dc, profile),
    namespacePrefix: profile.namespacePrefix ?? null,
    seed: rootSeed,
    asOf,
    requestedVolume,
    volume,
    population,
    bulkDensity: scope.bulkDensity,
    userPoolSize,
    userProfileName: scope.userProfileName,
    budgetCapped,
    scenarioCounts,
    units,
    // The pool is a flat once-seeded catalog (pool users + a handful of roles), not a per-account cost.
    estimatedRecords: Math.round(volume * pack.recordsPerUnitEstimate + population * bulkEstimate) + userPoolSize,
    perObjectCounts: {},
  });
}
