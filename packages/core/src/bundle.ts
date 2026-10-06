// packages/core/src/bundle.ts
//
// The NarrativeBundle — the GENERIC, domain-agnostic seam between the engine
// stages: `generate/` builds it, `copy/` patches copy fields, `load/`
// topologically loads it. Core knows it only as "records keyed by sObject API
// name, plus a config blob, copy requests, and a plan." The target PACK owns the
// per-object Zod schemas and validates records against them — core does not know
// what an `Account` or any app-specific custom object is.
//
// This keeps the engine target-agnostic: a new target = a new pack, never a core
// edit.

import { z } from "zod";
import { SeedMode } from "./scope-params.js";
import { DossierBeat } from "./dossier.js";

/** A single record, keyed by exact field API name → value. The pack's schema validates it. */
export const GenericRecord = z.record(z.string(), z.unknown());
export type GenericRecord = z.infer<typeof GenericRecord>;

/**
 * Reserved `_refs`/`_softRefs` target for a reference that resolves to a PRE-EXISTING org record
 * the seeder does not generate — currently the standard Pricebook2 (one per org). A pack emits it
 * as a lookup target; the loader resolves it once at load time. As a HARD `_refs` target it skips
 * the record when unresolved (a PricebookEntry needs its pricebook); as a `_softRefs` target it
 * drops the field but keeps the record (an Opportunity loads even without a pricebook).
 */
export const STANDARD_PRICEBOOK_REF = "@standardPricebook";

/**
 * Sentinel prefix for a `_refs`/`_softRefs` target that resolves to a PRE-EXISTING org record the
 * seeder does NOT generate, matched by a natural key: `@existing:<sobject>:<field>:<value>`. Where
 * STANDARD_PRICEBOOK_REF is one fixed record, this resolves ANY object/field/value at load time (via
 * the loader's idsByField) — used to attach seeded records to config the org already owns, e.g. a
 * mapping rule's lookups to a framework or concept-library record the app owns. As a HARD
 * `_refs` target it SKIPS the record when unresolved (a mapping rule without its framework is
 * useless); as a `_softRefs` target it drops the field and keeps the record.
 */
export const EXISTING_REF_PREFIX = "@existing:";

/** Build an `@existing:` ref target. `value` is matched against `field` on `sobject` at load time. */
export function existingRef(sobject: string, field: string, value: string): string {
  return `${EXISTING_REF_PREFIX}${sobject}:${field}:${value}`;
}

/**
 * Parse an `@existing:` ref target into its parts, or null if `ref` isn't one. Only the first two
 * ":" after the prefix are structural — the value itself may contain ":" (kept verbatim).
 */
export function parseExistingRef(ref: string): { sobject: string; field: string; value: string } | null {
  if (!ref.startsWith(EXISTING_REF_PREFIX)) return null;
  const body = ref.slice(EXISTING_REF_PREFIX.length);
  const i = body.indexOf(":");
  if (i < 0) return null;
  const j = body.indexOf(":", i + 1);
  if (j < 0) return null;
  return { sobject: body.slice(0, i), field: body.slice(i + 1, j), value: body.slice(j + 1) };
}

/**
 * Records keyed by sObject API name (e.g. "Account", "Opportunity"). The
 * load topology + per-object schemas come from the active pack.
 */
export const BundleRecords = z.record(z.string(), z.array(GenericRecord));
export type BundleRecords = z.infer<typeof BundleRecords>;

/**
 * The copy seam: `generate/` emits records with copy fields empty plus a
 * CopyRequest manifest (the intent to fill them). Generic across packs — `kind`
 * and `scenario` are free strings the pack defines.
 */
