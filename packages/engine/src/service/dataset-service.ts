// packages/engine/src/service/dataset-service.ts
//
// The headless dataset service — the engine's API as plain functions returning
// structured data (no CLI args, no exit codes, no logging side effects). This is
// what the MCP surface calls so another agent can "have static data created"
// (generate) or "move static data in" (disperse) — and what any future surface
// (CLI/server) can route through. Deps (packs, registry store, clock, profile
// loader, org connector) are INJECTED so it's trivially testable without an org.

import { existsSync, readFileSync } from "node:fs";
import {
  ScopeParams,
  CapabilityProfile,
  NarrativeBundle,
  resolveSize,
  RECORDS_PER_MB,
  type PackRegistry,
  type CopyProviderId,
  type BundleRecords,
  type TargetPack,
  type SizeRequest,
  type OrgStorage,
  type ResolvedSize,
} from "@dataseed/core";
import {
  datasetIdFromBundle,
  stackId,
  recordCounts,
  type RegistryStore,
  type Dataset,
  type DatasetMeta,
  type DatasetFilter,
  type LoadRecord,
  type Stack,
} from "@dataseed/registry";
import { WarehouseStore, DEFAULT_WAREHOUSE_PATH, corpusKey, GENERATOR_VERSION } from "@dataseed/warehouse";
import { buildWarehouseSlice } from "../store/warehouse-slice.js";
import { estimateObjectInsertCost, DEFAULT_BULK_THRESHOLD, type LoadTarget } from "../load/connection.js";
import { profilePath } from "../ops/profile-org.js";
import { MATERIALIZE_DEFAULT_ASOF } from "../ops/materialize.js";
import { defaultMix } from "../ops/plan-demo.js";
import { buildBundle, generateBundle } from "../generate/generate.js";
import { planBundle } from "../plan/plan.js";
import { streamMaterialize, type ScaffoldSlice } from "../generate/stream.js";
import { fillForegroundCopy } from "../generate/fill-foreground.js";
import { savePlanned, saveFilled, latestDatasetFor, ENGINE_VERSION } from "../store/bundle-store.js";
import { buildProviders, fillCopy, applyCopy } from "../copy/index.js";
import { buildSinks, disperseDataset, totalRecords, cascadeEstimate, type DisperseReport, type CascadeEstimate } from "../sinks/index.js";

// Hard ceilings on a single MCP-driven materialize — the surface is callable by ARBITRARY agents, so
// unbounded knobs are a memory/compute DoS that would crash the long-lived stdio server (killing every
// future tool call). The local CLI op (`materialize`) is uncapped — that's a trusted operator.
/** Bulk background accounts (streamed → RSS bounded, but generation is O(accounts)). */
export const MAX_CORPUS_POPULATION = 200_000;
/** Foreground narrative deals — held in memory and ~3.5× heavier per unit than a bulk account, so a far
 *  lower cap; thousands of full-narrative deals is already an enormous corpus. */
export const MAX_CORPUS_VOLUME = 2_000;
/** Belt-and-suspenders: reject if the PLANNED total record count exceeds this, so no single request (or a
 *  future knob the per-field caps miss) can OOM the process. ~200K accounts ≈ 2.7M records at full density. */
export const MAX_CORPUS_RECORDS = 3_500_000;
/** Cap on rows returned by query_corpus — bounds the payload an agent can pull back. */
const QUERY_ROW_CAP = 5_000;
/** select_accounts caps — bound the categorized-retrieval payload (each account drags its whole subtree). */
const MAX_SELECT_ACCOUNTS = 500;
const DEFAULT_SELECT_MAX_RECORDS = 25_000;
const MAX_SELECT_RECORDS = 100_000;

/** The named account "states" `select_accounts` understands, each → a SQL predicate over wh_Account (alias `a`),
 *  EXISTS-joining wh_Opportunity (alias `o`, on parent_ref) for structural states. Sentiment states read the
 *  stored Account.Rating; lifecycle states (expansion/urgent/churning) are COMPUTED live from the opp/case
 *  graph (nothing extra stored). The predicates are built from this CLOSED enum (+ the manifest's asOf for
 *  urgent), never from user input. */
export const ACCOUNT_STATES = ["healthy", "at-risk", "mixed", "expansion", "urgent", "churning"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];
const STATE_PREDICATES: Record<Exclude<AccountState, "urgent">, string> = {
  healthy: `json_extract(a.payload_json,'$.Rating') = 'Hot'`,
  "at-risk": `json_extract(a.payload_json,'$.Rating') = 'Cold'`,
  mixed: `json_extract(a.payload_json,'$.Rating') = 'Warm'`,
  // a prior Closed-Won AND a still-open deal = an expansion play. Pure StageName predicates (no asOf needed).
  expansion:
    `EXISTS (SELECT 1 FROM wh_Opportunity o WHERE o.ds_id = a.ds_id AND o.parent_ref = a.local_ref AND json_extract(o.payload_json,'$.StageName') = 'Closed Won') ` +
    `AND EXISTS (SELECT 1 FROM wh_Opportunity o WHERE o.ds_id = a.ds_id AND o.parent_ref = a.local_ref AND json_extract(o.payload_json,'$.StageName') NOT LIKE 'Closed%')`,
  // "at-risk" (Cold Rating) is a broad bucket — 3 of the 5 named deal scenarios land there. "churning" narrows
  // it to accounts ALSO carrying an active Escalated support Case — today that's ONLY the v28 churn-signal
  // Case (bulk Cases require hasWon, which is mutually exclusive with the hasLost-only condition that makes a
  // bulk account Cold — see sentiment.ts — so a bulk Cold account can never carry a bulk Case at all). Still a
  // converging, actionable signal a CS/success query would want, distinct from a merely-stalled deal with no
  // support-side corroboration; the predicate itself doesn't assume WHICH generation path produced the Case.
  churning:
    `json_extract(a.payload_json,'$.Rating') = 'Cold' ` +
    `AND EXISTS (SELECT 1 FROM wh_Case c WHERE c.ds_id = a.ds_id AND c.parent_ref = a.local_ref AND json_extract(c.payload_json,'$.Status') = 'Escalated')`,
};

