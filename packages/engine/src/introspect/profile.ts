// packages/engine/src/introspect/profile.ts
//
// assembleProfile — orchestrates the fail-open probes into one CapabilityProfile.
// Independent probes run in parallel; dataCloud waits on the licensing result,
// existing-data waits on object presence. Every probe's gaps are collected, and
// the merged draft is validated by the core Zod schema before return.

import { CapabilityProfile } from "@dataseed/core";
import type { SfClient } from "./sf-client.js";
import { probeLimits, probeOrgInfo, probeLicensing, probeObjects, probeDataCloud, probeExistingData } from "./probes.js";

export interface AssembleOpts {
  /** sObject API names to probe for presence/FLS/picklists (the pack's objects + standard ones). */
  objects: readonly string[];
  /** ISO 8601 capture time — injected at the edge (the op stamps it), never inside a pure path. */
  capturedAt: string;
}

export async function assembleProfile(client: SfClient, opts: AssembleOpts): Promise<CapabilityProfile> {
  const draft: Record<string, unknown> = { org: client.org, capturedAt: opts.capturedAt, gaps: [] };
  const gaps: string[] = [];

  // Batch 1 — independent probes in parallel.
  const [limits, orgInfo, licensing, objects] = await Promise.all([
    probeLimits(client),
    probeOrgInfo(client),
    probeLicensing(client),
    probeObjects(client, opts.objects),
  ]);

  // Batch 2 — dependent probes.
  const licensed = (licensing.patch.dataCloud?.licensed as boolean) ?? false;
  const presentSet = new Set((objects.patch.objects ?? []).filter((o) => o.present).map((o) => o.apiName));
  const [dataCloud, existing] = await Promise.all([
    probeDataCloud(client, licensed),
    probeExistingData(client, opts.objects, presentSet),
  ]);

  // Merge in dependency order so dataCloud (refined) wins over licensing's seed.
  for (const p of [limits, orgInfo, licensing, objects, dataCloud, existing]) {
    Object.assign(draft, p.patch);
    gaps.push(...p.gaps);
  }
  draft.gaps = gaps;

  return CapabilityProfile.parse(draft);
}
