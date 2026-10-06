// packages/engine/src/generate/stream.ts
//
// streamMaterialize — write a corpus into the warehouse WITHOUT ever holding the whole bundle in memory.
// The eager path (generateBundle → writeBundle) holds ~0.4GB RSS per 10K accounts, so a true 100K needs
// this: generate the up-front scaffold once, then the bulk tier in account-major BATCHES, writing each
// batch in its own transaction. Peak RSS is bounded by one batch (+ the SQLite page cache), not the corpus.
//
// Correctness rests on one invariant: every bulk record derives purely from (seed, accountIndex) and the
// bulk tier never reads the foreground rng (verified in packs/salescloud/src/generate.ts + the ref-locality test). So the
// concatenation of scaffold + batches is BYTE-IDENTICAL to a full generate — proven by the stream-parity
// test, which is the guardrail for this whole path.

import { type CapabilityProfile, type TargetPack, type BundlePlan, type BundleRecords, type CopyRequest, makeRng } from "@dataseed/core";
import type { ManifestInput, WarehouseStore } from "@dataseed/warehouse";

/** The up-front scaffold slice (config + FOREGROUND deals + leads + User pool) — the only slice that carries
 *  copyRequests, so it's the one a copy-fill hook operates on (the bulk batches have no copy). */
export interface ScaffoldSlice {
  records: BundleRecords;
  copyRequests: CopyRequest[];
}

export interface StreamOptions {
  /** Accounts per bulk batch — the RSS/throughput knob. Default 5000 (~0.2GB/batch at full density). */
  batch?: number;
  /** Called after each batch with cumulative account progress, for a progress line. */
  onProgress?: (accountsDone: number, totalAccounts: number) => void;
  /** Fill the foreground copy on the scaffold slice (in place) before it's written — so a materialized corpus
   *  carries real hero-deal bodies, not deferred/blank ones. Async (may call the LLM copy chain). */
  fillScaffold?: (slice: ScaffoldSlice) => Promise<void>;
}

export interface StreamResult {
  counts: Record<string, number>;
  totalRecords: number;
  batches: number;
}

/** Run the pack's generate for a slice (or the scaffold) — the streaming seam on GenerateContext. */
function generateSlice(plan: BundlePlan, profile: CapabilityProfile, pack: TargetPack, bulkRange: { start: number; end: number; scaffold: boolean }) {
  // A fresh root rng per slice: the seed is fixed (plan.seed), and every stream the pack derives is
  // seed-based (rng.derive / deriveSeed), so slices are independent and reproducible — no shared state.
  return pack.generate({ plan, profile, rng: makeRng(plan.seed), asOf: plan.asOf, bulkRange });
}

/**
 * Materialize a corpus into the warehouse by streaming. Requires a pack whose bulk tier is account-major
 * (pack.bulkRefLocality === 'account-major'); otherwise the caller should use the eager path.
 */
export async function streamMaterialize(
  plan: BundlePlan,
  profile: CapabilityProfile,
  pack: TargetPack,
  store: WarehouseStore,
  manifest: ManifestInput,
  builtAt: string,
  opts: StreamOptions = {},
): Promise<StreamResult> {
  const batch = Math.max(1, opts.batch ?? 5000);
  const population = plan.population;
  const seqs: Record<string, number> = {}; // running per-object next-seq, threaded across batches
  const advance = (appended: Record<string, number>) => {
    for (const [obj, n] of Object.entries(appended)) seqs[obj] = (seqs[obj] ?? 0) + n;
  };

  store.beginStream(manifest);
  // 1) scaffold once (config, foreground deals, leads, the User pool) — no bulk. Fill its foreground copy in
  //    place BEFORE writing (the bulk batches below carry no copyRequests, so this is the only fill point).
  const scaffold = generateSlice(plan, profile, pack, { start: 0, end: 0, scaffold: true });
  if (opts.fillScaffold) await opts.fillScaffold({ records: scaffold.records, copyRequests: scaffold.copyRequests ?? [] });
  advance(store.appendObjects(manifest.dsId, scaffold.records, seqs));
  // 2) the bulk tier in account-major batches — each batch is one transaction, bounded RSS
  let batches = 0;
  for (let start = 0; start < population; start += batch) {
    const end = Math.min(start + batch, population);
    advance(store.appendObjects(manifest.dsId, generateSlice(plan, profile, pack, { start, end, scaffold: false }).records, seqs));
    batches++;
    opts.onProgress?.(end, population);
  }
  store.finishStream(manifest.dsId, seqs, builtAt);

  const totalRecords = Object.values(seqs).reduce((a, b) => a + b, 0);
  return { counts: { ...seqs }, totalRecords, batches };
}
