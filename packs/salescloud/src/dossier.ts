// packs/salescloud/src/dossier.ts
//
// The STATIC Deal Dossier builder (Phase 4A) — authors a deterministic narrative spine per foreground
// deal, templated from the scenario archetype. It is the single source of truth the deal's emails,
// tasks, and transcripts are generated FROM (see generate.ts, which walks `dossier.beats`). 4B swaps
// this for a Claude-authored dossier behind the same shape; the static builder remains the
// no-LLM/deterministic fallback. Draws come from the per-unit rng in email→task→transcript order, so
// counts stay in the scenario ranges and the bundle stays byte-stable per seed.

import type { Rng, DealDossier, DossierBeat, DossierCastMember, DossierSentiment } from "@dataseed/core";
import { spreadDates } from "@dataseed/core";
import type { ScenarioProfile, SentimentShape } from "./variability.js";

/** Author the sentiment TRAJECTORY: where a beat sits on the arc, from its position + the scenario shape. */
function sentimentForBeat(shape: SentimentShape, index: number, total: number): DossierSentiment {
  const p = total <= 1 ? 1 : index / (total - 1); // 0 = oldest touch … 1 = most recent
  if (shape === "accelerating") return p < 0.3 ? "Neutral" : "Positive"; // healthy: warms, ends strong
  if (shape === "stalling") {
    // at-risk / churn: opens engaged, then decays into pushback and silence
    if (p < 0.35) return "Positive";
    if (p < 0.6) return "Neutral";
    if (p < 0.85) return "Negative";
    return "Risk";
  }
  return "Neutral"; // steady / rfp-gated: deliberately flat + sparse
}

const STANCE: Record<string, string> = {
  Champion: "championing internally",
  "Economic Buyer": "holds the budget, not yet sold",
  Skeptic: "unconvinced, pushing back on fit",
  Blocker: "gatekeeping the process",
  "Technical Evaluator": "running the technical validation",
  Coach: "feeding us intel from inside",
  "End User": "will live with the rollout",
};

/** A one-line stance for a cast member, tightened by the arc (a stalling deal's champion has gone quiet). */
function stanceFor(persona: string, shape: SentimentShape): string {
  const base = STANCE[persona] ?? "involved in the evaluation";
  if (shape === "stalling" && persona === "Champion") return `${base} — but has gone quiet lately`;
  return base;
}

function humanUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

