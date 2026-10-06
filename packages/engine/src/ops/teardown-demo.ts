// packages/engine/src/ops/teardown-demo.ts
//
// `teardown-demo` — delete the records a dataset seeded, so an org can be cleanly
// re-loaded (the recovery path for the M4 partial-load limitation, and the reset
// for demo iteration). DESTRUCTIVE but SAFE BY DESIGN: scoped to the seeded
// Accounts + their subtree (children found by parent Id), reverse dependency order,
// resilient. DRY-RUN BY DEFAULT — it previews the plan and changes nothing; pass
// --yes to actually delete. Deletes RECORDS only, never the org.
//
// Resolves the Account-name set to delete from EITHER source a load can come from: the plan-demo
// registry (default), or a warehouse corpus slice via --warehouse/--dsId (mirroring load-warehouse's own
// resolution) — previously teardown-demo could ONLY resolve via the registry, so it had no way at all to
// clean up anything loaded via load-warehouse: it either threw "no dataset" or, worse, silently deleted an
// UNRELATED registry dataset's Accounts if one happened to exist for the same (org, pack).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRegistry, type Dataset } from "@dataseed/registry";
import { WarehouseStore, DEFAULT_WAREHOUSE_PATH } from "@dataseed/warehouse";
import type { GenericRecord } from "@dataseed/core";
import type { Op, OpContext } from "./types.js";
import { latestDatasetFor } from "../store/bundle-store.js";
import { JsforceLoadTarget } from "../load/connection.js";
import { teardownBundle } from "../load/teardown.js";
import { buildWarehouseSlice } from "../store/warehouse-slice.js";
import { resolveManifest } from "./load-warehouse.js";
import { planDripTeardownFor } from "./drip.js";
import type { DripObject } from "../drip/types.js";

export const TEARDOWN_DIR = join(process.cwd(), ".dataseed", "teardowns");
export const teardownReportPath = (org: string, pack: string) => join(TEARDOWN_DIR, `${org}-${pack}.json`);

interface TeardownArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  yes: boolean;
  /** Warehouse-corpus teardown: when given, resolve the account set from a warehouse slice instead of the
   *  plan-demo registry. Pass the SAME --accounts/--dsId/--warehouse you loaded with (load-warehouse), else
   *  the slice — and so the delete — won't match what's actually in the org. */
  warehouse?: string;
  dsId?: string;
  accounts?: number;
  leads?: number;
  /** Also plan/delete records the `drip` op inserted (EmailMessage/Task/ContentVersion — see
   *  .dataseed/drip/<org>/*.json manifests), on top of whatever the base teardown resolves above.
   *  Dry-run by default like the rest of this op; --yes deletes both. */
  includeDrip?: boolean;
}

/** Total planned-for-deletion record count across a drip teardown plan (object → Ids). */
function dripPlanTotal(plan: Record<DripObject, string[]>): number {
  return Object.values(plan).reduce((sum, ids) => sum + ids.length, 0);
}

/** Resolve the Account + Lead rows to tear down — either the plan-demo registry's dataset (default), or a
 *  warehouse corpus slice (when --warehouse/--dsId is given). teardownBundle reads `.records.Account`
 *  (Name-matching) and `.records.Lead` (Email-matching), so that's all this needs to produce. Returns null
 *  when no dataset/corpus is found (the caller reports that as a normal "nothing to tear down" state). */
function resolveAccountsToTeardown(args: TeardownArgs, ctx: OpContext): { accounts: GenericRecord[]; leads: GenericRecord[]; source: string } | null {
  if (args.warehouse || args.dsId) {
    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const store = new WarehouseStore(whPath);
    try {
      const manifest = resolveManifest(store, args.dsId, args.pack, whPath);
      const pack = ctx.packs.get(args.pack);
      const slice = buildWarehouseSlice(store, manifest.dsId, pack.objects, manifest.counts, { accounts: args.accounts ?? 100, leads: args.leads ?? 0 });
      return { accounts: slice.records.Account ?? [], leads: slice.records.Lead ?? [], source: `warehouse corpus ${manifest.dsId} (first ${args.accounts ?? 100} account(s))` };
    } finally {
      store.close();
    }
  }
  const store = openRegistry();
  try {
    const ds: Dataset | null = latestDatasetFor(store, args.org, args.pack);
    if (!ds) return null;
    return { accounts: ds.bundle.records.Account ?? [], leads: ds.bundle.records.Lead ?? [], source: `dataset ${ds.id}` };
  } finally {
    store.close();
  }
}