/** Resolve a state to its SQL predicate over wh_Account (alias `a`). `urgent` is time-relative — an OPEN deal
 *  closing within ~30 days of the corpus asOf (or already overdue) = time pressure — so it's built here from
 *  the manifest's asOf (date part only, validated to YYYY-MM-DD; from our own manifest, never user input).
 *  Returns null when urgent is asked of a corpus that has no asOf anchor (an older pre-v24 corpus). */
function predicateFor(state: AccountState, asOf: string | undefined): string | null {
  if (state !== "urgent") return STATE_PREDICATES[state];
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(asOf ?? "")?.[1];
  if (!day) return null;
  return (
    `EXISTS (SELECT 1 FROM wh_Opportunity o WHERE o.ds_id = a.ds_id AND o.parent_ref = a.local_ref ` +
    `AND json_extract(o.payload_json,'$.StageName') NOT LIKE 'Closed%' ` +
    `AND date(json_extract(o.payload_json,'$.CloseDate')) <= date('${day}','+30 days'))`
  );
}

export interface ServiceDeps {
  packs: PackRegistry;
  store: RegistryStore;
  /** Injected clock (ISO) — stamps provenance + load-history. */
  now: () => string;
  /** Resolve a CapabilityProfile for an org. Default: read .dataseed/profiles/<org>.json. */
  loadProfile?: (org: string) => CapabilityProfile;
  /** Connect to an org for the salesforce sink (tests inject a mock). Default: JsforceLoadTarget.create. */
  connect?: (org: string) => Promise<LoadTarget>;
  /** The corpus warehouse store (injected; tests pass `new WarehouseStore(":memory:")`). Held for the
   *  service's life so materialize + query share one connection. Default: lazily opened from warehousePath. */
  warehouse?: WarehouseStore;
  /** Path for the lazily-opened default warehouse (when `warehouse` isn't injected). Default .dataseed/warehouse.db. */
  warehousePath?: string;
}

/** The flexible sizing units a caller can use to express "how much data" — resolved to a bulk `population`.
 *  Precedence (first set wins): population > accounts > records > storageMB > storagePct > leaveFreePct > fill.
 *  Storage units (storagePct/leaveFreePct/fill) require a live org profile (data-storage facts). */
export interface SizeFields {
  /** Direct bulk-account count. */
  population?: number;
  /** Target TOTAL accounts (volume + population). */
  accounts?: number;
  /** Target TOTAL record count across all objects. */
  records?: number;
  /** Target data-storage footprint in MB. */
  storageMB?: number;
  /** Fill up to this % of the org's TOTAL data storage (100 = use all remaining). */
  storagePct?: number;
  /** Leave this % of the org's TOTAL data storage free (= fill 100 − leaveFreePct). */
  leaveFreePct?: number;
}

export interface GenerateInput extends SizeFields {
  org: string;
  pack: string;
  volume: number;
  /** Bulk-graph richness 0–1 (default 0.6); also scales the per-account record cost the size resolver inverts. */
  bulkDensity?: number;
  /** Sales-rep User pool for OwnerId distribution (0 = off, ≤50). */
  userPoolSize?: number;
  scenarioMix?: Record<string, number>;
  seed?: string | number;
  asOf?: string;
  dc?: "auto" | "on" | "off";
  /** Fill deferred copy after planning: "none" (planned only) or a provider. Default "static" (free, instant, deterministic). */
  fill?: "none" | CopyProviderId;
  name?: string;
}

/** Input to a DRY-RUN estimate — same sizing surface as generate, but it writes nothing. */
export interface EstimateInput extends SizeFields {
  org: string;
  pack: string;
  volume?: number;
  bulkDensity?: number;
  userPoolSize?: number;
  scenarioMix?: Record<string, number>;
  seed?: string | number;
  asOf?: string;
  /** Preview the API-call cost AS IF loaded with this REST→Bulk switch threshold (default 5000 — the same
   *  default `disperse`'s salesforce sink uses). Lower it to preview a smaller/scratch-org-safer load. */
  bulkThreshold?: number;
}

export interface EstimateResult {
  /** How the size request resolved (which unit drove it, the final volume/population, a trace). */
  resolved: { volume: number; population: number; unit: string; notes: string[] };
  /** Projected totals (analytic, exact for the plan's record model). */
  estimatedRecords: number;
  estimatedStorageMB: number;
  /** Per-sObject record estimate (a small representative sample extrapolated linearly — approximate). */
  perObjectCounts: Record<string, number>;
  /** Whether the resolved population was clamped to the org's record budget. */
  budgetCapped: boolean;
  /** Foreground LLM-copy calls a `fill` with an LLM provider would fire (bulk fills zero). */
  foregroundCopyCalls: number;
  /** The org's data-storage envelope + where this run would leave it (only when the org has a live profile). */
  orgStorage?: { maxMB: number; remainingMB: number; usedPct: number; projectedUsedPct: number; freePctAfter: number };
  /** Salesforce API-call cost a `disperse --sink salesforce` load of this size would incur, mirroring the
   *  loader's actual REST(200/call)→Bulk(10k/batch) switch at `bulkThreshold` — so a scratch org's tight
   *  daily budget can be checked BEFORE loading, not discovered mid-load as a REQUEST_LIMIT_EXCEEDED failure. */
  apiCost: {
    restApiCalls: number;
    bulkApiBatches: number;
    bulkThreshold: number;
    /** Per-object counts within this fraction of `bulkThreshold` — the sample-extrapolated `perObjectCounts`
     *  can be off by a wide margin at scale, and near the threshold that's not just a magnitude error: it can
     *  flip WHICH path (REST vs Bulk) an object actually takes, changing restApiCalls/bulkApiBatches by orders
     *  of magnitude. Empty when nothing is close enough to matter. */
    uncertainObjects: string[];
    /** Present only when the org has a live profile with captured daily-limit data. `remaining` fields are
     *  `null` (not `-1`) when that specific limit wasn't captured — never confuse "unknown" with "zero left". */
    org?: {
      dailyApiRemaining: number | null;
      dailyBulkBatchesRemaining: number | null;
      wouldExceedDailyApi: boolean;
      wouldExceedDailyBulk: boolean;
      /** How old the org's limit snapshot is (ms since `profile_org` captured it) — Salesforce's daily
       *  counters are consumed continuously by ALL org activity and reset every 24h, so a stale snapshot can
       *  flip the verdict either way. Re-run profile_org if this is more than a couple hours old. */
      profileAgeMs: number;
    };
  };
  caveats: string[];
}

