// packages/engine/src/copy/gate.ts
//
// gateCopy — the realism gate's tier-2 quality loop. After a copy provider fills email bodies,
// voice-lint flags the realism tells; gateCopy REGENERATES just the flagged emails through the
// SAME primary provider with a corrective prompt (buildRegenPrompt names each tell + its fix),
// re-lints the FULL corpus, and repeats until clean or a small iteration cap. It is the
// no-vapor-ware enforcement seam: we don't hand-edit the model's output, we ask the model to fix
// the named defect and keep the draft only if it makes the WHOLE batch no worse.
//
// Design (from the gatecopy-design panel + adversarial review):
//  - PURE + separately testable: operates on LintTargets + the primary provider, returns spliced
//    results + a GateReport. fillCopy calls it as its final stage over only primary-authored emails.
//  - CORPUS-aware acceptance: a regenerated draft is kept only if it does not INCREASE the full
//    corpus's weighted violation score. This is the load-bearing correctness rule — scoring an
//    email in isolation is blind to CROSS_INSTANCE / STRUCTURAL (which need pairs / ≥5 emails), so
//    it would both reject a regen that de-clones (while adding a minor per-email tell) AND accept
//    one that newly clones a sibling. Scoring the whole corpus fixes both directions.
//  - SELECTIVE regeneration: per-email tells by their own id; CROSS_INSTANCE at most ONE email per
//    (scenario,position) cluster per pass (so two clones aren't rewritten into a fresh clone of
//    each other in one pass — clusters of ≥3 converge over passes); STRUCTURAL on a minimal
//    dominant-paragraph subset.
//  - Three stoppers: maxIters, the budget ceiling, and a no-progress guard (same emails dirty).
//  - SKIPS deterministic providers (static): regenerating yields identical bytes.

import type { CopyProvider, CopyRequest, CopyResult, CopyFillContext, GateReport } from "@dataseed/core";
import { lintCopy, dominantParagraphSubset, type LintTarget, type LintViolation, type Severity } from "./voice-lint.js";

export type { GateReport };

export interface GateResult {
  results: CopyResult[];
  report: GateReport;
}

