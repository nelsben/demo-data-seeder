// packages/core/src/pack.ts
//
// TargetPack — the plug-in contract that makes this a GENERAL data-testing app.
// A pack encapsulates everything domain-specific about generating data for one
// target schema (today: `salescloud`, standard Sales Cloud objects — no custom/__c
// objects). The engine drives ANY pack through this interface and never imports a
// concrete pack.
//
// Design rule: the engine depends on @dataseed/core; each pack depends on
// @dataseed/core; the engine receives a pack at runtime (via a registry). Core
// never imports a pack — no cycles, no pack-specific leakage into the core.

import type { ZodTypeAny } from "zod";
import type { CapabilityProfile } from "./capability-profile.js";
import type { BundlePlan, BundleRecords, BundleDirectives, CopyRequest } from "./bundle.js";
import type { Rng } from "./rng.js";
import type { AccountIdentity } from "./identity.js";

/** A restricted-picklist contract, keyed `Object.Field` (a standard or custom API field name) → the exact valid values. */
export type PicklistContract = Readonly<Record<string, readonly string[]>>;

/** One weighted value in a variability dimension. */
export interface WeightedValue {
  value: string;
  weight: number;
}

/**
 * A pack's variability matrix: dimension name → weighted values the plan samples
 * one of per unit (e.g. {industry: [...15...], dealSizeBand: [...6 bands...]}). The
 * sampled choices land in PlanUnit.traits. Generic — the engine samples; the pack
 * defines the dimensions and their realism weights.
 */
export type VariabilityMatrix = Readonly<Record<string, readonly WeightedValue[]>>;

/**
 * One derived-record probe — an object the TARGET PIPELINE produces from seeded inputs
 * (not a seeded input itself). Lets the app show the synthesis payoff after a load.
 */
export interface SynthesisProbe {
  /** sObject API name the pipeline derives, e.g. a custom object a downstream automation writes. */
  object: string;
  /** Human label for the UI, e.g. "Signals". */
  label: string;
  /** Optional field to surface a sample of (e.g. a scorecard JSON / summary). */
  sampleField?: string;
}

/** What a pack's downstream pipeline produces — so the app can verify synthesis, not just the load. */
export interface SynthesisView {
  probes: SynthesisProbe[];
}

/** What the engine hands a pack's generate(): the plan + live profile + a seeded rng + the as-of anchor. */
export interface GenerateContext {
  plan: BundlePlan;
  profile: CapabilityProfile;
  /** Root rng (seeded from plan.seed); derive per-unit streams with rng.derive("unit", i). */
  rng: Rng;
  /** ISO 8601 anchor for all relative timelines. */
  asOf: string;
  /**
   * Streaming seam (for the corpus warehouse). When set, `generate` emits only PART of the bundle so the
   * caller can stream a 100K corpus without holding it all in memory:
   *  - `scaffold: true`  → the up-front-once records (config, foreground deals, leads, the User pool) and
   *    NO bulk population. Emitted once.
   *  - `scaffold: false` → ONLY bulk accounts in [start, end) (and their subtrees), NO scaffold.
   * Safe to slice ONLY because every bulk record derives purely from (seed, accountIndex) — the bulk tier
   * never reads the foreground rng — so scaffold-less batches are byte-identical to the same slice of a
   * full generate. A pack that ignores `bulkRange` (generates everything) is still correct, just not
   * streamable. See bulkRefLocality + the ref-locality test for the eviction-safety invariant this rests on.
   */
  bulkRange?: { start: number; end: number; scaffold: boolean };
  /**
   * Optional LLM-authored SYNTHETIC account identities, keyed by `unit.index`. When a foreground unit's
   * index is present, the pack uses that synthetic company in place of its fixed real-anchor — the
   * single-account protocol's seam (see seed-account). Determinism is preserved by the identity cache
   * ((seed, index)). Absent ⇒ the pack falls back to its anchors (existing behavior, byte-identical).
   */
  identities?: ReadonlyMap<number, AccountIdentity>;
}

/** What a pack's generate() returns: records (+ copy requests + opaque config). */
export interface GenerateOutput {
  /** Pack Layer-1/config records (opaque to core). */
  config?: unknown;
  /** Records keyed by sObject API name. */
  records: BundleRecords;
  /** Copy intents for the M5 copy layer to realize (prose deferred — no vapor-ware). */
  copyRequests?: CopyRequest[];
  /** Post-load directives (e.g. lead conversions) the loader runs after inserts. */
  directives?: BundleDirectives;
}

/** One issue a pack raises while validating a profile against its needs. */
export interface PackRequirement {
  /** e.g. "object:Asset" | "field:Opportunity.ForecastCategoryName" | "feature:DataCloud". */
  kind: string;
  detail: string;
  /** blocking → the pack cannot seed; warning → degraded but possible. */
  severity: "blocking" | "warning";
}

/**
 * A target pack. M-generalize ships the descriptive surface (id, objects,
 * picklists, scenarios, schemas, requirement check); the generate/copy/load
 * behaviours are layered on in later milestones via the same object.
 */
export interface TargetPack {
  /** Stable id used in ScopeParams.pack and the registry (e.g. "salescloud"). */
  readonly id: string;
  /** Human label for the UI. */
  readonly label: string;
  /** One-line description of what this pack seeds. */
  readonly description: string;

  /** sObject API names this pack writes, in dependency (load) order. */
  readonly objects: readonly string[];

