// packs/salescloud/src/scenarios.ts
//
// The Sales Cloud pack's named scenarios (deal arcs) — the vocabulary for a run's
// scenario-mix. Each compiles to a deal narrative (the dossier spine derives from it).
// Generic B2B deal archetypes; their realism craft is in docs/narrative-design.md.

export const SALESCLOUD_SCENARIOS = [
  "at-risk-budget", // champion-silence, budget contested, an honest earned-risk read
  "healthy-tech", // momentum — mostly green, accelerating toward close
  "rfp-gated", // early-stage honest read — sparse, process-gated, no champion yet
  "stalled-portfolio", // scale — late-stage skew, Stalling/Dark velocity
  "churning-account", // cross-deal intel — multi-Opp, Closed-Lost, declining
] as const;

export type SalesCloudScenario = (typeof SALESCLOUD_SCENARIOS)[number];
