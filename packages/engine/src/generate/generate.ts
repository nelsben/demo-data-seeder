// packages/engine/src/generate/generate.ts
//
// The generate stage: drive the pack's generate() over the plan, assemble the
// NarrativeBundle, and backfill the plan's actual per-object counts. PURE — the
// rng is seeded from plan.seed, so (plan ⇒ bundle) is deterministic. The engine
// never knows what an Account is; the pack builds the records.

import {
  type CapabilityProfile,
  type ScopeParams,
  type TargetPack,
  type BundlePlan,
  type AccountIdentity,
  NarrativeBundle,
  makeRng,
} from "@dataseed/core";
import { planBundle } from "../plan/plan.js";

/** Assemble a NarrativeBundle from a pack's generate() output (shared by the with/without-identities paths). */
function assembleBundle(plan: BundlePlan, out: ReturnType<TargetPack["generate"]>): NarrativeBundle {
  const perObjectCounts: Record<string, number> = {};
  for (const [obj, recs] of Object.entries(out.records)) perObjectCounts[obj] = recs.length;
  const actualRecords = Object.values(perObjectCounts).reduce((a, b) => a + b, 0);

  return NarrativeBundle.parse({
    config: out.config,
    records: out.records,
    copyRequests: out.copyRequests ?? [],
    directives: out.directives,
    plan: { ...plan, perObjectCounts, estimatedRecords: actualRecords },
  });
}

export function generateBundle(plan: BundlePlan, profile: CapabilityProfile, pack: TargetPack): NarrativeBundle {
  const rng = makeRng(plan.seed);
  return assembleBundle(plan, pack.generate({ plan, profile, rng, asOf: plan.asOf }));
}

/**
 * Generate WITH LLM-authored synthetic identities (the single-account protocol). Identical to
 * generateBundle except a resolved `identities` map (keyed by unit.index) rides on the GenerateContext —
 * the pack uses each supplied company in place of its fixed anchor. Absent/empty map ⇒ same as generateBundle.
 */
export function generateBundleWithIdentities(
  plan: BundlePlan,
  profile: CapabilityProfile,
  pack: TargetPack,
  identities?: ReadonlyMap<number, AccountIdentity>,
): NarrativeBundle {
  const rng = makeRng(plan.seed);
  return assembleBundle(plan, pack.generate({ plan, profile, rng, asOf: plan.asOf, ...(identities ? { identities } : {}) }));
}

/** Convenience: plan + generate in one call. `asOf` anchors all timelines (injected at the edge). */
export function buildBundle(scope: ScopeParams, profile: CapabilityProfile, pack: TargetPack, asOf: string): NarrativeBundle {
  const plan = planBundle(scope, profile, pack, asOf);
  return generateBundle(plan, profile, pack);
}
