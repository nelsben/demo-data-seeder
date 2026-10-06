// packages/engine/src/introspect/probes.ts
//
// The introspection probes (app-architecture §3, grounding §5). Each is
// (SfClient, …) → a partial profile patch + any gaps, and is FAIL-OPEN: it
// catches its own failure, records a gap, and returns a smaller-valid patch
// rather than throwing. The orchestrator (profile.ts) merges the patches.
//
// Generic / target-agnostic: probes read ORG capabilities (limits, licensing,
// edition, objects/FLS, Data Cloud, existing data). What OBJECTS to probe is
// supplied by the caller (the chosen pack's object list) — the probes never name
// a target-app object themselves.

import type { CapabilityProfile, CopyProviderId } from "@dataseed/core";
import { RECORDS_PER_MB } from "@dataseed/core";
import type { SfClient } from "./sf-client.js";

export interface ProbePatch {
  patch: Partial<CapabilityProfile>;
  gaps: string[];
}

const RESERVE = 0.2; // keep 20% storage headroom (the DEFAULT; an MCP caller can override via a size request)

/** Storage / API / async limits → record budget. */
export async function probeLimits(client: SfClient): Promise<ProbePatch> {
  try {
    const rows = await client.limits();
    const by = new Map(rows.map((r) => [r.name, { max: r.max, remaining: r.remaining }]));
    const pick = (name: string) => by.get(name);
    const limits = {
      dataStorageMB: pick("DataStorageMB"),
      fileStorageMB: pick("FileStorageMB"),
      dailyApiRequests: pick("DailyApiRequests"),
      dailyBulkApiBatches: pick("DailyBulkApiBatches"),
      dailyAsyncApexExecutions: pick("DailyAsyncApexExecutions"),
    };
    const ds = limits.dataStorageMB;
    const recordBudget = ds ? Math.max(0, Math.floor(ds.remaining * RECORDS_PER_MB * (1 - RESERVE))) : undefined;
    return { patch: { limits, ...(recordBudget !== undefined ? { recordBudget } : {}) }, gaps: [] };
  } catch (e) {
    return { patch: {}, gaps: [`limits: ${(e as Error).message}`] };
  }
}

/** Edition / sandbox / namespace. */
export async function probeOrgInfo(client: SfClient): Promise<ProbePatch> {
  try {
    const [org] = await client.query<{ OrganizationType?: string; IsSandbox?: boolean; NamespacePrefix?: string | null }>(
      "SELECT OrganizationType, IsSandbox, NamespacePrefix FROM Organization",
    );
    return {
      patch: {
        edition: org?.OrganizationType,
        isSandbox: org?.IsSandbox,
        namespacePrefix: org?.NamespacePrefix ?? null,
      },
      gaps: [],
    };
  } catch (e) {
    return { patch: {}, gaps: [`orgInfo: ${(e as Error).message}`] };
  }
}

/** Licensing: active PSLs (incl. Data Cloud + GenAI), installed packages, copy provider. */
export async function probeLicensing(client: SfClient): Promise<ProbePatch> {
  const gaps: string[] = [];
  const patch: Partial<CapabilityProfile> = {};
  try {
    const psls = await client.query<{ DeveloperName: string }>(
      "SELECT DeveloperName FROM PermissionSetLicense WHERE Status='Active'",
    );
    const names = new Set(psls.map((p) => p.DeveloperName));
    const dcLicensed = names.has("GenieDataPlatformStarterPsl");
    const genAi = names.has("EinsteinGPTCopilotPsl") || names.has("EinsteinGPTPromptTemplatesPsl");
    // A GenAI-licensed org gets "anthropic" as the preferred provider hint (the real chain is
    // anthropic → claude-code → static; resolvePrimary's auto-order falls through if it's unavailable) —
    // NOT "einstein", which no engine-side provider has ever implemented (see the CopyProviderId note).
    const copyProvider: CopyProviderId = genAi ? "anthropic" : "static";
    patch.copyProvider = copyProvider;
    // Seed the DataCloud licensed flag here; probeDataCloud refines availability/evidence.
    patch.dataCloud = { licensed: dcLicensed, available: false, evidence: "licensing probe (availability not yet resolved)", gateState: null, instrumentedLimits: false };
  } catch (e) {
    gaps.push(`licensing: ${(e as Error).message}`);
  }
  try {
    const pkgs = await client.query<{ SubscriberPackage?: { Name?: string; NamespacePrefix?: string | null }; SubscriberPackageVersionId?: string }>(
      "SELECT SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersionId FROM InstalledSubscriberPackage",
      { tooling: true },
    );
    patch.installedPackages = pkgs
      .filter((p) => p.SubscriberPackage?.Name)
      .map((p) => ({
        name: p.SubscriberPackage!.Name!,
        namespacePrefix: p.SubscriberPackage!.NamespacePrefix ?? null,
        ...(p.SubscriberPackageVersionId ? { versionId: p.SubscriberPackageVersionId } : {}),
      }));
  } catch (e) {
    gaps.push(`installedPackages: ${(e as Error).message}`);
  }
  return { patch, gaps };
}