interface GateOpts {
  asOf: string;
  budgetUsd?: number;
  /** USD already spent by the primary fill before the gate — so the gate honors the same hard cap. */
  spentSoFar: number;
  maxIters?: number;
  log?: (m: string) => void;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { fatal: 1000, high: 100, medium: 10, low: 1 };

/** Total weighted violation load across the whole corpus (the keep-best yardstick — corpus-aware). */
function corpusScore(targets: LintTarget[]): number {
  return lintCopy(targets).violations.reduce((s, v) => s + SEVERITY_WEIGHT[v.severity], 0);
}

/** A corpus is clean when every email passes and no corpus tell remains. */
function isClean(violations: LintViolation[]): boolean {
  return violations.length === 0;
}

/**
 * Run the lint→regenerate loop over `targets` (all primary-authored). Returns the best draft of
 * each email + a GateReport. No-ops (ran:false) for deterministic/static providers.
 */
export async function gateCopy(
  targets: LintTarget[],
  primary: CopyProvider,
  reqById: Map<string, CopyRequest>,
  opts: GateOpts,
): Promise<GateResult> {
  const log = opts.log ?? (() => {});
  const maxIters = Math.max(1, Math.min(4, opts.maxIters ?? 2));

  // Reconstruct full CopyResults (LintTarget.result lacks `provider`; all targets are primary-authored).
  const asResult = (id: string, subject: string | undefined, body: string): CopyResult => ({ id, subject, body, provider: primary.id });
  const orderedIds = targets.map((t) => t.result.id);
  const requestOf = new Map(targets.map((t) => [t.result.id, t.request]));

  const before0 = lintCopy(targets);
  const before = { clean: before0.cleanEmails, total: before0.emailsLinted, passRate: before0.passRate };

  // Deterministic providers (static) can't improve on regeneration — skip, report honestly.
  if (primary.deterministic || primary.id === "static") {
    log(`gate skipped: ${primary.id} is deterministic (regeneration is identical)`);
    return {
      results: targets.map((t) => asResult(t.result.id, t.result.subject, t.result.body)),
      report: { ran: false, passes: 0, regenerated: 0, gateCostUsd: 0, before, after: before, converged: isClean(before0.violations), unresolved: [] },
    };
  }

  // keep-best per id (the current accepted draft for each email).
  const best = new Map<string, CopyResult>();
  for (const t of targets) best.set(t.result.id, asResult(t.result.id, t.result.subject, t.result.body));
  const currentTargets = (): LintTarget[] =>
    orderedIds.map((id) => ({ request: requestOf.get(id)!, result: { id, subject: best.get(id)!.subject, body: best.get(id)!.body } }));

  let passes = 0;
  let regenerated = 0;
  let gateCostUsd = 0;
  let prevSignature = "";

  for (let iter = 0; iter < maxIters; iter++) {
    const report = lintCopy(currentTargets());
    if (isClean(report.violations)) break; // converged

    // ── Dirty set: which emails to regenerate this pass ──
    const dirty = new Set<string>();
    // per-email / per-thread tells: regenerate the offending email.
    for (const v of report.violations) {
      if (v.id === "<corpus>" || v.rule === "CROSS_INSTANCE_SIMILARITY") continue;
      dirty.add(v.id);
    }
    // CROSS_INSTANCE: at most ONE email per (scenario,position) cluster per pass (deterministic
    // pick) — regenerating two clones together can rewrite them into a fresh clone of each other.
    const crossByGroup = new Map<string, string[]>();
    for (const v of report.violations) {
      if (v.rule !== "CROSS_INSTANCE_SIMILARITY") continue;
      const req = requestOf.get(v.id);
      const key = req?.seq ? `${req.scenario}#${req.seq.index}` : v.id;
      (crossByGroup.get(key) ?? crossByGroup.set(key, []).get(key)!).push(v.id);
    }
    for (const ids of crossByGroup.values()) dirty.add([...ids].sort()[0]!);
    // STRUCTURAL_UNIFORMITY: a minimal dominant-paragraph subset to reshape.
    const structuralViolation = report.violations.find((v) => v.rule === "STRUCTURAL_UNIFORMITY");
    const structuralSubset = structuralViolation ? dominantParagraphSubset(currentTargets()) : [];
    for (const id of structuralSubset) dirty.add(id);
    if (dirty.size === 0) break;

    // No-progress guard: stop if the SAME emails are dirty for the SAME reasons as last pass (the
    // model can't shake it). Keying on id+rules — not id alone — lets an email that cleared one
    // tell but exposed another get a second, differently-hinted attempt.
    const signature = [...dirty]
      .sort()
      .map((id) => {
        const rules = report.violations.filter((v) => v.id === id).map((v) => v.rule);
        if (structuralSubset.includes(id)) rules.push("STRUCTURAL_UNIFORMITY");
        return `${id}:${[...new Set(rules)].sort().join("+")}`;
      })
      .join(",");
    if (signature === prevSignature) {
      log(`gate: no progress (same ${dirty.size} email(s) dirty) — stopping`);
      break;
    }
    prevSignature = signature;

    // Budget guard: never let gating exceed the user's hard cap.
    if (opts.budgetUsd != null && opts.spentSoFar + gateCostUsd >= opts.budgetUsd) {
      log(`gate: budget $${opts.budgetUsd} reached — stopping with ${dirty.size} email(s) unresolved`);
      break;
    }

    // Per-id corrective hints: each dirty email's own violations, plus a structural note for the
    // subset (STRUCTURAL_UNIFORMITY is attributed to "<corpus>", so inject it by id here).
    const structuralDetail = structuralViolation?.detail ?? "vary the structure";
    const hints = new Map<string, Array<{ rule: string; severity: string; detail: string }>>();
    for (const id of dirty) {
      const own = report.violations.filter((v) => v.id === id).map((v) => ({ rule: v.rule, severity: v.severity, detail: v.detail }));
      if (structuralSubset.includes(id)) own.push({ rule: "STRUCTURAL_UNIFORMITY", severity: "high", detail: structuralDetail });
      hints.set(id, own);
    }

    const dirtyReqs = [...dirty].map((id) => reqById.get(id)).filter((r): r is CopyRequest => !!r);
    const remaining = opts.budgetUsd != null ? Math.max(0, opts.budgetUsd - opts.spentSoFar - gateCostUsd) : undefined;
    const ctx: CopyFillContext = { asOf: opts.asOf, budgetUsd: remaining, log, regenHints: hints };

    let out: { results: CopyResult[]; estCostUsd: number };
    try {
      out = await primary.fill(dirtyReqs, ctx);
    } catch (e) {
      log(`gate: regeneration pass failed (${(e as Error).message}) — keeping current drafts`);
      break;
    }
    gateCostUsd += out.estCostUsd;
    passes++;

    // Splice winners. Accept a regenerated draft only if it does not INCREASE the full corpus's
    // weighted violation load — so a per-email fix or a corpus de-clone is taken, while a draft
    // that newly clones a sibling or adds tells is rejected (greedy, evaluated against the evolving
    // corpus). An email therefore never ships a corpus-worse draft than what it had.
    let baseScore = corpusScore(currentTargets());
    for (const r of out.results) {
      const saved = best.get(r.id);
      if (!saved) continue;
      regenerated++;
      best.set(r.id, { ...r, provider: primary.id }); // tentative
      const trialScore = corpusScore(currentTargets());
      if (trialScore <= baseScore) baseScore = trialScore; // accept
      else best.set(r.id, saved); // revert — corpus-worse
    }
    log(`gate: pass ${passes} regenerated ${dirtyReqs.length} email(s)`);
  }

  const finalTargets = currentTargets();
  const after0 = lintCopy(finalTargets);
  const after = { clean: after0.cleanEmails, total: after0.emailsLinted, passRate: after0.passRate };

  // Honest residual: which emails still trip a rule (corpus tells folded under "<corpus>").
  const residual = new Map<string, Set<string>>();
  for (const v of after0.violations) (residual.get(v.id) ?? residual.set(v.id, new Set()).get(v.id)!).add(v.rule);
  const unresolved = [...residual.entries()].map(([id, rules]) => ({ id, rules: [...rules] }));

  return {
    results: orderedIds.map((id) => best.get(id)!),
    report: { ran: true, passes, regenerated, gateCostUsd, before, after, converged: isClean(after0.violations), unresolved },
  };
}

export default gateCopy;
