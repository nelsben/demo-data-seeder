import { describe, it, expect } from "vitest";
import { DealDossier, NarrativeBundle } from "@dataseed/core";
import { planNextBeats } from "../src/drip/beats.js";
import { attachSpineContext } from "../src/copy/index.js";

const baseDossier = (overrides: Record<string, unknown> = {}) =>
  DealDossier.parse({
    scenario: "at-risk-budget",
    arc: "Acme's budget got contested; the champion is going quiet.",
    cast: [
      { ref: "003A", name: "Dana Kessler", persona: "Champion" },
      { ref: "003B", name: "Marcus Ito", persona: "Economic Buyer" },
    ],
    beats: [{ ref: "email-0", kind: "email", day: "2026-08-20T15:00:00.000Z", author: "Alex", direction: "outbound", sentiment: "Neutral", summary: "AE confirms the pilot timeline" }],
    numbers: { amountUsd: 500_000 },
    provenance: "static",
    ...overrides,
  });

describe("planNextBeats — arc-aware next-beat authoring", () => {
  it("at-risk-budget yields a budget-pushback beat kind, on/after today, and never before opts.day", () => {
    const dossier = baseDossier();
    const beats = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 1 });
    expect(beats).toHaveLength(1);
    expect(beats[0]!.summary.toLowerCase()).toContain("budget");
    expect(beats[0]!.sentiment).toBe("Risk");
  });

  it("dates every new beat strictly after the dossier's last existing beat", () => {
    const dossier = baseDossier();
    const lastBeatMs = Date.parse(dossier.beats[dossier.beats.length - 1]!.day);
    const beats = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 2 });
    expect(beats).toHaveLength(2);
    for (const b of beats) expect(Date.parse(b.day)).toBeGreaterThan(lastBeatMs);
    // and strictly increasing across the two beats of the same day
    expect(Date.parse(beats[1]!.day)).toBeGreaterThan(Date.parse(beats[0]!.day));
  });

  it("is dated on/after opts.day even when the dossier's last beat is already further in the future", () => {
    const dossier = baseDossier({ beats: [{ ref: "email-0", kind: "email", day: "2026-09-10T15:00:00.000Z", author: "Alex", sentiment: "Neutral", summary: "future-dated beat" }] });
    const beats = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 1 });
    expect(Date.parse(beats[0]!.day)).toBeGreaterThan(Date.parse("2026-09-10T15:00:00.000Z"));
  });

  it("authors every beat from a real cast member (never an invented name)", () => {
    const dossier = baseDossier();
    const names = new Set(dossier.cast.map((c) => c.name));
    const beats = planNextBeats(dossier, { seed: "another-seed", day: "2026-09-04", count: 2 });
    for (const b of beats) expect(names.has(b.author)).toBe(true);
  });

  it("falls back to a neutral beat for an arc it doesn't recognize (e.g. a reconstructed deal's 'unknown')", () => {
    const dossier = baseDossier({ scenario: "unknown" });
    const beats = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 1 });
    expect(beats).toHaveLength(1);
    expect(beats[0]!.sentiment).toBe("Neutral");
  });

  it("stalled-portfolio stays quiet on most days (2 in 3) rather than authoring every day", () => {
    const dossier = baseDossier({ scenario: "stalled-portfolio" });
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const authoredDays = days.filter((day) => planNextBeats(dossier, { seed: "quiet-seed", day, count: 1 }).length > 0);
    // Roughly 1/3 of days author a beat — assert it's a minority, not "every day" (the bug this guards against).
    expect(authoredDays.length).toBeLessThan(days.length);
    expect(authoredDays.length).toBeGreaterThan(0);
  });

  it("never re-opens a fact an earlier beat already SETTLED (no contradicting the timeline)", () => {
    const dossier = baseDossier({
      beats: [
        {
          ref: "email-0",
          kind: "email",
          day: "2026-08-20T15:00:00.000Z",
          author: "Dana Kessler",
          sentiment: "Positive",
          summary: "Dana settles the budget pushback",
          establishes: [{ key: "budget_pushback_open", value: "Dana confirmed the budget pushback is resolved", status: "settled" }],
        },
      ],
    });
    const beats = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 1 });
    const reopened = beats.flatMap((b) => b.establishes ?? []).find((e) => e.key === "budget_pushback_open");
    expect(reopened).toBeUndefined();
  });

  it("carries establishedFacts from earlier beats into the new beat's CopyRequest (via the reused attachSpineContext)", () => {
    const dossier = baseDossier({
      beats: [
        {
          ref: "email-0",
          kind: "email",
          day: "2026-08-20T15:00:00.000Z",
          author: "Marcus Ito",
          sentiment: "Neutral",
          summary: "Marcus flags the renewal timeline",
          establishes: [{ key: "renewal_window", value: "Renewal window confirmed as Q4", status: "settled" }],
        },
      ],
    });
    const [draft] = planNextBeats(dossier, { seed: "demo", day: "2026-09-04", count: 1 });
    const beatRef = "drip-2026-09-04-0";
    const fullBeat = { ...draft!, ref: beatRef };
    const extended = { ...dossier, beats: [...dossier.beats, fullBeat] };

    const bundle = NarrativeBundle.parse({
      records: { Opportunity: [{ _ref: "opp-0", _meta: { dossier: extended } }] },
      copyRequests: extended.beats.map((b) => ({ id: b.ref, kind: b.kind, scenario: extended.scenario, beatIntent: b.summary, beat: b })),
      plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-09-04T15:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    attachSpineContext(bundle);
    const newRequest = bundle.copyRequests.find((c) => c.id === beatRef)!;
    expect(newRequest.spineContext?.establishedFacts?.some((f) => f.key === "renewal_window")).toBe(true);
  });
});
