// packages/core/src/capability-profile.ts
//
// CapabilityProfile — the GENERIC output of the `profile-org` op: what an
// arbitrary target Salesforce org supports. Domain-agnostic — it describes the
// ORG (limits, licensing, edition, namespace, object/field availability, Data
// Cloud, existing data), not any one app. A target pack READS this profile to
// decide what of its schema it can seed; the pack's "is my schema present?"
// question is answered from the generic `objects`/`livePicklists` fields.
//
// Every probe is fail-open: one that can't determine its answer records a `gap`
// and degrades to a smaller-valid result rather than throwing. So most fields are
// optional/nullable by design — absence is information, not an error.

import { z } from "zod";

/** One org limit as returned by `sf org list limits` / jsforce `conn.limits()`. */
export const OrgLimit = z.object({
  max: z.number().nonnegative(),
  remaining: z.number(),
});
export type OrgLimit = z.infer<typeof OrgLimit>;

export const LimitsProfile = z.object({
  dataStorageMB: OrgLimit.optional(),
  fileStorageMB: OrgLimit.optional(),
  dailyApiRequests: OrgLimit.optional(),
  dailyBulkApiBatches: OrgLimit.optional(),
  dailyAsyncApexExecutions: OrgLimit.optional(),
});
export type LimitsProfile = z.infer<typeof LimitsProfile>;

/**
 * Salesforce Data Cloud availability — a PLATFORM capability (not a pack concept),
 * resolved multi-signal in priority order. `instrumentedLimits:false` is the
 * honest admission that DC consumption limits have no confirmed read path yet.
 */
export const DataCloudProfile = z.object({
  licensed: z.boolean(),
  available: z.boolean(),
  evidence: z.string(),
  gateState: z.enum(["On", "Off", "Auto"]).nullable(),
  instrumentedLimits: z.literal(false).default(false),
});
export type DataCloudProfile = z.infer<typeof DataCloudProfile>;

/** Per-object presence + per-REQUIRED-field write capability (createable by the running identity). */
export const ObjectCapability = z.object({
  apiName: z.string(),
  present: z.boolean(),
  /** REQUIRED fields that exist but are NOT createable — a blocking finding, not a silent red. */
  blockedRequiredFields: z.array(z.string()).default([]),
});
export type ObjectCapability = z.infer<typeof ObjectCapability>;

/** Which copy provider the engine should route to, per the GenAI-entitlement probe. (The id; the runtime
 *  CopyProvider interface lives in copy.ts.) Matches the ACTUAL provider chain in copy/orchestrate.ts —
 *  "einstein" was removed (no provider ever implemented it; the licensing probe used to emit it anyway,
 *  which meant a GenAI-licensed org's profile lied about what provider would actually run). */
export const CopyProviderId = z.enum(["anthropic", "claude-code", "static"]);
export type CopyProviderId = z.infer<typeof CopyProviderId>;

/** A managed/unmanaged package detected in the org (a pack maps its id to one of these to know if its schema is installed + namespaced). */
export const InstalledPackage = z.object({
  name: z.string(),
  namespacePrefix: z.string().nullable(),
  versionId: z.string().optional(),
});
export type InstalledPackage = z.infer<typeof InstalledPackage>;

export const CapabilityProfile = z.object({
  /** The target org alias this profile describes. */
  org: z.string().min(1),
  /** ISO 8601 capture time (injected, never `Date.now()` in the pure path). */
  capturedAt: z.string().datetime(),

  edition: z.string().optional(),
  isSandbox: z.boolean().optional(),
  namespacePrefix: z.string().nullable().default(null),

  limits: LimitsProfile.default({}),
  dataCloud: DataCloudProfile.optional(),

  /** Installed managed/unmanaged packages — a pack matches its namespace here to know if/how its schema is present. */
  installedPackages: z.array(InstalledPackage).default([]),
  /** Per-object availability + write capability (the generic answer to "is the pack's schema present + writable"). */
  objects: z.array(ObjectCapability).default([]),
  /** Live restricted-picklist values, keyed `Object.Field__c` — overrides a pack's static contract when present. */
  livePicklists: z.record(z.string(), z.array(z.string())).default({}),
  /** Existing record counts per object (additive idempotency + thin-cohort fill). */
  existingCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),

  /** Derived: max records the storage headroom supports (drives the volume clamp). */
  recordBudget: z.number().int().nonnegative().optional(),
  copyProvider: CopyProviderId.default("static"),

  /** Honest, machine-readable list of what this profile could NOT determine. */
  gaps: z.array(z.string()).default([]),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfile>;
