import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, makeRng, DealDossier, type GenericRecord } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { buildDealDossier, deriveStage } from "../src/dossier.js";
import { SCENARIO_PROFILES } from "../src/variability.js";
import { salescloudPack } from "../src/index.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const cast = [
  { ref: "contact-0-0", name: "Dana Cole", persona: "Champion" },
  { ref: "contact-0-1", name: "Reza Patel", persona: "Economic Buyer" },
  { ref: "contact-0-2", name: "Mia Lund", persona: "Skeptic" },
];
const args = (scenario: string, seed = 1) => ({
  scenario,
  prof: SCENARIO_PROFILES[scenario]!,
  accountName: "Acme",
  sector: "Data & Analytics",
  amount: 1_200_000,
  closeDate: "2026-08-01",
  asOf: ASOF,
  unitIndex: 0,
  aeName: "Alex",
  stageName: "Proposal/Price Quote",
  cast,
  grounding: { painPhrase: "compute-cost sprawl", competitors: ["Databricks", "BigQuery"] },
  rng: makeRng(seed),
});

describe("buildDealDossier — the authored spine", () => {
  it("returns a schema-valid dossier (arc, cast, beats, numbers)", () => {
    const d = DealDossier.parse(buildDealDossier(args("at-risk-budget")));
    expect(d.provenance).toBe("static");
    expect(d.arc).toContain("Acme");
    expect(d.numbers.amountUsd).toBe(1_200_000);
    expect(d.beats.length).toBeGreaterThan(0);
  });

  it("is deterministic — same seed → byte-identical dossier", () => {
    expect(JSON.stringify(buildDealDossier(args("at-risk-budget", 7)))).toBe(JSON.stringify(buildDealDossier(args("at-risk-budget", 7))));
  });

  it("pins the Opportunity StageName onto the dossier (so copy can hold the prose to that maturity)", () => {
    const d = buildDealDossier(args("healthy-tech"));
    expect(d.stageName).toBe("Proposal/Price Quote");
  });

  it("deriveStage maps deal MATURITY to a stage that can't lag the prose", () => {
    const rng = makeRng(1);
    // no Economic Buyer engaged → pre-proposal, never a late stage
    expect(["Qualification", "Needs Analysis", "Value Proposition"]).toContain(deriveStage("steady", false, rng));
    // EB present + budget contested (stalling) → mature but stuck
    expect(["Proposal/Price Quote", "Negotiation/Review"]).toContain(deriveStage("stalling", true, rng));
    // EB present + approving (accelerating) → papering a verbally-won deal, never back at Proposal/discovery
    expect(deriveStage("accelerating", true, rng)).toBe("Negotiation/Review");
  });

  it("varies the acute TRIGGER per deal — same scenario, different seeds yield different why-now arcs (no template mold)", () => {
    const triggerClause = (seed: number) => buildDealDossier(args("healthy-tech", seed)).arc.split("The trigger to act now:")[1] ?? "";
    const clauses = new Set([3, 7, 11, 19, 23, 31].map(triggerClause));
    expect(clauses.size).toBeGreaterThan(1); // not one mold across deals
    // the systems-count framing only appears on a consolidation-trigger deal, never universally
    const all = [3, 7, 11, 19, 23].map((s) => buildDealDossier(args("healthy-tech", s)).beats[0]?.conveys ?? "");
    expect(all.some((c) => !/disconnected systems/.test(c))).toBe(true); // at least one non-consolidation deal omits "N systems"
  });

  it("varies the primary OBJECTION axis per deal — same-scenario deals don't share the same friction (template-mold swing)", () => {
    const objection = (seed: number) => buildDealDossier(args("at-risk-budget", seed)).arc.split("primary point of friction is")[1]?.split(".")[0]?.trim() ?? "";
    const foci = new Set([3, 7, 11, 19, 23, 31].map(objection));
    expect(foci.size).toBeGreaterThan(1); // pricing-gated vs security-gated vs integration-gated, not all alike
    expect([...foci].every((f) => f.length > 0)).toBe(true);
  });

  it("a compliance-deadline deal pins ONE board-deadline date whose quarter is internally consistent", () => {
    // sweep seeds to find a deal whose trigger is the compliance-deadline (board/audit date) one
    const withDeadline = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41]
      .map((s) => buildDealDossier(args("at-risk-budget", s)))
      .find((d) => /board\/audit reporting deadline \(/.test(d.arc));
    expect(withDeadline).toBeTruthy();
    const m = withDeadline!.arc.match(/deadline \((\d{4}-\d{2}-\d{2}), (Q[1-4])\)/);
    expect(m).toBeTruthy();
    const [, date, q] = m!;
    const derivedQ = `Q${Math.floor(new Date(date!).getUTCMonth() / 3) + 1}`;
    expect(q).toBe(derivedQ); // the stated quarter matches the date's real quarter (no Q2/Q3 mismatch)
  });

  it("emits email + task + transcript beats within the scenario's ranges", () => {
    const prof = SCENARIO_PROFILES["at-risk-budget"]!;
    const d = buildDealDossier(args("at-risk-budget"));
    const emails = d.beats.filter((b) => b.kind === "email");
    const tasks = d.beats.filter((b) => b.kind === "task");
    const trans = d.beats.filter((b) => b.kind === "transcript");
    expect(emails.length).toBeGreaterThanOrEqual(prof.emailRange[0]);
    expect(emails.length).toBeLessThanOrEqual(prof.emailRange[1]);
    expect(tasks.length).toBeGreaterThanOrEqual(prof.taskRange[0]);
    expect(tasks.length).toBeLessThanOrEqual(prof.taskRange[1]);
    expect(trans.length).toBeGreaterThanOrEqual(1);
    expect(trans.length).toBeLessThanOrEqual(2);
  });

  it("authors a SENTIMENT TRAJECTORY — at-risk decays to Risk, healthy ends Positive, rfp stays Neutral", () => {
    const lastEmail = (s: string) => {
      const es = buildDealDossier(args(s)).beats.filter((b) => b.kind === "email");
      return es[es.length - 1]!.sentiment;
    };
    expect(lastEmail("at-risk-budget")).toBe("Risk"); // champion-silence decay
    expect(lastEmail("healthy-tech")).toBe("Positive"); // accelerating
    const rfp = buildDealDossier(args("rfp-gated")).beats.filter((b) => b.kind === "email");
    expect(rfp.every((b) => b.sentiment === "Neutral")).toBe(true); // steady, honest-quiet
  });

  it("the cast is the SEEDED committee, never invented — every beat author/participant resolves to a cast ref", () => {
    const d = buildDealDossier(args("healthy-tech"));
    const refs = new Set(cast.map((c) => c.ref));
    expect(d.cast.map((c) => c.ref).sort()).toEqual([...refs].sort());
    for (const b of d.beats) {
      if (b.authorRef) expect(refs.has(b.authorRef)).toBe(true);
      if (b.participantRef) expect(refs.has(b.participantRef)).toBe(true);
    }
  });

  it("grounds the arc in the prospect's real world (competitor + pain), never sells its own product", () => {
    const d = buildDealDossier(args("at-risk-budget"));
    const pool = ["Databricks", "BigQuery"]; // the seller's rival pool passed in args
    expect(pool).toContain(d.competitor); // picked from the pool (per-deal), not necessarily index 0
    expect(d.arc).toContain(d.competitor!);
    expect(d.arc.toLowerCase()).toContain("compute-cost sprawl");
  });
});

