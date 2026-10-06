import { describe, it, expect } from "vitest";
import { NarrativeBundle, type CopyProvider, type CopyRequest, type CopyFillContext, type CopyFillOutput } from "@dataseed/core";
import { StaticCopyProvider } from "../src/copy/static-provider.js";
import { AnthropicCopyProvider } from "../src/copy/anthropic-provider.js";
import { buildEmailPrompt, buildPrompt, EMAIL_SYSTEM_PROMPT, TASK_SYSTEM_PROMPT, TRANSCRIPT_SYSTEM_PROMPT } from "../src/copy/prompt.js";
import { fillCopy, applyCopy } from "../src/copy/orchestrate.js";

const reqs: CopyRequest[] = [
  { id: "email-0-0", kind: "email", scenario: "at-risk-budget", beatIntent: "Budget squeeze. Email 1/2, outbound from the AE.", speakers: ["Account Executive"] },
  { id: "email-0-1", kind: "email", scenario: "at-risk-budget", beatIntent: "CFO pushes back. Email 2/2, inbound from Diane Okafor (Economic Buyer) — most recent touch.", speakers: ["Diane Okafor"] },
  { id: "email-1-0", kind: "email", scenario: "healthy-tech", beatIntent: "Momentum. Email 1/1, outbound from the AE.", speakers: ["Account Executive"] },
];

// A bundle whose EmailMessage records carry `_ref` == the request id (the apply seam).
function makeBundle(): NarrativeBundle {
  return NarrativeBundle.parse({
    records: {
      EmailMessage: reqs.map((r) => ({ _ref: r.id, _refs: { RelatedToId: "opp-0" }, Subject: "", TextBody: "", Incoming: false })),
    },
    copyRequests: reqs,
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 7, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 2, volume: 2 },
  });
}

const ctx: CopyFillContext = { asOf: "2026-06-17T00:00:00.000Z" };

describe("buildEmailPrompt", () => {
  it("ships the frozen voice spec as system + a per-request beat as user", () => {
    const { system, user } = buildEmailPrompt(reqs[1]!);
    expect(system).toBe(EMAIL_SYSTEM_PROMPT);
    expect(system).toMatch(/AI slop/i); // the anti-slop rules are present
    expect(system).toMatch(/I hope this email finds you well/); // names the tell to avoid
    expect(user).toContain("at-risk-budget"); // trajectory threaded in
    expect(user).toContain("Diane Okafor"); // speaker threaded in
    expect(user).toContain("CFO pushes back"); // the beat
  });

  it("weaves the prospect's grounding into the user prompt (one detail, not a fact-dump)", () => {
    const { user } = buildEmailPrompt({
      id: "g", kind: "email", scenario: "healthy-tech", beatIntent: "outbound from the AE", speakers: ["the AE"],
      facts: { grounding: { does: "cloud data warehousing", painPhrase: "compute-cost sprawl across teams", products: ["the Data Cloud"] } },
    });
    expect(user).toContain("cloud data warehousing");
    expect(user).toContain("compute-cost sprawl across teams");
    expect(user).toMatch(/weave in ONE/i); // instructed to use one, not list them
  });

  it("injects the writer's voice card so each persona writes in its own register", () => {
    const { user } = buildEmailPrompt({
      id: "v", kind: "email", scenario: "healthy-tech", beatIntent: "inbound from the buyer", speakers: ["Diane Okafor"],
      voiceCard: { name: "Diane Okafor", persona: "Economic Buyer", register: "a CFO — terse and numbers-first" },
    });
    expect(user).toContain("Write as Diane Okafor");
    expect(user).toContain("numbers-first");
  });

  it("pins the model to the deal's cast roster with an anti-invention guard (kills name drift)", () => {
    const { user } = buildEmailPrompt({
      id: "r", kind: "email", scenario: "rfp-gated", beatIntent: "outbound from the AE", speakers: ["the AE"],
      spineContext: { arc: "an RFP-gated eval", storySoFar: [], roster: [{ name: "Sofia Chen", persona: "Coach" }, { name: "Omar Novak", persona: "Economic Buyer" }] },
    });
    expect(user).toContain("Sofia Chen (Coach)");
    expect(user).toContain("Omar Novak (Economic Buyer)");
    expect(user).toMatch(/never invent another stakeholder/i);
    expect(user).toMatch(/never change or add a surname/i); // the Sofia Chen → Sofia Vance guard
  });

  it("anchors copy to the message's send date so relative-time language matches the spread timeline", () => {
    const { user } = buildEmailPrompt({
      id: "d", kind: "email", scenario: "at-risk-budget", beatIntent: "outbound from the AE", speakers: ["the AE"],
      facts: { closeDate: "2026-07-07" },
      beat: { day: "2026-05-03T07:00:00.000Z" },
    } as unknown as CopyRequest);
    expect(user).toContain("Date of THIS message: 2026-05-03"); // the actual send date, not the close
    expect(user).toMatch(/never call a date far in the future "this week"/);
    expect(user).toContain("2026-07-07"); // close framed as future relative to send date
  });

  it("re-announcing a settled fact is forbidden (the Wei-signed-off-3x repetition tell)", () => {
    const { user } = buildEmailPrompt({
      id: "s", kind: "email", scenario: "healthy-tech", beatIntent: "outbound from the AE", speakers: ["the AE"],
      spineContext: { arc: "a healthy deal", storySoFar: ["email (Wei): approved the $21K budget"], roster: [] },
    } as unknown as CopyRequest);
    expect(user).toMatch(/never re-announce it as if it just happened/i);
  });
});

