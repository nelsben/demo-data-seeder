import { describe, it, expect } from "vitest";
import { NarrativeBundle, DealDossier } from "@dataseed/core";
import { attachSpineContext, hasSpineContext, buildPrompt, buildEmailUserPrompt } from "../src/copy/index.js";

// A 3-beat deal across two emails + a task at distinct days (out of chronological order in the array).
const dossier = () =>
  DealDossier.parse({
    scenario: "at-risk-budget",
    arc: "Acme's budget got contested; the champion is going quiet.",
    cast: [{ ref: "c0", name: "Dana", persona: "Champion" }],
    beats: [
      { ref: "email-0-1", kind: "email", day: "2026-05-20T00:00:00.000Z", author: "Alex", direction: "outbound", sentiment: "Risk", summary: "AE chases the silent champion" },
      { ref: "email-0-0", kind: "email", day: "2026-05-01T00:00:00.000Z", author: "Dana", direction: "inbound", sentiment: "Positive", summary: "Dana confirms the pilot went well" },
      { ref: "task-0-0", kind: "task", day: "2026-05-10T00:00:00.000Z", author: "Alex", sentiment: "Neutral", summary: "Logged: CFO pulled into the budget review" },
    ],
    numbers: { amountUsd: 1_200_000 },
    provenance: "static",
  });

const bundle = (): NarrativeBundle =>
  NarrativeBundle.parse({
    records: { Opportunity: [{ _ref: "opp-0", _meta: { dossier: dossier() } }] },
    // copy requests carry their beat (generate sets it), so the trajectory line renders.
    copyRequests: dossier().beats.map((b) => ({ id: b.ref, kind: b.kind, scenario: "at-risk-budget", beatIntent: "x", beat: b })),
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
  });

describe("attachSpineContext — the compact story-so-far", () => {
  it("stamps the deal arc + prior beats in chronological order onto each request", () => {
    const b = bundle();
    const n = attachSpineContext(b);
    expect(n).toBe(3);
    expect(hasSpineContext(b)).toBe(true);
    const byId = new Map(b.copyRequests.map((c) => [c.id, c]));

    // The opener (earliest) has the arc but NO prior touches.
    expect(byId.get("email-0-0")!.spineContext!.arc).toContain("budget got contested");
    expect(byId.get("email-0-0")!.spineContext!.storySoFar).toEqual([]);

    // The newest email sees both earlier touches, oldest first.
    const latest = byId.get("email-0-1")!.spineContext!.storySoFar;
    expect(latest).toHaveLength(2);
    expect(latest[0]).toContain("Dana confirms the pilot"); // 2026-05-01 first
    expect(latest[1]).toContain("CFO pulled into the budget review"); // 2026-05-10 next
  });

  it("does nothing to a bundle whose Opportunities carry no dossier (backward-compatible)", () => {
    const b = NarrativeBundle.parse({
      records: { Opportunity: [{ _ref: "opp-0" }] },
      copyRequests: [{ id: "e", kind: "email", scenario: "s", beatIntent: "x" }],
      plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    expect(attachSpineContext(b)).toBe(0);
    expect(hasSpineContext(b)).toBe(false);
  });
});

describe("the copy prompt renders thread context", () => {
  it("includes the arc + the story-so-far bullets when present", () => {
    const b = bundle();
    attachSpineContext(b);
    const latest = b.copyRequests.find((c) => c.id === "email-0-1")!;
    const { user } = buildPrompt(latest);
    expect(user).toContain("The deal's arc");
    expect(user).toContain("Story so far");
    expect(user).toContain("Dana confirms the pilot");
    expect(user).toContain("This moment's place on the trajectory: Risk");
  });

  it("the opener prompt carries the arc but no story-so-far block", () => {
    const b = bundle();
    attachSpineContext(b);
    const opener = b.copyRequests.find((c) => c.id === "email-0-0")!;
    const user = buildEmailUserPrompt(opener);
    expect(user).toContain("The deal's arc");
    expect(user).not.toContain("Story so far");
  });

  it("a request with no spineContext renders exactly as before (no arc/story lines)", () => {
    const bare = { id: "e", kind: "email", scenario: "s", beatIntent: "Beat text", speakers: [] } as never;
    const user = buildEmailUserPrompt(bare);
    expect(user).not.toContain("The deal's arc");
    expect(user).not.toContain("Story so far");
  });
});