export interface DisperseInput {
  datasetId?: string;
  org?: string;
  pack?: string;
  sink: "salesforce" | "file" | "return";
  target?: string;
  force?: boolean;
  /** salesforce: "off" drops the pack's cascade-firing inputs (structural load, no pipeline). Default "auto". */
  cascade?: "auto" | "off";
  /** salesforce: checkpoint file path — resume a partially-loaded dataset instead of re-running from object 1. */
  checkpoint?: string;
  /** salesforce: rows-per-object at/above which the loader switches to the Bulk API (default 5000). */
  bulkThreshold?: number;
}

export interface RegisterBundleInput {
  /** Target pack the records conform to (e.g. "salescloud"). */
  pack: string;
  /** The agent's own records, keyed by sObject (use _ref/_refs for relationships, as the loader resolves). */
  records: BundleRecords;
  /** Org this data is intended for (stored in params; defaults to "imported"). */
  org?: string;
  name?: string;
}

export interface DisperseStackInput {
  stackId: string;
  sink: "salesforce" | "file" | "return";
  target?: string;
  force?: boolean;
}

export interface MaterializeCorpusInput extends SizeFields {
  org: string;
  pack: string;
  /** Foreground narrative deals (live). Default 12. */
  volume?: number;
  // population / accounts / records / storageMB / storagePct / leaveFreePct / fill come from SizeFields —
  // any of them sizes the bulk tier; population is still clamped to MAX_CORPUS_POPULATION afterward.
  bulkDensity?: number;
  userPoolSize?: number;
  userProfileName?: string;
  scenarioMix?: Record<string, number>;
  seed?: string | number;
  /** Timeline anchor. Default a FIXED date so re-materializing the same params is a cache no-op. */
  asOf?: string;
  /** Accounts per streaming batch (RSS/throughput knob). Default 5000. */
  batch?: number;
  /** Force the eager (in-memory) path instead of streaming. */
  eager?: boolean;
  /** Foreground hero-deal copy fill — part of the corpus identity. "static" (default, deterministic, no API)
   *  so a corpus is never blank; "claude-code"/"anthropic"/"auto" for VP-grade LLM copy; "none" for blank. */
  copy?: "static" | "claude-code" | "anthropic" | "auto" | "none";
  /** Rebuild even if a matching corpus is already materialized. */
  rematerialize?: boolean;
}

export interface MaterializeCorpusResult {
  datasetId: string;
  cacheKey: string;
  alreadyMaterialized: boolean;
  streamed: boolean;
  recordCounts: Record<string, number>;
  totalRecords: number;
  objects: number;
  /** Set (to the originally-requested value) when population/volume were clamped to their MCP ceilings. */
  populationClamped?: number;
  volumeClamped?: number;
}

export interface QueryCorpusInput {
  /** A corpus to inspect (ds_…). Omit (and omit sql) to LIST all corpora. */
  datasetId?: string;
  /** Sample rows for this sObject (needs datasetId). */
  object?: string;
  /** Row cap for samples / a SELECT (capped at QUERY_ROW_CAP). */
  limit?: number;
  /** A single read-only SELECT against the warehouse tables (wh_<sObject>); result is row-capped. */
  sql?: string;
}

export interface SelectAccountsInput {
  /** The materialized corpus to pull from (ds_…). */
  datasetId: string;
  /** Which overall account state to pull (healthy | at-risk | mixed | expansion). */
  state: AccountState;
  /** How many accounts to return (their full related-record graph comes along). Default 10; capped. */
  count?: number;
  /** Hard ceiling on total records in the returned graph (trims accounts to fit). Default 25K; capped at 100K. */
  maxRecords?: number;
}
export interface SelectAccountsResult {
  mode: "select";
  datasetId: string;
  state: AccountState;
  found: boolean;
  /** Total accounts of this state in the corpus (so the caller knows whether more exist). */
  accountsMatched: number;
  /** Accounts actually returned (≤ count, possibly trimmed to fit maxRecords). */
  accountsReturned: number;
  totalRecords: number;
  /** True when count / maxRecords trimmed the result below accountsMatched. */
  capped: boolean;
  /** Per-object row count in the returned slice (load order). */
  perObject: Record<string, number>;
  /** The referentially-closed account graph (account + all related records), keyed by sObject. */
  records: BundleRecords;
  /** Set when a state couldn't be evaluated (e.g. `urgent` on a corpus with no asOf anchor — re-materialize). */
  note?: string;
}

function defaultLoadProfile(org: string): CapabilityProfile {
  const p = profilePath(org);
  if (!existsSync(p)) throw new Error(`no CapabilityProfile for "${org}" — run profile_org first`);
  return CapabilityProfile.parse(JSON.parse(readFileSync(p, "utf8")));
}

// defaultMix is the SINGLE shared default (imported from plan-demo) so the dry-run op (`plan-demo`) and
// this headless service can never drift to different scenario mixes — they describe one product behavior.

function sampleDeal(bundle: { records: Record<string, Array<Record<string, unknown>>> }) {
  const o = bundle.records.Opportunity?.[0];
  if (!o) return undefined;
  return { name: o.Name, amount: o.Amount, stage: o.StageName, closeDate: o.CloseDate };
}

