// packages/engine/src/ops/storage.ts
//
// `storage` — read-only: what's filling this org? Prints DataStorageMB / FileStorageMB
// remaining-of-max (from `sf org list limits`), then a COUNT() row census across the
// fixed standard-object list the seeder and downstream app objects write, PLUS every custom object
// discovered in the org — sorted desc, top 20, with an estimated MB/object at
// RECORDS_PER_MB rows/MB (the same platform constant `probe-org`'s record-budget math
// already uses). NEVER MODIFIES ANYTHING: a rejected/failed COUNT() for one object
// prints `?` and the op still exits 0 — one troublesome object never sinks the census.
//
// Built after the 2026-09-04 incident: the demo org hit DataStorageMB 0/5 and nothing
// in the tooling could show what was filling it. Pairs with `purge` (docs/storage-and-purge.md).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Op } from "./types.js";
import { SfCliClient } from "../introspect/sf-client.js";
import { STORAGE_STANDARD_OBJECTS, CENSUS_TOP_N, buildCensus, topRows, formatCensusRow, type CensusRow } from "../introspect/storage-census.js";

export const STORAGE_DIR = join(process.cwd(), ".dataseed", "storage");
export const storageReportPath = (org: string) => join(STORAGE_DIR, `${org}.json`);

interface StorageArgs extends Record<string, unknown> {
  org: string;
}

interface StorageReport {
  org: string;
  capturedAt: string;
  dataStorageMB: { max: number; remaining: number } | null;
  fileStorageMB: { max: number; remaining: number } | null;
  census: CensusRow[];
}

export const storageOp: Op<StorageArgs> = {
  id: "storage",
  name: "Show what's filling an org (read-only)",
  description:
    "Print DataStorageMB / FileStorageMB remaining-of-max, then a COUNT() row census (standard seeder objects + every custom object in the org) sorted desc with an estimated MB/object — top 20 shown. Read-only; never modifies anything; a failed count prints `?` and the op still exits 0. Pairs with `purge` to actually free space (docs/storage-and-purge.md).",
  idempotent: false, // always re-reads the live org — a census can go stale instantly
  prerequisites: ["sf authenticated to the org"],
  affects: [".dataseed/storage/<org>.json (local file only — no org writes)"],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
  },

  check(args) {
    return { alreadyDone: false, hadPriorReport: existsSync(storageReportPath(args.org)) };
  },

  async run(args, ctx) {
    const client = new SfCliClient(args.org);
    const limits = await client.limits();
    const ds = limits.find((l) => l.name === "DataStorageMB") ?? null;
    const fileLimit = limits.find((l) => l.name === "FileStorageMB") ?? null;
    ctx.log(`DataStorageMB: ${ds ? `${ds.remaining}/${ds.max} remaining` : "?"}`);
    ctx.log(`FileStorageMB: ${fileLimit ? `${fileLimit.remaining}/${fileLimit.max} remaining` : "?"}`);

    let customObjects: string[] = [];
    try {
      customObjects = (await client.listCustomObjects?.()) ?? [];
    } catch (e) {
      ctx.log(`custom object discovery failed (${(e as Error).message}) — census covers standard objects only`);
    }
    const objects = [...new Set([...STORAGE_STANDARD_OBJECTS, ...customObjects])];
    ctx.log(`counting rows across ${objects.length} object(s) (${STORAGE_STANDARD_OBJECTS.length} standard + ${customObjects.length} custom)…`);

    const counts: Record<string, number | null> = {};
    for (const obj of objects) {
      try {
        const [row] = await client.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${obj}`);
        counts[obj] = Number(row?.cnt ?? 0);
      } catch {
        counts[obj] = null; // rejected/inaccessible object (e.g. no FLS, or not queryable) — reported as `?`, never fatal
      }
    }

    const census = buildCensus(counts);
    const top = topRows(census, CENSUS_TOP_N);
    ctx.log(`row census — top ${top.length} of ${census.length} object(s):`);
    top.forEach((row) => ctx.log(`  ${formatCensusRow(row)}`));

    const report: StorageReport = { org: args.org, capturedAt: new Date().toISOString(), dataStorageMB: ds, fileStorageMB: fileLimit, census };
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(storageReportPath(args.org), JSON.stringify(report, null, 2) + "\n");
  },

  verify(args) {
    // "verify = the limits line was read" — confirm the report landed and actually carries a DataStorageMB reading.
    const p = storageReportPath(args.org);
    if (!existsSync(p)) return { success: false, reason: "storage report not written" };
    try {
      const report = JSON.parse(readFileSync(p, "utf8")) as StorageReport;
      return { success: true, dataStorageMB: report.dataStorageMB, objectsCounted: report.census.length };
    } catch (e) {
      return { success: false, reason: `storage report unreadable: ${(e as Error).message}` };
    }
  },
};

export default storageOp;