export const teardownDemoOp: Op<TeardownArgs> = {
  id: "teardown-demo",
  name: "Delete the records a dataset seeded (reset an org)",
  description:
    "Delete the records the current dataset seeded into the org — scoped to the seeded Accounts + Leads and their subtree (CaseComment → CampaignMember → ContentDocument → Task → Event → EmailMessage → Opportunity → Case → Asset → Contact → Lead → Account; OLI/OCR cascade with their Opportunity; transcript files removed via their parent ContentDocument, since a ContentVersion can't be deleted directly). DRY-RUN BY DEFAULT (previews, changes nothing); pass --yes to delete. Deletes records only, never the org. The clean-reload path for a partial load.",
  idempotent: true,
  prerequisites: ["a dataset from plan-demo (run plan-demo first)", "sf authenticated to the org with delete permissions"],
  affects: ["<org>: DELETES the seeded Account/Lead subtree — Contact, Opportunity (+OLI/OCR cascade), Case (+CaseComment), Asset, Task, Event, EmailMessage, ContentDocument (transcript files), CampaignMember (only records under the dataset's Account names / Lead emails). Dry-run unless --yes."],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
    pack: { type: "string", default: "salescloud", description: "Target pack id (dataset source)." },
    yes: { type: "boolean", default: false, description: "Actually delete. Without it, this is a DRY RUN that only previews the plan." },
    warehouse: { type: "string", description: "Tear down a WAREHOUSE corpus slice instead of a plan-demo dataset — pass the same warehouse DB path you loaded with (load-warehouse)." },
    dsId: { type: "string", description: "Corpus id to tear down (with --warehouse; default: the sole ready corpus for the pack)." },
    accounts: { type: "number", default: 100, description: "With --warehouse/--dsId: number of root Accounts to resolve (must match the --accounts you loaded with)." },
    leads: { type: "number", default: 0, description: "With --warehouse/--dsId: number of funnel Leads to resolve (must match the --leads you loaded with)." },
    includeDrip: { type: "boolean", default: false, description: "Also plan/delete records the `drip` op inserted (reads every .dataseed/drip/<org>/*.json manifest). Dry-run by default; --yes deletes these too." },
  },

  check(args, ctx) {
    const found = resolveAccountsToTeardown(args, ctx);
    const dripPlan = args.includeDrip ? planDripTeardownFor(args.org) : null;
    return {
      alreadyDone: false,
      datasetFound: !!found,
      ...(found ? { source: found.source } : {}),
      ...(dripPlan ? { dripRecordsFound: dripPlanTotal(dripPlan) } : {}),
    };
  },

  async run(args, ctx) {
    const found = resolveAccountsToTeardown(args, ctx);
    // Without --include-drip, no base dataset/corpus really is "nothing to tear down" — same as
    // before. WITH --include-drip, a missing base dataset must NOT block it: the registry.db +
    // bundle under .dataseed/ are LOCAL to whichever machine ran plan-demo/load-demo, while a drip
    // manifest is written locally by whichever machine ran `drip --yes` — in practice those can
    // easily be two different histories, and drip records must still be removable either way.
    if (!found && !args.includeDrip) {
      throw new Error(
        args.warehouse || args.dsId
          ? `no ready corpus for pack "${args.pack}" in ${args.warehouse ?? "the default warehouse"}. Run: dataseed run materialize --pack ${args.pack} …`
          : `no dataset for ${args.org}/${args.pack}. Run: dataseed run plan-demo --org ${args.org} --pack ${args.pack}`,
      );
    }

    ctx.log(`connecting to ${args.org} (reusing sf auth)…`);
    const target = await JsforceLoadTarget.create(args.org);

    const dryRun = !args.yes;
    if (dryRun) ctx.log("DRY RUN — previewing the deletion plan (nothing will be deleted). Re-run with --yes to delete.");
    if (found) ctx.log(`resolved account set from ${found.source}`);
    else ctx.log("no plan-demo/load-demo dataset found for this org — skipping the base teardown plan (--include-drip only).");

    // An empty {Account:[],Lead:[]} bundle hits teardownBundle's own zero-names fast path and
    // returns the all-zero report immediately (no wasted queries) — exactly what "no dataset" wants.
    const report = await teardownBundle({ records: { Account: found?.accounts ?? [], Lead: found?.leads ?? [] } }, target, { dryRun, onProgress: (m) => ctx.log(m) });

    // --include-drip: on top of the base plan above, also plan/delete every record the `drip` op has
    // ever inserted for this org (its own manifests, not the plan-demo/load-demo dataset at all).
    let dripReport: { dryRun: boolean; objects: Array<{ object: DripObject; matched: number; deleted: number; errors: string[] }>; totalDeleted: number } | undefined;
    if (args.includeDrip) {
      const plan = planDripTeardownFor(args.org);
      const objects: Array<{ object: DripObject; matched: number; deleted: number; errors: string[] }> = [];
      let totalDeleted = 0;
      for (const object of Object.keys(plan) as DripObject[]) {
        const ids = plan[object] ?? [];
        if (ids.length === 0) continue;
        if (dryRun) {
          objects.push({ object, matched: ids.length, deleted: 0, errors: [] });
          continue;
        }
        const results = await target.deleteRecords(object, ids);
        const deleted = results.filter((r) => r.success).length;
        const errors = results.filter((r) => !r.success).flatMap((r) => r.errors).slice(0, 5);
        objects.push({ object, matched: ids.length, deleted, errors });
        totalDeleted += deleted;
      }
      dripReport = { dryRun, objects, totalDeleted };
      const wouldOrDid = dryRun ? "would delete" : "deleted";
      if (objects.length === 0) ctx.log("--include-drip: no drip-manifest records found for this org.");
      else ctx.log(`--include-drip: ${wouldOrDid} ${objects.reduce((a, o) => a + (dryRun ? o.matched : o.deleted), 0)} record(s) — ${objects.map((o) => `${o.object} ${dryRun ? o.matched : o.deleted}`).join(", ")}`);
    }

    mkdirSync(TEARDOWN_DIR, { recursive: true });
    writeFileSync(teardownReportPath(args.org, args.pack), JSON.stringify({ ...report, ...(dripReport ? { drip: dripReport } : {}) }, null, 2) + "\n");

    if (report.accountsMatched === 0 && report.leadsMatched === 0 && !dripReport?.objects.length) {
      ctx.log(found ? "nothing to tear down — no seeded Account or Lead found in the org." : "nothing to tear down — no dataset/corpus resolved and no drip records found for this org.");
      return;
    }
    if (dryRun) {
      const wouldDelete = report.objects.reduce((a, o) => a + o.matched, 0);
      ctx.log(`would delete ${wouldDelete} record(s) under ${report.accountsMatched} Account(s) + ${report.leadsMatched} Lead(s): ${report.objects.filter((o) => o.matched).map((o) => `${o.object} ${o.matched}`).join(", ")}`);
      ctx.log("re-run with --yes to delete.");
    } else {
      ctx.log(`deleted ${report.totalDeleted} record(s) under ${report.accountsMatched} Account(s) + ${report.leadsMatched} Lead(s).`);
    }
  },

  async verify(args, ctx) {
    const rp = teardownReportPath(args.org, args.pack);
    if (!existsSync(rp)) return { success: false, reason: "no teardown report" };
    const report = JSON.parse(readFileSync(rp, "utf8"));
    const dripDeleted = (report.drip?.objects ?? []).reduce((a: number, o: { deleted: number }) => a + o.deleted, 0);
    if (report.dryRun) {
      return {
        success: true,
        dryRun: true,
        wouldDelete: report.objects.reduce((a: number, o: { matched: number }) => a + o.matched, 0),
        ...(report.drip ? { dripWouldDelete: report.drip.objects.reduce((a: number, o: { matched: number }) => a + o.matched, 0) } : {}),
      };
    }

    // A real teardown is verified by the seeded Accounts + Leads (+ any drip records) being gone.
    const found = resolveAccountsToTeardown(args, ctx);
    const target = await JsforceLoadTarget.create(args.org);

    let dripRemaining = 0;
    if (report.drip) {
      const plan = planDripTeardownFor(args.org);
      for (const o of report.drip.objects as Array<{ object: DripObject; matched: number }>) {
        const ids = plan[o.object] ?? [];
        if (ids.length) dripRemaining += (await target.queryIds(o.object, "Id", ids)).length;
      }
    }

    if (!found) {
      const success = report.totalDeleted >= 0 && dripRemaining === 0;
      return { success, deleted: report.totalDeleted, dripDeleted, ...(dripRemaining ? { reason: `${dripRemaining} drip record(s) still present` } : {}) };
    }
    const acctNames = [...new Set(found.accounts.map((a) => a.Name).filter((v): v is string => typeof v === "string"))];
    const leadEmails = [...new Set(found.leads.map((l) => l.Email).filter((v): v is string => typeof v === "string"))];
    const remainingAccounts = acctNames.length ? await target.queryIds("Account", "Name", acctNames) : [];
    const remainingLeads = leadEmails.length ? await target.queryIds("Lead", "Email", leadEmails) : [];
    const remaining = remainingAccounts.length + remainingLeads.length + dripRemaining;
    return {
      success: remaining === 0,
      deleted: report.totalDeleted,
      dripDeleted,
      accountsRemaining: remainingAccounts.length,
      leadsRemaining: remainingLeads.length,
      ...(dripRemaining ? { dripRemaining } : {}),
      ...(remaining === 0 ? {} : { reason: `${remainingAccounts.length} seeded Account(s) / ${remainingLeads.length} seeded Lead(s) / ${dripRemaining} drip record(s) still present` }),
    };
  },
};

export default teardownDemoOp;
