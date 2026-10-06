// packages/engine/src/ops/disperse.ts
//
// `disperse` — the generalized dispersal verb (load-demo is its salesforce-only
// sibling). Resolve a registry dataset (by --dataset id, or the latest for
// --org/--pack) and disperse it through a sink: salesforce (load into an org),
// file (write JSON), or return (hand the bundle back). "Generate once, disperse
// many" — each dispersal is recorded in the dataset's load-history.

import { openRegistry, type Dataset, type RegistryStore } from "@dataseed/registry";
import type { Op } from "./types.js";
import { latestDatasetFor } from "../store/bundle-store.js";
import { buildSinks, disperseDataset, formatLoadObjectLines } from "../sinks/index.js";
import type { LoadReport } from "../load/loader.js";

interface DisperseArgs extends Record<string, unknown> {
  org?: string;
  pack: string;
  sink: string;
  dataset?: string;
  target?: string;
  force: boolean;
  /** salesforce: rows-per-object at/above which insert switches from REST collections to the Bulk API v1
   *  (default 5000). Lower it on a scratch org with a tight daily REST budget. */
  bulkThreshold?: number;
}

/** Resolve the dataset to disperse: explicit --dataset id wins, else the latest for (org, pack). */
function resolveDataset(store: RegistryStore, args: DisperseArgs): Dataset | null {
  if (args.dataset) return store.get(args.dataset);
  if (args.org) return latestDatasetFor(store, args.org, args.pack);
  return null;
}

export const disperseDemoOp: Op<DisperseArgs> = {
  id: "disperse",
  name: "Disperse a dataset to a sink (org / file / caller)",
  description:
    "Disperse a generated dataset to a sink: salesforce (load into an org), file (write the bundle JSON), or return (hand the bundle back to the caller). Resolve the dataset by --dataset <id> or the latest for --org/--pack. Generate once, disperse many — every dispersal is appended to the dataset's load-history.",
  idempotent: true,
  prerequisites: [
    "a dataset in the registry (run plan-demo first)",
    "for --sink salesforce: sf authenticated to --target with create permissions",
  ],
  affects: [
    "--sink salesforce: standard CRM records in --target (additive, deduped by Account.Name)",
    "--sink file: writes the --target path",
    "registry: appends a load-history entry to the dataset",
  ],
  args: {
    org: { type: "string", description: "Resolve the latest dataset for this org (with --pack) when --dataset is omitted." },
    pack: { type: "string", default: "salescloud", description: "Target pack id." },
    sink: { type: "string", default: "salesforce", enum: ["salesforce", "file", "return"], description: "Where to disperse." },
    dataset: { type: "string", description: "Dataset id to disperse (overrides --org/--pack resolution)." },
    target: { type: "string", description: "Destination: org alias (salesforce, defaults to --org) or file path (file)." },
    force: { type: "boolean", default: false, description: "salesforce: load even if matching Accounts exist (disables the idempotency skip)." },
    bulkThreshold: { type: "number", description: "salesforce: rows-per-object at/above which insert switches from REST collections to the Bulk API v1 (default 5000). Lower it (e.g. 200) on a scratch org with a tight daily API budget." },
  },

  check(args) {
    const store = openRegistry();
    try {
      const ds = resolveDataset(store, args);
      return { alreadyDone: false, datasetFound: !!ds, ...(ds ? { datasetId: ds.id, status: ds.status } : {}) };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const store = openRegistry();
    try {
      const ds = resolveDataset(store, args);
      if (!ds) {
        const where = args.dataset ? `id ${args.dataset}` : `latest ${args.org ?? "?"}/${args.pack}`;
        throw new Error(`no dataset to disperse (${where}). Run: dataseed run plan-demo --org <org> --pack ${args.pack}`);
      }
      const sink = buildSinks({ resolvePack: (id) => ctx.packs.get(id) }).get(args.sink);
      if (!sink) throw new Error(`unknown sink "${args.sink}" (expected salesforce | file | return)`);

      // Fall back to the dataset's OWN recorded org when resolving by --dataset <id> (the whole point of
      // that path is to not require --org) — otherwise `disperse --dataset ds_xyz --sink salesforce` always
      // threw "requires a --target org alias" even though the dataset already knows its own org.
      const target = args.target ?? (args.sink === "salesforce" ? (args.org ?? ds.params.org) : undefined);
      ctx.log(`dispersing ${ds.id} (${ds.pack}/${ds.status}) → ${sink.id}${target ? ` @ ${target}` : ""}…`);

      if (args.bulkThreshold != null) ctx.log(`bulk threshold: ${args.bulkThreshold} rows/object → Bulk API v1 above it`);
      const report = await disperseDataset(store, ds, sink, {
        now: new Date().toISOString(),
        force: args.force,
        ...(target ? { target } : {}),
        ...(args.bulkThreshold != null ? { bulkThreshold: args.bulkThreshold } : {}),
        onProgress: (m) => ctx.log(m),
      });

      ctx.log(report.summary);
      if (report.sink === "salesforce") formatLoadObjectLines(report.detail as LoadReport).forEach((l) => ctx.log(l));
    } finally {
      store.close();
    }
  },

  verify(args) {
    const store = openRegistry();
    try {
      const ds = resolveDataset(store, args);
      if (!ds) return { success: false, reason: "dataset not found" };
      const loads = store.loadsFor(ds.id);
      const last = loads[0];
      // A run() that dispersed records the dispersal; verify confirms it landed in history for the chosen sink.
      const ok = !!last && last.sink === args.sink;
      return { success: ok, datasetId: ds.id, dispersals: loads.length, ...(last ? { lastSink: last.sink, lastTarget: last.target, inserted: last.inserted } : {}) };
    } finally {
      store.close();
    }
  },
};

export default disperseDemoOp;
