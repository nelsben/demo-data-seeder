// packages/core/src/standard-profile.ts
//
// A SYNTHETIC "standard org" CapabilityProfile — so generation can run with NO live org.
//
// The whole pipeline (plan → generate) is gated on a CapabilityProfile because, against a real org, the
// data conforms to THAT org (its record budget, which objects/picklists exist, Data Cloud on/off, FLS).
// But you often want to build a corpus BEFORE you have a target org. This is the answer: a vanilla,
// generous profile where every object the pack needs is present + writable, there is NO record budget
// (so the plan never clamps a large request), Data Cloud is off, and the pack's static picklist contract
// governs. Generate against this, materialize the corpus, and the loader re-conforms it to whatever real
// org you eventually connect — it already field-drops non-createable fields, skips absent objects, and
// soft-drops unresolved lookups, so a corpus built against the generous profile degrades cleanly into a
// constrained org.

import { CapabilityProfile } from "./capability-profile.js";
import type { TargetPack } from "./pack.js";

/** A fixed synthetic capture time — the profile is org-agnostic so the moment is meaningless AND must be
 *  stable (a changing timestamp would perturb anything that hashes the profile). */
export const SYNTHETIC_CAPTURED_AT = "2020-01-01T00:00:00.000Z";

/** The default alias a synthetic profile is filed under (.dataseed/profiles/standard.json). */
export const SYNTHETIC_ORG = "standard";

/**
 * Build a synthetic standard-org CapabilityProfile for a pack: every declared object present + writable,
 * unlimited record budget (omitted ⇒ the plan's population clamp is a no-op), no Data Cloud, no namespace,
 * the pack's static picklists. Pure + deterministic — safe to hash, cache, and reproduce.
 */
export function standardProfile(pack: TargetPack, opts: { org?: string; capturedAt?: string } = {}): CapabilityProfile {
  return CapabilityProfile.parse({
    org: opts.org ?? SYNTHETIC_ORG,
    capturedAt: opts.capturedAt ?? SYNTHETIC_CAPTURED_AT,
    edition: "Synthetic Standard",
    isSandbox: false,
    namespacePrefix: null,
    objects: pack.objects.map((apiName) => ({ apiName, present: true, blockedRequiredFields: [] })),
    // recordBudget omitted → UNLIMITED (no clamp); dataCloud omitted → off; livePicklists/existingCounts
    // default empty → use the pack's static picklist contract and treat the org as fresh.
    copyProvider: "static",
    gaps: ["synthetic profile — not introspected from a live org; the real org is conformed to at load time"],
  });
}
