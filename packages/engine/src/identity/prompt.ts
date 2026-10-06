// packages/engine/src/identity/prompt.ts
//
// The identity-authoring prompt (the single-account protocol's NEW layer). The LLM invents a FICTIONAL
// B2B company that would appear in a CRM as a PROSPECT — one that could BUY a horizontal data/analytics/
// integration platform for its INTERNAL teams. It must NOT itself be a data/BI/analytics vendor (the
// self-product rule, enforced again deterministically by guard.ts). Returns JSON matching AccountIdentity.
// The system prompt is frozen (cache-friendly + what-we-validate-is-what-ships); the user prompt seeds
// the few knobs (industry hint, company scale from the deal-size band, region, a uniqueness nonce).

import type { IdentityRequest } from "@dataseed/core";

export const IDENTITY_SYSTEM = `You invent a realistic but FICTIONAL B2B company that would appear in a CRM as a PROSPECT — a company that could BUY a horizontal data, analytics & integration platform for its INTERNAL teams (RevOps, data, IT, finance). Return ONLY JSON.

HARD RULES:
- FICTIONAL: do NOT use a real company. Invent a plausible name and a matching web domain.
- The company is a BUYER, never a vendor of what WE sell: it must NOT be a business-intelligence, analytics, data-warehouse, data-platform, integration / iPaaS, ETL, observability, or dashboarding vendor. (Selling such a company our platform would be selling it its own product.) Pick a real-economy or vertical-software industry instead — logistics, healthcare delivery, manufacturing, consumer goods, insurance, energy, education, hospitality, construction, agriculture, and so on.
- Firmographics must be internally consistent: employees, revenue, and sector must line up (a 4,000-person regional carrier is ~$800M revenue, not $40M).
- painPhrase is an INTERNAL back-office reporting/operations pain a horizontal data platform could address (e.g. "reconciling operations and finance reporting across three acquired regional carriers") — NEVER the company's own customer-facing product.
- products are a couple of THEIR real offerings (what they sell to THEIR customers), so the generated deal copy can reference their actual world.

WHAT TO AUTHOR (good = specific, grounded, real):
- name; domain (a bare host like "meridianfreight.com"); sfIndustry (a realistic industry label); sector (a short descriptive sector, e.g. "Regional LTL Trucking").
- employees (integer); revenueUsd (integer USD); hq ("City, Country"); description (1-2 sentences on what they do).
- does (one phrase for what they do); products (1-3 of their offerings); buyingDept (the internal team that would own this evaluation); painPhrase (the internal pain).

Make it a company a salesperson would recognize as a real account — specific industry, specific scale, specific pain.`;

/** Company-scale guidance derived from the unit's deal-size band (so the company size fits the deal size). */
function bandSizeHint(band?: string): string {
  switch (band) {
    case "LT10K":
    case "10K_50K":
      return "a small business or lower-mid-market company (roughly 50-600 employees)";
    case "250K_1M":
    case "GTE1M":
      return "a large enterprise (roughly 6,000+ employees)";
    default:
      return "a mid-market company (roughly 600-6,000 employees)";
  }
}

/** Plausible HQ geography from the unit's region trait. */
function regionHint(region?: string): string {
  switch (region) {
    case "EMEA":
      return "Europe, the Middle East, or Africa";
    case "APAC":
      return "the Asia-Pacific region";
    default:
      return "North America";
  }
}

/** Serialize one unit's hints for the user turn. */
export function identityUserPrompt(req: IdentityRequest): string {
  const h = req.hints;
  return [
    h.industry ? `TARGET INDUSTRY: ${h.industry}` : "INDUSTRY: choose any real-economy or vertical-software industry (NOT a data/BI/analytics/integration vendor).",
    `COMPANY SCALE: ${bandSizeHint(h.dealSizeBand)}`,
    `REGION (plausible HQ): ${regionHint(h.region)}`,
    `UNIQUENESS TOKEN: ${h.nonce} — make the company name and domain distinctive; do not reuse a common or famous name.`,
    "",
    `Return JSON: { "name": string, "sfIndustry": string, "domain": string, "sector": string, "employees": number, "revenueUsd": number, "hq": string, "description": string, "does": string, "products": string[], "buyingDept": string, "painPhrase": string }`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The full single-string prompt for the CLI provider (system + user + a strict JSON-only instruction). */
export function buildIdentityCliPrompt(req: IdentityRequest): string {
  return `${IDENTITY_SYSTEM}\n\n---\n\n${identityUserPrompt(req)}\n\nOutput ONLY the JSON object. No preamble, no commentary, no code fences.`;
}
