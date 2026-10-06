// packages/engine/src/purge/run.ts
//
// Purge orchestration, injectable: a READER (arbitrary SOQL + describe), a DELETER
// (deleteRows), and an optional manifest WRITER are the only org/fs contact points,
// so this is unit-testable with no live org (purge-run.test.ts uses stub/mock
// doubles). The `purge` op wires real clients (SfCliClient for reads, JsforceLoadTarget
// for deleteRows) + a real fs-backed manifest writer around `runPurge`/`verifyPurge`.
//
// Dry-run (no --yes) queries COUNT() + a 5-row sample and returns — deleteRows is
// NEVER called, and no manifest is written. `--yes` re-queries the matching Ids
// (capped at --limit, else a DEFAULT_ID_FETCH_CAP safety valve), deletes them via
// `chunkIds` (200/batch, mirroring connection.ts's own REST chunking), and writes the
// manifest DURABLY across the whole delete — not just once at the end:
//   1. "planned"     — before the FIRST chunk deletes: the full planned Id set, deletedCount 0.
//   2. "in_progress" — after EVERY chunk: the Ids deleted so far, flushed synchronously.
//   3. "done"        — once every chunk completes: the final Ids deleted + counts.
// A crash between chunks (the deleter throws) leaves the LAST "in_progress" write on
// disk instead of nothing — `verify()` (in the `purge` op) reads whichever state
// exists, so a partial run is diagnosable rather than silently unrecoverable.

import { RECORDS_PER_MB } from "@dataseed/core";
import { buildPurgePlan, chunkIds, type PurgePlanInput } from "./plan.js";
import type { PurgeManifest } from "./manifest.js";

/** The read surface purge needs: arbitrary SOQL (COUNT / sample / id fetch) + describe (exists + deletable + fields). */
export interface PurgeReader {
  query<T = Record<string, unknown>>(soql: string): Promise<T[]>;
  describe(sobject: string): Promise<{ present: boolean; deletable: boolean; fields: string[] }>;
}

export interface PurgeDeleteResult {
  success: boolean;
  id?: string;
  errors: string[];
}

/** The write surface purge needs — deliberately narrow (not the full LoadTarget). */
export interface PurgeDeleter {
  deleteRows(sobject: string, ids: string[], opts?: { hardDelete?: boolean }): Promise<PurgeDeleteResult[]>;
}

/**
 * The manifest-persistence surface purge needs. `write` is called up to N+2 times per real purge (planned,
 * one per chunk, done) and must be safe to call repeatedly — each call OVERWRITES the durable record with
 * the manifest's current state. This is exactly how a crash mid-run still leaves a usable partial manifest:
 * the last successful `write` call before the crash is what's left on disk.
 */
export interface PurgeManifestWriter {
  write(manifest: PurgeManifest): Promise<void> | void;
}

export interface PurgeArgs extends PurgePlanInput {
  org: string;
  /** Cap on rows fetched-and-deleted with --yes (also usable to bound a dry-run's real-delete estimate). */
  limit?: number;
  /** Actually delete. Without it: dry run (preview only, nothing written/deleted). */
  yes?: boolean;
  /** Bypass the Recycle Bin (Bulk API hardDelete when permitted, else soft-delete + emptyRecycleBin). */
  hardDelete?: boolean;
}

export interface PurgeSampleRow {
  id: string;
  display?: string;
}

export interface PurgeRunResult {
  ok: boolean;
  reason?: string;
  sobject: string;
  /** The composed predicate (no leading WHERE); "" for a bare --all purge. */
  predicate: string;
  matchedCount: number;
  sample: PurgeSampleRow[];
  estimatedMBFreed: number;
  dryRun: boolean;
  deletedCount: number;
  failedCount: number;
  /** The Ids actually reported deleted (not merely attempted) — same set as the final manifest's `ids`. */
  ids: string[];
  manifest?: PurgeManifest;
}

const DISPLAY_FIELD_CANDIDATES = ["Name", "Subject", "Title"];
/** Safety valve when neither --limit nor a tight predicate bounds the match set. */
export const DEFAULT_ID_FETCH_CAP = 10_000;

