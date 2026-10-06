// packages/engine/src/ops/profile-org.ts
//
// `profile-org` — the M1 op and the app's mandatory first stage: point at any org,
// emit a CapabilityProfile, persist it. Generic (target-agnostic): it probes a
// standard SF object set, plus — when `--pack` is given — that pack's objects, so
// the pack can later call checkRequirements(profile). Fail-open throughout.
//
// `populate-demo-org` (M2+) refuses to generate until a fresh profile exists.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityProfile, standardProfile, SYNTHETIC_ORG } from "@dataseed/core";
import type { Op } from "./types.js";
import { SfCliClient } from "../introspect/sf-client.js";
import { assembleProfile } from "../introspect/profile.js";

/** Generic SF objects always worth probing (existence + counts), pack-independent. */
export const STANDARD_OBJECTS = ["Account", "Contact", "Opportunity", "Lead", "User", "Case"] as const;

/** The object list to probe: standard objects ∪ a pack's objects (deduped). Shared by the op + server. */
export function profileObjects(packObjects?: readonly string[]): string[] {
  return [...new Set([...STANDARD_OBJECTS, ...(packObjects ?? [])])];
}

/** Where profiles are persisted, per org alias. */
export const PROFILE_DIR = join(process.cwd(), ".dataseed", "profiles");
export const profilePath = (org: string) => join(PROFILE_DIR, `${org}.json`);

interface ProfileArgs extends Record<string, unknown> {
  org: string;
  pack?: string;
  synthetic?: boolean;
}

export const profileOrgOp: Op<ProfileArgs> = {
  id: "profile-org",
  name: "Profile an org",
  description:
    "Introspect any Salesforce org (limits, licensing, edition/namespace, object/FLS availability, Data Cloud, existing data) → a CapabilityProfile persisted to .dataseed/profiles/<org>.json. Fail-open. Pass --pack to also probe that target pack's objects.",
  idempotent: false, // always re-reads the live org (a profile can go stale)
  prerequisites: ["sf CLI authenticated to the target org"],
  affects: [".dataseed/profiles/<org>.json (local file only — no org writes)"],
  args: {
    org: { type: "string", required: true, description: "Target org alias (an authed `sf` org). With --synthetic, just the label to file the profile under (default 'standard')." },
    pack: { type: "string", description: "Optional target pack id; also probes that pack's objects (e.g. salescloud). REQUIRED with --synthetic (it defines which objects are present)." },
    synthetic: { type: "boolean", description: "Skip the live org entirely and write a generous SYNTHETIC standard-org profile (every pack object present, no record budget, no Data Cloud) — for building a corpus with no target org. Requires --pack." },
  },

  check(args) {
    // Read-only op; nothing to skip. Report whether a prior profile exists.
    const existing = existsSync(profilePath(args.org));
    return { alreadyDone: false, hadPriorProfile: existing };
  },

  async run(args, ctx) {
    // Synthetic path — no live org. Write a generous standard-org profile so generation can run org-agnostic.
    if (args.synthetic) {
      if (!args.pack) throw new Error("--synthetic requires --pack (the pack defines which objects the synthetic org exposes)");
      const pack = ctx.packs.get(args.pack);
      const org = args.org || SYNTHETIC_ORG;
      const profile = standardProfile(pack, { org });
      mkdirSync(PROFILE_DIR, { recursive: true });
      writeFileSync(profilePath(org), JSON.stringify(profile, null, 2) + "\n");
      ctx.log(`wrote SYNTHETIC profile ${profilePath(org)} — ${profile.objects.length} objects present, no record budget (no clamp), Data Cloud off`);
      ctx.log(`generate against org="${org}" to build a corpus with no live org; the loader conforms it to a real org at load time`);
      return;
    }

    const client = new SfCliClient(args.org);

    const pack = args.pack ? ctx.packs.get(args.pack) : undefined; // throws on unknown pack → surfaced as op error
    const objects = profileObjects(pack?.objects);
    ctx.log(pack ? `probing ${objects.length} objects for pack "${pack.id}"` : `probing ${objects.length} standard objects (no pack)`);

    const capturedAt = new Date().toISOString(); // edge timestamp — fine outside the pure path
    const profile = await assembleProfile(client, { objects, capturedAt });

    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(profilePath(args.org), JSON.stringify(profile, null, 2) + "\n");
    ctx.log(`wrote ${profilePath(args.org)}`);

    // Surface a concise human summary.
    const dc = profile.dataCloud;
    ctx.log(`edition=${profile.edition ?? "?"} sandbox=${profile.isSandbox ?? "?"} ns=${profile.namespacePrefix ?? "(none)"}`);
    ctx.log(`recordBudget=${profile.recordBudget ?? "?"} copyProvider=${profile.copyProvider} dataCloud=${dc ? `${dc.available ? "on" : "off"} (${dc.evidence})` : "?"}`);
    if (args.pack) {
      const pack = ctx.packs.get(args.pack);
      const reqs = pack.checkRequirements(profile);
      const blocking = reqs.filter((r) => r.severity === "blocking");
      ctx.log(`pack "${pack.id}" requirements: ${reqs.length === 0 ? "all satisfied" : `${blocking.length} blocking, ${reqs.length - blocking.length} warning`}`);
      for (const r of reqs) ctx.log(`  [${r.severity}] ${r.kind}: ${r.detail}`);
    }
    if (profile.gaps.length) ctx.log(`gaps: ${profile.gaps.length} (see file)`);
  },

  verify(args) {
    // Post-condition: a parseable, schema-valid profile for this org exists on disk.
    const p = profilePath(args.org);
    if (!existsSync(p)) return { success: false, reason: "profile file not written" };
    try {
      const parsed = CapabilityProfile.parse(JSON.parse(readFileSync(p, "utf8")));
      return { success: true, org: parsed.org, objects: parsed.objects.length, gaps: parsed.gaps.length };
    } catch (e) {
      return { success: false, reason: `profile invalid: ${(e as Error).message}` };
    }
  },
};

export default profileOrgOp;
