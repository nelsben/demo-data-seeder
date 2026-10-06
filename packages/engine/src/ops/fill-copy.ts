// packages/engine/src/ops/fill-copy.ts
//
// `fill-copy` — the M5 op: take the bundle plan-demo produced (EmailMessage bodies
// empty + a CopyRequest manifest) and fill every body with real prose, then write
// the bundle back so load-demo ships populated emails. Picks the copy provider by
// --provider (or the org's probed preference), generates within --budget, and
// ALWAYS static-fills anything the model left — no email ships blank. NO org writes
// (that's load-demo); this only rewrites the local bundle. Idempotent in effect:
// re-running regenerates the copy (set a --seed upstream for byte-stable static copy).

import { existsSync, readFileSync } from "node:fs";
import { NarrativeBundle, type CopyProviderId, type GenericRecord } from "@dataseed/core";
import { openRegistry, type Dataset } from "@dataseed/registry";
import type { Op } from "./types.js";
import { latestDatasetFor, saveFilled } from "../store/bundle-store.js";
import { profilePath } from "./profile-org.js";
import { buildProviders, fillCopy, applyCopy, lintCopy, judgeCopy, makeJudgeRunner, attachSpineContext, groundingGuard, type JudgeThread } from "../copy/index.js";
import type { DealDossier } from "@dataseed/core";
import { authorDossiers, buildSpineProviders, fileDossierCache } from "../spine/index.js";

/** Reconstruct each deal's email THREAD from the filled bundle (the unit the judge reads). */
function threadsFromBundle(bundle: NarrativeBundle): JudgeThread[] {
  const opps = new Map((bundle.records.Opportunity ?? []).map((o) => [o._ref as string, o]));
  const accts = new Map((bundle.records.Account ?? []).map((a) => [a._ref as string, a]));
  const byOpp = new Map<string, GenericRecord[]>();
  for (const e of bundle.records.EmailMessage ?? []) {
    const opp = (e._refs as Record<string, string> | undefined)?.RelatedToId;
    if (opp) (byOpp.get(opp) ?? byOpp.set(opp, []).get(opp)!).push(e);
  }
  const threads: JudgeThread[] = [];
  for (const [oppRef, emails] of byOpp) {
    const opp = opps.get(oppRef);
    const acctRef = (opp?._refs as Record<string, string> | undefined)?.AccountId;
    const account = (accts.get(acctRef ?? "")?.Name as string) ?? (opp?.Name as string) ?? oppRef;
    const sorted = [...emails].sort((a, b) => new Date(a.MessageDate as string).getTime() - new Date(b.MessageDate as string).getTime());
    const subject = (sorted.find((e) => (e.Subject as string)?.trim())?.Subject as string) ?? "";
    const body = sorted
      .filter((e) => (e.TextBody as string)?.trim())
      .map((e) => ({ from: (e.FromName as string) ?? "", direction: (e.Incoming ? "inbound" : "outbound") as "inbound" | "outbound", body: e.TextBody as string }));
    // Phase 4D — give the judge the intended dossier arc so it scores whether the thread DELIVERS the story.
    const intendedArc = (opp?._meta as { dossier?: DealDossier } | undefined)?.dossier?.arc;
    if (body.length) threads.push({ threadId: oppRef, account, subject, emails: body, ...(intendedArc ? { intendedArc } : {}) });
  }
  return threads;
}

interface FillCopyArgs extends Record<string, unknown> {
  org: string;
  pack: string;
  provider: string;
  budgetUsd?: number;
  limit?: number;
  gate?: boolean;
  gateIters?: number;
  judge?: boolean;
  spine?: string;
}

/** Count records of `object` whose `field` is non-empty (the post-fill success measure). */
function bodyStats(bundle: NarrativeBundle, object: string, field: string): { total: number; withBody: number } {
  const recs = bundle.records[object] ?? [];
  const withBody = recs.filter((r) => typeof r[field] === "string" && (r[field] as string).trim().length > 0).length;
  return { total: recs.length, withBody };
}

