// packs/salescloud/src/anchor-hq.ts
//
// Curated REAL headquarters for the foreground anchor companies — a public-fact lookup, NOT a generated or
// derived value. The foreground hero deals are real public companies (anchors.ts); a region-random billing city
// ("Coinbase in Chicago") is a louder realism tell than a blank, so anchors get their actual HQ by name. HQ is a
// public, non-financial fact (unlike headcount/revenue, which we still leave unset for anchors — deriving those
// from the deal band would contradict a known company). The row shape matches GEO_BY_REGION so the v19 dual
// state/country-code emit is mechanical. Keys MUST equal the exact `anchor.name` strings in anchors.ts.
//
// VERIFIED against public record 2026-06-25 (company sites / SEC filings / Wikipedia). Relocation-prone rows to
// re-check periodically: Snowflake (→Menlo Park 2025), Teladoc (→NYC 2025), Coinbase (remote-first, SF office),
// CrowdStrike (→Austin 2021), Zscaler (Santa Clara HQ opening ~2026). A stale HQ is the loudest tell here.

import { GEO_BY_REGION } from "./variability.js";

export type Geo = { city: string; country: string; countryCode: string; state: string; stateCode: string };

const US = (city: string, state: string, stateCode: string): Geo => ({ city, country: "United States", countryCode: "US", state, stateCode });

export const ANCHOR_HQ: Record<string, Geo> = {
  "10x Genomics": US("Pleasanton", "California", "CA"),
  Affirm: US("San Francisco", "California", "CA"),
  Airbnb: US("San Francisco", "California", "CA"),
  Allbirds: US("San Francisco", "California", "CA"),
  Atlassian: { city: "Sydney", country: "Australia", countryCode: "AU", state: "New South Wales", stateCode: "NSW" },
  "Beyond Meat": US("El Segundo", "California", "CA"),
  Block: US("Oakland", "California", "CA"),
  Chewy: US("Plantation", "Florida", "FL"),
  Chime: US("San Francisco", "California", "CA"),
  Cloudflare: US("San Francisco", "California", "CA"),
  Coinbase: US("San Francisco", "California", "CA"), // officially HQ-less/remote-first; SF (Mission Rock office, infobox) is the defensible real city — "Remote" would contradict a street address
  Confluent: US("Mountain View", "California", "CA"),
  Coursera: US("Mountain View", "California", "CA"),
  CrowdStrike: US("Austin", "Texas", "TX"),
  Datadog: US("New York", "New York", "NY"),
  DocuSign: US("San Francisco", "California", "CA"),
  DoorDash: US("San Francisco", "California", "CA"),
  Duolingo: US("Pittsburgh", "Pennsylvania", "PA"),
  "Enphase Energy": US("Fremont", "California", "CA"),
  "First Solar": US("Tempe", "Arizona", "AZ"),
  "Guardant Health": US("Palo Alto", "California", "CA"),
  HubSpot: US("Cambridge", "Massachusetts", "MA"),
  Lemonade: US("New York", "New York", "NY"),
  "Lucid Motors": US("Newark", "California", "CA"),
  Lyft: US("San Francisco", "California", "CA"),
  Moderna: US("Cambridge", "Massachusetts", "MA"),
  MongoDB: US("New York", "New York", "NY"),
  Okta: US("San Francisco", "California", "CA"),
  PayPal: US("San Jose", "California", "CA"),
  Procore: US("Carpinteria", "California", "CA"),
  RingCentral: US("Belmont", "California", "CA"),
  Rivian: US("Irvine", "California", "CA"),
  Robinhood: US("Menlo Park", "California", "CA"),
  Roblox: US("San Mateo", "California", "CA"),
  Roku: US("San Jose", "California", "CA"),
  Root: US("Columbus", "Ohio", "OH"),
  Samsara: US("San Francisco", "California", "CA"),
  ServiceNow: US("Santa Clara", "California", "CA"),
  Shopify: { city: "Ottawa", country: "Canada", countryCode: "CA", state: "Ontario", stateCode: "ON" },
  Snowflake: US("Menlo Park", "California", "CA"), // operational HQ relocated to CA in 2025 (SEC principal office still legally Bozeman MT — stale)
  SoFi: US("San Francisco", "California", "CA"),
  Spotify: { city: "Stockholm", country: "Sweden", countryCode: "SE", state: "", stateCode: "" },
  Stripe: US("South San Francisco", "California", "CA"),
  Sunrun: US("San Francisco", "California", "CA"),
  Sweetgreen: US("Los Angeles", "California", "CA"),
  "Teladoc Health": US("New York", "New York", "NY"), // relocated principal office Purchase NY → Manhattan, June 2025 (FY2025 10-K)
  Toast: US("Boston", "Massachusetts", "MA"),
  Twilio: US("San Francisco", "California", "CA"),
  Uber: US("San Francisco", "California", "CA"),
  "Unity Technologies": US("San Francisco", "California", "CA"),
  "Veeva Systems": US("Pleasanton", "California", "CA"),
  "Warby Parker": US("New York", "New York", "NY"),
  Wayfair: US("Boston", "Massachusetts", "MA"),
  Zscaler: US("San Jose", "California", "CA"),
};

// Reverse lookup for the SYNTHETIC path: recover ISO codes when an authored HQ country matches a known one
// (else the synthetic account stays label-only — never a fabricated code).
const COUNTRY_GEO = new Map<string, Geo>(Object.values(GEO_BY_REGION).flat().map((g) => [g.country, g as Geo]));
export function geoForCountry(country: string): Geo | undefined { return COUNTRY_GEO.get(country); }

// Representative in-state ZIP-3 prefix per US state (a major-metro sectional-center prefix). A real BillingPostal
// is built as `ZIP3 + two stream-drawn digits`, so the ZIP is always in the RIGHT STATE — a random 5-digit ZIP
// put a CA address in a TX ZIP region, which (like a wrong phone dial code) is a cross-field realism tell. We bind
// to state, not city (any in-state ZIP kills the tell); city-exact ZIP precision is a deferred backlog item.
export const US_STATE_ZIP3: Record<string, string> = {
  AL: "352", AK: "995", AZ: "850", AR: "722", CA: "941", CO: "802", CT: "061", DE: "197", DC: "200", FL: "331",
  GA: "303", HI: "968", ID: "837", IL: "606", IN: "462", IA: "503", KS: "662", KY: "402", LA: "701", ME: "040",
  MD: "212", MA: "021", MI: "481", MN: "553", MS: "392", MO: "631", MT: "591", NE: "681", NV: "891", NH: "030",
  NJ: "070", NM: "871", NY: "100", NC: "282", ND: "581", OH: "432", OK: "731", OR: "972", PA: "191", RI: "029",
  SC: "290", SD: "571", TN: "372", TX: "750", UT: "841", VT: "056", VA: "232", WA: "981", WV: "253", WI: "532",
  WY: "820",
};
