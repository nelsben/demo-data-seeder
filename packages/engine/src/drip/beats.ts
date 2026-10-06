// packages/engine/src/drip/beats.ts
//
// The next-beat AUTHORING INPUT: given a deal's dossier (real or reconstructed — see dossier.ts) and
// today's date, decide what the next 1-2 beats ARE (kind, sentiment, who, when, what they establish)
// before any prose gets written. Pure — no LLM call here; this is the deterministic skeleton the copy
// layer (fillCopy, reused as-is) then writes prose FROM, exactly like generate.ts's own dossier→beat→
// copyRequest pipeline. Arc-aware: the beat kind/sentiment/summary follow the deal's story instead of
// being generic ("at-risk-budget" escalates a budget objection, "healthy-tech" progresses toward
// security/legal, "stalled-portfolio" mostly stays quiet). Never lets a new beat re-open a fact an
// earlier beat already SETTLED (dossier.beats[].establishes) — the same "no contradicting the
// timeline" invariant thread-context.ts enforces on the copy side.

import type { DealDossier, DossierBeat, DossierSentiment } from "@dataseed/core";
import { seededFraction } from "./select.js";

/** A beat not yet turned into a record — validated against the real DossierBeat shape (minus `ref`,
 *  which the caller assigns once it knows the eventual CopyRequest/record id). */
export type DraftBeat = Omit<DossierBeat, "ref">;

export interface PlanNextBeatsOptions {
  seed: string | number;
  /** ISO date (YYYY-MM-DD) — "today", the day these beats are dated on. */
  day: string;
  /** --beats (1 or 2). */
  count: 1 | 2;
}

/** One arc's authoring template for its Nth beat of the day (i is 0-based, < count). */
type BeatTemplate = (cast: DealDossier["cast"], i: number, seed: string | number, day: string) => {
  kind: DraftBeat["kind"];
  sentiment: DossierSentiment;
  direction?: "inbound" | "outbound";
  summarize: (authorName: string) => string;
  establishKey?: string;
  establishValue?: (authorName: string) => string;
};

/** Deterministically pick a cast member (falls back to a synthesized "the Account Executive" author
 *  when the dossier has no cast — a reconstructed deal with no resolvable OpportunityContactRole). */
function pickCastMember(cast: DealDossier["cast"], seed: string | number, day: string, salt: string): DealDossier["cast"][number] | undefined {
  if (cast.length === 0) return undefined;
  const idx = Math.floor(seededFraction(seed, day, salt) * cast.length) % cast.length;
  return cast[idx];
}

const ARC_TEMPLATES: Record<string, BeatTemplate> = {
  "at-risk-budget": (cast, i, seed, day) => {
    const person = pickCastMember(cast, seed, day, `at-risk-budget-${i}`);
    const name = person?.name ?? "the Account Executive";
    return {
      kind: i === 0 ? "email" : "task",
      sentiment: "Risk",
      direction: i === 0 ? "inbound" : undefined,
      summarize: () => `${name} pushes back on the budget ceiling as the close date approaches`,
      establishKey: "budget_pushback_open",
      establishValue: () => `${name} raised renewed budget pushback`,
    };
  },
  "churning-account": (cast, i, seed, day) => {
    const person = pickCastMember(cast, seed, day, `churning-${i}`);
    const name = person?.name ?? "the Account Executive";
    return {
      kind: i === 0 ? "email" : "task",
      sentiment: "Risk",
      direction: i === 0 ? "inbound" : undefined,
      summarize: () => `${name} flags renewed churn risk on the account`,
      establishKey: "churn_risk_open",
      establishValue: () => `${name} flagged renewed churn risk`,
    };
  },
  "healthy-tech": (cast, i, seed, day) => {
    const person = pickCastMember(cast, seed, day, `healthy-tech-${i}`);
    const name = person?.name ?? "the Account Executive";
    return {
      kind: i === 0 ? "task" : "email",
      sentiment: "Positive",
      direction: i === 1 ? "inbound" : undefined,
      summarize: () => `${name} moves the deal into security review with Legal looped in`,
      establishKey: "security_review_scheduled",
      establishValue: () => `security review scheduled with Legal looped in`,
    };
  },
  "rfp-gated": (cast, i, seed, day) => {
    const person = pickCastMember(cast, seed, day, `rfp-gated-${i}`);
    const name = person?.name ?? "the Account Executive";
    return {
      kind: "email",
      sentiment: "Neutral",
      direction: i === 0 ? "inbound" : undefined,
      summarize: () => `${name} shares the next step in the RFP process`,
    };
  },
  "stalled-portfolio": (cast, i, seed, day) => {
    const person = pickCastMember(cast, seed, day, `stalled-${i}`);
    const name = person?.name ?? "the Account Executive";
    return {
      kind: "email",
      sentiment: "Neutral",
      summarize: () => `${name} sends a light touchpoint to keep the deal warm`,
    };
  },
};

