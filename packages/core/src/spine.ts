// packages/core/src/spine.ts
//
// The spine-authoring contracts (Phase 4B). 4A builds a deterministic STATIC dossier; 4B lets an
// LLM author the dossier's NARRATIVE — the arc, each cast member's stance, and each beat's
// summary/what-it-conveys/sentiment — on top of that skeleton. The structural scaffold (which beats
// exist, when, who, inbound/outbound) is PINNED (the records were already emitted from it), so the
// LLM authors the STORY freely while the engine keeps determinism. Per Ben's decision, the authored
// draft is CACHED by (seed, account) — so a re-run reproduces it byte-for-byte, the determinism
// contract. Core declares the SHAPES only; the engine owns the provider implementations (CLI / API).

import { z } from "zod";
import { DossierSentiment, DossierSignalAim, type DealDossier } from "./dossier.js";

/**
 * The NARRATIVE layer an LLM authors over the deterministic skeleton. Keyed maps (not arrays) so a
 * provider addresses each cast member / beat by its stable ref and can't reorder or drop the scaffold.
 */
export const DossierDraft = z
  .object({
    /** 2–3 sentences: what's happening, the tension, where it's heading. */
    arc: z.string(),
    /** castRef → one-line stance ("championing internally, quiet since the CFO got involved"). */
    castStances: z.record(z.string(), z.string()).default({}),
    /** beatRef → the authored narrative for that beat (structure stays pinned in the skeleton). */
    beats: z.record(z.string(), z.object({ summary: z.string(), conveys: z.string().optional(), sentiment: DossierSentiment })).default({}),
    /** Optional refinement of the MEDDPICC signal aims the thread should yield. */
    signalAims: z.array(DossierSignalAim).optional(),
  })
  .strict();
export type DossierDraft = z.infer<typeof DossierDraft>;

/** One deal handed to a spine provider: its cache key + the deterministic skeleton dossier to enrich. */
export interface SpineRequest {
  /** Stable cache key for this deal ((seed, account)-derived) — a hit reproduces the draft. */
  dealKey: string;
  dossier: DealDossier;
}

/** What a spine provider may use while authoring (budget cap + as-of anchor + logging). */
export interface SpineAuthorContext {
  asOf: string;
  /** Hard USD ceiling; a provider stops once its running cost would exceed it (remainder → static). */
  budgetUsd?: number;
  /** Cap how many deals to author via the model (a cheap smoke-test lever). */
  limit?: number;
  log?: (msg: string) => void;
}

/** A provider's output: the drafts it authored (≤ requests) + the spend it incurred. */
export interface SpineAuthorOutput {
  drafts: Array<{ dealKey: string; draft: DossierDraft }>;
  estCostUsd: number;
  budgetExhausted: boolean;
}

/**
 * A pluggable spine provider — authors a dossier's narrative. May return FEWER drafts than requests
 * (budget/limit/error): the orchestrator keeps the static skeleton for the remainder, so a provider
 * never has to be exhaustive or fatal. Mirrors CopyProvider.
 */
export interface SpineProvider {
  /** "static" | "claude-code" | "anthropic". */
  id: string;
  /** True if author() is pure (the static tier — its draft IS the skeleton's own narrative). */
  deterministic?: boolean;
  available(): Promise<boolean> | boolean;
  author(requests: SpineRequest[], ctx: SpineAuthorContext): Promise<SpineAuthorOutput>;
}

/**
 * Merge an authored narrative draft onto the deterministic skeleton: STRUCTURE is pinned (every beat
 * keeps its ref/kind/day/author/direction/participant/detail — the records were emitted from these),
 * NARRATIVE comes from the draft (arc, per-cast stance, per-beat summary/conveys/sentiment, signal aims).
 * A beat/cast member the draft omits keeps its skeleton narrative — so a partial draft is safe.
 */
export function mergeDossier(skeleton: DealDossier, draft: DossierDraft, provenance: "static" | "llm"): DealDossier {
  return {
    ...skeleton,
    arc: draft.arc || skeleton.arc,
    cast: skeleton.cast.map((c) => ({ ...c, stance: draft.castStances[c.ref] ?? c.stance })),
    beats: skeleton.beats.map((b) => {
      const n = draft.beats[b.ref];
      return n ? { ...b, summary: n.summary, conveys: n.conveys ?? b.conveys, sentiment: n.sentiment } : b;
    }),
    signalAims: draft.signalAims ?? skeleton.signalAims,
    provenance,
  };
}
