// packages/engine/src/identity/static-provider.ts
//
// StaticIdentityProvider — the deterministic, no-LLM floor. Synthesizes a coherent, picklist-safe,
// banned-category-free company purely from (seed, index) via a small templated vocabulary, so tests and
// offline runs are byte-stable with NO API credits and the provider set always has a fallback. Every
// template is a real-economy / vertical industry (never a data/BI/analytics vendor), so a static
// identity can't be a self-product. Mirrors StaticSpineProvider (deterministic = true).

import { makeRng, deriveSeed, type IdentityProvider, type IdentityRequest, type IdentityAuthorContext, type IdentityAuthorOutput, type AccountIdentity, type Rng } from "@dataseed/core";

/** Distinctive, invented company-name roots (paired with an industry suffix → "Meridian Freight Systems"). */
const ROOTS = [
  "Meridian", "Northwind", "Cascade", "Arbor", "Vantage", "Brightpath", "Solstice", "Keystone", "Halcyon", "Ironwood",
  "Tideline", "Summit", "Lumen", "Cobalt", "Granite", "Verdant", "Beacon", "Cardinal", "Harbor", "Juniper",
  "Sable", "Crestline", "Foundry", "Marigold", "Aspen", "Polaris", "Redwood", "Sterling", "Wexford", "Yardley",
];

interface Template {
  sfIndustry: string;
  sector: string;
  suffix: string[];
  does: string;
  products: string[];
  buyingDept: string;
  pains: string[];
}

/** Real-economy / vertical templates — deliberately NO data/BI/analytics vendor (self-product safe). */
const TEMPLATES: Template[] = [
  { sfIndustry: "Transportation", sector: "Regional Freight & Logistics", suffix: ["Freight Systems", "Logistics", "Carriers", "Transport Group"], does: "regional freight and last-mile logistics", products: ["LTL freight", "last-mile delivery", "warehousing"], buyingDept: "Operations & Finance", pains: ["reconciling operations and finance reporting across acquired regional carriers", "fragmented dispatch, billing, and fuel-cost reporting across terminals"] },
  { sfIndustry: "Healthcare", sector: "Ambulatory Care Network", suffix: ["Health Group", "Care Network", "Medical Partners", "Health Services"], does: "outpatient and ambulatory healthcare delivery", products: ["primary care clinics", "urgent care", "specialty referrals"], buyingDept: "Revenue Cycle & Operations", pains: ["consolidating patient-throughput and revenue-cycle reporting across clinics", "reconciling scheduling, claims, and staffing data across sites"] },
  { sfIndustry: "Manufacturing", sector: "Industrial Components", suffix: ["Manufacturing", "Industries", "Components", "Works"], does: "precision industrial-component manufacturing", products: ["machined components", "assemblies", "aftermarket parts"], buyingDept: "Operations & Supply Chain", pains: ["unifying production, supply-chain, and finance reporting across plants", "manual throughput and inventory reporting across the shop floor and ERP"] },
  { sfIndustry: "Retail", sector: "Specialty Retail", suffix: ["Retail Group", "Brands", "Outfitters", "Markets"], does: "omnichannel specialty retail", products: ["physical stores", "e-commerce", "loyalty program"], buyingDept: "Merchant Operations", pains: ["reconciling store, e-commerce, and inventory data across channels", "fragmented merchandising and margin reporting across regions"] },
  { sfIndustry: "Food & Beverage", sector: "Food Production", suffix: ["Foods", "Provisions", "Brands", "Kitchens"], does: "packaged food production and distribution", products: ["packaged goods", "foodservice", "private label"], buyingDept: "Supply Chain & Finance", pains: ["consolidating production, distribution, and trade-spend reporting", "manual freshness, cost, and demand reporting across plants and distribution centers"] },
  { sfIndustry: "Insurance", sector: "Specialty Insurance", suffix: ["Insurance Group", "Mutual", "Underwriters", "Assurance"], does: "specialty property & casualty insurance", products: ["commercial P&C", "specialty lines", "claims services"], buyingDept: "Underwriting & Actuarial", pains: ["unifying underwriting, claims, and finance reporting across lines", "slow loss-ratio and reserve reporting across legacy policy systems"] },
  { sfIndustry: "Energy", sector: "Clean Energy Operations", suffix: ["Energy", "Power", "Renewables", "Grid Partners"], does: "distributed clean-energy generation and operations", products: ["solar installations", "battery storage", "grid services"], buyingDept: "Operations & Finance", pains: ["consolidating project-cost and field-operations reporting across sites", "reconciling asset performance and finance data across the fleet"] },
  { sfIndustry: "Hospitality", sector: "Hospitality & Lodging", suffix: ["Hospitality", "Hotels", "Resorts", "Hospitality Group"], does: "hotel and resort hospitality operations", products: ["full-service hotels", "resorts", "events & catering"], buyingDept: "Operations & Finance", pains: ["forecasting labor cost and reporting performance across properties", "fragmented revenue, occupancy, and labor data across locations"] },
  { sfIndustry: "Construction", sector: "Commercial Construction", suffix: ["Construction", "Builders", "Contractors", "Build Group"], does: "commercial construction and project delivery", products: ["general contracting", "design-build", "civil works"], buyingDept: "Project Operations & Finance", pains: ["reconciling project-cost, schedule, and finance data across job sites", "manual progress and margin reporting across active projects"] },
  { sfIndustry: "Education", sector: "Education Services", suffix: ["Education", "Learning Group", "Academies", "Institute"], does: "post-secondary and professional education services", products: ["degree programs", "professional certificates", "corporate training"], buyingDept: "Operations & Data", pains: ["consolidating enrollment, retention, and finance reporting across programs", "fragmented student, content, and support reporting across systems"] },
  { sfIndustry: "Apparel", sector: "Consumer Apparel", suffix: ["Apparel", "Outfitters", "Goods", "Brands"], does: "consumer apparel design and direct-to-consumer retail", products: ["apparel lines", "DTC e-commerce", "wholesale"], buyingDept: "Merchandising & Operations", pains: ["forecasting demand and reconciling returns across channels", "fragmented inventory, margin, and sell-through reporting"] },
  { sfIndustry: "Agriculture", sector: "Agribusiness", suffix: ["Agriculture", "Farms", "Agribusiness", "Growers"], does: "agribusiness production and distribution", products: ["row crops", "fresh produce", "distribution"], buyingDept: "Operations & Finance", pains: ["consolidating yield, logistics, and finance reporting across operations", "manual cost and supply reporting across growers and packhouses"] },
];

