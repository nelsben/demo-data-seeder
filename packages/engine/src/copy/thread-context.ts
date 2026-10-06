// packages/engine/src/copy/thread-context.ts
//
// Thread-aware copy prep (Phase 4C). The copy layer fills one artifact at a time, so without help
// email N is authored blind to email N-1 — the judge's "a reply that doesn't actually respond". This
// stamps each copy request with a COMPACT story-so-far from its deal's dossier: the arc + the prior
// beats' one-line summaries (chronological, oldest first). The copy prompt then has the deal's whole
// story without paying to stuff every prior body in (Ben's "compact story-so-far" over "full text").
// Works on the static dossier too — so thread-awareness lands even with no LLM spine.

import type { GenericRecord, NarrativeBundle, DealDossier } from "@dataseed/core";

/** A compact one-liner for a prior beat in the story-so-far. */
const beatLine = (b: DealDossier["beats"][number]) => `${b.kind} (${b.author}): ${b.summary}`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Weekday name for an ISO date — deterministic (parses a fixed string; no clock). Powers the shared
 *  calendar so copy can't name a wrong weekday or narrate a future-dated interaction as already happened. */
const weekdayOf = (iso: string): string => WEEKDAYS[new Date(iso).getUTCDay()] ?? "";

/**
 * Stamp `spineContext` (arc + prior-beat summaries) onto every copy request that maps to a dossier
 * beat, in place. For each deal, beats are ordered by their timestamp so "story so far" is the real
 * chronology across emails, tasks, and transcripts. Returns how many requests were enriched.
 */
export function attachSpineContext(bundle: NarrativeBundle): number {
  const reqById = new Map(bundle.copyRequests.map((c) => [c.id, c]));
  let enriched = 0;
  for (const opp of bundle.records.Opportunity ?? []) {
    const dossier = (opp._meta as { dossier?: DealDossier } | undefined)?.dossier;
    if (!dossier) continue;
    const ordered = [...dossier.beats].sort((a, b) => a.day.localeCompare(b.day));
    // The deal's shared calendar: every interaction that exists, with its date + weekday. Same for all of a
    // deal's requests — it's the authoritative "what happened, and when" the copy can't contradict or invent past.
    const activityIndex = ordered.map((b) => ({ date: b.day.slice(0, 10), weekday: weekdayOf(b.day), kind: b.kind }));
    ordered.forEach((beat, i) => {
      const req = reqById.get(beat.ref);
      if (!req) return;
      // The deal's shared memory: facts COMMITTED by every strictly-earlier beat. A later artifact sees
      // them as KNOWN, so the copy layer can forbid re-announcing a settled sign-off or sliding a deadline.
      const establishedFacts = ordered.slice(0, i).flatMap((b) => b.establishes ?? []);
      req.spineContext = {
        arc: dossier.arc,
        storySoFar: ordered.slice(0, i).map(beatLine),
        roster: dossier.cast.map((c) => ({ name: c.name, persona: c.persona })),
        establishedFacts,
        activityIndex,
        ...(dossier.stageName ? { stageName: dossier.stageName } : {}),
      };
      enriched++;
    });
  }
  return enriched;
}

/** True if any copy request carries thread context — lets a caller log whether 4C ran. */
export function hasSpineContext(bundle: NarrativeBundle): boolean {
  return bundle.copyRequests.some((c) => c.spineContext != null);
}

/** Re-export the record type for callers that index the bundle. */
export type { GenericRecord };
