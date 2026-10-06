// packages/engine/src/ops/purge.ts
//
// `purge` — delete a targeted set of rows from ANY sObject, dry-run by default. The
// sanctioned complement to every seeding op: the seeder creates AND deletes data, for
// demo purposes AND for testing purposes (Ben, 2026-09-05 — see docs/storage-and-purge.md).
// Built after the 2026-09-04 incident: the demo org hit DataStorageMB 0/5 and nothing in
// the tooling could delete a targeted set of rows to recover.
//
// SAFE BY DESIGN: refuses a bare purge (no --where/--older-than-days) unless --all is
// explicit, refuses a small DENY list of config/identity objects (purge/deny-list.ts),
// and previews the plan (no writes) unless --yes. Deletes in 200-row chunks;
// --hard-delete tries the Bulk API hardDelete operation, falling back to soft-delete +
// emptyRecycleBin when the running user lacks the "Bulk API Hard Delete" permission —
// see docs/storage-and-purge.md for why that matters: a plain (soft) delete's rows sit
// in the Recycle Bin and keep counting against DataStorageMB until it's emptied or the
// 15-day retention lapses.
//
// Reuses the #94-fixed connection (packages/engine/src/load/connection.ts's
// getAccessInfo/JsforceLoadTarget) for the delete path, and SfCliClient (the read-only
// introspection client) for COUNT()/describe/limits — the same split `profile-org` and
// the load ops already use.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Op } from "./types.js";
import { SfCliClient } from "../introspect/sf-client.js";
import { JsforceLoadTarget } from "../load/connection.js";
import { runPurge, verifyPurge, type PurgeArgs as PurgeRunArgs, type PurgeReader, type PurgeDeleter, type PurgeManifestWriter } from "../purge/run.js";
import { serializePurgeManifest, parsePurgeManifest } from "../purge/manifest.js";

export const PURGE_DIR = join(process.cwd(), ".dataseed", "purge");
/** Stable per-(org, sobject) pointer to the latest REAL delete's manifest — how `verify()` recovers
 *  the pre-delete count/deleted-count from `run()` without the Op contract passing state between them
 *  (mirrors teardown-demo's `teardownReportPath` pattern). The timestamped file alongside it is the
 *  brief's audit-trail manifest; this one is always overwritten. Exported for direct testing (see
 *  purge-op.test.ts) — `verify()`'s status-aware branch is otherwise only reachable through a live org. */
export const purgeStatePath = (org: string, sobject: string) => join(PURGE_DIR, org, `${sobject}.latest.json`);

const NULL_DELETER: PurgeDeleter = { deleteRows: async () => [] };

/**
 * A REAL (fs-backed) manifest writer for one purge run: ONE timestamp computed up front, reused for every
 * write, so "planned" → "in_progress" (×N) → "done" all land in the SAME audit file (overwritten each
 * time) rather than scattering a file per chunk. The stable `<sobject>.latest.json` pointer gets the exact
 * same bytes on every write too, so a crash between chunks (see purge/run.ts's header) leaves it holding
 * the last successfully-written state — `verify()` below reads it back as "whichever state exists."
 * Exported for direct testing (see purge-op.test.ts).
 */
export function fsManifestWriter(org: string, sobject: string): PurgeManifestWriter {
  const auditPath = join(PURGE_DIR, org, `${Date.now()}.json`);
  const statePath = purgeStatePath(org, sobject);
  return {
    write(manifest) {
      mkdirSync(join(PURGE_DIR, org), { recursive: true });
      const serialized = serializePurgeManifest(manifest);
      writeFileSync(auditPath, serialized);
      writeFileSync(statePath, serialized);
    },
  };
}

interface PurgeArgs extends Record<string, unknown> {
  org: string;
  sobject: string;
  where?: string;
  olderThanDays?: number;
  dateField?: string;
  limit?: number;
  all: boolean;
  yes: boolean;
  hardDelete: boolean;
}

/** Adapt SfCliClient (the introspection read surface) to the narrow PurgeReader purge/run.ts needs. */
function purgeReader(client: SfCliClient): PurgeReader {
  return {
    query: (soql) => client.query(soql),
    async describe(sobject) {
      try {
        const d = await client.describe(sobject);
        return { present: true, deletable: d.deletable !== false, fields: d.fields.map((f) => f.name) };
      } catch {
        return { present: false, deletable: false, fields: [] }; // describe throws on an absent/inaccessible object
      }
    },
  };
}

function toRunArgs(args: PurgeArgs, yes: boolean): PurgeRunArgs {
  return {
    org: args.org,
    sobject: args.sobject,
    where: args.where,
    olderThanDays: args.olderThanDays,
    dateField: args.dateField,
    all: args.all,
    limit: args.limit,
    yes,
    hardDelete: args.hardDelete,
  };
}

