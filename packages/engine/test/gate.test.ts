import { describe, it, expect } from "vitest";
import type { CopyProvider, CopyRequest, CopyFillContext, CopyFillOutput } from "@dataseed/core";
import { gateCopy } from "../src/copy/gate.js";
import { buildRegenPrompt, buildEmailPrompt, EMAIL_SYSTEM_PROMPT } from "../src/copy/prompt.js";
import { lintCopy, HUMAN_FIX, type LintTarget } from "../src/copy/voice-lint.js";

// ── fixtures ─────────────────────────────────────────────────────────────────
const CLEAN = "Hi Diane,\n\nThe numbers held up well after the pilot last week, so the $1.2M piece is unblocked.\n\nWorks for a quick call Wed?\n\n— Alex";
const DOUBLED = "Hi Diane,\n\nThe the numbers held up well after the pilot last week.\n\nWorks for a quick call Wed?\n\n— Alex"; // "the the" → DOUBLED_FUNCTION_WORD
const WORSE = "Hi Diane,\n\nThe the numbers — held — up — well — after the pilot.\n\nWorks for a quick call Wed?\n\n— Alex"; // doubled + em-dash density

const target = (id: string, body: string, scenario = "healthy-tech", index = 0, total = 1): LintTarget => ({ request: { id, scenario, seq: { index, total } }, result: { id, subject: "S", body } });
const reqFor = (id: string, scenario = "healthy-tech", index = 0, total = 1): CopyRequest =>
  ({ id, kind: "email", scenario, beatIntent: "beat", speakers: ["Alex"], seq: { index, total } });
const reqMap = (targets: LintTarget[]): Map<string, CopyRequest> =>
  new Map(targets.map((t) => [t.result.id, reqFor(t.result.id, t.request.scenario!, t.request.seq?.index, t.request.seq?.total)]));
const OPTS = { asOf: "2026-06-18", spentSoFar: 0, log: () => {} };

/** A provider whose regenerated body is decided by a render fn; records the ids it was asked to fill. */
class Scripted implements CopyProvider {
  id = "anthropic";
  calls: string[][] = [];
  constructor(private render: (req: CopyRequest, hints?: ReadonlyArray<{ rule: string }>) => string | null, public deterministic = false, id = "anthropic") {
    this.id = id;
  }
  available() { return true; }
  async fill(reqs: CopyRequest[], ctx: CopyFillContext): Promise<CopyFillOutput> {
    this.calls.push(reqs.map((r) => r.id));
    const results = reqs.flatMap((r) => {
      const body = this.render(r, ctx.regenHints?.get(r.id));
      return body == null ? [] : [{ id: r.id, subject: "S", body, provider: this.id }];
    });
    return { results, estCostUsd: results.length * 0.01, budgetExhausted: false };
  }
}

