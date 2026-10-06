// packages/engine/src/spine/orchestrate.ts
//
// The spine orchestrator (Phase 4B): author the NARRATIVE of each foreground deal's dossier with the
// resolved provider, CACHED by (seed, account), then patch the result back onto the bundle — the
// Opportunity's `_meta.dossier`, every copy request's `beat`/`beatIntent`, and each stream record's
// `_meta.sentiment`. The deterministic skeleton (which beats exist, when, who) is untouched; only the
// story is (re)authored. A deal the provider doesn't author (budget/limit/error, or a deterministic
// primary) keeps its static skeleton — so this never makes a deal worse, only richer. Mirrors fillCopy.

import type { GenericRecord, NarrativeBundle, SpineProvider, SpineRequest, DealDossier } from "@dataseed/core";
import { mergeDossier } from "@dataseed/core";
import type { DossierCache } from "./cache.js";
import { ClaudeCodeSpineProvider } from "./claude-code-provider.js";
import { StaticSpineProvider } from "./static-provider.js";

/** The standard spine provider set (preferred → fallback): claude-code (subscription), then static. */
export function buildSpineProviders(): SpineProvider[] {
  return [new ClaudeCodeSpineProvider(), new StaticSpineProvider()];
}

export interface AuthorDossiersOptions {
  requestedProvider?: "auto" | "claude-code" | "anthropic" | "static";
  /** The org's probed preference, used when requested is "auto". */
  profilePreferred?: string;
  budgetUsd?: number;
  /** Cap how many deals to author via the model (rest keep their skeleton) — a smoke-test lever. */
  limit?: number;
  /** Cache authored drafts by (seed, account); a hit reuses instead of re-authoring (determinism + free). */
  cache?: DossierCache;
  asOf: string;
  log?: (m: string) => void;
}

export interface AuthorDossiersReport {
  /** Provider that led the authoring. */
  provider: string;
  /** Foreground deals seen. */
  deals: number;
  /** Deals (re)authored by the model this run. */
  authored: number;
  /** Deals served from the cache (no spend). */
  cached: number;
  /** Deals that kept their static skeleton (budget/limit/error/deterministic primary). */
  staticKept: number;
  estCostUsd: number;
  budgetExhausted: boolean;
}

async function resolvePrimary(providers: SpineProvider[], opts: AuthorDossiersOptions): Promise<SpineProvider> {
  const byId = (id: string) => providers.find((p) => p.id === id);
  const requested = opts.requestedProvider ?? "auto";
  if (requested !== "auto") {
    const p = byId(requested);
    if (!p) throw new Error(`unknown spine provider "${requested}"`);
    return p;
  }
  const order: string[] = [];
  if (opts.profilePreferred) order.push(opts.profilePreferred);
  for (const id of ["claude-code", "anthropic", "static"]) if (!order.includes(id)) order.push(id);
  for (const id of order) {
    const p = byId(id);
    if (p && (await p.available())) return p;
  }
  return byId("static")!;
}

/** Foreground deals = Opportunities carrying an authored-skeleton dossier on `_meta`. */
function foregroundDeals(bundle: NarrativeBundle): Array<{ opp: GenericRecord; dossier: DealDossier; dealKey: string }> {
  const seed = bundle.plan.seed;
  const out: Array<{ opp: GenericRecord; dossier: DealDossier; dealKey: string }> = [];
  for (const o of bundle.records.Opportunity ?? []) {
    const dossier = (o._meta as { dossier?: DealDossier } | undefined)?.dossier;
    if (dossier && typeof o._ref === "string") out.push({ opp: o, dossier, dealKey: `${seed}:${o._ref}` });
  }
  return out;
}

/** Author + patch every foreground dossier in the bundle (in place). */
export async function authorDossiers(bundle: NarrativeBundle, providers: SpineProvider[], opts: AuthorDossiersOptions): Promise<AuthorDossiersReport> {
  const log = opts.log ?? (() => {});
  const deals = foregroundDeals(bundle);
  const primary = await resolvePrimary(providers, opts);

  // Index the bundle ONCE so patching each deal is cheap.
  const reqById = new Map(bundle.copyRequests.map((c) => [c.id, c]));
  const recByRef = new Map<string, GenericRecord>();
  for (const recs of Object.values(bundle.records)) for (const r of recs) if (typeof r._ref === "string") recByRef.set(r._ref, r);

  const patch = (opp: GenericRecord, merged: DealDossier) => {
    (opp._meta as Record<string, unknown>).dossier = merged;
    for (const beat of merged.beats) {
      const req = reqById.get(beat.ref);
      if (req) {
        req.beat = beat;
        req.beatIntent = `${beat.summary}${beat.conveys ? ` ${beat.conveys}` : ""}`;
      }
      const rec = recByRef.get(beat.ref);
      if (rec) rec._meta = { ...(rec._meta as Record<string, unknown> | undefined), sentiment: beat.sentiment };
    }
  };

  // Deterministic primary (static) → nothing to author; every deal keeps its skeleton.
  if (primary.deterministic) {
    log(`spine provider: ${primary.id} (deterministic) — keeping static dossiers`);
    return { provider: primary.id, deals: deals.length, authored: 0, cached: 0, staticKept: deals.length, estCostUsd: 0, budgetExhausted: false };
  }
  if (!(await primary.available())) {
    log(`spine provider: ${primary.id} unavailable — keeping static dossiers`);
    return { provider: primary.id, deals: deals.length, authored: 0, cached: 0, staticKept: deals.length, estCostUsd: 0, budgetExhausted: false };
  }

  // Cache pass: a hit patches immediately (free); a miss is queued for the model.
  let cachedCount = 0;
  const toAuthor: Array<{ deal: (typeof deals)[number]; req: SpineRequest }> = [];
  for (const deal of deals) {
    const hit = opts.cache?.get(deal.dealKey);
    if (hit) {
      patch(deal.opp, mergeDossier(deal.dossier, hit, "llm"));
      cachedCount++;
    } else {
      toAuthor.push({ deal, req: { dealKey: deal.dealKey, dossier: deal.dossier } });
    }
  }

  log(`spine provider: ${primary.id} (primary) — ${cachedCount} cached, ${toAuthor.length} to author${opts.budgetUsd != null ? `, budget $${opts.budgetUsd}` : ""}`);

  let authored = 0;
  let estCostUsd = 0;
  let budgetExhausted = false;
  if (toAuthor.length) {
    const out = await primary.author(
      toAuthor.map((t) => t.req),
      { asOf: opts.asOf, budgetUsd: opts.budgetUsd, limit: opts.limit, log },
    );
    estCostUsd = out.estCostUsd;
    budgetExhausted = out.budgetExhausted;
    const draftByKey = new Map(out.drafts.map((d) => [d.dealKey, d.draft]));
    for (const { deal } of toAuthor) {
      const draft = draftByKey.get(deal.dealKey);
      if (draft) {
        opts.cache?.set(deal.dealKey, draft);
        patch(deal.opp, mergeDossier(deal.dossier, draft, "llm"));
        authored++;
      }
      // else: keep the skeleton (already on _meta) — a deal the model skipped stays static.
    }
  }

  const staticKept = deals.length - cachedCount - authored;
  return { provider: primary.id, deals: deals.length, authored, cached: cachedCount, staticKept, estCostUsd, budgetExhausted };
}
