// packs/salescloud/src/variability.ts
//
// The salescloud pack's variability matrix + the per-scenario generation knobs the
// narrative-design doc calls for: the 6 deal-size bands (seed MULTIPLE deals per
// band so the no-DC pacing benchmark has cohorts), regions, the 10 standard sales
// stages, and per-arc shape (email count, sentiment trajectory, persona mix,
// stage skew). The engine samples `variability` per unit into PlanUnit.traits;
// generate() reads the traits + the scenario profile below.

import type { VariabilityMatrix, WeightedValue, Rng } from "@dataseed/core";

/** The 6 BenchmarkBands (grounding §4). Weighted toward mid-market — but every band is represented. */
export const SALESCLOUD_VARIABILITY: VariabilityMatrix = {
  dealSizeBand: [
    { value: "LT10K", weight: 1 },
    { value: "10K_50K", weight: 3 },
    { value: "50K_100K", weight: 4 },
    { value: "100K_250K", weight: 4 },
    { value: "250K_1M", weight: 3 },
    { value: "GTE1M", weight: 1 },
  ],
  region: [
    { value: "NA", weight: 5 },
    { value: "EMEA", weight: 3 },
    { value: "APAC", weight: 2 },
  ],
};

/** Inclusive USD amount range per band (generate picks within via the unit rng). */
export const BAND_RANGE: Record<string, [number, number]> = {
  LT10K: [2_000, 10_000],
  "10K_50K": [10_000, 50_000],
  "50K_100K": [50_000, 100_000],
  "100K_250K": [100_000, 250_000],
  "250K_1M": [250_000, 1_000_000],
  GTE1M: [1_000_000, 3_000_000],
};

/** The 10 standard sales stages (open + closed). */
export const STAGES = [
  "Prospecting",
  "Qualification",
  "Needs Analysis",
  "Value Proposition",
  "Id. Decision Makers",
  "Perception Analysis",
  "Proposal/Price Quote",
  "Negotiation/Review",
  "Closed Won",
  "Closed Lost",
] as const;

export type SentimentShape = "steady" | "accelerating" | "stalling";

/** Per-scenario generation profile (structure only; prose is the copy layer's job). */
export interface ScenarioProfile {
  /** Candidate open stages for this arc (generate picks one via the unit rng). */
  stages: readonly string[];
  /** Email-cadence shape → drives the velocity classifier post-load. */
  shape: SentimentShape;
  /** [min,max] EmailMessages per deal. */
  emailRange: [number, number];
  /** [min,max] logged-activity Tasks per deal (calls/meetings — a second signal stream). */
  taskRange: [number, number];
  /** Persona mix to instantiate as Contacts (order = priority; truncated to count). */
  personas: readonly string[];
  /** [min,max] contacts per deal. */
  contactRange: [number, number];
  /** Days from asOf to CloseDate (future). */
  closeInDays: [number, number];
  /**
   * When set, the account ALSO carries a PRIOR closed-won deal (the original land), so the account
   * has real cross-deal history — what an account-level intelligence layer aggregates across. agoDays = how far
   * back its CloseDate sits; amountFactor = the prior deal's size relative to the current one.
   * Historical context: no emails/tasks (nothing new to synthesize from it).
   */
  priorWin?: { agoDays: [number, number]; amountFactor: [number, number] };
  /** One-line arc intent, surfaced in copy requests + previews. */
  intent: string;
  /**
   * Paraphrases of `intent` — the static spine picks one per deal (by a per-unit `variant` draw) so two
   * deals of the SAME scenario don't stamp a verbatim arc + email-summary string (the audit's
   * "interchangeable beat sheet / same prof.intent every email" tell). Each keeps the scenario's SHAPE but
   * varies the angle/objection. Falls back to `intent` when absent.
   */
  intents?: readonly string[];
}

// ── Bulk / background population tier (the scale knob — see company-names.ts) ────────────────────
// These accounts make an org FEEL populated at scale: rich Account fields + a realistic
// opps-per-account distribution, but NO email/task/transcript signal streams — so they cost ~7
// records each and fire ZERO trigger cascade. Foreground `volume` deals are unchanged.

/** Standard Account.Industry picklist values the bulk tier spreads across (all valid on a vanilla org). */
export const BULK_INDUSTRIES = [
  "Technology", "Finance", "Healthcare", "Manufacturing", "Retail", "Energy", "Education", "Consulting",
  "Transportation", "Communications", "Biotechnology", "Insurance", "Construction", "Hospitality", "Media",
  "Agriculture", "Chemicals", "Electronics", "Apparel", "Banking",
] as const;

/** Account.Type — weighted toward prospects. Values from the standard default Account.Type picklist. */
export const BULK_ACCOUNT_TYPES: readonly WeightedValue[] = [
  { value: "Prospect", weight: 50 },
  { value: "Customer - Direct", weight: 30 },
  { value: "Customer - Channel", weight: 12 },
  { value: "Other", weight: 8 },
];

/** Company-size bands → employee range. revPerEmp is a coarse floor/ceiling; the per-industry RPE map
 *  (INDUSTRY_RPE, below) is the dominant signal so AnnualRevenue carries the SECTOR, not a flat band. */
export const SIZE_BANDS = [
  { value: "SMB", weight: 46, employees: [10, 200] as [number, number], revPerEmp: [120_000, 220_000] as [number, number] },
  { value: "MidMarket", weight: 37, employees: [200, 2_000] as [number, number], revPerEmp: [180_000, 300_000] as [number, number] },
  { value: "Enterprise", weight: 17, employees: [2_000, 50_000] as [number, number], revPerEmp: [250_000, 450_000] as [number, number] },
] as const;

/**
 * Industry-specific revenue-per-employee (USD) — software/SaaS is capital-light and high-RPE; manufacturing
 * and retail are headcount-heavy and lower-RPE. Sampled per account so AnnualRevenue reflects the SECTOR
 * (the audit's "rev/employee uniform across the corpus" tell), not a flat ~$124K–$269K band. Any industry
 * not listed falls back to DEFAULT. Cardinality is irrelevant — these are economic ranges, not text.
 */
export const INDUSTRY_RPE: Record<string, [number, number]> = {
  Technology: [250_000, 1_000_000], Telecommunications: [300_000, 800_000], Communications: [250_000, 700_000],
  Finance: [350_000, 1_200_000], Banking: [400_000, 1_400_000], Insurance: [300_000, 900_000],
  Biotechnology: [200_000, 700_000], Healthcare: [180_000, 450_000], Energy: [400_000, 1_500_000],
  Utilities: [350_000, 900_000], Media: [200_000, 600_000], Entertainment: [180_000, 500_000],
  Electronics: [200_000, 500_000], Engineering: [180_000, 400_000], Chemicals: [250_000, 600_000],
  Manufacturing: [150_000, 400_000], Machinery: [150_000, 400_000], Construction: [120_000, 350_000],
  Transportation: [120_000, 350_000], Shipping: [120_000, 350_000], Retail: [100_000, 250_000],
  Apparel: [100_000, 280_000], "Food & Beverage": [120_000, 300_000], Hospitality: [80_000, 200_000],
  Recreation: [90_000, 220_000], Agriculture: [120_000, 320_000], Education: [80_000, 180_000],
  Government: [110_000, 250_000], "Not For Profit": [70_000, 160_000], Environmental: [130_000, 350_000],
  Consulting: [180_000, 500_000], DEFAULT: [120_000, 300_000],
};

/**
 * Account.Industry distribution — the FULL 33-value standard picklist (⊆ ACCOUNT_INDUSTRIES in picklists.ts),
 * weighted to a believable B2B CRM book. Replaces the name-coupled industry (the #1 bulk tell). Every value
 * carries weight ≥ 1 so Telecom/Education/Banking each get representation instead of starving. Drawn
 * INDEPENDENTLY of the company name (no "Realty"→Construction mismatch).
 */
export const INDUSTRY_DIST: readonly WeightedValue[] = [
  { value: "Technology", weight: 14 }, { value: "Manufacturing", weight: 10 }, { value: "Healthcare", weight: 8 },
  { value: "Finance", weight: 7 }, { value: "Retail", weight: 6 }, { value: "Consulting", weight: 5 },
  { value: "Construction", weight: 5 }, { value: "Education", weight: 5 }, { value: "Transportation", weight: 4 },
  { value: "Communications", weight: 4 }, { value: "Banking", weight: 4 }, { value: "Insurance", weight: 4 },
  { value: "Energy", weight: 4 }, { value: "Hospitality", weight: 4 }, { value: "Media", weight: 3 },
  { value: "Biotechnology", weight: 3 }, { value: "Electronics", weight: 3 }, { value: "Telecommunications", weight: 3 },
  { value: "Agriculture", weight: 3 }, { value: "Food & Beverage", weight: 3 }, { value: "Machinery", weight: 3 },
  { value: "Engineering", weight: 3 }, { value: "Government", weight: 2 }, { value: "Apparel", weight: 2 },
  { value: "Chemicals", weight: 2 }, { value: "Entertainment", weight: 2 }, { value: "Shipping", weight: 2 },
  { value: "Utilities", weight: 2 }, { value: "Recreation", weight: 2 }, { value: "Environmental", weight: 1 },
  { value: "Not For Profit", weight: 1 }, { value: "Other", weight: 1 },
];

/** Region → plausible BillingCity + BillingCountry (city is free text; countries are standard picklist values).
 *  NA 24 / EMEA 28 / APAC 20 = 72 cities (was 17) — wider geographic spread across the corpus. */
