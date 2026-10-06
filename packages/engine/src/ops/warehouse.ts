// packages/engine/src/ops/warehouse.ts
//
// `warehouse` — inspect/query the corpus warehouse. List the materialized corpora (manifests), show a
// corpus's per-object counts, sample rows, or run a guarded read-only SELECT for EDA/demos. This is the
// "the data is accessible" surface — plain SQL over the per-sObject tables.

import { WarehouseStore, DEFAULT_WAREHOUSE_PATH } from "@dataseed/warehouse";
import type { Op } from "./types.js";

interface WarehouseArgs extends Record<string, unknown> {
  warehouse?: string;
  ds?: string;
  object?: string;
  limit: number;
  counts?: boolean;
  sql?: string;
}

export const warehouseOp: Op<WarehouseArgs> = {
  id: "warehouse",
  name: "Inspect / query the corpus warehouse",
  description:
    "Read the corpus warehouse: list materialized corpora, show per-object counts (--counts --ds <id>), sample rows (--object <sObject> --ds <id>), or run a single read-only SELECT (--sql). The accessible-database surface over the materialized corpus.",
  idempotent: true,
  prerequisites: ["a materialized corpus (run `materialize` first)"],
  affects: ["nothing — read-only"],
  args: {
    warehouse: { type: "string", description: `Warehouse DB path (default ${DEFAULT_WAREHOUSE_PATH}).` },
    ds: { type: "string", description: "Corpus dataset id to inspect (ds_…). Omit to list all corpora." },
    object: { type: "string", description: "Sample rows for this sObject (needs --ds)." },
    limit: { type: "number", default: 10, description: "Row limit for samples." },
    counts: { type: "boolean", default: false, description: "Show per-object record counts for --ds." },
    sql: { type: "string", description: 'A single read-only SELECT, e.g. "SELECT count(*) FROM wh_Account".' },
  },

  check() {
    return { alreadyDone: false }; // read-only inspection — always runs
  },

  run(args, ctx) {
    const store = new WarehouseStore(args.warehouse ?? DEFAULT_WAREHOUSE_PATH);
    try {
      if (args.sql) {
        const rows = store.query(args.sql);
        ctx.log(`${rows.length} row(s):`);
        for (const r of rows.slice(0, args.limit)) ctx.log("  " + JSON.stringify(r));
        return;
      }
      if (!args.ds) {
        const manifests = store.listManifests();
        ctx.log(`${manifests.length} corpus(es) in the warehouse:`);
        for (const m of manifests) ctx.log(`  ${m.dsId}  pack=${m.pack} seed=${m.seed} records=${m.totalRecords} built=${m.builtAt ?? "?"}`);
        return;
      }
      const manifest = store.getManifest(args.ds);
      if (!manifest) {
        ctx.log(`no corpus "${args.ds}" in the warehouse`);
        return;
      }
      if (args.object) {
        const rows = store.sample(args.ds, args.object, args.limit);
        ctx.log(`${args.object} — ${manifest.counts[args.object] ?? 0} total, sampling ${rows.length}:`);
        for (const r of rows) ctx.log("  " + JSON.stringify(r));
        return;
      }
      // default / --counts: the corpus summary
      ctx.log(`corpus ${manifest.dsId}: ${manifest.totalRecords} records across ${Object.keys(manifest.counts).length} objects (built ${manifest.builtAt ?? "?"})`);
      for (const [obj, n] of Object.entries(manifest.counts).sort((a, b) => b[1] - a[1])) ctx.log(`  ${obj}: ${n}`);
    } finally {
      store.close();
    }
  },

  verify() {
    return { success: true };
  },
};

export default warehouseOp;
