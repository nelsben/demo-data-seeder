// packs/salescloud/src/generate.ts
//
// The salescloud pack's generate() — turns plan units into the full standard Sales Cloud
// object graph (Accounts → Contacts → Opportunities → OpportunityContactRoles →
// EmailMessages/Tasks/ContentVersion transcripts, plus Leads/Campaigns/Cases/Assets), all
// deterministic from the per-unit seeds. NO PROSE is written here: every email/task/transcript
// body emits a CopyRequest and an empty field for the copy layer to fill (the no-vapor-ware seam).
//
// Linkage uses local `_ref` ids and a `_refs` map (parent-field → ref); the M4
// loader resolves them to real Salesforce Ids in topological order. `_meta` holds
// non-field annotations (scenario, persona) for previews — the loader strips
// underscore-prefixed keys before insert.

import type { GenerateContext, GenerateOutput, BundleRecords, CopyRequest, GenericRecord, LeadConversion, Rng } from "@dataseed/core";
import { makeRng, deriveSeed, spreadDates, STANDARD_PRICEBOOK_REF, existingRef } from "@dataseed/core";
import { ANCHORS, type Anchor } from "./anchors.js";
import { resolveGrounding } from "./grounding.js";
import { identityToAnchor, identityToGrounding, accountFirmographics, splitHq } from "./identity.js";
import { ANCHOR_HQ, geoForCountry, US_STATE_ZIP3, type Geo } from "./anchor-hq.js";
import { voiceCardFor, type VoiceCard } from "./voice-cards.js";
import {
  BAND_RANGE,
  SCENARIO_PROFILES,
  SALESCLOUD_VARIABILITY,
  SIZE_BANDS,
  GEO_BY_REGION,
  INDUSTRY_DIST,
  INDUSTRY_RPE,
  OPP_COUNT_DISTRIBUTION,
  OPP_STATE_MIX,
  BULK_OPEN_STAGES,
  BULK_OCR_ROLES,
  BULK_CASE_STATUS_MIX,
  BULK_CASE_ORIGIN_MIX,
  BULK_PRIORITY_MIX,
  BULK_CASE_PRIORITY_MIX,
  BULK_TASK_OPEN_STATUS,
  // v15 bulk-tier combinatorial content
  bulkTaskSubject,
  bulkTaskDescription,
  bulkEventSubject,
  bulkCaseSubject,
  bulkCaseDescription,
  caseCommentThread,
  buildCaseScene,
  CASE_AREAS,
  ASSET_EDITIONS,
  ASSET_TERMS,
  NAME_SHAPES,
  INITIATIVE,
  DEPARTMENT,
  motionsForType,
  BULK_LINE_COUNT,
  PRODUCT_ATTACH,
  OPP_TYPE_NEW,
  OPP_TYPE_EXISTING,
  OPP_LEADSOURCE,
  NEXTSTEP,
  buildOppDescription,
  oppDescKey,
  PROBABILITY,
  FORECASTCATEGORY,
  TITLES_BY_DEPT,
  SENIOR_DEPTS,
  ALL_DEPTS,
  isSingularTitle,
  deptOfTitle,
  CONTACT_LEADSOURCE,
  STREET_NAMES,
  STREET_TYPES,
  ACCOUNT_SOURCE,
  ACCT_DESC_LEAD,
  ACCT_DESC_FOCUS,
  ACCT_DESC_TAIL,
  bulkPhone,
  quarterOf,
  seatTier,
  seatCount,
  stageBand,
  familyRollup,
  // v17 demand-gen funnel (bulk Leads + CampaignMembers + scaled Campaigns)
  buildBulkCampaigns,
  BULK_LEAD_TITLES,
  BULK_LEAD_STATUS_MIX,
  LEAD_RATING_MIX,
  BULK_LEAD_COUNT,
  CAMPAIGN_MEMBER_STATUS_MIX,
  taskEacFields,
  bulkEmailSubject,
  bulkEmailBody,
  bulkTranscriptVtt,
  compactUsd,
  type SupportCtx,
  type CaseScene,
} from "./variability.js";
import { ratingForForeground, ratingForBulk } from "./sentiment.js";
import { makeCompanyNamer } from "./company-names.js";
import { buildDealDossier, deriveStage } from "./dossier.js";
import { CASE_ORIGIN, CASE_PRIORITY } from "./picklists.js";

// 40 first + 40 last names (globally varied) — large enough that a multi-deal demo's foreground casts draw
// distinct first names AND surnames across deals (the run-level reservation below relies on the headroom; the
// old 16-name pools overflowed at ~5 deals, forcing the Mwangi/Becker cross-deal collisions the audit caught).
const FIRST_NAMES = [
  // original 40 (kept first so foreground name reservation is byte-identical for the first names used)
  "Maya", "Daniel", "Priya", "Marcus", "Elena", "Tom", "Aisha", "Jordan", "Nina", "Carlos", "Sofia", "Wei", "Hannah", "Omar", "Grace", "Leo",
  "Sara", "Kevin", "Lena", "Raj", "Mei", "Diego", "Yuki", "Noor", "Felix", "Ava", "Ivan", "Zara", "Paul", "Lucia", "Sven", "Tara",
  "Ravi", "Clara", "Dmitri", "Fatima", "Hugo", "Ingrid", "Mateo", "Rosa",
  // expansion → ~300 globally diverse, real first names (no AI-slop)
  "Olivia", "Liam", "Mei-Ling", "Andre", "Beatriz", "Cheng", "Anika", "Tobias", "Ines", "Kwame",
  "Hana", "Rafael", "Soo-jin", "Magnus", "Camila", "Arjun", "Freya", "Naomi", "Emeka", "Yara",
  "Lars", "Priscila", "Hiroshi", "Adaeze", "Nikolai", "Bianca", "Tariq", "Greta", "Joon", "Renata",
  "Mads", "Idris", "Annika", "Pedro", "Saanvi", "Bjorn", "Carmen", "Kenji", "Zoe", "Mohammed",
  "Astrid", "Vikram", "Elif", "Santiago", "Mira", "Cormac", "Thandiwe", "Henrik", "Valentina", "Dev",
  "Ingvar", "Lucas", "Amara", "Theo", "Sana", "Niklas", "Paloma", "Ren", "Esther", "Bruno",
  "Aaliyah", "Stefan", "Noemi", "Hassan", "Linnea", "Mateusz", "Chloe", "Akira", "Farida", "Oskar",
  "Manon", "Ravindra", "Sigrid", "Tomas", "Leila", "Casper", "Inaya", "Jonas", "Maira", "Levi",
  "Anouk", "Ravi-Kumar", "Yael", "Emil", "Rania", "Frida", "Samuel", "Tessa", "Khalil", "Olga",
  "Bram", "Aditya", "Nadia", "Joel", "Suri", "Viktor", "Amani", "Pia", "Demir", "Marisol",
  "Caleb", "Anja", "Rohan", "Sienna", "Tadeo", "Ewa", "Malik", "Britta", "Nora", "Yusuf",
  "Lina", "Gustavo", "Indira", "Sebastian", "Maeve", "Anton", "Zuri", "Ravi-Shankar", "Selma", "Otto",
  "Daniela", "Ismael", "Wren", "Petra", "Hugo-Andre", "Saoirse", "Ezra", "Catalina", "Joaquin", "Birgit",
  "Aria", "Kofi", "Maja", "Rashid", "Eliza", "Tomasz", "Noa", "Dimitri", "Romy", "Aziz",
  "Cecilia", "Bodhi", "Suhana", "Felipe", "Greer", "Anders", "Layla", "Mikkel", "Esme", "Hamza",
  "Ottilie", "Pavel", "Rosalind", "Tobi", "Veronika", "Wassim", "Yara-Sofia", "Zane", "Aurelia", "Bartek",
  "Cira", "Damien", "Eira", "Fabian", "Giulia", "Hedda", "Ilias", "Juno", "Kira", "Loic",
  "Maren", "Nils", "Orla", "Pip", "Quincy", "Rocco", "Sade", "Tomi", "Ulla", "Vidya",
  "Willa", "Xavi", "Yannick", "Zofia", "Aaron", "Brigid", "Cyrus", "Delphine", "Enzo", "Fiona",
  "Gael", "Hella", "Ivar", "Janelle", "Kasper", "Lia", "Milo", "Neha", "Owen", "Pernille",
  "Rania-Mae", "Soren", "Tanvi", "Umberto", "Vera", "Wim", "Xenia", "Yohan", "Zara-Lee", "Aron",
  "Bea", "Ciaran", "Dario", "Esra", "Florian", "Gemma", "Halle", "Iker", "Jana", "Koen",
  "Lena-Marie", "Misha", "Nadir", "Olof", "Petter", "Quinta", "Reza", "Suvi", "Timo", "Ugo",
  "Vivienne", "Wojciech", "Yuna", "Zeynep", "Albin", "Bodil", "Cato", "Dunja", "Enrique", "Faye",
  "Gunnar", "Hina", "Iris", "Jago", "Keira", "Lev", "Maël", "Niamh", "Oona", "Pawel",
];
const LAST_NAMES = [
  // original 40 (kept first for byte-stable foreground reservation)
  "Okafor", "Reyes", "Lindqvist", "Bauer", "Costa", "Nakamura", "Patel", "Foster", "Romano", "Haddad", "Chen", "Novak", "Sterling", "Mwangi", "Becker", "Vance",
  "Iverson", "Delgado", "Brandt", "Kapoor", "Sato", "Mensah", "Walsh", "Petrov", "Nguyen", "Ortiz", "Haas", "Larsen", "Rossi", "Abboud", "Fischer", "Dubois",
  "Okonkwo", "Yamamoto", "Greco", "Eriksson", "Khan", "Moreau", "Sandoval", "Bianchi",
  // expansion → ~600 globally diverse surnames
  "Andersson", "Muller", "Tanaka", "Silva", "Kowalski", "Hernandez", "Adebayo", "O'Brien", "Schmidt", "Ivanova",
  "Park", "Romero", "Nakagawa", "Fernandez", "Bjornsen", "Acharya", "Schneider", "Lefebvre", "Esposito", "Goldberg",
  "Mbeki", "Antonov", "Castillo", "Whitfield", "Hoffmann", "Pereira", "Saito", "Macdonald", "Kovac", "Banerjee",
  "Lindgren", "Salazar", "Yoshida", "Marchetti", "Boateng", "Volkov", "Vargas", "Hubbard", "Weber", "Mehta",
  "Andersen", "Bergstrom", "Caruso", "DiMaggio", "Engel", "Fontaine", "Gallo", "Hassan", "Ishikawa", "Jankowski",
  "Klein", "Lombardi", "Moreno", "Nilsson", "Ohlsson", "Pavlov", "Quintana", "Rasmussen", "Stein", "Takahashi",
  "Ueda", "Vidal", "Wagner", "Xu", "Yilmaz", "Zhang", "Adeyemi", "Brioschi", "Cervantes", "Dlamini",
  "Eriksen", "Farouk", "Grimaldi", "Holm", "Iqbal", "Jimenez", "Kristensen", "Laurent", "Maharaj", "Novikov",
  "Olsen", "Pakulski", "Qureshi", "Ramirez", "Sorensen", "Tremblay", "Ullah", "Voss", "Wahlberg", "Yamada",
  "Zielinski", "Aguilar", "Baumann", "Chiang", "Delacroix", "Eklund", "Ferrari", "Garibaldi", "Hwang", "Imamura",
  "Johansson", "Karlsson", "Lozano", "Mancini", "Nakashima", "Ortega", "Petersen", "Rahman", "Stefanopoulos", "Trujillo",
  "Uchida", "Vasquez", "Wickramasinghe", "Yamaguchi", "Zhukov", "Abara", "Bertrand", "Castellano", "Donnelly", "Esfahani",
  "Falk", "Gomez", "Holloway", "Ibrahim", "Joshi", "Kaminski", "Lindholm", "Matsumoto", "Naidoo", "Owusu",
  "Persson", "Radev", "Sancho", "Toledano", "Underwood", "Verma", "Wojcik", "Yousef", "Zambrano", "Arnesen",
  "Brennan", "Conti", "Dembele", "Eriksson-Holm", "Frank", "Gunnarsson", "Halvorsen", "Ito", "Jovanovic", "Kohler",
  "Lefevre", "Morales", "Nardini", "Obi", "Petrenko", "Reinholt", "Savic", "Thorne", "Ueno", "Villanueva",
  "Wood", "Yamashita", "Zoric", "Abbas", "Beaumont", "Costanzo", "Dragomir", "Emanuelsson", "Fadel", "Grossi",
  "Hartmann", "Inoue", "Jansen", "Kapadia", "Larsson", "Mizuno", "Nystrom", "Oduya", "Pasquale", "Renaud",
  "Sasaki", "Tabatabai", "Urbina", "Vinogradov", "Walewski", "Yuki", "Zaragoza", "Akande", "Bellini", "Caldeira",
  "Dahl", "Eichmann", "Fournier", "Gallego", "Hamada", "Isaksen", "Jain", "Kessler", "Lindqvist-Bo", "Matos",
  "Nowak", "Ostrowski", "Pirozzi", "Roux", "Stenberg", "Tamura", "Ueki", "Vega", "Wallenberg", "Yamazaki",
  "Zografos", "Almeida", "Berglund", "Christophersen", "Demir", "Eklof", "Fontana", "Gravesen", "Hirano", "Issa",
  "Jonsson", "Kalra", "Liang", "Mwangiwa", "Nakamoto", "Onyango", "Pajak", "Rivera", "Sundqvist", "Trabelsi",
  "Uddin", "Valenti", "Wozniak", "Yamane", "Zubair", "Aslan", "Bonetti", "Cisse", "Drummond", "Estrada",
  "Fuentes", "Gianni", "Holst", "Ikeda", "Jovic", "Kozlov", "Lindahl", "Murakami", "Nardone", "Ogundele",
  "Petrov", "Ricci", "Stoyanov", "Tomassi", "Ugarte", "Vukovic", "Wennberg", "Yusupova", "Zanetti", "Aleman",
  "Borg", "Chowdhury", "Dupont", "Engström", "Ferro", "Goncalves", "Hossain", "Ivashov", "Jang", "Koppel",
  "Lemaire", "Magnusson", "Nair", "Ozdemir", "Pinto", "Quaranta", "Rossini", "Solberg", "Takeda", "Usman",
  "Vasilenko", "Wahlstrom", "Yates", "Zaragoza-Lo", "Asante", "Bjornstad", "Cardoso", "Dziedzic", "Ekberg", "Ferrante",
  "Gulati", "Hagen", "Iwasaki", "Joachim", "Kovalenko", "Lehtinen", "Mortensen", "Nieminen", "Osei", "Pellegrini",
  "Qadir", "Ronnberg", "Suzuki", "Thiele", "Ullrich", "Vidovic", "Westergaard", "Yamamuro", "Zielke", "Adler",
  "Bakr", "Cuevas", "Doyle", "Ekstrom", "Frei", "Gjertsen", "Holmberg", "Ishii", "Jaworski", "Kang",
  "Lindberg", "Mahmoud", "Nakata", "Oyelaran", "Pasternak", "Riva", "Sobotka", "Tanev", "Uribe", "Vilela",
  "Wieczorek", "Yokoyama", "Zec", "Akhtar", "Bjorklund", "Capelli", "Diallo", "Engberg", "Fang", "Grewal",
  "Haq", "Ido", "Jaffe", "Kunz", "Lindqvist-Sa", "Matsuda", "Nilsen", "Okafor-Eze", "Pavlovic", "Rangel",
  "Strand", "Tomic", "Urquhart", "Vlasov", "Wrona", "Yamaoka", "Zoll", "Andrade", "Bratt", "Chaudhary",
  "Dvorak", "Engqvist", "Fukuda", "Gustafsson", "Holguin", "Ismael", "Jovanov", "Kallio", "Larkin", "Mancinelli",
  "Nogueira", "Ohlin", "Pereira-Lo", "Rasheed", "Sjoberg", "Tan", "Ueno-Kai", "Velasco", "Wallin", "Yi",
];
// AE (selling-side rep) first names — kept distinct from buyer-side names for clarity, and sized so a
// multi-deal demo (default volume 12) draws a DISTINCT rep per foreground deal before the pool wraps (the
// run-level reservation below relies on this headroom; the old 10-name pool overflowed past ~10 deals and
// repeated AE first names across deals — a cross-deal tell the audit caught).
const AE_NAMES = [
  "Alex", "Sam", "Riley", "Casey", "Morgan", "Drew", "Taylor", "Quinn", "Avery", "Jamie",
  "Reese", "Cameron", "Skyler", "Parker", "Devon", "Harper", "Rowan", "Blake",
];