/** Data Cloud availability — multi-signal priority order (grounding §5). */
export async function probeDataCloud(client: SfClient, licensed: boolean): Promise<ProbePatch> {
  // (1) PSL active is the definitive, callout-free signal.
  if (licensed) {
    // (2) confirm provisioned via the data-model API (clean {} vs FUNCTIONALITY_NOT_ENABLED).
    try {
      const res = await client.restGet("/services/data/v62.0/ssot/data-model-objects");
      const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      const provisioned = res.ok && text.includes("dataModelObject");
      return {
        patch: {
          dataCloud: {
            licensed: true,
            available: provisioned,
            evidence: provisioned ? "GenieDataPlatformStarterPsl + ssot/data-model-objects provisioned" : "licensed but ssot/data-model-objects not provisioned",
            gateState: null,
            instrumentedLimits: false,
          },
        },
        gaps: provisioned ? [] : [],
      };
    } catch (e) {
      // Licensed but couldn't confirm provisioning — fail CLOSED (available=false). PSL presence is NOT proof
      // that Data Cloud is provisioned: our Dev/scratch orgs carry GenieDataPlatformStarterPsl yet have ZERO
      // DataSpace / __dlm tables (DC needs a separate async Setup step). Claiming available=true here is a false
      // positive; this signal only feeds an "is this org a DC candidate?" readout, so honesty beats permissiveness.
      return {
        patch: { dataCloud: { licensed: true, available: false, evidence: "GenieDataPlatformStarterPsl active but ssot probe failed — provisioning unconfirmed (PSL ≠ provisioned)", gateState: null, instrumentedLimits: false } },
        gaps: [`dataCloud.ssotProbe: ${(e as Error).message}`],
      };
    }
  }
  return {
    patch: { dataCloud: { licensed: false, available: false, evidence: "no GenieDataPlatformStarterPsl", gateState: null, instrumentedLimits: false } },
    gaps: [],
  };
}

/** Per-object presence + FLS + live restricted-picklist values, for the pack's object list. */
export async function probeObjects(client: SfClient, objectNames: readonly string[]): Promise<ProbePatch> {
  const objects: NonNullable<CapabilityProfile["objects"]> = [];
  const livePicklists: Record<string, string[]> = {};
  const gaps: string[] = [];

  for (const name of objectNames) {
    try {
      const d = await client.describe(name);
      // A real blocker = a CUSTOM, required field this user can't create (FLS), that
      // Salesforce wouldn't populate itself. System/audit/formula/auto-number/defaulted
      // fields are non-createable by design and never the seeder's problem — exclude them.
      const blockedRequiredFields = d.fields
        .filter((f) => f.custom && !f.nillable && !f.createable && !f.calculated && !f.autoNumber && !f.defaultedOnCreate)
        .map((f) => f.name);
      objects.push({ apiName: name, present: true, blockedRequiredFields });
      for (const f of d.fields) {
        if (f.restrictedPicklist && f.picklistValues?.length) {
          livePicklists[`${name}.${f.name}`] = f.picklistValues.filter((v) => v.active).map((v) => v.value);
        }
      }
    } catch {
      // describe throws on a non-existent object → present:false (not a gap; absence is the answer).
      objects.push({ apiName: name, present: false, blockedRequiredFields: [] });
    }
  }
  return { patch: { objects, livePicklists }, gaps };
}

/** Existing record counts per object (additive idempotency + thin-cohort fill). */
export async function probeExistingData(client: SfClient, objectNames: readonly string[], present: Set<string>): Promise<ProbePatch> {
  const existingCounts: Record<string, number> = {};
  const gaps: string[] = [];
  for (const name of objectNames) {
    if (!present.has(name)) continue; // don't count objects that aren't there
    try {
      const [row] = await client.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${name}`);
      existingCounts[name] = Number(row?.cnt ?? 0);
    } catch (e) {
      gaps.push(`existingCount:${name}: ${(e as Error).message}`);
    }
  }
  return { patch: { existingCounts }, gaps };
}