// ── Flexible sizing (the size resolver wired to a pack + profile) ──────────────────────────────────────
/** Records per bulk account at a given density — the plan's bulkEstimate, the divisor for record/storage targets. */
function bulkEstimateFor(pack: TargetPack, bulkDensity: number): number {
  return Math.max(1, (pack.recordsPerPopulationUnitEstimate ?? 0) + bulkDensity * (pack.recordsPerPopulationUnitFullDensityDelta ?? 0));
}
/** The org's data-storage envelope from its profile (undefined for a synthetic/unprofiled org). */
function orgStorageOf(profile: CapabilityProfile): OrgStorage | undefined {
  const ds = profile.limits?.dataStorageMB;
  return ds ? { maxMB: ds.max, remainingMB: ds.remaining } : undefined;
}
/** Resolve a caller's size fields → a bulk `population`, given the pack's record model + the org's storage. */
function resolvePopulationFor(size: SizeRequest, pack: TargetPack, profile: CapabilityProfile, volume: number, bulkDensity: number, flatRecords: number): ResolvedSize {
  return resolveSize(size, { volume, recordsPerForegroundUnit: pack.recordsPerUnitEstimate, recordsPerBulkAccount: bulkEstimateFor(pack, bulkDensity), flatRecords }, orgStorageOf(profile));
}
/** Pull the size fields off any input that carries them. */
function sizeRequestOf(input: SizeFields): SizeRequest {
  return {
    ...(input.population != null ? { population: input.population } : {}),
    ...(input.accounts != null ? { accounts: input.accounts } : {}),
    ...(input.records != null ? { records: input.records } : {}),
    ...(input.storageMB != null ? { storageMB: input.storageMB } : {}),
    ...(input.storagePct != null ? { storagePct: input.storagePct } : {}),
    ...(input.leaveFreePct != null ? { leaveFreePct: input.leaveFreePct } : {}),
  };
}

export interface DatasetService {
  listPacks(): Array<{ id: string; label: string; description: string; scenarios: readonly string[]; objects: readonly string[] }>;
  generate(input: GenerateInput): Promise<{
    datasetId: string;
    status: string;
    pack: string;
    recordCounts: Record<string, number>;
    totalRecords: number;
    plan: { volume: number; population: number; budgetCapped: boolean; scenarioCounts: Record<string, number> };
    /** Pipeline blast radius if loaded with cascade on (use disperse `cascade:"off"` to load structurally). */
    cascade: CascadeEstimate;
    fill?: { provider: string; filled: number; costUsd: number };
    sampleDeal?: Record<string, unknown> | undefined;
    /** Present when the requested knob exceeded the MCP-surface ceiling and was silently capped. */
    volumeClamped?: number;
    populationClamped?: number;
  }>;
  disperse(input: DisperseInput): Promise<DisperseReport>;
  /** Ingest an agent's OWN authored bundle as a (content-addressed) dataset — the "move in static data" path. */
  registerBundle(input: RegisterBundleInput): { datasetId: string; status: string; recordCounts: Record<string, number>; totalRecords: number };
  list(filter?: DatasetFilter): DatasetMeta[];
  get(id: string): Dataset | null;
  loads(id: string): LoadRecord[];
  /** Compose datasets into an ordered stack (layers). */
  composeStack(input: { datasetIds: string[]; name?: string }): Stack;
  /** Disperse a stack's datasets in order through one sink (the layered load). */
  disperseStack(input: DisperseStackInput): Promise<{ stackId: string; reports: Array<{ datasetId: string; ok: boolean; summary?: string; error?: string }> }>;
  listStacks(): Stack[];
  getStack(id: string): { stack: Stack; datasets: DatasetMeta[] } | null;
  /** Generate a corpus into the SQLite warehouse (streamed when the pack is account-major) — the "have a
   *  100K-account corpus ready in a queryable database, no live org" path. Idempotent on the cache key. */
  materializeCorpus(input: MaterializeCorpusInput): Promise<MaterializeCorpusResult>;
  /** DRY-RUN: resolve a size request + project records/storage/per-object counts WITHOUT writing anything. */
  estimate(input: EstimateInput): Promise<EstimateResult>;
  /** Read the corpus warehouse: list corpora, per-object counts, sample rows, or a row-capped read-only SELECT. */
  queryCorpus(input: QueryCorpusInput): Record<string, unknown>;
  /** Pull N accounts of a given overall STATE (healthy/at-risk/mixed/expansion) WITH their full, referentially-
   *  closed related-record graph — the categorized-retrieval surface agents use to test against data states. */
  selectAccounts(input: SelectAccountsInput): SelectAccountsResult;
}