/**
 * A generic SaaS product catalog — seeded ONCE and shared across deals (not per-deal). Each product
 * gets a PricebookEntry on the org's standard pricebook; each deal draws 2–4 of them as line items
 * whose totals reconcile EXACTLY to Opportunity.Amount (Salesforce derives Amount from line items
 * once they exist, so a mismatch would silently rewrite the figure the emails/tasks quote). `list`
 * is the catalog list price; a deal's line carries its own negotiated UnitPrice.
 */
const PRODUCTS = [
  { code: "PLAT-CORE", name: "Platform License", family: "Licenses", list: 60_000 },
  { code: "PLAT-PREM", name: "Premium Support", family: "Services", list: 18_000 },
  { code: "PLAT-IMPL", name: "Onboarding & Implementation", family: "Services", list: 25_000 },
  { code: "PLAT-ANL", name: "Advanced Analytics Module", family: "Add-ons", list: 22_000 },
  { code: "PLAT-API", name: "API & Integrations", family: "Add-ons", list: 12_000 },
  { code: "PLAT-SBX", name: "Sandbox Environment", family: "Add-ons", list: 8_000 },
  { code: "PLAT-TRN", name: "Training & Enablement", family: "Services", list: 9_000 },
  { code: "PLAT-STG", name: "Data Storage Expansion", family: "Add-ons", list: 6_000 },
];

/**
 * What the AE's company SELLS — a HORIZONTAL data/analytics/integration platform (the PRODUCTS catalog
 * above), the SAME across every deal and deliberately orthogonal to any prospect's own product. Passed
 * into every CopyRequest's facts so the model pitches OUR platform helping the prospect's internal teams
 * — never the prospect's own product/category. This is the cure for the audit's fatal "self-product" tell
 * (pitching Lyft a routing optimizer, Veeva a Vault content workflow, Roku an ad-yield analytics tool):
 * the model had no idea what "we" sold, so it invented a pitch out of the prospect's own domain.
 */
const SELLER_PITCH =
  "a horizontal data, analytics & integration platform (Platform License + Advanced Analytics, API/Integrations, Sandbox, and Data Storage modules) that the AE's company sells INTO businesses across every industry. It is a back-office/operations tool for the prospect's INTERNAL teams (RevOps, data, IT, finance) — it is NOT the prospect's own product, industry, or customer-facing capability. Pitch how THIS platform helps their internal teams; never pitch them anything they themselves make or sell.";

/**
 * The AE's company's OWN email domain — ONE fixed brand, identical across every account. Previously this
 * was derived from the PROSPECT's own domain (`ae@${prospectDomain.replace(".", "-sales.")}`), so e.g.
 * Zscaler's AE emailed from "ae@zscaler-sales.com" — indistinguishable from a look-alike/typosquat of the
 * customer's own domain, and every account was effectively sold to by a different fictitious vendor named
 * after itself. A single constant brand reads as a real third-party vendor and is consistent org-wide.
 */
export const SELLER_DOMAIN = "meridianiq.com";

/**
 * Marketing campaigns — seeded ONCE and shared (like the product catalog), upserted by Name so they
 * don't accumulate. Deals attribute to one (Opportunity.CampaignId) and leads respond via
 * CampaignMember — the top-of-funnel "where did this come from" story. `agoDays` backdates the run.
 */
// (The static 5-campaign list was replaced by buildBulkCampaigns(rng) — the scaled ~30-campaign set built in
//  salescloudGenerate; campaign-N refs stay stable because it's deterministic given the run seed.)
const LEAD_STATUSES_OPEN = ["Open - Not Contacted", "Working - Contacted"]; // restricted Lead.Status (pre-conversion)
const LEAD_SOURCES = ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"]; // restricted Lead.LeadSource
const CAMPAIGN_MEMBER_STATUSES = ["Sent", "Responded", "Received"]; // restricted CampaignMember.Status
const LEAD_TITLES = ["VP Revenue Operations", "Director of Sales", "Head of GTM", "RevOps Lead", "CRO", "VP Sales Enablement"];

/**
 * Split `total` into `n` positive integer parts that SUM EXACTLY to `total` (last part absorbs the
 * remainder) — so a deal's line-item TotalPrices reconcile to Opportunity.Amount with no drift. The
 * first line (the platform license) carries the largest share; the rest taper.
 */
function splitAmount(total: number, n: number): number[] {
  if (n <= 1) return [total];
  // The license (line 0) takes the majority — weight n+1 keeps it dominant (> the others combined,
  // which sum to n) no matter how many lines; one mid add-on (weight 2), the rest small (weight 1).
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? n + 1 : i === 1 ? 2 : 1));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.max(1, Math.round((total * w) / wsum / 100) * 100)); // round to $100
  const drift = total - parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1] = Math.max(1, parts[parts.length - 1]! + drift); // last line absorbs the remainder → exact sum
  return parts;
}

/** A concrete, deal-specific thread subject phrase per scenario (varies the subject across deals). */
const SUBJECT_HINT: Record<string, string> = {
  "at-risk-budget": "budget + next steps",
  "healthy-tech": "rollout plan",
  "rfp-gated": "evaluation",
  "stalled-portfolio": "status check",
  "churning-account": "renewal",
};

/**
 * Persona → (title, OCR role). OCR roles are from the standard OpportunityContactRole picklist
 * (all values here are in the BULK_OCR_ROLES load-safe set + "Decision Maker", a standard default).
 *
 * The HARD invariant this map encodes (cross-object coherence — the emails/transcripts repeatedly
 * name the CFO/Economic Buyer as holding budget sign-off, so the OCR must agree): the decision
 * authority on a deal is the Economic Buyer (the budget holder), NOT the procurement Skeptic or the
 * IT-Security Blocker, who in the prose defer all sign-off to the CFO. So "Decision Maker" is
 * RESERVED for the deal's decision authority and is NEVER assigned to a Skeptic or a Blocker.
 *   - Economic Buyer       → "Economic Buyer"   (holds budget sign-off; the standard EB role)
 *   - Champion             → "Influencer"        (drives internally; promoted to the decision role
 *                                                 only when the cast has no Economic Buyer — see ocrRoleFor)
 *   - Technical Evaluator  → "Technical Buyer"
 *   - Coach                → "Influencer"
 *   - Skeptic              → "Evaluator"         (NEVER Decision Maker — they vet, they don't approve)
 *   - Blocker              → "Influencer"        (NEVER Decision Maker — they defer sign-off to the CFO)
 *   - End User             → "Business User"
 */
// v25: each persona carries a fixed Department so the foreground Contact's standard Department field coheres
// with WHO they are (a CFO sits in Finance, the IT-Security blocker in IT) — the org chart reads true. We map
// per-persona here rather than via deptOfTitle() because the foreground persona titles are a different, smaller
// set than the bulk title matrix (extending TITLES_BY_DEPT would shift bulk bytes); this is pure, no RNG.
/** A load-safe email local part: FOLD diacritics (Engström → engstrom) then drop any remaining non-ASCII, so a
 *  contact with an accented name doesn't produce an INVALID_EMAIL_ADDRESS on a live load (a real bug caught on a
 *  burn load: `esra.engström@uber.com`). NFKD-folding preserves readability (engstrom), unlike a bare strip. */
