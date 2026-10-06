// packages/engine/src/identity/orchestrate.ts
//
// The identity orchestrator (the single-account protocol's pre-pass): author a synthetic AccountIdentity
// for each foreground unit with the resolved provider, CACHED by (seed, index), and return a
// Map<index, AccountIdentity> the SYNC generator consumes (pack.generate reads ctx.identities). Mirrors
// authorDossiers: build requests from the plan, a cache pass (free hits), a model pass (misses), then a
// STATIC fill so every unit always has an identity (a budget/limit/parse miss never leaves a hole). Only
// LLM-authored identities are cached — a static fallback isn't pinned into the cache.

import type { AccountIdentity, BundlePlan, IdentityProvider, IdentityRequest } from "@dataseed/core";
import { deriveSeed } from "@dataseed/core";
import type { IdentityCache } from "./cache.js";
import { ClaudeCodeIdentityProvider } from "./claude-code-provider.js";
import { AnthropicIdentityProvider } from "./anthropic-provider.js";
import { StaticIdentityProvider } from "./static-provider.js";

/** The standard identity provider set (preferred → fallback): claude-code, anthropic, then static. */
export function buildIdentityProviders(): IdentityProvider[] {
  return [new ClaudeCodeIdentityProvider(), new AnthropicIdentityProvider(), new StaticIdentityProvider()];
}

export interface AuthorIdentitiesOptions {
  requestedProvider?: "auto" | "claude-code" | "anthropic" | "static";
  /** The org's probed preference, used when requested is "auto". */
  profilePreferred?: string;
  budgetUsd?: number;
  limit?: number;
  /** Cache authored identities by (seed, index); a hit reuses instead of re-authoring (determinism + free). */
  cache?: IdentityCache;
  asOf: string;
  /** Optional target-industry hint applied to every unit's identity prompt. */
  industryHint?: string;
  log?: (m: string) => void;
}

export interface AuthorIdentitiesReport {
  /** Provider that led the authoring. */
  provider: string;
  /** Foreground units seen. */
  units: number;
  /** Units authored by the model this run. */
  authored: number;
  /** Units served from the cache (no spend). */
  cached: number;
  /** Units filled by the deterministic static floor (budget/limit/error/deterministic primary). */
  staticFilled: number;
  estCostUsd: number;
  budgetExhausted: boolean;
}

async function resolvePrimary(providers: IdentityProvider[], opts: AuthorIdentitiesOptions): Promise<IdentityProvider> {
  const byId = (id: string) => providers.find((p) => p.id === id);
  const requested = opts.requestedProvider ?? "auto";
  if (requested !== "auto") {
    const p = byId(requested);
    if (!p) throw new Error(`unknown identity provider "${requested}"`);
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

/** Build one identity request per foreground unit (cache key + the prompt hints). */
function requestsForPlan(plan: BundlePlan, industryHint?: string): IdentityRequest[] {
  return plan.units.map((u) => ({
    unitKey: `${plan.seed}:${u.index}`,
    index: u.index,
    hints: {
      ...(industryHint ? { industry: industryHint } : {}),
      ...(u.traits.dealSizeBand ? { dealSizeBand: u.traits.dealSizeBand } : {}),
      ...(u.traits.region ? { region: u.traits.region } : {}),
      scenario: u.scenario,
      nonce: deriveSeed(plan.seed, "identity", u.index).toString(36),
    },
  }));
}

/** Author a synthetic identity for every foreground unit; returns the resolved map + a report. */
export async function authorIdentities(
  plan: BundlePlan,
  providers: IdentityProvider[],
  opts: AuthorIdentitiesOptions,
): Promise<{ identities: Map<number, AccountIdentity>; report: AuthorIdentitiesReport }> {
  const log = opts.log ?? (() => {});
  const identities = new Map<number, AccountIdentity>();
  const requests = requestsForPlan(plan, opts.industryHint);
  const staticProvider = providers.find((p) => p.id === "static") ?? new StaticIdentityProvider();

  const primary = await resolvePrimary(providers, opts);
  const usePrimary = !primary.deterministic && (await primary.available());

  // A deterministic (or unavailable) primary means EVERY unit is static-authored this run — the cache is
  // SKIPPED entirely (mirrors spine/orchestrate.ts's authorDossiers) so an explicit `--provider static`
  // request, or a genuinely unavailable LLM, can never silently return a STALE LLM-authored identity left
  // over from a prior run with a different provider. Only an active LLM primary ever consults the cache.
  if (!usePrimary) {
    if ((opts.requestedProvider ?? "auto") !== "static") log(`identity provider: ${primary.id} unavailable — synthesizing ${requests.length} via static floor`);
    const sout = await staticProvider.author(requests, { asOf: opts.asOf, log });
    for (const it of sout.identities) identities.set(it.index, it.identity);
    return {
      identities,
      report: { provider: "static", units: requests.length, authored: 0, cached: 0, staticFilled: requests.length, estCostUsd: 0, budgetExhausted: false },
    };
  }

  // Cache pass: a hit resolves immediately (free); a miss is queued for the model.
  let cached = 0;
  const toAuthor: IdentityRequest[] = [];
  for (const req of requests) {
    const hit = opts.cache?.get(req.unitKey);
    if (hit) {
      identities.set(req.index, hit);
      cached++;
    } else {
      toAuthor.push(req);
    }
  }

  let authored = 0;
  let estCostUsd = 0;
  let budgetExhausted = false;

  if (toAuthor.length) {
    log(`identity provider: ${primary.id} (primary) — ${cached} cached, ${toAuthor.length} to author${opts.budgetUsd != null ? `, budget $${opts.budgetUsd}` : ""}`);
    const out = await primary.author(toAuthor, { asOf: opts.asOf, budgetUsd: opts.budgetUsd, limit: opts.limit, log });
    estCostUsd = out.estCostUsd;
    budgetExhausted = out.budgetExhausted;
    const byKey = new Map(out.identities.map((i) => [i.unitKey, i.identity]));
    const stillMissing: IdentityRequest[] = [];
    for (const req of toAuthor) {
      const got = byKey.get(req.unitKey);
      if (got) {
        identities.set(req.index, got);
        opts.cache?.set(req.unitKey, got); // cache ONLY LLM-authored identities (a static fill stays uncached)
        authored++;
      } else {
        stillMissing.push(req);
      }
    }

    // Static-fill anything not authored (a miss or a budget cap).
    if (stillMissing.length) {
      const sout = await staticProvider.author(stillMissing, { asOf: opts.asOf, log });
      for (const it of sout.identities) identities.set(it.index, it.identity);
    }
  }

  const staticFilled = requests.length - cached - authored;
  return { identities, report: { provider: primary.id, units: requests.length, authored, cached, staticFilled, estCostUsd, budgetExhausted } };
}