// Each entry binds city + country + state as ONE coherent unit (state drawn WITH the city, never independently
// — an independent region-scoped state draw put "Île-de-France" on a Stockholm/Sweden address). `state` is the
// city's real subnational (US state, Canadian province, German Land, …) and is "" for countries that don't carry
// a state line in postal addresses (Sweden, Denmark, Singapore, …) — the generator omits BillingState when "".
// v19 (load-safety): each entry carries the ISO countryCode + stateCode AND the canonical Salesforce label.
// On an org with State & Country Picklists ENABLED, the loader sets the *Code fields (validated → Salesforce
// autofills the canonical text) and the label text is consistent; on a picklist-OFF org the *Code fields are
// not createable (dropped) and the canonical label is used as free text. State is "" where Salesforce's
// standard picklist has no sub-states for that country (UK/DE/FR/…) — emitting one there fails on a
// picklist-on org. Resolved against the live BillingStateCode/BillingCountryCode picklists (dependent on the
// controlling country), so every value is a real, insertable code+label pair.
export const GEO_BY_REGION: Record<string, ReadonlyArray<{ city: string; country: string; countryCode: string; state: string; stateCode: string }>> = {
  NA: [
    { city: "San Francisco", country: "United States", countryCode: "US", state: "California", stateCode: "CA" }, { city: "New York", country: "United States", countryCode: "US", state: "New York", stateCode: "NY" },
    { city: "Austin", country: "United States", countryCode: "US", state: "Texas", stateCode: "TX" }, { city: "Chicago", country: "United States", countryCode: "US", state: "Illinois", stateCode: "IL" },
    { city: "Boston", country: "United States", countryCode: "US", state: "Massachusetts", stateCode: "MA" }, { city: "Seattle", country: "United States", countryCode: "US", state: "Washington", stateCode: "WA" },
    { city: "Denver", country: "United States", countryCode: "US", state: "Colorado", stateCode: "CO" }, { city: "Atlanta", country: "United States", countryCode: "US", state: "Georgia", stateCode: "GA" },
    { city: "Dallas", country: "United States", countryCode: "US", state: "Texas", stateCode: "TX" }, { city: "Los Angeles", country: "United States", countryCode: "US", state: "California", stateCode: "CA" },
    { city: "Minneapolis", country: "United States", countryCode: "US", state: "Minnesota", stateCode: "MN" }, { city: "Portland", country: "United States", countryCode: "US", state: "Oregon", stateCode: "OR" },
    { city: "Columbus", country: "United States", countryCode: "US", state: "Ohio", stateCode: "OH" }, { city: "Raleigh", country: "United States", countryCode: "US", state: "North Carolina", stateCode: "NC" },
    { city: "Nashville", country: "United States", countryCode: "US", state: "Tennessee", stateCode: "TN" }, { city: "Phoenix", country: "United States", countryCode: "US", state: "Arizona", stateCode: "AZ" },
    { city: "Detroit", country: "United States", countryCode: "US", state: "Michigan", stateCode: "MI" }, { city: "Miami", country: "United States", countryCode: "US", state: "Florida", stateCode: "FL" },
    { city: "Toronto", country: "Canada", countryCode: "CA", state: "Ontario", stateCode: "ON" }, { city: "Vancouver", country: "Canada", countryCode: "CA", state: "British Columbia", stateCode: "BC" },
    { city: "Montreal", country: "Canada", countryCode: "CA", state: "Quebec", stateCode: "QC" }, { city: "Calgary", country: "Canada", countryCode: "CA", state: "Alberta", stateCode: "AB" },
    { city: "Mexico City", country: "Mexico", countryCode: "MX", state: "", stateCode: "" }, { city: "Guadalajara", country: "Mexico", countryCode: "MX", state: "Jalisco", stateCode: "JA" },
  ],
  EMEA: [
    { city: "London", country: "United Kingdom", countryCode: "GB", state: "", stateCode: "" }, { city: "Manchester", country: "United Kingdom", countryCode: "GB", state: "", stateCode: "" },
    { city: "Edinburgh", country: "United Kingdom", countryCode: "GB", state: "", stateCode: "" }, { city: "Munich", country: "Germany", countryCode: "DE", state: "", stateCode: "" },
    { city: "Berlin", country: "Germany", countryCode: "DE", state: "", stateCode: "" }, { city: "Hamburg", country: "Germany", countryCode: "DE", state: "", stateCode: "" },
    { city: "Frankfurt", country: "Germany", countryCode: "DE", state: "", stateCode: "" }, { city: "Paris", country: "France", countryCode: "FR", state: "", stateCode: "" },
    { city: "Lyon", country: "France", countryCode: "FR", state: "", stateCode: "" }, { city: "Amsterdam", country: "Netherlands", countryCode: "NL", state: "", stateCode: "" },
    { city: "Dublin", country: "Ireland", countryCode: "IE", state: "", stateCode: "" }, { city: "Stockholm", country: "Sweden", countryCode: "SE", state: "", stateCode: "" },
    { city: "Madrid", country: "Spain", countryCode: "ES", state: "", stateCode: "" }, { city: "Barcelona", country: "Spain", countryCode: "ES", state: "", stateCode: "" },
    { city: "Milan", country: "Italy", countryCode: "IT", state: "", stateCode: "" }, { city: "Rome", country: "Italy", countryCode: "IT", state: "", stateCode: "" },
    { city: "Copenhagen", country: "Denmark", countryCode: "DK", state: "", stateCode: "" }, { city: "Oslo", country: "Norway", countryCode: "NO", state: "", stateCode: "" },
    { city: "Helsinki", country: "Finland", countryCode: "FI", state: "", stateCode: "" }, { city: "Zurich", country: "Switzerland", countryCode: "CH", state: "", stateCode: "" },
    { city: "Geneva", country: "Switzerland", countryCode: "CH", state: "", stateCode: "" }, { city: "Vienna", country: "Austria", countryCode: "AT", state: "", stateCode: "" },
    { city: "Brussels", country: "Belgium", countryCode: "BE", state: "", stateCode: "" }, { city: "Lisbon", country: "Portugal", countryCode: "PT", state: "", stateCode: "" },
    { city: "Warsaw", country: "Poland", countryCode: "PL", state: "", stateCode: "" }, { city: "Prague", country: "Czechia", countryCode: "CZ", state: "", stateCode: "" },
    { city: "Tel Aviv", country: "Israel", countryCode: "IL", state: "", stateCode: "" }, { city: "Cape Town", country: "South Africa", countryCode: "ZA", state: "", stateCode: "" },
  ],
  APAC: [
    { city: "Sydney", country: "Australia", countryCode: "AU", state: "New South Wales", stateCode: "NSW" }, { city: "Melbourne", country: "Australia", countryCode: "AU", state: "Victoria", stateCode: "VIC" },
    { city: "Singapore", country: "Singapore", countryCode: "SG", state: "", stateCode: "" }, { city: "Bangalore", country: "India", countryCode: "IN", state: "Karnataka", stateCode: "KA" },
    { city: "Mumbai", country: "India", countryCode: "IN", state: "Maharashtra", stateCode: "MH" }, { city: "Pune", country: "India", countryCode: "IN", state: "Maharashtra", stateCode: "MH" },
    { city: "Hyderabad", country: "India", countryCode: "IN", state: "Telangana", stateCode: "TG" }, { city: "Delhi", country: "India", countryCode: "IN", state: "Delhi", stateCode: "DL" },
    { city: "Tokyo", country: "Japan", countryCode: "JP", state: "Tokyo", stateCode: "13" }, { city: "Osaka", country: "Japan", countryCode: "JP", state: "Osaka", stateCode: "27" },
    { city: "Seoul", country: "Korea, Republic of", countryCode: "KR", state: "", stateCode: "" }, { city: "Taipei", country: "Taiwan", countryCode: "TW", state: "", stateCode: "" },
    { city: "Shanghai", country: "China", countryCode: "CN", state: "Shanghai", stateCode: "31" }, { city: "Shenzhen", country: "China", countryCode: "CN", state: "Guangdong", stateCode: "44" },
    { city: "Jakarta", country: "Indonesia", countryCode: "ID", state: "", stateCode: "" }, { city: "Manila", country: "Philippines", countryCode: "PH", state: "", stateCode: "" },
    { city: "Kuala Lumpur", country: "Malaysia", countryCode: "MY", state: "", stateCode: "" }, { city: "Bangkok", country: "Thailand", countryCode: "TH", state: "", stateCode: "" },
    { city: "Auckland", country: "New Zealand", countryCode: "NZ", state: "", stateCode: "" }, { city: "Wellington", country: "New Zealand", countryCode: "NZ", state: "", stateCode: "" },
  ],
};

/**
 * Opps-per-account distribution — a real book of business is a POWER LAW, not one-deal-per-account.
 * Each weighted bucket is a [min,max] count of TOTAL opportunities (open + closed history) the account
 * carries. Expected ≈ 1.7 opps/account; ~34% of accounts have none (dormant prospects).
 */
export const OPP_COUNT_DISTRIBUTION = [
  { weight: 34, range: [0, 0] as [number, number] }, // dormant / never-engaged
  { weight: 34, range: [1, 1] as [number, number] }, // single deal
  { weight: 20, range: [2, 4] as [number, number] }, // a few
  { weight: 9, range: [5, 9] as [number, number] }, //  active
  { weight: 3, range: [10, 20] as [number, number] }, // strategic
] as const;

/** Per-opp lifecycle split for the bulk tier — open pipeline vs closed-won/closed-lost history. */
export const OPP_STATE_MIX: readonly WeightedValue[] = [
  { value: "open", weight: 40 },
  { value: "won", weight: 35 },
  { value: "lost", weight: 25 },
];

/** Open stages a bulk open opp can sit in (the standard pipeline, excluding the two Closed stages). */
export const BULK_OPEN_STAGES = STAGES.filter((s) => !s.startsWith("Closed"));

export const SCENARIO_PROFILES: Record<string, ScenarioProfile> = {
  "at-risk-budget": {
    stages: ["Negotiation/Review", "Proposal/Price Quote"],
    shape: "stalling", // active, then champion goes quiet
    emailRange: [5, 7],
    taskRange: [2, 3],
    personas: ["Champion", "Economic Buyer", "Skeptic", "Technical Evaluator"],
    contactRange: [3, 4],
    closeInDays: [20, 45],
    intent: "Late-stage deal where the champion has gone silent and budget is suddenly contested.",
    intents: [
      "Late-stage deal where the champion has gone silent and budget is suddenly contested.",
      "A deal that was tracking to close until finance reopened the spend and the main contact stopped replying.",
      "A late budget freeze stalled a deal the team thought was won; the champion has gone quiet and a skeptic is pressing on terms.",
    ],
  },
  "healthy-tech": {
    stages: ["Proposal/Price Quote", "Negotiation/Review", "Value Proposition"],
    shape: "accelerating",
    emailRange: [6, 8],
    taskRange: [2, 4],
    personas: ["Champion", "Economic Buyer", "Technical Evaluator", "Coach"],
    contactRange: [3, 4],
    closeInDays: [15, 35],
    priorWin: { agoDays: [300, 540], amountFactor: [0.4, 0.8] }, // an existing customer expanding — current deal is the bigger expand on a prior land
    intent: "Multi-threaded, mostly-green deal with steady forward momentum.",
    intents: [
      "Multi-threaded, mostly-green deal with steady forward momentum.",
      "A well-qualified expansion moving on schedule, several stakeholders already aligned.",
      "A healthy deal with a committed champion and a clear path to close — the momentum is real, not manufactured.",
    ],
  },
  "rfp-gated": {
    // An RFP with a response in flight (SOC 2 delivered, committee scoring) is mid-funnel, NOT "Qualification"
    // (the coherence audit's Allbirds tell: StageName understated the deal vs its own narrative).
    stages: ["Needs Analysis", "Value Proposition", "Proposal/Price Quote"],
    shape: "steady",
    emailRange: [3, 5],
    taskRange: [1, 2],
    personas: ["Technical Evaluator", "Coach", "End User"],
    contactRange: [2, 3],
    closeInDays: [60, 120],
    intent: "Early, quiet, RFP-gated deal — sparse signal, no champion yet (honest 'early, not at risk').",
    intents: [
      "Early, quiet, RFP-gated deal — sparse signal, no champion yet (honest 'early, not at risk').",
      "A formal RFP in its early innings: structured, low-touch, no internal champion surfaced yet.",
      "An early-stage evaluation gated behind a committee RFP — deliberate and slow, genuinely not at risk yet.",
    ],
  },
  "stalled-portfolio": {
    // BOTH late-stage — a stalled-portfolio deal is late-and-decayed, so its StageName must read late
    // (a sent proposal / active negotiation), never the mid-funnel "Perception Analysis" (the coherence
    // audit's Lucid tell: stage "Perception Analysis" while the prose routes a proposal for sign-off).
    stages: ["Negotiation/Review", "Proposal/Price Quote"],
    shape: "stalling",
    emailRange: [4, 6],
    taskRange: [1, 3],
    personas: ["Champion", "Economic Buyer", "Blocker"],
    contactRange: [2, 4],
    closeInDays: [30, 60],
    intent: "Late-stage deal whose cadence has decayed to Stalling/Dark.",
    intents: [
      "Late-stage deal whose cadence has decayed to Stalling/Dark.",
      "A deal that went dark after a strong middle — replies have dried up and the close date keeps drifting.",
      "Momentum has bled out of a once-active deal; the buying group has gone quiet without a clear 'no'.",
    ],
  },
  "churning-account": {
    stages: ["Closed Lost", "Negotiation/Review"],
    shape: "stalling",
    emailRange: [4, 6],
    taskRange: [1, 2],
    personas: ["Economic Buyer", "Skeptic", "Blocker"],
    contactRange: [2, 3],
    closeInDays: [10, 30],
    priorWin: { agoDays: [400, 620], amountFactor: [0.8, 1.3] }, // bought ~1–1.7y ago; the renewal/expansion is now at risk — the churn story
    intent: "Account with declining sentiment and a recent loss — cross-deal intelligence signal.",
    intents: [
      "Account with declining sentiment and a recent loss — cross-deal intelligence signal.",
      "An existing customer souring at renewal — usage down, a competitor circling, expansion at risk.",
      "A renewal turning into a save: sentiment is sliding and a prior loss is still fresh.",
    ],
  },
};

// ── Bulk Sales-Cloud graph (Phase 4E) — the wider object set layered onto bulk accounts ──────────────
// All values here are STANDARD Salesforce defaults (load-safe in an untouched org). Subjects are
// generic-but-plausible (these accounts carry no narrative/voice — they're firmographic texture a VP
// scans, not deals anyone reads). The bulk generator scales each family's count by `plan.bulkDensity`.

/** OpportunityContactRole.Role — standard default set, NON-primary roles for committee expansion.
 *  ("Technical Evaluator" is NOT in the standard set — the standard technical role is "Technical Buyer".) */
export const BULK_OCR_ROLES = [
  "Economic Buyer",
  "Technical Buyer",
  "Business User",
  "Evaluator",
  "Influencer",
  "Executive Sponsor",
] as const;

/** @deprecated v15 — superseded by the stage-aware bulkTaskSubject() slot system below (kept for back-compat). */
export const BULK_TASK_SUBJECTS = [
  "Call: discovery follow-up",
  "Call: pricing questions",
  "Send proposal recap",
  "Schedule technical deep-dive",
  "Check in on procurement status",
  "Email: security questionnaire",
  "Quarterly business review prep",
  "Confirm next steps with champion",
  "Renewal reminder",
  "Log: left voicemail",
] as const;

/** @deprecated v15 — superseded by the stage-aware bulkEventSubject() slot system below (kept for back-compat). */
export const BULK_EVENT_SUBJECTS = [
  "Discovery call",
  "Product demo",
  "Technical deep-dive",
  "Pricing & proposal review",
  "Executive alignment",
  "Quarterly business review",
  "Implementation kickoff",
] as const;

/** @deprecated v15 — superseded by the area-driven bulkCaseSubject() builder below (kept for back-compat). */
export const BULK_CASE_SUBJECTS = [
  "Login / SSO not working",
  "Data sync delay",
  "Report export error",
  "API rate-limit question",
  "User provisioning request",
  "Billing discrepancy",
  "Feature request: bulk edit",
  "Performance degradation",
  "Integration setup help",
  "Permission / sharing issue",
] as const;

/** Case.Status mix — most resolved (a healthy support backlog), a tail still open. */
export const BULK_CASE_STATUS_MIX: readonly WeightedValue[] = [
  { value: "Closed", weight: 65 },
  { value: "Working", weight: 20 },
  { value: "New", weight: 10 },
  { value: "Escalated", weight: 5 },
];

/** Case.Origin mix. */
export const BULK_CASE_ORIGIN_MIX: readonly WeightedValue[] = [
  { value: "Email", weight: 45 },
  { value: "Phone", weight: 35 },
  { value: "Web", weight: 20 },
];

/** Priority mix for Task / Event (the standard Activity set uses "Normal"). */
export const BULK_PRIORITY_MIX: readonly WeightedValue[] = [
  { value: "Normal", weight: 60 },
  { value: "High", weight: 25 },
  { value: "Low", weight: 15 },
];

/** Priority mix for Case (the standard Case set uses "Medium", not "Normal"). */
export const BULK_CASE_PRIORITY_MIX: readonly WeightedValue[] = [
  { value: "Medium", weight: 60 },
  { value: "High", weight: 25 },
  { value: "Low", weight: 15 },
];

