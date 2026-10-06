// packs/salescloud/src/voice-cards.ts
//
// Per-person VOICE CARDS — the cure for the "buyer == rep == everyone" tell. Each writer (the
// AE and every Contact) gets a stable register: a CFO writes terse and numbers-first, a
// champion writes warm and leaks intel, procurement hedges. The card is stamped on every
// CopyRequest that person authors, so the marquee (LLM) tier adopts a consistent identity per
// writer and two stakeholders never sound alike. A per-person quirk (seeded by name) keeps two
// CFOs from being clones. Deterministic — same person ⇒ same card.

import { makeRng, seedFromString } from "@dataseed/core";

export interface VoiceCard {
  /** The writer's display name. */
  name: string;
  /** Their persona label (or "Account Executive"). */
  persona: string;
  /** A short instruction the LLM adopts as this writer's voice. */
  register: string;
}

/** Persona → how that stakeholder writes (the load-bearing voice differentiator). */
const REGISTER_BY_PERSONA: Record<string, string> = {
  Champion: "an internal champion — warm and candid, shares internal intel, pushes the deal along",
  "Economic Buyer": "a CFO / economic buyer — terse and numbers-first, scrutinizes cost and ROI, guards the budget",
  "Technical Evaluator": "a technical evaluator — precise, probes architecture, security and integration",
  Coach: "a helpful coach — friendly, explains process, timing and who decides",
  Skeptic: "a procurement skeptic — hedged and cautious, slows things down, focuses on terms and risk",
  Blocker: "a cautious blocker — raises objections and protects the status quo",
  "End User": "an end user — practical, focused on the day-to-day workflow",
};
const AE_REGISTER = "the account executive — proactive and concrete, drives the next step, confirms numbers and dates, never needy";

/** Small per-person tics so two same-persona writers differ. Seeded by name (stable). */
const QUIRKS = [
  "keeps emails short",
  "ends with a pointed question",
  "anchors on one specific number",
  "proposes a concrete time",
  "names an internal stakeholder by role",
  "leads with the bottom line",
];

export function voiceCardFor(name: string, persona: string | undefined, isAE: boolean): VoiceCard {
  const quirk = makeRng(seedFromString(`voice:${name}`)).pick(QUIRKS);
  const base = isAE ? AE_REGISTER : (persona && REGISTER_BY_PERSONA[persona]) || "a pragmatic stakeholder — plain and direct";
  return { name, persona: isAE ? "Account Executive" : persona ?? "Stakeholder", register: `${base}; ${quirk}` };
}