describe("gateCopy — the lint→regenerate loop", () => {
  it("regenerates a flagged email and converges to clean (before→after rises)", async () => {
    const t = [target("e-0", DOUBLED)];
    const p = new Scripted((_r, hints) => (hints?.length ? CLEAN : DOUBLED));
    const { results, report } = await gateCopy(t, p, reqMap(t), OPTS);
    expect(report.ran).toBe(true);
    expect(report.before.clean).toBe(0);
    expect(report.after.clean).toBe(1);
    expect(report.converged).toBe(true);
    expect(results[0]!.body).toBe(CLEAN);
    expect(lintCopy([target("e-0", results[0]!.body)]).violations).toEqual([]);
  });

  it("is violation-AWARE: the provider only cleans WITH a hint (proves regenHints reaches it)", async () => {
    const p = new Scripted((_r, hints) => (hints?.length ? CLEAN : DOUBLED));
    // a no-hint call returns the dirty body…
    const noHint = await p.fill([reqFor("e-0")], { asOf: OPTS.asOf });
    expect(noHint.results[0]!.body).toBe(DOUBLED);
    // …but the gate, which passes hints, gets the clean rewrite
    const t = [target("e-0", DOUBLED)];
    const { results } = await gateCopy(t, p, reqMap(t), OPTS);
    expect(results[0]!.body).toBe(CLEAN);
  });

  it("stops at the cap with the best draft + honest unresolved when the model can't fix it", async () => {
    const t = [target("e-0", DOUBLED)];
    const stubborn = new Scripted(() => DOUBLED); // ignores hints, never improves
    const { results, report } = await gateCopy(t, stubborn, reqMap(t), { ...OPTS, maxIters: 4 });
    expect(report.converged).toBe(false);
    expect(report.passes).toBeLessThan(4); // no-progress guard stops early, doesn't burn all iters
    expect(report.unresolved.find((u) => u.id === "e-0")?.rules).toContain("DOUBLED_FUNCTION_WORD");
    expect(results[0]!.body).toBe(DOUBLED); // never blank, never worse
  });

  it("keeps the BEST draft — a regeneration that's worse is discarded", async () => {
    const t = [target("e-0", DOUBLED)]; // 1 violation
    const worse = new Scripted(() => WORSE); // regen adds violations
    const { results } = await gateCopy(t, worse, reqMap(t), OPTS);
    expect(results[0]!.body).toBe(DOUBLED); // retained the original, not the worse regen
  });

  it("SKIPS a deterministic provider (regen would be identical) — ran:false, zero fill calls", async () => {
    const t = [target("e-0", DOUBLED)];
    const stat = new Scripted(() => CLEAN, true, "static-ish"); // deterministic=true
    const { results, report } = await gateCopy(t, stat, reqMap(t), OPTS);
    expect(report.ran).toBe(false);
    expect(stat.calls).toEqual([]);
    expect(results[0]!.body).toBe(DOUBLED); // unchanged
  });

  it("SKIPS by id guard too (a provider literally named 'static')", async () => {
    const t = [target("e-0", DOUBLED)];
    const stat = new Scripted(() => CLEAN, false, "static");
    const { report } = await gateCopy(t, stat, reqMap(t), OPTS);
    expect(report.ran).toBe(false);
  });

  it("clears a CROSS_INSTANCE clone by regenerating ONLY the second instance", async () => {
    const cloneA = "Good momentum after the pilot, the numbers held up. I'd like to keep moving toward the $1.2M expansion with Diane. What is the best next step?\n\n— Alex";
    const cloneB = "Good momentum after the pilot, the numbers held up. I'd like to keep moving toward the $1.1M expansion with Marcus. What is the best next step?\n\n— Riley";
    const diverse = "The fraud-rule pilot cut chargebacks enough that Marcus wants procurement on the $1.1M. Can you intro me?\n\n— Riley";
    const t = [target("d1-0", cloneA, "at-risk-budget", 0, 1), target("d2-0", cloneB, "at-risk-budget", 0, 1)];
    expect(lintCopy(t).violations.some((v) => v.rule === "CROSS_INSTANCE_SIMILARITY")).toBe(true);
    const p = new Scripted((r) => (r.id === "d2-0" ? diverse : cloneA));
    const { report } = await gateCopy(t, p, reqMap(t), OPTS);
    expect(p.calls.flat()).toEqual(["d2-0"]); // only the attributed second instance
    expect(report.after.passRate).toBeGreaterThan(report.before.passRate);
    expect(lintCopy([target("d2-0", diverse, "at-risk-budget", 0, 1)]).violations).toEqual([]);
  });

  it("breaks STRUCTURAL_UNIFORMITY by reshaping a minimal subset", async () => {
    const one = (n: number) => target(`s-${n}`, `Pilot point ${n} landed ${10 + n}% under projection, worth locking phase two.\n\n— Alex`, "healthy-tech", n, 6);
    const t = [0, 1, 2, 3, 4, 5].map(one); // all single-paragraph → uniform
    expect(lintCopy(t).violations.some((v) => v.rule === "STRUCTURAL_UNIFORMITY")).toBe(true);
    const twoPara = (id: string) => `First, the pilot held.\n\nSecond, ${id} is ready for phase two.\n\n— Alex`;
    const p = new Scripted((r, hints) => (hints?.some((h) => h.rule === "STRUCTURAL_UNIFORMITY") ? twoPara(r.id) : null));
    const { report } = await gateCopy(t, p, reqMap(t), OPTS);
    expect(report.regenerated).toBeGreaterThan(0);
    expect(report.regenerated).toBeLessThan(6); // a SUBSET, not the whole corpus
    expect(report.converged).toBe(true); // the rule actually cleared
    expect(report.unresolved).toEqual([]);
  });

  it("ACCEPTS a de-cloning regen even when it adds a minor per-email tell (corpus fatal→high is a win)", async () => {
    // Two same-position clones; CROSS_INSTANCE (fatal) attaches to the second (d2-0).
    const cloneA = "Good momentum after the pilot, the numbers held up. I'd like to keep moving toward the $1.2M with Diane. What is the next step?\n\n— Alex";
    const cloneB = "Good momentum after the pilot, the numbers held up. I'd like to keep moving toward the $1.1M with Marcus. What is the next step?\n\n— Riley";
    // The regen de-clones (totally different prose) but carries a doubled word ("the the").
    const declonedDoubled = "The the fraud-rule pilot cut chargebacks enough that Marcus wants procurement on the $1.1M.\n\n— Riley";
    const t = [target("d1-0", cloneA, "at-risk-budget", 0, 1), target("d2-0", cloneB, "at-risk-budget", 0, 1)];
    const p = new Scripted((r) => (r.id === "d2-0" ? declonedDoubled : cloneA));
    const { results, report } = await gateCopy(t, p, reqMap(t), { ...OPTS, maxIters: 1 });
    const d2 = results.find((r) => r.id === "d2-0")!;
    expect(d2.body).toBe(declonedDoubled); // accepted, NOT reverted to the clone (1000 → 100 is better)
    const finalRules = new Set(lintCopy(t.map((x) => x.result.id === "d2-0" ? { ...x, result: { ...x.result, body: d2.body } } : x)).violations.map((v) => v.rule));
    expect(finalRules.has("CROSS_INSTANCE_SIMILARITY")).toBe(false); // the fatal clone is gone
    expect(report.before.passRate).toBeLessThan(1);
  });

  it("REJECTS a per-email-clean regen that newly clones a sibling (never ship a corpus-worse draft)", async () => {
    const aBody = "Hi Sam,\n\nThe rollout held at 30% under projection, so phase two is unblocked.\n\nQuick call Thursday?\n\n— Alex";
    const bEmDash = "Hi Sam,\n\nThe pilot — held — strong — last — week, no surprises.\n\nReady for phase two?\n\n— Riley"; // EM_DASH_DENSITY (low), NOT a clone of A
    const bClonesA = "Hi Sam,\n\nThe rollout held at 30% under projection, so phase two is unblocked.\n\nQuick call Thursday?\n\n— Riley"; // per-email clean but a clone of A
    const t = [target("x1-0", aBody, "healthy-tech", 0, 1), target("x2-0", bEmDash, "healthy-tech", 0, 1)];
    expect(lintCopy(t).violations.some((v) => v.rule === "CROSS_INSTANCE_SIMILARITY")).toBe(false); // not clones to begin with
    const p = new Scripted((r) => (r.id === "x2-0" ? bClonesA : aBody));
    const { results } = await gateCopy(t, p, reqMap(t), { ...OPTS, maxIters: 1 });
    expect(results.find((r) => r.id === "x2-0")!.body).toBe(bEmDash); // reverted: a low em-dash beats a fatal clone
  });

  it("converges a 3-way clone cluster by regenerating at most one per cluster per pass", async () => {
    // Same prose, only the (masked) counterpart name differs → all three mask-identical = clones.
    const clone = (name: string) => `Good momentum after the pilot, the numbers held up nicely. I would like to move the expansion forward with ${name} this quarter.\n\n— Alex`;
    const distinct: Record<string, string> = {
      "c-b-0": "Fraud-rule tuning cut chargebacks sharply once Radar shipped to the cohort.\n\n— Alex",
      "c-c-0": "Warehouse credit burn fell under the new routing logic across three teams.\n\n— Alex",
    };
    const t = ([["c-a-0", "Diane"], ["c-b-0", "Marcus"], ["c-c-0", "Priya"]] as const).map(([id, name]) => target(id, clone(name), "at-risk-budget", 0, 1));
    expect(lintCopy(t).violations.filter((v) => v.rule === "CROSS_INSTANCE_SIMILARITY").length).toBeGreaterThanOrEqual(2);
    const p = new Scripted((r, hints) => (hints?.some((h) => h.rule === "CROSS_INSTANCE_SIMILARITY") ? distinct[r.id] ?? clone("Diane") : null));
    const { report } = await gateCopy(t, p, reqMap(t), { ...OPTS, maxIters: 2 });
    expect(p.calls.every((c) => c.length <= 1)).toBe(true); // never two clones from one cluster in one pass
    expect(report.converged).toBe(true);
  });

  it("honors the budget ceiling — no regeneration once the cap is reached", async () => {
    const t = [target("e-0", DOUBLED)];
    const p = new Scripted(() => CLEAN);
    const { results, report } = await gateCopy(t, p, reqMap(t), { ...OPTS, budgetUsd: 0.5, spentSoFar: 0.5 });
    expect(p.calls).toEqual([]); // budget already spent → never calls the model
    expect(report.passes).toBe(0);
    expect(results[0]!.body).toBe(DOUBLED);
  });
});