describe("generate — the deal is generated FROM its dossier", () => {
  const profile = CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF });
  const scope = ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 6, scenarioMix: { "at-risk-budget": 50, "healthy-tech": 50 } });
  const bundle = buildBundle(scope, profile, salescloudPack, ASOF);

  it("rides a schema-valid dossier on every foreground Opportunity's _meta", () => {
    const liveOpps = bundle.records.Opportunity!.filter((o) => !(o._meta as { prior?: boolean })?.prior && (o._meta as { dossier?: unknown }).dossier);
    expect(liveOpps.length).toBe(6); // one per foreground unit
    for (const o of liveOpps) {
      const d = DealDossier.parse((o._meta as { dossier: unknown }).dossier);
      expect(d.beats.length).toBeGreaterThan(0);
    }
  });

  it("realizes every beat as exactly one input record + one copy request (beat.ref ↔ record ↔ request)", () => {
    const beatRefs = bundle.records
      .Opportunity!.map((o) => (o._meta as { dossier?: { beats?: Array<{ ref: string }> } }).dossier?.beats ?? [])
      .flat()
      .map((b) => b.ref);
    const recordRefs = new Set([...bundle.records.EmailMessage!, ...bundle.records.Task!, ...bundle.records.ContentVersion!].map((r) => r._ref as string));
    const requestById = new Map(bundle.copyRequests.map((c) => [c.id, c]));
    expect(beatRefs.length).toBe(recordRefs.size); // 1:1 beats ↔ stream records
    for (const ref of beatRefs) {
      expect(recordRefs.has(ref)).toBe(true);
      expect(requestById.get(ref)?.beat?.ref).toBe(ref); // the copy request carries its beat
    }
  });

  it("stamps the beat's authored sentiment onto each stream record (the trajectory survives to the record)", () => {
    const withSentiment = (rs: GenericRecord[]) => rs.filter((r) => (r._meta as { sentiment?: string }).sentiment);
    expect(withSentiment(bundle.records.EmailMessage!).length).toBe(bundle.records.EmailMessage!.length);
    const sentiments = new Set(bundle.records.EmailMessage!.map((r) => (r._meta as { sentiment: string }).sentiment));
    expect([...sentiments].every((s) => ["Positive", "Neutral", "Negative", "Risk"].includes(s))).toBe(true);
  });

  it("OCR never invents a Decision Maker on an rfp/early cast with no EB or Champion — but always names one primary", () => {
    // rfp-gated personas = Technical Evaluator / Coach / End User → no decision authority on the roster.
    const rfpScope = ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 4, scenarioMix: { "rfp-gated": 100 } });
    const b = buildBundle(rfpScope, profile, salescloudPack, ASOF);
    const ocrs = b.records.OpportunityContactRole!;
    // group by Opportunity and assert: zero "Decision Maker", exactly one IsPrimary each
    const byOpp = new Map<string, GenericRecord[]>();
    for (const o of ocrs) {
      const oppId = (o._refs as Record<string, string>).OpportunityId!;
      (byOpp.get(oppId) ?? byOpp.set(oppId, []).get(oppId)!).push(o);
    }
    expect(byOpp.size).toBeGreaterThan(0);
    for (const rows of byOpp.values()) {
      expect(rows.some((r) => r.Role === "Decision Maker")).toBe(false); // no unnamed authority faked onto a gatekeeper
      expect(rows.filter((r) => r.IsPrimary === true).length).toBe(1); // still exactly one primary
    }
  });
});

