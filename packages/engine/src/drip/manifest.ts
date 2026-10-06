// packages/engine/src/drip/manifest.ts
//
// The drip's per-day MANIFEST: what got inserted (Salesforce Ids + the natural key that would dedupe
// it), so a later `teardown-demo --include-drip` can find and remove exactly those records without
// re-deriving anything. Pure — JSON-serializable data + the plan-computation over it; the op (drip.ts)
// owns reading/writing `.dataseed/drip/<org>/<day>.json`, mirroring how checkpoint.ts/teardown-demo.ts
// keep file I/O at the op layer and the shape/logic here testable with no filesystem.

import type { DripObject } from "./types.js";

export interface DripManifestRecord {
  object: DripObject;
  id: string;
  naturalKey: string;
}

export interface DripManifest {
  org: string;
  /** ISO date (YYYY-MM-DD) this manifest is for. */
  day: string;
  createdAt: string;
  /** ISO timestamp the run STARTED — verify()'s "created after this" anchor for polling
   *  Signal_Ingestion_Queue__c, so a re-run's manifest never lets an earlier run's queue rows count. */
  runStartedAt: string;
  seed: string | number;
  /** How many deals were touched this run. */
  accounts: number;
  /** --beats value used. */
  beatsPerAccount: number;
  provider: string;
  records: DripManifestRecord[];
}

export function buildManifest(input: {
  org: string;
  day: string;
  createdAt: string;
  runStartedAt: string;
  seed: string | number;
  accounts: number;
  beatsPerAccount: number;
  provider: string;
  records: DripManifestRecord[];
}): DripManifest {
  return { ...input, records: [...input.records] };
}

/** Everything `teardown-demo --include-drip` would delete: object → distinct Ids, across every
 *  manifest given (order-preserving, deduped — the same Id can't appear twice even across manifests
 *  from re-runs of the same day, e.g. a manifest overwritten mid-debug). */
export function planDripTeardown(manifests: readonly DripManifest[]): Record<DripObject, string[]> {
  const byObject: Record<string, string[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const m of manifests) {
    for (const r of m.records) {
      const ids = (byObject[r.object] ??= []);
      const dedup = (seen[r.object] ??= new Set<string>());
      if (!dedup.has(r.id)) {
        dedup.add(r.id);
        ids.push(r.id);
      }
    }
  }
  return byObject as Record<DripObject, string[]>;
}

/** Total record count across a set of manifests — a quick display figure for the op/teardown preview. */
export function totalManifestRecords(manifests: readonly DripManifest[]): number {
  return manifests.reduce((sum, m) => sum + m.records.length, 0);
}