/** Task.Status by recency — past activities are Completed; future ones are Not Started / In Progress. */
export const BULK_TASK_OPEN_STATUS: readonly WeightedValue[] = [
  { value: "Not Started", weight: 60 },
  { value: "In Progress", weight: 40 },
];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v15 — BULK-TIER COMBINATORIAL CONTENT (the corpus-quality overhaul)
//
// Three slot systems replace the flat ≤10-value subject arrays above, lifting per-family distinctness
// from a handful of strings to tens of thousands while staying byte-deterministic (every draw is off a
// seeded Rng; pools are frozen `as const`). All subject/description/comment/name strings are FREE TEXT
// (no restricted picklist), so the only constraints are length (Subject<255, Description<32k,
// CommentBody<4k) — all slot outputs are 1–3 short sentences, well under.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── Pure helpers (no RNG) — derived opportunity/firmographic facts ──────────────────────────────

/** Fiscal quarter + year label from a Salesforce Date/DateTime (calendar-FY). e.g. "Q3 FY26". */
export function quarterOf(date: string): string {
  const d = new Date(date);
  const q = Math.floor(d.getUTCMonth() / 3) + 1; // 1..4
  const fy = String(d.getUTCFullYear()).slice(2);
  return `Q${q} FY${fy}`;
}

/** Seat-tier label bucketed from NumberOfEmployees — multiplies cleanly into a License line Quantity. */
export function seatTier(employees: number): string {
  if (employees < 50) return "25-Seat";
  if (employees < 150) return "100-Seat";
  if (employees < 400) return "250-Seat";
  if (employees < 900) return "500-Seat";
  if (employees < 2_500) return "1,000-Seat";
  if (employees < 8_000) return "2,500-Seat";
  return "Enterprise-Wide";
}

/** The integer seat count behind a seatTier label — for License-line Quantity. */
export function seatCount(employees: number): number {
  if (employees < 50) return 25;
  if (employees < 150) return 100;
  if (employees < 400) return 250;
  if (employees < 900) return 500;
  if (employees < 2_500) return 1_000;
  if (employees < 8_000) return 2_500;
  return 5_000;
}

/** Coarse stage band (early / mid / late / closed) — keys the NextStep + intent pools. */
export function stageBand(stage: string): "early" | "mid" | "late" | "closed" {
  if (stage.startsWith("Closed")) return "closed";
  if (stage === "Prospecting" || stage === "Qualification" || stage === "Needs Analysis" || stage === "Id. Decision Makers") return "early";
  if (stage === "Value Proposition" || stage === "Perception Analysis" || stage === "Proposal/Price Quote") return "mid";
  return "late"; // Negotiation/Review
}

/** Product → family rollup for the opp NAME_SHAPES that want a category, not a SKU. */
export function familyRollup(product: string): string {
  if (product.includes("Analytics")) return "Analytics";
  if (product.includes("Support") || product.includes("Onboarding") || product.includes("Training") || product.includes("Implementation")) return "Services";
  return "Platform";
}

/** Probability derived from StageName (standard SFDC stage defaults) — never sampled, always stage-coherent. */
export const PROBABILITY: Record<string, number> = {
  Prospecting: 10, Qualification: 10, "Needs Analysis": 20, "Value Proposition": 50,
  "Id. Decision Makers": 60, "Perception Analysis": 70, "Proposal/Price Quote": 75,
  "Negotiation/Review": 90, "Closed Won": 100, "Closed Lost": 0,
};

/** ForecastCategoryName derived from StageName — standard value set (added to picklists.ts). */
export const FORECASTCATEGORY: Record<string, string> = {
  Prospecting: "Pipeline", Qualification: "Pipeline", "Needs Analysis": "Pipeline", "Id. Decision Makers": "Pipeline",
  "Value Proposition": "Best Case", "Perception Analysis": "Best Case", "Proposal/Price Quote": "Best Case",
  "Negotiation/Review": "Commit", "Closed Won": "Closed", "Closed Lost": "Omitted",
};

// ── Opportunity naming + standard-field pools ───────────────────────────────────────────────────

/** NAME_SHAPES — weighted templates, ALL keep the "{Account} — …" prefix, NONE encode deal state. */
export const NAME_SHAPES: readonly WeightedValue[] = [
  { value: "{Account} — {Initiative}", weight: 22 },
  { value: "{Account} — {ProductLine} {Initiative}", weight: 20 },
  { value: "{Account} — {Department} {Initiative}", weight: 16 },
  { value: "{Account} — {ProductLine} ({Quarter})", weight: 12 },
  { value: "{Account} — {SeatTier} {ProductLine}", weight: 10 },
  { value: "{Account} — {Initiative} — {Region}", weight: 8 },
  { value: "{Account} — {Department} {ProductLine} {Quarter}", weight: 7 },
  { value: "{Account} — {Motion}", weight: 5 },
];
export const INITIATIVE = [
  "Rollout", "Expansion", "Migration", "Adoption", "Modernization", "Consolidation", "Standardization",
  "Onboarding", "Pilot", "Deployment", "Implementation", "Upgrade", "Refresh", "Replatforming", "Integration",
  "Enablement", "Optimization", "Buildout",
] as const;
export const DEPARTMENT = [
  "RevOps", "Finance", "Sales", "Marketing", "IT", "Operations", "Customer Success", "Procurement",
  "Engineering", "Data & Analytics", "Support", "HR", "Field Service", "Supply Chain",
] as const;
export const MOTION = ["Net-New Platform", "Expansion", "Renewal", "Cross-Sell", "Upsell", "Land & Expand"] as const;
/**
 * v16: the {Motion} name token is now CONSTRAINED by Opportunity.Type (was drawn independently, so a "…
 * Renewal" opp could be typed New Business — a self-contradiction). Existing Business → only retain/grow
 * motions; New Business → only acquisition motions. The caller decides Type FIRST, then draws the motion from
 * motionsForType(type). "Land & Expand" is plausible under both (you land new, then expand) so it sits in both.
 */
export const MOTION_EXISTING = ["Renewal", "Expansion", "Upsell", "Cross-Sell", "Land & Expand"] as const;
export const MOTION_NEW = ["Net-New Platform", "Land & Expand"] as const;
export function motionsForType(type: string): readonly string[] {
  return type === "Existing Business" ? MOTION_EXISTING : MOTION_NEW;
}

/** Opportunity.Type — STANDARD stock value set (added to picklists.ts). Prior-won bias applied at the call site. */
export const OPP_TYPE_NEW: readonly WeightedValue[] = [
  { value: "New Business", weight: 85 }, { value: "Existing Business", weight: 15 },
];
export const OPP_TYPE_EXISTING: readonly WeightedValue[] = [
  { value: "Existing Business", weight: 70 }, { value: "New Business", weight: 30 },
];
/** Opportunity.LeadSource — STANDARD stock value set (added to picklists.ts; ⊆ the 5 universal members). */
export const OPP_LEADSOURCE: readonly WeightedValue[] = [
  { value: "Web", weight: 30 }, { value: "Partner Referral", weight: 22 }, { value: "Phone Inquiry", weight: 18 },
  { value: "Purchased List", weight: 15 }, { value: "Other", weight: 15 },
];
/** Opportunity.NextStep (free text) — open deals only, keyed by stage band; verb-led, specific. */
export const NEXTSTEP: Record<"early" | "mid" | "late", readonly string[]> = {
  early: ["Confirm discovery call", "Map current-state workflow", "Identify economic buyer", "Send capabilities deck", "Scope pilot success criteria"],
  mid: ["Schedule technical deep-dive", "Deliver security questionnaire", "Build the business case", "Align on rollout timeline", "Run reference call"],
  late: ["Route MSA to legal", "Confirm signature date", "Finalize seat count", "Get CFO sign-off on terms", "Lock implementation kickoff"],
};
/**
 * Opportunity.Description — v16 makes it COMBINATORIAL + stage-coherent (was 12 fixed strings across 202K).
 * buildOppDescription() draws a LEAD (the deal posture) + a TAIL (the open item / outcome) from the pools for
 * the deal's stage band, optionally splicing the deal's {ProductLine} or {Department}. won/lost have their own
 * outcome-shaped pools (so a closed deal doesn't read as "in legal"). ~6 leads × ~8 tails × stage × optional
 * product/dept token → thousands of distinct one-liners. 1 short sentence, free text.
 */
export const OPP_DESC_LEAD: Record<"open-early" | "open-mid" | "open-late" | "won" | "lost", readonly string[]> = {
  "open-early": ["Early-stage evaluation", "Net-new prospect exploring options", "Inbound interest, qualifying now", "Discovery underway", "Mapping fit and the buying group", "Top-of-funnel opportunity"],
  "open-mid": ["Active evaluation", "Multi-threaded deal in progress", "Mid-funnel opportunity", "Business case taking shape", "Technical fit confirmed", "Stakeholders aligning"],
  "open-late": ["Late-stage deal", "In final negotiation", "Verbal commitment in hand", "Terms nearly settled", "Papering the contract", "Down to the last open items"],
  won: ["Closed-won deal", "Won and booked", "Signed and in onboarding", "Landed account", "Closed this quarter"],
  lost: ["Closed-lost deal", "Lost to a competitor", "Stalled out and closed", "No-decision; shelved", "Disqualified late"],
};
export const OPP_DESC_TAIL: Record<"open-early" | "open-mid" | "open-late" | "won" | "lost", readonly string[]> = {
  "open-early": ["qualifying budget and timeline.", "mapping the current-state workflow.", "scoping pilot success criteria.", "identifying the economic buyer.", "gauging fit against the incumbent.", "exploring a platform consolidation.", "for the {Department} team.", "centered on {ProductLine}."],
  "open-mid": ["with a business case in progress.", "proposal scoped, pricing under review.", "running a technical deep-dive.", "building the ROI model.", "lining up a reference call.", "aligning the {Department} stakeholders.", "anchored on {ProductLine}.", "with seat count under discussion."],
  "open-late": ["in legal and procurement.", "settling seats and payment terms.", "with the MSA in redlines.", "awaiting CFO sign-off.", "locking the implementation kickoff.", "finalizing the {ProductLine} scope.", "with the {Department} approvals outstanding.", "on net-60 terms."],
  won: ["with {ProductLine} as the core line.", "expanding the {Department} footprint.", "after a competitive evaluation.", "on an annual term.", "with services attached.", "off the back of a successful pilot.", "as a multi-year commitment.", "with room to expand."],
  lost: ["on price.", "to an incumbent renewal.", "after the budget was pulled.", "on timing — revisit next year.", "when the champion left.", "over a missing {ProductLine} capability.", "after the {Department} reorg.", "with no clear decision."],
};
/** Stage band → the five-way OPP_DESC key (closed splits into won/lost at the call site via state). */
export function oppDescKey(band: "early" | "mid" | "late" | "closed", state: string): "open-early" | "open-mid" | "open-late" | "won" | "lost" {
  if (state === "won") return "won";
  if (state === "lost") return "lost";
  if (band === "early") return "open-early";
  if (band === "late") return "open-late";
  return "open-mid"; // mid, or a closed-but-not-won/lost fallback
}
/** Build a combinatorial Opportunity.Description, splicing the deal's product line + department. */
export function buildOppDescription(nr: Rng, key: ReturnType<typeof oppDescKey>, productLine: string, department: string): string {
  const lead = nr.pick(OPP_DESC_LEAD[key]);
  const tail = nr.pick(OPP_DESC_TAIL[key]);
  return collapse(`${lead}; ${tail}`.replace(/\{ProductLine\}/g, productLine).replace(/\{Department\}/g, department));
}

/** Product attach mix for bulk OLIs (License always present, line 0; these are the add-ons). Names mirror PRODUCTS. */
export const PRODUCT_ATTACH: readonly WeightedValue[] = [
  { value: "Premium Support", weight: 30 }, { value: "Onboarding & Implementation", weight: 24 },
  { value: "Advanced Analytics Module", weight: 20 }, { value: "API & Integrations", weight: 16 },
  { value: "Training & Enablement", weight: 12 }, { value: "Data Storage Expansion", weight: 8 },
  { value: "Sandbox Environment", weight: 6 },
];
/** Line-item count band by deal size — a $5k deal isn't 6 lines, a $2M deal isn't 1. */
export const BULK_LINE_COUNT: Record<string, [number, number]> = {
  LT10K: [1, 2], "10K_50K": [1, 2], "25K_50K": [2, 3], "50K_100K": [2, 3],
  "100K_250K": [3, 4], "250K_500K": [3, 4], "250K_1M": [3, 4], "500K_1M": [4, 6], GTE1M: [4, 6],
};

// ── Contact title matrix (department × seniority) ───────────────────────────────────────────────

/** TITLES_BY_DEPT — a department×seniority matrix (~90 real corporate titles) replacing the flat 12.
 *  Each department lists titles roughly senior→junior; the call site biases the first contact senior. */