export const fillCopyOp: Op<FillCopyArgs> = {
  id: "fill-copy",
  name: "Fill a bundle's deferred copy (email bodies) with generated prose",
  description:
    "Generate the email bodies plan-demo deferred (the CopyRequest manifest) and write them back into the bundle. Provider: anthropic (ANTHROPIC_API_KEY) → claude-code (local Claude Code CLI, runs on your subscription) → static (always-on fallback). Budgeted; the static tier fills anything the model leaves, so no email ships blank. Local file only — run load-demo to push.",
  idempotent: true,
  prerequisites: ["a bundle from plan-demo (.dataseed/bundles/<org>-<pack>.json)", "for --provider anthropic: ANTHROPIC_API_KEY in the environment", "for --provider claude-code: the `claude` CLI on PATH (no API key needed — uses your Claude subscription)"],
  affects: [".dataseed/bundles/<org>-<pack>.json (rewrites EmailMessage Subject/TextBody in place)"],
  args: {
    org: { type: "string", required: true, description: "Target org alias (the bundle to fill)." },
    pack: { type: "string", default: "salescloud", description: "Target pack id (bundle source)." },
    provider: { type: "string", default: "auto", enum: ["auto", "anthropic", "claude-code", "static"], description: "Copy provider; auto = profile preference, then availability. claude-code = local Claude Code CLI (runs on your subscription, no API credits)." },
    budgetUsd: { type: "number", description: "Hard cap on LLM spend (USD). Remaining emails fall back to static." },
    limit: { type: "number", description: "Cap how many emails the model writes (rest go to static) — a cheap smoke test." },
    gate: { type: "boolean", default: true, description: "Realism gate: lint LLM-authored copy and regenerate the emails that trip a tell. Pass --gate false to disable." },
    gateIters: { type: "number", description: "Max gate regeneration passes (default 2, max 4)." },
    judge: { type: "boolean", default: false, description: "LLM-as-VP realism check: score each deal thread for believability (advisory; needs an LLM provider). Extra model calls — opt in with --judge." },
    spine: { type: "string", default: "static", enum: ["static", "auto", "claude-code", "anthropic"], description: "Phase 4B — author each deal's narrative DOSSIER (the spine all its copy is generated from) before filling copy. static = keep the deterministic skeleton (default, no LLM). claude-code/auto = Claude authors the arc/stances/sentiment trajectory, cached by (seed, account) in .dataseed/dossiers so re-runs are free + byte-stable." },
  },

  check(args) {
    const store = openRegistry();
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      if (!ds) return { alreadyDone: false, datasetFound: false };
      const { total, withBody } = bodyStats(ds.bundle, "EmailMessage", "TextBody");
      return { alreadyDone: false, datasetFound: true, emails: total, alreadyFilled: withBody };
    } finally {
      store.close();
    }
  },

  async run(args, ctx) {
    const store = openRegistry();
    let ds: Dataset | null = null;
    try {
      ds = latestDatasetFor(store, args.org, args.pack);
    } finally {
      store.close();
    }
    if (!ds) {
      throw new Error(`no dataset for ${args.org}/${args.pack}. Run: dataseed run plan-demo --org ${args.org} --pack ${args.pack}`);
    }
    const bundle = ds.bundle;
    if (bundle.copyRequests.length === 0) {
      ctx.log("no copy requests in this dataset — nothing to fill.");
      return;
    }

    // The org's probed copy preference (if a profile exists) seeds the "auto" choice.
    let profilePreferred: CopyProviderId | undefined;
    const pp = profilePath(args.org);
    if (existsSync(pp)) {
      try {
        profilePreferred = JSON.parse(readFileSync(pp, "utf8")).copyProvider;
      } catch {
        /* profile unreadable — fall through to availability order */
      }
    }

    // Phase 4B — author the narrative DOSSIER first (the spine every artifact derives from), so the
    // copy fill below realizes one coherent story per deal. Default "static" keeps the deterministic
    // skeleton (no LLM); claude-code/auto authors it, cached by (seed, account) for free re-runs.
    const spine = args.spine ?? "static";
    if (spine !== "static") {
      const sr = await authorDossiers(bundle, buildSpineProviders(), {
        requestedProvider: spine as "auto" | "claude-code" | "anthropic" | "static",
        cache: fileDossierCache(".dataseed/dossiers"),
        asOf: bundle.plan.asOf,
        log: (m) => ctx.log(m),
      });
      ctx.log(`spine: authored ${sr.authored} deal(s) via ${sr.provider}${sr.cached ? `, ${sr.cached} cached` : ""}${sr.staticKept ? `, ${sr.staticKept} static` : ""}`);
    }

    // Phase 4C — stamp each copy request with its deal's arc + compact story-so-far, so every artifact
    // is authored thread-aware (email N answers N-1). Runs for the static dossier too (no LLM needed).
    const enriched = attachSpineContext(bundle);
    if (enriched) ctx.log(`thread context: ${enriched} artifact(s) carry the deal arc + story-so-far`);

    const report = await fillCopy(bundle.copyRequests, buildProviders(), {
      requestedProvider: args.provider as "auto" | CopyProviderId,
      profilePreferred,
      budgetUsd: args.budgetUsd,
      limit: args.limit,
      gate: args.gate,
      gateIters: args.gateIters,
      asOf: bundle.plan.asOf,
      log: (m) => ctx.log(m),
    });

    const { applied, unmatched } = applyCopy(bundle, report.results);
    const store2 = openRegistry();
    try {
      saveFilled(store2, ds, { bundle, now: new Date().toISOString(), provider: report.provider, costUsd: report.estCostUsd });
    } finally {
      store2.close();
    }

    if (report.provider === "static") {
      ctx.log(`filled ${report.results.length} copy request(s) via static`);
    } else {
      ctx.log(`filled ${report.results.length} copy request(s): ${report.filledByPrimary} via ${report.provider}${report.fallbacks ? `, ${report.fallbacks} via static fallback` : ""}`);
    }
    if (report.estCostUsd > 0) ctx.log(`estimated LLM cost: $${report.estCostUsd.toFixed(4)}${report.budgetExhausted ? " (budget reached)" : ""}`);
    ctx.log(`applied to ${applied} record(s)${unmatched.length ? `, ${unmatched.length} unmatched` : ""}`);

    // Realism gate (report-only here; the LLM tier adds the regenerate loop). Lint the filled
    // copy against the rubric so every run measures how real it reads — the static tier is
    // expected to flag CROSS_INSTANCE_SIMILARITY (it's a template), the marquee tier should not.
    const byId = new Map(report.results.map((r) => [r.id, r]));
    const targets = bundle.copyRequests.filter((c) => c.kind === "email" && byId.has(c.id)).map((c) => ({ request: c, result: byId.get(c.id)! }));
    if (targets.length) {
      const lint = lintCopy(targets);
      ctx.log(`realism: ${lint.cleanEmails}/${lint.emailsLinted} emails clean (${Math.round(lint.passRate * 100)}%)${lint.bySeverity.fatal ? `, ${lint.bySeverity.fatal} fatal` : ""}`);
      const top = Object.entries(lint.byRule).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (top.length) ctx.log(`  top realism violations: ${top.map(([r, n]) => `${r}×${n}`).join(", ")}`);
      // When the gate ran, show what it bought (before→after, passes, any honest residual).
      const g = report.gate;
      if (g?.ran) {
        ctx.log(`  gate: ${g.before.clean}/${g.before.total} → ${g.after.clean}/${g.after.total} clean over ${g.passes} regen pass(es)${g.converged ? " (converged)" : g.unresolved.length ? `; ${g.unresolved.length} unresolved: ${g.unresolved.map((u) => u.id).join(", ")}` : ""}`);
      }
    }

    // Grounding guard (Phase 4D) — deterministic, zero-LLM: catch copy that contradicts the deal's
    // facts (a figure that isn't the loaded Amount) or sells the prospect its own product (frames the
    // prospect's company as a competitor). Reported every run; it never spends a token.
    const guard = groundingGuard(bundle);
    if (guard.checked) {
      ctx.log(`grounding: ${guard.clean}/${guard.checked} artifact(s) grounded${guard.violations.length ? `, ${guard.violations.length} issue(s): ${Object.entries(guard.byRule).map(([r, n]) => `${r}×${n}`).join(", ")}` : ""}`);
      for (const v of guard.violations.slice(0, 3)) ctx.log(`  ⚠ ${v.id} [${v.rule}]: ${v.detail}`);
    }

    // Tier-3 realism check (opt-in): an LLM reads each thread as a skeptical VP and scores
    // believability — the semantic miss the mechanical lint can't see. Advisory: it reports, it
    // doesn't rewrite (feeding the critique back into regeneration is the next increment).
    if (args.judge) {
      const runner = makeJudgeRunner(report.provider);
      if (!runner) {
        ctx.log(`judge: ${report.provider} has no LLM to judge with — skipping (use --provider claude-code or anthropic)`);
      } else {
        const threads = threadsFromBundle(bundle);
        ctx.log(`judging ${threads.length} thread(s) as a skeptical VP…`);
        const jr = await judgeCopy(threads, runner, { log: (m) => ctx.log(m) });
        if (jr.total) {
          ctx.log(`believability: ${jr.believable}/${jr.total} threads read real (avg ${jr.avgScore.toFixed(1)}/5)`);
          for (const v of jr.flagged) {
            const acct = threads.find((t) => t.threadId === v.threadId)?.account ?? v.threadId;
            ctx.log(`  ⚠ ${acct} (${v.score}/5): ${v.critique}${v.issues.length ? ` — ${v.issues.slice(0, 2).join("; ")}` : ""}`);
          }
        }
      }
    }

    const sample = bundle.records.EmailMessage?.find((e) => typeof e.TextBody === "string" && (e.TextBody as string).trim());
    if (sample) ctx.log(`sample email — "${sample.Subject}": ${(sample.TextBody as string).split("\n")[0]}`);
  },

  verify(args) {
    const store = openRegistry();
    try {
      const ds = latestDatasetFor(store, args.org, args.pack);
      if (!ds) return { success: false, reason: "no dataset to verify" };
      const bundle = ds.bundle;
      if (bundle.copyRequests.length === 0) return { success: true, note: "no copy requests" };
      const email = bodyStats(bundle, "EmailMessage", "TextBody");
      const task = bodyStats(bundle, "Task", "Description"); // logged-activity notes (the 2nd copy-bearing artifact)
      const transcript = bodyStats(bundle, "ContentVersion", "VersionData"); // call-recording transcripts (the 3rd)
      const ok = email.total > 0 && email.withBody === email.total && task.withBody === task.total && transcript.withBody === transcript.total;
      return {
        success: ok,
        emails: email.total,
        emailsWithBody: email.withBody,
        tasks: task.total,
        tasksWithBody: task.withBody,
        transcripts: transcript.total,
        transcriptsWithBody: transcript.withBody,
        ...(ok ? {} : { reason: "some EmailMessage TextBody / Task Description / ContentVersion VersionData still empty" }),
      };
    } finally {
      store.close();
    }
  },
};

export default fillCopyOp;
