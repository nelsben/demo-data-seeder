// apps/server/src/app.ts
//
// The dataseed HTTP API — a thin Fastify layer over the engine (in-process, no
// CLI shelling for the pure paths). Backs the web app's Connect → Scope → Preview
// flow. Routes:
//   GET  /api/health
//   GET  /api/packs            → registered target packs (+ scenarios/variability)
//   GET  /api/orgs             → authed `sf` org aliases
//   POST /api/profile          → introspect a live org → CapabilityProfile (+ pack requirements)
//   GET  /api/profile/:org     → the persisted profile
//   POST /api/plan             → plan + generate a bundle (dry-run; no org writes)
//
// The composition root (registry.ts) injects the packs; the engine stays
// pack-agnostic. Load (M4) adds POST /api/load behind the same shape.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  CapabilityProfile,
  ScopeParams,
  NarrativeBundle,
  type TargetPack,
} from "@dataseed/core";
import {
  SfCliClient,
  assembleProfile,
  profileObjects,
  profilePath,
  PROFILE_DIR,
  buildBundle,
  buildProviders,
  fillCopy,
  applyCopy,
  teardownBundle,
  JsforceLoadTarget,
  probeSynthesis,
  openRegistry,
  latestDatasetFor,
  savePlanned,
  saveFilled,
  salesforceSink,
  disperseDataset,
} from "@dataseed/engine";
import type { LoadTarget, SynthesisSummary, Dataset } from "@dataseed/engine";
import type { CopyProviderId } from "@dataseed/core";
import { buildRegistry } from "./registry.js";
import { listOrgs } from "./orgs.js";
import { preflight } from "./preflight.js";

/** A compact preview so the UI needn't ship the whole bundle. */
function buildPreview(bundle: NarrativeBundle) {
  const opps = bundle.records.Opportunity ?? [];
  const olis = bundle.records.OpportunityLineItem ?? [];
  const sampleDeals = opps.slice(0, 5).map((o) => {
    const lines = olis
      .filter((li) => (li._refs as Record<string, string> | undefined)?.OpportunityId === o._ref)
      .map((li) => ({
        product: String((li._meta as Record<string, unknown> | undefined)?.product ?? "Product"),
        quantity: Number(li.Quantity ?? 1),
        unitPrice: Number(li.UnitPrice ?? 0),
      }));
    const sum = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    return {
      name: o.Name,
      amount: o.Amount,
      stage: o.StageName,
      closeDate: o.CloseDate,
      scenario: (o._meta as Record<string, unknown> | undefined)?.scenario,
      ...(lines.length ? { lineItems: lines, reconciled: sum === o.Amount } : {}),
    };
  });
  return {
    copyRequests: bundle.copyRequests.length,
    sampleDeals,
    sampleCopy: bundle.copyRequests[0]?.beatIntent ?? null,
  };
}

/** A few filled Task notes for the UI (the rep's internal activity logs). */
function taskSamples(bundle: NarrativeBundle, n = 2) {
  return (bundle.records.Task ?? [])
    .filter((t) => typeof t.Description === "string" && (t.Description as string).trim().length > 0)
    .slice(0, n)
    .map((t) => ({ subject: String(t.Subject ?? ""), body: String(t.Description ?? "") }));
}

function packSummary(p: TargetPack) {
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    scenarios: p.scenarios,
    objects: p.objects,
    variabilityDimensions: Object.keys(p.variability),
    recordsPerUnitEstimate: p.recordsPerUnitEstimate,
  };
}

/** Resolve the current dataset for (org, pack) from the registry (the one /api/plan registered). */
function getDataset(org: string, pack: string): Dataset | null {
  const store = openRegistry();
  try {
    return latestDatasetFor(store, org, pack);
  } finally {
    store.close();
  }
}

/** A few filled email samples for the UI (subject + body + direction). */
function emailSamples(bundle: NarrativeBundle, n = 3) {
  return (bundle.records.EmailMessage ?? [])
    .filter((e) => typeof e.TextBody === "string" && (e.TextBody as string).trim().length > 0)
    .slice(0, n)
    .map((e) => ({ subject: String(e.Subject ?? ""), body: String(e.TextBody ?? ""), incoming: e.Incoming === true }));
}

