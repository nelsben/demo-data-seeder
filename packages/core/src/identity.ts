// packages/core/src/identity.ts
//
// The synthetic-account-identity contract — the one NEW generation layer for the single-account
// protocol (seed-account). Today a foreground account's identity comes from a fixed pool of ~57 real
// public companies (the pack's anchors); that can't scale to 100K distinct companies. This lets an LLM
// author a FULLY SYNTHETIC, fictional-but-realistic company (name, industry, firmographics, what it
// does, its internal pain) per account, which then feeds the existing per-account fan-out unchanged.
//
// An AccountIdentity is a SUPERSET of the pack's Anchor + AnchorGrounding, so one object satisfies BOTH
// the Account record fields (name/industry/domain/firmographics) AND the downstream dossier/copy
// grounding consumer. Per the determinism contract (mirroring the dossier spine, [[spine.ts]]), the
// authored identity is CACHED by (seed, account index) — a re-run reproduces it byte-for-byte. Core
// declares the SHAPES only; the engine owns the provider implementations (CLI / API / static), and the
// PACK owns the mapping onto its concrete Anchor/grounding + picklist coercion.

import { z } from "zod";

/**
 * A synthetic company identity. NO `competitors` field — competitors are ALWAYS the seller's own
 * competitive set (re-applied by the pack), so the model can't author a self-product rival. The pack
 * coerces `sfIndustry` to a valid Account.Industry picklist value at the seam (core stays picklist-agnostic).
 */
export const AccountIdentity = z
  .object({
    // — Account record fields —
    /** The fictional company name (e.g. "Meridian Freight Systems"). */
    name: z.string().min(2),
    /** A realistic industry; the pack coerces this to a valid Account.Industry value. */
    sfIndustry: z.string().min(2),
    /** A bare host for plausible contact/AE emails (e.g. "meridianfreight.com"). */
    domain: z.string().min(3),
    /** Descriptive sector for previews/copy intent (e.g. "Regional LTL Trucking"). */
    sector: z.string().min(2),
    /** Headcount — internally consistent with revenue + sector. */
    employees: z.number().int().positive(),
    /** Annual revenue (USD). */
    revenueUsd: z.number().nonnegative(),
    /** Headquarters "City, Country" (drives Billing fields). */
    hq: z.string().min(2),
    /** 1–2 sentences on what the company does. */
    description: z.string().min(20),
    // — grounding consumer fields (satisfy the dossier + every CopyRequest.facts.grounding) —
    /** One phrase for what the company does (public-knowledge style). */
    does: z.string().min(3),
    /** A real product/offering or two of THEIRS (so copy can reference their world). */
    products: z.array(z.string().min(1)).min(1),
    /** A plausible internal team that would own a vendor evaluation. */
    buyingDept: z.string().min(2),
    /** A concrete INTERNAL operational pain the seller's platform could speak to (never their own product). */
    painPhrase: z.string().min(3),
  })
  .strict();
export type AccountIdentity = z.infer<typeof AccountIdentity>;

/** One unit handed to an identity provider: its cache key, the unit index it maps to, and prompt hints. */
export interface IdentityRequest {
  /** Stable cache key ((seed, index)-derived) — a hit reproduces the identity. */
  unitKey: string;
  /** The plan unit's index — keys the resolved identity map the generator consumes. */
  index: number;
  /** Prompt seeds: an optional target industry, the unit's deal-size band + region, scenario, and a
   *  uniqueness nonce derived from (seed, index) so 100K companies don't collide. */
  hints: {
    industry?: string;
    dealSizeBand?: string;
    region?: string;
    scenario?: string;
    nonce: string;
  };
}

/** What an identity provider may use while authoring (budget cap + as-of anchor + a smoke-test limit + log). */
export interface IdentityAuthorContext {
  asOf: string;
  /** Hard USD ceiling; a provider stops once running cost would exceed it (remainder → static). */
  budgetUsd?: number;
  /** Cap how many identities to author via the model (the rest fall back). */
  limit?: number;
  log?: (msg: string) => void;
}

/** A provider's output: the identities it authored (≤ requests) + the spend it incurred. */
export interface IdentityAuthorOutput {
  identities: Array<{ unitKey: string; index: number; identity: AccountIdentity }>;
  estCostUsd: number;
  budgetExhausted: boolean;
}

/**
 * A pluggable identity provider — authors a synthetic company. May return FEWER identities than requests
 * (budget/limit/error): the orchestrator falls back to the static tier for the remainder, so a provider
 * never has to be exhaustive or fatal. Mirrors SpineProvider / CopyProvider.
 */
export interface IdentityProvider {
  /** "static" | "claude-code" | "anthropic". */
  id: string;
  /** True if author() is pure (the static tier — synthesizes deterministically from the nonce, no LLM). */
  deterministic?: boolean;
  available(): Promise<boolean> | boolean;
  author(requests: IdentityRequest[], ctx: IdentityAuthorContext): Promise<IdentityAuthorOutput>;
}