export async function runPurge(
  reader: PurgeReader,
  deleter: PurgeDeleter,
  args: PurgeArgs,
  opts: { onProgress?: (msg: string) => void; now?: () => string; manifestWriter?: PurgeManifestWriter } = {},
): Promise<PurgeRunResult> {
  const log = opts.onProgress ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const writeManifest = async (manifest: PurgeManifest) => {
    await opts.manifestWriter?.write(manifest);
  };
  const dryRun = !args.yes;

  const plan = buildPurgePlan(args);
  if (!plan.ok) {
    return { ok: false, reason: plan.reason, sobject: args.sobject, predicate: "", matchedCount: 0, sample: [], estimatedMBFreed: 0, dryRun, deletedCount: 0, failedCount: 0, ids: [] };
  }
  const fail = (reason: string): PurgeRunResult => ({
    ok: false,
    reason,
    sobject: args.sobject,
    predicate: plan.predicate,
    matchedCount: 0,
    sample: [],
    estimatedMBFreed: 0,
    dryRun,
    deletedCount: 0,
    failedCount: 0,
    ids: [],
  });

  const described = await reader.describe(args.sobject);
  if (!described.present) return fail(`"${args.sobject}" does not exist (or isn't visible) in this org`);
  if (!described.deletable) return fail(`"${args.sobject}" is not deletable by the running user`);

  const [countRow] = await reader.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${args.sobject}${plan.whereClause}`);
  const matchedCount = Number(countRow?.cnt ?? 0);

  const displayField = DISPLAY_FIELD_CANDIDATES.find((f) => described.fields.includes(f)) ?? null;
  const sampleRows = await reader.query<Record<string, unknown>>(`SELECT Id${displayField ? `, ${displayField}` : ""} FROM ${args.sobject}${plan.whereClause} LIMIT 5`);
  const sample: PurgeSampleRow[] = sampleRows.map((r) => ({
    id: String(r.Id ?? ""),
    ...(displayField && r[displayField] != null ? { display: String(r[displayField]) } : {}),
  }));
  const estimatedMBFreed = matchedCount / RECORDS_PER_MB;

  const base = { ok: true as const, sobject: args.sobject, predicate: plan.predicate, matchedCount, sample, estimatedMBFreed };

  if (dryRun) {
    log(`DRY RUN — ${matchedCount} row(s) of ${args.sobject} match "${plan.predicate || "(none — --all)"}"; nothing deleted. Re-run with --yes to delete.`);
    return { ...base, dryRun: true, deletedCount: 0, failedCount: 0, ids: [] };
  }

  const cap = args.limit ?? DEFAULT_ID_FETCH_CAP;
  const idRows = await reader.query<{ Id: string }>(`SELECT Id FROM ${args.sobject}${plan.whereClause} LIMIT ${cap}`);
  const ids = idRows.map((r) => r.Id).filter((id): id is string => typeof id === "string");

  let failedCount = 0;
  const deletedIds: string[] = [];
  /** A snapshot of the CURRENT progress — `deletedIds` is read live, so calling this after each mutation
   *  always reflects exactly what's been deleted so far. */
  const progressManifest = (status: PurgeManifest["status"]): PurgeManifest => ({
    org: args.org,
    sobject: args.sobject,
    predicate: plan.predicate,
    hardDelete: !!args.hardDelete,
    dryRun: false,
    status,
    matchedCount,
    deletedCount: deletedIds.length,
    ids: [...deletedIds],
    timestamp: now(),
  });

  // Durable BEFORE the first delete: a crash before any chunk runs still leaves the planned Id set on disk
  // — status "planned", the FULL candidate set (not yet deleted, deletedCount 0), so a partial run is
  // diagnosable against what was ATTEMPTED, not just what succeeded.
  await writeManifest({ ...progressManifest("planned"), ids, deletedCount: 0 });

  for (const batch of chunkIds(ids)) {
    const results = await deleter.deleteRows(args.sobject, batch, { hardDelete: !!args.hardDelete });
    results.forEach((r, i) => {
      if (r.success) deletedIds.push(batch[i]!);
      else failedCount++;
    });
    log(`${args.sobject}: deleted ${deletedIds.length}/${ids.length} so far${failedCount ? `, ${failedCount} failed` : ""}`);
    // Durable AFTER every chunk: a crash on the NEXT chunk still leaves everything up to this one recorded.
    await writeManifest(progressManifest("in_progress"));
  }

  const manifest = progressManifest("done");
  await writeManifest(manifest);

  return { ...base, dryRun: false, deletedCount: deletedIds.length, failedCount, ids: deletedIds, manifest };
}

export interface PurgeVerifyResult {
  success: boolean;
  remainingCount: number;
  reason?: string;
}

/** Re-run COUNT() and confirm it dropped to at most `preCount - deletedCount` (0 in the common case). */
export async function verifyPurge(reader: PurgeReader, args: PurgeArgs, expected: { preCount: number; deletedCount: number }): Promise<PurgeVerifyResult> {
  const plan = buildPurgePlan(args);
  const whereClause = plan.ok ? plan.whereClause : "";
  const [row] = await reader.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${args.sobject}${whereClause}`);
  const remainingCount = Number(row?.cnt ?? 0);
  const expectedMax = Math.max(0, expected.preCount - expected.deletedCount);
  const success = remainingCount <= expectedMax;
  return { success, remainingCount, ...(success ? {} : { reason: `expected ≤ ${expectedMax} remaining after deleting ${expected.deletedCount}/${expected.preCount}, found ${remainingCount}` }) };
}
