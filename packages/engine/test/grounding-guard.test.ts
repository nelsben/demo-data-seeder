import { describe, it, expect } from "vitest";
import { NarrativeBundle, DealDossier } from "@dataseed/core";
import { groundingGuard, buildJudgePrompt } from "../src/copy/index.js";

const dossier = () =>
  DealDossier.parse({
    scenario: "at-risk-budget",
    arc: "Snowflake's budget got contested; champion going quiet.",
    cast: [],
    beats: [],
    numbers: { amountUsd: 1_200_000, ceilingUsd: 864_000 },
    competitor: "Databricks",
    provenance: "static",
  });

const email = (ref: string, body: string) => ({ _ref: ref, _refs: { RelatedToId: "opp-0" }, TextBody: body });

const bundle = (bodies: string[]): NarrativeBundle =>
  NarrativeBundle.parse({
    records: {
      Account: [{ _ref: "acct-0", Name: "Snowflake" }],
      Opportunity: [{ _ref: "opp-0", _refs: { AccountId: "acct-0" }, Name: "Snowflake — Platform Expansion", _meta: { dossier: dossier() } }],
      EmailMessage: bodies.map((b, i) => email(`email-0-${i}`, b)),
    },
    copyRequests: [],
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
  });

describe("groundingGuard — don't sell a company its own product / don't contradict the record", () => {
  it("flags an artifact that frames the PROSPECT as a competitor", () => {
    const r = groundingGuard(bundle(["Honestly we'd beat Snowflake on cost here."]));
    expect(r.byRule.SELF_AS_COMPETITOR).toBe(1);
    expect(r.violations[0]!.id).toBe("email-0-0");
  });

  it("flags a deal-magnitude figure that contradicts the loaded Amount", () => {
    const r = groundingGuard(bundle(["Excited to get this $5M deal across the line in Q3."]));
    expect(r.byRule.FOREIGN_DEAL_FIGURE).toBe(1);
    expect(r.violations[0]!.detail).toContain("$1,200,000");
  });

  it("passes copy grounded in the real facts (right figure, the REAL competitor, sub-$100K detail)", () => {
    const r = groundingGuard(bundle(["The $1.2M investment beats Databricks on TCO. We modeled $50K in quarterly savings."]));
    expect(r.violations).toHaveLength(0);
    expect(r.clean).toBe(1);
  });

  it("accepts a figure that matches the contested ceiling", () => {
    const r = groundingGuard(bundle(["Diane confirmed the $864K ceiling holds through Q3."]));
    expect(r.violations).toHaveLength(0);
  });

  it("checks every grounded artifact and counts cleanly", () => {
    const r = groundingGuard(bundle(["we'd beat Snowflake", "a clean $1.2M note", "a $9M fantasy"]));
    expect(r.checked).toBe(3);
    expect(r.clean).toBe(1); // only the middle one is grounded
    expect(r.byRule.SELF_AS_COMPETITOR).toBe(1);
    expect(r.byRule.FOREIGN_DEAL_FIGURE).toBe(1);
  });
});

describe("the judge is spine-aware when given the intended arc (Phase 4D)", () => {
  it("includes the intended story in the prompt when present", () => {
    const p = buildJudgePrompt({ threadId: "t", account: "Snowflake", subject: "s", emails: [{ from: "Alex", direction: "outbound", body: "hi" }], intendedArc: "champion goes silent after the CFO joins" });
    expect(p).toContain("INTENDED STORY");
    expect(p).toContain("champion goes silent");
  });
  it("omits the intended-story block when no arc is given (judges cold)", () => {
    const p = buildJudgePrompt({ threadId: "t", account: "Acme", subject: "s", emails: [{ from: "Alex", direction: "outbound", body: "hi" }] });
    expect(p).not.toContain("INTENDED STORY");
  });
});
