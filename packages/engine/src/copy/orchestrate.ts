// packages/engine/src/copy/orchestrate.ts
//
// The copy orchestrator: pick a primary provider, fill what it can, and ALWAYS
// static-fill the remainder so every CopyRequest ends up with a body (a deal with
// blank emails is worse than one with a templated email). Then applyCopy() writes
// the filled prose back onto the bundle's records. Pure of any provider internals —
// it composes CopyProviders through the core interface.

import type { CopyProvider, CopyRequest, CopyFillReport, CopyResult, CopyProviderId, GateReport, NarrativeBundle, GenericRecord } from "@dataseed/core";
import { StaticCopyProvider } from "./static-provider.js";
import { AnthropicCopyProvider } from "./anthropic-provider.js";
import { ClaudeCodeCopyProvider } from "./claude-code-provider.js";
import { gateCopy } from "./gate.js";

/** The standard provider set (preferred → fallback): anthropic, claude-code, static. */
export function buildProviders(): CopyProvider[] {
  return [new AnthropicCopyProvider(), new ClaudeCodeCopyProvider(), new StaticCopyProvider()];
}

export interface FillCopyOptions {
  /** Explicit provider choice, or "auto" to resolve by preference + availability. */
  requestedProvider?: "auto" | CopyProviderId;
  /** The org's probed preference (profile.copyProvider), used when requested is "auto". */
  profilePreferred?: CopyProviderId;
  budgetUsd?: number;
  /** Cap the number of MODEL-filled emails (rest go to static) — a cheap smoke-test lever. */
  limit?: number;
  /** Run the realism gate (lint→regenerate) over LLM-authored copy. Default: ON for non-deterministic primaries, OFF for static. */
  gate?: boolean;
  /** Max gate regeneration passes (default 2, hard-capped at 4). */
  gateIters?: number;
  asOf: string;
  log?: (m: string) => void;
}

/** Resolve which provider leads the fill: explicit override, else profile pref, else availability order. */
async function resolvePrimary(providers: CopyProvider[], opts: FillCopyOptions): Promise<CopyProvider> {
  const byId = (id: string) => providers.find((p) => p.id === id);
  const requested = opts.requestedProvider ?? "auto";
  if (requested !== "auto") {
    const p = byId(requested);
    if (!p) throw new Error(`unknown copy provider "${requested}"`);
    return p;
  }
  const order: string[] = [];
  if (opts.profilePreferred) order.push(opts.profilePreferred);
  for (const id of ["anthropic", "claude-code", "static"]) if (!order.includes(id)) order.push(id);
  for (const id of order) {
    const p = byId(id);
    if (p && (await p.available())) return p;
  }
  return byId("static")!;
}

/**
 * Fill every CopyRequest: run the resolved primary provider (within budget/limit),
 * then static-fill anything it left (budget/limit/error/unavailable). Every request
 * comes back with a result.
 */