export const TITLES_BY_DEPT: Record<string, readonly string[]> = {
  Executive: ["Chief Executive Officer", "President", "Chief Operating Officer", "Chief Financial Officer", "Chief Technology Officer", "Chief Information Officer", "Chief Revenue Officer", "Chief Marketing Officer", "Founder", "General Manager"],
  Sales: ["Chief Revenue Officer", "EVP, Sales", "SVP, Sales", "VP, Sales", "VP, Revenue Operations", "Senior Director, Sales", "Director, Account Management", "Director, Field Sales", "Senior Manager, Sales Enablement", "Manager, Field Sales", "Sales Operations Lead", "Account Executive"],
  Marketing: ["Chief Marketing Officer", "VP, Marketing", "VP, Demand Generation", "Senior Director, Brand", "Director, Product Marketing", "Senior Manager, Demand Generation", "Manager, Growth", "Head of Brand", "Marketing Operations Lead", "Senior Marketing Manager"],
  Finance: ["Chief Financial Officer", "VP, Finance", "SVP, Finance", "Senior Director, FP&A", "Director, Accounting", "Controller", "Director of Procurement", "Senior Manager, FP&A", "Treasury Manager", "Finance Manager"],
  Engineering: ["Chief Technology Officer", "VP, Engineering", "SVP, Engineering", "Senior Director, Platform Engineering", "Director, Platform Engineering", "Director, Infrastructure", "Head of Security", "Senior Engineering Manager", "Engineering Manager", "Lead Engineer"],
  IT: ["Chief Information Officer", "VP, IT", "Senior Director, IT", "Director, Infrastructure", "Head of Infrastructure", "Director, Information Security", "Senior IT Manager", "IT Manager", "Systems Lead"],
  Product: ["Chief Product Officer", "VP, Product", "Senior Director, Product Management", "Director, Product Management", "Head of UX", "Senior Product Manager", "Product Manager", "Design Lead"],
  Operations: ["Chief Operating Officer", "VP, Operations", "Senior Director, Business Operations", "Director, Operations", "VP, Supply Chain", "Director, Logistics", "Senior Operations Manager", "Operations Manager"],
  "Customer Success": ["VP, Customer Success", "Senior Director, Customer Success", "Director, Customer Success", "Head of Support", "Senior CSM", "Customer Success Manager", "Support Lead"],
  People: ["Chief People Officer", "VP, People", "Senior Director, Talent", "Director, HR", "Head of Talent", "Senior People Operations Manager", "HR Manager"],
  Data: ["VP, Data & Analytics", "Senior Director, Data", "Director, Data & Analytics", "Head of Data", "Senior Data Manager", "Analytics Lead", "Data Manager"],
};
/** Departments eligible for the FIRST (senior-biased) contact — executive + the GTM/finance/eng leads. */
export const SENIOR_DEPTS = ["Executive", "Finance", "Sales", "Engineering", "Operations"] as const;
export const ALL_DEPTS = Object.keys(TITLES_BY_DEPT);
/** C-level / president titles — a singular-role uniqueness set (one CEO/CFO/COO/etc. per account). */
const SINGULAR_TITLES = new Set([
  "Chief Executive Officer", "President", "Chief Operating Officer", "Chief Financial Officer",
  "Chief Technology Officer", "Chief Information Officer", "Chief Revenue Officer", "Chief Marketing Officer",
  "Chief Product Officer", "Chief People Officer", "Founder", "Controller",
]);
export function isSingularTitle(title: string): boolean {
  return SINGULAR_TITLES.has(title);
}
/** A contact's Department label from its Title — for the Contact.Department field. */
export function deptOfTitle(title: string): string {
  for (const [dept, titles] of Object.entries(TITLES_BY_DEPT)) {
    if (titles.includes(title)) return dept === "People" ? "Human Resources" : dept === "Data" ? "Data & Analytics" : dept;
  }
  return "General";
}
/** Contact.LeadSource — standard set (free here; not a guarded picklist in this pack). */
export const CONTACT_LEADSOURCE: readonly WeightedValue[] = [
  { value: "Web", weight: 32 }, { value: "Phone Inquiry", weight: 14 }, { value: "Partner Referral", weight: 16 },
  { value: "Trade Show", weight: 12 }, { value: "Employee Referral", weight: 10 }, { value: "Other", weight: 16 },
];

// ── Account standard-field pools ────────────────────────────────────────────────────────────────

export const STREET_NAMES = [
  "Market", "Main", "Oak", "Maple", "Park", "Industrial", "Commerce", "Innovation", "Tech", "Harbor",
  "Mill", "Bridge", "Union", "King", "Queen", "Lake", "River", "Hill", "Center", "Broad",
  "Franklin", "Lincoln", "Madison", "Jefferson", "Washington", "Enterprise", "Corporate", "Summit", "Vista", "Cedar",
] as const;
export const STREET_TYPES = ["St", "Ave", "Blvd", "Rd", "Way", "Dr", "Plaza", "Pkwy"] as const;
// (BillingState is now bound to the city via GEO_BY_REGION[].state — no independent region-scoped state pool,
//  which previously produced cross-country mismatches like "Île-de-France" on a Stockholm/Sweden address.)
export const ACCOUNT_SOURCE: readonly WeightedValue[] = [
  { value: "Web", weight: 26 }, { value: "Partner Referral", weight: 20 }, { value: "Trade Show", weight: 14 },
  { value: "Phone Inquiry", weight: 10 }, { value: "Word of mouth", weight: 14 }, { value: "Other", weight: 16 },
];
/**
 * Account.Description — v16 makes it genuinely COMBINATORIAL (was a 5-template Mad-Libs that read as ~5
 * recognizable sentences). LEAD (18 size/shape openers) × FOCUS (16 what-they-do clauses) × TAIL (18
 * what-they're-investing-in clauses), each with {industry}/{city} tokens → ~5,000 distinct frames before
 * the industry/city tokens multiply it further. The caller renders LEAD + FOCUS + TAIL. Free text.
 */
export const ACCT_DESC_LEAD = [
  "A {industry} company", "{industry} firm", "Mid-market {industry} organization", "{industry} business",
  "An established {industry} operator", "Growth-stage {industry} company", "A {industry} provider",
  "Regional {industry} group", "A privately held {industry} company", "An expanding {industry} business",
  "A {industry} enterprise", "Family-run {industry} operation", "A fast-scaling {industry} company",
  "Long-standing {industry} firm", "A {industry} services company", "An emerging {industry} player",
  "A specialized {industry} operator", "A {industry} concern",
] as const;
/** The middle clause — what the company does / how it operates. Drawn independently of LEAD/TAIL. */
export const ACCT_DESC_FOCUS = [
  "serving customers across the region", "with a national footprint", "operating across several markets",
  "with a growing customer base", "known for steady year-over-year growth", "with a lean operating team",
  "moving upmarket into enterprise accounts", "expanding beyond its home market", "with a multi-site operation",
  "running a high-volume operation", "with a distributed workforce", "scaling its commercial team",
  "navigating a competitive market", "with a strong regional reputation", "modernizing a legacy operating model",
  "balancing growth with margin discipline",
] as const;
export const ACCT_DESC_TAIL = [
  "headquartered in {city}, modernizing its internal data and operations stack.",
  "based in {city}, consolidating tooling across go-to-market teams.",
  "in {city}, scaling its analytics and reporting capability.",
  "operating out of {city}, standardizing platforms across the org.",
  "in {city}, investing in integration and data infrastructure.",
  "headquartered in {city}, evaluating a platform to unify back-office workflows.",
  "out of {city}, replacing spreadsheets with a system of record.",
  "based in {city}, tightening its forecasting and pipeline visibility.",
  "in {city}, automating manual reporting that eats its team's week.",
  "headquartered in {city}, unifying customer data across disconnected systems.",
  "in {city}, rolling out self-serve analytics to its business teams.",
  "operating from {city}, cleaning up a fragmented tooling landscape.",
  "based in {city}, building a single source of truth for revenue data.",
  "in {city}, investing in operational tooling ahead of its next growth phase.",
  "headquartered in {city}, migrating off a brittle legacy back office.",
  "in {city}, standardizing how its teams measure and report performance.",
  "out of {city}, shoring up data governance across departments.",
  "based in {city}, modernizing finance and operations workflows.",
] as const;

// ── Phone dial codes (v16) ───────────────────────────────────────────────────────────────────────
// Account.Phone + Contact.Phone were always "+1 NNN-NNN-NNNN" regardless of BillingCountry — a +1 number on a
// Munich/Germany account is a per-record tell. COUNTRY_DIAL maps every GEO_BY_REGION country to its E.164 dial
// code + a national grouping (digit-block sizes the subscriber number splits into). bulkPhone() builds the
// number from the account's geo.country; Contact.Phone inherits the account's dial code. All values are FREE
// text (Phone is not a restricted picklist) — the only contract is a country-coherent leading code.
export const COUNTRY_DIAL: Record<string, { code: string; groups: readonly number[] }> = {
  "United States": { code: "+1", groups: [3, 3, 4] }, Canada: { code: "+1", groups: [3, 3, 4] },
  Mexico: { code: "+52", groups: [2, 4, 4] }, "United Kingdom": { code: "+44", groups: [2, 4, 4] },
  Germany: { code: "+49", groups: [3, 3, 4] }, France: { code: "+33", groups: [1, 2, 2, 2, 2] },
  Netherlands: { code: "+31", groups: [2, 3, 4] }, Ireland: { code: "+353", groups: [2, 3, 4] },
  Sweden: { code: "+46", groups: [2, 3, 3] }, Spain: { code: "+34", groups: [3, 3, 3] },
  Italy: { code: "+39", groups: [3, 3, 4] }, Denmark: { code: "+45", groups: [2, 2, 2, 2] },
  Norway: { code: "+47", groups: [3, 2, 3] }, Finland: { code: "+358", groups: [2, 3, 4] },
  Switzerland: { code: "+41", groups: [2, 3, 2, 2] }, Austria: { code: "+43", groups: [3, 3, 4] },
  Belgium: { code: "+32", groups: [3, 2, 2, 2] }, Portugal: { code: "+351", groups: [3, 3, 3] },
  Poland: { code: "+48", groups: [3, 3, 3] }, Czechia: { code: "+420", groups: [3, 3, 3] },
  Israel: { code: "+972", groups: [2, 3, 4] }, "South Africa": { code: "+27", groups: [2, 3, 4] },
  Australia: { code: "+61", groups: [1, 4, 4] }, Singapore: { code: "+65", groups: [4, 4] },
  India: { code: "+91", groups: [5, 5] }, Japan: { code: "+81", groups: [2, 4, 4] },
  "Korea, Republic of": { code: "+82", groups: [2, 4, 4] }, Taiwan: { code: "+886", groups: [4, 4] },
  China: { code: "+86", groups: [3, 4, 4] }, Indonesia: { code: "+62", groups: [3, 4, 4] },
  Philippines: { code: "+63", groups: [3, 3, 4] }, Malaysia: { code: "+60", groups: [2, 4, 4] },
  Thailand: { code: "+66", groups: [1, 4, 4] }, "New Zealand": { code: "+64", groups: [1, 3, 4] },
};
const DIAL_DEFAULT = { code: "+1", groups: [3, 3, 4] as readonly number[] };

/** Build a country-coherent phone number from a seeded Rng + a BillingCountry. e.g. "+49 152-863-4471". */
export function bulkPhone(r: Rng, country: string): string {
  const dial = COUNTRY_DIAL[country] ?? DIAL_DEFAULT;
  const blocks = dial.groups.map((len) => {
    const max = Math.pow(10, len) - 1;
    return String(r.int(len <= 1 ? 1 : Math.pow(10, len - 1), max));
  });
  return `${dial.code} ${blocks.join("-")}`;
}

// ── Activity (Task / Event) slot pools ──────────────────────────────────────────────────────────

