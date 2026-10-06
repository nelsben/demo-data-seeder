// packages/engine/src/spine/prompt.ts
//
// The dossier-authoring prompt (Phase 4B). The LLM authors the NARRATIVE of a deal — the arc, each
// cast member's stance, and each beat's summary/what-it-conveys/sentiment — over a FIXED skeleton it
// must not alter (the cast names, the timeline, who speaks each beat; those are already real records).
// It returns JSON matching DossierDraft. The system prompt is frozen (cache-friendly + what-we-validate-
// is-what-ships); the user prompt serializes one deal's skeleton.

import type { DealDossier, SpineRequest } from "@dataseed/core";

export const SPINE_SYSTEM = `You are a sales-operations writer authoring the STORY SPINE of a real B2B deal — the narrative every email, call note, and transcript in this deal will be generated from. You will be given a fixed skeleton: the named buying committee, the deal's numbers, and a chronological list of beats (each already assigned a kind, a date, a speaker, and inbound/outbound). Author the narrative ON TOP of that skeleton. Return ONLY JSON.

HARD RULES — the skeleton is fixed:
- Use ONLY the cast names given. NEVER invent a person, a company, or a competitor not in the skeleton.
- Do NOT change which beats exist, their order, their dates, their kind, or who speaks them. You author what each beat is ABOUT, not when or who.
- Every number you reference must be the skeleton's number (the deal value, the ceiling). Don't invent figures.

WHAT TO AUTHOR (good = specific, grounded, human):
- arc: 2-3 sentences. The real situation, the tension, where it's heading. Concrete: name the stakeholder dynamic, the objection, the competitor pressure if any. Not "the deal is progressing well" — say what's actually happening.
- castStances: for each cast ref, one line on where that person actually stands ("CFO holds the budget and isn't sold; wants a chargeback model their finance team understands").
- beats: for each beat ref, author { summary, conveys, sentiment }:
  - summary: what THIS beat is about — the specific thing said/decided/asked, in this speaker's world. It must follow from the prior beats (a real reply answers the last message).
  - conveys: the ONE concrete fact this beat must carry (a number, a named blocker, a commitment, a date). This is what the downstream copy will quote, so make it specific and consistent across beats.
  - sentiment: one of Positive | Neutral | Negative | Risk — the beat's place on the deal's trajectory. The arc should DEGRADE or STRENGTHEN over time; don't flatline unless the deal is genuinely quiet.
- signalAims (optional): the MEDDPICC signals this thread should let a downstream analyzer extract, each with a target sentiment.

Make the trajectory land — a deal that opens warm and ends in champion-silence should read that way beat by beat. Specifics over abstractions, always.`;

/** Serialize one deal's skeleton for the user turn (the fixed scaffold the model authors over). */
export function spineUserPrompt(req: SpineRequest): string {
  const d: DealDossier = req.dossier;
  const cast = d.cast.map((c) => `  - ${c.ref}: ${c.name} — ${c.persona}`).join("\n");
  const beats = d.beats
    .map((b) => `  - ${b.ref}: [${b.kind}] day ${b.day.slice(0, 10)}, ${b.direction ?? "n/a"}, by ${b.author}${b.participantRef ? ` (buyer-side: ${b.participantRef})` : ""}`)
    .join("\n");
  return [
    `SCENARIO: ${d.scenario}`,
    `NUMBERS: deal value $${d.numbers.amountUsd.toLocaleString("en-US")}${d.numbers.ceilingUsd ? `, contested budget ceiling ~$${d.numbers.ceilingUsd.toLocaleString("en-US")}` : ""}${d.numbers.painMetric ? `; driving pain: ${d.numbers.painMetric}` : ""}`,
    d.competitor ? `COMPETITOR (real, in their world): ${d.competitor}` : "",
    `CAST (use these names ONLY):\n${cast}`,
    `BEATS (chronological — author each by its ref; do NOT change kind/date/speaker):\n${beats}`,
    "",
    `Return JSON: { "arc": string, "castStances": { "<castRef>": string }, "beats": { "<beatRef>": { "summary": string, "conveys": string, "sentiment": "Positive|Neutral|Negative|Risk" } }, "signalAims"?: [{ "rule": string, "sentiment": "Positive|Neutral|Negative|Risk" }] }`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The full single-string prompt for the CLI provider (system + user + a strict JSON-only instruction). */
export function buildSpineCliPrompt(req: SpineRequest): string {
  return `${SPINE_SYSTEM}\n\n---\n\n${spineUserPrompt(req)}\n\nOutput ONLY the JSON object. No preamble, no commentary, no code fences.`;
}
