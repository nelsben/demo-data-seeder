// packages/engine/src/purge/manifest.ts
//
// The purge manifest — written to `.dataseed/purge/<org>/<timestamp>.json` (plus a
// stable `<org>/<sobject>.latest.json` pointer) on every REAL delete (never on a dry
// run). Same shape family as the other op reports in this repo (teardown's report,
// the load report): object, predicate, the Ids involved, and the counts either side
// of the operation. A Zod schema (matching the codebase's CapabilityProfile /
// NarrativeBundle convention) so a malformed manifest fails loudly on read instead of
// silently misreporting `verify`.
//
// `status` makes the manifest DURABLE across a crash mid-delete, not just a
// post-hoc report: `run.ts#runPurge` writes it three times per real purge —
// "planned" (all planned Ids, before the first chunk deletes), "in_progress"
// (Ids deleted SO FAR, flushed after every chunk), and "done" (the final Ids
// deleted + counts). A crash between chunks leaves the LAST "in_progress" write on
// disk — `ops/purge.ts`'s `verify()` reads whichever state exists, so a partial run
// is diagnosable (how many of how many deleted) instead of silently unrecoverable.

import { z } from "zod";

export const PurgeManifest = z.object({
  /** Target org alias this purge ran against. */
  org: z.string().min(1),
  /** sObject API name purged. */
  sobject: z.string().min(1),
  /** The composed SOQL predicate (no leading "WHERE"); "" for an explicit --all bare purge. */
  predicate: z.string(),
  /** Whether the delete bypassed the Recycle Bin (Bulk API hardDelete, or soft-delete + emptyRecycleBin). */
  hardDelete: z.boolean().default(false),
  /** Always false for a written manifest (dry runs write nothing) — kept explicit for a stable schema shape. */
  dryRun: z.boolean().default(false),
  /**
   * Durable progress marker: "planned" (written before any chunk deletes — `ids` is the FULL planned set,
   * `deletedCount` 0), "in_progress" (flushed after EVERY chunk — `ids` is the Ids deleted SO FAR), "done"
   * (the final write — `ids` is every Id actually deleted). Defaults to "done" so a manifest written before
   * this field existed still parses as a normal completed record.
   */
  status: z.enum(["planned", "in_progress", "done"]).default("done"),
  /** Rows the predicate matched at plan time. */
  matchedCount: z.number().int().nonnegative(),
  /** Rows actually reported deleted so far (see `status` for what "so far" means). */
  deletedCount: z.number().int().nonnegative(),
  /** The Ids this write's `status` describes (see the field-by-field note on `status`). */
  ids: z.array(z.string()),
  /** ISO 8601 — when this write happened (re-stamped on every planned/in_progress/done write). */
  timestamp: z.string().datetime(),
});
export type PurgeManifest = z.infer<typeof PurgeManifest>;

export function serializePurgeManifest(manifest: PurgeManifest): string {
  return JSON.stringify(PurgeManifest.parse(manifest), null, 2) + "\n";
}

export function parsePurgeManifest(json: string): PurgeManifest {
  return PurgeManifest.parse(JSON.parse(json));
}
