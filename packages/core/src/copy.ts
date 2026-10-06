// packages/core/src/copy.ts
//
// The copy-layer contracts. generate() defers all prose by emitting CopyRequests
// (in bundle.ts) and leaving the record's copy fields empty — the no-vapor-ware
// seam. A CopyProvider fills those requests into CopyResults, which the engine
// applies back onto the records. Core declares the SHAPES only; the engine owns
// the provider implementations (static templates, the Anthropic API, the Claude
// Code subscription), because they pull in SDKs/credentials core must stay free of.

import { z } from "zod";
import type { CopyRequest } from "./bundle.js";

/**
 * One filled copy artifact, addressing back to its CopyRequest.id. `subject` is
 * present for kinds that have one (email/note); transcripts carry only `body`.
 * `provider` records who produced it (provenance — a static fallback is honest
 * about being a fallback).
 */
export const CopyResult = z.object({
  id: z.string(),
  subject: z.string().optional(),
  body: z.string(),
  provider: z.string(),
});
export type CopyResult = z.infer<typeof CopyResult>;

/** What a provider may use while filling (the budget cap + an as-of anchor + logging). */
export interface CopyFillContext {
  /** ISO anchor so copy can reference "Tuesday"/"last week" coherently with the deal timeline. */
  asOf: string;
  /** Hard ceiling on LLM spend (USD). A provider stops calling the model once its running cost would exceed this; the remainder falls back to the static tier. Omit for no cap. */
  budgetUsd?: number;
  /** Cap on how many requests to fill via the model (a cheap smoke-test lever). Omit for all. */
  limit?: number;
  log?: (msg: string) => void;
  /**
   * Per-id corrective notes for a REGENERATION pass (set by the realism gate): the violations
   * the prior draft tripped, keyed by request id. A provider seeing a hint for a request rewrites
   * that email with buildRegenPrompt (fix-the-named-tell), else generates normally. Plain shape so
   * core never imports the linter.
   */
  regenHints?: ReadonlyMap<string, ReadonlyArray<{ rule: string; severity: string; detail: string }>>;
}

/**
 * A pluggable copy provider — turns CopyRequests into prose. May return FEWER
 * results than requests (budget/limit/error): the orchestrator static-fills the
 * remainder, so a provider never has to be exhaustive or fatal.
 */
export interface CopyProvider {
  /** "static" | "anthropic" | "claude-code". */
  id: string;
  /**
   * True if fill() is a pure function of its inputs (the static tier). The realism gate SKIPS a
   * deterministic provider — regenerating yields identical bytes, so the loop could never converge.
   */
  deterministic?: boolean;
  /** Can this provider run right now (key present, entitlement live)? */
  available(): Promise<boolean> | boolean;
  /** Fill what it can; report cost so the orchestrator can enforce the budget across providers. */
  fill(requests: CopyRequest[], ctx: CopyFillContext): Promise<CopyFillOutput>;
}

/** A provider's output: the results it produced + the spend it incurred. */
export interface CopyFillOutput {
  results: CopyResult[];
  /** Estimated USD spent by this provider (0 for static). */
  estCostUsd: number;
  /** True if the provider stopped early because the budget would be exceeded. */
  budgetExhausted: boolean;
}

/**
 * What the realism gate did (the lint→regenerate quality loop, engine-side). Declared here so
 * CopyFillReport can carry it without core depending on the engine; gate.ts re-exports this type.
 * Present on a report only when the gate actually ran (LLM providers; never for static).
 */
export interface GateReport {
  ran: boolean;
  /** Regeneration passes performed (0 if it converged or no-op'd immediately). */
  passes: number;
  /** Total emails regenerated across all passes. */
  regenerated: number;
  /** USD the gate's regenerations cost (0 on the subscription tier). */
  gateCostUsd: number;
  before: { clean: number; total: number; passRate: number };
  after: { clean: number; total: number; passRate: number };
  /** True if the corpus reached a clean state within the iteration cap. */
  converged: boolean;
  /** Emails that still tripped a rule at the cap — shipped at their BEST draft, listed honestly. */
  unresolved: Array<{ id: string; rules: string[] }>;
}

/** The orchestrated outcome across the primary provider + the static fallback. */
export interface CopyFillReport {
  /** Provider id that led the fill (the requested/selected primary). */
  provider: string;
  results: CopyResult[];
  /** Requests filled by the primary provider. */
  filledByPrimary: number;
  /** Requests that fell back to the static tier (budget, limit, error, or primary unavailable). */
  fallbacks: number;
  estCostUsd: number;
  budgetExhausted: boolean;
  /** The realism gate's outcome, when it ran (LLM primary only). */
  gate?: GateReport;
}

export type { CopyRequest };
