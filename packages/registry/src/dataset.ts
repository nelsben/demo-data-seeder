// packages/registry/src/dataset.ts
//
// Helpers that turn a freshly-generated bundle into a registry Dataset. Timestamps
// are INJECTED (never Date.now() here) — the repo's reproducibility rule — so the
// op/MCP caller controls the clock and tests stay deterministic.

import type { NarrativeBundle, ScopeParams } from "@dataseed/core";
import { datasetId } from "./id.js";
import type { Dataset, DatasetStatus } from "./types.js";

/** Per-sobject record counts — cheap sizing carried in provenance so listing needn't decode the bundle. */
export function recordCounts(bundle: NarrativeBundle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [object, rows] of Object.entries(bundle.records)) counts[object] = rows.length;
  return counts;
}

export interface BuildDatasetInput {
  pack: string;
  params: ScopeParams;
  bundle: NarrativeBundle;
  /** Generator/engine version stamped into provenance. */
  engineVersion: string;
  /** ISO timestamp to stamp (injected, e.g. params.asOf or the op's clock). */
  now: string;
  status?: DatasetStatus;
  name?: string;
  /** A prior dataset of the same id (re-plan) — its createdAt + name are preserved. */
  prior?: Dataset | null;
}

/**
 * Construct a Dataset from a generated bundle. The id is content-addressed on
 * (pack, params), so re-planning the same request yields the same id and this
 * preserves the original createdAt while bumping updatedAt.
 */
export function buildDataset(input: BuildDatasetInput): Dataset {
  const name = input.name ?? input.prior?.name;
  return {
    id: datasetId(input.pack, input.params),
    ...(name !== undefined ? { name } : {}),
    pack: input.pack,
    params: input.params,
    status: input.status ?? "planned",
    provenance: {
      engineVersion: input.engineVersion,
      createdAt: input.prior?.provenance.createdAt ?? input.now,
      updatedAt: input.now,
      recordCounts: recordCounts(input.bundle),
    },
    bundle: input.bundle,
  };
}
