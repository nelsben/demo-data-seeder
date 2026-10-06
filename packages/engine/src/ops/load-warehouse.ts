// packages/engine/src/ops/load-warehouse.ts
//
// `load-warehouse` — the warehouse→org BRIDGE. Loads a bounded, account-rooted SLICE of a materialized
// corpus (the warehouse, `materialize` op) into a live org through the same proven loader as `load-demo`.
//
// Why a slice, not the whole corpus: a 100K-account corpus is 3M+ records — a Dev/scratch org can't hold it
// (data-storage caps), and you rarely want it to. `--accounts N` lands the first N accounts + their full
// subtree (Contacts/Opps/OCR/OLI/Email/Task/Event/transcript/Asset/Case/CaseComment) + the shared scaffold
// (Product2/PricebookEntry/Campaign/User) + `--leads M` net-new funnel leads. The slice is referentially
// CLOSED (buildWarehouseSlice walks parents-first), so loadBundle resolves every in-slice `_ref` unchanged.
//
// ADDITIVELY IDEMPOTENT (skips Accounts already present + their subtree) and resilient (absent objects / row
// failures reported, not fatal), exactly like load-demo. `--cascade off` strips the trigger-firing streams.
//
// KNOWN LIMITATION: ContentVersion.VersionData (the VTT transcripts) needs base64 + ContentDocumentLink to
// land + link on a live org (docs/open-questions/m4-loader-hardening.md) — not yet implemented, so transcript
// rows are reported-failed-not-fatal here; the other 16 objects load. That base64 fix is the next increment.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WarehouseStore, DEFAULT_WAREHOUSE_PATH, type ManifestRow } from "@dataseed/warehouse";
import type { GenericRecord } from "@dataseed/core";
import type { Op } from "./types.js";
import { buildWarehouseSlice } from "../store/warehouse-slice.js";
import { loadBundle, type LoadReport } from "../load/loader.js";
import { JsforceLoadTarget } from "../load/connection.js";
import { excludeCascade, formatLoadObjectLines } from "../sinks/index.js";
import { fileCheckpoint } from "../load/checkpoint.js";

const LOAD_DIR = join(process.cwd(), ".dataseed", "loads");

interface LoadWarehouseArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  warehouse?: string;
  dsId?: string;
  accounts: number;
  leads: number;
  force: boolean;
  cascade: "on" | "off";
  checkpoint?: string;
  bulkThreshold?: number;
}

/** Resolve which corpus to load: explicit --dsId, else the sole ready corpus for the pack (error if ambiguous).
 *  Exported for teardown-demo.ts, which resolves the SAME corpus to rebuild the account-name set to delete. */
export function resolveManifest(store: WarehouseStore, dsId: string | undefined, pack: string, whPath: string): ManifestRow {
  if (dsId) {
    const m = store.getManifest(dsId);
    if (!m || m.status !== "ready") throw new Error(`no ready corpus for dsId "${dsId}" in ${whPath}. Run: dataseed run materialize --warehouse ${whPath} …`);
    return m;
  }
  const ready = store.listManifests().filter((m) => m.status === "ready" && m.pack === pack);
  if (ready.length === 0) throw new Error(`no ready corpus for pack "${pack}" in ${whPath}. Run: dataseed run materialize --pack ${pack} --warehouse ${whPath} …`);
  if (ready.length > 1) throw new Error(`multiple corpora in ${whPath} — pass --dsId. Candidates: ${ready.map((m) => `${m.dsId} (${m.totalRecords} recs)`).join(", ")}`);
  return ready[0]!;
}

