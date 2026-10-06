// packs/salescloud/src/company-names.ts
//
// Procedural company-name generator for the BULK/background account tier. The 54
// real anchors (anchors.ts) stay reserved for the foreground narrative deals (they
// carry the grounding fact-packs that make hero copy realistic); the bulk tier
// needs unlimited, unique, plausible names — and "Stripe (Div 1852)" reads synthetic.
//
// Design: a name is a point in PREFIX×STEM×CATEGORY×SUFFIX space (a compound root
// "Northwind" + a category "Analytics" + an optional suffix "Group"). Mapping a
// 0-based index → a name through a SEEDED LINEAR PERMUTATION (i·STRIDE+offset mod M,
// gcd(STRIDE, M) = 1 ⇒ bijection on [0,M)) guarantees:
//   • uniqueness  — distinct indices → distinct names for the first M = 4,838,400 accounts
//   • scatter     — consecutive indices land far apart (no alphabetical lockstep)
//   • determinism — same seed → same names; pure, no Math.random
// Past M names a numeric disambiguator keeps uniqueness (only ever hit beyond 4.8M).
//
// INDUSTRY DECOUPLING (v15): the category noun is now NAME FLAVOR ONLY. The account's
// Industry field is drawn INDEPENDENTLY (variability.ts INDUSTRY_DIST, at the generate
// call site) so the name root no longer dictates (or predicts) the industry — killing
// both the "name carries sector meaning" tell and the "Realty→Construction" mismatch.
// `industry()` survives as a DEPRECATED helper (name-flavor mapping) for callers that
// still want a noun-coherent label, but generate.ts no longer uses it for the field.

import type { Rng } from "@dataseed/core";

// 96 prefixes × 60 stems = 5,760 compound roots. Prefix/stem vocabularies are disjoint
// (no "Stonestone"), and glue into readable invented roots ("Northwind", "Ironbrook").
const PREFIXES = [
  "North", "Stone", "Bright", "Clear", "Iron", "River", "Oak", "Cedar", "Silver", "Gold",
  "Black", "White", "Red", "Blue", "Green", "Swift", "High", "West", "Bay", "Pine",
  "Birch", "Ash", "Frost", "Storm", "Sun", "Star", "Cloud", "Dawn", "Rock", "Sand",
  "Fox", "Wolf", "Hawk", "Crane", "Elk", "Bear", "Granite", "Slate", "Amber", "Onyx",
  "East", "South", "Vale", "Moss", "Fern", "Reed", "Thorn", "Briar", "Hollow", "Marsh",
  "Quill", "Vert", "Cobalt", "Copper", "Brass", "Steel", "Flint", "Ember", "Cinder", "Glacier",
  "Tide", "Cove", "Harbor", "Mast", "Anchor", "Beacon", "Summit", "Vista", "Mesa", "Canyon",
  "Prairie", "Meadow", "Heron", "Raven", "Falcon", "Lark", "Sparrow", "Otter", "Lynx", "Stag",
  "Maple", "Aspen", "Willow", "Hazel", "Laurel", "Juniper", "Cypress", "Sage", "Clover", "Holly",
  "Vector", "Apex", "Keystone", "Linden", "Verde", "Aura",
] as const;

const STEMS = [
  "wind", "water", "field", "wood", "ridge", "gate", "ford", "brook", "dale", "mont",
  "vale", "crest", "haven", "bourne", "worth", "land", "peak", "bridge", "view", "cliff",
  "bank", "grove", "line", "point", "reach", "spring", "hill", "lake", "port", "mere",
  "stone", "fall", "glen", "moor", "heath", "march", "wick", "by", "thorpe", "shire",
  "helm", "garth", "holt", "combe", "den", "fen", "marsh", "strand", "quay", "wharf",
  "run", "hollow", "knoll", "bluff", "cove", "isle", "ness", "scar", "tarn", "beck",
] as const;

