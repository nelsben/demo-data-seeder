// packages/engine/src/ops/load-demo.ts
//
// `load-demo` — disperse the current dataset for (org, pack) into the org through
// the Salesforce sink (Account → Contact → Opportunity → OCR → EmailMessage →
// Task → …), resolving lookups as parents insert. The salesforce-specific sibling
// of `disperse`; kept as the familiar verb. ADDITIVELY IDEMPOTENT: re-running skips
// Accounts that already exist (and their subtrees). Resilient: objects the org
// lacks and request-level failures are reported and skipped, not fatal. Every load
// is recorded in the dataset's registry load-history.
//
// KNOWN LIMITATION (idempotency is root-Account-grained; see docs/open-questions/
// m4-loader-hardening.md): a load that fails PART-WAY (Accounts committed, children
// not) is not auto-healed by a re-run — the existing Account suppresses its whole
// subtree. verify() checks Opportunities too, so it FAILS loudly on a half-load.
// Recovery today is teardown-then-reload; target dedicated demo/scratch orgs.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRegistry } from "@dataseed/registry";
import type { GenericRecord } from "@dataseed/core";
import type { Op } from "./types.js";
import { latestDatasetFor } from "../store/bundle-store.js";
import { salesforceSink, disperseDataset, formatLoadObjectLines } from "../sinks/index.js";
import { JsforceLoadTarget } from "../load/connection.js";
import type { LoadReport } from "../load/loader.js";

export const LOAD_DIR = join(process.cwd(), ".dataseed", "loads");
export const loadReportPath = (org: string, pack: string) => join(LOAD_DIR, `${org}-${pack}.json`);

interface LoadArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  force: boolean;
  /** Rows-per-object at/above which insert switches from REST collections to the Bulk API v1 (default
   *  5000). Lower it on a scratch org with a tight daily REST budget — the Bulk API costs ~1 batch per
   *  10K rows instead of 1 REST call per 200, so more of the load routes off the REST budget entirely. */
  bulkThreshold?: number;
}

export const loadDemoOp: Op<LoadArgs> = {
  id: "load-demo",
  name: "Load the current dataset for an org into the org",
  description:
    "Disperse the current dataset for (org, pack) into the org via the Salesforce sink — Account → Contact → Opportunity → OCR → EmailMessage → Task, resolving lookups as parents insert. Additively idempotent (skips existing Accounts + subtrees). Objects the org lacks are reported, not fatal. Records the load in the dataset's load-history.",
  idempotent: true,
  prerequisites: ["a dataset from plan-demo (run plan-demo first)", "sf authenticated to the org with create permissions"],
  affects: [
    "<org>: standard CRM records (Account/Contact/Opportunity/OCR/EmailMessage/Task); additive, deduped by Account.Name",
    "registry: appends a load-history entry to the dataset",
  ],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
    pack: { type: "string", default: "salescloud", description: "Target pack id (dataset source)." },
    force: { type: "boolean", default: false, description: "Load even if matching Accounts already exist (disables the idempotency skip)." },
    bulkThreshold: { type: "number", description: "Rows-per-object at/above which insert switches from REST collections to the Bulk API v1 (default 5000). Lower it (e.g. 200) on a scratch org with a tight daily API budget." },
  },

  check(args) {
    const store = openRegistry();
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      return { alreadyDone: false, datasetFound: !!ds, ...(ds ? { datasetId: ds.id, status: ds.status } : {}) };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const store = openRegistry();
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      if (!ds) {
        throw new Error(`no dataset for ${args.org}/${args.pack}. Run: dataseed run plan-demo --org ${args.org} --pack ${args.pack}`);
      }
      const sink = salesforceSink({ resolvePack: (id) => ctx.packs.get(id) });
      ctx.log(`connecting to ${args.org} (reusing sf auth)…`);
      if (args.bulkThreshold != null) ctx.log(`bulk threshold: ${args.bulkThreshold} rows/object → Bulk API v1 above it`);
      const report = await disperseDataset(store, ds, sink, {
        now: new Date().toISOString(),
        target: args.org,
        force: args.force,
        ...(args.bulkThreshold != null ? { bulkThreshold: args.bulkThreshold } : {}),
        onProgress: (m) => ctx.log(m),
      });

      const load = report.detail as LoadReport;
      mkdirSync(LOAD_DIR, { recursive: true });
      writeFileSync(loadReportPath(args.org, args.pack), JSON.stringify(load, null, 2) + "\n");

      ctx.log(report.summary);
      formatLoadObjectLines(load).forEach((l) => ctx.log(l));

      // Phase 4F — if a User pool was requested but none seated (license-exhausted / Manage-Users denied:
      // the inserts are ATTEMPTED and fail per-row, not pre-skipped), the bulk OwnerId soft-refs all drop
      // and the org silently falls back to running-user ownership. Surface that plainly rather than leaving
      // it buried in the per-row failure list.
      const wantUsers = (ds.bundle.plan.userPoolSize ?? 0) > 0;
      if (wantUsers) {
        const u = load.objects.find((o) => o.object === "User");
        const seated = (u?.inserted ?? 0) + (u?.reused ?? 0);
        if (seated === 0) ctx.log(`⚠ User pool unavailable (0 of ${ds.bundle.plan.userPoolSize} seated) — bulk records owned by the running user. Check User-license headroom / Manage Users, or set userProfileName.`);
      }
    } finally {
      store.close();
    }
  },

  async verify(args) {
    const store = openRegistry();
    let bundle;
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      if (!ds) return { success: false, reason: "no dataset to verify against" };
      bundle = ds.bundle;
    } finally {
      store.close();
    }

    const names = (key: "Account" | "Opportunity") => [
      ...new Set((bundle.records[key] ?? []).map((r: GenericRecord) => r.Name).filter((v): v is string => typeof v === "string")),
    ];
    const acctNames = names("Account");
    const oppNames = names("Opportunity");
    if (acctNames.length === 0) return { success: true, note: "no Accounts in dataset" };

    // Confirm the cascade landed — Accounts AND their Opportunities. Checking Opps too is what makes a
    // HALF-load (Accounts in, children missing) fail verify instead of falsely passing on Account presence.
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
      ...(ok ? {} : { reason: "cascade incomplete — re-run after clearing the partial load (per-child backfill is a later milestone)" }),
    };
  },
};

export default loadDemoOp;