/** Bind the dataset service to a set of deps (one registry handle, one pack registry). */
export function makeDatasetService(deps: ServiceDeps): DatasetService {
  const loadProfile = deps.loadProfile ?? defaultLoadProfile;

  // One warehouse connection for the service's life so materialize + query share it (an in-memory
  // ":memory:" warehouse only works if the SAME connection is reused). Opened lazily — generate/disperse
  // callers never touch it.
  let lazyWh: WarehouseStore | undefined;
  const warehouse = (): WarehouseStore => deps.warehouse ?? (lazyWh ??= new WarehouseStore(deps.warehousePath ?? DEFAULT_WAREHOUSE_PATH));

  function resolve(input: { datasetId?: string; org?: string; pack?: string }): Dataset | null {
    if (input.datasetId) return deps.store.get(input.datasetId);
    if (input.org) return latestDatasetFor(deps.store, input.org, input.pack ?? "salescloud");
    return null;
  }

  return {
    listPacks() {
      return deps.packs.list().map((p) => ({ id: p.id, label: p.label, description: p.description, scenarios: p.scenarios, objects: p.objects }));
    },

    async generate(input) {
      const pack = deps.packs.get(input.pack);
      const profile = loadProfile(input.org);
      const asOf = input.asOf ?? deps.now();
      const bulkDensity = input.bulkDensity ?? 0.6;
      // DoS guards on an arbitrary-agent MCP surface (mirrors materializeCorpus's identical ceilings, which
      // this generate_dataset path previously lacked): the officially-recommended synthetic no-org profile
      // (`profile_org --synthetic`) carries an explicitly UNLIMITED record budget, so without an explicit
      // clamp here a small request could trigger unbounded in-memory generation on the long-lived stdio
      // server. `generate` (unlike `materializeCorpus`) streams nothing — the whole bundle lives in memory.
      const requestedVolume = input.volume;
      const volume = Math.min(requestedVolume, MAX_CORPUS_VOLUME);
      // Resolve whatever sizing unit the caller used (accounts/records/storage%/…) → a bulk population.
      const requestedPop = resolvePopulationFor(sizeRequestOf(input), pack, profile, volume, bulkDensity, input.userPoolSize ?? 0).population;
      const population = Math.min(requestedPop, MAX_CORPUS_POPULATION);
      const scope = ScopeParams.parse({
        org: input.org,
        pack: input.pack,
        volume,
        population,
        bulkDensity,
        ...(input.userPoolSize != null ? { userPoolSize: input.userPoolSize } : {}),
        scenarioMix: input.scenarioMix ?? defaultMix(pack.scenarios),
        dc: input.dc ?? "auto",
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        asOf,
      });
      const plan = planBundle(scope, profile, pack, asOf);
      // Belt-and-suspenders: refuse a plan that would exceed the record ceiling (catches any knob the
      // per-field caps miss) rather than let it OOM mid-generate.
      if (plan.estimatedRecords > MAX_CORPUS_RECORDS) {
        throw new Error(`dataset too large: ~${plan.estimatedRecords} records exceeds the ${MAX_CORPUS_RECORDS} ceiling — reduce population/volume/bulkDensity`);
      }
      const bundle = generateBundle(plan, profile, pack);
      let ds = savePlanned(deps.store, { pack: input.pack, params: scope, bundle, now: deps.now(), ...(input.name ? { name: input.name } : {}) });

      const fillMode = input.fill ?? "static";
      let fill: { provider: string; filled: number; costUsd: number } | undefined;
      if (fillMode !== "none" && bundle.copyRequests.length > 0) {
        const report = await fillCopy(bundle.copyRequests, buildProviders(), { requestedProvider: fillMode, asOf, gate: false });
        applyCopy(bundle, report.results);
        ds = saveFilled(deps.store, ds, { bundle, now: deps.now(), provider: report.provider, costUsd: report.estCostUsd });
        fill = { provider: report.provider, filled: report.results.length, costUsd: report.estCostUsd };
      }
      const volumeClamped = volume < requestedVolume ? requestedVolume : undefined;
      const populationClamped = population < requestedPop ? requestedPop : undefined;

      return {
        datasetId: ds.id,
        status: ds.status,
        ...(volumeClamped ? { volumeClamped } : {}),
        ...(populationClamped ? { populationClamped } : {}),
        pack: ds.pack,
        recordCounts: ds.provenance.recordCounts ?? {},
        totalRecords: Object.values(ds.provenance.recordCounts ?? {}).reduce((a, b) => a + b, 0),
        plan: { volume: bundle.plan.volume, population: bundle.plan.population, budgetCapped: bundle.plan.budgetCapped, scenarioCounts: bundle.plan.scenarioCounts },
        cascade: cascadeEstimate(pack, bundle.records),
        ...(fill ? { fill } : {}),
        sampleDeal: sampleDeal(bundle),
      };
    },

    async estimate(input): Promise<EstimateResult> {
      const pack = deps.packs.get(input.pack);
      const profile = loadProfile(input.org);
      const asOf = input.asOf ?? deps.now();
      const volume = input.volume ?? 12;
      const bulkDensity = input.bulkDensity ?? 0.6;
      const resolved = resolvePopulationFor(sizeRequestOf(input), pack, profile, volume, bulkDensity, input.userPoolSize ?? 0);

      const scope = ScopeParams.parse({
        org: input.org,
        pack: input.pack,
        volume,
        population: resolved.population,
        bulkDensity,
        ...(input.userPoolSize != null ? { userPoolSize: input.userPoolSize } : {}),
        scenarioMix: input.scenarioMix ?? defaultMix(pack.scenarios),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        asOf,
      });
      // The plan applies the org's record-budget clamp → the AUTHORITATIVE volume/population + total.
      const plan = planBundle(scope, profile, pack, asOf);
      const estimatedRecords = plan.estimatedRecords;
      const estimatedStorageMB = estimatedRecords / RECORDS_PER_MB;

      // Per-object: generate a small representative sample, count by tier, extrapolate linearly (clearly an
      // estimate — exact counts come from materialize_corpus + query_corpus).
      const sampleVol = Math.min(Math.max(1, plan.volume), 3);
      const samplePop = Math.min(plan.population, 200);
      const sampleScope = ScopeParams.parse({ ...scope, volume: sampleVol, population: samplePop });
      const sample = buildBundle(sampleScope, profile, pack, asOf);
      const fg: Record<string, number> = {};
      const bulk: Record<string, number> = {};
      for (const [obj, recs] of Object.entries(sample.records)) {
        for (const rec of recs) {
          const tier = (rec._meta as { tier?: string } | undefined)?.tier;
          const bucket = tier === "bulk" ? bulk : fg;
          bucket[obj] = (bucket[obj] ?? 0) + 1;
        }
      }
      const perObjectCounts: Record<string, number> = {};
      for (const obj of new Set([...Object.keys(fg), ...Object.keys(bulk)])) {
        const perDeal = (fg[obj] ?? 0) / sampleVol;
        const perAcct = samplePop > 0 ? (bulk[obj] ?? 0) / samplePop : 0;
        const n = Math.round(perDeal * plan.volume + perAcct * plan.population);
        if (n > 0) perObjectCounts[obj] = n;
      }
      const foregroundCopyCalls = Math.round((sample.copyRequests.length / sampleVol) * plan.volume);

      const ds = profile.limits?.dataStorageMB;
      const orgStorage = ds
        ? (() => {
            const usedMB = Math.max(0, ds.max - ds.remaining);
            const projectedMB = usedMB + estimatedStorageMB;
            const pct = (mb: number) => (ds.max > 0 ? Math.round((mb / ds.max) * 1000) / 10 : 0);
            return { maxMB: ds.max, remainingMB: ds.remaining, usedPct: pct(usedMB), projectedUsedPct: pct(projectedMB), freePctAfter: Math.max(0, Math.round((100 - pct(projectedMB)) * 10) / 10) };
          })()
        : undefined;

      // API-call cost: sum each object's REST/Bulk insert cost (the SAME switch the loader itself applies —
      // see estimateObjectInsertCost) + a modest, labeled overhead for the once-per-object describe calls
      // (cached, so exactly one each) and the once-per-load Account.Name idempotency check (chunked at 200).
      // This deliberately excludes small constant costs (catalog upserts, standardPricebookId, retries) —
      // typically under ten calls total — so it stays a close, honest approximation, not false precision.
      const bulkThreshold = input.bulkThreshold ?? DEFAULT_BULK_THRESHOLD;
      // Near-threshold objects are a SHAPE risk, not just a magnitude one: perObjectCounts is a small-sample
      // extrapolation, and sampling noise landing on the wrong side of bulkThreshold flips that object's whole
      // REST-vs-Bulk classification (orders of magnitude, not a rounding error). Flag anything within 20%.
      const UNCERTAIN_BAND = 0.2;
      const uncertainObjects = Object.entries(perObjectCounts)
        .filter(([, n]) => Math.abs(n - bulkThreshold) <= bulkThreshold * UNCERTAIN_BAND)
        .map(([obj]) => obj);
      let restApiCalls = Object.keys(perObjectCounts).length; // one cached describe() per touched object
      let bulkApiBatches = 0;
      for (const n of Object.values(perObjectCounts)) {
        const cost = estimateObjectInsertCost(n, bulkThreshold);
        restApiCalls += cost.restApiCalls;
        bulkApiBatches += cost.bulkApiBatches;
      }
      restApiCalls += Math.ceil((perObjectCounts.Account ?? 0) / 200); // the idempotency existingValues() check
      const dailyApi = profile.limits?.dailyApiRequests;
      const dailyBulk = profile.limits?.dailyBulkApiBatches;
      const apiCost = {
        restApiCalls,
        bulkApiBatches,
        bulkThreshold,
        uncertainObjects,
        ...(dailyApi || dailyBulk
          ? {
              org: {
                dailyApiRemaining: dailyApi?.remaining ?? null,
                dailyBulkBatchesRemaining: dailyBulk?.remaining ?? null,
                wouldExceedDailyApi: dailyApi != null && restApiCalls > dailyApi.remaining,
                wouldExceedDailyBulk: dailyBulk != null && bulkApiBatches > dailyBulk.remaining,
                profileAgeMs: Math.max(0, Date.parse(deps.now()) - Date.parse(profile.capturedAt)),
              },
            }
          : {}),
      };

      const caveats = [
        "Per-object counts are an estimate (a small sample extrapolated linearly); for exact counts run materialize_corpus + query_corpus.",
        "apiCost excludes small constant overhead (catalog upserts, retries — typically <10 calls); lower bulkThreshold to shift more objects onto the Bulk API and cut restApiCalls.",
        ...resolved.notes,
      ];
      if (plan.budgetCapped) caveats.push(`population clamped to the org's record budget → ${plan.population}`);
      if (orgStorage && orgStorage.projectedUsedPct > 100) caveats.push("projected storage exceeds the org's allocation — reduce the size or free space.");
      if (uncertainObjects.length) caveats.push(`${uncertainObjects.join(", ")} — estimated count is close enough to bulkThreshold (${bulkThreshold}) that the REST-vs-Bulk classification (and so restApiCalls/bulkApiBatches) may not match the real load; re-check with materialize_corpus for an exact count.`);
      if (apiCost.org?.wouldExceedDailyApi) caveats.push(`estimated ${restApiCalls} REST API calls exceeds the org's remaining daily budget of ${apiCost.org.dailyApiRemaining} — lower bulkThreshold (moves more objects onto the Bulk API) or shrink the load.`);
      if (apiCost.org?.wouldExceedDailyBulk) caveats.push(`estimated ${bulkApiBatches} Bulk API batches exceeds the org's remaining daily budget of ${apiCost.org.dailyBulkBatchesRemaining} — raise bulkThreshold or shrink the load.`);
      if (apiCost.org && apiCost.org.profileAgeMs > 2 * 60 * 60 * 1000) caveats.push(`the org's daily-limit snapshot is ${Math.round(apiCost.org.profileAgeMs / 60_000)} minutes old (from the last profile_org run) — Salesforce's daily counters are consumed continuously by ALL org activity and reset every 24h, so wouldExceedDailyApi/wouldExceedDailyBulk may be stale; re-run profile_org for a fresh read before a large load.`);

      return {
        resolved: { volume: plan.volume, population: plan.population, unit: resolved.unit, notes: resolved.notes },
        estimatedRecords,
        estimatedStorageMB: Math.round(estimatedStorageMB * 10) / 10,
        apiCost,
        perObjectCounts,
        budgetCapped: plan.budgetCapped,
        foregroundCopyCalls,
        ...(orgStorage ? { orgStorage } : {}),
        caveats,
      };
    },

    async disperse(input) {
      const ds = resolve(input);
      if (!ds) throw new Error(`no dataset to disperse (${input.datasetId ?? `latest ${input.org ?? "?"}/${input.pack ?? "salescloud"}`}) — generate one first`);
      const sink = buildSinks({ resolvePack: (id) => deps.packs.get(id), ...(deps.connect ? { connect: deps.connect } : {}) }).get(input.sink);
      if (!sink) throw new Error(`unknown sink "${input.sink}" (expected salesforce | file | return)`);
      // Fall back to the dataset's OWN recorded org (mirrors disperseStack below) — resolving by `datasetId`
      // alone (the documented mcp-surface flow: generate_dataset → disperse_dataset { datasetId, sink }) never
      // sets `input.org`, so without this fallback the salesforce sink always threw "requires a --target org
      // alias" even though the dataset already knows the org it was planned against.
      const target = input.target ?? (input.sink === "salesforce" ? (input.org ?? ds.params.org) : undefined);
      return disperseDataset(deps.store, ds, sink, {
        now: deps.now(),
        force: input.force ?? false,
        ...(input.cascade ? { cascade: input.cascade } : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        ...(input.bulkThreshold != null ? { bulkThreshold: input.bulkThreshold } : {}),
        ...(target ? { target } : {}),
      });
    },

    registerBundle(input) {
      // NOTE: datasetIdFromBundle is content-addressed on (pack, records) ONLY — deliberately org-independent
      // (see id.ts). Registering byte-identical records under two different `org`s therefore computes the
      // SAME id, and this upsert (`deps.store.put` below) overwrites the stored `params.org` on that single
      // row. A caller that later resolves by org (not by this call's returned datasetId) can silently stop
      // finding their import. Callers of an imported/registered bundle should always disperse by the returned
      // datasetId, never by org-based resolution.
      const vol = Math.max(1, Object.values(input.records).reduce((a, r) => a + r.length, 0));
      const bundle = NarrativeBundle.parse({
        records: input.records,
        plan: { pack: input.pack, mode: "inputs", withDc: false, seed: 0, asOf: deps.now(), requestedVolume: vol, volume: vol },
      });
      const id = datasetIdFromBundle(input.pack, bundle.records);
      const prior = deps.store.get(id);
      const name = input.name ?? prior?.name;
      const ds: Dataset = {
        id,
        ...(name !== undefined ? { name } : {}),
        pack: input.pack,
        params: ScopeParams.parse({ org: input.org ?? "imported", pack: input.pack, volume: vol, scenarioMix: { imported: 100 } }),
        status: "filled", // an authored bundle is complete (no deferred copy to fill)
        provenance: {
          engineVersion: ENGINE_VERSION,
          createdAt: prior?.provenance.createdAt ?? deps.now(),
          updatedAt: deps.now(),
          recordCounts: recordCounts(bundle),
        },
        bundle,
      };
      deps.store.put(ds);
      return { datasetId: id, status: ds.status, recordCounts: ds.provenance.recordCounts ?? {}, totalRecords: totalRecords(ds) };
    },

    list(filter) {
      return deps.store.list(filter);
    },
    get(id) {
      return deps.store.get(id);
    },
    loads(id) {
      return deps.store.loadsFor(id);
    },

    composeStack(input) {
      if (!input.datasetIds.length) throw new Error("a stack needs at least one dataset id");
      for (const id of input.datasetIds) if (!deps.store.getMeta(id)) throw new Error(`unknown dataset "${id}"`);
      const stack: Stack = { id: stackId(input.datasetIds, input.name), datasetIds: input.datasetIds, createdAt: deps.now(), ...(input.name ? { name: input.name } : {}) };
      deps.store.putStack(stack);
      return stack;
    },

    async disperseStack(input) {
      const stack = deps.store.getStack(input.stackId);
      if (!stack) throw new Error(`unknown stack "${input.stackId}"`);
      const sink = buildSinks({ resolvePack: (id) => deps.packs.get(id), ...(deps.connect ? { connect: deps.connect } : {}) }).get(input.sink);
      if (!sink) throw new Error(`unknown sink "${input.sink}" (expected salesforce | file | return)`);
      const reports: Array<{ datasetId: string; ok: boolean; summary?: string; error?: string }> = [];
      for (let i = 0; i < stack.datasetIds.length; i++) {
        const datasetId = stack.datasetIds[i]!;
        const ds = deps.store.get(datasetId);
        if (!ds) {
          reports.push({ datasetId, ok: false, error: "dataset missing from registry" });
          continue;
        }
        // file sink: suffix the path per layer so members don't overwrite one file.
        const target =
          input.sink === "file" && input.target
            ? input.target.replace(/(\.json)?$/i, "") + `-${i}-${datasetId}.json`
            : input.target ?? (input.sink === "salesforce" ? ds.params.org : undefined);
        const report = await disperseDataset(deps.store, ds, sink, { now: deps.now(), force: input.force ?? false, ...(target ? { target } : {}) });
        reports.push({ datasetId, ok: report.ok, summary: report.summary });
      }
      return { stackId: input.stackId, reports };
    },

    listStacks() {
      return deps.store.listStacks();
    },
    getStack(id) {
      const stack = deps.store.getStack(id);
      if (!stack) return null;
      const datasets = stack.datasetIds.map((d) => deps.store.getMeta(d)).filter((m): m is DatasetMeta => m !== null);
      return { stack, datasets };
    },

    async materializeCorpus(input): Promise<MaterializeCorpusResult> {
      const pack = deps.packs.get(input.pack);
      const profile = loadProfile(input.org);
      // DoS guards on an arbitrary-agent surface: clamp BOTH the foreground (volume) and bulk (population)
      // knobs — an unbounded volume would OOM the long-lived server just like population.
      const requestedVolume = input.volume ?? 12;
      const volume = Math.min(requestedVolume, MAX_CORPUS_VOLUME);
      const asOf = input.asOf ?? MATERIALIZE_DEFAULT_ASOF; // fixed default → re-materialize is a cache no-op
      // Any sizing unit (accounts/records/storage%/population) → a bulk population, then clamp to the ceiling.
      const requestedPop = resolvePopulationFor(sizeRequestOf(input), pack, profile, volume, input.bulkDensity ?? 0.6, input.userPoolSize ?? 0).population;
      const population = Math.min(requestedPop, MAX_CORPUS_POPULATION);
      const scope = ScopeParams.parse({
        org: input.org,
        pack: input.pack,
        volume,
        population,
        ...(input.bulkDensity !== undefined ? { bulkDensity: input.bulkDensity } : {}),
        ...(input.userPoolSize !== undefined ? { userPoolSize: input.userPoolSize } : {}),
        ...(input.userProfileName !== undefined ? { userProfileName: input.userProfileName } : {}),
        scenarioMix: input.scenarioMix ?? defaultMix(pack.scenarios),
        dc: "off",
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        asOf,
      });
      const plan = planBundle(scope, profile, pack, asOf);
      plan.copyMode = input.copy ?? "static"; // foreground copy fill is part of the corpus identity
      // Belt-and-suspenders: refuse a plan that would exceed the record ceiling (catches any knob the
      // per-field caps miss) rather than let it OOM mid-generate.
      if (plan.estimatedRecords > MAX_CORPUS_RECORDS) {
        throw new Error(`corpus too large: ~${plan.estimatedRecords} records exceeds the ${MAX_CORPUS_RECORDS} ceiling — reduce population/volume/bulkDensity`);
      }
      const { dsId, paramsHash, cacheKey } = corpusKey(plan);
      const store = warehouse();
      const populationClamped = population < requestedPop ? requestedPop : undefined;
      const volumeClamped = volume < requestedVolume ? requestedVolume : undefined;

      const existing = store.findByCacheKey(cacheKey);
      if (existing && !input.rematerialize) {
        return { datasetId: existing.dsId, cacheKey, alreadyMaterialized: true, streamed: false, recordCounts: existing.counts, totalRecords: existing.totalRecords, objects: Object.keys(existing.counts).length, ...(populationClamped ? { populationClamped } : {}), ...(volumeClamped ? { volumeClamped } : {}) };
      }
      const manifest = { dsId, pack: input.pack, seed: plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey, asOf: plan.asOf };
      const builtAt = deps.now();
      const streamed = !input.eager && pack.bulkRefLocality === "account-major" && plan.population > 0;
      const fillScaffold = (slice: ScaffoldSlice) => fillForegroundCopy(slice, plan.copyMode, plan.asOf);
      let counts: Record<string, number>;
      if (streamed) {
        counts = (await streamMaterialize(plan, profile, pack, store, manifest, builtAt, { batch: input.batch ?? 5000, fillScaffold })).counts;
      } else {
        const bundle = generateBundle(plan, profile, pack);
        await fillForegroundCopy(bundle, plan.copyMode, plan.asOf);
        counts = store.writeBundle(manifest, bundle.records, builtAt);
      }
      return { datasetId: dsId, cacheKey, alreadyMaterialized: false, streamed, recordCounts: counts, totalRecords: Object.values(counts).reduce((a, b) => a + b, 0), objects: Object.keys(counts).length, ...(populationClamped ? { populationClamped } : {}), ...(volumeClamped ? { volumeClamped } : {}) };
    },

    queryCorpus(input): Record<string, unknown> {
      const store = warehouse();
      if (input.sql) {
        const cap = Math.min(input.limit ?? QUERY_ROW_CAP, QUERY_ROW_CAP);
        // Fetch cap+1 to tell "exactly cap real rows" from "truncated" — then slice back to cap.
        const rows = store.query(input.sql, { maxRows: cap + 1 });
        const capped = rows.length > cap;
        return { mode: "sql", rowCount: Math.min(rows.length, cap), capped, rows: capped ? rows.slice(0, cap) : rows };
      }
      if (!input.datasetId) {
        return { mode: "list", corpora: store.listManifests().map((m) => ({ datasetId: m.dsId, pack: m.pack, seed: m.seed, totalRecords: m.totalRecords, objects: Object.keys(m.counts).length, builtAt: m.builtAt })) };
      }
      const m = store.getManifest(input.datasetId);
      if (!m) return { mode: "counts", datasetId: input.datasetId, found: false };
      if (input.object) {
        const rows = store.sample(input.datasetId, input.object, Math.min(input.limit ?? 20, 1000));
        return { mode: "sample", datasetId: input.datasetId, object: input.object, total: m.counts[input.object] ?? 0, sampled: rows.length, rows };
      }
      return { mode: "counts", datasetId: input.datasetId, found: true, totalRecords: m.totalRecords, counts: m.counts, builtAt: m.builtAt };
    },
    selectAccounts(input): SelectAccountsResult {
      const store = warehouse();
      const m = store.getManifest(input.datasetId);
      const empty = { mode: "select" as const, datasetId: input.datasetId, state: input.state, found: false, accountsMatched: 0, accountsReturned: 0, totalRecords: 0, capped: false, perObject: {}, records: {} };
      if (!m) return empty;
      const pack = deps.packs.get(m.pack);
      const count = Math.min(Math.max(1, Math.floor(input.count ?? 10)), MAX_SELECT_ACCOUNTS);
      const maxRecords = Math.min(Math.max(1, Math.floor(input.maxRecords ?? DEFAULT_SELECT_MAX_RECORDS)), MAX_SELECT_RECORDS);
      const predicate = predicateFor(input.state, m.asOf);
      if (predicate == null) return { ...empty, found: true, note: "the 'urgent' state needs a corpus timeline anchor (asOf), which this corpus predates — re-materialize it to enable urgency." };
      const { refs, total } = store.selectAccountRefs(input.datasetId, predicate, count);
      let use = refs;
      let slice = buildWarehouseSlice(store, input.datasetId, pack.objects, m.counts, { accounts: use.length, leads: 0, accountRefs: use });
      // If the closed graph blows the record ceiling, trim accounts (a single rebuild) to fit.
      if (slice.stats.totalRecords > maxRecords && slice.stats.accounts > 0) {
        const avg = slice.stats.totalRecords / slice.stats.accounts;
        const fit = Math.max(1, Math.floor(maxRecords / avg));
        if (fit < use.length) {
          use = use.slice(0, fit);
          slice = buildWarehouseSlice(store, input.datasetId, pack.objects, m.counts, { accounts: use.length, leads: 0, accountRefs: use });
        }
      }
      return {
        mode: "select",
        datasetId: input.datasetId,
        state: input.state,
        found: true,
        accountsMatched: total,
        accountsReturned: slice.stats.accounts,
        totalRecords: slice.stats.totalRecords,
        capped: slice.stats.accounts < total,
        perObject: slice.stats.perObject,
        records: slice.records,
      };
    },
  };
}