function emailLocal(first: string, last: string): string {
  // NFKD splits "ö" → "o" + a combining mark; the final [^a-z0-9] strip drops the mark and keeps the base letter.
  const fold = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${fold(first)}.${fold(last)}`;
}

// v26 org chart (Contact.ReportsToId). LOWER rank = MORE senior. The Economic Buyer (CFO) is the sole C-level
// top-of-tree (the CEO isn't a contact); a Champion (VP RevOps) reports to the EB when present, never above it.
// REPORTS_TO is each persona's preferred manager personas, most-preferred first; a reporting edge only forms
// toward a STRICTLY more-senior in-cast contact, so the graph is always acyclic. PURE — no RNG.
const PERSONA_RANK: Record<string, number> = {
  "Economic Buyer": 0, Champion: 1, Skeptic: 1, "Technical Evaluator": 2, Blocker: 2, Coach: 3, "End User": 4,
};
const REPORTS_TO: Record<string, readonly string[]> = {
  "Economic Buyer": [],
  Champion: ["Economic Buyer"],
  Skeptic: ["Economic Buyer"],
  "Technical Evaluator": ["Champion", "Economic Buyer"],
  Blocker: ["Economic Buyer", "Champion"],
  Coach: ["Champion", "Economic Buyer", "Technical Evaluator"],
  "End User": ["Coach", "Technical Evaluator", "Champion", "Economic Buyer"],
};
/** The in-cast manager _ref for contact j, or null when top-of-tree / no strictly-senior contact exists. Pure. */
function reportsToRefFor(cast: ReadonlyArray<{ ref: string; persona: string }>, j: number): string | null {
  const myRank = PERSONA_RANK[cast[j]!.persona] ?? 4;
  const seniorEnough = (i: number) => (PERSONA_RANK[cast[i]!.persona] ?? 4) < myRank; // strictly more senior → acyclic
  for (const wantP of REPORTS_TO[cast[j]!.persona] ?? []) {
    const idx = cast.findIndex((c, i) => c.persona === wantP && seniorEnough(i));
    if (idx >= 0) return cast[idx]!.ref;
  }
  let bestIdx = -1, bestRank = Infinity; // fallback: the most-senior contact strictly above (ties → lowest index)
  for (let i = 0; i < cast.length; i++) {
    if (!seniorEnough(i)) continue;
    const rk = PERSONA_RANK[cast[i]!.persona] ?? 4;
    if (rk < bestRank) { bestRank = rk; bestIdx = i; }
  }
  return bestIdx >= 0 ? cast[bestIdx]!.ref : null;
}

// `titles` is a per-persona POOL (not a fixed string) — sampled per deal so two foreground hero accounts
// never show identical buying-committee titles (the earlier fixed 1:1 map meant every Champion across every
// demo company was literally "VP, Revenue Operations", every CFO "Chief Financial Officer", etc. — a tell a
// VP flipping between two accounts in the same org would immediately notice). role/dept stay singular: they
// encode hard cross-object invariants (OCR role mapping, Contact.Department coherence), not narrative color.
const PERSONA_DETAIL: Record<string, { titles: readonly string[]; role: string; dept: string }> = {
  Champion: {
    titles: ["VP, Revenue Operations", "VP, Sales Operations", "Head of Revenue Operations", "VP, GTM Operations", "Director, Revenue Operations"],
    role: "Influencer",
    dept: "Sales",
  },
  "Economic Buyer": {
    titles: ["Chief Financial Officer", "VP of Finance", "SVP, Finance", "Head of Finance", "Chief Financial Officer & VP Finance"],
    role: "Economic Buyer",
    dept: "Finance",
  },
  "Technical Evaluator": {
    titles: ["Director, Platform Engineering", "VP of Engineering", "Director of IT Architecture", "Head of Platform Engineering", "Director, Systems Engineering"],
    role: "Technical Buyer",
    dept: "Engineering",
  },
  Coach: {
    titles: ["Sales Operations Manager", "Manager, Revenue Operations", "Senior Sales Operations Analyst", "Sales Operations Lead"],
    role: "Influencer",
    dept: "Sales",
  },
  Skeptic: {
    titles: ["VP, Procurement", "Director of Procurement", "Head of Vendor Management", "VP, Sourcing & Procurement"],
    role: "Evaluator",
    dept: "Finance",
  },
  Blocker: {
    titles: ["Director, IT Security", "Chief Information Security Officer", "VP, Information Security", "Head of IT Security & Compliance"],
    role: "Influencer",
    dept: "Information Technology",
  },
  "End User": {
    titles: ["Operations Analyst", "Senior Operations Analyst", "Business Operations Specialist", "Operations Coordinator"],
    role: "Business User",
    dept: "Operations",
  },
};

/**
 * The deal's decision authority for OCR purposes: the Economic Buyer if the cast has one, else the
 * Champion (the internal advocate who carries the deal). This is the contact who gets OCR Role
 * "Decision Maker" and IsPrimary=true — so the primary is the deal's advocate/sign-off, never the
 * Skeptic or Blocker. Returns the index into `personas`, or -1 when the cast has NO decision authority
 * (rfp/early casts with no EB and no Champion — the real decision-maker is unnamed, "above" the roster),
 * in which case no contact is tagged "Decision Maker" (see the OCR loop, which still sets one IsPrimary).
 */
function decisionAuthorityIndex(personas: readonly string[]): number {
  const eb = personas.indexOf("Economic Buyer");
  if (eb >= 0) return eb;
  const champ = personas.indexOf("Champion");
  if (champ >= 0) return champ;
  return -1;
}

/** OCR Role for a contact: the decision authority is "Decision Maker"; everyone else takes their
 *  persona's standard OCR role. Keeps "Decision Maker" off Skeptics/Blockers by construction. */
function ocrRoleFor(persona: string, isDecisionAuthority: boolean): string {
  if (isDecisionAuthority) return "Decision Maker";
  return (PERSONA_DETAIL[persona] ?? PERSONA_DETAIL["End User"]!).role;
}

const DAY_MS = 86_400_000;
/** asOf + days as a Salesforce Date (YYYY-MM-DD). */
function forwardDate(asOf: string, days: number): string {
  return new Date(new Date(asOf).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
/** asOf + days, anchored at `hour` (UTC), as a Salesforce DateTime (ISO 8601) — for Event Start/End. */
function forwardDateTime(asOf: string, days: number, hour: number): string {
  const d = new Date(new Date(asOf).getTime() + days * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
/**
 * v16 (event timing): shift a days-from-asOf offset OFF a weekend onto the nearest weekday — Saturday (UTC
 * getUTCDay()===6) pulls back to Friday (−1), Sunday (===0) pushes to Monday (+1). Keeps the Start/End window
 * inside business days so the corpus stops scheduling ~28% of meetings on Sat/Sun. Pure: derived from asOf+day.
 */
function nearestWeekdayDay(asOf: string, day: number): number {
  const dow = new Date(new Date(asOf).getTime() + day * DAY_MS).getUTCDay();
  if (dow === 6) return day - 1; // Saturday → Friday
  if (dow === 0) return day + 1; // Sunday → Monday
  return day;
}
/** Pick one weighted item deterministically from `r` (cumulative-weight walk; inclusive r.int). */
function weightedPick<T extends { weight: number }>(r: Rng, items: readonly T[]): T {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let x = r.int(0, total - 1);
  for (const it of items) {
    if (x < it.weight) return it;
    x -= it.weight;
  }
  return items[items.length - 1]!;
}
// Standard required-field defaults for a seeded User (org-validated picklists; we write fixed valid
// values rather than sampling, so no enum guard is needed). Pool roles are flat, one per region.
const POOL_REGIONS = ["West", "East", "Central"] as const;
const USER_DEFAULTS = { TimeZoneSidKey: "America/Los_Angeles", LocaleSidKey: "en_US", EmailEncodingKey: "UTF-8", LanguageLocaleKey: "en_US" } as const;

/**
 * Emit the shared sales-rep User pool + a FLAT set of UserRoles, returning the ordered pool refs
 * (`user-0..N-1`) for OwnerId distribution. Drawn from a DEDICATED `userpool` rng stream, so it never
 * perturbs the per-account `bulk` streams. Everything is a pure function of (seed, index): same seed →
 * byte-identical pool (the Username catalog-dedup reuses it on re-load); different seed → a disjoint
 * Username namespace.
 *
 * Roles are FLAT (no ParentRoleId): the loader builds ALL of an object's payloads before inserting, so
 * an intra-UserRole self-parent ref can't resolve in one pass (every child role would skip) — a 2-level
 * hierarchy needs a loader two-pass and is deferred. ProfileId is a HARD `@existing` Profile ref: if the
 * org lacks that Profile the User row skips and its OwnerId soft-refs then drop to the running user.
 */
function emitUserPool(plan: { seed: number; userPoolSize: number; userProfileName: string }, records: BundleRecords): string[] {
  const n = plan.userPoolSize;
  if (n <= 0) return [];
  const up = makeRng(deriveSeed(plan.seed, "userpool", 0)); // dedicated stream, consumed fully before the bulk loop
  // poolTag MUST stay seed-derived (NOT a per-run nonce): same seed must reproduce the same Username so the
  // catalog upsert reuses the existing User instead of spraying DUPLICATE_USERNAME-dodging orphan users.
  const poolTag = deriveSeed(plan.seed, "userpool-tag").toString(36);
  const seed8 = deriveSeed(plan.seed, "userpool").toString(16).padStart(8, "0");

  POOL_REGIONS.forEach((region, r) => {
    records.UserRole!.push({ _ref: `role-${r}`, Name: `Sales — ${region}`, DeveloperName: `dataseed_sales_${region.toLowerCase()}` } satisfies GenericRecord);
  });

  const profileRef = existingRef("Profile", "Name", plan.userProfileName);
  const refs: string[] = [];
  for (let i = 0; i < n; i++) {
    const first = up.pick(AE_NAMES);
    const last = up.pick(LAST_NAMES);
    const idx36 = i.toString(36); // base36 keeps the Alias <=8 chars + org-locally distinct up to the [1,50] cap
    records.User!.push({
      _ref: `user-${i}`,
      _refs: { ProfileId: profileRef }, // HARD: a User without a Profile is invalid → skip-and-report
      _softRefs: { UserRoleId: `role-${i % POOL_REGIONS.length}` }, // SOFT: a User is valid without a role
      Username: `${first}.${last}.${seed8}.${i}@dataseed-${poolTag}.example`.toLowerCase(), // globally unique, non-routable .example TLD
      FirstName: first,
      LastName: last,
      Email: `${first}.${last}@dataseed-${poolTag}.example`.toLowerCase(),
      Alias: `${(first.slice(0, 3) + last.slice(0, 2)).toLowerCase()}${idx36}`, // <=8, soft-unique
      IsActive: true, // an inactive user can't own records (INACTIVE_OWNER_OR_USER)
      ...USER_DEFAULTS,
    } satisfies GenericRecord);
    refs.push(`user-${i}`);
  }
  return refs;
}

/** The User-pool refs WITHOUT emitting records — for the bulk pass to resolve OwnerId when the scaffold
 *  (which emits the User rows once) ran in a separate streaming pass. Pure function of the pool size:
 *  the refs are just `user-0..user-(n-1)`, identical to what emitUserPool returns. */
function userPoolRefs(plan: { userPoolSize: number }): string[] {
  return plan.userPoolSize > 0 ? Array.from({ length: plan.userPoolSize }, (_, i) => `user-${i}`) : [];
}

export function salescloudGenerate(ctx: GenerateContext): GenerateOutput {
  const { plan, rng, asOf } = ctx;
  const records: BundleRecords = { Product2: [], PricebookEntry: [], Campaign: [], UserRole: [], User: [], Account: [], Contact: [], Opportunity: [], OpportunityContactRole: [], OpportunityLineItem: [], Lead: [], CampaignMember: [], EmailMessage: [], ContentVersion: [], Task: [], Event: [], Case: [], CaseComment: [], Asset: [] };
  const copyRequests: CopyRequest[] = [];
  const convertLeads: LeadConversion[] = []; // Phase C: post-load Lead→Account/Contact/Opp directives

  // Streaming seam (corpus warehouse): emit the up-front scaffold, a bulk slice, or both (default).
  // `bulkRange` lets a caller stream a 100K corpus without holding it all in memory; safe to slice
  // because the bulk tier derives purely from (seed, accountIndex) and never reads the foreground rng.
  const emitScaffold = !ctx.bulkRange || ctx.bulkRange.scaffold;
  const emitBulk = !ctx.bulkRange || !ctx.bulkRange.scaffold;
  const bulkStart = ctx.bulkRange?.start ?? 0;
  const bulkEnd = ctx.bulkRange ? ctx.bulkRange.end : plan.population;

  // v17: the shared campaign set — scaled from 5 hand-authored to ~30 quarterly/always-on programs over ~3
  // years. Built deterministically (so campaign-N refs are stable across the scaffold + every bulk slice),
  // emitted ONLY in the scaffold pass below, and referenced by the bulk CampaignMembers (demand-gen funnel).
  const campaignSet = buildBulkCampaigns(rng.derive("campaigns"));
  const campaignCount = campaignSet.length;

  // Product catalog + standard-pricebook entries — seeded ONCE, shared across every deal. The loader
  // resolves the standard Pricebook2 (a pre-existing org record) for the Pricebook2Id sentinel; if it
  // can't, the PricebookEntries (and the line items below) cleanly skip while the deals still load.
  (emitScaffold ? PRODUCTS : []).forEach((p, i) => {
    records.Product2!.push({ _ref: `product-${i}`, Name: p.name, ProductCode: p.code, Family: p.family, IsActive: true } satisfies GenericRecord);
    records.PricebookEntry!.push({
      _ref: `pbe-${i}`,
      _refs: { Product2Id: `product-${i}`, Pricebook2Id: STANDARD_PRICEBOOK_REF }, // HARD: a PBE without its pricebook is invalid
      UnitPrice: p.list,
      IsActive: true,
    } satisfies GenericRecord);
  });

  // Marketing campaigns — seeded ONCE, shared. Past campaigns are Completed, recent ones In Progress.
  // Upserted by Name at load (declared catalog), so re-loads reuse them instead of duplicating.
  (emitScaffold ? campaignSet : []).forEach((c, i) => {
    const start = forwardDate(asOf, -(c.agoDays + 21));
    const end = forwardDate(asOf, -(c.agoDays - 14));
    records.Campaign!.push({
      _ref: `campaign-${i}`,
      Name: c.name,
      Type: c.type,
      Status: c.agoDays > 60 ? "Completed" : "In Progress",
      IsActive: true,
      StartDate: start,
      EndDate: end,
    } satisfies GenericRecord);
  });

  // Distinct anchor assignment: shuffle once, then SPREAD across distinct industries (round-robin over the
  // sfIndustry groups) so a small foreground sample doesn't cluster on one industry — the audit's "all 3
  // sampled deals were Technology" tell. The first N foreground deals get N DISTINCT industries (when the
  // pool has that many); only past the industry count do industries repeat. Past the pool size, anchors reuse.
  // Exclude anchors whose OWN product collides with SELLER_PITCH's category (a horizontal data/analytics/
  // integration platform) — no amount of grounding wording fixes a foreground deal pitching Snowflake/
  // Confluent/MongoDB their own product space. Still usable as a bulk/company reference elsewhere; just not
  // as a hero foreground prospect.
  const shuffled = rng.derive("anchors").shuffle(ANCHORS.filter((a) => !a.selfProductRisk));
  const byIndustry = new Map<string, Anchor[]>();
  for (const a of shuffled) {
    const list = byIndustry.get(a.sfIndustry);
    if (list) list.push(a);
    else byIndustry.set(a.sfIndustry, [a]);
  }
  const industryGroups = [...byIndustry.values()];
  const anchors: Anchor[] = [];
  for (let drained = false; !drained; ) {
    drained = true;
    for (const g of industryGroups) {
      const next = g.shift();
      if (next) {
        anchors.push(next);
        drained = false;
      }
    }
  }

  // Run-level name reservation across foreground deals — so a distinctive first name OR surname never recurs
  // at two accounts (the audit's Mwangi/Becker/Carlos cross-deal tells; a full-name-only key let surnames
  // repeat with a different first name). Safe to share across units: the foreground scaffold is generated in
  // ONE pass (stream.ts emits it once, scaffold:true), so this is order-stable and never touches the bulk
  // tier's per-account streaming parity. Past the pool size names gracefully reuse — realistic at scale,
  // conspicuous only in small demos.
  const usedFirstRun = new Set<string>();
  const usedLastRun = new Set<string>();
  // Run-level AE (selling-side rep) name reservation — same rationale as the buyer-side cast reservation:
  // a rep first name should not recur across foreground deals until the pool is exhausted (the audit's
  // repeated-AE cross-deal tell). Order-stable for the same reason: the foreground scaffold is generated in
  // ONE pass. Picks deterministically off the per-deal rng; wraps (reuses) only once every name is taken.
  const usedAeRun = new Set<string>();
  const pickAeName = (r: Rng): string => {
    const fresh = AE_NAMES.filter((n) => !usedAeRun.has(n));
    const choice = r.pick(fresh.length ? fresh : AE_NAMES); // exhausted → allow reuse (realistic at scale)
    usedAeRun.add(choice);
    return choice;
  };

  for (const unit of emitScaffold ? plan.units : []) {
    const r = makeRng(unit.seed); // tie generation to the plan's per-unit seed (order-independent)
    // The identity seam (single-account protocol): an LLM-authored SYNTHETIC company for this unit if one
    // was supplied (seed-account), else the fixed real-anchor pool. Everything downstream reads `anchor` +
    // `grounding` unchanged, so the synthetic identity flows through the whole graph + every CopyRequest.
    const supplied = ctx.identities?.get(unit.index);
    const anchor = supplied ? identityToAnchor(supplied) : anchors[unit.index % anchors.length]!;
    const grounding = supplied ? identityToGrounding(supplied) : resolveGrounding(anchor); // real/synthetic context about THIS prospect
    const aeName = pickAeName(r.derive("ae")); // one stable, run-unique selling-side rep per deal
    const aeCard = voiceCardFor(aeName, undefined, true);
    const cycle = Math.floor(unit.index / anchors.length);
    const accountName = cycle === 0 ? anchor.name : `${anchor.name} (Div ${cycle + 1})`;
    const prof = SCENARIO_PROFILES[unit.scenario] ?? SCENARIO_PROFILES["healthy-tech"]!;
    const region = unit.traits.region ?? "NA";
    const band = unit.traits.dealSizeBand ?? "50K_100K";

    // ── wave-2 (v26): ONE HQ geo for the whole foreground unit. The Account billing block AND every Contact's
    // mailing/phone read the SAME city/state/country/dial code, so an account and its people can never disagree.
    // A REAL anchor gets its CURATED public HQ (a wrong city for a famous company is a worse tell than a blank);
    // a SYNTHETIC identity honors its authored HQ (ISO codes recovered only when the country is known — never
    // fabricated); a divisional clone / uncurated anchor gets a regional office. All new geo draws ride a FRESH
    // `geofields` sub-stream → the main stream `r` (and every copy stream) stays byte-identical.
    const gf = r.derive("geofields");
    let hqGeo: Geo;
    if (supplied) {
      const { city, country } = splitHq(supplied.hq);
      const known = geoForCountry(country);
      hqGeo = { city: city || known?.city || "", country: country || "United States", countryCode: known?.countryCode ?? "", state: "", stateCode: "" };
    } else if (cycle === 0 && ANCHOR_HQ[anchor.name]) {
      hqGeo = ANCHOR_HQ[anchor.name]!; // curated real HQ — pure lookup, no RNG
    } else {
      hqGeo = gf.pick(GEO_BY_REGION[region] ?? GEO_BY_REGION["NA"]!); // divisional clone / uncurated anchor → regional office
    }
    // Derived geo fields — FIXED draw order (street: num→name→type, postal, source, ownership?, phone).
    const billingStreet = `${gf.int(10, 9990)} ${gf.pick([...STREET_NAMES])} ${gf.pick([...STREET_TYPES])}`;
    // ZIP bound to the STATE (ZIP3 prefix + 2 drawn digits) so a CA address never carries a TX ZIP — a cross-field
    // tell, like a wrong dial code. ONE draw (range only, vs the old random 5-digit) → re-bless stays Account-only.
    // Omitted for non-US / no-state (synthetic label-only) — never a wrong-format fake postal.
    const postalTail = String(gf.int(0, 99)).padStart(2, "0");
    const usZip3 = hqGeo.countryCode === "US" ? US_STATE_ZIP3[hqGeo.stateCode] : undefined;
    const billingPostal = usZip3 ? `${usZip3}${postalTail}` : undefined;
    const accountSource = gf.weighted(ACCOUNT_SOURCE);
    const ownership = supplied
      ? supplied.revenueUsd >= 1_000_000_000 ? (gf.bool(0.7) ? "Public" : "Private") : gf.bool(0.18) ? "Public" : "Private"
      : undefined; // ANCHOR: omit — never fabricate Public/Private for a real public company (the v25 no-size-fabrication stance)
    const acctPhone = bulkPhone(gf, hqGeo.country);

    const acctRef = `acct-${unit.index}`;
    records.Account!.push({
      _ref: acctRef,
      Name: accountName,
      Industry: anchor.sfIndustry,
      Website: `https://${anchor.domain}`,
      // A synthetic identity carries richer firmographics (headcount/revenue/description) a VP scans; the anchor
      // path gets the one size-free high-signal field: Type — Customer once it has a prior win, else Prospect.
      // (Headcount/revenue stay unset for real anchors — deriving them from the deal band would contradict a
      // known public company; the synthetic path carries authored ones.) Pure, no RNG.
      ...(supplied ? accountFirmographics(supplied, prof) : { Type: prof.priorWin ? "Customer - Direct" : "Prospect" }),
      // v24: customer sentiment in the STANDARD field — the deal's dossier shape projected to Hot/Warm/Cold.
      Rating: ratingForForeground(prof.shape),
      // ── wave-2 geo-coherent billing + phone (v19 DUAL-EMIT: the *Code field only when known — never guessed,
      // so a State/Country-Picklist org validates and a picklist-off org drops the code + keeps the label). ──
      ...(hqGeo.city ? { BillingCity: hqGeo.city } : {}),
      BillingStreet: billingStreet,
      ...(hqGeo.stateCode ? { BillingState: hqGeo.state, BillingStateCode: hqGeo.stateCode } : {}),
      ...(billingPostal ? { BillingPostalCode: billingPostal } : {}),
      BillingCountry: hqGeo.country,
      ...(hqGeo.countryCode ? { BillingCountryCode: hqGeo.countryCode } : {}),
      Phone: acctPhone,
      AccountSource: accountSource,
      ...(ownership ? { Ownership: ownership } : {}),
      _meta: { scenario: unit.scenario, sector: anchor.sector, region },
    } satisfies GenericRecord);

    // Contacts (persona mix).
    const contactCount = r.int(prof.contactRange[0], prof.contactRange[1]);
    const personas = prof.personas.slice(0, contactCount);
    while (personas.length < contactCount) personas.push("End User");
    const contactRefs: Array<{ ref: string; persona: string; name: string; email: string; card: VoiceCard }> = [];
    // Pick a name unused at the RUN level (across all foreground deals) first, then unused within THIS deal,
    // then anything — so a distinctive first name or surname doesn't recur across accounts until the pool is
    // exhausted, and a deal never has two "Elena"s or two "Reyes". One rng draw per pick (count-stable). The
    // run-level constraint subsumes within-deal uniqueness; the within-deal fallback only matters once a run
    // has consumed the whole pool (≈8 deals), where reuse is realistic anyway.
    const usedFirst = new Set<string>();
    const usedLast = new Set<string>();
    // v25: all NEW foreground-contact field draws (LeadSource) ride a DERIVED stream so the existing
    // name/email draws on `r` — and every downstream email/task/transcript stream — stay byte-identical.
    const cf = r.derive("contactfields");
    const pickName = (pool: readonly string[], usedDeal: Set<string>, usedRun: Set<string>): string => {
      const freshRun = pool.filter((x) => !usedRun.has(x));
      const freshDeal = pool.filter((x) => !usedDeal.has(x));
      const choice = r.pick(freshRun.length ? freshRun : freshDeal.length ? freshDeal : pool);
      usedDeal.add(choice);
      usedRun.add(choice);
      return choice;
    };
    personas.forEach((persona, j) => {
      const first = pickName(FIRST_NAMES, usedFirst, usedFirstRun);
      const last = pickName(LAST_NAMES, usedLast, usedLastRun);
      const detail = PERSONA_DETAIL[persona] ?? PERSONA_DETAIL["End User"]!;
      const title = cf.pick(detail.titles); // per-deal pick — two accounts don't share a buying-committee title
      const ref = `contact-${unit.index}-${j}`;
      const email = `${emailLocal(first, last)}@${anchor.domain.toLowerCase()}`; // diacritic-folded → load-safe
      const card = voiceCardFor(`${first} ${last}`, persona, false);
      records.Contact!.push({
        _ref: ref,
        _refs: { AccountId: acctRef },
        FirstName: first,
        LastName: last,
        Title: title,
        Email: email,
        // v25 saturation: Department coheres with the persona (a CFO in Finance, the IT-Security blocker in IT);
        // LeadSource (derived stream) is how this contact entered the funnel. Both standard fields a rep filters on.
        Department: detail.dept,
        LeadSource: cf.weighted(CONTACT_LEADSOURCE),
        // ── wave-2 (v26): the contact inherits the account's HQ — MailingCity == Account.BillingCity and the
        // phone dial code matches the account (one HQ, fanned out). Draws ride the shared `gf` stream, in persona
        // order AFTER the account-level geo draws, so the sequence stays deterministic.
        Phone: bulkPhone(gf, hqGeo.country),
        ...(gf.bool(0.6) ? { MobilePhone: bulkPhone(gf, hqGeo.country) } : {}),
        ...(hqGeo.city ? { MailingCity: hqGeo.city } : {}),
        ...(hqGeo.stateCode ? { MailingState: hqGeo.state, MailingStateCode: hqGeo.stateCode } : {}),
        MailingCountry: hqGeo.country,
        ...(hqGeo.countryCode ? { MailingCountryCode: hqGeo.countryCode } : {}),
        _meta: { persona, role: detail.role },
      } satisfies GenericRecord);
      contactRefs.push({ ref, persona, name: `${first} ${last}`, email, card });
    });

    // ── wave-2 (v26): the org chart. Wire Contact.ReportsToId (self-lookup) as a _softRef to the in-cast
    // manager — a pure, persona-coherent reporting line (CFO at top; reports point strictly up-rank → acyclic).
    // It's a SOFT ref: the single-batch Contact load can't resolve a sibling's Id yet, so it drops cleanly on a
    // live org (the field is present in the corpus/warehouse/MCP substrate, where wave-2 saturation is read;
    // in-org landing needs depth-ordered sub-batching — see docs/open-questions/). Pure, no RNG.
    const firstContactIdx = records.Contact!.length - contactRefs.length;
    contactRefs.forEach((_c, j) => {
      const mgrRef = reportsToRefFor(contactRefs, j);
      if (!mgrRef) return; // top-of-tree → no ReportsToId key
      const row = records.Contact![firstContactIdx + j]!;
      row._softRefs = { ...((row._softRefs as Record<string, string> | undefined) ?? {}), ReportsToId: mgrRef };
    });

    // Opportunity (band → amount; scenario → stage/close).
    const [lo, hi] = BAND_RANGE[band] ?? [50_000, 100_000];
    const amount = roundTo(r.int(lo, hi), 1_000);
    // StageName is DERIVED from deal maturity (EB engaged? budget contested?) so it can't lag the prose —
    // the audit's "Stage=Proposal but the deal is verbally won and papering" cross-object tell. Same signals
    // the dossier's settled facts use → stage, established facts, and prose all agree.
    const hasEB = contactRefs.some((c) => c.persona === "Economic Buyer");
    const stage = deriveStage(prof.shape, hasEB, r);
    const closeDate = forwardDate(asOf, r.int(prof.closeInDays[0], prof.closeInDays[1]));
    const oppRef = `opp-${unit.index}`;
    // Attribute most deals to a primary campaign source (the funnel story); soft so the deal loads
    // even if the campaign was skipped. A derived stream keeps existing email/task output unchanged.
    const campaignFor = r.derive("campaign").bool(0.7) ? `campaign-${r.derive("campaign-pick").int(0, campaignCount - 1)}` : null;
    // Captured so the authored Deal Dossier (below) can ride on its `_meta` — one spine per deal, the
    // single source of truth the deal's emails/tasks/transcripts are generated FROM. `_meta` is stripped
    // before load, so this is preview/inspection metadata, not a field write.
    // v25 saturation: the standard deal fields a VP scans on the Opportunity — all DERIVED from the pinned
    // stage / priorWin / product so they can't contradict the narrative (Probability/Forecast track the stage;
    // Type is Existing iff the account already bought; the NextStep + Description splice the deal's own product
    // line + the grounded buying department). New draws ride the `oppfields` stream → copy streams byte-stable.
    const of = r.derive("oppfields");
    const oppBand = stageBand(stage);
    const oppRow: GenericRecord = {
      _ref: oppRef,
      _refs: { AccountId: acctRef },
      _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF, ...(campaignFor ? { CampaignId: campaignFor } : {}) }, // SOFT: pricebook + campaign source, load even without either
      Name: `${accountName} — Platform Expansion`,
      Amount: amount,
      StageName: stage,
      CloseDate: closeDate,
      Type: prof.priorWin ? "Existing Business" : "New Business",
      LeadSource: of.weighted(OPP_LEADSOURCE),
      Probability: PROBABILITY[stage] ?? 10,
      ForecastCategoryName: FORECASTCATEGORY[stage] ?? "Pipeline",
      NextStep: of.pick(NEXTSTEP[oppBand === "closed" ? "mid" : oppBand]), // the live deal is open → always a next step
      Description: buildOppDescription(of, oppDescKey(oppBand, "open"), familyRollup(PRODUCTS[0]!.name), grounding.buyingDept),
      _meta: { scenario: unit.scenario, band, region, intent: prof.intent },
    };
    records.Opportunity!.push(oppRow);

    // OpportunityContactRoles — Role + IsPrimary are DERIVED from persona so the OCR agrees with the
    // prose's buying-committee logic: the deal's decision authority (the Economic Buyer who holds budget
    // sign-off, or the Champion when there's no EB) is the lone "Decision Maker" + IsPrimary contact, and
    // the procurement Skeptic / IT-Security Blocker is NEVER tagged "Decision Maker" (they defer sign-off
    // to the CFO in every email/transcript). `contactRefs` is in `personas` order, so the index lines up.
    const personasList = contactRefs.map((c) => c.persona);
    const authorityIdx = decisionAuthorityIndex(personasList);
    // IsPrimary still needs exactly one contact. With a decision authority it's them; otherwise (rfp/early
    // casts with no EB or Champion — the real decision-maker is unnamed, "above" the named roster) the
    // primary is the most-engaged named contact (our Coach, else the Technical Evaluator running the eval),
    // and NO ONE is tagged "Decision Maker" — matching the prose, where sign-off escalates to someone not yet met.
    const coachIdx = personasList.indexOf("Coach");
    const teIdx = personasList.indexOf("Technical Evaluator");
    const primaryIdx = authorityIdx >= 0 ? authorityIdx : coachIdx >= 0 ? coachIdx : teIdx >= 0 ? teIdx : 0;
    contactRefs.forEach((c, j) => {
      records.OpportunityContactRole!.push({
        _refs: { OpportunityId: oppRef, ContactId: c.ref },
        Role: ocrRoleFor(c.persona, j === authorityIdx), // "Decision Maker" only when an authority exists (j === -1 never matches)
        IsPrimary: j === primaryIdx, // exactly one primary: the decision authority, else the most-engaged contact — never the blocker
      } satisfies GenericRecord);
    });

    // OpportunityLineItems — real per-line economics. Always include the Platform License (the
    // dominant line), plus 1–3 shuffled add-ons; split Amount across them so the line totals
    // reconcile EXACTLY to Opportunity.Amount. Derived rng → existing email/task output unchanged.
    const lr = r.derive("lineitems");
    // Bigger deals carry more line items, so no single add-on balloons (a $963K "sandbox" reads fake).
    const sizeFloor = amount >= 500_000 ? 5 : amount >= 100_000 ? 4 : amount >= 25_000 ? 3 : 2;
    const lineCount = Math.min(PRODUCTS.length, lr.int(sizeFloor, sizeFloor + 1));
    const addOns = lr.shuffle(PRODUCTS.map((_, i) => i).slice(1)).slice(0, lineCount - 1);
    const productIdx = [0, ...addOns]; // line 0 = Platform License (largest share)
    const shares = splitAmount(amount, productIdx.length);
    productIdx.forEach((pi, j) => {
      records.OpportunityLineItem!.push({
        _ref: `oli-${unit.index}-${j}`,
        _refs: { OpportunityId: oppRef, PricebookEntryId: `pbe-${pi}` }, // HARD: both required for a line item
        Quantity: 1,
        UnitPrice: shares[j], // negotiated line price; Σ UnitPrice = Amount (so Amount survives the line-item recalc)
        _meta: { product: PRODUCTS[pi]!.name },
      } satisfies GenericRecord);
    });

    // Phase B — cross-deal history. For accounts the arc marks with a priorWin (churning renewal,
    // healthy expansion), seed a PRIOR closed-won deal (the original land) so the account has real
    // multi-deal history — exactly what an account-level intelligence layer aggregates across, not a single
    // isolated opp. Historical context only: backdated close, its own reconciling line items + a
    // primary OCR, but NO emails/tasks (nothing new to synthesize from a closed deal). Draws from a
    // dedicated "priorwin" rng stream so existing email/task output stays byte-identical.
    // Set ONLY on priorWin units (left undefined otherwise) so the dossier frames the live deal as a
    // net-new eval for non-customers and an expansion on a live deployment for existing customers.
    let priorWinFacts: { amountUsd: number; closeDate: string; product: string } | undefined;
    if (prof.priorWin) {
      const pw = r.derive("priorwin");
      const factor = pw.int(Math.round(prof.priorWin.amountFactor[0] * 100), Math.round(prof.priorWin.amountFactor[1] * 100)) / 100;
      const priorAmount = Math.max(1_000, roundTo(amount * factor, 1_000));
      const priorClose = forwardDate(asOf, -pw.int(prof.priorWin.agoDays[0], prof.priorWin.agoDays[1]));
      const priorRef = `opp-${unit.index}-prior`;
      // v25: the prior win was the net-new LAND (Type "New Business" — it pre-dates today's expansion), closed,
      // so Probability/Forecast are terminal. New draws ride a child of the existing `priorwin` stream so the
      // prior deal's line items + OCR below stay byte-identical.
      const pwf = pw.derive("fields");
      records.Opportunity!.push({
        _ref: priorRef,
        _refs: { AccountId: acctRef },
        _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF },
        Name: `${accountName} — Initial Rollout`,
        Amount: priorAmount,
        StageName: "Closed Won",
        CloseDate: priorClose,
        Type: "New Business",
        LeadSource: pwf.weighted(OPP_LEADSOURCE),
        Probability: PROBABILITY["Closed Won"] ?? 100,
        ForecastCategoryName: FORECASTCATEGORY["Closed Won"] ?? "Closed",
        Description: buildOppDescription(pwf, oppDescKey("late", "won"), familyRollup(PRODUCTS[0]!.name), grounding.buyingDept),
        _meta: { scenario: unit.scenario, band, region, prior: true },
      } satisfies GenericRecord);
      // Line items reconcile EXACTLY to priorAmount (same recalc-survival rule as the live deal).
      const pIdxs = [0, ...pw.derive("lines").shuffle(PRODUCTS.map((_, i) => i).slice(1)).slice(0, (priorAmount >= 100_000 ? 3 : 2) - 1)];
      const pShares = splitAmount(priorAmount, pIdxs.length);
      pIdxs.forEach((pi, j) => {
        records.OpportunityLineItem!.push({
          _ref: `oli-${unit.index}-prior-${j}`,
          _refs: { OpportunityId: priorRef, PricebookEntryId: `pbe-${pi}` },
          Quantity: 1,
          UnitPrice: pShares[j],
          _meta: { product: PRODUCTS[pi]!.name, prior: true },
        } satisfies GenericRecord);
      });
      // The buyer who signed the original land anchors the prior deal's OCR — the SAME decision authority
      // (Economic Buyer, else Champion) that owns the live deal, so the cross-deal history is coherent
      // (the CFO who holds sign-off, not whoever happens to sit at contact index 0).
      const signer = contactRefs[decisionAuthorityIndex(contactRefs.map((c) => c.persona))];
      if (signer) {
        records.OpportunityContactRole!.push({
          _refs: { OpportunityId: priorRef, ContactId: signer.ref },
          Role: "Decision Maker", // the signer of the original land IS the decision authority
          IsPrimary: true,
        } satisfies GenericRecord);
      }

      // ── Installed base + support history (cross-object coherence) — a year-old customer that ONLY
      // carries a closed-won Opp reads as never having bought. The prior land seeds an Asset (the
      // deployed footprint of PRODUCTS[0], always a line on the prior deal) plus 1–2 support Cases so
      // the expansion narrates against a real deployment, not a greenfield eval. The buyer/signer (the
      // same decision authority that owns the prior deal) anchors the Asset/Cases. Draws on a "footprint"
      // sub-stream of `pw` so existing email/task/transcript output stays byte-identical (append-only).
      const fp = pw.derive("footprint");
      const landProduct = PRODUCTS[0]!; // index 0 (Platform License) is always on the prior deal's line items
      const installDate = forwardDate(priorClose, fp.int(3, 21)); // deployed a few days/weeks after the close
      const owner = signer ?? contactRefs[0]; // the buyer who signed the land anchors the installed base
      // Asset — the deployed installed base from the land. Status OMITTED: Asset.Status is org-configurable
      // (not in picklists.ts → would NULL-fail INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST on a vanilla org).
      records.Asset!.push({
        _ref: `asset-${unit.index}-prior`,
        _refs: { AccountId: acctRef, Product2Id: "product-0", ...(owner ? { ContactId: owner.ref } : {}) },
        Name: landProduct.name,
        SerialNumber: `SN-${(unit.index * 19 + 7919).toString(36).toUpperCase()}`,
        Quantity: 1,
        Price: priorAmount, // the land's value as the asset's book price
        PurchaseDate: priorClose, // bought at the prior close
        InstallDate: installDate, // deployed shortly after
        _meta: { prior: true, product: landProduct.name },
      } satisfies GenericRecord);

      // Support history — 1–2 Cases on the installed base (one resolved/Closed for history, sometimes a
      // second still Working). Picklists from the load-safe std sets ONLY (Case.Status/Origin/Priority);
      // Case Type/Reason OMITTED (org-configurable). Dates sit between the land's close and asOf.
      // A pool of 5 (was 2) distinct subject/description/resolution triples, picked per-case — the old fixed
      // 2-entry pool meant any two prior-win accounts drawing the same caseCount got byte-identical support
      // history (verified: Uber and Sweetgreen both carried the exact same two Case Subject/Description pairs).
      const CASE_HISTORY_SCENARIOS: ReadonlyArray<{ subject: string; closedDesc: string; openDesc: string; resolution: string }> = [
        {
          subject: `Intermittent sync latency on ${landProduct.name}`,
          closedDesc: `Reported degraded performance on the ${landProduct.name} deployment; resolved after a configuration fix.`,
          openDesc: `Open issue on the ${landProduct.name} deployment; support engaged, awaiting a fix window.`,
          resolution: `Root cause traced to the ${landProduct.name} sync config; corrected and confirmed resolved`,
        },
        {
          subject: `SSO session timeout after ${landProduct.name} upgrade`,
          closedDesc: `Users reported repeated SSO session drops following the ${landProduct.name} upgrade; resolved by re-issuing the SAML certificate.`,
          openDesc: `SSO session timeouts persisting after the ${landProduct.name} upgrade; the identity team is engaged.`,
          resolution: `Traced to an expired SAML certificate in the ${landProduct.name} identity-provider config; reissued and confirmed resolved`,
        },
        {
          subject: `${landProduct.name} API rate-limit errors during peak load`,
          closedDesc: `Integration jobs against the ${landProduct.name} API began failing with 429s during month-end peak load; resolved by raising the account's rate-limit tier.`,
          openDesc: `${landProduct.name} API calls are intermittently rate-limited during peak load; support is reviewing tier options.`,
          resolution: `Confirmed the account was still on the default rate-limit tier; upgraded it and load-tested`,
        },
        {
          subject: `Report export timing out on ${landProduct.name}`,
          closedDesc: `Large report exports from ${landProduct.name} began timing out; resolved by moving the export to the async batch pipeline.`,
          openDesc: `Report exports from ${landProduct.name} are intermittently timing out on large datasets; support is investigating.`,
          resolution: `Root cause was a synchronous export path hitting the platform's request timeout; moved to the async batch export`,
        },
        {
          subject: `Data sync gap between ${landProduct.name} and the CRM`,
          closedDesc: `A field-mapping mismatch caused records to silently drop out of the ${landProduct.name} sync; resolved by correcting the mapping.`,
          openDesc: `Records are intermittently missing from the ${landProduct.name} sync; the field mapping is under review.`,
          resolution: `Found a stale field mapping left over from a prior schema change; corrected it and backfilled the gap`,
        },
      ];
      const caseCount = fp.int(1, 2);
      const daysInstallToNow = Math.max(1, Math.round((new Date(asOf).getTime() - new Date(installDate).getTime()) / DAY_MS));
      for (let c = 0; c < caseCount; c++) {
        const closed = c === 0; // the first Case is resolved history; a 2nd (if any) is still open
        const reporter = fp.pick(contactRefs);
        const scene = fp.pick(CASE_HISTORY_SCENARIOS);
        records.Case!.push({
          _ref: `case-${unit.index}-prior-${c}`,
          _refs: { AccountId: acctRef, ...(reporter ? { ContactId: reporter.ref } : {}) },
          Subject: scene.subject,
          Status: closed ? "Closed" : "Working",
          Origin: fp.pick([...CASE_ORIGIN]),
          Priority: fp.pick([...CASE_PRIORITY]),
          Description: closed ? scene.closedDesc : scene.openDesc,
          // ClosedDate was previously OMITTED on a "Closed" foreground Case (the bulk-tier equivalent always
          // sets it) — anchored between install and asOf so it can't land in the future.
          ...(closed ? { ClosedDate: forwardDateTime(installDate, Math.round(daysInstallToNow * fp.float(0.2, 0.7)), 12) } : {}),
          _meta: { prior: true },
        } satisfies GenericRecord);
        if (closed) {
          records.CaseComment!.push({
            _refs: { ParentId: `case-${unit.index}-prior-${c}` },
            CommentBody: `${scene.resolution} with ${reporter?.name ?? "the reporter"}.`,
            _meta: { prior: true },
          } satisfies GenericRecord);
        }
      }

      // v28 CHURN SIGNAL — only for the churning-account scenario (the one arc where the LIVE deal is an at-risk
      // RENEWAL, not a net-new eval). Add an ESCALATED support Case grounded in the renewal risk: the churn
      // leading indicator an analyst / AI reads alongside the Cold Rating + the stalling deal + the negative
      // sentiment trajectory. A fresh `churn` sub-stream keeps the prior Cases above byte-identical, and scenario-
      // gated (not shape-gated) so a scenario-config change can't silently mis-fire it onto a healthy renewal.
      if (unit.scenario === "churning-account") {
        const ch = r.derive("churn");
        const eb = contactRefs.find((c) => c.persona === "Economic Buyer"); // the budget-holder gating the renewal
        // churning-account's persona mix (variability.ts) is [Economic Buyer, Skeptic, Blocker] — never a
        // Champion — so the reporter is always the first non-EB contact (a CFO doesn't escalate a renewal
        // risk to themselves).
        const reporter = contactRefs.find((c) => c !== eb) ?? contactRefs[0];
        // Derived from the LIVE deal's actual CloseDate (not an independent draw) so the Case narrative can
        // never contradict the Opportunity it's describing (a deal closing in 14 days can't carry a Case
        // saying "~68 days to the renewal decision").
        const daysToRenewal = Math.max(1, Math.round((new Date(closeDate).getTime() - new Date(asOf).getTime()) / 86_400_000));
        const [subjLead, descOpen] = ch.pick([
          [`${landProduct.name} reliability escalation ahead of renewal`, "raised a formal escalation"] as const,
          [`Repeat ${landProduct.name} incidents flagged as a renewal risk`, "opened a Sev-1 escalation"] as const,
          [`${landProduct.name} stability review before the renewal decision`, "escalated to the account team"] as const,
        ]);
        const gate = eb && eb !== reporter // only name the CFO gate when it's a DIFFERENT person than the reporter
          ? `${eb.name} has made continued spend contingent on a remediation plan`
          : "the renewal has been flagged at risk in the account review";
        records.Case!.push({
          _ref: `case-${unit.index}-churn`,
          _refs: { AccountId: acctRef, ...(reporter ? { ContactId: reporter.ref } : {}) },
          Subject: subjLead,
          Status: "Escalated",
          Origin: "Phone",
          Priority: "High",
          Description: `${reporter?.name ?? "The account team"} ${descOpen} with ~${daysToRenewal} days to the renewal decision: the ${landProduct.name} deployment has taken repeated production hits this quarter and ${gate}. Support is engaged; renewal is at risk without a committed fix.`,
          _meta: { churn: true },
        } satisfies GenericRecord);
      }

      // Hand the prior-win facts to the dossier so the spine frames this as an EXPANSION on a live
      // deployment (amount/date/product all agree with the records emitted above).
      priorWinFacts = { amountUsd: priorAmount, closeDate: priorClose, product: landProduct.name };
    }

    // ── The Deal Dossier (Phase 4) — author the narrative spine, then generate every artifact FROM it ──
    // The inversion: instead of emitting emails/tasks/transcripts on a cadence curve and filling each body
    // in isolation, we author ONE spine (arc + cast + a chronological beat timeline + signal aims) and walk
    // its beats to produce the records — so the whole account tells one coherent story. 4A uses the static
    // (deterministic) dossier; 4B swaps in a Claude-authored one behind the same shape. The dossier draws on
    // the per-unit rng in email→task→transcript order, so counts stay in range and the bundle stays seed-stable.
    const dossier = buildDealDossier({
      scenario: unit.scenario,
      prof,
      accountName,
      sector: anchor.sector,
      amount,
      closeDate,
      asOf,
      unitIndex: unit.index,
      aeName,
      stageName: stage, // the Opp's StageName — pinned onto the dossier so copy holds the prose to this maturity
      cast: contactRefs.map((c) => ({ ref: c.ref, name: c.name, persona: c.persona })),
      grounding,
      priorWin: priorWinFacts, // set only on priorWin units → frames the deal as an expansion on a live deployment
      rng: r,
    });
    (oppRow._meta as Record<string, unknown>).dossier = dossier; // the spine rides on the deal (preview/inspection; stripped before load)

    const byRef = new Map(contactRefs.map((c) => [c.ref, c]));
    const aeAddress = `${aeName.toLowerCase().replace(/[^a-z]+/g, ".")}@${SELLER_DOMAIN}`; // stable selling-side address on OUR fixed brand (never the prospect's own domain)
    const threadId = `thread-${unit.index}`;
    const seedSubject = `${accountName} — ${SUBJECT_HINT[unit.scenario] ?? "next steps"}`; // one subject the whole thread shares
    const primary = contactRefs[0];
    const beatIntent = (b: { summary: string; conveys?: string }) => `${b.summary}${b.conveys ? ` ${b.conveys}` : ""}`;

    // EmailMessages — one per email beat; bodies deferred to copy requests (the no-vapor-ware seam).
    const emailBeats = dossier.beats.filter((b) => b.kind === "email");
    emailBeats.forEach((beat, k) => {
      const incoming = beat.direction === "inbound";
      const participant = beat.participantRef ? byRef.get(beat.participantRef) : undefined;
      const writerCard = incoming ? (participant?.card ?? aeCard) : aeCard; // the person authoring this email
      records.EmailMessage!.push({
        _ref: beat.ref,
        _refs: { RelatedToId: oppRef },
        MessageDate: beat.day,
        Incoming: incoming,
        Status: incoming ? "0" : "3", // EmailMessage.Status (required): 0=New (inbound) / 3=Sent (outbound)
        FromAddress: incoming ? (participant?.email ?? aeAddress) : aeAddress,
        FromName: beat.author,
        ToAddress: incoming ? aeAddress : (primary?.email ?? aeAddress),
        Subject: "", // copy layer
        TextBody: "", // copy layer
        _meta: { scenario: unit.scenario, speaker: beat.author, persona: participant?.persona, sentiment: beat.sentiment, latest: k === emailBeats.length - 1 },
      } satisfies GenericRecord);
      copyRequests.push({
        id: beat.ref,
        kind: "email",
        scenario: unit.scenario,
        beatIntent: beatIntent(beat),
        speakers: [beat.author],
        facts: { amountUsd: amount, closeDate, primaryContact: primary?.name, counterpart: participant?.name, sector: anchor.sector, sells: SELLER_PITCH, grounding },
        seq: { index: k, total: emailBeats.length },
        voiceCard: writerCard,
        threadId,
        inReplyTo: k > 0 ? `email-${unit.index}-${k - 1}` : undefined,
        seedSubject,
        beat,
      } satisfies CopyRequest);
    });

    // Tasks — logged sales activities (the rep's call/meeting notes), one per task beat. TaskSubtype='Email'
    // is REQUIRED: many downstream email/activity triggers only fan out on Email-subtype Tasks (a typical gate is `TaskSubtype != 'Email'
    // → continue`), so a Call subtype yields 0 signals. Note variety (call vs meeting) lives in the copy, not
    // in restricted fields (no call fields set). A live insert of one such Task produced 13 Task-sourced signals.
    const taskBeats = dossier.beats.filter((b) => b.kind === "task");
    const tpf = r.derive("taskpriority");
    taskBeats.forEach((beat, k) => {
      const who = (beat.participantRef ? byRef.get(beat.participantRef) : undefined) ?? primary;
      records.Task!.push({
        _ref: beat.ref,
        _refs: { WhoId: who?.ref, WhatId: oppRef }, // attributed Contact + the deal
        Subject: "", // copy layer
        Description: "", // copy layer
        ActivityDate: beat.day.slice(0, 10), // Task.ActivityDate is a Date (YYYY-MM-DD)
        Status: "Completed",
        // Priority DERIVED from the beat's sentiment — a rep genuinely flags a Risk/Negative touch High,
        // not the flat "Normal" every foreground task previously carried regardless of scenario/sentiment
        // (even on at-risk/churning deals). Bulk tasks already vary (BULK_PRIORITY_MIX); this brings the
        // narrative-bearing tier to parity.
        Priority: beat.sentiment === "Risk" ? (tpf.bool(0.7) ? "High" : "Normal")
          : beat.sentiment === "Negative" ? (tpf.bool(0.4) ? "High" : "Normal")
          : beat.sentiment === "Positive" ? (tpf.bool(0.1) ? "Low" : "Normal")
          : "Normal",
        TaskSubtype: "Email", // REQUIRED — many downstream email/activity triggers only fan out on Email-subtype Tasks; a Call-subtype Task produces no signal
        _meta: { scenario: unit.scenario, persona: who?.persona, activity: beat.detail?.activity, sentiment: beat.sentiment, kind: "task" },
      } satisfies GenericRecord);
      copyRequests.push({
        id: beat.ref,
        kind: "task",
        scenario: unit.scenario,
        beatIntent: beatIntent(beat),
        speakers: [aeName],
        facts: { amountUsd: amount, closeDate, primaryContact: primary?.name, counterpart: who?.name, sector: anchor.sector, sells: SELLER_PITCH, grounding },
        seq: { index: k, total: taskBeats.length },
        voiceCard: aeCard,
        threadId,
        beat,
      } satisfies CopyRequest);
    });

    // Call-recording transcripts — one per transcript beat, stored as ContentVersion files (VTT) linked to
    // the deal via FirstPublishLocationId → the Opp. The shape a tool like Einstein Conversation Insights or
    // Gong produces. Bodies deferred to copy requests (kind "transcript") → ContentVersion.VersionData.
    const inboxBeats = dossier.beats.filter((b) => b.kind === "transcript");
    inboxBeats.forEach((beat, k) => {
      const speaker = (beat.participantRef ? byRef.get(beat.participantRef) : undefined) ?? primary;
      const sourceSystem = (beat.detail?.sourceSystem as string) ?? "Einstein Conversation Insights";
      const contentKind = (beat.detail?.contentKind as string) ?? "Transcript";
      const day = beat.day.slice(0, 10);
      const slug = sourceSystem.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      records.ContentVersion!.push({
        _ref: beat.ref,
        _refs: { FirstPublishLocationId: oppRef }, // publishes the file against the Opp (auto-links on insert)
        Title: `${sourceSystem} ${contentKind.toLowerCase()} — ${accountName} (${day})`,
        PathOnClient: `${slug}-call-${day}.vtt`,
        VersionData: "", // copy layer fills the transcript text (VTT)
        Description: `${contentKind} of a ${(beat.detail?.activity as string) ?? "call"} with ${speaker?.name ?? "the prospect"} on the ${accountName} deal, via ${sourceSystem}.`,
        _meta: { scenario: unit.scenario, persona: speaker?.persona, activity: beat.detail?.activity, sentiment: beat.sentiment, kind: "transcript" },
      } satisfies GenericRecord);
      copyRequests.push({
        id: beat.ref,
        kind: "transcript",
        scenario: unit.scenario,
        beatIntent: beatIntent(beat),
        speakers: [speaker?.name ?? aeName, aeName],
        facts: { amountUsd: amount, closeDate, primaryContact: primary?.name, counterpart: speaker?.name, sector: anchor.sector, sells: SELLER_PITCH, grounding },
        seq: { index: k, total: inboxBeats.length },
        voiceCard: speaker?.card, // the buyer-side speaker's voice anchors the conversation
        threadId,
        beat,
      } satisfies CopyRequest);
    });
  }

  // ── Top of funnel (Phase C): leads + campaign responses + a few real conversions ──────────────
  // Leads are NEW prospects drawn from anchors NOT used as accounts in this bundle, so they stay
  // real-company-grounded and never collide with the seeded accounts. Most sit open in the funnel;
  // ~25% are flagged for a load-time conversion (Lead→Account/Contact/Opportunity via SOAP
  // convertLead — emitted as a directive the loader runs after inserts).
  const fr = rng.derive("funnel");
  const leadAnchors = anchors.slice(plan.units.length); // anchors not assigned to an account
  const leadCount = emitScaffold ? Math.min(leadAnchors.length, Math.max(4, Math.round(plan.units.length * 0.6))) : 0;
  for (let i = 0; i < leadCount; i++) {
    const a = leadAnchors[i]!;
    const first = fr.pick(FIRST_NAMES);
    const last = fr.pick(LAST_NAMES);
    const leadRef = `lead-${i}`;
    const willConvert = i < Math.max(1, Math.round(leadCount * 0.25)); // a few won from marketing
    records.Lead!.push({
      _ref: leadRef,
      FirstName: first,
      LastName: last,
      Company: a.name,
      Title: fr.pick(LEAD_TITLES),
      Email: `${first}.${last}@${a.domain}`.toLowerCase(),
      Status: willConvert ? "Working - Contacted" : fr.pick(LEAD_STATUSES_OPEN),
      LeadSource: fr.pick(LEAD_SOURCES),
      Industry: a.sfIndustry,
      _meta: { sector: a.sector, willConvert },
    } satisfies GenericRecord);
    // The campaign response that sourced this lead.
    records.CampaignMember!.push({
      _refs: { CampaignId: `campaign-${fr.int(0, campaignCount - 1)}`, LeadId: leadRef },
      Status: fr.pick(CAMPAIGN_MEMBER_STATUSES),
    } satisfies GenericRecord);
    if (willConvert) {
      convertLeads.push({ leadRef, convertedStatus: "Closed - Converted", opportunityName: `${a.name} — New Business` });
    }
  }

  // ── Background population (the scale tier) ──────────────────────────────────────────────────────
  // Extra accounts that make the org feel POPULATED without firing the pipeline: rich Account fields +
  // a realistic opps-per-account distribution (open / closed-won / closed-lost history over ~3 years),
  // but NO email/task/transcript signal streams — so each costs ~7 records and triggers ZERO synthesis
  // (the hero/bulk split, built in at the source). Procedurally named (company-names.ts) so 100K accounts
  // stay unique without "(Div N)". Foreground output above is byte-identical: every draw here comes from a
  // dedicated per-account "bulk" seed, never the streams the active loop / funnel use.
  // Phase 4F — the shared sales-rep User pool: SCAFFOLD (emitted once, shared by every bulk account's
  // OwnerId). When streaming, this lands in the scaffold pass; bulk passes reconstruct the refs (pure)
  // without re-emitting the User rows.
  if (emitScaffold && plan.population > 0) emitUserPool(plan, records);

  if (emitBulk && plan.population > 0) {
    const density = plan.bulkDensity ?? 0; // Phase 4E — how richly the wider object graph is fleshed out (0 = structural)
    // OwnerId on each bulk record is a pure function of the account index i (no `br` draw), so it never
    // perturbs bulk output. userPoolRefs is the refs-only reconstruction (User rows emitted in the scaffold).
    const userRefs = userPoolRefs(plan);
    const ownerFor = (i: number): string | undefined => (userRefs.length ? userRefs[i % userRefs.length] : undefined);
    const namer = makeCompanyNamer(rng); // offset derives from plan.seed (derive is seed-based) → batch-reconstructable
    const regionDims = SALESCLOUD_VARIABILITY.region!.map((v) => ({ value: v.value, weight: v.weight }));
    const bandDims = SALESCLOUD_VARIABILITY.dealSizeBand!.map((v) => ({ value: v.value, weight: v.weight }));
    for (let i = bulkStart; i < bulkEnd; i++) {
      const br = makeRng(deriveSeed(plan.seed, "bulk", i)); // independent per-account stream (order-independent)
      const accountName = namer.name(i);
      const domain = namer.domain(i);
      const region = br.weighted(regionDims);
      const size = weightedPick(br, SIZE_BANDS);
      const employees = br.int(size.employees[0], size.employees[1]);
      // v15: Industry is drawn INDEPENDENTLY of the name (no name↔industry coupling), on a derived stream so
      // it doesn't perturb the rest of `br`. AnnualRevenue then carries the SECTOR via industry-specific RPE.
      const industry = br.derive("industry").weighted(INDUSTRY_DIST);
      const rpe = INDUSTRY_RPE[industry] ?? INDUSTRY_RPE.DEFAULT!;
      const annualRevenue = roundTo(employees * br.derive("revenue").int(rpe[0], rpe[1]), 100_000);
      const geo = br.pick(GEO_BY_REGION[region] ?? GEO_BY_REGION["NA"]!);
      const acctRef = `bulk-acct-${i}`;
      // The rep who owns this account's whole book (account + its opps + their activities). SOFT lookup:
      // an org that can't seat the pool drops OwnerId and the record falls back to the running user.
      const ownerRef = ownerFor(i);
      const owns = ownerRef ? { _softRefs: { OwnerId: ownerRef } } : {};

      // ── Pass 1: draw the opportunity spine (state/band/amount/stage/dates) so Account.Type can DERIVE from
      // the won/lost history (G-ACCT-TYPE). Drawn on `br` in the SAME order as before (count → per-opp state/
      // band/amount/stage/closeDay) so the structural bytes downstream are stable; the extra per-opp metadata
      // (Type/LeadSource/OLIs/Name) is layered on a derived `oppmeta` stream below.
      const oppBucket = weightedPick(br, OPP_COUNT_DISTRIBUTION);
      const oppCount = br.int(oppBucket.range[0], oppBucket.range[1]);
      type OppSpine = { ref: string; state: string; band: string; amount: number; stage: string; closeDay: number };
      const oppSpines: OppSpine[] = [];
      let hasWon = false;
      let hasLost = false;
      for (let k = 0; k < oppCount; k++) {
        const state = weightedPick(br, OPP_STATE_MIX).value;
        if (state === "won") hasWon = true;
        if (state === "lost") hasLost = true;
        const band = br.weighted(bandDims);
        const [lo, hi] = BAND_RANGE[band] ?? [50_000, 100_000];
        const amount = roundTo(br.int(lo, hi), 1_000);
        const stage = state === "won" ? "Closed Won" : state === "lost" ? "Closed Lost" : br.pick(BULK_OPEN_STAGES);
        // v16: open-pipeline CloseDate spans ~1–3 quarters forward of asOf (was br.int(15,150) — bunched in one
        // quarter). A TRIANGULAR draw (average of two uniforms) centers the pipeline at ~140 days (~1.5 quarters)
        // with real mass across the whole 10–270d horizon — a healthy spread, not a near-term pile-up. (Staleness
        // against a months-old default asOf is an operational concern: seed a live demo with `--asOf <today>`.)
        const closeDay = state === "open" ? Math.round((br.int(10, 270) + br.int(10, 270)) / 2) : -br.int(30, 1_000);
        oppSpines.push({ ref: `bulk-opp-${i}-${k}`, state, band, amount, stage, closeDay });
      }

      // G-ACCT-TYPE: any Closed-Won → Customer (Direct/Channel); else Prospect. An enterprise floor makes a
      // big, established account a Customer even before the first logged win (a $9B/23k-emp "Prospect" reads
      // wrong). "Other" is gone — every account carries a meaningful, history-coherent Type.
      const am = br.derive("acctmeta"); // all NEW account-field draws (no perturbation of `br`)
      const enterpriseFloor = employees >= 5_000 && am.bool(0.6);
      const acctType = hasWon || enterpriseFloor ? (am.bool(0.72) ? "Customer - Direct" : "Customer - Channel") : "Prospect";
      const isCustomer = acctType.startsWith("Customer");

      // G-ACCT-FIELDS: Phone / BillingStreet+State+PostalCode / Description / AccountSource / Ownership.
      // v16: Phone dial code DERIVES from the account's BillingCountry (was always "+1"). Contacts inherit it.
      const phone = bulkPhone(am, geo.country);
      const billingStreet = `${am.int(10, 9990)} ${am.pick([...STREET_NAMES])} ${am.pick([...STREET_TYPES])}`;
      const billingState = geo.state; // bound to the city (coherent); "" for countries with no state line → omitted
      // v27: ZIP bound to the STATE (ZIP3 prefix + 2 drawn digits) so a CA account never carries a TX ZIP — the
      // same cross-field tell v26 fixed for the foreground tier. ONE draw (range only) → re-bless is Account-only.
      // Omitted for non-US (no fake US-format postal on a London/Singapore address).
      const postalTail = String(am.int(0, 99)).padStart(2, "0");
      const usZip3 = geo.countryCode === "US" ? US_STATE_ZIP3[geo.stateCode] : undefined;
      const billingPostal = usZip3 ? `${usZip3}${postalTail}` : undefined;
      // v16: Account.Description is now LEAD + FOCUS + TAIL (combinatorial), not a 5-template Mad-Libs.
      const descLead = am.pick([...ACCT_DESC_LEAD]).replace(/\{industry\}/g, industry);
      const descFocus = am.pick([...ACCT_DESC_FOCUS]);
      const descTail = am.pick([...ACCT_DESC_TAIL]).replace(/\{city\}/g, geo.city);
      const description = `${descLead}, ${descFocus}, ${descTail}`;
      const accountSource = am.weighted(ACCOUNT_SOURCE);
      const ownership = annualRevenue >= 1_000_000_000 ? (am.bool(0.7) ? "Public" : "Private") : am.bool(0.18) ? "Public" : "Private";

      records.Account!.push({
        _ref: acctRef,
        Name: accountName,
        Industry: industry, // v15: independent of the name (INDUSTRY_DIST)
        Type: acctType, // v15: derived from won/lost history (+ enterprise floor)
        Website: `https://www.${domain}`,
        Phone: phone,
        NumberOfEmployees: employees,
        AnnualRevenue: annualRevenue,
        BillingStreet: billingStreet,
        BillingCity: geo.city,
        // v19: emit BOTH the ISO code AND the canonical label. On a State/Country-Picklist org the *Code field
        // validates + autofills (and the label is consistent); on a picklist-OFF org the *Code field is not
        // createable → dropped, and the canonical label loads as free text. State omitted where the country
        // has no standard sub-state picklist (its stateCode is "").
        ...(billingState ? { BillingState: billingState, BillingStateCode: geo.stateCode } : {}),
        ...(billingPostal ? { BillingPostalCode: billingPostal } : {}),
        BillingCountry: geo.country,
        BillingCountryCode: geo.countryCode,
        Description: description,
        AccountSource: accountSource,
        Ownership: ownership,
        // v24: customer sentiment in the STANDARD field — derived structurally from won/lost history
        // (no dossier at bulk tier). Pure, no RNG.
        Rating: ratingForBulk(hasWon, hasLost),
        ...owns,
        _meta: { tier: "bulk", sizeBand: size.value, region, hasWon, hasLost },
      } satisfies GenericRecord);

      // ── Contacts: size-scaled count + dept×seniority titles + singular-role uniqueness (G-CONTACT-ROSTER).
      // Small accounts 1–3; enterprise 4–12, biased up by deal activity. All new field draws on `cc`.
      const cc = br.derive("contactmeta");
      const baseCount = employees > 2_000 ? cc.int(4, 12) : employees > 400 ? cc.int(2, 6) : cc.int(1, 3);
      const contactCount = Math.min(20, baseCount + (oppCount >= 3 ? 1 : 0));
      // Email convention varies PER ACCOUNT (G-CONTACT-NAME): the local-part shape + a ~10% external-provider minority.
      const ec = br.derive("emailconv");
      const convention = ec.pick(["first.last", "flast", "first_last", "firstl"] as const);
      const externalProvider = ec.bool(0.1) ? ec.pick(["gmail.com", "outlook.com", "proton.me"] as const) : null;
      const localPart = (first: string, last: string): string => {
        const f = first.toLowerCase().replace(/[^a-z]/g, "");
        const l = last.toLowerCase().replace(/[^a-z]/g, "");
        switch (convention) {
          case "flast": return `${f.charAt(0)}${l}`;
          case "first_last": return `${f}_${l}`;
          case "firstl": return `${f}${l.charAt(0)}`;
          default: return `${f}.${l}`;
        }
      };
      const usedFirst = new Set<string>();
      const usedFull = new Set<string>();
      const usedSingular = new Set<string>();
      type BulkContact = { ref: string; name: string; full: string; email: string };
      const bulkContacts: BulkContact[] = [];
      for (let j = 0; j < contactCount; j++) {
        // Full-name uniqueness within the account, and no two same-first-name (reuse the foreground dedup spirit).
        let first = br.pick(FIRST_NAMES);
        let last = br.pick(LAST_NAMES);
        for (let tries = 0; (usedFirst.has(first) || usedFull.has(`${first} ${last}`)) && tries < 6; tries++) {
          first = br.pick(FIRST_NAMES);
          last = br.pick(LAST_NAMES);
        }
        usedFirst.add(first);
        usedFull.add(`${first} ${last}`);
        // Title: the FIRST contact is senior-biased (C-level/VP from a senior dept); the rest spread across depts.
        const dept = j === 0 ? cc.pick([...SENIOR_DEPTS]) : cc.pick(ALL_DEPTS);
        const titlePool = TITLES_BY_DEPT[dept] ?? TITLES_BY_DEPT.Sales!;
        // Senior-bias the first contact toward the top of the (senior→junior) pool.
        let title = j === 0 ? titlePool[cc.int(0, Math.min(2, titlePool.length - 1))]! : cc.pick([...titlePool]);
        // Singular-role uniqueness (one CEO/CFO/COO/… per account) — re-draw a non-singular title on collision.
        for (let tries = 0; isSingularTitle(title) && usedSingular.has(title) && tries < 6; tries++) {
          title = cc.pick([...titlePool]);
        }
        if (isSingularTitle(title)) usedSingular.add(title);
        const ref = `bulk-contact-${i}-${j}`;
        const lp = localPart(first, last);
        const email = externalProvider ? `${lp}@${externalProvider}` : `${lp}@${domain}`;
        records.Contact!.push({
          _ref: ref,
          _refs: { AccountId: acctRef },
          FirstName: first,
          LastName: last,
          Title: title,
          Email: email.toLowerCase(),
          Phone: phone, // main line — inherits the account's country dial code (v16)
          ...(cc.bool(0.6) ? { MobilePhone: bulkPhone(cc, geo.country) } : {}), // v16: country-coherent mobile too
          LeadSource: cc.weighted(CONTACT_LEADSOURCE),
          Department: deptOfTitle(title),
          MailingCity: geo.city, // mirror the account HQ
          ...(geo.state ? { MailingState: geo.state, MailingStateCode: geo.stateCode } : {}), // v19: code + label
          MailingCountry: geo.country,
          MailingCountryCode: geo.countryCode,
          _meta: { tier: "bulk" },
        } satisfies GenericRecord);
        bulkContacts.push({ ref, name: first, full: `${first} ${last}`, email: email.toLowerCase() });
      }
      const primary = bulkContacts[0];
      // v18 (EAC/ECI): one stable selling-side rep per account — sends the outbound emails + is on the calls.
      // A real account owner repeats across that account's deals/threads (unlike the run-unique foreground AE).
      const repRng = br.derive("rep");
      const repFirst = repRng.pick(FIRST_NAMES);
      const repLast = repRng.pick(LAST_NAMES);
      const repFull = `${repFirst} ${repLast}`;
      const repEmail = `${localPart(repFirst, repLast)}@${SELLER_DOMAIN}`; // OUR fixed brand — never the prospect's own domain
      // Title lookup for OCR Decision-Maker gating (the contact's seniority gates the role).
      const titleOf = (ref: string): string => (records.Contact!.find((c) => c._ref === ref)?.Title as string) ?? "";

      // ── Pass 2: emit the opportunities with full standard fields + real line items (G-OPP-*, G-OPP-OLI).
      const nr = br.derive("oppmeta"); // all NEW opp-metadata draws (Name/Type/LeadSource/OLIs)
      const usedOppNames = new Set<string>();
      // Per-BASE-NAME collision counter — indexing the roman numeral by usedOppNames.size (the old approach)
      // counted ALL distinct names ever emitted, not how many times THIS base name has repeated, and capped
      // at index 4 ("VI"); once an account passed 5 distinct names, every later collision (on any base name)
      // rendered the identical literal "<name> VI", producing true duplicate Opportunity Names on one account.
      const oppNameCollisions = new Map<string, number>();
      const romanSuffix = (n: number): string => {
        const ROMAN = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
        return ROMAN[n - 1] ?? `#${n + 1}`; // beyond the pool, just keep counting — never re-share an index
      };
      type BulkOpp = OppSpine & { primaryRef: string | undefined; productLine: string };
      const bulkOpps: BulkOpp[] = [];
      // v16 (G-ASSET-RECONCILE): the License line (UnitPrice + seat Quantity) of each WON deal, so an Asset's
      // Price/Quantity can reconcile to the actual deal it was provisioned from instead of a fresh sample.
      type WonLicense = { closeDay: number; unitPrice: number; quantity: number; productIdx: number };
      const wonLicenseLines: WonLicense[] = [];
      oppSpines.forEach((o, k) => {
        const oppRef = o.ref;
        const stageOf = o.stage;
        // Line items first (the primary product drives the {ProductLine} name slot). License always present.
        const lineRange = BULK_LINE_COUNT[o.band] ?? [2, 3];
        const lineCount = Math.min(PRODUCTS.length, nr.int(lineRange[0], lineRange[1]));
        const attachNames = nr.sample(PRODUCT_ATTACH.map((p) => p.value), lineCount - 1);
        const attachIdx = attachNames.map((nm) => PRODUCTS.findIndex((p) => p.name === nm)).filter((x) => x >= 0);
        const productIdx = [0, ...attachIdx]; // line 0 = Platform License (largest share)
        const shares = splitAmount(o.amount, productIdx.length);
        const seats = seatCount(employees);
        const primaryProduct = productIdx.length > 1 ? PRODUCTS[productIdx[1]!]!.name : "Platform License";
        const productLine = familyRollup(primaryProduct);

        // Decide Type FIRST (G-OPP-TYPE) so the {Motion} name token can be drawn CONSISTENT with it (v16):
        // an "Existing Business" deal names as Renewal/Expansion/Upsell/Cross-Sell/Land & Expand; a "New
        // Business" deal as Net-New/Land & Expand. Was: motion drawn independently → "…Renewal" typed New.
        const priorWonAcct = hasWon; // the account already bought → bias Existing Business
        const type = nr.weighted(priorWonAcct ? OPP_TYPE_EXISTING : OPP_TYPE_NEW);
        const department = nr.pick([...DEPARTMENT]);

        // Name — decoupled from state (G-OPP-NAME). Fill the chosen shape; de-dup per account with a roman numeral.
        const shape = nr.weighted(NAME_SHAPES);
        let name = shape
          .replace(/\{Account\}/g, accountName)
          .replace(/\{Initiative\}/g, nr.pick([...INITIATIVE]))
          .replace(/\{ProductLine\}/g, productLine)
          .replace(/\{Department\}/g, department)
          .replace(/\{Motion\}/g, nr.pick([...motionsForType(type)])) // motion ⊆ the set valid for this Type
          .replace(/\{Quarter\}/g, quarterOf(forwardDate(asOf, o.closeDay)))
          .replace(/\{SeatTier\}/g, seatTier(employees))
          .replace(/\{Region\}/g, region);
        if (usedOppNames.has(name)) {
          const n = (oppNameCollisions.get(name) ?? 0) + 1;
          oppNameCollisions.set(name, n);
          name = `${name} ${romanSuffix(n)}`;
        }
        usedOppNames.add(name);

        // Standard fields (G-OPP-FIELDS) — all derived/coherent, never state-leaking.
        const leadSource = nr.weighted(OPP_LEADSOURCE);
        const probability = PROBABILITY[stageOf] ?? 10;
        const forecastCategory = FORECASTCATEGORY[stageOf] ?? "Pipeline";
        const band3 = stageBand(stageOf);
        const nextStep = o.state === "open" ? nr.pick(NEXTSTEP[band3 === "closed" ? "mid" : band3]) : null;
        // v16: combinatorial, state+stage-coherent Description splicing the deal's product line + department.
        const oppDescription = buildOppDescription(nr, oppDescKey(band3, o.state), productLine, department);

        records.Opportunity!.push({
          _ref: oppRef,
          _refs: { AccountId: acctRef },
          // The owner (if a user pool is seated) merges INTO _softRefs alongside the pricebook. A bare
          // `...owns` spread would CLOBBER the whole _softRefs object and silently drop Pricebook2Id —
          // breaking OLI load AND the "purely additive" pool guard (pool-on then differed from pool-off).
          _softRefs: { Pricebook2Id: STANDARD_PRICEBOOK_REF, ...(ownerRef ? { OwnerId: ownerRef } : {}) },
          Name: name,
          Amount: o.amount,
          StageName: stageOf,
          CloseDate: forwardDate(asOf, o.closeDay),
          Type: type,
          LeadSource: leadSource,
          Probability: probability,
          ForecastCategoryName: forecastCategory,
          ...(nextStep ? { NextStep: nextStep } : {}),
          Description: oppDescription,
          _meta: { tier: "bulk", state: o.state, band: o.band },
        } satisfies GenericRecord);

        // OpportunityLineItems — Σ UnitPrice == Amount EXACTLY (splitAmount). License Quantity = seat tier,
        // but `seats` comes from headcount alone (independent of the deal's dollar band) — an enterprise
        // account with a small deal could draw thousands of seats against a tiny license dollar share, which
        // used to floor UnitPrice to $1/seat and OVERSHOOT the license line's true share by up to 65%+
        // (confirmed: a $4,000 LT10K deal reconciling to $6,600 once Salesforce recalculates Amount from the
        // line items on load). The license Quantity is now capped to its own dollar share (never "sells" more
        // seats than dollars allocated to the line), and any residual from the seat-based rounding is
        // absorbed into the LAST add-on line — the same "last line absorbs the remainder" rule splitAmount
        // already uses — so Σ UnitPrice reconstructs Amount exactly regardless of how the seat/dollar ratio falls.
        const singleLine = productIdx.length === 1;
        const licenseQty = singleLine ? 1 : Math.max(1, Math.min(seats, shares[0]!));
        const licenseUnitPrice = singleLine ? shares[0]! : Math.max(1, Math.round(shares[0]! / licenseQty));
        const licenseDrift = shares[0]! - licenseQty * licenseUnitPrice;
        if (licenseDrift !== 0) shares[shares.length - 1] = shares[shares.length - 1]! + licenseDrift;
        productIdx.forEach((pi, li) => {
          records.OpportunityLineItem!.push({
            _ref: `bulk-oli-${i}-${k}-${li}`,
            _refs: { OpportunityId: oppRef, PricebookEntryId: `pbe-${pi}` }, // pbe-{idx} is a SHARED (scaffold) ref
            Quantity: pi === 0 ? licenseQty : 1,
            UnitPrice: pi === 0 ? licenseUnitPrice : shares[li]!,
            _meta: { tier: "bulk", product: PRODUCTS[pi]!.name },
          } satisfies GenericRecord);
        });
        // v16: remember this WON deal's License line so its installed-base Asset reconciles to the real deal.
        if (o.state === "won") wonLicenseLines.push({ closeDay: o.closeDay, unitPrice: licenseUnitPrice, quantity: licenseQty, productIdx: productIdx[1] ?? 0 });

        // Buying committee (G-OCR) — rotate the primary across the account's deals, vary the primary's role,
        // and gate "Decision Maker" by title seniority + deal size. Exactly one IsPrimary per opp.
        let primaryRef: string | undefined;
        if (bulkContacts.length) {
          const primaryContact = bulkContacts[k % bulkContacts.length]!;
          primaryRef = primaryContact.ref;
          const ptitle = titleOf(primaryContact.ref);
          const senior = /Chief|President|VP|EVP|SVP|Founder|Director/.test(ptitle);
          const bigDeal = o.amount >= 250_000;
          // On a large deal a junior primary can't be the Decision Maker — they're an Influencer, and a senior
          // contact (if any) takes the decision role. Otherwise the primary holds it.
          const seniorContact = bulkContacts.find((c) => /Chief|President|VP|EVP|SVP|Founder/.test(titleOf(c.ref)));
          let dmRef = primaryContact.ref;
          let primaryRole = nr.weighted([
            { value: "Decision Maker", weight: senior ? 50 : 20 },
            { value: "Economic Buyer", weight: 18 },
            { value: "Evaluator", weight: 16 },
            { value: "Influencer", weight: 16 },
          ]);
          if (bigDeal && !senior && seniorContact) {
            primaryRole = "Influencer";
            dmRef = seniorContact.ref; // the decision authority moves to a senior contact on a 6-figure+ deal
          }
          // Emit the primary OCR (IsPrimary).
          records.OpportunityContactRole!.push({ _refs: { OpportunityId: oppRef, ContactId: primaryContact.ref }, Role: primaryRole, IsPrimary: true, _meta: { tier: "bulk" } } satisfies GenericRecord);
          // If we relocated the decision maker to a senior contact, tag them too (distinct contact).
          if (dmRef !== primaryContact.ref) {
            records.OpportunityContactRole!.push({ _refs: { OpportunityId: oppRef, ContactId: dmRef }, Role: "Decision Maker", IsPrimary: false, _meta: { tier: "bulk" } } satisfies GenericRecord);
          }
          // Density-scaled extra committee members on the OTHER contacts (distinct), each a distinct role.
          const taken = new Set<string>([primaryContact.ref, dmRef]);
          const others = bulkContacts.filter((c) => !taken.has(c.ref));
          const extraRoles = Math.min(Math.round(density * nr.int(0, 2)), others.length);
          const roles = nr.shuffle([...BULK_OCR_ROLES]).slice(0, extraRoles);
          roles.forEach((role, ri) => {
            const contact = others[ri];
            if (contact) records.OpportunityContactRole!.push({ _refs: { OpportunityId: oppRef, ContactId: contact.ref }, Role: role, IsPrimary: false, _meta: { tier: "bulk" } } satisfies GenericRecord);
          });
        }
        bulkOpps.push({ ...o, primaryRef, productLine });
      });
      // The opp's PRIMARY champion as a BulkContact — the person every activity on this deal routes through
      // (one coherent counterpart per deal, not a fresh random contact per touch). Falls back to the first
      // contact when no primary was assigned (e.g. a contact-less account).
      const championOf = (o: { primaryRef?: string }): BulkContact | undefined =>
        bulkContacts.find((c) => c.ref === o.primaryRef) ?? bulkContacts[0];

      // ── Activities (Phase 4E): Task + Event timelines per opp — the dominant realism-per-record family.
      // v18 (EAC): each Task now carries its activity-capture shape — TaskSubtype (Email/Call/LinkedIn/Cadence)
      // derived from the activity's channel, and call-channel tasks add CallType/CallDurationInSeconds/
      // CallDisposition (the ECI telephony fields). Dates are BOUNDED to each opp's active window (G-OPP-DATES)
      // so there is no pre-sales activity after a deal closed; subjects/descriptions are stage-aware (G-ACT-SUBJECTS).
      const act = br.derive("activity"); // all activity content/extra draws on a derived stream
      bulkOpps.forEach((o, k) => {
        const won = o.state === "won";
        // The opp's active window in days-from-asOf: [openDay, closeDay]. Open lead time scales with stage.
        const leadTime = 30 + stageBand(o.stage).length * 10 + (o.state === "open" ? 30 : 60);
        const openDay = o.closeDay - leadTime;
        const inWindow = (extra: Rng): number => {
          // a day inside [openDay, closeDay]; never strictly after closeDay (no post-close pre-sales activity)
          const span = Math.max(1, o.closeDay - openDay);
          return openDay + extra.int(0, span);
        };
        // One champion per deal — most touches go through them; a minority reach another committee member
        // (a real deal has a dominant contact, not a different name every interaction).
        const champion = championOf(o);
        const touchContact = (rng: Rng): BulkContact => (champion && rng.bool(0.72) ? champion : rng.pick(bulkContacts));
        // The deal's facts, so a logged-call note can quote the buyer saying real numbers/dates/product.
        const actFacts = { money: compactUsd(o.amount), quarter: quarterOf(forwardDate(asOf, o.closeDay)), product: o.productLine, account: accountName };
        const seenSubjects = new Set<string>();
        const taskCount = Math.round(density * br.int(0, 5));
        for (let t = 0; t < taskCount; t++) {
          const day = inWindow(act);
          const who = touchContact(act);
          const { subject, channel } = bulkTaskSubject(act, o.stage, who.name);
          if (seenSubjects.has(subject)) continue; // de-dup identical subjects within one opp
          seenSubjects.add(subject);
          const description = bulkTaskDescription(act, o.stage, who.name, channel, actFacts);
          // Status tied to the date: past+settled → Completed; future → Not Started/In Progress; a tail
          // sprinkles the two otherwise-unused statuses (Waiting on someone else / Deferred).
          const isPast = day < 0;
          const status = isPast
            ? (act.bool(0.85) ? "Completed" : act.pick(["Waiting on someone else", "Deferred"] as const))
            : act.weighted(BULK_TASK_OPEN_STATUS.map((s) => ({ value: s.value, weight: s.weight })));
          records.Task!.push({
            _ref: `bulk-task-${i}-${k}-${t}`,
            _refs: { WhatId: o.ref, WhoId: who.ref },
            ...owns, // the owning rep logged the activity
            Subject: subject,
            Description: description,
            ActivityDate: forwardDate(asOf, day),
            Status: status,
            Priority: act.weighted(BULK_PRIORITY_MIX.map((s) => ({ value: s.value, weight: s.weight }))),
            ...taskEacFields(act, channel), // v18 (EAC): the capture shape — TaskSubtype + (calls) CallType/Duration/Disposition
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
        }
        const seenEvents = new Set<string>();
        // v16: density modestly above ~1.0/opp on larger / late-stage deals (more meetings as a deal heats up
        // and as the contract value rises) — a small additive bump, not a multiplier, so bulk stays cheap.
        const lateOrLarge = (stageBand(o.stage) === "late" || won ? 1 : 0) + (o.amount >= 250_000 ? 1 : 0);
        const eventCount = Math.round(density * (br.int(0, 2) + lateOrLarge));
        for (let e = 0; e < eventCount; e++) {
          // v16: shift off Sat/Sun, then clamp so the weekend-shift never pushes PAST the deal's CloseDate
          // (the activity-window invariant the bulk-graph test guards). Pulling a boundary-Sunday back two days
          // to Friday keeps it in-window and still on a weekday.
          let day = nearestWeekdayDay(asOf, inWindow(act));
          if (day > o.closeDay) day = nearestWeekdayDay(asOf, o.closeDay - 2);
          const who = touchContact(act); // the deal's champion hosts most meetings
          const subject = bulkEventSubject(act, o.stage, who.name, won); // post-sale types gated to won
          if (seenEvents.has(subject)) continue; // de-dup identical events within one opp
          seenEvents.add(subject);
          // v16: business-hour dayparts — peaks ~10:00 and ~14:00 (UTC, a stand-in for local), :00/:30 starts.
          const hour = act.weighted([
            { value: 9, weight: 12 }, { value: 10, weight: 22 }, { value: 11, weight: 15 }, { value: 13, weight: 12 },
            { value: 14, weight: 22 }, { value: 15, weight: 12 }, { value: 16, weight: 5 },
          ]);
          const minute = act.bool(0.4) ? 30 : 0; // :00 / :30 starts
          const durationMin = act.weighted([{ value: 30, weight: 25 }, { value: 60, weight: 50 }, { value: 90, weight: 25 }]);
          const start = new Date(new Date(asOf).getTime() + day * DAY_MS);
          start.setUTCHours(hour, minute, 0, 0);
          const end = new Date(start.getTime() + durationMin * 60_000);
          records.Event!.push({
            _ref: `bulk-event-${i}-${k}-${e}`,
            _refs: { WhatId: o.ref, WhoId: who.ref },
            ...owns, // the owning rep hosted the meeting
            Subject: subject,
            StartDateTime: start.toISOString(),
            EndDateTime: end.toISOString(),
            ShowAs: act.weighted([{ value: "Busy", weight: 78 }, { value: "Free", weight: 14 }, { value: "OutOfOffice", weight: 8 }]),
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
        }
      });

      // ── EAC email capture (v18): a synced EmailMessage thread per active opp — the shape Einstein Activity
      // Capture writes to the timeline. Threaded (shared ThreadIdentifier), alternating inbound(buyer)/
      // outbound(rep) with From/To coherent (buyer = a real Contact's email; rep = the account's stable seller
      // address), dates inside the opp's open→close window, Status '0' inbound / '3' sent. RelatedToId → the Opp
      // (NOT the Account — the EAC/email invariant). Bodies are combinatorial (bulk tier = no LLM).
      const em = br.derive("email");
      bulkOpps.forEach((o, k) => {
        if (!bulkContacts.length) return;
        const late = stageBand(o.stage) === "late" || o.state === "won";
        // Fully density-gated (incl. the late-deal floor) so bulkDensity 0 stays a pure structural skeleton.
        const threadLen = Math.round(density * (em.int(0, 3) + (late ? 2 : 1)));
        if (threadLen <= 0) return;
        const contact = championOf(o) ?? bulkContacts[em.int(0, bulkContacts.length - 1)]!; // one buyer per thread
        const dept = em.pick([...DEPARTMENT]);
        const subject = bulkEmailSubject(em, o.stage, { account: accountName, dept });
        // Ground the thread in the deal's real numbers/date/product (voice.md: specific = numbers + names + dates).
        const facts = { money: compactUsd(o.amount), quarter: quarterOf(forwardDate(asOf, o.closeDay)), product: o.productLine, account: accountName };
        const leadTime = 30 + stageBand(o.stage).length * 10 + (o.state === "open" ? 30 : 60);
        const openDay = o.closeDay - leadTime;
        const span = Math.max(1, o.closeDay - openDay);
        const threadId = `bulk-thr-${i}-${k}`;
        for (let m = 0; m < threadLen; m++) {
          const incoming = m % 2 === 1; // m0 = rep opens (outbound), then alternate buyer/rep
          // messages march forward through the window, clamped so none lands after the close
          const day = Math.min(o.closeDay, openDay + Math.round(((m + 1) / (threadLen + 1)) * span) + em.int(-1, 1));
          records.EmailMessage!.push({
            _ref: `bulk-email-${i}-${k}-${m}`,
            _refs: { RelatedToId: o.ref },
            ...owns, // the owning rep's activity
            Subject: m === 0 ? subject : `Re: ${subject}`,
            TextBody: bulkEmailBody(em, o.stage, incoming, contact.name, repFirst, m, facts),
            FromAddress: incoming ? contact.email : repEmail,
            FromName: incoming ? contact.full : repFull,
            ToAddress: incoming ? repEmail : contact.email,
            Incoming: incoming,
            Status: incoming ? "0" : "3", // 0 = New (inbound), 3 = Sent (outbound)
            MessageDate: forwardDateTime(asOf, day, 9 + em.int(0, 8)),
            ThreadIdentifier: threadId,
            MessageIdentifier: `bulk-msg-${i}-${k}-${m}`,
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
        }
      });

      // ── ECI call recordings (v18): a WebVTT transcript (ContentVersion) on a subset of LATE/WON opps — the
      // shape Einstein Conversation Insights / Gong exports. Speakers are the deal's actual people (the rep +
      // named contacts who are OCRs). VersionData is the VTT body (combinatorial; the file sink stores plain
      // text — a Salesforce sink base64-encodes + links via FirstPublishLocationId). Capped to keep the corpus
      // lean (transcripts are large): only late-stage/won deals, ~density-gated, one per qualifying opp.
      const tr = br.derive("transcript");
      bulkOpps.forEach((o, k) => {
        if (!bulkContacts.length) return;
        const eligible = stageBand(o.stage) === "late" || o.state === "won" || o.amount >= 250_000;
        if (!eligible || !tr.bool(Math.min(1, density * 0.6))) return;
        // The champion is always on the call (+ sometimes one more attendee) — the recording's speakers are
        // the deal's actual people, led by its primary contact.
        const champ = championOf(o);
        const otherAttendees = bulkContacts.filter((c) => c.ref !== champ?.ref);
        const onCall = champ
          ? [champ.full, ...(otherAttendees.length && tr.bool(0.5) ? [tr.pick(otherAttendees).full] : [])]
          : tr.sample(bulkContacts.map((c) => c.full), Math.min(bulkContacts.length, tr.int(1, 2)));
        const callDay = o.state === "open" ? o.closeDay - tr.int(5, 40) : o.closeDay - tr.int(1, 30);
        const trFacts = { money: compactUsd(o.amount), quarter: quarterOf(forwardDate(asOf, o.closeDay)), product: o.productLine, account: accountName };
        records.ContentVersion!.push({
          _ref: `bulk-cv-${i}-${k}`,
          _refs: { FirstPublishLocationId: o.ref }, // publishes the file against the Opp (auto-links on insert)
          Title: `Einstein Conversation Insights — ${accountName} (${forwardDate(asOf, callDay)})`,
          PathOnClient: `${accountName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-call-${i}-${k}.vtt`,
          VersionData: bulkTranscriptVtt(tr, repFull, onCall, o.stage, trFacts),
          Description: `Call recording transcript with ${onCall[0] ?? "the prospect"} on the ${accountName} deal, via Einstein Conversation Insights.`,
          _meta: { tier: "bulk" },
        } satisfies GenericRecord);
      });

      // ── Installed base (Phase 4E): Assets on CUSTOMER accounts that have won — the post-sale footprint.
      // Coherent Name/edition/Price/Quantity/InstallDate (from the won close)/SerialNumber (G-ASSET).
      const sup = br.derive("support"); // assets + cases + comments draw on a derived stream
      const wonCloseDays = bulkOpps.filter((o) => o.state === "won").map((o) => o.closeDay);
      if (isCustomer && hasWon) {
        const assetCount = Math.round(density * br.int(0, 3));
        for (let a = 0; a < assetCount; a++) {
          // v16 (G-ASSET-RECONCILE): pin each asset to a WON deal's License line — its seat Quantity + License
          // UnitPrice + close date come from the actual deal, so the installed-base $ reconciles to the deal
          // instead of a fresh per-product sample. When (rarely) no won License line is captured, fall back to
          // the catalog sample so the field is never empty.
          const wl = wonLicenseLines.length ? sup.pick(wonLicenseLines) : null;
          // The asset's product: the License-anchored deal's primary product if we have one, else a catalog draw.
          const pIdx = wl ? wl.productIdx : sup.int(0, PRODUCTS.length - 1);
          const p = PRODUCTS[pIdx]!;
          const edition = sup.pick([...ASSET_EDITIONS]);
          const term = sup.weighted(ASSET_TERMS);
          const suffix = p.family === "Licenses" ? "License" : p.family === "Services" ? "Plan" : sup.pick(["Subscription", "Module", "Add-on"] as const);
          // Quantity + Price reconcile to the won deal's License line when available; else catalog-sampled.
          const quantity = wl ? wl.quantity : p.family === "Licenses" ? roundTo(sup.int(10, 500), 5) : sup.int(1, 12);
          const unitPrice = wl ? wl.unitPrice : roundTo(p.list * sup.float(0.78, 1.0), 100);
          // InstallDate anchored to the SAME won close the price came from (deployed at/after that close).
          const wonClose = wl ? wl.closeDay : wonCloseDays.length ? sup.pick(wonCloseDays) : -sup.int(60, 700);
          const installDay = wonClose + sup.int(3, 21);
          records.Asset!.push({
            _ref: `bulk-asset-${i}-${a}`,
            _refs: { AccountId: acctRef, Product2Id: `product-${pIdx}`, ...(primary ? { ContactId: primary.ref } : {}) },
            Name: `${p.name} — ${edition} (${term} ${suffix})`,
            SerialNumber: `SN-${edition.slice(0, 3).toUpperCase()}-${(i * 17 + a * 3 + 1000).toString(36).toUpperCase()}`,
            InstallDate: forwardDate(asOf, installDay),
            PurchaseDate: forwardDate(asOf, wonClose),
            Quantity: quantity,
            Price: unitPrice,
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
        }
      }

      // ── Support history (Phase 4E): Cases (+ CaseComment threads) on CUSTOMER accounts that have won
      // (G-CASE) — the churn/health leading indicator. Area-driven Subject + Description + a status-coherent
      // comment thread; restricted picklists from the std sets only.
      if (isCustomer && hasWon) {
        const caseCount = Math.min(Math.round(density * br.int(0, 6)), 12);
        for (let c = 0; c < caseCount; c++) {
          const status = sup.weighted(BULK_CASE_STATUS_MIX.map((s) => ({ value: s.value, weight: s.weight })));
          const openedDay = -sup.int(1, 540);
          const caseRef = `bulk-case-${i}-${c}`;
          const reporter = sup.pick(bulkContacts);
          const area = sup.pick(CASE_AREAS);
          const ctx: SupportCtx = {
            component: area.component,
            area: area.label,
            reporter: reporter.name,
            n: sup.int(8, 120),
            rel: `v${sup.int(9, 12)}.${sup.int(0, 6)}`,
            eng: sup.int(1200, 9800),
          };
          // v16: ONE root cause (symptom + subsurface + detail + finding) drawn ONCE, threaded into the Subject,
          // the Description, AND the comment thread — so a case is a single coherent problem end to end.
          const scene: CaseScene = buildCaseScene(sup, area);
          records.Case!.push({
            _ref: caseRef,
            _refs: { AccountId: acctRef, ContactId: reporter.ref },
            Subject: bulkCaseSubject(sup, scene),
            Description: bulkCaseDescription(sup, scene, ctx),
            Status: status,
            Origin: sup.weighted(BULK_CASE_ORIGIN_MIX.map((s) => ({ value: s.value, weight: s.weight }))),
            Priority: sup.weighted(BULK_CASE_PRIORITY_MIX.map((s) => ({ value: s.value, weight: s.weight }))),
            ...(status === "Closed" ? { ClosedDate: forwardDateTime(asOf, openedDay + sup.int(1, 20), 12) } : {}),
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
          // CaseComment thread — only when density warrants comments; coherent with the case status AND scene.
          if (density > 0 && sup.bool(Math.min(1, density))) {
            const thread = caseCommentThread(sup, status, ctx, scene);
            thread.forEach((body, cm) => {
              records.CaseComment!.push({
                _ref: `bulk-casecomment-${i}-${c}-${cm}`,
                _refs: { ParentId: caseRef },
                CommentBody: body,
                _meta: { tier: "bulk" },
              } satisfies GenericRecord);
            });
          }
        }
      }

      // ── Demand-gen funnel (v17): the BULK top-of-funnel — Leads + CampaignMembers ───────────────────
      // Leads are NET-NEW prospects (their own company via the namer at a reserved high index range, so no
      // collision with account names) — Salesforce-correct: a Lead has NO AccountId, so it carries no hard
      // _refs (parent_ref stays null) and only a soft OwnerId. CampaignMembers wire the account's CONTACTS
      // (and the new leads) onto the shared campaign set. All on a derived `funnel` stream — order-independent
      // and account-major (every ref is within this account's subtree or a shared campaign-* scaffold ref).
      const fnl = br.derive("funnel");
      const leadN = Number(fnl.weighted(BULK_LEAD_COUNT));
      for (let l = 0; l < leadN; l++) {
        const lFirst = fnl.pick(FIRST_NAMES);
        const lLast = fnl.pick(LAST_NAMES);
        const coIdx = 2_000_000 + i * 4 + l; // reserved namer index range → a net-new company name (not an account)
        const coDomain = namer.domain(coIdx);
        const lGeo = fnl.pick(GEO_BY_REGION[region] ?? GEO_BY_REGION["NA"]!);
        const leadRef = `bulk-lead-${i}-${l}`;
        records.Lead!.push({
          _ref: leadRef,
          ...owns, // the territory rep owns the inbound lead (soft OwnerId; no hard _refs → parent_ref null)
          FirstName: lFirst,
          LastName: lLast,
          Company: namer.name(coIdx),
          Title: fnl.pick([...BULK_LEAD_TITLES]),
          Email: `${lFirst}.${lLast}@${coDomain}`.toLowerCase(),
          Status: fnl.weighted(BULK_LEAD_STATUS_MIX),
          Rating: fnl.weighted(LEAD_RATING_MIX),
          LeadSource: fnl.pick(LEAD_SOURCES),
          Industry: fnl.weighted(INDUSTRY_DIST),
          City: lGeo.city,
          ...(lGeo.state ? { State: lGeo.state, StateCode: lGeo.stateCode } : {}), // v19: code + canonical label
          Country: lGeo.country,
          CountryCode: lGeo.countryCode,
          _meta: { tier: "bulk" },
        } satisfies GenericRecord);
        if (fnl.bool(0.72)) { // most leads were sourced by a marketing program
          records.CampaignMember!.push({
            _ref: `bulk-cm-lead-${i}-${l}`,
            _refs: { LeadId: leadRef, CampaignId: `campaign-${fnl.int(0, campaignCount - 1)}` },
            Status: fnl.weighted(CAMPAIGN_MEMBER_STATUS_MIX),
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
        }
      }
      // A slice of the account's existing CONTACTS responded to campaigns (the install-base engagement signal).
      const memberRate = 0.25 + density * 0.35; // ~25–60% of contacts are campaign members, density-scaled
      bulkContacts.forEach((c, ci) => {
        if (!fnl.bool(memberRate)) return;
        const nCamp = Math.min(fnl.int(1, 2), campaignCount);
        const camps = new Set<number>();
        let guard = 0;
        while (camps.size < nCamp && guard++ < 8) camps.add(fnl.int(0, campaignCount - 1));
        let m = 0;
        for (const cIdx of camps) {
          records.CampaignMember!.push({
            _ref: `bulk-cm-${i}-${ci}-${m}`,
            _refs: { ContactId: c.ref, CampaignId: `campaign-${cIdx}` }, // parent_ref = the contact (account-major)
            Status: fnl.weighted(CAMPAIGN_MEMBER_STATUS_MIX),
            _meta: { tier: "bulk" },
          } satisfies GenericRecord);
          m++;
        }
      });
    }
  }

  return { records, copyRequests, directives: { convertLeads } };
}