// 60 category nouns (disjoint from the suffixes below, so no "Northwind Group Group").
// NAME FLAVOR ONLY — the Industry field is drawn independently (see header).
const CATEGORIES = [
  "Analytics", "Systems", "Labs", "Devices", "Networks", "Solutions", "Dynamics", "Logistics",
  "Robotics", "Health", "Financial", "Capital", "Digital", "Cloud", "Data", "Software",
  "Industries", "Sciences", "Instruments", "Ventures", "Materials", "Energy", "Biotech", "Pharma",
  "Medical", "Retail", "Foods", "Beverage", "Apparel", "Media", "Studios", "Security",
  "Defense", "Aerospace", "Automotive", "Mobility", "Insurance", "Realty", "Consulting", "Components",
  "Partners", "Group", "Works", "Holdings", "Technologies", "Logic", "Metrics", "Signal",
  "Forge", "Craft", "Supply", "Trading", "Mutual", "Assurance", "Collective", "Union",
  "Standard", "Global", "Domestic", "Continental",
] as const;

// 14 suffixes incl. two empty slots → ~1/7 of names are bare ("Northwind Analytics"); the rest
// carry a corporate suffix ("Ironbrook Logistics Associates") — realistic for a CRM account book.
// v16: dropped the country-bound legal forms "PLC"/"GmbH" (they stamped a German/UK legal suffix onto
// US accounts — a per-record tell). Length stays 14 (the NAME_SPACE gcd/cardinality invariant
// M = 96·60·60·14 is unchanged). A full per-country legal-suffix system is out of scope.
// v22: the suffix pool is now GENUINELY DISJOINT from CATEGORIES. Previously five tokens —
// Group/Holdings/Partners/Technologies/Industries — lived in BOTH pools, so decode() drawing c and k
// independently produced "Meadowline Partners Partners" / "Forge Industries Industries" doublings (the
// "X X" tell). Those five suffixes are replaced with category-free corporate forms; a module-load guard
// (below) now FAILS if any future edit re-introduces an overlap, instead of relying on a hopeful comment.
const SUFFIXES = ["", "", "Inc", "LLC", "Associates", "Companies", "Corp", "Co", "Brands", "Trust", "International", "Worldwide", "Limited", "Enterprises"] as const;

// Disjointness invariant: no suffix token may also be a category token, or name() renders a doubled word
// ("Root Partners Partners"). Asserted at import — a future pool edit that re-introduces overlap fails loudly.
{
  const overlap = SUFFIXES.filter((s) => s && (CATEGORIES as readonly string[]).includes(s));
  if (overlap.length) {
    throw new Error(`company-names: SUFFIXES overlap CATEGORIES (${overlap.join(", ")}) — name() would render "X X". Keep the two pools disjoint.`);
  }
}

const M = PREFIXES.length * STEMS.length * CATEGORIES.length * SUFFIXES.length; // 96·60·60·14 = 4,838,400 distinct names
const STRIDE = 1_000_003; // prime; gcd(STRIDE, M) = 1 ⇒ (i·STRIDE + offset) mod M is a bijection on [0, M)

/** Greatest common divisor (Euclid) — used to ASSERT STRIDE ⊥ M at module load (a permutation invariant). */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
// Fail loudly at import if the permutation is ever broken by a pool resize (a non-coprime STRIDE would
// fold the index space and re-introduce name collisions). 1,000,003 is prime and does NOT divide
// M = 2^7·3·5^2·7·... so gcd === 1; if a future M shares a factor, fall back to the prime 6,151,879.
if (gcd(STRIDE, M) !== 1) {
  throw new Error(`company-names: STRIDE ${STRIDE} is not coprime to name space M ${M} — the index→name map is no longer a bijection`);
}
export const NAME_SPACE = M; // exported for tests (the gcd/cardinality guard)
export const NAME_STRIDE = STRIDE;