const ProfileBody = z.object({ org: z.string().min(1), pack: z.string().optional() });
const PlanBody = z.object({
  org: z.string().min(1),
  pack: z.string().min(1),
  volume: z.number().int().positive(),
  scenarioMix: z.record(z.string(), z.number()),
  dc: z.enum(["auto", "on", "off"]).optional(),
  seed: z.union([z.number().int(), z.string().min(1)]).optional(),
  asOf: z.string().optional(),
  full: z.boolean().optional(),
});
const FillBody = z.object({
  org: z.string().min(1),
  pack: z.string().min(1).default("salescloud"),
  provider: z.enum(["auto", "anthropic", "claude-code", "static"]).default("auto"),
  budgetUsd: z.number().positive().optional(),
  limit: z.number().int().positive().optional(),
  gate: z.boolean().optional(),
  gateIters: z.number().int().positive().optional(),
});
const LoadBody = z.object({ org: z.string().min(1), pack: z.string().min(1).default("salescloud"), force: z.boolean().default(false) });
const TeardownBody = z.object({ org: z.string().min(1), pack: z.string().min(1).default("salescloud"), yes: z.boolean().default(false) });
const SynthesisBody = z.object({ org: z.string().min(1), pack: z.string().min(1).default("salescloud") });

export interface BuildAppOptions {
  /** Override the live introspection (tests inject a stub so routes don't hit an org). */
  introspect?: (org: string, pack?: TargetPack) => Promise<CapabilityProfile>;
  /** Override the org write surface for load/teardown (tests inject a mock so routes don't hit an org). */
  createLoadTarget?: (org: string) => Promise<LoadTarget>;
  /** Override the synthesis read-back (tests inject a stub so the route doesn't hit an org). */
  probeSynthesis?: (org: string, pack: TargetPack) => Promise<SynthesisSummary>;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const registry = buildRegistry();

  const introspect =
    opts.introspect ??
    ((org: string, pack?: TargetPack) =>
      assembleProfile(new SfCliClient(org), { objects: profileObjects(pack?.objects), capturedAt: new Date().toISOString() }));

  const createLoadTarget = opts.createLoadTarget ?? ((org: string) => JsforceLoadTarget.create(org));

