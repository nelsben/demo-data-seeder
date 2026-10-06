// apps/web/src/api.ts
//
// Typed fetch client for the dataseed API (apps/server). Same-origin in dev via
// the Vite proxy. Types reuse @dataseed/core where they match the wire shape —
// `import type` is erased at build, so this adds zero runtime weight.

import type { CapabilityProfile, BundlePlan, PackRequirement } from "@dataseed/core";

export interface PackSummary {
  id: string;
  label: string;
  description: string;
  scenarios: string[];
  objects: string[];
  variabilityDimensions: string[];
  recordsPerUnitEstimate: number;
}

export interface OrgSummary {
  alias: string | null;
  username: string;
  isScratch: boolean;
  isExpired: boolean;
}

export interface SampleLineItem {
  product: string;
  quantity: number;
  unitPrice: number;
}

export interface SampleDeal {
  name: string;
  amount: number;
  stage: string;
  closeDate: string;
  scenario?: string;
  /** Per-line product economics (Phase A) — the lines sum to `amount` (see `reconciled`). */
  lineItems?: SampleLineItem[];
  /** True when Σ(lineItems quantity × unitPrice) === amount (the reconciliation guarantee). */
  reconciled?: boolean;
}

export interface PlanPreview {
  copyRequests: number;
  sampleDeals: SampleDeal[];
  sampleCopy: string | null;
}

export interface PlanResult {
  plan: BundlePlan;
  preview: PlanPreview;
}

export interface PlanRequest {
  org: string;
  pack: string;
  volume: number;
  scenarioMix: Record<string, number>;
  dc?: "auto" | "on" | "off";
  seed?: string | number;
}

export type CopyProvider = "auto" | "claude-code" | "anthropic" | "static";

export interface FillRequest {
  org: string;
  pack: string;
  provider?: CopyProvider;
  budgetUsd?: number;
  limit?: number;
}

export interface EmailSample {
  subject: string;
  body: string;
  incoming: boolean;
}

export interface TaskSample {
  subject: string;
  body: string;
}

export interface GateOutcome {
  ran: boolean;
  passes: number;
  before: { clean: number; total: number };
  after: { clean: number; total: number };
  converged: boolean;
  unresolved: { id: string }[];
}

export interface FillResult {
  provider: string;
  filled: number;
  filledByPrimary?: number;
  fallbacks?: number;
  estCostUsd: number;
  budgetExhausted?: boolean;
  applied?: number;
  unmatched?: number;
  emails: { total: number; withBody: number };
  /** Logged-activity Task notes filled (the 2nd Mode-A signal stream, Phase A). */
  tasks: { total: number; withBody: number };
  samples: EmailSample[];
  /** A couple of generated Task notes (the rep's internal logs). */
  taskSamples?: TaskSample[];
  /** Realism-gate outcome (lint→regenerate), when the gate ran. */
  gate?: GateOutcome;
  note?: string;
}

export interface ObjectLoadResult {
  object: string;
  present: boolean;
  attempted: number;
  inserted: number;
  failed: number;
  skipped: number;
  /** Catalog records (Product2/PricebookEntry) reused from the org instead of inserted (upsert). */
  reused: number;
  droppedFields: string[];
  errors: string[];
}

export interface LeadConversionResult {
  attempted: number;
  converted: number;
  opportunitiesCreated: number;
  errors: string[];
}

export interface LoadResult {
  org: string;
  pack: string;
  objects: ObjectLoadResult[];
  totalInserted: number;
  idempotencySkipped: number;
  /** Post-load Lead→Account/Contact/Opportunity conversions (Phase C), when the pack emits directives. */
  conversions?: LeadConversionResult;
}

export interface TeardownObjectResult {
  object: string;
  matched: number;
  deleted: number;
  failed: number;
  errors: string[];
}

export interface TeardownResult {
  org: string;
  dryRun: boolean;
  accountsMatched: number;
  objects: TeardownObjectResult[];
  totalDeleted: number;
}

export interface SynthesisProbeResult {
  object: string;
  label: string;
  present: boolean;
  count: number;
  sample?: string | null;
}

export interface SynthesisSummary {
  org: string;
  pack: string;
  supported: boolean;
  /** Seeded INPUT records (Accounts, Opps, Emails, Tasks, line items) — confirms the load landed. */
  inputs: SynthesisProbeResult[];
  /** Records the pipeline DERIVED (signals, briefs, …). */
  probes: SynthesisProbeResult[];
  total: number;
}

export interface PreflightResult {
  sf: boolean;
  claudeCode: boolean;
  anthropicKey: boolean;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  packs: () => req<{ packs: PackSummary[] }>("/api/packs").then((r) => r.packs),
  orgs: () => req<{ orgs: OrgSummary[] }>("/api/orgs").then((r) => r.orgs),
  preflight: () => req<PreflightResult>("/api/preflight"),
  profile: (org: string, pack?: string) =>
    req<{ profile: CapabilityProfile; requirements: PackRequirement[] }>("/api/profile", {
      method: "POST",
      body: JSON.stringify({ org, pack }),
    }),
  plan: (body: PlanRequest) => req<PlanResult>("/api/plan", { method: "POST", body: JSON.stringify(body) }),
  fillCopy: (body: FillRequest) => req<FillResult>("/api/fill-copy", { method: "POST", body: JSON.stringify(body) }),
  load: (org: string, pack: string, force = false) => req<LoadResult>("/api/load", { method: "POST", body: JSON.stringify({ org, pack, force }) }),
  teardown: (org: string, pack: string, yes = false) => req<TeardownResult>("/api/teardown", { method: "POST", body: JSON.stringify({ org, pack, yes }) }),
  synthesis: (org: string, pack: string) => req<SynthesisSummary>("/api/synthesis", { method: "POST", body: JSON.stringify({ org, pack }) }),
};

export { ApiError };
