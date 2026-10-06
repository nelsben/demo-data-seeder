// packages/core/src/dossier.ts
//
// The Deal Dossier — the per-account NARRATIVE SPINE (Phase 4). Where today's generation
// *constrains* a deal's story (cadence curve + persona mix) but never *authors* it, the dossier
// is the single authored source of truth a whole account derives from: the arc, the named cast,
// a chronological BEAT TIMELINE (the events that become emails/tasks/transcripts), the shared
// numbers, and the MEDDPICC signal aims the thread should yield. Every object of the account is
// generated FROM this object, so they cohere by construction.
//
// 4A ships a deterministic STATIC dossier (provenance "static"); 4B lets Claude author it. Either
// way the dossier is a cached, deterministic INPUT to the (still-deterministic) structure step.

import { z } from "zod";

/** The four sentiment values the pipeline understands — a beat's place on the deal's trajectory. */
export const DossierSentiment = z.enum(["Positive", "Neutral", "Negative", "Risk"]);
export type DossierSentiment = z.infer<typeof DossierSentiment>;

/** One event on the deal's timeline — becomes exactly one input artifact (email / task / transcript). */
export const DossierBeat = z
  .object({
    /** The artifact's record `_ref` (so the beat and its emitted record address each other). */
    ref: z.string(),
    /** Which input stream this beat realizes. */
    kind: z.enum(["email", "task", "transcript"]),
    /** When it happens — full ISO timestamp (backdated before asOf to manufacture velocity). */
    day: z.string(),
    /** Display name of who writes/speaks it. */
    author: z.string(),
    /** Cast `_ref` of the author (a buyer-side contact); omitted ⇒ the selling-side rep (the AE). */
    authorRef: z.string().optional(),
    /** The buyer-side contact this beat involves/attributes to (for facts + record attribution). */
    participantRef: z.string().optional(),
    /** Email direction relative to the seller (emails only). */
    direction: z.enum(["inbound", "outbound"]).optional(),
    /** This beat's place on the authored sentiment trajectory. */
    sentiment: DossierSentiment,
    /** The narrative intent — what this beat is about (drives the copy prompt). */
    summary: z.string(),
    /** The one specific fact this beat must carry (shared across the deal so artifacts agree). */
    conveys: z.string().optional(),
    /**
     * Settled/open facts this beat COMMITS to the deal (a budget sign-off, an agreed close date). The copy
     * layer accumulates these into each later artifact's story-so-far so a SETTLED fact is treated as KNOWN —
     * never re-announced as fresh news, never contradicted (the audit's "Diego signed off this morning"
     * recurring 4× weeks apart, and deadlines silently sliding). Authored deterministically by the static
     * spine at pivotal beats; absent on most beats. status: "settled" = done; "open" = raised, not resolved.
     */
    establishes: z.array(z.object({ key: z.string(), value: z.string(), status: z.enum(["settled", "open"]) })).optional(),
    /** The deal's mutable state AS OF this beat — the authoritative deadline / budget ceiling / sign-off at
     *  this moment, so a later change is explicit and acknowledgeable rather than a silent contradiction. */
    dealState: z.object({ closeDate: z.string().optional(), ceilingUsd: z.number().optional(), signedOff: z.boolean().optional() }).optional(),
    /** Kind-specific reconstruction hints the emitter needs (task activity, transcript content-kind/source). */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type DossierBeat = z.infer<typeof DossierBeat>;

/** A named member of the deal's buying committee — MUST be a seeded Contact (never invented). */
export const DossierCastMember = z
  .object({
    ref: z.string(), // the Contact `_ref`
    name: z.string(),
    persona: z.string(),
    stance: z.string().optional(), // "championing internally, but quiet since the CFO got involved"
  })
  .strict();
export type DossierCastMember = z.infer<typeof DossierCastMember>;

/** A MEDDPICC signal the dossier intends its thread to produce — the no-vapor-ware assertion target. */
export const DossierSignalAim = z.object({ rule: z.string(), sentiment: DossierSentiment }).strict();
export type DossierSignalAim = z.infer<typeof DossierSignalAim>;

/** The authored spine of one account's deal. */
export const DealDossier = z
  .object({
    scenario: z.string(),
    /** 2–3 sentences: what's happening, the tension, where it's heading. */
    arc: z.string(),
    cast: z.array(DossierCastMember),
    /** The chronological event timeline (oldest first) — the authority for which artifacts exist. */
    beats: z.array(DossierBeat),
    numbers: z.object({ amountUsd: z.number(), ceilingUsd: z.number().optional(), painMetric: z.string().optional() }),
    /** A real rival from the prospect's world — never the prospect's own product. */
    competitor: z.string().optional(),
    /** The Opportunity's StageName — pinned so the copy layer can hold the prose to this maturity (no
     *  contract redlines/implementation if it's only at Proposal; no pre-RFP talk if it's at Negotiation). */
    stageName: z.string().optional(),
    /** The MEDDPICC signals this story should yield (so we can assert the derived brief matches). */
    signalAims: z.array(DossierSignalAim).default([]),
    /** "static" = templated + deterministic (4A); "llm" = authored by Claude, cached (4B). */
    provenance: z.enum(["static", "llm"]).default("static"),
  })
  .strict();
export type DealDossier = z.infer<typeof DealDossier>;
