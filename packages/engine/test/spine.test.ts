import { describe, it, expect } from "vitest";
import { NarrativeBundle, DealDossier, mergeDossier, type DossierDraft, type SpineProvider, type SpineRequest, type GenericRecord } from "@dataseed/core";
import { authorDossiers, StaticSpineProvider, parseDraft, memoryDossierCache } from "../src/spine/index.js";

// A minimal skeleton dossier with one email beat.
const skeleton = () =>
  DealDossier.parse({
    scenario: "at-risk-budget",
    arc: "STATIC ARC",
    cast: [{ ref: "contact-0-0", name: "Dana Cole", persona: "Champion", stance: "championing" }],
    beats: [{ ref: "email-0-0", kind: "email", day: "2026-05-01T00:00:00.000Z", author: "Dana Cole", authorRef: "contact-0-0", participantRef: "contact-0-0", direction: "inbound", sentiment: "Positive", summary: "STATIC SUMMARY", conveys: "static facts" }],
    numbers: { amountUsd: 1_200_000 },
    signalAims: [{ rule: "Champion", sentiment: "Positive" }],
    provenance: "static",
  });

const bundle = (): NarrativeBundle =>
  NarrativeBundle.parse({
    records: {
      Opportunity: [{ _ref: "opp-0", Name: "Acme — Platform Expansion", _meta: { dossier: skeleton() } }],
      EmailMessage: [{ _ref: "email-0-0", Subject: "", TextBody: "", _meta: { sentiment: "Positive" } }],
    },
    copyRequests: [{ id: "email-0-0", kind: "email", scenario: "at-risk-budget", beatIntent: "STATIC SUMMARY static facts", beat: skeleton().beats[0]! }],
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 42, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
  });

const draft: DossierDraft = {
  arc: "AUTHORED ARC — champion went quiet after the CFO got involved",
  castStances: { "contact-0-0": "championing, but silent since the CFO joined" },
  beats: { "email-0-0": { summary: "AUTHORED SUMMARY", conveys: "the $1.2M figure", sentiment: "Risk" } },
  signalAims: [{ rule: "Champion", sentiment: "Risk" }],
};

class MockSpine implements SpineProvider {
  id = "claude-code";
  calls = 0;
  constructor(private draftFor: (r: SpineRequest) => DossierDraft | null) {}
  available() {
    return true;
  }
  async author(reqs: SpineRequest[]) {
    this.calls++;
    const drafts = reqs.map((r) => ({ dealKey: r.dealKey, draft: this.draftFor(r) })).filter((d): d is { dealKey: string; draft: DossierDraft } => !!d.draft);
    return { drafts, estCostUsd: 0.01 * reqs.length, budgetExhausted: false };
  }
}

describe("mergeDossier — pin structure, take narrative", () => {
  it("keeps the skeleton's beat scaffold but takes arc / stance / summary / sentiment from the draft", () => {
    const merged = mergeDossier(skeleton(), draft, "llm");
    expect(merged.provenance).toBe("llm");
    expect(merged.arc).toBe(draft.arc);
    expect(merged.cast[0]!.stance).toBe("championing, but silent since the CFO joined");
    const b = merged.beats[0]!;
    expect(b.day).toBe("2026-05-01T00:00:00.000Z"); // structure pinned
    expect(b.direction).toBe("inbound"); // structure pinned
    expect(b.summary).toBe("AUTHORED SUMMARY"); // narrative taken
    expect(b.sentiment).toBe("Risk"); // trajectory re-authored
    expect(merged.signalAims[0]!.sentiment).toBe("Risk");
  });

  it("a beat the draft omits keeps its skeleton narrative (partial drafts are safe)", () => {
    const merged = mergeDossier(skeleton(), { arc: "x", castStances: {}, beats: {} }, "llm");
    expect(merged.beats[0]!.summary).toBe("STATIC SUMMARY"); // untouched
  });
});

describe("authorDossiers — patches the bundle from the authored draft", () => {
  it("rewrites the Opp dossier, the copy request's beat/beatIntent, and the record sentiment", async () => {
    const b = bundle();
    const mock = new MockSpine(() => draft);
    const rep = await authorDossiers(b, [mock, new StaticSpineProvider()], { requestedProvider: "claude-code", asOf: b.plan.asOf });

    expect(rep.authored).toBe(1);
    const merged = (b.records.Opportunity![0]!._meta as { dossier: DealDossier }).dossier;
    expect(merged.provenance).toBe("llm");
    expect(merged.arc).toBe(draft.arc);
    const req = b.copyRequests[0]!;
    expect(req.beat!.summary).toBe("AUTHORED SUMMARY");
    expect(req.beatIntent).toContain("AUTHORED SUMMARY");
    expect((b.records.EmailMessage![0]!._meta as { sentiment: string }).sentiment).toBe("Risk");
  });

  it("caches by (seed, account): a second run with the same cache reuses the draft, no re-author", async () => {
    const cache = memoryDossierCache();
    const mock = new MockSpine(() => draft);
    const run1 = await authorDossiers(bundle(), [mock], { requestedProvider: "claude-code", asOf: "2026-06-17T00:00:00.000Z", cache });
    expect(run1.authored).toBe(1);
    expect(mock.calls).toBe(1);
    const run2 = await authorDossiers(bundle(), [mock], { requestedProvider: "claude-code", asOf: "2026-06-17T00:00:00.000Z", cache });
    expect(run2.cached).toBe(1);
    expect(run2.authored).toBe(0);
    expect(mock.calls).toBe(1); // provider NOT called again — the cache served it
  });

  it("a deterministic (static) provider short-circuits — dossiers stay static, untouched", async () => {
    const b = bundle();
    const rep = await authorDossiers(b, [new StaticSpineProvider()], { requestedProvider: "static", asOf: b.plan.asOf });
    expect(rep.authored).toBe(0);
    expect(rep.staticKept).toBe(1);
    expect((b.records.Opportunity![0]!._meta as { dossier: DealDossier }).dossier.provenance).toBe("static");
    expect((b.records.Opportunity![0]!._meta as { dossier: DealDossier }).dossier.arc).toBe("STATIC ARC");
  });

  it("a deal the provider declines to author keeps its static skeleton (never made worse)", async () => {
    const b = bundle();
    const mock = new MockSpine(() => null); // authors nothing
    const rep = await authorDossiers(b, [mock], { requestedProvider: "claude-code", asOf: b.plan.asOf });
    expect(rep.authored).toBe(0);
    expect(rep.staticKept).toBe(1);
    expect((b.records.Opportunity![0]!._meta as { dossier: DealDossier }).dossier.arc).toBe("STATIC ARC");
  });
});

describe("parseDraft — tolerant JSON extraction from CLI output", () => {
  it("parses a fenced/prefixed JSON draft", () => {
    const out = "Here you go:\n```json\n" + JSON.stringify(draft) + "\n```\n";
    const parsed = parseDraft(out);
    expect(parsed?.arc).toBe(draft.arc);
  });
  it("returns null for unparseable output", () => {
    expect(parseDraft("sorry, I can't do that")).toBeNull();
  });
});
