// packages/engine/src/ops/materialize.ts
//
// `materialize` — generate a corpus and write it into the deterministic SQLite WAREHOUSE (one table per
// sObject), keyed as a content-addressed cache. Unlike plan-demo (which blobs the whole bundle into the
// registry), this lands the records as queryable rows you can SELECT against and stream-load later. Run
// it against the synthetic `standard` profile to build a corpus with NO live org.
//
// V1 is EAGER (generate the whole bundle, then write) — correct + simple, bounded by what generate() holds
// in memory (fine to tens of thousands of accounts). Streaming to a true 100K lands in a follow-on; the
// store + schema + cache here are the same either way.

import { existsSync, readFileSync } from "node:fs";
import { ScopeParams, type BundlePlan } from "@dataseed/core";
import { WarehouseStore, DEFAULT_WAREHOUSE_PATH, corpusKey, GENERATOR_VERSION } from "@dataseed/warehouse";
import type { Op } from "./types.js";
import { profilePath } from "./profile-org.js";
import { planBundle } from "../plan/plan.js";
import { generateBundle } from "../generate/generate.js";
import { streamMaterialize, type ScaffoldSlice } from "../generate/stream.js";
import { fillForegroundCopy } from "../generate/fill-foreground.js";
import { parseMix, defaultMix } from "./plan-demo.js";

/** A FIXED default anchor so re-materializing the same (seed, params) is a cache no-op. Override with --asOf. */
export const MATERIALIZE_DEFAULT_ASOF = "2026-01-01T00:00:00.000Z";

interface MaterializeArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  volume: number;
  population?: number;
  accounts?: number;
  bulkDensity?: number;
  userPoolSize?: number;
  userProfileName?: string;
  scenarioMix?: unknown;
  dc: string;
  copy?: string;
  seed?: string | number;
  asOf?: string;
  warehouse?: string;
  rematerialize?: boolean;
  batch?: number;
  eager?: boolean;
}

function buildScope(args: MaterializeArgs, packScenarios: readonly string[]) {
  const scenarioMix = parseMix(args.scenarioMix) ?? defaultMix(packScenarios);
  const population = args.accounts !== undefined ? Math.max(0, args.accounts - args.volume) : args.population;
  return ScopeParams.parse({
    org: args.org,
    pack: args.pack,
    volume: args.volume,
    ...(population !== undefined ? { population } : {}),
    ...(args.bulkDensity !== undefined ? { bulkDensity: args.bulkDensity } : {}),
    ...(args.userPoolSize !== undefined ? { userPoolSize: args.userPoolSize } : {}),
    ...(args.userProfileName !== undefined ? { userProfileName: args.userProfileName } : {}),
    scenarioMix,
    dc: args.dc,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    asOf: args.asOf ?? MATERIALIZE_DEFAULT_ASOF,
  });
}

