import { describe, it, expect } from "vitest";
import type { CopyRequest } from "@dataseed/core";
import { lintCopy, type LintTarget } from "../src/copy/voice-lint.js";
import { StaticCopyProvider } from "../src/copy/static-provider.js";

// Build a full static-tier thread for one company and pair each result with its request.
async function staticThread(company: string, scenario: string, n: number, facts: NonNullable<CopyRequest["facts"]> & { counterpart: string }): Promise<LintTarget[]> {
  const reqs: CopyRequest[] = Array.from({ length: n }, (_, k) => {
    const incoming = k % 2 === 1;
    return {
      id: `email-${company}-${k}`,
      kind: "email",
      scenario,
      beatIntent: `Email ${k + 1}/${n} for ${company}, ${incoming ? `inbound from ${facts.counterpart}` : "outbound from the AE"}.`,
      speakers: [incoming ? facts.counterpart : "Account Executive"],
      facts,
      seq: { index: k, total: n },
    } satisfies CopyRequest;
  });
  const { results } = await new StaticCopyProvider().fill(reqs, { asOf: "2026-06-18" });
  return reqs.map((r) => ({ request: r, result: results.find((x) => x.id === r.id)! }));
}

// Build a LintTarget from minimal parts (request needs id/scenario/seq; result needs id/subject/body).
function t(id: string, scenario: string, index: number, total: number, subject: string, body: string): LintTarget {
  return { request: { id, scenario, seq: { index, total } }, result: { id, subject, body } };
}
const rulesOf = (targets: LintTarget[]) => new Set(lintCopy(targets).violations.map((v) => v.rule));

describe("voice-lint — per-email mechanical tells", () => {
  it("flags machine-format money ($1,200,000) as ROUND_NUMBER_FORMAT", () => {
    const e = t("e", "at-risk-budget", 0, 1, "Budget", "Finance capped the $1,200,000 ARR number.\n\n— Alex");
    expect(rulesOf([e])).toContain("ROUND_NUMBER_FORMAT");
  });

  it("flags a sender naming themselves in the third person (SELF_REFERENCE, fatal)", () => {
    const e = t("e", "at-risk-budget", 0, 1, "Pilot", "The pilot looked strong. Diane Okafor is bought in.\n\n— Diane");
    const report = lintCopy([e]);
    const v = report.violations.find((x) => x.rule === "SELF_REFERENCE");
    expect(v?.severity).toBe("fatal");
  });

  it("flags a concatenation seam ('before … before') as DOUBLED_FUNCTION_WORD", () => {
    const e = t("e", "at-risk-budget", 0, 1, "ROI", "Finance wants the ROI before they'll commit before the Aug 15 close.\n\n— Alex");
    expect(rulesOf([e])).toContain("DOUBLED_FUNCTION_WORD");
  });

  it("flags AI-slop phrases and stock confessional openers", () => {
    const slop = t("e1", "healthy-tech", 0, 1, "Hi", "I hope this email finds you well.\n\nLet's circle back.\n\n— Sam");
    expect(rulesOf([slop])).toContain("FORBIDDEN_PHRASE");
    const conf = t("e2", "at-risk-budget", 0, 1, "Budget", "I have to be straight about the budget.\n\nIt's tight.\n\n— Sam");
    expect(rulesOf([conf])).toContain("CONFESSIONAL_OPENER");
  });

  it("accepts every natural sign-off shape — em-dash, bare first name, and 'Thanks,\\nName' (no SIGNOFF_SHAPE)", () => {
    const dash = t("a", "healthy-tech", 0, 1, "rollout", "Wei, the pilot held at 40% under projection. Worth locking the next phase Friday?\n\n— Alex");
    const bare = t("b", "healthy-tech", 0, 1, "rollout", "Wei, the pilot held at 40% under projection. Worth locking the next phase Friday?\n\nTaylor");
    const closing = t("c", "healthy-tech", 0, 1, "rollout", "Wei, the pilot held at 40% under projection. Worth locking the next phase Friday?\n\nThanks,\nTaylor");
    for (const e of [dash, bare, closing]) expect(rulesOf([e])).not.toContain("SIGNOFF_SHAPE");
    // a bare-name sign-off must NOT leak the name into SELF_REFERENCE — the signature is stripped first
    const selfOk = t("d", "healthy-tech", 0, 1, "rollout", "Wei, locking the next phase Friday.\n\nTaylor");
    expect(rulesOf([selfOk])).not.toContain("SELF_REFERENCE");
    // genuinely no sign-off still flags
    const none = t("e", "healthy-tech", 0, 1, "rollout", "Wei, are you free Friday to lock the next phase before the review?");
    expect(rulesOf([none])).toContain("SIGNOFF_SHAPE");
  });

  it("passes a genuinely human-sounding email with zero violations", () => {
    const clean = t(
      "clean", "at-risk-budget", 0, 1, "quick one before Thurs",
      "Hi Diane,\n\nThanks for looping Finance in — that unblocks the $1.2M piece. I'll send the payback model over so procurement has it ahead of Thursday.\n\nWorks for a quick call Wed?\n\n— Alex"
    );
    const report = lintCopy([clean]);
    expect(report.violations).toEqual([]);
    expect(report.passRate).toBe(1);
  });
});