export async function fillCopy(requests: CopyRequest[], providers: CopyProvider[], opts: FillCopyOptions): Promise<CopyFillReport> {
  const log = opts.log ?? (() => {});
  const staticP = providers.find((p) => p.id === "static") ?? new StaticCopyProvider();
  const primary = await resolvePrimary(providers, opts);

  let primaryResults: CopyResult[] = [];
  let estCostUsd = 0;
  let budgetExhausted = false;

  if (primary.id !== "static" && (await primary.available())) {
    log(`copy provider: ${primary.id} (primary)${opts.limit != null ? `, limit ${opts.limit}` : ""}${opts.budgetUsd != null ? `, budget $${opts.budgetUsd}` : ""}`);
    const out = await primary.fill(requests, { asOf: opts.asOf, budgetUsd: opts.budgetUsd, limit: opts.limit, log });
    primaryResults = out.results;
    estCostUsd = out.estCostUsd;
    budgetExhausted = out.budgetExhausted;
  } else if (primary.id !== "static") {
    log(`copy provider: ${primary.id} unavailable — using static for all`);
  }

  const filled = new Set(primaryResults.map((r) => r.id));
  const remainder = requests.filter((r) => !filled.has(r.id));
  // Static fills ALL of the remainder (no limit) so no email ships blank.
  const staticResults = remainder.length ? (await staticP.fill(remainder, { asOf: opts.asOf, log })).results : [];

  // Realism gate: regenerate primary-authored emails that trip a realism tell. Default on for LLM
  // tiers, off for static (deterministic — regen is identical). Only the primary's own emails are
  // gated; static fallbacks are left alone (asking the LLM to "fix" a template it never wrote is
  // off-contract and re-introduces spend the budget already declined).
  // KNOWN LIMITATION: the gate lints only the primary-authored set, so a CROSS_INSTANCE clone
  // BETWEEN a primary email and a static fallback isn't seen here (the op's final lint over
  // primary∪static still reports it honestly). This only arises under --budget/--limit (the only
  // way static fallbacks exist on an LLM run); a full run has none. Fix when it matters: pass the
  // static results to gateCopy as read-only corpus context (lintable, not regenerable).
  let gatedPrimary = primaryResults;
  let gate: GateReport | undefined;
  const gateOn = (opts.gate ?? (!primary.deterministic && primary.id !== "static")) && primaryResults.length > 0;
  if (gateOn) {
    const reqById = new Map(requests.map((r) => [r.id, r]));
    const targets = primaryResults.flatMap((r) => {
      const req = reqById.get(r.id);
      // The gate's lint is email-tuned (sign-off shape, thread "Re:", inbound/outbound). Task notes
      // and other kinds have a different shape, so they aren't email-gated here (kept as authored).
      if (!req || req.kind !== "email") return [];
      return [{ request: { id: req.id, scenario: req.scenario, seq: req.seq }, result: { id: r.id, subject: r.subject, body: r.body } }];
    });
    const res = await gateCopy(targets, primary, reqById, { asOf: opts.asOf, budgetUsd: opts.budgetUsd, spentSoFar: estCostUsd, maxIters: opts.gateIters, log });
    const gatedById = new Map(res.results.map((r) => [r.id, r]));
    gatedPrimary = primaryResults.map((r) => gatedById.get(r.id) ?? r); // never lose an email
    gate = res.report;
    estCostUsd += res.report.gateCostUsd;
    if (res.report.ran) {
      log(`realism gate: ${res.report.before.clean}/${res.report.before.total} → ${res.report.after.clean}/${res.report.after.total} clean after ${res.report.passes} pass(es)${res.report.converged ? " (converged)" : res.report.unresolved.length ? `, ${res.report.unresolved.length} unresolved` : ""}`);
    }
  }

  return {
    provider: primary.id,
    results: [...gatedPrimary, ...staticResults],
    filledByPrimary: primaryResults.length,
    fallbacks: staticResults.length,
    estCostUsd,
    budgetExhausted,
    gate,
  };
}

/** kind → which record fields carry the subject/body. (vtt/dc land later.) */
const FIELD_MAP: Record<string, { subject?: string; body: string }> = {
  email: { subject: "Subject", body: "TextBody" },
  task: { subject: "Subject", body: "Description" }, // logged-activity Task (Subject + Description)
  transcript: { body: "VersionData" }, // ContentVersion call recording — the transcript text is the file body
};

/**
 * Write filled copy back onto the bundle's records (in place), matching a result's
 * id to the record's `_ref`. Returns how many landed + any ids with no record.
 */
export function applyCopy(bundle: NarrativeBundle, results: CopyResult[]): { applied: number; unmatched: string[] } {
  const byRef = new Map<string, GenericRecord>();
  for (const recs of Object.values(bundle.records)) for (const r of recs) if (typeof r._ref === "string") byRef.set(r._ref, r);
  const kindById = new Map(bundle.copyRequests.map((c) => [c.id, c.kind]));

  let applied = 0;
  const unmatched: string[] = [];
  for (const res of results) {
    const rec = byRef.get(res.id);
    if (!rec) {
      unmatched.push(res.id);
      continue;
    }
    const map = FIELD_MAP[kindById.get(res.id) ?? "email"] ?? FIELD_MAP.email!;
    if (map.subject && res.subject != null) rec[map.subject] = res.subject;
    rec[map.body] = res.body;
    applied++;
  }
  return { applied, unmatched };
}