export const purgeOp: Op<PurgeArgs> = {
  id: "purge",
  name: "Delete a targeted set of rows from an org (dry-run by default)",
  description:
    "Preview (default) or delete (--yes) rows matching --where / --older-than-days on any sObject. Refuses a bare purge (no predicate) unless --all, and refuses a small config/identity DENY list. Deletes in 200-row chunks; --hard-delete additionally bypasses the Recycle Bin so DataStorageMB actually drops. Writes a manifest under .dataseed/purge/<org>/<timestamp>.json on every real delete. The sanctioned delete tool for demo AND test data — see docs/storage-and-purge.md.",
  idempotent: false, // re-evaluates the live match set every run — new rows can match between runs
  prerequisites: ["sf authenticated to the org", "delete permission on the target sObject"],
  affects: [
    "<org>: DELETES rows matching the predicate (soft, or hard with --hard-delete) — dry-run unless --yes",
    ".dataseed/purge/<org>/<timestamp>.json manifest + .dataseed/purge/<org>/<sobject>.latest.json on a real delete",
  ],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
    sobject: { type: "string", required: true, description: "sObject API name to purge." },
    where: { type: "string", description: "SOQL WHERE-clause fragment (no leading WHERE)." },
    olderThanDays: { type: "number", description: "Match rows whose --date-field (default CreatedDate) is older than N days." },
    dateField: { type: "string", description: "Date/DateTime field --older-than-days applies to (default CreatedDate)." },
    limit: { type: "number", description: "Cap the number of rows fetched/deleted (also the safety cap when omitted: 10,000)." },
    all: { type: "boolean", default: false, description: "Explicit opt-in to purge EVERY row of --sobject (no --where/--older-than-days)." },
    yes: { type: "boolean", default: false, description: "Actually delete. Without it: DRY RUN — previews the plan, changes nothing." },
    hardDelete: { type: "boolean", default: false, description: "Bypass the Recycle Bin (Bulk API hardDelete when permitted, else soft-delete + emptyRecycleBin) so storage actually frees." },
  },

  async check(args) {
    const client = new SfCliClient(args.org);
    const result = await runPurge(purgeReader(client), NULL_DELETER, toRunArgs(args, false));
    return { alreadyDone: false, ok: result.ok, reason: result.reason, matchedCount: result.matchedCount, predicate: result.predicate };
  },

  async run(args, ctx) {
    const client = new SfCliClient(args.org);
    const reader = purgeReader(client);

    if (args.yes) {
      const before = (await client.limits()).find((l) => l.name === "DataStorageMB");
      if (before) ctx.log(`DataStorageMB before: ${before.remaining}/${before.max} remaining`);
    }

    const target: PurgeDeleter = args.yes ? await JsforceLoadTarget.create(args.org, { onProgress: (m) => ctx.log(m) }) : NULL_DELETER;
    // Written BEFORE the first delete + flushed after EVERY chunk (purge/run.ts) — so a crash mid-run
    // leaves a durable, diagnosable partial manifest instead of nothing at all (only real deletes write).
    const manifestWriter = args.yes ? fsManifestWriter(args.org, args.sobject) : undefined;
    const result = await runPurge(reader, target, toRunArgs(args, args.yes), { onProgress: (m) => ctx.log(m), manifestWriter });

    if (!result.ok) throw new Error(result.reason ?? `purge of "${args.sobject}" refused`);

    if (!args.yes) {
      ctx.log(`DRY RUN — ${result.matchedCount} row(s) of ${args.sobject} match "${result.predicate || "(none — --all)"}" (~${result.estimatedMBFreed.toFixed(2)}MB)`);
      result.sample.forEach((s) => ctx.log(`  ${s.id}${s.display ? ` — ${s.display}` : ""}`));
      ctx.log("re-run with --yes to delete.");
      return;
    }

    ctx.log(`deleted ${result.deletedCount}/${result.matchedCount} record(s)${result.failedCount ? `, ${result.failedCount} failed` : ""}`);

    const after = (await client.limits()).find((l) => l.name === "DataStorageMB");
    if (after) ctx.log(`DataStorageMB after: ${after.remaining}/${after.max} remaining`);
  },

  async verify(args, ctx) {
    const client = new SfCliClient(args.org);
    const reader = purgeReader(client);

    if (!args.yes) {
      const preview = await runPurge(reader, NULL_DELETER, toRunArgs(args, false));
      return preview.ok ? { success: true, dryRun: true, matchedCount: preview.matchedCount } : { success: false, reason: preview.reason };
    }

    // Reads WHICHEVER state the manifest is in — "done" on a clean run, or the last durable
    // "planned"/"in_progress" snapshot if run() crashed mid-delete (purge/run.ts flushes after every chunk).
    const statePath = purgeStatePath(args.org, args.sobject);
    if (!existsSync(statePath)) return { success: false, reason: "no purge manifest found — run() may not have completed" };
    const state = parsePurgeManifest(readFileSync(statePath, "utf8"));

    const verified = await verifyPurge(reader, toRunArgs(args, true), { preCount: state.matchedCount, deletedCount: state.deletedCount });
    const after = (await client.limits()).find((l) => l.name === "DataStorageMB");
    if (after) ctx.log(`DataStorageMB after: ${after.remaining}/${after.max} remaining`);

    if (state.status !== "done") {
      // A crash left the manifest mid-flight — the delete DID progress (state.deletedCount rows, durably
      // recorded), but the overall purge never finished, so this is a genuine verify failure with an
      // honest diagnosis rather than either a false "success" or an opaque "no manifest found".
      return {
        success: false,
        reason: `purge did not complete (status "${state.status}") — ${state.deletedCount}/${state.matchedCount} row(s) deleted before it stopped`,
        remainingCount: verified.remainingCount,
        matchedCount: state.matchedCount,
        deletedCount: state.deletedCount,
        dataStorageMB: after ?? null,
      };
    }

    return {
      success: verified.success,
      remainingCount: verified.remainingCount,
      matchedCount: state.matchedCount,
      deletedCount: state.deletedCount,
      dataStorageMB: after ?? null,
      ...(verified.reason ? { reason: verified.reason } : {}),
    };
  },
};

export default purgeOp;