describe("voice-lint — the headline anti-clone check", () => {
  it("flags two same-position deals that are one template with names swapped (CROSS_INSTANCE_SIMILARITY, fatal)", () => {
    const a = t("email-Snowflake-0", "at-risk-budget", 0, 6, "Next step", "Good momentum after the pilot — the numbers held up.\n\nI'd like to keep this moving toward the $1.2M expansion with Diane Okafor.\n\nWhat's the best next step on your side?\n\n— Alex");
    const b = t("email-Stripe-0", "at-risk-budget", 0, 6, "Strong pilot", "Good momentum after the pilot — the numbers held up.\n\nI'd like to keep this moving toward the $1.1M expansion with Marcus Reyes.\n\nWhat's the best next step on your side?\n\n— Riley");
    const report = lintCopy([a, b]);
    const clone = report.violations.find((v) => v.rule === "CROSS_INSTANCE_SIMILARITY");
    expect(clone?.severity).toBe("fatal");
    expect(report.maxCrossInstanceSimilarity).toBeGreaterThanOrEqual(0.45);
  });

  it("does NOT flag two genuinely-different deals at the same position", () => {
    const a = t("email-Snowflake-0", "at-risk-budget", 0, 6, "warehouse spend", "Diane — the warehouse-credit pilot held at 40% under projection. Worth locking the $1.2M expansion before your Q3 planning closes?\n\n— Alex");
    const b = t("email-Stripe-0", "at-risk-budget", 0, 6, "fraud pilot", "Quick one: the fraud-rule pilot cut chargebacks enough that Marcus wants to bring procurement in on the $1.1M. Can you intro?\n\n— Riley");
    expect(lintCopy([a, b]).violations.find((v) => v.rule === "CROSS_INSTANCE_SIMILARITY")).toBeUndefined();
  });
});

describe("voice-lint — the static tier is the canonical NEGATIVE fixture", () => {
  it("after floor fixes: per-email mechanical tells are gone, but the clone is still fatal (only the LLM escapes it)", async () => {
    const snow = await staticThread("Snowflake", "at-risk-budget", 6, { amountUsd: 1_200_000, closeDate: "2026-08-15", primaryContact: "Diane Okafor", counterpart: "Diane Okafor" });
    const stripe = await staticThread("Stripe", "at-risk-budget", 6, { amountUsd: 1_100_000, closeDate: "2026-08-09", primaryContact: "Marcus Reyes", counterpart: "Marcus Reyes" });
    const report = lintCopy([...snow, ...stripe]);
    const rules = new Set(report.violations.map((v) => v.rule));

    // The mechanical per-email tells the floor fixes addressed:
    expect(rules.has("ROUND_NUMBER_FORMAT")).toBe(false); // $1.2M, not $1,200,000
    expect(rules.has("SELF_REFERENCE")).toBe(false); // inbound speaks first person
    expect(rules.has("DOUBLED_FUNCTION_WORD")).toBe(false); // no "before … before"
    expect(rules.has("CONFESSIONAL_OPENER")).toBe(false); // no "I have to be straight…"
    expect(rules.has("CURRENCY_UNIT_REPETITION")).toBe(false); // "ARR" not on every email

    // …but the STRUCTURAL clone survives — this is the proof static is a template:
    expect(report.violations.some((v) => v.rule === "CROSS_INSTANCE_SIMILARITY" && v.severity === "fatal")).toBe(true);
  });
});