const CHANNEL: readonly WeightedValue[] = [
  { value: "Call", weight: 35 }, { value: "Email", weight: 30 }, { value: "LinkedIn", weight: 8 },
  { value: "Text", weight: 7 }, { value: "Voicemail", weight: 8 }, { value: "", weight: 12 },
];
type Intent = "outbound" | "inbound" | "schedule" | "send" | "prep" | "log" | "chase";
const VERB_BY_INTENT: Record<Intent, readonly string[]> = {
  outbound: ["Followed up on", "Reached out re", "Touched base on", "Circled back on", "Chased", "Nudged on"],
  inbound: ["Replied to", "Answered", "Responded to", "Fielded question on"],
  schedule: ["Scheduled", "Booked", "Set up", "Confirmed timing for", "Pinned down"],
  send: ["Sent", "Shared", "Forwarded", "Pushed over", "Routed"],
  prep: ["Prepped", "Pulled together", "Drafted", "Reviewed", "Built out"],
  log: ["Logged", "Noted", "Left", "Captured", "Recorded"],
  chase: ["Following up on", "Waiting on", "Chasing", "Checking status of", "Pinging on"],
};
const OBJECT_BY_STAGE: Record<string, readonly string[]> = {
  Prospecting: ["intro deck", "fit overview", "company background", "initial outreach", "cold follow-up", "quick intro call ask", "relevant case study"],
  Qualification: ["budget + timeline", "use-case fit", "current tooling", "pain points", "decision process", "authority chain", "qualifying questions"],
  "Needs Analysis": ["requirements doc", "current-state workflow", "integration list", "data-volume sizing", "success criteria", "stakeholder map", "gap analysis"],
  "Value Proposition": ["ROI model", "value framing", "exec one-pager", "comparison vs incumbent", "business case", "cost-of-inaction math"],
  "Id. Decision Makers": ["approver list", "procurement contact", "exec sponsor intro", "sign-off chain", "org chart", "champion's manager"],
  "Perception Analysis": ["competitive concerns", "internal pushback", "reference call", "risk objections", "skeptic's questions", "trial feedback"],
  "Proposal/Price Quote": ["proposal", "pricing breakdown", "quote revision", "contract draft", "order form", "discount approval", "line-item scope"],
  "Negotiation/Review": ["redlines", "legal review", "payment terms", "MSA edits", "final pricing", "security questionnaire", "procurement form", "DPA"],
  GENERIC: ["next steps", "open items", "the thread", "the account", "this deal", "the eval"],
};
const CONTEXT: readonly WeightedValue[] = [
  { value: "", weight: 40 }, { value: "with {Contact}", weight: 18 }, { value: "— left vm", weight: 6 },
  { value: "— no response yet", weight: 6 }, { value: "before EOW", weight: 5 }, { value: "per their ask", weight: 5 },
  { value: "ahead of demo", weight: 5 }, { value: "post-call", weight: 5 }, { value: "for {Contact}", weight: 6 },
];
/** Stage → weighted intent-class mix (early stages favor outbound/schedule/send/prep; late favor send/chase/log). */
const INTENT_BY_STAGE: Record<"early" | "mid" | "late" | "closed", readonly WeightedValue[]> = {
  early: [{ value: "outbound", weight: 30 }, { value: "schedule", weight: 22 }, { value: "send", weight: 18 }, { value: "prep", weight: 18 }, { value: "log", weight: 12 }],
  mid: [{ value: "send", weight: 26 }, { value: "prep", weight: 22 }, { value: "inbound", weight: 18 }, { value: "outbound", weight: 16 }, { value: "log", weight: 18 }],
  late: [{ value: "send", weight: 24 }, { value: "chase", weight: 24 }, { value: "inbound", weight: 18 }, { value: "log", weight: 18 }, { value: "prep", weight: 16 }],
  closed: [{ value: "log", weight: 40 }, { value: "send", weight: 20 }, { value: "outbound", weight: 20 }, { value: "inbound", weight: 20 }],
};
// v16: openers PARTITIONED by channel compatibility (was one mixed pool, which stapled spoken phrases like
// "Short call, ran late." onto an "Email:" subject — a per-record self-contradiction). bulkTaskDescription
// picks ONLY from the set matching the subject's drawn channel: spoken (Call/Voicemail), written
// (Email/Text/LinkedIn), or agnostic (no channel). No email/text/linkedin subject can carry a call/voicemail
// body and vice-versa. The {channel} token (e.g. "Good {channel} today.") only appears in sets where it
// resolves to a real medium label. The agnostic set + the shared tail are channel-neutral by construction.
const OPENER_SPOKEN: readonly WeightedValue[] = [
  { value: "Quick {channel} with {Contact}.", weight: 12 }, { value: "Good {channel} today.", weight: 8 },
  { value: "Left a message for {Contact}.", weight: 8 }, { value: "No answer — will retry.", weight: 7 },
  { value: "Caught {Contact} between meetings.", weight: 7 }, { value: "Short call, ran late.", weight: 6 },
  { value: "{Contact} picked up.", weight: 6 }, { value: "", weight: 16 },
];
const OPENER_WRITTEN: readonly WeightedValue[] = [
  { value: "Quick {channel} to {Contact}.", weight: 12 }, { value: "{Contact} replied.", weight: 9 },
  { value: "Sent and waiting on {Contact}.", weight: 8 }, { value: "{Contact} got back to me.", weight: 8 },
  { value: "Dropped {Contact} a note.", weight: 6 }, { value: "No reply yet.", weight: 6 },
  { value: "{Contact} looped in their team.", weight: 6 }, { value: "", weight: 16 },
];
const OPENER_AGNOSTIC: readonly WeightedValue[] = [
  { value: "Connected with {Contact}.", weight: 12 }, { value: "Picked back up where we left off.", weight: 9 },
  { value: "{Contact} got back to me.", weight: 8 }, { value: "They reached out first.", weight: 7 },
  { value: "Touched base with {Contact}.", weight: 7 }, { value: "{Contact} looped in their team.", weight: 6 },
  { value: "", weight: 20 },
];
/** The opener set compatible with a drawn channel ("" / Voicemail map to spoken/agnostic appropriately). */
function openersFor(channel: string): readonly WeightedValue[] {
  if (channel === "Call" || channel === "Voicemail") return OPENER_SPOKEN;
  if (channel === "Email" || channel === "Text" || channel === "LinkedIn") return OPENER_WRITTEN;
  return OPENER_AGNOSTIC; // channel === "" → medium-neutral phrasing only
}
const CORE_BY_STAGE: Record<string, readonly string[]> = {
  Prospecting: ["Still early — gauging whether there's a real need.", "Asked for 20 min next week to walk through fit.", "Sounds like they're just starting to look.", "Not a priority this quarter but worth nurturing.", "Wants the intro deck before committing to a call."],
  Qualification: ["Budget looks real, timeline is Q3.", "No budget allocated yet — champion is building the case.", "Confirmed they're actively evaluating two vendors.", "Decision sits with their VP, not my contact.", "Pain is around manual reporting eating their week."],
  "Needs Analysis": ["Walked their current workflow — three manual handoffs we'd remove.", "They need the Salesforce + Slack integrations on day one.", "Sizing came back bigger than I scoped — ~400 seats.", "Success = cutting onboarding time in half by EOY.", "Mapped requirements; one gap on SSO we need to confirm."],
  "Value Proposition": ["Built the ROI case — payback inside 8 months.", "Exec wants a one-pager before the next meeting.", "They're weighing us against staying on the incumbent.", "Cost of doing nothing is the angle that landed.", "Champion gets the value; now selling it upstairs."],
  "Id. Decision Makers": ["Finally got the name of the economic buyer.", "Procurement gets involved above $50K — flagged early.", "Champion offered to intro their manager next week.", "Sign-off chain is longer than expected — three approvers.", "Need an exec sponsor or this stalls in committee."],
  "Perception Analysis": ["Skeptic on their side wants a reference call.", "Pushback on switching cost — addressing head-on.", "Trial feedback was mostly positive, two nits.", "They're nervous about the migration lift.", "Competitor planted FUD about our uptime — handling it."],
  "Proposal/Price Quote": ["Sent the proposal — walking them through it Thursday.", "They pushed back on price; floated a 10% bump in seats instead.", "Quote revised to match their fiscal-year start.", "Waiting on their procurement form to finalize.", "Scope is set; just the discount approval outstanding."],
  "Negotiation/Review": ["Legal is in — redlines back by Friday.", "Down to payment terms; they want net-60.", "Security questionnaire done, one follow-up on data residency.", "MSA mostly agreed; DPA is the last open item.", "Verbal yes — just papering it now."],
  GENERIC: ["Keeping it warm.", "Holding pattern until they're back from the offsite.", "Reconfirmed where things stand.", "Nothing new — touching base.", "Logged for the record."],
};
const NEXTVERB = ["follow up", "send", "schedule", "loop in", "get", "confirm", "push for", "circle back"] as const;
const NEXTTARGET_GENERIC = ["a call", "their decision", "an answer", "the quote", "sign-off", "the demo"] as const;
const EVENT_TYPE: readonly WeightedValue[] = [
  { value: "Discovery call", weight: 16 }, { value: "Demo", weight: 18 }, { value: "Technical deep-dive", weight: 12 },
  { value: "Pricing review", weight: 10 }, { value: "Proposal walkthrough", weight: 9 }, { value: "Exec alignment", weight: 7 },
  { value: "Working session", weight: 8 }, { value: "Check-in", weight: 8 }, { value: "QBR", weight: 5 }, { value: "Kickoff", weight: 7 },
];
/** Event types that only make sense post-sale — gated to won opps. */
export const POST_SALE_EVENT_TYPES = new Set(["QBR", "Kickoff"]);
const EVENT_FORMAT: readonly WeightedValue[] = [
  { value: "", weight: 40 }, { value: " (Zoom)", weight: 18 }, { value: " (Teams)", weight: 12 },
  { value: " — onsite", weight: 8 }, { value: " (call)", weight: 12 }, { value: " — follow-up", weight: 10 },
];
const EVENT_PARTY: readonly WeightedValue[] = [
  { value: "", weight: 50 }, { value: " w/ {Contact}", weight: 22 }, { value: " w/ {Contact} + team", weight: 10 },
  { value: " w/ procurement", weight: 6 }, { value: " w/ their VP", weight: 6 }, { value: " w/ champion", weight: 6 },
];

const stageObjects = (stage: string): readonly string[] => OBJECT_BY_STAGE[stage] ?? OBJECT_BY_STAGE.GENERIC!;
const stageCore = (stage: string): readonly string[] => CORE_BY_STAGE[stage] ?? CORE_BY_STAGE.GENERIC!;
const sub = (s: string, contact: string): string => s.replace(/\{Contact\}/g, contact);
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * bulkTaskSubject — stage-aware logged-activity Subject. Returns BOTH the rendered subject and the drawn
 * channel (so the matching description can reuse the same medium). ~20K+ distinct subjects across stages.
 */
export function bulkTaskSubject(br: Rng, stage: string, contactFirstName: string): { subject: string; channel: string } {
  const band = stageBand(stage);
  const intent = br.weighted(INTENT_BY_STAGE[band]) as Intent;
  const verb = br.pick(VERB_BY_INTENT[intent]);
  const channel = br.weighted(CHANNEL);
  const object = br.bool(0.8) ? br.pick(stageObjects(stage)) : br.pick(OBJECT_BY_STAGE.GENERIC!);
  const context = sub(br.weighted(CONTEXT), contactFirstName);
  const prefix = channel ? `${channel}: ` : "";
  const subject = collapse(`${prefix}${verb} ${object} ${context}`);
  return { subject: subject.slice(0, 120), channel };
}

// v23: attributed buyer QUOTES — what the champion actually SAID, recorded in a logged-call note. A quote with
// a name attached ("Dana said '…'") is the single most real-looking line in a CRM: it forces a name + a stance
// + (often) a number/date all at once. Grounded in the deal's money/quarter/product (voice.md: specific =
// numbers + names + dates); gated to SPOKEN channels (a Call is where you'd quote someone — a written note
// paraphrases). The quote is the BUYER's voice; the rep's note frames it.
const BULK_QUOTE_BY_STAGE: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: [
    "the current setup isn't scaling and it's starting to hurt",
    "I need to see ROI before I can take this upstairs",
    "we've outgrown what we have — that's what's driving this",
    "send me something I can walk my boss through",
    "honestly we're just starting to look, but it's a real priority",
  ],
  mid: [
    "the {money} is more than we'd budgeted — can we phase it",
    "integration with our stack is the thing I'm worried about",
    "my technical lead has to sign off before we go further",
    "if it does what you showed us, we're in",
    "I need {product} live before {quarter}",
  ],
  late: [
    "legal's got the redlines — otherwise we're there",
    "the {money} works if the terms hold",
    "my VP is on board; it's down to procurement now",
    "give me through {quarter} and I'll have sign-off",
    "we can move as soon as the security review clears",
  ],
  closed: [
    "the team's genuinely excited to get going",
    "let's get the {product} kickoff on the calendar",
    "this was smoother than I expected",
    "we'll want one main point of contact for the {product} rollout",
    "we're happy with where the {money} landed",
  ],
};
/** The rep's framing around a verbatim buyer quote (attribution + the quoted line). */
const QUOTE_ATTRIB: readonly string[] = [
  '{Contact} said "{q}."',
  '{Contact}: "{q}."',
  '{Contact} was clear — "{q}."',
  'Per {Contact}: "{q}."',
  'Got a strong signal — {Contact}: "{q}."',
];
// Spoken openers that imply a conversation ACTUALLY happened — the only ones a verbatim quote can follow (the
// no-answer/left-a-message openers in OPENER_SPOKEN would contradict "and then they said …").
const OPENER_SPOKEN_CONNECTED: readonly WeightedValue[] = [
  { value: "Quick {channel} with {Contact}.", weight: 14 }, { value: "Good {channel} today.", weight: 10 },
  { value: "Caught {Contact} between meetings.", weight: 9 }, { value: "Short call, ran late.", weight: 7 },
  { value: "{Contact} picked up.", weight: 8 }, { value: "", weight: 18 },
];

/** bulkTaskDescription — 1–3 sentence rep-voice note body; channel comes from the matching subject draw.
 *  The opener is drawn from the set that AGREES with `channel` (spoken/written/agnostic) so an "Email:"
 *  subject never gets a "Short call, ran late." body (and vice-versa). On a SPOKEN channel the core is often
 *  a verbatim, ATTRIBUTED buyer quote grounded in the deal (`facts`) — the highest-fidelity realism beat. */
export function bulkTaskDescription(br: Rng, stage: string, contactFirstName: string, channel: string, facts: CopyFacts): string {
  const chLabel = channel ? (channel === "LinkedIn" ? "linkedin message" : channel.toLowerCase()) : "note";
  // A verbatim quote only follows a real conversation → gate to Call + a conversation-happened opener.
  const quoting = channel === "Call" && br.bool(0.6);
  const opener = sub(br.weighted(quoting ? OPENER_SPOKEN_CONNECTED : openersFor(channel)).replace(/\{channel\}/g, chLabel), contactFirstName);
  let core: string;
  if (quoting) {
    // A logged call → record what they actually said, attributed, grounded in the deal's numbers.
    const q = subTok(br.pick(BULK_QUOTE_BY_STAGE[stageBand(stage)]), { money: facts.money, quarter: facts.quarter, product: facts.product, account: facts.account });
    core = subTok(br.pick(QUOTE_ATTRIB), { Contact: contactFirstName, q });
  } else {
    core = br.bool(0.85) ? br.pick(stageCore(stage)) : br.pick(CORE_BY_STAGE.GENERIC!);
  }
  let next = "";
  if (br.bool(0.65)) {
    const targets = [...stageObjects(stage), ...NEXTTARGET_GENERIC];
    next = ` Next: ${br.pick(NEXTVERB)} ${br.pick(targets)}.`;
  }
  return collapse(`${opener} ${core}${next}`);
}

