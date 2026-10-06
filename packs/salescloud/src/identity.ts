// packs/salescloud/src/identity.ts
//
// The pack-side adapter for a SYNTHETIC AccountIdentity (the single-account protocol's seam). A core
// AccountIdentity is engine-/picklist-agnostic; these helpers map it onto the concrete shapes the
// salescloud fan-out already consumes — an Anchor (name/sector/sfIndustry/domain) and an AnchorGrounding
// (does/products/buyingDept/painPhrase/competitors) — plus the richer firmographic Account fields. Two
// realism invariants are enforced HERE, by construction, so a synthetic company can never reintroduce a
// tell the realism campaign closed:
//   1. `sfIndustry` is coerced to a VALID Account.Industry picklist value (load-safe).
//   2. grounding `competitors` is ALWAYS the SELLER's BI/data rival set (never the prospect's own
//      category) — the self-product cure, identical to resolveGrounding's override.

import type { GenericRecord } from "@dataseed/core";
import type { AccountIdentity } from "@dataseed/core";
import type { Anchor } from "./anchors.js";
import type { AnchorGrounding } from "./grounding.js";
import { SELLER_COMPETITORS } from "./grounding.js";
import type { ScenarioProfile } from "./variability.js";
import { ACCOUNT_INDUSTRIES } from "./picklists.js";

const INDUSTRY_SET = new Set<string>(ACCOUNT_INDUSTRIES);

/** Keyword → canonical Account.Industry, for when the model authors a near-miss ("Fintech", "EdTech"). */
const INDUSTRY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(fintech|payment|lending|brokerage|wealth)\b/i, "Finance"],
  [/\b(bank|neobank|credit union)\b/i, "Banking"],
  [/\b(insur|insurtech|underwrit)\b/i, "Insurance"],
  [/\b(biotech|genomic|life ?science|pharma|therapeutic)\b/i, "Biotechnology"],
  [/\b(health|clinic|care|medical|hospital|telehealth)\b/i, "Healthcare"],
  [/\b(software|saas|cloud|platform|tech|developer|cyber|security|observability)\b/i, "Technology"],
  [/\b(food|beverage|restaurant|grocery|dining)\b/i, "Food & Beverage"],
  [/\b(apparel|fashion|clothing|footwear|eyewear)\b/i, "Apparel"],
  [/\b(retail|commerce|e-?commerce|storefront|marketplace)\b/i, "Retail"],
  [/\b(manufactur|industrial|factory|machining)\b/i, "Manufacturing"],
  [/\b(machinery|equipment)\b/i, "Machinery"],
  [/\b(transport|logistics|freight|delivery|trucking|mobility|rideshare)\b/i, "Transportation"],
  [/\b(shipping|maritime|cargo)\b/i, "Shipping"],
  [/\b(energy|solar|utilit|power|grid|renewable)\b/i, "Energy"],
  [/\b(education|learning|edtech|university|school)\b/i, "Education"],
  [/\b(media|streaming|publishing|advertis)\b/i, "Media"],
  [/\b(entertainment|gaming|games)\b/i, "Entertainment"],
  [/\b(telecom|communications|wireless|network)\b/i, "Telecommunications"],
  [/\b(construction|building|contractor)\b/i, "Construction"],
  [/\b(hospitality|hotel|travel|lodging|tourism)\b/i, "Hospitality"],
  [/\b(consult|advisory|professional services)\b/i, "Consulting"],
  [/\b(agricultur|farm|agri)\b/i, "Agriculture"],
  [/\b(chemical|materials)\b/i, "Chemicals"],
  [/\b(electronic|semiconductor|hardware)\b/i, "Electronics"],
  [/\b(engineering)\b/i, "Engineering"],
  [/\b(environment|sustainab|recycl)\b/i, "Environmental"],
  [/\b(government|public sector|civic|defense)\b/i, "Government"],
  [/\b(non[- ]?profit|nonprofit|charity|ngo)\b/i, "Not For Profit"],
  [/\b(recreation|fitness|sports|leisure)\b/i, "Recreation"],
];

/** Coerce any authored industry string to a VALID Account.Industry picklist value (never throws). */
export function coerceIndustry(raw: string | undefined): string {
  if (!raw) return "Other";
  const trimmed = raw.trim();
  // Exact (case-insensitive) match first.
  for (const v of ACCOUNT_INDUSTRIES) if (v.toLowerCase() === trimmed.toLowerCase()) return v;
  if (INDUSTRY_SET.has(trimmed)) return trimmed;
  for (const [re, canon] of INDUSTRY_KEYWORDS) if (re.test(trimmed)) return canon;
  return "Other";
}

/** Map a synthetic identity onto the pack's Anchor shape (the fan-out's per-unit company handle). */
export function identityToAnchor(id: AccountIdentity): Anchor {
  return {
    name: id.name,
    sector: id.sector,
    sfIndustry: coerceIndustry(id.sfIndustry),
    domain: id.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase(),
  };
}

/**
 * Map a synthetic identity onto AnchorGrounding. `competitors` is ALWAYS the seller's BI/data rival set
 * (minus the prospect's own name) — identical to resolveGrounding, so a synthetic company can't be sold
 * its own product. The identity itself never carries competitors (the model can't author one).
 */
export function identityToGrounding(id: AccountIdentity): AnchorGrounding {
  const lowerName = id.name.toLowerCase();
  return {
    does: id.does,
    products: id.products,
    buyingDept: id.buyingDept,
    painPhrase: id.painPhrase,
    competitors: SELLER_COMPETITORS.filter((c) => c.toLowerCase() !== lowerName),
  };
}

/** Split a "City, Country" HQ string into its parts (best-effort; country defaults sensibly). Exported so the
 *  generator authors the synthetic account's geo (billing + the v19 dual state/country codes + phone) in ONE
 *  place alongside the anchor path — see generate.ts `hqGeo`. (Was: this module spread a bare BillingCity/
 *  Country with no codes + no phone, which left a State/Country-Picklist org with free-text-only city/country
 *  and no dial code; geo is now owned solely by generate.ts.) */
export function splitHq(hq: string): { city: string; country: string } {
  const parts = hq.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0]!, country: parts[parts.length - 1]! };
  return { city: parts[0] ?? "", country: "United States" };
}

/**
 * The richer firmographic Account fields a synthetic identity carries (the anchor path leaves these
 * unset, so the no-identity path stays byte-identical). Standard, load-safe Account fields. An
 * existing-customer scenario (priorWin) reads as a Customer, else a Prospect. Geo (billing/phone) is NOT
 * here — generate.ts `hqGeo` is the sole author for both the synthetic and anchor paths (v26).
 */
export function accountFirmographics(id: AccountIdentity, prof: ScenarioProfile): Partial<GenericRecord> {
  return {
    Type: prof.priorWin ? "Customer - Direct" : "Prospect",
    NumberOfEmployees: id.employees,
    AnnualRevenue: id.revenueUsd,
    Description: id.description,
  };
}