export const CopyRequest = z
  .object({
    /** Stable id so a filled body addresses back to the record/field it belongs to. */
    id: z.string(),
    /** e.g. "email" | "vtt" | "dc-interaction" | "note" — the pack's content kinds. */
    kind: z.string(),
    /** The pack scenario this copy realizes. */
    scenario: z.string(),
    /** The beat to realize: what the LLM must say (who, the gap, the numbers). */
    beatIntent: z.string(),
    speakers: z.array(z.string()).default([]),
    /**
     * Structured deal facts the pack already knows — so providers (incl. the static
     * fallback) can weave the SAME specifics the loaded SF records carry: real numbers,
     * names, and dates. Without these, static copy is generic and drives no signal
     * extraction (specifics are what the pipeline turns into signals).
     */
    facts: z
      .object({
        amountUsd: z.number().optional(),
        closeDate: z.string().optional(),
        primaryContact: z.string().optional(),
        counterpart: z.string().optional(),
        sector: z.string().optional(),
        /**
         * What the AE's company SELLS — the seller-side product (a horizontal SaaS platform, the same
         * catalog across deals). Passed so providers pitch OUR product, never the prospect's own — the
         * fatal "self-product" tell (pitching Lyft routing, Veeva a Vault workflow).
         */
        sells: z.string().optional(),
        /**
         * Real, public, non-financial context about the PROSPECT company, so copy references
         * its actual world (a Snowflake deal mentions warehouse credits, not generic "ROI").
         * The pack resolves this per anchor; providers weave ONE detail per thread. Kills the
         * "interchangeable company" tell. See the pack's grounding fact-packs.
         */
        grounding: z
          .object({
            does: z.string().optional(),
            products: z.array(z.string()).optional(),
            buyingDept: z.string().optional(),
            painPhrase: z.string().optional(),
            competitors: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .partial()
      .optional(),
    /**
     * Where this artifact sits in its deal's timeline (0-based). Lets a provider render a
     * SENTIMENT TRAJECTORY across a thread — early touches set the deal up, later ones carry
     * the scenario's climax (the positive→risk arc the BRIEF calls load-bearing).
     */
    seq: z.object({ index: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
    /**
     * The WRITER of this artifact — a stable per-person voice so a CFO and a champion never
     * sound alike and one person reads consistently across a thread. `register` is the LLM
     * voice instruction; the static tier uses `name` for the sign-off.
     */
    voiceCard: z
      .object({
        name: z.string(),
        persona: z.string().optional(),
        register: z.string().optional(),
      })
      .optional(),
    /** Groups every artifact of one deal's thread (stable per deal). */
    threadId: z.string().optional(),
    /** The id of the prior artifact in this thread, so a reply can answer/quote it (undefined for the opener). */
    inReplyTo: z.string().optional(),
    /** The thread's base subject — the opener uses it bare; replies become "Re: <seedSubject>". */
    seedSubject: z.string().optional(),
    /**
     * The dossier BEAT this artifact realizes (Phase 4) — the authored event (sentiment, what it must
     * convey, who) this copy is the realization of. The full per-deal DealDossier rides on the deal's
     * Opportunity `_meta.dossier`; the copy layer (4C) reads both to author thread-aware, spine-consistent prose.
     */
    beat: DossierBeat.optional(),
    /**
     * Thread-aware context (Phase 4C) — the COMPACT story-so-far the copy layer needs so an artifact
     * follows from the deal instead of being authored in isolation: the deal's `arc` and the prior
     * beats' one-line summaries (oldest first). Lets email N answer email N-1 (the judge's "a reply that
     * doesn't respond" fix) without paying to stuff every prior body into the prompt. Stamped by
     * attachSpineContext from the deal's dossier; present even on the static path.
     */
    spineContext: z
      .object({
        arc: z.string().optional(),
        storySoFar: z.array(z.string()).default([]),
        /** The deal's FULL cast (name + persona) — the single source of truth for who exists. The copy
         *  layer pins the LLM to it so it never invents a stakeholder or drifts a name mid-thread (the
         *  audit's "Sofia Chen → Sofia Vance" / two-"Elena" tells). */
        roster: z.array(z.object({ name: z.string(), persona: z.string() })).default([]),
        /** Facts SETTLED (or still OPEN) by earlier beats in this deal, oldest first — the deal's shared
         *  memory. A "settled" fact (a budget sign-off, an agreed close date) is DONE: later artifacts must
         *  treat it as known, never re-announce it as fresh news or contradict it (the audit's recurring
         *  "signed off this morning" + sliding-deadline tells). Accumulated by attachSpineContext from the
         *  prior beats' `establishes`. */
        establishedFacts: z.array(z.object({ key: z.string(), value: z.string(), status: z.enum(["settled", "open"]) })).optional(),
        /** The COMPLETE set of interactions that exist on this deal (every beat), each with its date +
         *  computed weekday — the deal's shared calendar. Lets the copy layer forbid the date tells: citing a
         *  call/meeting on a date no record exists for, narrating a FUTURE-dated interaction in the past tense,
         *  or naming a wrong weekday (the audit's "Thursday (June 19)" when June 19 is a Friday). */
        activityIndex: z.array(z.object({ date: z.string(), weekday: z.string(), kind: z.string() })).optional(),
        /** The Opportunity's StageName — the copy layer holds the prose to this stage's maturity so the
         *  narrative can't run PAST where the record says the deal is (the audit's "Stage=Proposal but the
         *  emails are already trading redlined contracts / scheduling implementation" tell). */
        stageName: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type CopyRequest = z.infer<typeof CopyRequest>;

/**
 * One planned top-level unit (the pack interprets it — for the salescloud pack, one Account/deal).
 * The plan is a COMPLETE deterministic blueprint: scenario + a derived sub-seed +
 * the sampled variability traits (industry, deal-size band, …). generate() turns
 * each unit into records with no further plan-level randomness.
 */
export const PlanUnit = z
  .object({
    index: z.number().int().nonnegative(),
    scenario: z.string(),
    /** Stable per-unit sub-seed (deriveSeed(rootSeed, "unit", index)). */
    seed: z.number().int(),
    /** Sampled values per the pack's variability dimensions (e.g. {industry, dealSizeBand}). */
    traits: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type PlanUnit = z.infer<typeof PlanUnit>;

/** The plan stamped onto the bundle by the pure `plan/` stage. */
export const BundlePlan = z
  .object({
    pack: z.string(),
    mode: SeedMode,
    withDc: z.boolean(),
    /** Foreground copy-fill mode used when materializing a corpus — PART OF THE CORPUS IDENTITY (different
     *  modes are different datasets). "static" is the deterministic default (a corpus is never blank); the LLM
     *  modes carry VP-grade hero copy. "none" leaves bodies deferred (blank) for a pure-structural corpus. */
    copyMode: z.enum(["static", "claude-code", "anthropic", "auto", "none"]).default("static"),
    namespacePrefix: z.string().nullable().default(null),
    /** Resolved root seed (string seeds hashed to a uint32 at plan-time). */
    seed: z.number().int(),
    /** As-of anchor for all relative timelines (ISO 8601). */
    asOf: z.string(),
    /** Units the caller asked for vs actually planned (record budget may clamp). */
    requestedVolume: z.number().int().nonnegative(),
    volume: z.number().int().nonnegative(),
    /** Background/bulk primary entities planned beyond `volume` (clamped to the remaining budget). 0 = foreground only. */
    population: z.number().int().nonnegative().default(0),
    /** How richly the bulk tier fleshes out the wider object graph (Phase 4E); 0 = structural, 1 = full. */
    bulkDensity: z.number().min(0).max(1).default(0.6),
    /** Resolved sales-rep User pool size (clamped, profile-gated at plan-time). 0 = no pool (running-user owns bulk). */
    userPoolSize: z.number().int().nonnegative().default(0),
    /** Profile Name the pool users are created under (hard `@existing` lookup). Only meaningful when userPoolSize > 0. */
    userProfileName: z.string().default("Standard User"),
    budgetCapped: z.boolean().default(false),
    /** Exact integer count per scenario (sums to volume). */
    scenarioCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /** The per-unit blueprint. */
    units: z.array(PlanUnit).default([]),
    /** Rough estimated total records (for budget display); refined post-generate. */
    estimatedRecords: z.number().int().nonnegative().default(0),
    perObjectCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();
export type BundlePlan = z.infer<typeof BundlePlan>;

/**
 * One lead conversion the loader performs AFTER inserting records — Lead→Account/Contact/Opportunity
 * isn't a bulk insert, it's the SOAP convertLead call. The pack emits these as directives; the loader
 * resolves the in-bundle refs to real Ids and runs them as a post-load step.
 */
export const LeadConversion = z
  .object({
    /** In-bundle ref of the Lead to convert. */
    leadRef: z.string(),
    /** A "converted" Lead.Status MasterLabel (e.g. "Closed - Converted"); the loader re-resolves the org's real one. */
    convertedStatus: z.string(),
    /** Name for the Opportunity the conversion creates (omit + doNotCreateOpportunity to convert without one). */
    opportunityName: z.string().optional(),
    doNotCreateOpportunity: z.boolean().optional(),
    /** Optional in-bundle Account ref to convert INTO (else Salesforce creates a new Account from Lead.Company). */
    accountRef: z.string().optional(),
  })
  .strict();
export type LeadConversion = z.infer<typeof LeadConversion>;

/** Post-load directives — actions the loader runs after the record inserts (not records themselves). */
export const BundleDirectives = z.object({ convertLeads: z.array(LeadConversion).default([]) }).strict();
export type BundleDirectives = z.infer<typeof BundleDirectives>;

export const NarrativeBundle = z
  .object({
    /** Pack-specific Layer-1/config records (e.g. a pack's config records). Opaque to core; the pack shapes it. */
    config: z.unknown().optional(),
    /** Generated records keyed by sObject API name, in the pack's load order. */
    records: BundleRecords.default({}),
    copyRequests: z.array(CopyRequest).default([]),
    /** Post-load actions (e.g. lead conversions) the loader runs after inserts. */
    directives: BundleDirectives.optional(),
    plan: BundlePlan,
  })
  .strict();
export type NarrativeBundle = z.infer<typeof NarrativeBundle>;