/** bulkEventSubject — stage-aware meeting Subject; post-sale types (QBR/Kickoff) are filtered out unless `won`. */
export function bulkEventSubject(br: Rng, stage: string, contactFirstName: string, won: boolean): string {
  const types = won ? EVENT_TYPE : EVENT_TYPE.filter((t) => !POST_SALE_EVENT_TYPES.has(t.value));
  const type = br.weighted(types);
  const focus = br.bool(0.4) ? `: ${br.pick(stageObjects(stage))}` : "";
  const format = br.weighted(EVENT_FORMAT);
  const party = sub(br.weighted(EVENT_PARTY), contactFirstName);
  return collapse(`${type}${focus}${format}${party}`);
}

// ── Support content (Case / CaseComment / Asset) slot pools ─────────────────────────────────────

// v16: `component` is stored WITHOUT a leading article ("SAML login flow", not "the SAML login flow"). The
// old article-prefixed values produced "their the SAML login flow" / "the the cohort builder" wherever a
// template already supplied an article (DESC_SECOND "after their {component}", CC_FINDINGS "stale token in
// {component}", etc.). Every template now supplies exactly one article before {component}; fillSupport
// splices the bare noun. Grepping the rendered corpus for "the the"/"their the" must come back empty.
export const CASE_AREAS = [
  { key: "auth", label: "SSO / authentication", component: "SAML login flow" },
  { key: "sync", label: "data sync", component: "nightly sync job" },
  { key: "reports", label: "reporting & exports", component: "scheduled report export" },
  { key: "api", label: "API & integrations", component: "REST ingest endpoint" },
  { key: "perf", label: "performance", component: "dashboard load" },
  { key: "billing", label: "billing & licensing", component: "seat / usage meter" },
  { key: "provision", label: "user provisioning", component: "SCIM provisioning bridge" },
  { key: "perms", label: "permissions & sharing", component: "role-based access rules" },
  { key: "storage", label: "data storage", component: "warehouse connector" },
  { key: "analytics", label: "analytics module", component: "cohort builder" },
  { key: "ui", label: "UI / web app", component: "saved-view editor" },
  { key: "mobile", label: "mobile app", component: "offline cache" },
  { key: "webhook", label: "webhooks & notifications", component: "outbound webhook queue" },
  { key: "import", label: "data import", component: "CSV bulk loader" },
] as const;
export const CASE_SYMPTOMS = [
  "Intermittent failures", "Timeout", "Stuck in pending", "Returns 500", "Silently dropping records",
  "Slow response", "Not respecting filters", "Duplicate records created", "Missing rows",
  "Auth token rejected", "Wrong totals", "Stale data", "Blank screen", "Rate-limit hit",
  "Permission denied", "Export never completes", "Mismatched counts", "Job ran but no output",
] as const;
export const CASE_SUBSURFACE_BY_AREA: Record<string, readonly string[]> = {
  auth: ["after the 9.4 upgrade", "for SCIM-provisioned users", "on the IdP-initiated path", "for the contractor group"],
  sync: ["on the nightly delta run", "for the EU region", "after the connector reauth", "on the Salesforce source"],
  reports: ["on scheduled exports over 50k rows", "for the pipeline dashboard", "to the SFTP drop", "in the PDF renderer"],
  api: ["on the /v2/ingest endpoint", "under burst load", "for the OAuth client-credentials grant", "on paginated pulls"],
  perf: ["on the exec dashboard", "during 9am peak", "for accounts over 2M rows", "after the storage expansion"],
  billing: ["on the seat count", "for the annual true-up", "after a mid-term upgrade", "on the usage meter"],
  provision: ["for new hires", "on deprovisioning", "for the bulk import", "against the HR feed"],
  perms: ["after a role change", "for the regional teams", "on shared records", "for the read-only group"],
  storage: ["on the warehouse sync", "after the expansion", "for archived data", "on the nightly snapshot"],
  analytics: ["in the cohort builder", "on custom metrics", "for large date ranges", "after a schema change"],
  ui: ["in the saved-view editor", "on the dashboard grid", "after the last release", "in Safari only"],
  mobile: ["on the offline cache", "for Android users", "after a background sync", "on first launch"],
  webhook: ["on the outbound queue", "for the order events", "after a payload change", "under retry storms"],
  import: ["on the CSV bulk loader", "for files over 100MB", "with non-UTF8 encoding", "on the column mapping"],
};
export const CASE_QUALIFIERS = [
  "blocking go-live", "started Monday", "affecting ~40 users", "only in production", "since the last release",
  "first reported by their admin", "reproducible every time", "intermittent", "during business hours", "ahead of their QBR",
] as const;
export const DESC_OPENERS = [
  "Customer reports that", "Their admin flagged that", "Logged via the portal:", "Came in on the support line —",
  "{reporter} wrote in that", "Account team escalated:", "Reported during onboarding that", "Raised in the QBR that",
  "Customer's IT team noticed", "Ticket opened because",
] as const;
export const DESC_DETAILS_BY_AREA: Record<string, readonly string[]> = {
  auth: ["users get bounced back to the login page", "the SAML assertion is being rejected", "MFA prompts loop indefinitely"],
  sync: ["records from the source aren't appearing for 6+ hours", "the delta sync shows zero rows", "the connector status reads 'degraded'"],
  reports: ["the export download link 404s", "row counts don't match the live view", "the scheduled email never arrived"],
  api: ["calls return 429 under load", "the ingest endpoint times out", "OAuth tokens expire prematurely"],
  perf: ["the dashboard takes 40s to load", "queries time out at peak", "the page hangs on first paint"],
  billing: ["the seat count is off by a dozen", "the true-up invoice double-counts", "usage isn't metering"],
  provision: ["new users aren't being created", "deprovisioned users still have access", "the SCIM sync stalled"],
  perms: ["users see records they shouldn't", "the sharing rule isn't applying", "a role change didn't propagate"],
  storage: ["the warehouse connector dropped", "archived data isn't queryable", "the snapshot failed overnight"],
  analytics: ["the cohort numbers are wrong", "a custom metric returns null", "the chart won't render"],
  ui: ["saved views won't load", "the editor freezes on save", "the grid renders blank"],
  mobile: ["the app crashes on launch", "offline edits aren't syncing", "push notifications stopped"],
  webhook: ["webhooks are firing twice", "the queue is backed up", "callbacks are timing out"],
  import: ["the import rejects valid rows", "the column mapping resets", "large files never finish"],
};
export const DESC_SECOND = [
  "They've already tried clearing the cache and reauthing.", "It started after their {component} change last week.",
  "About {n} users are affected.", "Severity is high — this is blocking their {area} workflow.",
  "Works fine in sandbox but not in production.", "No error in the UI, only in the logs.",
  "Their admin has a HAR file ready if needed.", "Intermittent — happens roughly every third attempt.",
  "Repro steps attached.", "Wants a callback before 5pm their time.", "Asked whether other tenants are affected.",
  "First occurrence; no prior history on this {area}.",
] as const;
export const CC_AGENTS = ["Priya", "Marcus", "Dana", "Tariq", "Elena", "Sam", "Noah", "Wei", "Ola", "Greg"] as const;
export const CC_TRIAGE_OPENERS = [
  "Picked this up.", "Took a look.", "Reproduced on our side.", "Dug into the logs.", "Pulled the trace for this.",
  "Checked the {component}.", "Confirmed the behavior.", "Looked at the affected account.", "Reviewed the HAR file.",
  "Ran this down.", "Grabbed the request IDs.", "Started on this.",
] as const;
export const CC_FINDINGS = [
  "Root cause is a stale token in the {component}", "the {component} is throttling above ~200 req/s",
  "a config drift on their tenant — the {area} flag was off", "the upgrade reset their custom mapping on the {component}",
  "a timezone offset is shifting the {area} window", "their IdP is sending an unexpected NameID format",
  "the delta cursor on the {component} was stuck on a poison record", "a connection-pool exhaustion under peak load",
  "the export job hit the 10-minute timeout on a large dataset", "a permission set was missing the {area} object",
  "a duplicate webhook subscription firing twice", "the SCIM payload is missing the email attribute",
  "the cache wasn't invalidating after their schema change", "a regression in 9.4 affecting the {component}",
  "their firewall is dropping our callback IPs", "the seat count was double-billed on the mid-term upgrade",
  "a malformed CSV header on the import", "the report query is doing a full scan without the index",
  "rate-limit headers weren't being honored by their client", "a clock-skew between their gateway and our auth service",
] as const;
export const CC_AGENT_ACTIONS = [
  "Pushed a config fix and asked them to retest.", "Bumped their rate limit to unblock.", "Cleared the stuck cursor and re-ran the sync.",
  "Filed ENG-{n} and tagged it P2.", "Applied the hotfix to their tenant.", "Re-issued the token and confirmed login.",
  "Walked their admin through the remap on a screen-share.", "Re-ran the export off-peak; completed clean.",
  "Restored the missing permission set.", "Disabled the duplicate webhook.", "Added the index; query dropped to under 2s.",
  "Sent them the corrected SCIM mapping.", "Whitelisted our callback range with their network team.",
  "Issued a credit for the double-billed seats.", "Provided a workaround while ENG ships the fix.", "Rolled their tenant back to 9.3 pending the patch.",
] as const;
export const CC_WAITING = [
  "Waiting on the customer to retest.", "Asked {reporter} for the request IDs from this morning.",
  "Pending a maintenance window on their side.", "Escalated to ENG — tracking under ENG-{n}.",
  "Need their admin to confirm the change landed.", "Holding for the next release ({rel}) which carries the fix.",
  "Requested a fresh HAR; theirs had expired.", "Looped in their CSM on the timeline.",
  "Asked them to confirm whether sandbox shows the same.", "Awaiting approval from their security team to whitelist us.",
  "Following up — no response in 48h.", "Scheduled a call for tomorrow to walk through it.",
] as const;
export const CC_RESOLUTION = [
  "Fix confirmed by {reporter}; closing this out.", "Customer verified it's working now. Resolved.",
  "Confirmed clean for 48h, no recurrence. Closing.", "{reporter} signed off. Marking resolved.",
  "Shipped in {rel}; verified on their tenant. Closed.", "Workaround accepted; permanent fix tracked in ENG-{n}. Closing the ticket.",
  "Re-ran end to end, all green. Resolved with {reporter}.", "Credit applied and acknowledged. Closing.",
  "No further reports since the fix. Auto-closing.", "Their admin confirmed across all affected users. Resolved.",
  "Root cause documented in the KB; closing.", "Validated in production and sandbox. Done.",
  "{reporter} happy with the outcome. Closed.", "Issue not reproducible after the patch. Resolving.",
] as const;
export const CC_CUSTOMER_REPLIES = [
  "Thanks — retesting now.", "Confirmed on our end, looks good.", "Still seeing it intermittently, sending a new trace.",
  "When's the next maintenance window?", "Can you also check whether QA is affected?", "Appreciate the quick turnaround.",
  "We'll need security sign-off before whitelisting.", "That worked — thank you!", "Any ETA on the permanent fix?",
  "Reopening — it came back this morning.",
] as const;
export const ASSET_EDITIONS = ["Enterprise", "Business", "Professional", "Team", "Standard", "Premier"] as const;
export const ASSET_TERMS: readonly WeightedValue[] = [
  { value: "Annual", weight: 40 }, { value: "3-Year", weight: 25 }, { value: "Multi-Year", weight: 20 },
  { value: "Monthly", weight: 10 }, { value: "Perpetual", weight: 5 },
];

/** Token-splice helper (no RNG) — fills {component}/{area}/{reporter}/{n}/{rel}/ENG-{n} from per-record ctx. */
export interface SupportCtx {
  component: string;
  area: string;
  reporter: string;
  n: number;
  rel: string;
  eng: number;
}
export function fillSupport(s: string, ctx: SupportCtx): string {
  return s
    .replace(/ENG-\{n\}/g, `ENG-${ctx.eng}`)
    .replace(/\{component\}/g, ctx.component)
    .replace(/\{area\}/g, ctx.area)
    .replace(/\{reporter\}/g, ctx.reporter)
    .replace(/\{n\}/g, String(ctx.n))
    .replace(/\{rel\}/g, ctx.rel);
}

/**
 * v16: a Case is ONE coherent problem. The symptom, subsurface, customer-facing detail, and the agent's
 * root-cause FINDING are drawn ONCE into a CaseScene at the call site, then threaded into the Subject, the
 * Description, AND the comment thread — so the subject can't staple "Export never completes" onto a "429 under
 * load" description, and the thread can't mix four unrelated fixes. Was: three functions each independently
 * `sup.pick(CASE_SYMPTOMS)` / `sup.pick(CC_FINDINGS)`.
 */
export interface CaseScene {
  area: (typeof CASE_AREAS)[number];
  symptom: string;
  subsurface: string;
  detail: string;
  finding: string;
}
export function buildCaseScene(sup: Rng, area: (typeof CASE_AREAS)[number]): CaseScene {
  return {
    area,
    symptom: sup.pick(CASE_SYMPTOMS),
    subsurface: sup.pick(CASE_SUBSURFACE_BY_AREA[area.key] ?? ["on " + area.label]),
    detail: sup.pick(DESC_DETAILS_BY_AREA[area.key] ?? ["the issue persists"]),
    finding: sup.pick(CC_FINDINGS), // the SINGLE root cause the whole thread converges on
  };
}