export const loadWarehouseOp: Op<LoadWarehouseArgs> = {
  id: "load-warehouse",
  name: "Load a bounded slice of a materialized corpus into an org",
  description:
    "Load the first --accounts N accounts (+ their full subtree, the shared scaffold, and --leads M funnel leads) from a materialized warehouse corpus into a live org via the bulk loader. Additively idempotent; --cascade off for a structural-only load. The warehouse→org bridge for the 100K corpus.",
  idempotent: true,
  prerequisites: ["a materialized corpus (run materialize first)", "sf authenticated to the org with create permissions"],
  affects: [
    "<org>: standard CRM records for the sliced accounts + subtree; additive, deduped by Account.Name",
    "writes a load report to .dataseed/loads/<org>-<pack>-warehouse.json",
  ],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
    pack: { type: "string", default: "salescloud", description: "Target pack id (corpus source)." },
    warehouse: { type: "string", description: `Warehouse DB path (default ${DEFAULT_WAREHOUSE_PATH}).` },
    dsId: { type: "string", description: "Corpus id to load (default: the sole ready corpus for the pack)." },
    accounts: { type: "number", default: 100, description: "Number of root Accounts to load (their full subtree comes along)." },
    leads: { type: "number", default: 0, description: "Number of net-new funnel Leads to include (account-independent; 0 = none)." },
    force: { type: "boolean", default: false, description: "Load even if matching Accounts already exist (disables the idempotency skip)." },
    cascade: { type: "string", default: "on", enum: ["on", "off"], description: "off → strip the trigger-firing streams (EmailMessage/Task/ContentVersion) for a structural-only load." },
    checkpoint: { type: "string", description: "Checkpoint file path — resume a partially-loaded slice instead of restarting." },
    bulkThreshold: { type: "number", description: "Rows-per-object at/above which insert switches from REST collections to the Bulk API v1 (default 5000). Lower it (e.g. 50) to exercise the bulk path on a small slice." },
  },

  check(args) {
    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const store = new WarehouseStore(whPath);
    try {
      const m = resolveManifest(store, args.dsId, args.pack, whPath);
      return { alreadyDone: false, dsId: m.dsId, corpusAccounts: m.counts.Account ?? 0, sliceAccounts: Math.min(args.accounts, m.counts.Account ?? 0) };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const store = new WarehouseStore(whPath);
    try {
      const manifest = resolveManifest(store, args.dsId, args.pack, whPath);
      const pack = ctx.packs.get(args.pack);
      const slice = buildWarehouseSlice(store, manifest.dsId, pack.objects, manifest.counts, { accounts: args.accounts, leads: args.leads });
      ctx.log(`slice of ${manifest.dsId}: ${slice.stats.accounts} account(s) → ${slice.stats.totalRecords} records across ${Object.keys(slice.records).length} objects`);

      const records = args.cascade === "off" ? excludeCascade(pack, slice.records) : slice.records;
      if (args.cascade === "off") ctx.log(`cascade: off — excluded ${(pack.cascadeObjects ?? []).join(", ")} (structural load, no pipeline)`);

      ctx.log(`connecting to ${args.org} (reusing sf auth)…`);
      const target = await JsforceLoadTarget.create(args.org, args.bulkThreshold != null ? { bulkThreshold: args.bulkThreshold } : {});
      if (args.bulkThreshold != null) ctx.log(`bulk threshold: ${args.bulkThreshold} rows/object → Bulk API v1 above it`);
      const report = await loadBundle({ records }, pack, target, {
        ...(args.force ? {} : { idempotency: { object: "Account", field: "Name" } }),
        ...(args.checkpoint ? { checkpoint: fileCheckpoint(args.checkpoint) } : {}),
        onProgress: (m) => ctx.log(m),
      });

      mkdirSync(LOAD_DIR, { recursive: true });
      writeFileSync(join(LOAD_DIR, `${args.org}-${args.pack}-warehouse.json`), JSON.stringify(report, null, 2) + "\n");
      ctx.log(`loaded ${report.totalInserted} record(s)` + (report.idempotencySkipped ? `, skipped ${report.idempotencySkipped} existing` : ""));
      formatLoadObjectLines(report).forEach((l) => ctx.log(l));
    } finally {
      store.close();
    }
  },

  async verify(args, ctx) {
    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const store = new WarehouseStore(whPath);
    let acctNames: string[];
    let oppNames: string[];
    try {
      const manifest = resolveManifest(store, args.dsId, args.pack, whPath);
      const pack = ctx.packs.get(args.pack);
      const slice = buildWarehouseSlice(store, manifest.dsId, pack.objects, manifest.counts, { accounts: args.accounts, leads: args.leads });
      const names = (key: string) => [...new Set((slice.records[key] ?? []).map((r: GenericRecord) => r.Name).filter((v): v is string => typeof v === "string"))];
      acctNames = names("Account");
      oppNames = names("Opportunity");
    } finally {
      store.close();
    }
    if (acctNames.length === 0) return { success: true, note: "empty slice (0 accounts)" };

    // Confirm the cascade landed — Accounts AND their Opportunities (so a HALF-load fails instead of passing
    // on Account presence). Opp.Name can repeat across accounts, so we check distinct names are present.
    const target = await JsforceLoadTarget.create(args.org);
    const acctsPresent = await target.existingValues("Account", "Name", acctNames);
    const oppsPresent = oppNames.length ? await target.existingValues("Opportunity", "Name", oppNames) : new Set<string>();
    const ok = acctsPresent.size === acctNames.length && oppsPresent.size === oppNames.length;
    return {
      success: ok,
      accountsExpected: acctNames.length,
      accountsPresent: acctsPresent.size,
      opportunitiesExpected: oppNames.length,
      opportunitiesPresent: oppsPresent.size,
      ...(ok ? {} : { reason: "slice cascade incomplete — re-run after clearing the partial load" }),
    };
  },
};

export default loadWarehouseOp;