/** Any arc not in ARC_TEMPLATES (incl. "unknown" — a reconstructed deal with no recoverable origin
 *  story) gets a neutral "steady progress" beat rather than guessing at a story it doesn't know. */
const DEFAULT_TEMPLATE: BeatTemplate = (cast, i, seed, day) => {
  const person = pickCastMember(cast, seed, day, `default-${i}`);
  const name = person?.name ?? "the Account Executive";
  return {
    kind: "email",
    sentiment: "Neutral",
    direction: i === 0 ? "inbound" : undefined,
    summarize: () => `${name} follows up on where the deal stands`,
  };
};

/** Every key an EARLIER beat already SETTLED — a later beat may reference these but must never
 *  contradict or re-open them (mirrors thread-context.ts's establishedFacts guard). */
function settledKeys(dossier: DealDossier): Set<string> {
  const keys = new Set<string>();
  for (const b of dossier.beats) for (const e of b.establishes ?? []) if (e.status === "settled") keys.add(e.key);
  return keys;
}

/** One full day (UTC) after `iso`, same time-of-day. */
function plusOneDay(iso: string): Date {
  return new Date(Date.parse(iso) + 86_400_000);
}

/** Plan the next 1-2 beats for a deal: arc-aware kind/sentiment/summary, authored from the dossier's
 *  cast, dated strictly after the dossier's last beat (never dated before `opts.day`, so a scheduler
 *  running late in the day still writes "today"). Returns [] when the arc's own cadence says today is
 *  a quiet day (stalled-portfolio, ~2 days in 3) — a deal `select.ts` picked can still author nothing. */
export function planNextBeats(dossier: DealDossier, opts: PlanNextBeatsOptions): DraftBeat[] {
  const arc = dossier.scenario || "unknown";

  if (arc === "stalled-portfolio") {
    // "Stays quiet 2 days in 3" — author only on the ~1-in-3 draw. Salted independently of select.ts's
    // own jitter so the two decisions don't correlate (a deal selected "because it's overdue" isn't
    // then silently muted by the exact same coin flip that influenced its selection).
    const draw = seededFraction(opts.seed, opts.day, dossier.scenario, "quiet-gate");
    if (draw >= 1 / 3) return [];
  }

  const template = ARC_TEMPLATES[arc] ?? DEFAULT_TEMPLATE;
  const settled = settledKeys(dossier);

  const lastBeatDay = dossier.beats.length ? dossier.beats[dossier.beats.length - 1]!.day : undefined;
  const todayFloor = `${opts.day}T15:00:00.000Z`; // a plausible business-hours anchor for "today"
  const baseline = lastBeatDay && Date.parse(lastBeatDay) >= Date.parse(todayFloor) ? plusOneDay(lastBeatDay).toISOString() : todayFloor;

  const out: DraftBeat[] = [];
  for (let i = 0; i < opts.count; i++) {
    const t = template(dossier.cast, i, opts.seed, opts.day);
    const person = pickCastMember(dossier.cast, opts.seed, opts.day, `author-${arc}-${i}`);
    const day = new Date(Date.parse(baseline) + i * 2 * 60 * 60 * 1000).toISOString(); // beats of the same day 2h apart
    const establishes =
      t.establishKey && t.establishValue && !settled.has(t.establishKey)
        ? [{ key: t.establishKey, value: t.establishValue(person?.name ?? "the Account Executive"), status: "open" as const }]
        : undefined;
    out.push({
      kind: t.kind,
      day,
      author: person?.name ?? "the Account Executive",
      ...(person ? { authorRef: person.ref, participantRef: person.ref } : {}),
      ...(t.kind === "email" ? { direction: t.direction ?? "outbound" } : {}),
      sentiment: t.sentiment,
      summary: t.summarize(person?.name ?? "the Account Executive"),
      ...(establishes ? { establishes } : {}),
    });
  }
  return out;
}