/** Render the Case Subject from the scene (the symptom + subsurface the description + comments also use). */
export function bulkCaseSubject(sup: Rng, scene: CaseScene): string {
  const qualifier = sup.bool(0.45) ? ` — ${sup.pick(CASE_QUALIFIERS)}` : "";
  return collapse(`${scene.symptom} ${scene.subsurface}${qualifier}`).slice(0, 240);
}

/** Render the Case Description from the SAME scene (subject↔description share symptom+detail → one problem). */
export function bulkCaseDescription(sup: Rng, scene: CaseScene, ctx: SupportCtx): string {
  const opener = sup.pick(DESC_OPENERS);
  const first = fillSupport(`${opener} ${scene.symptom.charAt(0).toLowerCase() + scene.symptom.slice(1)} — ${scene.detail}.`, ctx);
  const second = sup.bool(0.55) ? " " + fillSupport(sup.pick(DESC_SECOND), ctx) : "";
  return collapse(`${first}${second}`);
}

/**
 * Build a Case's CaseComment thread (1–4 comments) coherent with its status AND its scene. The triage comment
 * states the scene's SINGLE finding (the root cause), and every later turn stays on that one issue — the thread
 * converges instead of mixing CSV-header / version-rollback / DB-index / billing fixes. A CLOSED case ALWAYS
 * terminates on a resolution line (last turn forced to CC_RESOLUTION when status === "Closed").
 */
export function caseCommentThread(sup: Rng, status: string, ctx: SupportCtx, scene: CaseScene): string[] {
  const n = sup.int(1, status === "New" ? 2 : 4);
  const threadAgent = sup.pick(CC_AGENTS);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const agent = sup.bool(0.6) ? threadAgent : sup.pick(CC_AGENTS);
    const last = i === n - 1;
    let body: string;
    if (i === 0) {
      // Triage names the ONE root cause for the whole thread (scene.finding), not a fresh independent pick.
      body = `${agent}: ${fillSupport(sup.pick(CC_TRIAGE_OPENERS), ctx)} ${fillSupport(`Looks like ${scene.finding}.`, ctx)} ${fillSupport(sup.pick(CC_AGENT_ACTIONS), ctx)}`;
    } else if (last && status === "Closed") {
      body = `${agent}: ${fillSupport(sup.pick(CC_RESOLUTION), ctx)}`;
    } else if (last) {
      body = `${agent}: ${fillSupport(sup.pick(CC_WAITING), ctx)}`;
    } else if (sup.bool(0.3)) {
      body = `${ctx.reporter}: ${fillSupport(sup.pick(CC_CUSTOMER_REPLIES), ctx)}`;
    } else {
      const tail = sup.bool(0.4) ? " " + fillSupport(sup.pick(CC_WAITING), ctx) : "";
      body = `${agent}: ${fillSupport(sup.pick(CC_AGENT_ACTIONS), ctx)}${tail}`;
    }
    out.push(collapse(body));
  }
  // Belt-and-suspenders: a Closed case MUST end on a close-out line. The n=1 branch above already lands on
  // CC_RESOLUTION, but guard any tail that didn't read as resolved (pushes Closed-terminate-on-close → 100%).
  if (status === "Closed" && out.length) {
    const lastLine = out[out.length - 1]!;
    if (!/\b(resolv|clos|done|signed off|happy with)/i.test(lastLine)) {
      out[out.length - 1] = collapse(`${threadAgent}: ${fillSupport(sup.pick(CC_RESOLUTION), ctx)}`);
    }
  }
  return out;
}

// ── Demand-gen funnel (v17): the BULK top-of-funnel — Leads + CampaignMembers at scale ───────────────
// The v15/v16 corpus had a rich deal/account/activity graph but only 7 foreground Leads + 7 CampaignMembers,
// so a 100K-account org had an EMPTY top-of-funnel (no MQL/SQL/SDR/campaign-influence substrate). These pools
// drive a bulk Lead population (net-new prospects, not yet accounts) + bulk CampaignMembers wiring the account
// roster + the leads onto the (now scaled) campaign set. All values are load-safe standard picklist members.

/** Lead.Status — bulk mix. Pre-conversion (Open/Working) dominates; a real tail is Closed - Not Converted
 *  (dead/disqualified). "Closed - Converted" is OMITTED at the bulk tier (a converted lead becomes an
 *  Account/Contact/Opp — which the bulk tier already emits directly, so a bulk converted Lead would double-count). */
export const BULK_LEAD_STATUS_MIX: readonly WeightedValue[] = [
  { value: "Open - Not Contacted", weight: 46 }, { value: "Working - Contacted", weight: 33 },
  { value: "Closed - Not Converted", weight: 21 },
];
/** Lead.Rating — standard default set (Hot/Warm/Cold). */
export const LEAD_RATING_MIX: readonly WeightedValue[] = [
  { value: "Hot", weight: 16 }, { value: "Warm", weight: 46 }, { value: "Cold", weight: 38 },
];
/** Leads-per-account power-law — most accounts spawned no net-new lead; a long tail did. Expected ≈ 0.62. */
export const BULK_LEAD_COUNT: readonly WeightedValue[] = [
  { value: "0", weight: 58 }, { value: "1", weight: 26 }, { value: "2", weight: 11 }, { value: "3", weight: 5 },
];
/** CampaignMember.Status — standard default set, weighted toward the top of the engagement funnel. */
export const CAMPAIGN_MEMBER_STATUS_MIX: readonly WeightedValue[] = [
  { value: "Sent", weight: 48 }, { value: "Received", weight: 30 }, { value: "Responded", weight: 22 },
];
/** Buyer titles for bulk Leads — wider + more cross-functional than the 6 foreground RevOps titles, so a
 *  100K-lead funnel doesn't read as one persona. Free text (Lead.Title is not a restricted picklist). */
export const BULK_LEAD_TITLES = [
  "VP Revenue Operations", "Director of Sales", "Head of GTM", "RevOps Lead", "CRO", "VP Sales Enablement",
  "Director of Marketing", "VP Finance", "Head of Data", "Director of IT", "VP Operations", "Chief of Staff",
  "Director of Procurement", "Head of Analytics", "VP Customer Success", "Director of FP&A", "Head of BizOps",
  "VP Engineering", "Director of Demand Gen", "Head of Sales Operations", "VP Strategy", "Director of Partnerships",
  "Head of Growth", "VP Marketing",
] as const;

/** Campaign program archetypes — each (type, cadence) seeds a recurring program; the namer stamps the quarter.
 *  Used by buildBulkCampaigns to scale the shared campaign set from 5 → a few dozen over ~3 years. */
const CAMPAIGN_PROGRAMS = [
  { shape: "{Q} Product Webinar — {Topic}", type: "Webinar", perQuarter: 1 },
  { shape: "{Q} Field Event — {City}", type: "Conference", perQuarter: 1 },
  { shape: "Outbound — {Segment} ({Q})", type: "Email", perQuarter: 1 },
  { shape: "{Topic} Nurture Track", type: "Email", perQuarter: 0 }, // always-on (one, recent)
  { shape: "Intent Surge — {Topic}", type: "Other", perQuarter: 0 },
  { shape: "Analyst Briefing — {Topic}", type: "Advertisement", perQuarter: 0 },
] as const;
const CAMPAIGN_TOPICS = ["RevOps in Practice", "Pipeline Hygiene", "Forecast Accuracy", "Data Activation",
  "GTM Efficiency", "Deal Inspection", "Territory Design", "Renewals Motion", "Onboarding at Scale"] as const;
const CAMPAIGN_SEGMENTS = ["Enterprise FinTech", "Mid-Market SaaS", "Healthcare IT", "Manufacturing Ops",
  "Retail & CPG", "Public Sector", "High-Growth Startups"] as const;
const CAMPAIGN_EVENT_CITIES = ["San Francisco", "New York", "London", "Austin", "Chicago", "Singapore", "Berlin"] as const;

/** Build the shared campaign set: ~3 years of quarterly programs + a handful of always-on tracks (≈ 26-30
 *  campaigns). Deterministic given `rng`. Returns {name, type, agoDays} (the emitter derives dates + status). */
export function buildBulkCampaigns(rng: Rng): ReadonlyArray<{ name: string; type: string; agoDays: number }> {
  const out: Array<{ name: string; type: string; agoDays: number }> = [];
  const quarters = ["Q1 FY24", "Q2 FY24", "Q3 FY24", "Q4 FY24", "Q1 FY25", "Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26"];
  quarters.forEach((q, qi) => {
    const agoBase = (quarters.length - qi) * 91 - 30; // newest quarter ≈ 60d ago, oldest ≈ 880d ago
    for (const p of CAMPAIGN_PROGRAMS) {
      if (p.perQuarter < 1) continue; // always-on programs handled below
      const name = p.shape
        .replace("{Q}", q)
        .replace("{Topic}", rng.pick(CAMPAIGN_TOPICS))
        .replace("{City}", rng.pick(CAMPAIGN_EVENT_CITIES))
        .replace("{Segment}", rng.pick(CAMPAIGN_SEGMENTS));
      out.push({ name, type: p.type, agoDays: agoBase + rng.int(0, 20) });
    }
  });
  // A few always-on programs (recent), one per always-on archetype.
  for (const p of CAMPAIGN_PROGRAMS) {
    if (p.perQuarter >= 1) continue;
    const name = p.shape.replace("{Topic}", rng.pick(CAMPAIGN_TOPICS));
    out.push({ name, type: p.type, agoDays: rng.int(15, 75) });
  }
  return out;
}

// ── EAC / ECI activity layer (v18): the activity-capture + conversation-intelligence SIGNAL ─────────────
// The native ECI objects (VoiceCall / ConversationParticipant) are NOT createable and ActivityMetric is
// feature-gated, so the EAC/ECI signal is modeled through the load-safe createable fields on Task (the
// call-log: TaskSubtype / CallType / CallDurationInSeconds / CallDisposition), EmailMessage (the captured
// thread), and ContentVersion (the call-recording VTT transcript). All combinatorial (bulk tier = no LLM).

/** Logged-call outcomes (Task.CallDisposition — a free-text string field). */
const CALL_DISPOSITIONS_CONNECTED = [
  "Connected — next step set", "Connected — gathering requirements", "Connected — discussed pricing",
  "Connected — looping in their team", "Connected — not a fit right now", "Connected — meeting booked",
  "Connected — answered objections", "Connected — confirmed timeline", "Connected — intro to economic buyer",
  "Reached — short, will resume", "Connected — pushed for a decision", "Connected — reviewed the proposal",
] as const;

/** Map a logged-activity channel (from bulkTaskSubject) to its EAC TaskSubtype + telephony fields. Calls/
 *  voicemails carry CallType/CallDurationInSeconds/CallDisposition (the ECI call shape); email/linkedin/text
 *  carry only the subtype. Returns a partial Task record to spread at the call site. */
export function taskEacFields(rng: Rng, channel: string): Record<string, string | number> {
  if (channel === "Call") {
    return {
      TaskSubtype: "Call",
      CallType: rng.weighted([{ value: "Outbound", weight: 62 }, { value: "Inbound", weight: 28 }, { value: "Internal", weight: 10 }]),
      CallDurationInSeconds: 60 * rng.int(2, 41), // 2–41 min
      CallDisposition: rng.pick(CALL_DISPOSITIONS_CONNECTED),
    };
  }
  if (channel === "Voicemail") {
    return { TaskSubtype: "Call", CallType: "Outbound", CallDurationInSeconds: rng.int(12, 55), CallDisposition: "Left voicemail" };
  }
  if (channel === "Email") return { TaskSubtype: "Email" };
  if (channel === "LinkedIn") return { TaskSubtype: "LinkedIn" };
  // NB: 'Cadence' and 'ListEmail' are valid DESCRIBE picklist values but are NOT API-insertable on a manual
  // Task — they're reserved for the Sales Engagement Cadence / List Email features ("Subtype cadence is used
  // only by cadences"). So the only API-insertable subtypes the bulk tier emits are Task/Email/Call/LinkedIn;
  // a text/SMS touch logs as a plain Task. (Surfaced by the first live load — a mock can't catch this.)
  return { TaskSubtype: "Task" };
}