describe("StaticCopyProvider", () => {
  it("is always available and fills every request, deterministically", async () => {
    const p = new StaticCopyProvider();
    expect(await p.available()).toBe(true);
    const a = await p.fill(reqs, ctx);
    const b = await p.fill(reqs, ctx);
    expect(a.results.map((r) => r.id)).toEqual(reqs.map((r) => r.id));
    expect(a.estCostUsd).toBe(0);
    expect(a.results).toEqual(b.results); // byte-stable from the request id
  });
  it("writes scenario-shaped, slop-free, signed-off emails", async () => {
    const { results } = await new StaticCopyProvider().fill(reqs, ctx);
    for (const r of results) {
      expect((r.subject ?? "").length).toBeGreaterThan(3);
      expect(r.body).toMatch(/\n\n/); // paragraph beats
      expect(r.body).toMatch(/—\s+\w+$/); // first-name sign-off
      expect(r.body).not.toMatch(/I hope this email finds you well|circle back|synergy/i);
      expect(r.provider).toBe("static");
    }
  });
  it("respects ctx.limit", async () => {
    const { results } = await new StaticCopyProvider().fill(reqs, { ...ctx, limit: 1 });
    expect(results).toHaveLength(1);
  });
  it("threads the subject — the opener bare, replies prefixed Re:", async () => {
    const base = { kind: "email", scenario: "healthy-tech", beatIntent: "outbound from the AE", speakers: ["Alex"], seedSubject: "Acme — rollout plan" };
    const open: CopyRequest = { ...base, id: "t-0", seq: { index: 0, total: 3 } };
    const reply: CopyRequest = { ...base, id: "t-1", seq: { index: 1, total: 3 } };
    const { results } = await new StaticCopyProvider().fill([open, reply], ctx);
    const byId = Object.fromEntries(results.map((x) => [x.id, x]));
    expect(byId["t-0"]!.subject).toBe("Acme — rollout plan");
    expect(byId["t-1"]!.subject).toBe("Re: Acme — rollout plan");
  });
  it("renders a SENTIMENT TRAJECTORY across a thread — early reads positive, late carries the scenario climax", async () => {
    const base = {
      kind: "email",
      scenario: "at-risk-budget",
      beatIntent: "outbound from the AE",
      speakers: ["Account Executive"],
      facts: { amountUsd: 833000, closeDate: "2026-08-02", primaryContact: "Aisha Chen" },
    } satisfies Omit<CopyRequest, "id" | "seq">;
    const early = { ...base, id: "thr-0", seq: { index: 0, total: 5 } } satisfies CopyRequest;
    const late = { ...base, id: "thr-4", seq: { index: 4, total: 5 } } satisfies CopyRequest;
    const e = (await new StaticCopyProvider().fill([early], ctx)).results[0]!.body;
    const l = (await new StaticCopyProvider().fill([late], ctx)).results[0]!.body;
    expect(e).toMatch(/momentum|pilot|moving/i); // early: positive engagement
    expect(e).not.toMatch(/blocker|stalling|haven't heard/i);
    expect(l).toMatch(/budget|finance|blocker|stalling/i); // late: the at-risk climax
    expect(e).not.toBe(l); // the arc actually moved
  });
  it("weaves the deal's real facts (amount, contact, close date) into the body — the signal-bearing specifics", async () => {
    const req: CopyRequest = {
      id: "email-9-0",
      kind: "email",
      scenario: "at-risk-budget",
      beatIntent: "Budget squeeze. Email 1/1, outbound from the AE.",
      speakers: ["Account Executive"],
      facts: { amountUsd: 833000, closeDate: "2026-08-02", primaryContact: "Aisha Chen", counterpart: "Marcus Reyes", sector: "Observability" },
    };
    const { results } = await new StaticCopyProvider().fill([req], ctx);
    const body = results[0]!.body;
    expect(body).toContain("$833K"); // the real figure, humanized (not "$833,000")
    expect(body).toContain("Aisha Chen"); // the primary contact
    expect(body).toContain("Aug 2"); // the close date, humanized
  });
});

describe("provider availability gates", () => {
  it("anthropic is gated on ANTHROPIC_API_KEY", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(new AnthropicCopyProvider().available()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(new AnthropicCopyProvider().available()).toBe(true);
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });
});

// A mock primary provider: fills only the ids it's told to, reports a cost.
class MockProvider implements CopyProvider {
  id = "anthropic";
  constructor(private fillIds: Set<string>, private avail = true) {}
  available() {
    return this.avail;
  }
  async fill(requests: CopyRequest[], _ctx: CopyFillContext): Promise<CopyFillOutput> {
    const results = requests
      .filter((r) => this.fillIds.has(r.id))
      .map((r) => ({ id: r.id, subject: "S", body: "B", provider: "anthropic" }));
    return { results, estCostUsd: results.length * 0.01, budgetExhausted: this.fillIds.size < requests.length };
  }
}

describe("fillCopy orchestration", () => {
  it("runs the primary then static-fills the remainder — every request gets a result", async () => {
    const primary = new MockProvider(new Set(["email-0-0"])); // fills only 1 of 3
    const providers: CopyProvider[] = [primary, new StaticCopyProvider()];
    const report = await fillCopy(reqs, providers, { requestedProvider: "anthropic", asOf: ctx.asOf, gate: false });
    expect(report.provider).toBe("anthropic");
    expect(report.filledByPrimary).toBe(1);
    expect(report.fallbacks).toBe(2);
    expect(report.results).toHaveLength(3); // no request left unfilled
    expect(report.results.find((r) => r.id === "email-0-0")!.provider).toBe("anthropic");
    expect(report.results.find((r) => r.id === "email-0-1")!.provider).toBe("static");
    expect(report.estCostUsd).toBeCloseTo(0.01);
  });

  it("auto-resolves to static when no preferred provider is available", async () => {
    const providers: CopyProvider[] = [new MockProvider(new Set(), false), new StaticCopyProvider()];
    const report = await fillCopy(reqs, providers, { requestedProvider: "auto", asOf: ctx.asOf });
    expect(report.provider).toBe("static");
    expect(report.results.every((r) => r.provider === "static")).toBe(true);
  });

  it("an explicitly requested provider that's unavailable falls back to static, doesn't throw", async () => {
    const providers: CopyProvider[] = [new MockProvider(new Set(), false), new StaticCopyProvider()];
    const report = await fillCopy(reqs, providers, { requestedProvider: "anthropic", asOf: ctx.asOf, gate: false });
    expect(report.provider).toBe("anthropic"); // it led, but produced nothing…
    expect(report.fallbacks).toBe(3); // …so static caught all three
  });
});

describe("task copy (logged activities)", () => {
  const taskReq: CopyRequest = {
    id: "task-0-0", kind: "task", scenario: "at-risk-budget", speakers: ["Alex"],
    beatIntent: "Logged call with Diane Okafor (Economic Buyer) on the Acme deal. Write the rep's terse internal note.",
    facts: { amountUsd: 200000, closeDate: "2026-08-31", counterpart: "Diane Okafor" },
    seq: { index: 0, total: 1 },
  };

  it("buildPrompt dispatches on kind — task → the activity-log system prompt, email → the email one", () => {
    expect(buildPrompt(taskReq).system).toBe(TASK_SYSTEM_PROMPT);
    expect(buildPrompt(taskReq).system).toMatch(/internal CRM activity log/i);
    expect(buildPrompt(taskReq).user).toContain("Diane Okafor");
    expect(buildPrompt(reqs[0]!).system).toBe(EMAIL_SYSTEM_PROMPT); // emails still route to the email prompt
  });

  it("the static floor renders a Task note as a private log — no greeting, no sign-off, carries specifics", async () => {
    const { results } = await new StaticCopyProvider().fill([taskReq], ctx);
    const note = results[0]!;
    expect(note.body).not.toMatch(/—\s+\w+$/); // NOT signed off (it's a log, not an email)
    expect(note.body).not.toMatch(/^(Hi|Hello|Dear)\b/i); // no greeting
    expect(note.body).toMatch(/Next:/); // a concrete next step
    expect(note.body).toContain("$200K"); // the humanized deal figure
    expect((note.subject ?? "").length).toBeGreaterThan(3);
  });

  it("applyCopy writes a task result onto Task.Description (not TextBody)", () => {
    const bundle = NarrativeBundle.parse({
      records: { Task: [{ _ref: "task-0-0", _refs: { WhoId: "c0", WhatId: "opp-0" }, Subject: "", Description: "" }] },
      copyRequests: [taskReq],
      plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 7, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    const { applied } = applyCopy(bundle, [{ id: "task-0-0", subject: "Pricing call — budget cap", body: "Call with Diane. Next: send model.", provider: "static" }]);
    expect(applied).toBe(1);
    const t = bundle.records.Task![0]!;
    expect(t.Description).toBe("Call with Diane. Next: send model.");
    expect(t.Subject).toBe("Pricing call — budget cap");
  });
});

describe("transcript copy (call recordings)", () => {
  const transcriptReq: CopyRequest = {
    id: "inbox-0-0", kind: "transcript", scenario: "at-risk-budget", speakers: ["Diane Okafor", "Alex"],
    beatIntent: "Recorded call on the Acme deal — Diane Okafor (Economic Buyer) and the AE (Alex). Write the transcript excerpt.",
    facts: { amountUsd: 200000, closeDate: "2026-08-31", primaryContact: "Diane Okafor", counterpart: "Diane Okafor" },
    seq: { index: 0, total: 1 },
    voiceCard: { name: "Diane Okafor", persona: "Economic Buyer", register: "a CFO — terse and numbers-first" },
  };

  it("buildPrompt dispatches transcript → the conversation system prompt (not email/task)", () => {
    const { system, user } = buildPrompt(transcriptReq);
    expect(system).toBe(TRANSCRIPT_SYSTEM_PROMPT);
    expect(system).toMatch(/TRANSCRIPT EXCERPT|CONVERSATION SUMMARY/); // the conversation spec, not the email one
    expect(user).toContain("Diane Okafor"); // participant threaded in
    expect(user).toContain("at-risk-budget"); // trajectory
    expect(buildPrompt(reqs[0]!).system).not.toBe(TRANSCRIPT_SYSTEM_PROMPT); // emails still route to the email prompt
  });

  it("the static floor renders a transcript as a real exchange carrying the deal's specifics", async () => {
    const rec = (await new StaticCopyProvider().fill([transcriptReq], ctx)).results[0]!;
    expect(rec.body.length).toBeGreaterThan(0);
    expect(rec.body).toContain("$200K"); // the humanized deal figure (the signal-bearing specific)
    expect(rec.body).toMatch(/\bDiane\b|\bAlex\b/); // a participant is named in the exchange
    expect(rec.provider).toBe("static");
  });

  it("renders an AI SUMMARY when the beat asks for one (a Next: step), not a speaker-labeled transcript", async () => {
    const summary: CopyRequest = { ...transcriptReq, id: "inbox-0-1", beatIntent: "Recorded meeting on the Acme deal — Diane and the AE. Write the AI conversation summary." };
    const body = (await new StaticCopyProvider().fill([summary], ctx)).results[0]!.body;
    expect(body).toMatch(/Next:/);
  });

  it("applyCopy writes a transcript result onto ContentVersion.VersionData (the transcript file body)", () => {
    const bundle = NarrativeBundle.parse({
      records: { ContentVersion: [{ _ref: "inbox-0-0", _refs: { FirstPublishLocationId: "opp-0" }, VersionData: "" }] },
      copyRequests: [transcriptReq],
      plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 7, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    const { applied } = applyCopy(bundle, [{ id: "inbox-0-0", subject: "ignored — the transcript body is the VTT file", body: "Diane: our cap is $200K. Alex: I'll send the payback model.", provider: "static" }]);
    expect(applied).toBe(1);
    expect(bundle.records.ContentVersion![0]!.VersionData).toBe("Diane: our cap is $200K. Alex: I'll send the payback model.");
  });
});

describe("applyCopy", () => {
  it("writes Subject/TextBody onto the EmailMessage matching each result id", async () => {
    const bundle = makeBundle();
    const { results } = await new StaticCopyProvider().fill(reqs, ctx);
    const { applied, unmatched } = applyCopy(bundle, results);
    expect(applied).toBe(3);
    expect(unmatched).toEqual([]);
    for (const e of bundle.records.EmailMessage!) {
      expect((e.TextBody as string).length).toBeGreaterThan(0);
      expect((e.Subject as string).length).toBeGreaterThan(0);
    }
  });
  it("reports a result whose id matches no record as unmatched", () => {
    const bundle = makeBundle();
    const { applied, unmatched } = applyCopy(bundle, [{ id: "ghost", body: "x", provider: "static" }]);
    expect(applied).toBe(0);
    expect(unmatched).toEqual(["ghost"]);
  });
});