/** [empLo, empHi, revPerEmpLo, revPerEmpHi] for the deal-size band → coherent headcount/revenue. */
function sizeFor(band?: string): [number, number, number, number] {
  switch (band) {
    case "LT10K":
    case "10K_50K":
      return [60, 600, 120_000, 200_000];
    case "250K_1M":
    case "GTE1M":
      return [6_000, 40_000, 250_000, 400_000];
    default:
      return [600, 6_000, 180_000, 280_000];
  }
}

const HQ_BY_REGION: Record<string, string[]> = {
  NA: ["Columbus, United States", "Austin, United States", "Denver, United States", "Toronto, Canada", "Atlanta, United States"],
  EMEA: ["Manchester, United Kingdom", "Lyon, France", "Hamburg, Germany", "Rotterdam, Netherlands", "Dublin, Ireland"],
  APAC: ["Brisbane, Australia", "Pune, India", "Osaka, Japan", "Singapore, Singapore", "Auckland, New Zealand"],
};

const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const firstWord = (s: string) => s.split(/\s+/)[0] ?? s;

/** Pick the template matching an industry hint (loose contains match), else a deterministic one. */
function pickTemplate(industry: string | undefined, rng: Rng): Template {
  if (industry) {
    const lc = industry.toLowerCase();
    const hit = TEMPLATES.find((t) => t.sfIndustry.toLowerCase() === lc || t.sector.toLowerCase().includes(lc) || lc.includes(t.sfIndustry.toLowerCase()));
    if (hit) return hit;
  }
  return rng.pick(TEMPLATES);
}

/** Deterministically synthesize a valid AccountIdentity from a request (no LLM). */
export function staticIdentity(req: IdentityRequest): AccountIdentity {
  const rng = makeRng(deriveSeed(0, "identity-static", req.unitKey));
  const tmpl = pickTemplate(req.hints.industry, rng);
  const root = rng.pick(ROOTS);
  const suffix = rng.pick(tmpl.suffix);
  const name = `${root} ${suffix}`;
  const domain = `${root}${firstWord(suffix)}`.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
  const [empLo, empHi, rpeLo, rpeHi] = sizeFor(req.hints.dealSizeBand);
  const employees = rng.int(empLo, empHi);
  const revenueUsd = roundTo(employees * rng.int(rpeLo, rpeHi), 100_000);
  const hq = rng.pick(HQ_BY_REGION[req.hints.region ?? "NA"] ?? HQ_BY_REGION.NA!);
  const painPhrase = rng.pick(tmpl.pains);
  return {
    name,
    sfIndustry: tmpl.sfIndustry,
    domain,
    sector: tmpl.sector,
    employees,
    revenueUsd,
    hq,
    description: `${name} is a ${tmpl.sector.toLowerCase()} company focused on ${tmpl.does}.`,
    does: tmpl.does,
    products: tmpl.products,
    buyingDept: tmpl.buyingDept,
    painPhrase,
  };
}

export class StaticIdentityProvider implements IdentityProvider {
  id = "static";
  deterministic = true;
  available() {
    return true;
  }
  async author(requests: IdentityRequest[], _ctx: IdentityAuthorContext): Promise<IdentityAuthorOutput> {
    return {
      identities: requests.map((req) => ({ unitKey: req.unitKey, index: req.index, identity: staticIdentity(req) })),
      estCostUsd: 0,
      budgetExhausted: false,
    };
  }
}

export default StaticIdentityProvider;
