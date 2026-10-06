// packages/engine/src/ops/seed-account.ts
//
// `seed-account` — the SINGLE-ACCOUNT protocol, the atomic unit for the 100K scale-up. It produces ONE
// realistic, fully-SYNTHETIC Salesforce account end-to-end with NO live org:
//   1. author a fictional company IDENTITY via the LLM (cached by (seed, index) → byte-stable re-runs),
//   2. fan out the full Sales Cloud object graph for that account (the existing per-unit generator),
//   3. fill the prose (emails/tasks/transcripts) via the copy layer,
//   4. write it into the deterministic SQLite WAREHOUSE (wh_<Object>) — the loader-injectable corpus format.
//
// Composes existing stages (planBundle / authorIdentities / generateBundleWithIdentities / the copy
// pipeline / writeBundle) — nothing here is reimplemented. Runs against an in-memory synthetic profile, so
// it needs no profile-org first. --provider static keeps it fully offline + deterministic (no API credits).

import { standardProfile, type CapabilityProfile, type BundlePlan, type TargetPack, ScopeParams } from "@dataseed/core";
import { WarehouseStore, DEFAULT_WAREHOUSE_PATH, corpusKey, GENERATOR_VERSION } from "@dataseed/warehouse";
import type { Op } from "./types.js";
import { planBundle } from "../plan/plan.js";
import { generateBundleWithIdentities } from "../generate/generate.js";
import { authorIdentities, buildIdentityProviders, fileIdentityCache } from "../identity/index.js";
import { authorDossiers, buildSpineProviders, fileDossierCache } from "../spine/index.js";
import { buildProviders, fillCopy, applyCopy, attachSpineContext } from "../copy/index.js";

/** A FIXED default anchor so re-seeding the same (seed, scenario) is a cache no-op. Override with --asOf. */
export const SEED_ACCOUNT_DEFAULT_ASOF = "2026-01-01T00:00:00.000Z";
const DEFAULT_SCENARIO = "healthy-tech"; // a priorWin archetype → the account gets an Asset + Case (installed base)

interface SeedAccountArgs extends Record<string, unknown> {
  pack: string;
  seed?: string | number;
  scenario: string;
  industry?: string;
  provider: string;
  asOf?: string;
  warehouse?: string;
  reseed?: boolean;
}

/** Build the plan for a one-account run (synthetic profile, volume 1, no bulk, a single scenario). */
function buildPlanFor(args: SeedAccountArgs, pack: TargetPack): { plan: BundlePlan; profile: CapabilityProfile } {
  const profile = standardProfile(pack);
  const scenario = args.scenario || DEFAULT_SCENARIO;
  const scope = ScopeParams.parse({
    org: profile.org,
    pack: args.pack,
    volume: 1,
    population: 0,
    scenarioMix: { [scenario]: 100 },
    dc: "off",
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    asOf: args.asOf ?? SEED_ACCOUNT_DEFAULT_ASOF,
  });
  return { plan: planBundle(scope, profile, pack, scope.asOf!), profile };
}

