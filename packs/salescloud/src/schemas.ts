// packs/salescloud/src/schemas.ts
//
// The Sales Cloud pack's per-object Zod record schemas. These enforce the restricted
// standard picklists at the unit-test boundary so a bad value fails BEFORE org load,
// never as INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. The engine validates generated
// records against these via TargetPack.recordSchemas.
//
// CRM/input records (Account/Contact/Opp/Email/ContentVersion/…) keep an extensible
// shape; the restricted-picklist-bearing activity/support records are enum-guarded.

import { z } from "zod";
import { TASK_STATUS, TASK_PRIORITY, EVENT_SHOW_AS, CASE_STATUS, CASE_ORIGIN, CASE_PRIORITY } from "./picklists.js";

const extensible = (shape: z.ZodRawShape) => z.object(shape).passthrough();

// ── Activity & support records — standard objects, restricted picklists guarded ──
// Task is shared with the FOREGROUND (which sets TaskSubtype='Email' to model EAC-synced
// emails); bulk tasks omit TaskSubtype. Status/Priority are guarded against the standard sets.
export const ActivityTask = extensible({
  Status: z.enum(TASK_STATUS).optional(),
  Priority: z.enum(TASK_PRIORITY).optional(),
});
export const ActivityEvent = extensible({
  ShowAs: z.enum(EVENT_SHOW_AS).optional(),
  Priority: z.enum(TASK_PRIORITY).optional(),
});
// Support history — the churn/health leading indicator. Type/Reason omitted (org-configurable).
export const SupportCase = extensible({
  Status: z.enum(CASE_STATUS).optional(),
  Origin: z.enum(CASE_ORIGIN).optional(),
  Priority: z.enum(CASE_PRIORITY).optional(),
});

const AnyRecord = z.record(z.string(), z.unknown());

/** Per-object record schemas, keyed by sObject API name → the pack's TargetPack.recordSchemas.
 *  Standard Sales Cloud objects only — no custom (__c) objects. */
export const SALESCLOUD_RECORD_SCHEMAS = {
  // Product catalog (standard-pricebook chain) — seeded once, shared across deals.
  Product2: AnyRecord,
  PricebookEntry: AnyRecord,
  // Funnel: marketing campaigns + top-of-funnel leads + responses.
  Campaign: AnyRecord,
  Lead: AnyRecord,
  CampaignMember: AnyRecord,
  // Shared sales-rep User pool — bulk OwnerId distribution.
  UserRole: AnyRecord,
  User: AnyRecord,
  // CRM core + communication/activity history.
  Account: AnyRecord,
  Contact: AnyRecord,
  Opportunity: AnyRecord,
  OpportunityContactRole: AnyRecord,
  OpportunityLineItem: AnyRecord,
  EmailMessage: AnyRecord,
  ContentVersion: AnyRecord, // call-recording transcripts (VTT files linked to the deal)
  Task: ActivityTask,
  Event: ActivityEvent,
  Asset: AnyRecord, // installed base; Status org-configurable → omitted, no enum guard
  Case: SupportCase,
  CaseComment: AnyRecord,
} as const;

/** Load order — the master-detail / lookup data chain in dependency order. profile-org probes
 *  this list for presence; the loader inserts in this sequence so parents precede children. */
export const SALESCLOUD_LOAD_ORDER = [
  "Product2",
  "PricebookEntry",
  "Campaign", // before Opportunity (CampaignId attribution) + CampaignMember
  "UserRole", // sales-rep pool — before User (User.UserRoleId) + before Account (OwnerId)
  "User", // before Account/Opportunity/Task/Event (their OwnerId soft-refs resolve to a pool user)
  "Account",
  "Contact",
  "Opportunity",
  "OpportunityContactRole",
  "OpportunityLineItem",
  "Lead", // top of funnel — independent of the account chain
  "CampaignMember", // junction: needs Campaign + Lead first
  "EmailMessage",
  "ContentVersion", // call transcripts (link to the Opp via FirstPublishLocationId)
  "Task",
  "Event", // activity sibling of Task
  // Wider Sales-Cloud graph — all reference Account/Contact/Opp/Product2 already loaded above.
  "Asset", // installed base on Customer accounts (needs Account + Product2)
  "Case", // support history (needs Account + Contact)
  "CaseComment", // junction child of Case
] as const;