export const materializeOp: Op<MaterializeArgs> = {
  id: "materialize",
  name: "Materialize a corpus into the SQLite warehouse",
  description:
    "Generate a corpus and write it into the deterministic SQLite warehouse (.dataseed/warehouse.db) as one queryable table per sObject — content-addressed so re-running the same (seed, params) is a no-op. Run against the synthetic `standard` profile (profile-org --synthetic) to build with NO live org. Inspect with `warehouse`; load later with load-demo --from-warehouse.",
  idempotent: true,
  prerequisites: ["a CapabilityProfile for the org (run `profile-org --org <org> --pack <pack>` — add --synthetic for no live org)"],
  affects: [".dataseed/warehouse.db (the corpus record store — additive per (seed, params); no org writes)"],
  args: {
    org: { type: "string", required: true, description: "Org alias whose profile to use (e.g. 'standard' for the synthetic profile)." },
    pack: { type: "string", default: "salescloud", description: "Target pack id." },
    volume: { type: "number", default: 12, description: "Foreground narrative deals." },
    population: { type: "number", description: "Bulk background accounts (the scale knob, e.g. 100000)." },
    accounts: { type: "number", description: "Convenience: target TOTAL accounts → population = max(0, accounts − volume)." },
    bulkDensity: { type: "number", description: "Bulk graph richness 0–1 (default 0.6)." },
    userPoolSize: { type: "number", description: "Sales-rep User pool size for OwnerId distribution (0 = off; ≤50)." },
    userProfileName: { type: "string", description: "Profile the pool users are created under (default 'Standard User')." },
    scenarioMix: { type: "string", description: 'e.g. "at-risk-budget:34,healthy-tech:33,rfp-gated:33".' },
    dc: { type: "string", default: "off", enum: ["auto", "on", "off"], description: "Data Cloud branch (default off — corpus is org-agnostic)." },
    copy: { type: "string", default: "static", enum: ["static", "claude-code", "anthropic", "auto", "none"], description: "Foreground hero-deal copy fill: static (deterministic, no API — default, never blank), claude-code/anthropic/auto (LLM, VP-grade copy, cached), none (deferred/blank for a pure-structural corpus)." },
    seed: { type: "string", description: "Reproducibility seed (number or string; default 42)." },
    asOf: { type: "string", description: `Timeline anchor (default ${MATERIALIZE_DEFAULT_ASOF} — fixed so re-runs are cache no-ops).` },
    warehouse: { type: "string", description: `Warehouse DB path (default ${DEFAULT_WAREHOUSE_PATH}).` },
    rematerialize: { type: "boolean", default: false, description: "Rebuild even if a matching corpus is already materialized." },
    batch: { type: "number", default: 5000, description: "Accounts per streaming batch (RSS/throughput knob; streaming bounds memory for 100K)." },
    eager: { type: "boolean", default: false, description: "Force the eager path (whole bundle in memory) instead of streaming. Mainly for parity testing." },
  },

  check(args, ctx) {
    const pPath = profilePath(args.org);
    if (!existsSync(pPath)) return { alreadyDone: false, hasProfile: false };
    const pack = ctx.packs.get(args.pack);
    const profile = JSON.parse(readFileSync(pPath, "utf8"));
    const scope = buildScope(args, pack.scenarios);
    const plan = planBundle(scope, profile, pack, scope.asOf!); // cheap — no record generation
    plan.copyMode = (args.copy ?? "static") as BundlePlan["copyMode"]; // copy mode is part of the corpus identity
    const { cacheKey } = corpusKey(plan);
    const store = new WarehouseStore(args.warehouse ?? DEFAULT_WAREHOUSE_PATH);
    try {
      const hit = store.findByCacheKey(cacheKey);
      return { alreadyDone: !!hit && !args.rematerialize, cacheKey, ...(hit ? { dsId: hit.dsId, totalRecords: hit.totalRecords } : {}) };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const pPath = profilePath(args.org);
    if (!existsSync(pPath)) {
      throw new Error(`no CapabilityProfile for "${args.org}". Run: dataseed run profile-org --org ${args.org} --pack ${args.pack}${args.org === "standard" ? " --synthetic" : ""}`);
    }
    const profile = JSON.parse(readFileSync(pPath, "utf8"));
    const pack = ctx.packs.get(args.pack);
    const scope = buildScope(args, pack.scenarios);
    const plan = planBundle(scope, profile, pack, scope.asOf!);
    plan.copyMode = (args.copy ?? "static") as BundlePlan["copyMode"]; // copy mode is part of the corpus identity
    const { dsId, paramsHash, cacheKey } = corpusKey(plan);
    const manifest = { dsId, pack: args.pack, seed: plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey, asOf: plan.asOf };

    // Stream when the pack's bulk tier is account-major (RSS bounded to one batch) — the only way 100K is
    // safe. Fall back to eager (whole bundle in memory) for foreground-only corpora, packs without locality,
    // or --eager (parity testing). The two paths are byte-identical (proven by the stream-parity test).
    const stream = !args.eager && pack.bulkRefLocality === "account-major" && plan.population > 0;
    if (!stream && plan.population > 40_000) {
      ctx.log(`⚠ eager materialize of ${plan.population} accounts may use ~${(plan.population * 0.00004).toFixed(1)}GB RAM. Drop --eager to stream (bounded RSS).`);
    }
    ctx.log(`generating corpus (${stream ? "streaming" : "eager"}, volume=${plan.volume}, population=${plan.population}, density=${plan.bulkDensity}, users=${plan.userPoolSize}, seed=${plan.seed})…`);

    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const store = new WarehouseStore(whPath);
    try {
      const existing = store.findByCacheKey(cacheKey);
      if (existing && !args.rematerialize) {
        ctx.log(`already materialized: ${existing.dsId} (${existing.totalRecords} records) — pass --rematerialize to rebuild`);
        return;
      }
      const builtAt = new Date().toISOString();
      const fillScaffold = (slice: ScaffoldSlice) => fillForegroundCopy(slice, plan.copyMode, plan.asOf, ctx.log);
      let counts: Record<string, number>;
      if (stream) {
        const res = await streamMaterialize(plan, profile, pack, store, manifest, builtAt, {
          batch: args.batch ?? 5000,
          onProgress: (done, total) => { if (done % ((args.batch ?? 5000) * 4) === 0 || done === total) ctx.log(`  …${done}/${total} accounts`); },
          fillScaffold, // fill the FOREGROUND hero copy (deferred CopyRequests) before the scaffold is written
        });
        counts = res.counts;
        ctx.log(`streamed in ${res.batches} batch(es)`);
      } else {
        const bundle = generateBundle(plan, profile, pack);
        await fillForegroundCopy(bundle, plan.copyMode, plan.asOf, ctx.log);
        counts = store.writeBundle(manifest, bundle.records, builtAt);
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      ctx.log(`materialized ${dsId} → ${whPath}`);
      ctx.log(`${total} records: ${Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      ctx.log(`inspect:  dataseed run warehouse --ds ${dsId} --counts`);
      ctx.log(`query:    dataseed run warehouse --sql "SELECT name, json_extract(payload_json,'$.StageName') AS stage FROM wh_Opportunity WHERE ds_id='${dsId}' LIMIT 10"`);
    } finally {
      store.close();
    }
  },

  verify(args, ctx) {
    const pPath = profilePath(args.org);
    if (!existsSync(pPath)) return { success: false, reason: "no profile" };
    const pack = ctx.packs.get(args.pack);
    const profile = JSON.parse(readFileSync(pPath, "utf8"));
    const scope = buildScope(args, pack.scenarios);
    const plan = planBundle(scope, profile, pack, scope.asOf!);
    plan.copyMode = (args.copy ?? "static") as BundlePlan["copyMode"]; // copy mode is part of the corpus identity
    const { cacheKey } = corpusKey(plan);
    const store = new WarehouseStore(args.warehouse ?? DEFAULT_WAREHOUSE_PATH);
    try {
      const hit = store.findByCacheKey(cacheKey);
      if (!hit) return { success: false, reason: "no ready corpus for this cache key" };
      return { success: hit.totalRecords > 0, dsId: hit.dsId, totalRecords: hit.totalRecords, objects: Object.keys(hit.counts).length };
    } finally {
      store.close();
    }
  },
};

export default materializeOp;
