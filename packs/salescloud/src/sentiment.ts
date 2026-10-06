// packs/salescloud/src/sentiment.ts
//
// Per-account customer SENTIMENT, projected into the standard Account.Rating field (Hot/Warm/Cold). Sentiment
// is the ONE "account state" that can't be reconstructed from raw fields — it's a narrative property of the
// deal's trajectory — so it's the only thing we STORE; every other state an agent might query (urgency,
// expansion, lifecycle) is computed live from standard fields at retrieval time (see select_accounts). These
// projections are PURE, TOTAL, and RNG-FREE: stamping Rating onto a record changes THAT record's bytes but
// consumes no RNG, so no other object's stream shifts (the golden diff stays Account-only on the v24 bump).

import type { SentimentShape } from "./variability.js";

export type AccountRating = "Hot" | "Warm" | "Cold";

/** FOREGROUND: a hero deal's sentiment IS its dossier sentiment SHAPE — the same signal `sentimentForBeat`
 *  derives the beat arc from (dossier.ts). accelerating → Hot (healthy / expanding), stalling → Cold
 *  (at-risk / churning), steady → Warm (early / RFP-gated, deliberately flat). Scenario→shape is fixed in
 *  SCENARIO_PROFILES, so this resolves the archetypes consistently: healthy-tech → Hot; at-risk-budget /
 *  stalled-portfolio / churning-account → Cold; rfp-gated → Warm. */
export function ratingForForeground(shape: SentimentShape): AccountRating {
  if (shape === "accelerating") return "Hot";
  if (shape === "stalling") return "Cold";
  return "Warm"; // steady
}

/** BULK: a population account has no dossier, so derive sentiment STRUCTURALLY from its close-won/lost history
 *  (already tracked as hasWon/hasLost at the bulk Account emit). won & !lost → Hot (healthy customer);
 *  lost & !won → Cold (lost / at-risk); won & lost → Warm (mixed); neither → Warm (open prospect, no signal). */
export function ratingForBulk(hasWon: boolean, hasLost: boolean): AccountRating {
  if (hasWon && !hasLost) return "Hot";
  if (hasLost && !hasWon) return "Cold";
  return "Warm"; // mixed (won&lost) or no-signal (neither)
}