  const probeSynth =
    opts.probeSynthesis ?? ((org: string, pack: TargetPack) => probeSynthesis(new SfCliClient(org), pack, org));

  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, service: "dataseed", packs: registry.list().length }));

  // First-run environment check (sf CLI / claude CLI / ANTHROPIC_API_KEY) — the Connect screen
  // reads this so a missing prerequisite surfaces before the SE is mid-demo.
  app.get("/api/preflight", async () => preflight());

  app.get("/api/packs", async () => ({ packs: registry.list().map(packSummary) }));

  app.get("/api/orgs", async () => ({ orgs: await listOrgs() }));

  // Live introspection → persist + return profile (+ pack requirements).
  app.post("/api/profile", async (req, reply) => {
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack: packId } = parsed.data;
    let pack: TargetPack | undefined;
    if (packId) {
      if (!registry.has(packId)) return reply.code(404).send({ error: `unknown pack: ${packId}` });
      pack = registry.get(packId);
    }
    const profile = await introspect(org, pack);
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(profilePath(org), JSON.stringify(profile, null, 2) + "\n");
    const requirements = pack ? pack.checkRequirements(profile) : [];
    return { profile, requirements };
  });

  app.get<{ Params: { org: string } }>("/api/profile/:org", async (req, reply) => {
    const p = profilePath(req.params.org);
    if (!existsSync(p)) return reply.code(404).send({ error: `no profile for ${req.params.org} — POST /api/profile first` });
    return { profile: CapabilityProfile.parse(JSON.parse(readFileSync(p, "utf8"))) };
  });

  // Plan + generate (dry-run). No org writes.
  app.post("/api/plan", async (req, reply) => {
    const parsed = PlanBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack: packId, volume, scenarioMix, dc, seed, asOf, full } = parsed.data;
    if (!registry.has(packId)) return reply.code(404).send({ error: `unknown pack: ${packId}` });
    const pPath = profilePath(org);
    if (!existsSync(pPath)) return reply.code(404).send({ error: `no profile for ${org} — POST /api/profile first` });

    const profile = CapabilityProfile.parse(JSON.parse(readFileSync(pPath, "utf8")));
    const pack = registry.get(packId);
    const resolvedAsOf = asOf ?? new Date().toISOString();

    let bundle: NarrativeBundle;
    let scope: ScopeParams;
    try {
      scope = ScopeParams.parse({
        org,
        pack: packId,
        volume,
        scenarioMix,
        dc: dc ?? "auto",
        ...(seed !== undefined ? { seed } : {}),
        asOf: resolvedAsOf,
      });
      bundle = buildBundle(scope, profile, pack, resolvedAsOf);
    } catch (e) {
      // ZodError (mix≠100) or planBundle throws (unknown scenario) → client error.
      return reply.code(400).send({ error: (e as Error).message });
    }

    const store = openRegistry();
    try {
      savePlanned(store, { pack: packId, params: scope, bundle, now: new Date().toISOString() });
    } finally {
      store.close();
    }
    return full ? { bundle } : { plan: bundle.plan, preview: buildPreview(bundle) };
  });

  // Fill the bundle's deferred copy (email bodies). Local-only — no org writes.
  app.post("/api/fill-copy", async (req, reply) => {
    const parsed = FillBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack, provider, budgetUsd, limit, gate, gateIters } = parsed.data;
    const ds = getDataset(org, pack);
    if (!ds) return reply.code(404).send({ error: `no dataset for ${org}/${pack} — POST /api/plan first` });
    const bundle = ds.bundle;
    if (bundle.copyRequests.length === 0) return { provider: "static", filled: 0, emails: { total: 0, withBody: 0 }, samples: [], note: "no copy requests" };

    // The org's probed copy preference (if profiled) seeds the "auto" choice.
    let profilePreferred: CopyProviderId | undefined;
    const pp = profilePath(org);
    if (existsSync(pp)) {
      try {
        profilePreferred = JSON.parse(readFileSync(pp, "utf8")).copyProvider;
      } catch {
        /* unreadable — fall through to availability order */
      }
    }

    const report = await fillCopy(bundle.copyRequests, buildProviders(), {
      requestedProvider: provider as "auto" | CopyProviderId,
      profilePreferred,
      budgetUsd,
      limit,
      gate,
      gateIters,
      asOf: bundle.plan.asOf,
    });
    const { applied, unmatched } = applyCopy(bundle, report.results);
    const store = openRegistry();
    try {
      saveFilled(store, ds, { bundle, now: new Date().toISOString(), provider: report.provider, costUsd: report.estCostUsd });
    } finally {
      store.close();
    }

    const emails = bundle.records.EmailMessage ?? [];
    const withBody = emails.filter((e) => typeof e.TextBody === "string" && (e.TextBody as string).trim().length > 0).length;
    const tasks = bundle.records.Task ?? [];
    const tasksWithBody = tasks.filter((t) => typeof t.Description === "string" && (t.Description as string).trim().length > 0).length;
    return {
      provider: report.provider,
      filled: report.results.length,
      filledByPrimary: report.filledByPrimary,
      fallbacks: report.fallbacks,
      estCostUsd: report.estCostUsd,
      budgetExhausted: report.budgetExhausted,
      gate: report.gate, // realism gate outcome (before→after, passes, unresolved) — undefined for static
      applied,
      unmatched: unmatched.length,
      emails: { total: emails.length, withBody },
      tasks: { total: tasks.length, withBody: tasksWithBody },
      samples: emailSamples(bundle),
      taskSamples: taskSamples(bundle),
    };
  });

  // Load the bundle into the org (real writes). Additively idempotent unless `force`.
  app.post("/api/load", async (req, reply) => {
    const parsed = LoadBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack: packId, force } = parsed.data;
    if (!registry.has(packId)) return reply.code(404).send({ error: `unknown pack: ${packId}` });
    const ds = getDataset(org, packId);
    if (!ds) return reply.code(404).send({ error: `no dataset for ${org}/${packId} — POST /api/plan first` });

    try {
      const sink = salesforceSink({ resolvePack: (id) => registry.get(id), connect: createLoadTarget });
      const store = openRegistry();
      try {
        const report = await disperseDataset(store, ds, sink, { now: new Date().toISOString(), target: org, force });
        return report.detail; // the LoadReport (records the dispersal in load-history as a side effect)
      } finally {
        store.close();
      }
    } catch (e) {
      // Org auth / connection failures surface as a gateway error (not a 500 stack).
      return reply.code(502).send({ error: `load failed: ${(e as Error).message}` });
    }
  });

  // Tear down the records this bundle seeded. DRY-RUN unless `yes` — previews the plan.
  app.post("/api/teardown", async (req, reply) => {
    const parsed = TeardownBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack, yes } = parsed.data;
    const ds = getDataset(org, pack);
    if (!ds) return reply.code(404).send({ error: `no dataset for ${org}/${pack} — POST /api/plan first` });

    try {
      const target = await createLoadTarget(org);
      const report = await teardownBundle(ds.bundle, target, { dryRun: !yes });
      return report;
    } catch (e) {
      return reply.code(502).send({ error: `teardown failed: ${(e as Error).message}` });
    }
  });

  // Verify SYNTHESIS — read back what the target pipeline derived from the seeded inputs
  // (signals, briefs, …). The cascade is async, so the UI re-polls; counts climb post-load.
  app.post("/api/synthesis", async (req, reply) => {
    const parsed = SynthesisBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.issues });
    const { org, pack: packId } = parsed.data;
    if (!registry.has(packId)) return reply.code(404).send({ error: `unknown pack: ${packId}` });
    try {
      return await probeSynth(org, registry.get(packId));
    } catch (e) {
      return reply.code(502).send({ error: `synthesis probe failed: ${(e as Error).message}` });
    }
  });

  return app;
}