// P0 realism: beat timestamps must NOT leak asOf's exact (now()-millisecond) instant, and no two artifacts
// — across streams, across deals — may share an identical timestamp (the audit found every deal's final
// artifact stamped 2026-06-20T12:37:52.759Z, with email+transcript colliding within a deal).
describe("dossier beat timestamps — no asOf leak, no collisions", () => {
  const NOW = "2026-06-20T12:37:52.759Z"; // a now()-style asOf with millisecond precision

  it("no beat lands on asOf's exact instant", () => {
    const d = buildDealDossier({ ...args("at-risk-budget", 3), asOf: NOW });
    expect(d.beats.some((b) => b.day === NOW)).toBe(false);
    expect(d.beats.every((b) => !b.day.endsWith(".759Z"))).toBe(true); // the now() millisecond never appears
  });

  it("no two beats across a deal's streams share an exact timestamp", () => {
    const d = buildDealDossier({ ...args("healthy-tech", 5), asOf: NOW });
    const days = d.beats.map((b) => b.day);
    expect(new Set(days).size).toBe(days.length);
  });

  it("different deals (unitIndex) anchor at different moments — no cross-deal timestamp collision", () => {
    const a = buildDealDossier({ ...args("rfp-gated", 9), asOf: NOW, unitIndex: 0 });
    const b = buildDealDossier({ ...args("rfp-gated", 9), asOf: NOW, unitIndex: 1 });
    const aDays = new Set(a.beats.map((x) => x.day));
    const overlap = b.beats.filter((x) => aDays.has(x.day));
    expect(overlap).toEqual([]);
  });
});