  /**
   * The seeded INPUT objects that FIRE the target's trigger/automation cascade on insert (e.g. a
   * downstream EmailMessage/Task/transcript signal-extraction pipeline). Loading these has an
   * async/LLM blast radius; a `cascade: "off"` disperse excludes them to fill an org structurally at
   * zero pipeline cost. Omitted ⇒ the pack has no cascade (nothing to exclude / estimate).
   */
  readonly cascadeObjects?: readonly string[];

  /** The restricted-picklist truth this pack must honor (overridden by live describe when available). */
  readonly picklists: PicklistContract;

  /** Named scenarios/arcs this pack supports (the vocabulary for ScopeParams.scenarioMix). */
  readonly scenarios: readonly string[];

  /** Per-object Zod schema for validating generated records before load. */
  readonly recordSchemas: Readonly<Record<string, ZodTypeAny>>;

  /** The variability dimensions the plan samples per unit (industry, deal-size band, …). */
  readonly variability: VariabilityMatrix;

  /** Rough record count one unit produces — the plan uses it to clamp volume to the record budget. */
  readonly recordsPerUnitEstimate: number;

  /**
   * Rough record count ONE background/bulk population entity produces (cheaper than a foreground unit —
   * structural records, no narrative signal streams). The plan uses it to clamp `population` against the
   * budget left after foreground `volume`. Omitted ⇒ the pack ignores `population` (no bulk tier).
   */
  readonly recordsPerPopulationUnitEstimate?: number;

  /**
   * Additional records ONE bulk account produces at FULL bulkDensity (1.0) beyond the structural base
   * above — the wider object graph the pack layers on per `bulkDensity` (e.g. salescloud's buying
   * committees, activity timelines, Assets, Cases). The plan scales it by `scope.bulkDensity` so the
   * record-budget clamp tracks the density knob honestly. Omitted ⇒ 0 (density has no budget effect).
   */
  readonly recordsPerPopulationUnitFullDensityDelta?: number;

  /**
   * Shared CATALOG objects that aren't per-unit and have no Account root, so the additive
   * idempotency (keyed on the root object) can't dedupe them — without this they'd duplicate on
   * every load (e.g. Product2, PricebookEntry). The loader UPSERTS them: it resolves an existing
   * org record by a natural key and reuses its Id (remapping in-bundle refs), inserting only the
   * missing ones. Order matters — a `keyByRef` entry resolves against refs an earlier entry set.
   *   - keyField:  dedupe by a scalar field value        (Product2 → "ProductCode")
   *   - keyByRef:  dedupe by a resolved lookup ref's Id   (PricebookEntry → "Product2Id")
   *   - keyFields: dedupe by a COMPOSITE natural key      (OpportunityLineItem → ["OpportunityId","Product2Id"])
   *               — for objects whose uniqueness needs >1 field (a single field alone can repeat).
   */
  readonly catalog?: ReadonlyArray<{ object: string; keyField?: string; keyByRef?: string; keyFields?: readonly string[] }>;

  /**
   * Optional: the records this pack's TARGET PIPELINE derives from the seeded inputs
   * (signals, briefs, …). When present, the app can verify synthesis after a load —
   * not just that records landed, but that the live pipeline produced its outputs.
   */
  readonly synthesisView?: SynthesisView;

  /**
   * Optional: the seeded INPUT objects to read back on Verify (Accounts, Opportunities,
   * EmailMessages, Tasks, line items). Distinct from synthesisView (derived outputs) — together
   * they show the whole chain, inputs → outputs, so an SE confirms the load landed AND the
   * pipeline ran. Counts are org-wide (these orgs are single-purpose), a landing sanity check.
   */
  readonly inputView?: SynthesisView;

  /**
   * Inspect a CapabilityProfile and report what's missing for THIS pack to seed
   * (objects absent, required fields not createable, a needed feature off). Pure;
   * fail-open at the call site. Empty array ⇒ the org can host this pack.
   */
  checkRequirements(profile: CapabilityProfile): PackRequirement[];

  /**
   * Turn the plan's units into records + copy requests (+ Layer-1 config). PURE and
   * deterministic given ctx.rng/asOf — no Math.random/Date.now, no I/O. Prose copy is
   * NOT produced here: emit a CopyRequest per body and leave the field empty for the
   * M5 copy layer (the no-vapor-ware seam). Honors ctx.bulkRange for streaming (optional).
   */
  generate(ctx: GenerateContext): GenerateOutput;

  /**
   * Declares the bulk tier's ref locality, enabling streaming materialize (and, later, a bounded-memory
   * loader). `'account-major'` asserts every bulk record references ONLY records in its own account's
   * subtree or a non-bulk shared ref (catalog/user/pool) — never another bulk account. This is an
   * INVARIANT, not a guarantee: the locality test derives it from the actual emitted refs and fails the
   * day a cross-account bulk ref is introduced. Omit (undefined) if the pack's bulk tier isn't streamable.
   */
  readonly bulkRefLocality?: "account-major";
}

/** A tiny in-memory registry so the engine/CLI can resolve a pack by id. */
export class PackRegistry {
  private readonly packs = new Map<string, TargetPack>();

  register(pack: TargetPack): this {
    if (this.packs.has(pack.id)) throw new Error(`pack already registered: ${pack.id}`);
    this.packs.set(pack.id, pack);
    return this;
  }

  get(id: string): TargetPack {
    const p = this.packs.get(id);
    if (!p) throw new Error(`unknown pack: ${id} (registered: ${[...this.packs.keys()].join(", ") || "none"})`);
    return p;
  }

  has(id: string): boolean {
    return this.packs.has(id);
  }

  list(): TargetPack[] {
    return [...this.packs.values()];
  }
}