/** Add N days to a YYYY-MM-DD (or ISO) date, returning YYYY-MM-DD. Deterministic (parses a fixed string). */
function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** The fiscal-quarter label (Q1–Q4) for a date — derived from the month, so a pinned deadline carries a
 *  quarter that can never disagree with it (the audit's "Q2 audit package due July 11" Q2/Q3 mismatch). */
function quarterLabel(date: string): string {
  return `Q${Math.floor(new Date(date).getUTCMonth() / 3) + 1}`;
}

/** The PRIMARY friction axis a deal centers on — sampled per deal so two same-scenario deals don't share the
 *  same objection (the audit's "Shopify and Atlassian execute the identical at-risk scenario down to the same
 *  module objection" template-mold). Decorrelated by unitIndex like the trigger, so a 6-deal run spreads. */
const OBJECTION_FOCI = [
  "pricing / ROI — the buyer pushes hardest on cost justification, payback period, and discount or terms",
  "security & compliance — the buyer pushes hardest on data residency, SOC 2 / audit posture, and access controls",
  "technical integration — the buyer pushes hardest on API limits, data-pipeline fit, and migration effort",
  "timing & sequencing — the buyer pushes hardest on the rollout timeline, resourcing, and competing priorities",
  "procurement & vendor consolidation — the buyer pushes hardest on contract terms, vendor rationalization, and the approval path",
];

/** Incumbents a legacy-migration deal displaces — flavour for that trigger. */
const LEGACY_TOOLS = ["a homegrown Tableau stack", "an aging on-prem BI warehouse", "a sprawl of spreadsheets and one-off Looker dashboards", "a legacy Cognos deployment"];

/**
 * The acute TRIGGER that makes the prospect buy NOW — varied per deal so the corpus isn't one mold
 * ("consolidate N systems → stuck in finance review → send a one-page ROI model" on every account, the
 * believability audit's template-mold tell). Each yields an arc clause + the deal's pain framing for `facts`.
 * Drawn on INDEPENDENT rng streams ("trigger"/"legacy") so it never shifts the email/task/transcript draws.
 * Only the consolidation trigger surfaces `systemsCount` — so a non-consolidation deal never cites "N systems"
 * (this also retires round 4's over-cited scope pin, which the audit flagged as repeated 6× on one deal).
 */
type DealTrigger = { key: string; arc: string; pain: string };
function triggerFor(rng: Rng, systemsCount: number, unitIndex: number, closeDate: string): DealTrigger {
  const legacy = LEGACY_TOOLS[(rng.derive("legacy").int(0, LEGACY_TOOLS.length - 1) + unitIndex) % LEGACY_TOOLS.length] ?? LEGACY_TOOLS[0]!;
  // Canonical pinned quantities — the audit's worst recurring tells were UN-pinned ones (Lucid's board
  // deadline stated 5 different ways, First Solar's build duration 8 vs 18 vs 4 months). The audit lands
  // shortly AFTER sign; its quarter is DERIVED from the date so the two can never disagree.
  const boardDeadline = addDays(closeDate, 7 + rng.derive("deadline").int(0, 21));
  const dq = quarterLabel(boardDeadline);
  const buildMonths = 4 + rng.derive("builddur").int(0, 14); // 4–18 months
  const opts: DealTrigger[] = [
    { key: "consolidation", arc: `internal teams are stitching reporting across ${systemsCount} disconnected systems by hand`, pain: `If you cite how many disconnected systems/tools the prospect runs, it is exactly ${systemsCount} — never a different count, and cite it at most once (don't restate it every message).` },
    { key: "legacy-migration", arc: `they're trying to migrate off ${legacy} that can no longer keep up`, pain: `The deal is a MIGRATION off ${legacy} — frame it as replacing that incumbent, not buying net-new tooling; do not lean on a generic "N disconnected systems" pitch.` },
    { key: "failed-inhouse", arc: `an in-house analytics build overran (~${buildMonths} months in) before stalling, so they're weighing buy-over-build`, pain: `An internal build stalled after about ${buildMonths} months — use THIS duration in every artifact that mentions it, never a different number of months; this is a BUY-VS-BUILD decision, not a generic "consolidate N systems" framing.` },
    { key: "compliance-deadline", arc: `a board/audit reporting deadline (${boardDeadline}, ${dq}) is forcing a reporting-infrastructure decision`, pain: `A fixed board/audit reporting DEADLINE forces this deal: it is ${boardDeadline} (${dq}). Use THIS exact date and quarter for the deadline in every artifact — never a different date or a different quarter; legal must have something signed before it.` },
    { key: "post-reorg", arc: `a recent reorg merged two orgs whose data and metrics don't reconcile`, pain: `A reorg/merger left two teams' data unreconciled — the deal UNIFIES them; frame around the merged orgs, not a raw system count.` },
    { key: "cost-rationalization", arc: `finance is moving to consolidate redundant analytics and vendor spend`, pain: `Finance is CUTTING redundant tool/vendor spend — frame around consolidating overlapping vendors and cost, not a raw system count.` },
  ];
  return opts[(rng.derive("trigger").int(0, opts.length - 1) + unitIndex) % opts.length] ?? opts[0]!;
}

/**
 * Derive the Opportunity StageName from the deal's MATURITY — not an independent pick — so the stage can't
 * contradict the narrative (the audit's "Stage=Proposal but the emails have the budget signed off and are
 * trading redlines / scheduling implementation" tell). Maturity follows the SAME signals the dossier's
 * settled facts use, so stage ↔ established facts ↔ prose all cohere:
 *   - no Economic Buyer engaged (rfp/early casts)       → pre-proposal (Qualification / Needs Analysis / Value Proposition)
 *   - EB present but the budget is contested (stalling) → mature but stuck (Proposal/Price Quote or Negotiation/Review)
 *   - EB present and approving (accelerating/steady)    → papering a verbally-committed deal (Negotiation/Review)
 * Exactly one rng.pick per branch — same draw count as the old single pick, so the stream stays aligned.
 */
export function deriveStage(shape: SentimentShape, hasEconomicBuyer: boolean, rng: Rng): string {
  if (!hasEconomicBuyer) return rng.pick(["Qualification", "Needs Analysis", "Value Proposition"]);
  if (shape === "stalling") return rng.pick(["Proposal/Price Quote", "Negotiation/Review"]);
  return rng.pick(["Negotiation/Review"]);
}

export interface DossierBuildArgs {
  scenario: string;
  prof: ScenarioProfile;
  accountName: string;
  sector: string;
  amount: number;
  closeDate: string;
  asOf: string;
  unitIndex: number;
  aeName: string;
  /** The Opportunity's StageName (picked in generate.ts) — pinned onto the dossier so the copy layer can
   *  hold every artifact to this stage's maturity (the "Stage=Proposal but the thread is in redlines" tell). */
  stageName: string;
  /** The seeded buying committee (Contact refs) — the dossier cast MUST be these, never invented names. */
  cast: ReadonlyArray<{ ref: string; name: string; persona: string }>;
  /** Real public context about the prospect — its competitor + pain ground the numbers. */
  grounding: { painPhrase?: string; competitors?: string[] };
  /**
   * When the account carries a PRIOR closed-won land (set on priorWin scenarios — expansion/renewal),
   * the actual prior deal's facts, so the spine frames this deal as an EXPANSION on a live deployment
   * (not a net-new greenfield eval) and every artifact treats the existing relationship as known. Populated
   * by generate.ts from the prior Opp it emits, so the dossier and the records agree on amount/date/product.
   */
  priorWin?: { amountUsd: number; closeDate: string; product: string };
  rng: Rng;
}

/**
 * Build the static dossier for one deal. Beats are emitted in stream order (emails, then tasks, then
 * transcripts), each timestamped — generate.ts walks them to produce the records. Determinism: every
 * draw is on the passed per-unit rng, in a fixed order.
 */
// Each artifact stream anchors at a CLEAN, recent business moment that varies per deal (unitIndex) and per
// stream — so MessageDate/ActivityDate never inherit asOf's exact now()-millisecond instant (the literal-leak
// tell: every deal's final artifact stamped 2026-06-20T12:37:52.759Z) and the newest email / task / transcript
// don't collide on one instant across deals or within a deal. asOf normalizes to a business morning (no ms).
export function streamAnchor(asOf: string, unitIndex: number, streamOffsetHours: number): string {
  const d = new Date(asOf);
  d.setUTCHours(10, 0, 0, 0); // business-morning base — drops the now()-millisecond, clean seconds
  return new Date(d.getTime() - (unitIndex * 19 + streamOffsetHours) * 3_600_000).toISOString();
}

export function buildDealDossier(args: DossierBuildArgs): DealDossier {
  const { prof, accountName, sector, amount, closeDate, asOf, unitIndex, aeName, cast, grounding, rng, priorWin, stageName } = args;
  const shape = prof.shape;
  // Per-deal narrative variant: pick one intent paraphrase so two deals of the SAME scenario don't stamp a
  // verbatim arc + email-summary string (the "interchangeable beat sheet" tell). Drawn on an INDEPENDENT rng
  // stream ("structure") so it can't shift the email/task/transcript count draws below — determinism preserved.
  const intentChoices = prof.intents?.length ? prof.intents : [prof.intent];
  const intent = intentChoices[rng.derive("structure").int(0, intentChoices.length - 1)] ?? prof.intent;
  const beats: DossierBeat[] = [];
  // A PINNED magnitude for the consolidation/integration pain — authored ONCE so every artifact cites the
  // SAME number (the audit's "5 systems" in an email vs "14" in the transcript). Independent rng stream, so
  // it adds no draw-shift. Conditional: only constrains a count IF the copy mentions one.
  const systemsCount = rng.derive("scope").int(4, 9);
  // The deal's acute trigger (why now) + primary objection axis — both varied per deal (and decorrelated by
  // unitIndex) so two same-scenario deals don't share a why-now OR a dominant objection (the template-mold).
  const trigger = triggerFor(rng, systemsCount, unitIndex, closeDate);
  const objectionFocus = OBJECTION_FOCI[(rng.derive("objection").int(0, OBJECTION_FOCI.length - 1) + unitIndex) % OBJECTION_FOCI.length] ?? OBJECTION_FOCI[0]!;
  const facts = (extra = "") =>
    `Deal facts (use these EXACT figures/names, don't invent others): deal value ${humanUsd(amount)}, target close ${closeDate}; primary contact ${cast[0]?.name ?? "the buyer"}. ${trigger.pain} This deal's PRIMARY friction is ${objectionFocus} — center its tension on that axis (a different deal centers on a different one).${extra}`;

  // ── Email thread beats ──────────────────────────────────────────────────────────────────────────
  const emailCount = rng.int(prof.emailRange[0], prof.emailRange[1]);
  const emailDates = spreadDates(rng.derive("emails"), streamAnchor(asOf, unitIndex, 3), emailCount, { spanDays: 45, shape });
  emailDates.forEach((day, k) => {
    const incoming = rng.bool(0.5);
    const counterpart = rng.pick(cast);
    const isLatest = k === emailDates.length - 1;
    beats.push({
      ref: `email-${unitIndex}-${k}`,
      kind: "email",
      day,
      direction: incoming ? "inbound" : "outbound",
      author: incoming ? counterpart.name : aeName,
      ...(incoming ? { authorRef: counterpart.ref } : {}),
      participantRef: counterpart.ref,
      sentiment: sentimentForBeat(shape, k, emailCount),
      summary: `Email ${k + 1}/${emailCount} for ${accountName} (${sector}), ${incoming ? `inbound from ${counterpart.name} (${counterpart.persona})` : `outbound from ${aeName} (the AE)`}${isLatest ? " — most recent touch" : ""}. ${intent}`,
      conveys: facts(' Reference the figure once; don\'t repeat "ARR".'),
    });
  });

  // ── Logged-activity Task beats (the rep's notes) ─────────────────────────────────────────────────
  const tr = rng.derive("tasks");
  const taskCount = tr.int(prof.taskRange[0], prof.taskRange[1]);
  const taskDates = spreadDates(tr.derive("dates"), streamAnchor(asOf, unitIndex, 17), taskCount, { spanDays: 45, shape });
  taskDates.forEach((day, k) => {
    const who = tr.pick(cast);
    const activity = tr.bool(0.7) ? "call" : "meeting";
    beats.push({
      ref: `task-${unitIndex}-${k}`,
      kind: "task",
      day,
      author: aeName,
      participantRef: who.ref,
      sentiment: sentimentForBeat(shape, k, taskCount),
      summary: `Logged ${activity} with ${who.name} (${who.persona}) on the ${accountName} (${sector}) deal. Write the rep's terse internal CRM activity note: what was discussed, what was decided, any objection raised, and the concrete next step.`,
      conveys: facts(),
      detail: { activity },
    });
  });

  // ── ECI transcript beats (recorded conversations) ────────────────────────────────────────────────
  const ir = rng.derive("inbox");
  const inboxCount = ir.int(1, 2);
  const inboxDates = spreadDates(ir.derive("dates"), streamAnchor(asOf, unitIndex, 31), inboxCount, { spanDays: 45, shape });
  const CI_SOURCES = ["Einstein Conversation Insights", "Gong", "Chorus", "Otter"];
  inboxDates.forEach((day, k) => {
    const speaker = ir.pick(cast);
    const activity = ir.bool(0.6) ? "call" : "meeting";
    const contentKind = ir.bool(0.7) ? "Transcript" : "Summary";
    const sourceSystem = ir.pick(CI_SOURCES);
    beats.push({
      ref: `inbox-${unitIndex}-${k}`,
      kind: "transcript",
      day,
      author: speaker.name,
      authorRef: speaker.ref,
      participantRef: speaker.ref,
      sentiment: sentimentForBeat(shape, k, inboxCount),
      summary: `Recorded ${activity} on the ${accountName} (${sector}) deal — ${speaker.name} (${speaker.persona}) and the AE (${aeName}). Write the ${contentKind === "Summary" ? "AI conversation summary" : "transcript excerpt"}: the substantive exchange — what each side said, the numbers and commitments, any objection, and where it left off.`,
      conveys: facts(),
      detail: { activity, contentKind, sourceSystem },
    });
  });

  // ── Monotonic deal-state ─────────────────────────────────────────────────────────────────────────
  // Commit settled/open facts at pivotal beats (in CHRONOLOGICAL order) so every LATER artifact treats them
  // as KNOWN — killing the pervasive timeline tells: a budget sign-off re-announced as fresh news 4× weeks
  // apart, and a close date that silently slides. Pure (position + cast derived, no rng draw) and append-only,
  // so it never perturbs the streams above. The copy layer accumulates each beat's `establishes` into the
  // next beats' story-so-far ledger (see thread-context.ts) and forbids re-announcing/contradicting them.
  const chrono = [...beats].sort((a, b) => a.day.localeCompare(b.day)); // shares element refs → mutations land on beats
  const n = chrono.length;
  if (n >= 2) {
    // Existing-customer framing: the FIRST touch already knows this is an expansion/renewal on a LIVE
    // deployment — kills the structural tell where a prior-closed-won account narrates as a net-new
    // greenfield eval ("Tech eval kickoff", "before we touch production", zero reference to the rollout).
    if (priorWin) {
      const first = chrono[0]!;
      first.establishes = [
        ...(first.establishes ?? []),
        { key: "relationship", value: `${accountName} is ALREADY a customer — they bought ${priorWin.product} for ${humanUsd(priorWin.amountUsd)} (closed ${priorWin.closeDate}) and it is live in production. This ${humanUsd(amount)} deal is the EXPANSION/RENEWAL on that deployment, NOT a first purchase — reference the existing rollout and never frame this as a brand-new, first-time evaluation`, status: "settled" },
      ];
    }
    const eb = cast.find((c) => c.persona === "Economic Buyer");
    const amountStr = humanUsd(amount);
    // Budget — only when an Economic Buyer is in the room (early/RFP arcs have none → budget genuinely unsettled).
    if (eb) {
      const budgetBeat = chrono[Math.min(n - 1, Math.max(1, Math.floor(n * 0.4)))]!;
      if (shape === "stalling") {
        budgetBeat.establishes = [{ key: "budget", value: `${eb.name} (Economic Buyer) put the ${amountStr} budget under review — it is NOT re-approved yet`, status: "open" }];
        budgetBeat.dealState = { ceilingUsd: Math.round(amount * 0.72), signedOff: false };
      } else {
        budgetBeat.establishes = [{ key: "budget", value: `${eb.name} (Economic Buyer) approved the ${amountStr} budget`, status: "settled" }];
        budgetBeat.dealState = { signedOff: true };
      }
    }
    // Deadline — both sides lock the REAL close date (the record's CloseDate) at a later beat, so no artifact
    // invents a different or sliding date. Append/merge in case it lands on the same beat as the budget fact.
    const deadlineBeat = chrono[Math.min(n - 1, Math.max(1, Math.floor(n * 0.65)))]!;
    deadlineBeat.establishes = [...(deadlineBeat.establishes ?? []), { key: "deadline", value: `the target close date is firmly set for ${closeDate}`, status: "settled" }];
    deadlineBeat.dealState = { ...deadlineBeat.dealState, closeDate };
  }

  const castOut: DossierCastMember[] = cast.map((c) => ({ ref: c.ref, name: c.name, persona: c.persona, stance: stanceFor(c.persona, shape) }));
  // Pick the competing vendor per-deal (independent rng stream) so the corpus isn't "vs Tableau" on every
  // account — grounding.competitors is the seller's rival-BI-vendor pool, the same for all deals.
  const competitor = grounding.competitors?.length ? grounding.competitors[(rng.derive("competitor").int(0, grounding.competitors.length - 1) + unitIndex) % grounding.competitors.length] : undefined;
  const ceiling = shape === "stalling" ? Math.round(amount * 0.72) : undefined; // at-risk: a contested budget ceiling below the ask

  return {
    scenario: args.scenario,
    arc:
      `${accountName} (${sector}), a ${humanUsd(amount)} deal closing ~${closeDate}. ${intent}` +
      ` The trigger to act now: ${trigger.arc}.` +
      ` The deal's primary point of friction is ${objectionFocus.split(" — ")[0]}.` +
      (priorWin ? ` This is an EXISTING customer expanding/renewing — they already run ${priorWin.product} (bought ${humanUsd(priorWin.amountUsd)}, closed ${priorWin.closeDate}); this deal builds on that live deployment, not a first-time evaluation.` : "") +
      (competitor ? ` A competitive eval against ${competitor} (a rival data/analytics platform) is in the mix.` : "") +
      (grounding.painPhrase ? ` The chronic underlying pain: ${grounding.painPhrase}.` : ""),
    cast: castOut,
    beats,
    numbers: { amountUsd: amount, ...(ceiling ? { ceilingUsd: ceiling } : {}), ...(grounding.painPhrase ? { painMetric: grounding.painPhrase } : {}) },
    ...(competitor ? { competitor } : {}),
    stageName,
    signalAims: [],
    provenance: "static",
  };
}