export const seedAccountOp: Op<SeedAccountArgs> = {
  id: "seed-account",
  name: "Seed ONE synthetic account (identity → full graph → prose) into the warehouse",
  description:
    "The single-account protocol: an LLM authors a fully-synthetic company IDENTITY, the per-account fan-out builds its full Sales Cloud object graph (Account → Contacts → Opportunity[+prior win] → contact roles → line items → emails/tasks/transcripts → asset/case), the copy layer fills the prose, and the result lands in the deterministic SQLite warehouse (wh_<Object>) ready to load into any org. No live org needed (synthetic profile). --provider static = fully offline + deterministic (no API credits); claude-code/auto = Claude authors the identity + copy on your subscription. The atomic unit for the 100K scale-up.",
  idempotent: true,
  prerequisites: ["for --provider claude-code: the `claude` CLI on PATH (uses your Claude subscription, no API key)", "for --provider anthropic: ANTHROPIC_API_KEY in the environment"],
  affects: [".dataseed/warehouse.db (one synthetic account's records)", ".dataseed/identities/ (cached synthetic identities)", ".dataseed/dossiers/ (cached narrative spines)"],
  args: {
    pack: { type: "string", default: "salescloud", description: "Target pack id." },
    seed: { type: "string", description: "Reproducibility seed (number or string; default 42). A fresh seed authors a fresh company." },
    scenario: { type: "string", default: DEFAULT_SCENARIO, description: `Deal archetype (default ${DEFAULT_SCENARIO} — an existing-customer expansion that gets an Asset + Case). Others: at-risk-budget, rfp-gated, stalled-portfolio, churning-account.` },
    industry: { type: "string", description: "Optional industry hint for the authored company (e.g. 'Healthcare', 'Transportation'). Coerced to a valid Account.Industry." },
    provider: { type: "string", default: "auto", enum: ["auto", "claude-code", "anthropic", "static"], description: "LLM provider for BOTH the identity and the prose. auto = availability order (claude-code → anthropic → static). static = offline + deterministic, no API credits." },
    asOf: { type: "string", description: `Timeline anchor (default ${SEED_ACCOUNT_DEFAULT_ASOF} — fixed so re-runs are cache no-ops).` },
    warehouse: { type: "string", description: `Warehouse DB path (default ${DEFAULT_WAREHOUSE_PATH}).` },
    reseed: { type: "boolean", default: false, description: "Rebuild even if a matching account is already in the warehouse (and re-author the identity if --provider differs)." },
  },

  check(args, ctx) {
    const pack = ctx.packs.get(args.pack);
    const { plan } = buildPlanFor(args, pack);
    const { cacheKey } = corpusKey(plan);
    const store = new WarehouseStore(args.warehouse ?? DEFAULT_WAREHOUSE_PATH);
    try {
      const hit = store.findByCacheKey(cacheKey);
      return { alreadyDone: !!hit && !args.reseed, cacheKey, ...(hit ? { dsId: hit.dsId, totalRecords: hit.totalRecords } : {}) };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const pack = ctx.packs.get(args.pack);
    const { plan, profile } = buildPlanFor(args, pack);
    const { dsId, paramsHash, cacheKey } = corpusKey(plan);
    const whPath = args.warehouse ?? DEFAULT_WAREHOUSE_PATH;
    const provider = args.provider as "auto" | "claude-code" | "anthropic" | "static";
    const llm = provider !== "static";

    const store = new WarehouseStore(whPath);
    try {
      const existing = store.findByCacheKey(cacheKey);
      if (existing && !args.reseed) {
        ctx.log(`already seeded: ${existing.dsId} (${existing.totalRecords} records) — pass --reseed to rebuild`);
        return;
      }

      // 1) Author the synthetic IDENTITY (cached by (seed, index)) and resolve it for the generator.
      ctx.log(`authoring synthetic identity (provider=${provider}, scenario=${plan.units[0]?.scenario}, seed=${plan.seed})…`);
      const { identities, report: idReport } = await authorIdentities(plan, buildIdentityProviders(), {
        requestedProvider: provider,
        cache: fileIdentityCache(".dataseed/identities"),
        asOf: plan.asOf,
        ...(args.industry ? { industryHint: args.industry } : {}),
        log: (m) => ctx.log(m),
      });
      const id0 = identities.get(plan.units[0]?.index ?? 0);
      ctx.log(`identity: ${id0?.name ?? "?"} — ${id0?.sector ?? "?"} (${id0?.sfIndustry ?? "?"}, ~${id0?.employees ?? "?"} emp) via ${idReport.provider}${idReport.cached ? " (cached)" : ""}`);

      // 2) Fan out the full object graph FROM that identity (sync — the identity rides on the GenerateContext).
      const bundle = generateBundleWithIdentities(plan, profile, pack, identities);

      // 3) Author the narrative spine (LLM tiers) + fill the prose bodies, so the account reads as one story.
      if (llm) {
        const sr = await authorDossiers(bundle, buildSpineProviders(), {
          requestedProvider: provider,
          cache: fileDossierCache(".dataseed/dossiers"),
          asOf: bundle.plan.asOf,
          log: (m) => ctx.log(m),
        });
        ctx.log(`spine: authored ${sr.authored} deal(s) via ${sr.provider}${sr.cached ? `, ${sr.cached} cached` : ""}`);
      }
      attachSpineContext(bundle);
      if (bundle.copyRequests.length) {
        const report = await fillCopy(bundle.copyRequests, buildProviders(), {
          requestedProvider: provider,
          asOf: bundle.plan.asOf,
          gate: llm, // the realism gate runs only for LLM tiers
          log: (m) => ctx.log(m),
        });
        const { applied } = applyCopy(bundle, report.results);
        ctx.log(`copy: filled ${report.results.length} body(ies) via ${report.provider}${report.fallbacks ? ` (+${report.fallbacks} static)` : ""}, applied to ${applied} record(s)`);
      }

      // 4) Write the account's records into the warehouse (the loader-injectable corpus format).
      const manifest = { dsId, pack: args.pack, seed: plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey, asOf: plan.asOf };
      const builtAt = new Date().toISOString();
      const counts = store.writeBundle(manifest, bundle.records, builtAt);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      ctx.log(`seeded ${dsId} → ${whPath}`);
      ctx.log(`${total} records: ${Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      ctx.log(`inspect:  node bin/run-op.js run warehouse --ds ${dsId} --counts`);
    } finally {
      store.close();
    }
  },

  verify(args, ctx) {
    const pack = ctx.packs.get(args.pack);
    const { plan } = buildPlanFor(args, pack);
    const { cacheKey } = corpusKey(plan);
    const validIndustries = new Set<string>(pack.picklists["Account.Industry"] ?? []);
    const store = new WarehouseStore(args.warehouse ?? DEFAULT_WAREHOUSE_PATH);
    try {
      const hit = store.findByCacheKey(cacheKey);
      if (!hit) return { success: false, reason: "no ready corpus for this cache key" };
      const accounts = store.readObject(hit.dsId, "Account");
      const allBodies = (object: string, field: string) => {
        const recs = store.readObject(hit.dsId, object);
        return { total: recs.length, withBody: recs.filter((r) => typeof r[field] === "string" && (r[field] as string).trim().length > 0).length };
      };
      const email = allBodies("EmailMessage", "TextBody");
      const task = allBodies("Task", "Description");
      const transcript = allBodies("ContentVersion", "VersionData");
      const industryOk = validIndustries.size === 0 || accounts.every((a) => typeof a.Industry === "string" && validIndustries.has(a.Industry as string));
      const bodiesOk = email.withBody === email.total && task.withBody === task.total && transcript.withBody === transcript.total;
      const ok = hit.totalRecords > 0 && accounts.length >= 1 && industryOk && bodiesOk;
      return {
        success: ok,
        dsId: hit.dsId,
        accounts: accounts.length,
        totalRecords: hit.totalRecords,
        emails: email.total,
        emailsWithBody: email.withBody,
        tasks: task.total,
        transcripts: transcript.total,
        industryOk,
        ...(ok ? {} : { reason: !industryOk ? "an Account.Industry is not a valid picklist value" : !bodiesOk ? "some email/task/transcript body is still empty" : "no records" }),
      };
    } finally {
      store.close();
    }
  },
};

export default seedAccountOp;