describe("buildRegenPrompt", () => {
  it("reuses the cached system prompt + appends a REVISION block naming each tell and its fix", () => {
    const req = reqFor("e-0");
    const { system, user } = buildRegenPrompt(req, [{ rule: "EM_DASH_DENSITY", detail: "4 em-dashes (AI tic; keep ≤2)" }]);
    expect(system).toBe(EMAIL_SYSTEM_PROMPT); // byte-stable → prompt cache still hits
    expect(user).toContain("4 em-dashes"); // the literal offending detail
    expect(user).toContain(HUMAN_FIX.EM_DASH_DENSITY!); // the canonical fix instruction
    expect(user).toMatch(/rewrite it from scratch/i);
    // the no-hint prompt is byte-identical to today's normal generation
    expect(buildEmailPrompt(req).user).not.toContain("REVISION");
    expect(buildEmailPrompt(req).user).not.toContain("rewrite it from scratch");
  });

  it("dedupes repeated rules so the model gets one instruction per tell", () => {
    const { user } = buildRegenPrompt(reqFor("e-0"), [
      { rule: "DOUBLED_FUNCTION_WORD", detail: 'doubled word "the the"' },
      { rule: "DOUBLED_FUNCTION_WORD", detail: '"that" appears 2× in one sentence' },
    ]);
    expect(user.match(/Recast that sentence/g)?.length).toBe(1);
  });
});
