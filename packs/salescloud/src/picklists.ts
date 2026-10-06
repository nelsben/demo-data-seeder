// packs/salescloud/src/picklists.ts
//
// The EXACT restricted-picklist truth the SALES CLOUD pack must honor — the Salesforce
// STANDARD default value sets for the activity/support objects. A wrong value does NOT
// fail in this repo; it fails at LOAD time with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`,
// an error that reads like a typo and reds the whole run. Verified against the platform
// default sets; we OMIT org-configurable ones (Task/Event subtype, Case Type/Reason,
// Asset Status) to stay load-safe on an untouched org. Treat as a contract, not a
// convenience — the introspection layer diffs these against the live org describe.

/**
 * Account.Industry — the full STANDARD Salesforce picklist (32 values, per the array below — verify against
 * a live org describe via `profile-org` before adding/removing any). A synthetic identity's authored
 * industry is coerced to one of these (`coerceIndustry` in identity.ts) so a load never trips
 * INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. Anchors use a subset; the bulk tier uses BULK_INDUSTRIES.
 */
export const ACCOUNT_INDUSTRIES = [
  "Agriculture", "Apparel", "Banking", "Biotechnology", "Chemicals", "Communications", "Construction", "Consulting",
  "Education", "Electronics", "Energy", "Engineering", "Entertainment", "Environmental", "Finance", "Food & Beverage",
  "Government", "Healthcare", "Hospitality", "Insurance", "Machinery", "Manufacturing", "Media", "Not For Profit",
  "Other", "Recreation", "Retail", "Shipping", "Technology", "Telecommunications", "Transportation", "Utilities",
] as const;

/** Task.Status — standard default set. ("Open" is NOT a member; use Not Started / In Progress.) */
export const TASK_STATUS = ["Not Started", "In Progress", "Completed", "Waiting on someone else", "Deferred"] as const;
/** Task.Priority / Event has the same default Priority set. */
export const TASK_PRIORITY = ["High", "Normal", "Low"] as const;
/** Task.TaskSubtype — the activity-capture (EAC) channel of a logged activity. STANDARD createable set
 *  (verified against the live describe). 'Email' = an EAC-synced email; 'Call' = a logged call (carries the
 *  CallType/CallDurationInSeconds/CallDisposition telephony fields); 'LinkedIn'/'Cadence'/'ListEmail' = the
 *  other captured channels; 'Task' = a plain to-do. */
export const TASK_SUBTYPE = ["Task", "Email", "ListEmail", "Cadence", "Call", "LinkedIn"] as const;
/** Task.CallType — the direction of a logged call (the ECI/telephony shape). STANDARD set. */
export const CALL_TYPE = ["Internal", "Inbound", "Outbound"] as const;
/** EmailMessage.Status — the standard numeric status set: 0=New, 1=Read, 2=Replied, 3=Sent, 4=Forwarded,
 *  5=Draft. The seeder uses '0' for inbound (new) and '3' for outbound (sent). */
export const EMAIL_STATUS = ["0", "1", "2", "3", "4", "5"] as const;
/** Event.ShowAs (free/busy). Event has no Status field. */
export const EVENT_SHOW_AS = ["Busy", "OutOfOffice", "Free"] as const;
/** Case.Status — standard default set. */
export const CASE_STATUS = ["New", "Working", "Escalated", "Closed"] as const;
/** Case.Origin — standard default set. */
export const CASE_ORIGIN = ["Phone", "Email", "Web"] as const;
/** Case.Priority — standard default set. (Case uses Medium, unlike Task's Normal.) */
export const CASE_PRIORITY = ["High", "Medium", "Low"] as const;

/** Opportunity.Type — STANDARD stock value set members the bulk/foreground opps draw from. We set ONLY
 *  New/Existing Business (the safest universal defaults); the introspection layer diffs the full set. */
export const OPPORTUNITY_TYPE = ["Existing Business", "New Business"] as const;
/** Opportunity.LeadSource — the 5 universal stock members (subset of the LeadSource value set). */
export const OPPORTUNITY_LEADSOURCE = ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"] as const;
/** Opportunity.ForecastCategoryName — the standard forecast categories (derived from StageName). */
export const OPPORTUNITY_FORECASTCATEGORY = ["Omitted", "Pipeline", "Best Case", "Commit", "Closed"] as const;
/** Account.Rating / Lead.Rating — the standard temperature picklist. We OVERLOAD Account.Rating to carry
 *  per-account customer SENTIMENT (Hot = healthy, Warm = mixed/watch, Cold = at-risk) — a real standard field,
 *  so it survives the org load and is itself realism. (Lead.Rating was already emitted but unregistered.) */
export const RATING = ["Hot", "Warm", "Cold"] as const;

/**
 * The deal cast's buyer personas — a NARRATIVE vocabulary (who's who in a deal), NOT a
 * restricted org field. Drives the per-deal persona mix + the per-persona voice in generated
 * copy (a CFO and a champion never sound alike). Standard B2B buying-committee roles.
 */
export const PERSONAS = [
  "Champion",
  "Economic Buyer",
  "Technical Evaluator",
  "Coach",
  "Skeptic",
  "Blocker",
  "End User",
] as const;

/** The pack's PicklistContract — keyed by exact `Object.Field`. The introspection layer diffs this
 *  against the live describe so a managed-package picklist drift fails loudly. */
export const SALESCLOUD_PICKLISTS = {
  "Account.Industry": ACCOUNT_INDUSTRIES,
  "Task.Status": TASK_STATUS,
  "Task.Priority": TASK_PRIORITY,
  "Task.TaskSubtype": TASK_SUBTYPE,
  "Task.CallType": CALL_TYPE,
  "EmailMessage.Status": EMAIL_STATUS,
  "Event.ShowAs": EVENT_SHOW_AS,
  "Case.Status": CASE_STATUS,
  "Case.Origin": CASE_ORIGIN,
  "Case.Priority": CASE_PRIORITY,
  "Opportunity.Type": OPPORTUNITY_TYPE,
  "Opportunity.LeadSource": OPPORTUNITY_LEADSOURCE,
  "Opportunity.ForecastCategoryName": OPPORTUNITY_FORECASTCATEGORY,
  "Account.Rating": RATING,
  "Lead.Rating": RATING,
} as const;

export type SalesCloudPicklistKey = keyof typeof SALESCLOUD_PICKLISTS;
