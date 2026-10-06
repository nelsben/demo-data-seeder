// packs/salescloud/src/index.ts
//
// @dataseed/pack-salescloud — the Salesforce Sales Cloud target pack: everything
// domain-specific about generating realistic standard-object sales data, behind
// @dataseed/core's TargetPack contract. The engine drives this pack without
// importing it; core never imports it back.

import type { CapabilityProfile, PackRequirement, TargetPack } from "@dataseed/core";
import { SALESCLOUD_PICKLISTS } from "./picklists.js";
import { SALESCLOUD_SCENARIOS } from "./scenarios.js";
import { SALESCLOUD_RECORD_SCHEMAS, SALESCLOUD_LOAD_ORDER } from "./schemas.js";
import { SALESCLOUD_VARIABILITY } from "./variability.js";
import { salescloudGenerate } from "./generate.js";

export * from "./picklists.js";
export * from "./scenarios.js";
export * from "./schemas.js";
export * from "./anchors.js";
export * from "./variability.js";
export { salescloudGenerate } from "./generate.js";
export { identityToAnchor, identityToGrounding, coerceIndustry, accountFirmographics } from "./identity.js";
export { SELLER_COMPETITORS, resolveGrounding, type AnchorGrounding } from "./grounding.js";

export const salescloudPack: TargetPack = {
  id: "salescloud",
  label: "Salesforce Sales Cloud",
  description:
    "Seeds realistic Sales Cloud pipelines — Accounts, Contacts, Leads, Opportunities (with line items), Campaigns, the communication history (Emails, Tasks, call transcripts), and the wider account graph (Assets, Cases) — for demos and testing.",

  objects: SALESCLOUD_LOAD_ORDER,
  // The communication/activity stream — high-volume records a `cascade: "off"` disperse drops to fill an
  // org structurally fast (and to skip any org automation these objects might fire on insert).
  cascadeObjects: ["EmailMessage", "Task", "ContentVersion"],
  picklists: SALESCLOUD_PICKLISTS,
  scenarios: SALESCLOUD_SCENARIOS,
  recordSchemas: SALESCLOUD_RECORD_SCHEMAS,
  variability: SALESCLOUD_VARIABILITY,
  // ~1 Account + 3 Contacts + 1 Opp + 3 OCR + 3 line items + 6 Emails + 2 Tasks + 1–2 call transcripts
  // per unit, plus a PRIOR closed-won deal on the ~40% of arcs with cross-deal history, plus ~0.6 funnel
  // leads + campaign members per unit. Fixed catalogs (products + 5 campaigns) are seeded once, not counted.
  recordsPerUnitEstimate: 25,

  // A background/bulk population account at bulkDensity 0 (pure structural): ~1 Account + ~2 Contacts + a
  // power-law of opps + OCRs/OLIs + the demand-gen funnel (v17: Leads + CampaignMembers) ≈ 17 records.
  // The plan uses (base + bulkDensity × delta) to clamp `population` against the budget AND the size resolver
  // inverts it to size by records/storage — so it MUST track the real generator. MEASURED 2026-06-22 (v22):
  // density 0 → 16.8/acct, 0.6 → 29.9, 1.0 → 39.0 → linear fit base 17, delta 22 (was 7/12, ~2× too low
  // since the v17 funnel + v18 EAC activity layer landed). Re-measure on a bulk-tier generator change.
  recordsPerPopulationUnitEstimate: 17,

  // The wider Sales-Cloud graph layered on at FULL bulkDensity (1.0): committee OCR-expand + Activities
  // (Tasks/Events) + EAC EmailMessage thread + ECI ContentVersion transcript + Assets + Cases & comments
  // ≈ +22 records per bulk account over the density-0 base (16.8 → 39.0 measured). Scaled by scope.bulkDensity.
  recordsPerPopulationUnitFullDensityDelta: 22,

  // Shared CATALOG objects with no Account root — additive idempotency can't dedupe them, so UPSERT by a
  // natural key. Order matters: Product2 (sets product-* refs) before PricebookEntry (resolves Product2Id).
  catalog: [
    { object: "Product2", keyField: "ProductCode" },
    { object: "PricebookEntry", keyByRef: "Product2Id" },
    // Funnel: campaigns shared (dedupe by Name); leads dedupe by Email so a re-load reuses them.
    { object: "Campaign", keyField: "Name" },
    { object: "Lead", keyField: "Email" },
    // Sales-rep User pool — Account-rootless. UserRole FIRST (User.UserRoleId resolves against a deduped
    // role); User reused by its globally-unique Username (a second load without this throws DUPLICATE_USERNAME).
    { object: "UserRole", keyField: "DeveloperName" },
    { object: "User", keyField: "Username" },
  ],

  // The seeded INPUTS to read back on Verify — confirms the load landed (Accounts, Opps, the Email/Task/
  // transcript streams, line items). Counts are org-wide, a landing sanity check.
  inputView: {
    probes: [
      { object: "Campaign", label: "Campaigns" },
      { object: "Lead", label: "Leads" },
      { object: "Account", label: "Accounts" },
      { object: "Opportunity", label: "Opportunities", sampleField: "Name" },
      { object: "EmailMessage", label: "Emails" },
      { object: "Task", label: "Activity notes" },
      { object: "ContentVersion", label: "Call transcripts", sampleField: "Title" },
      { object: "OpportunityLineItem", label: "Line items" },
    ],
  },

  // Standard Sales Cloud objects are present in every Salesforce org — no special install requirement to seed.
  checkRequirements(_profile: CapabilityProfile): PackRequirement[] {
    return [];
  },

  generate: salescloudGenerate,

  // The bulk tier is account-major: every bulk record refs only its own account's subtree or a non-bulk
  // shared ref (catalog/User pool). This unlocks streaming materialize (and a future bounded-memory loader).
  // Enforced by warehouse-corpus.test.ts's ref-locality invariant — derived from the actual emitted refs.
  bulkRefLocality: "account-major",
};

export default salescloudPack;
