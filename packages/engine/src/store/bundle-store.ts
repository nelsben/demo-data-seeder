// packages/engine/src/store/bundle-store.ts
//
// (org, pack)-keyed ergonomics over the addressable dataset registry. The legacy
// flat-file workflow keyed generated content by (org, pack), overwriting per run;
// the registry keys datasets by a content-addressed id (pack + params) and keeps
// history. This bridges the two: `savePlanned` registers a Dataset, and
// `latestDatasetFor` resolves the CURRENT dataset for an (org, pack) — the most
// recent one — so the existing plan→fill→load verbs keep working unchanged while
// every dataset stays addressable, reusable, and dispersable to many sinks.

import type { NarrativeBundle, ScopeParams } from "@dataseed/core";
import { buildDataset, datasetId, recordCounts, type Dataset, type RegistryStore } from "@dataseed/registry";

/** Bundle/generator format version stamped into dataset provenance. Bump on a bundle-shape change. */
export const ENGINE_VERSION = "0.1.0";

/**
 * Save a freshly-planned bundle as a Dataset. Idempotent by content-addressed id:
 * re-planning the same (pack, params) updates the same dataset and preserves its
 * original createdAt.
 */
export function savePlanned(
  store: RegistryStore,
  input: { pack: string; params: ScopeParams; bundle: NarrativeBundle; now: string; name?: string },
): Dataset {
  const prior = store.get(datasetId(input.pack, input.params));
  const ds = buildDataset({
    pack: input.pack,
    params: input.params,
    bundle: input.bundle,
    engineVersion: ENGINE_VERSION,
    now: input.now,
    status: "planned",
    ...(input.name !== undefined ? { name: input.name } : {}),
    prior,
  });
  store.put(ds);
  return ds;
}

/**
 * Record a filled bundle (planned→filled) for an existing dataset: preserves its
 * id, params, name, and createdAt while swapping the bundle and stamping copy
 * provenance (provider/model/cost + filledAt).
 */
export function saveFilled(
  store: RegistryStore,
  dataset: Dataset,
  input: { bundle: NarrativeBundle; now: string; provider?: string; model?: string; costUsd?: number },
): Dataset {
  const updated: Dataset = {
    ...dataset,
    status: "filled",
    bundle: input.bundle,
    provenance: {
      ...dataset.provenance,
      updatedAt: input.now,
      filledAt: input.now,
      recordCounts: recordCounts(input.bundle),
      ...(input.provider !== undefined ? { llmProvider: input.provider } : {}),
      ...(input.model !== undefined ? { llmModel: input.model } : {}),
      ...(input.costUsd !== undefined ? { llmCostUsd: input.costUsd } : {}),
    },
  };
  store.put(updated);
  return updated;
}

/**
 * The CURRENT dataset for an (org, pack) — the most recent one (list() is newest
 * first). This is what the (org, pack)-keyed verbs (fill, load) operate on, the
 * registry analogue of "the bundle file for this org+pack".
 */
export function latestDatasetFor(store: RegistryStore, org: string, pack: string): Dataset | null {
  const meta = store.list({ pack }).find((m) => m.params.org === org);
  return meta ? store.get(meta.id) : null;
}