// DEPRECATED (name-flavor only): each category noun maps to a loosely-implied industry. NO LONGER used for
// the Account.Industry field (that is drawn independently from INDUSTRY_DIST) — kept so the export doesn't
// break and a caller wanting a noun-coherent label still has one. Every value is a valid Account.Industry.
const CATEGORY_INDUSTRY: Readonly<Record<(typeof CATEGORIES)[number], string>> = {
  Analytics: "Technology", Systems: "Technology", Labs: "Biotechnology", Devices: "Electronics",
  Networks: "Communications", Solutions: "Technology", Dynamics: "Manufacturing", Logistics: "Transportation",
  Robotics: "Manufacturing", Health: "Healthcare", Financial: "Finance", Capital: "Finance",
  Digital: "Technology", Cloud: "Technology", Data: "Technology", Software: "Technology",
  Industries: "Manufacturing", Sciences: "Biotechnology", Instruments: "Electronics", Ventures: "Finance",
  Materials: "Chemicals", Energy: "Energy", Biotech: "Biotechnology", Pharma: "Healthcare",
  Medical: "Healthcare", Retail: "Retail", Foods: "Agriculture", Beverage: "Hospitality",
  Apparel: "Apparel", Media: "Media", Studios: "Media", Security: "Technology",
  Defense: "Manufacturing", Aerospace: "Manufacturing", Automotive: "Manufacturing", Mobility: "Transportation",
  Insurance: "Insurance", Realty: "Construction", Consulting: "Consulting", Components: "Electronics",
  Partners: "Consulting", Group: "Other", Works: "Manufacturing", Holdings: "Finance",
  Technologies: "Technology", Logic: "Technology", Metrics: "Technology", Signal: "Communications",
  Forge: "Manufacturing", Craft: "Manufacturing", Supply: "Transportation", Trading: "Retail",
  Mutual: "Insurance", Assurance: "Insurance", Collective: "Consulting", Union: "Finance",
  Standard: "Other", Global: "Other", Domestic: "Other", Continental: "Other",
};

export interface CompanyNamer {
  /** A unique (within [0, space)), plausible company name for the given 0-based bulk index. */
  name(index: number): string;
  /** A lowercase domain for the name (suffix stripped) — used for Website + contact emails. */
  domain(index: number): string;
  /** @deprecated name-flavor only — the Industry field is drawn independently. A noun-coherent label. */
  industry(index: number): string;
  /** Distinct names before a numeric disambiguator is appended (M = 4,838,400). */
  readonly space: number;
}

function decode(index: number, offset: number): { root: string; category: string; suffix: string; cycle: number } {
  const cycle = Math.floor(index / M); // 0 until the full space is exhausted (≥ 4.8M accounts)
  let x = ((index % M) * STRIDE + offset) % M; // seeded bijection on [0, M)
  const p = x % PREFIXES.length; x = Math.floor(x / PREFIXES.length);
  const s = x % STEMS.length; x = Math.floor(x / STEMS.length);
  const c = x % CATEGORIES.length; x = Math.floor(x / CATEGORIES.length);
  const k = x % SUFFIXES.length;
  return { root: PREFIXES[p]! + STEMS[s]!, category: CATEGORIES[c]!, suffix: SUFFIXES[k]!, cycle };
}

/** Bind a namer to a run's seed (offset derived once from a dedicated rng stream). */
export function makeCompanyNamer(rng: Rng): CompanyNamer {
  const offset = rng.derive("company-names").int(0, M - 1);
  return {
    space: M,
    name(index: number): string {
      const { root, category, suffix, cycle } = decode(index, offset);
      const base = suffix ? `${root} ${category} ${suffix}` : `${root} ${category}`;
      return cycle === 0 ? base : `${base} ${cycle + 1}`;
    },
    domain(index: number): string {
      const { root, category, cycle } = decode(index, offset);
      const slug = `${root}${category}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      return cycle === 0 ? `${slug}.com` : `${slug}${cycle + 1}.com`;
    },
    industry(index: number): string {
      return CATEGORY_INDUSTRY[decode(index, offset).category as keyof typeof CATEGORY_INDUSTRY];
    },
  };
}