// — EmailMessage thread (captured email) — subject + body slot systems keyed by stage band —————————————
// Subjects MIX three registers so a 100K corpus doesn't read templated: ~party-specific ({Account}/{Dept}),
// ~topic-specific ({object} — the buyer-side concern, same vocabulary the body draws on), and ~generic (real
// subject lines often are). The token substitution (per account × dept × object) is what lifts cardinality
// from a 20-line static pool (the "Kicking off onboarding" ×26 tell) to hundreds of distinct, grounded subjects.
const EMAIL_SUBJECT_BY_BAND: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["Intro — {Account} + a quick fit check", "{Object} at {Account} — worth a look?", "Following up from {Channel}", "Quick question on {Dept} {object}", "Exploring options for {Dept}", "Rethinking {object}?", "{Account} + {object}", "Worth a quick look?", "A quick idea for {Dept}"],
  mid: ["Recap — {object} scope", "Pricing + what's included", "Next steps on {object}", "{Dept} requirements + timeline", "Where we landed on scope", "Pricing for {Account}", "Looping in the team on {object}", "Walking the numbers on {object}", "Re: {Dept} — a few open questions"],
  late: ["Proposal for {Account}", "Redlines + final pricing", "Security questionnaire — {object}", "Getting {Account} to signature", "Last open items before close", "{Account} MSA — redlines", "Final pricing on {object}", "Down to commercial terms"],
  closed: ["Kicking off {Account}", "Welcome aboard — {object} rollout", "{Dept} onboarding plan", "Thanks + next steps", "Recap + handoff on {object}", "Getting {Account} started", "Onboarding — {object}", "Welcome aboard"],
};
const EMAIL_OUT_OPEN = ["Hi {Contact},", "Hi {Contact} —", "Thanks for the time today, {Contact}.", "{Contact} — quick follow-up.", "Good speaking, {Contact}."] as const;
const EMAIL_IN_OPEN = ["Hi {Rep},", "Thanks {Rep},", "{Rep} —", "Appreciate the note, {Rep}.", "Hi {Rep} — thanks."] as const;
// Body lines are DIRECTION-PARTITIONED (like the openers/asks/signs): a rep's outbound line is a seller
// action ("Sending the kickoff invite"), a buyer's inbound line is a buyer action ("Looping in procurement")
// — so a thread never has the customer offering to send the kickoff invite.
const EMAIL_BODY_OUT: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["Wanted to see if there's a fit on {object}.", "Sharing a short overview ahead of our call.", "Curious how you're handling {object} today.", "A few teams your size are tackling this now.", "Thought this was worth a quick look.", "At {account}'s scale, {product} usually runs in the {money} range — worth exploring before {quarter}?"],
  mid: ["Recapping what we covered on {object}.", "Attaching the {money} pricing breakdown for {product}.", "Happy to get our technical lead on the next call.", "Here's how we'd handle the integration.", "Let me know if the scope looks right.", "If we hold scope on {product}, {quarter} is realistic for go-live."],
  late: ["Proposal's attached — {money} for {product}, let me know what stands out.", "Our legal team can turn the redlines around fast.", "Sending the security questionnaire back filled in.", "We're aligned on scope; the {money} is the last piece.", "Let's aim for signature by {quarter}."],
  closed: ["Excited to get you started on {product}.", "Looping in our onboarding lead for the {money} rollout.", "Sending the kickoff invite shortly.", "Thanks for working through the details.", "Great working with you on this."],
};
const EMAIL_BODY_IN: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["We're starting to look at this seriously.", "A few folks here flagged this as a priority.", "Timing could work for us before {quarter}.", "We're comparing a couple of options on {object}.", "Want to understand how {product} fits our stack."],
  mid: ["Our technical lead has a couple of questions.", "The {money} is a bit higher than we budgeted for {product}.", "We'd need this to integrate with our current tools.", "Walking the {money} internally this week.", "Need to bring procurement into the loop."],
  late: ["Legal had a couple of redlines on the MSA.", "Our VP is on board — down to commercial terms.", "Procurement needs a few more days on our side.", "We can move fast on the {money} if the pricing holds.", "Targeting sign-off by {quarter} here."],
  closed: ["Excited to get started on {product}.", "Who's our main point of contact for rollout?", "Thanks for working through the details.", "We'll get the kickoff on the calendar.", "Appreciate how smooth this was."],
};
const EMAIL_OUT_ASK = ["Can we grab 20 minutes this week?", "Sending the revised version over.", "Happy to walk the team through it.", "What's the best next step on your side?", "Let me know a couple of times that work.", ""] as const;
const EMAIL_IN_ASK = ["Can you send the details?", "We'll review internally and circle back.", "Let me loop in the right people.", "What does the timeline look like?", "Give us a few days on this.", ""] as const;
const EMAIL_OUT_SIGN = ["Best,", "Thanks,", "Cheers,", "Appreciate it,"] as const;
const EMAIL_IN_SIGN = ["Thanks,", "Best,", "Talk soon,", "Regards,"] as const;
/** The "{object}" a body line is about — framed from the BUYER's side (their reporting/rollout), never our product. */
const EMAIL_OBJECTS = ["reporting", "forecasting", "the data stack", "analytics", "the rollout", "pipeline visibility", "the integration", "dashboards", "the migration", "the renewal"] as const;
const subTok = (s: string, m: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k) => m[k] ?? "");

/** A captured-email subject for a thread (the first message; replies get a "Re: " prefix at the call site).
 *  The {object} token draws on the same buyer-side topic vocabulary as the body ({Object} = leading-capitalised
 *  for start-of-subject) so subjects are grounded in the deal's concern, not a generic 20-line pool. */
export function bulkEmailSubject(rng: Rng, stage: string, ctx: { account: string; dept: string }): string {
  const base = rng.pick(EMAIL_SUBJECT_BY_BAND[stageBand(stage)]);
  const object = rng.pick(EMAIL_OBJECTS);
  const Object = object.charAt(0).toUpperCase() + object.slice(1);
  return collapse(subTok(base, { Account: ctx.account, Dept: ctx.dept, Channel: "our call", object, Object })).slice(0, 200);
}
/** Rotate a pool pick by the message's sequence number so same-direction messages in one thread don't repeat
 *  the same opener/line back-to-back (the small pools collide otherwise) — the thread reads as progressing. */
const rotPick = <T>(rng: Rng, pool: readonly T[], seq: number): T => pool[(rng.int(0, pool.length - 1) + seq) % pool.length]!;

/** Compact USD for body/transcript copy — $250K / $1.2M / $4M (no decimals when round). voice.md: real numbers. */
export function compactUsd(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.max(0, Math.round(n))}`;
}

/** The deal facts spliced into a bulk thread/transcript so the copy carries numbers + a date + the product
 *  (not generic Mad-Libs). money = compact amount, quarter = close quarter, product = the deal's product line. */
export interface CopyFacts {
  money: string;
  quarter: string;
  product: string;
  account: string;
}

// GROUNDED openers (the rep's first outbound message in a thread) — every bulk email thread opens with the
// deal's real number + close quarter + product, so a thread is never number-free.
const EMAIL_OUT_GROUNDED: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["A few teams your size run {product} as a {money}-range program — worth 20 minutes before {quarter}?", "Most {product} rollouts at your scale land near {money}; happy to map it to your timeline for {quarter}."],
  mid: ["Recapping {product}: the proposal comes in around {money}. Targeting {quarter} if the scope holds.", "On {product} — we're at {money} as scoped; I can break down how that phases toward a {quarter} go-live."],
  late: ["Proposal's in — {money} for {product}, aiming for signature by {quarter}.", "We're aligned on {product} at {money}; pricing's the last piece before {quarter} close."],
  closed: ["Thrilled we got the {money} {product} rollout over the line — looping in onboarding now.", "Signed and done on {product} at {money}; here's the {quarter} kickoff plan."],
};

/** A captured-email body — direction (incoming = from the buyer) flips the voice; stage band sets the substance;
 *  `seq` is the message's position in the thread (rotates the slot picks so adjacent messages don't echo).
 *  The rep's opener (seq 0, outbound) is GROUNDED in the deal facts; other messages can reference them too. */
export function bulkEmailBody(rng: Rng, stage: string, incoming: boolean, contactFirst: string, repFirst: string, seq: number, facts: CopyFacts): string {
  const band = stageBand(stage);
  const tokens = { object: rotPick(rng, EMAIL_OBJECTS, seq), money: facts.money, quarter: facts.quarter, product: facts.product, account: facts.account };
  const open = subTok(rotPick(rng, incoming ? EMAIL_IN_OPEN : EMAIL_OUT_OPEN, seq), { Contact: contactFirst, Rep: repFirst });
  const body =
    seq === 0 && !incoming
      ? subTok(rng.pick(EMAIL_OUT_GROUNDED[band]), tokens) // the opener always cites real numbers
      : subTok(rotPick(rng, (incoming ? EMAIL_BODY_IN : EMAIL_BODY_OUT)[band], seq), tokens);
  const ask = rotPick(rng, incoming ? EMAIL_IN_ASK : EMAIL_OUT_ASK, seq);
  const sign = `${rng.pick(incoming ? EMAIL_IN_SIGN : EMAIL_OUT_SIGN)} ${incoming ? contactFirst : repFirst}`;
  return collapse(`${open} ${body}${ask ? " " + ask : ""}\n\n${sign}`);
}

// — ContentVersion call-recording transcript (WebVTT — the ECI/Gong shape) ——————————————————————————————
const VTT_REP_OPEN = ["Thanks for making the time today.", "Appreciate you both joining.", "Let's dive in — I'll keep us on time.", "Before we start, anything change on your side?"] as const;
const VTT_CUST_OPEN = ["Happy to — we've been looking at this for a while.", "Yeah, the team's eager to see it.", "We've got about 30 minutes.", "Quick context: our current setup isn't scaling."] as const;
const VTT_REP_BY_BAND: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["Walk me through how you handle this today.", "Who else would be involved in a decision like this?", "What's driving the timeline?", "Let me show you how this maps to your workflow."],
  mid: ["Here's how the integration would work.", "On pricing — it scales with seats, so let me break it down.", "What would success look like in the first 90 days?", "Your technical lead asked about the API — happy to cover it."],
  late: ["Let's get the proposal in front of your economic buyer.", "On the redlines — our legal team can turn those around fast.", "What's left before we can get to signature?", "Procurement flagged the security review; we've got it ready."],
  closed: ["Congrats — let's talk onboarding.", "I'll connect you with your implementation lead.", "Here's the rollout plan for the first month.", "We'll set up a check-in at week two."],
};
const VTT_CUST_BY_BAND: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["Right now it's mostly spreadsheets and it's breaking down.", "Finance and ops would both need to sign off.", "We'd want something live before the next fiscal year.", "That's closer to what we need than what we have."],
  mid: ["Integration is the big question for us.", "The number's higher than we budgeted — can we phase it?", "We'd measure it on cycle time and forecast accuracy.", "Our security team will have a questionnaire."],
  late: ["Our VP is on board; it's down to commercial terms.", "Legal's main concern is the data-processing addendum.", "We can move fast if the pricing holds.", "Give us through Friday and we should have sign-off."],
  closed: ["Excited to get the team ramped.", "Who's our main point of contact for rollout?", "We'll get the kickoff on the calendar.", "Appreciate how smooth this was."],
};
const VTT_CLOSE = ["Great — I'll send a recap and next steps.", "I'll follow up with the action items.", "Thanks all — recap to follow.", "Perfect, talk next week."] as const;
// GROUNDED turns — every transcript carries the deal's real number + close quarter + product, spoken by the
// rep and the buyer (so an ECI/Gong recording reads as a real conversation about a real deal, not Mad-Libs).
const VTT_REP_GROUNDED: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["So you're evaluating {product} — at your size that's typically a {money}-range program. What's driving the {quarter} timeline?", "If {product} is the direction, we'd usually scope something near {money}. Is {quarter} the window you're working toward?"],
  mid: ["On pricing — {product} comes in around {money}; it scales with seats. Are we still targeting {quarter} to go live?", "The {money} on {product} breaks down across the seat tiers — happy to phase it toward a {quarter} start."],
  late: ["Where we landed is {money} for {product}, signature by {quarter}. What's left on your side?", "So it's {money} on {product}, closing {quarter} — anything outstanding before we sign?"],
  closed: ["Congrats — the {money} {product} rollout is signed. Let's talk onboarding for {quarter}.", "Deal's done at {money} on {product}. Here's the {quarter} rollout plan."],
};
const VTT_CUST_GROUNDED: Record<"early" | "mid" | "late" | "closed", readonly string[]> = {
  early: ["Roughly, yeah — we'd want {product} live before {quarter}.", "That's about the range we expected; {quarter} would be the goal for {product}."],
  mid: ["The {money} is a bit above budget — can we phase the {product} rollout?", "We'd measure {product} on cycle time; the {money} needs to clear finance first."],
  late: ["{money} works if the terms hold. We can sign off on {product} by {quarter}.", "Our VP is good with the {money}; it's down to commercial terms before {quarter}."],
  closed: ["Excited to get {product} ramped this quarter.", "Happy with where the {money} landed — let's kick {product} off."],
};
const vttStamp = (sec: number) => `00:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.000`;

/** A WebVTT call-recording transcript (the shape Gong / Einstein Conversation Insights exports). Speakers are
 *  the deal's actual people (the rep + the named contacts who are on the call); turns are stage-appropriate.
 *  One rep turn + one buyer turn are GROUNDED in the deal's real number/quarter/product (`facts`). */
export function bulkTranscriptVtt(rng: Rng, repName: string, contactNames: readonly string[], stage: string, facts: CopyFacts): string {
  const band = stageBand(stage);
  const cust = contactNames.length ? contactNames : ["Buyer"];
  const tok = { money: facts.money, quarter: facts.quarter, product: facts.product, account: facts.account };
  const lines: string[] = ["WEBVTT", ""];
  let t = rng.int(2, 8);
  const cue = (speaker: string, text: string) => {
    const end = t + rng.int(8, 35);
    lines.push(`${vttStamp(t)} --> ${vttStamp(end)}`, `${speaker}: ${text}`, "");
    t = end + rng.int(1, 4);
  };
  cue(repName, rng.pick(VTT_REP_OPEN));
  cue(rng.pick(cust), rng.pick(VTT_CUST_OPEN));
  // The substantive heart of the call is grounded in the deal's facts.
  cue(repName, subTok(rng.pick(VTT_REP_GROUNDED[band]), tok));
  cue(rng.pick(cust), subTok(rng.pick(VTT_CUST_GROUNDED[band]), tok));
  const turns = rng.int(1, 3);
  for (let i = 0; i < turns; i++) {
    cue(repName, rng.pick(VTT_REP_BY_BAND[band]));
    cue(rng.pick(cust), rng.pick(VTT_CUST_BY_BAND[band]));
  }
  cue(repName, rng.pick(VTT_CLOSE));
  return lines.join("\n");
}
