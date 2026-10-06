// packages/engine/src/sinks/cascade.ts
//
// Cascade controls for dispersal. A pack declares which seeded INPUT objects fire its target's
// trigger/automation cascade (TargetPack.cascadeObjects — e.g. the EmailMessage/Task/transcript
// streams that drive signal extraction → synthesis). Loading those has an async/LLM blast radius, so:
//   • cascadeEstimate() — tells a caller the blast radius BEFORE loading (how many jobs/LLM calls).
//   • excludeCascade()  — drops those objects so a bulk fill lands purely structurally (zero cascade).
// Both are pure and pack-agnostic; the salesforce sink applies them when `cascade: "off"`.

import type { TargetPack, BundleRecords, GenericRecord } from "@dataseed/core";

// A record fires the cascade only if it ISN'T bulk-tier. Bulk-tier records of a cascade object are inert
// by construction: their copy is filled inline (combinatorial, no CopyRequest), so they enqueue no fill-copy
// LLM/synthesis work — even though v18 bulk records DO carry real activity-capture shapes (EmailMessage
// threads, ContentVersion transcripts, TaskSubtype). So they must NOT inflate the blast-radius estimate, and
// a `cascade: "off"` fill should KEEP them (structural texture, not pipeline inputs). Foreground streams (no
// bulk tag) carry CopyRequests → they fire the pipeline and are counted/dropped.
const firesCascade = (rec: GenericRecord): boolean => (rec._meta as { tier?: string } | undefined)?.tier !== "bulk";

export interface CascadeEstimate {
  /** The cascade-firing input objects actually PRESENT in the bundle. */
  cascadeObjects: string[];
  /** Total trigger-firing input records (emails + tasks + transcripts …). */
  streamRecords: number;
  /** ≈ async queueables enqueued (one ingestion job per stream record; synthesis adds ~1 per affected deal). */
  estAsyncJobs: number;
  /** ≈ LLM calls (one extraction per stream record; synthesis adds ~1 per affected deal). Extraction-dominated. */
  estLlmCalls: number;
}

/** Estimate the pipeline blast radius of loading this bundle's cascade inputs (rough, extraction-dominated). */
export function cascadeEstimate(pack: TargetPack, records: BundleRecords): CascadeEstimate {
  // Count only the cascade-FIRING records (foreground streams) — bulk-tier records of a cascade object
  // are inert and would wildly overstate the estimate (~578K bulk Tasks at 100K accounts fire nothing).
  const counts = (pack.cascadeObjects ?? [])
    .map((o) => ({ o, n: (records[o] ?? []).filter(firesCascade).length }))
    .filter((c) => c.n > 0);
  const present = counts.map((c) => c.o);
  const streamRecords = counts.reduce((s, c) => s + c.n, 0);
  // Synthesis is per-deal and debounced; approximate one extra job/call per cascade-bearing deal,
  // bounded by the deal count, so the estimate doesn't wildly overstate at huge bulk volumes.
  const deals = Math.min(records.Opportunity?.length ?? 0, streamRecords);
  return { cascadeObjects: present, streamRecords, estAsyncJobs: streamRecords + deals, estLlmCalls: streamRecords + deals };
}

/** A copy of `records` with the pack's cascade-FIRING records removed — the structural-only ("cascade off")
 *  view. Inert bulk-tier records of a cascade object (e.g. subtype-less bulk Tasks) are KEPT: they fire
 *  nothing, so a structural load still gets its activity-timeline texture. */
export function excludeCascade(pack: TargetPack, records: BundleRecords): BundleRecords {
  const cascade = new Set(pack.cascadeObjects ?? []);
  const out: BundleRecords = {};
  for (const [obj, recs] of Object.entries(records)) {
    if (!cascade.has(obj)) {
      out[obj] = recs;
      continue;
    }
    const kept = recs.filter((r) => !firesCascade(r)); // keep the inert bulk records, drop the firing ones
    if (kept.length) out[obj] = kept;
  }
  return out;
}
