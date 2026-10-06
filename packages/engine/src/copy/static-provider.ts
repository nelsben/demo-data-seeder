// packages/engine/src/copy/static-provider.ts
//
// StaticCopyProvider — the always-available fallback tier (the BRIEF's final routing
// fallback). NO LLM: deterministic templated emails seeded from the request id, so re-runs
// are byte-stable. It renders the FIVE canonical archetype ARCS parameterized across
// companies — a deal's thread evolves through phases (early → mid → late), so the synthesis
// sees a real SENTIMENT TRAJECTORY, not flat same-day noise:
//   - at-risk-budget (Meridian): strong pilot → budget question → champion goes quiet.
//   - healthy-tech (TechVista): momentum → stakeholder alignment → sign-off. Green throughout.
//   - rfp-gated (Cascade): scoping → criteria mapping → committee still deciding. Early/quiet,
//     honestly NOT at risk.
//   - stalled-portfolio: a late-stage deal whose cadence decayed to Stalling/Dark — proposal
//     out, then slow, then fully gone quiet.
//   - churning-account: an existing customer's renewal at risk — usage/incidents raised,
//     competitor evaluation, an escalated decision.
// Every line weaves the deal's REAL facts (amount, contact, close date) — the specifics the
// pipeline turns into FINANCIAL/AUTHORITY/TIMELINE signals. Modest prose by design; the
// marquee path is the AnthropicCopyProvider.
//
// Each beat field carries 2 phrasing VARIANTS, picked by a stable hash of the beat's own
// req.id (see variantOf) — not by phase position. Earlier versions had exactly ONE string
// per (scenario, phase, direction), so any two beats sharing a phase+direction rendered
// byte-identical bodies regardless of who was "speaking" (confirmed: a Skeptic and a Champion
// on the same deal uttering the exact same sentence, an Economic Buyer and a Technical
// Evaluator both saying "Finance capped this below $70K..."). That broke the documented
// guarantee that "a CFO and a champion never sound alike." Two variants doesn't guarantee
// zero repeats on a long thread, but it kills the 100%-collision case the audit caught.

import type { CopyProvider, CopyRequest, CopyFillContext, CopyFillOutput, CopyResult } from "@dataseed/core";
import { makeRng, seedFromString, type Rng } from "@dataseed/core";

const REP_NAMES = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Drew", "Taylor"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-27" → "Jul 27" (deterministic, no Date). */
function shortDate(iso?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

const firstName = (full: string) => full.split(/\s+/)[0] ?? full;

/** How a human writes a deal size: $1.2M, $750K — never the ledger figure "$1,200,000". */
function humanizeUsd(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

type Phase = "early" | "mid" | "late";
function phaseOf(seq?: { index: number; total: number }): Phase {
  if (!seq || seq.total <= 2) return "mid";
  const p = seq.index / (seq.total - 1);
  return p <= 0.34 ? "early" : p >= 0.75 ? "late" : "mid";
}

/** A small, stable per-request variant index in [0, n) — so two beats sharing the same
 *  (scenario, phase, direction) render DIFFERENT prose instead of a byte-identical body. Keyed
 *  off the beat's own unique req.id (not its phase-relative position), so it's stable across
 *  re-runs and doesn't correlate with phase the way seq.index would. */
function variantOf(id: string, n: number): number {
  return seedFromString(id) % n;
}
const pick = (arr: readonly string[], v: number): string => arr[v % arr.length]!;

interface Tokens {
  amt: string;
  who: string | null;
  close: string | null;
  byClose: string;
  withWho: string;
  pain: string | null;
}
function tokensOf(f: CopyRequest["facts"]): Tokens {
  // Humanized money, no "ARR" suffix on every mention (both were machine tells the realism
  // audit flagged); byClose says "ahead of" not "before" so it never collides with a host
  // clause's own "before" (the "before … before" concatenation seam).
  const amt = f?.amountUsd != null ? humanizeUsd(f.amountUsd) : "the proposed";
  const who = f?.primaryContact ?? null;
  const close = shortDate(f?.closeDate);
  return { amt, who, close, byClose: close ? ` ahead of the ${close} close` : "", withWho: who ? ` with ${who}` : "", pain: f?.grounding?.painPhrase ?? null };
}

interface Beat {
  subjects: string[];
  openOut: readonly string[];
  openIn: readonly string[];
  subOut: (t: Tokens, v: number) => string;
  subIn: (t: Tokens, v: number) => string;
  closeOut: readonly string[];
  closeIn: readonly string[];
}

// scenario → phase → the beat to render. The arc is the archetype.
const ARC: Record<string, Record<Phase, Beat>> = {
  "at-risk-budget": {
    early: {
      subjects: ["Strong pilot results", "Next step on the expansion"],
      openOut: ["Good momentum after the pilot — the numbers held up.", "Solid signal out of the pilot — worth building on."],
      openIn: ["The pilot looked strong on our side.", "Our team came away from the pilot pretty encouraged."],
      subOut: (t, v) => pick([
        `I'd like to keep this moving toward the ${t.amt} expansion${t.withWho}.`,
        `Let's use that momentum to lock down the ${t.amt} expansion${t.withWho} while it's fresh.`,
      ], v),
      subIn: (t, v) => pick([
        `We're keen to move the ${t.amt} expansion forward — I'm sold on my side, just lining up the rest.`,
        `The ${t.amt} expansion makes sense to me — I just need to get the rest of the team aligned.`,
      ], v),
      closeOut: ["What's the best next step on your side?", "How do you want to sequence the next step?"],
      closeIn: ["Send over a draft SOW and we'll socialize it.", "Get me a draft SOW and I'll start circulating it."],
    },
    mid: {
      subjects: ["The budget question", "Lining up the ROI case"],
      openOut: ["One open item before we go further.", "Wanted to flag one thing before we go further."],
      openIn: ["One thing I need to flag on cost.", "There's a cost question I need to raise."],
      subOut: (t, v) => pick([
        `I want to make sure ${t.who ?? "your team"} has the ROI case for the ${t.amt} number${t.byClose}.`,
        `Let's get ${t.who ?? "your team"} a clean ROI case on the ${t.amt} number${t.byClose} so it's an easy yes.`,
      ], v),
      subIn: (t, v) => pick([
        `Finance wants the ROI on the ${t.amt} figure before they'll sign off${t.close ? `; close is ${t.close}` : ""}.`,
        `Before finance signs off on the ${t.amt} figure, they want to see the ROI math${t.close ? `; we're targeting ${t.close}` : ""}.`,
      ], v),
      closeOut: ["Can we get 20 minutes with whoever owns the budget?", "Could we grab 20 minutes with the budget owner?"],
      closeIn: ["Can you put together a payback one-pager?", "Could you pull together a one-pager on payback?"],
    },
    late: {
      subjects: ["Where the budget stands", "Checking in before close"],
      openOut: ["I know the budget is the blocker right now.", "I know budget is what's holding this up."],
      openIn: ["Here's where the budget landed.", "Wanted to give you an update on where budget landed."],
      subOut: (t, v) => pick([
        `The ${t.amt} number is what's stalling us — finance flagged it and I haven't heard back${t.who ? ` from ${t.who}` : ""}. I'd like to get in front of it${t.byClose}.`,
        `We're stuck on the ${t.amt} number — finance raised it and it's gone quiet${t.who ? ` on ${t.who}'s end` : ""}. I'd rather get ahead of it${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `Finance capped this below ${t.amt} and I've gone quiet while we sort it internally — I'm not sure it clears${t.byClose}.`,
        `We came in under ${t.amt} on finance's cap and I've had to go quiet while we work it internally — no promises it clears${t.byClose}.`,
      ], v),
      closeOut: ["Are you free this week to talk it through?", "Any time this week to talk it through?"],
      closeIn: ["I'll come back to you once I have a clearer read.", "I'll circle back once I know more on my end."],
    },
  },
  "healthy-tech": {
    early: {
      subjects: ["Great kickoff", "Recap from today"],
      openOut: ["Good energy after today — thanks for getting your team in the room.", "Great session today — appreciate you pulling the team together."],
      openIn: ["The team liked what they saw.", "Good reaction from the team on our side."],
      subOut: (t, v) => pick([
        `We're aligned on the ${t.amt} scope; ${t.who ?? "the team"} seems ready to move.`,
        `The ${t.amt} scope is landing well — ${t.who ?? "the team"} looks ready to keep going.`,
      ], v),
      subIn: (t, v) => pick([
        `The ${t.amt} scope looks right to us — let's keep it moving.`,
        `We're comfortable with the ${t.amt} scope — let's keep the pace up.`,
      ], v),
      closeOut: ["I'll send the agenda for the next session.", "I'll get the next session on the calendar."],
      closeIn: ["Looking forward to the deep dive.", "Looking forward to digging in further."],
    },
    mid: {
      subjects: ["Path to a decision", "Lining up the stakeholders"],
      openOut: ["We're in good shape — just lining up the last approvals.", "Things are on track — just chasing the last few approvals."],
      openIn: ["This is tracking well internally.", "Internally this is moving in the right direction."],
      subOut: (t, v) => pick([
        `${t.who ?? "Your team"} has the materials for the ${t.amt} proposal; targeting a decision${t.byClose}.`,
        `${t.who ?? "Your team"} is set with everything on the ${t.amt} proposal; we're tracking to a decision${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `We're routing the ${t.amt} proposal for sign-off — on track${t.byClose}.`,
        `The ${t.amt} proposal is in sign-off routing now — still on pace${t.byClose}.`,
      ], v),
      closeOut: ["Anything you need from us to keep it on track?", "Anything on our end that would help keep it moving?"],
      closeIn: ["I'll confirm once it clears our side.", "I'll let you know the moment it clears our side."],
    },
    late: {
      subjects: ["Moving to sign-off", "Final step"],
      openOut: ["We're at the finish line.", "We're basically at the finish line."],
      openIn: ["We're ready to move forward.", "We're good to move forward on our end."],
      subOut: (t, v) => pick([
        `Everything's lined up for the ${t.amt} agreement — just the final signature${t.byClose}.`,
        `The ${t.amt} agreement is fully lined up — just need the final signature${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `We're ready to sign on the ${t.amt} scope${t.close ? `; ${t.close} works` : ""}.`,
        `We're good to sign on the ${t.amt} scope${t.close ? `; ${t.close} works for us` : ""}.`,
      ], v),
      closeOut: ["I'll send the paperwork over today.", "I'll get the paperwork over today."],
      closeIn: ["Send the paperwork and we'll turn it around.", "Get the paperwork to us and we'll turn it around fast."],
    },
  },
  "rfp-gated": {
    early: {
      subjects: ["Clarifying the requirements", "On your evaluation process"],
      openOut: ["A couple of questions so our response fits your process.", "A few questions so we scope our response correctly."],
      openIn: ["We're early in scoping this.", "We're still early on scoping our side of this."],
      subOut: (t, v) => pick([
        `We're scoping a response around ${t.amt}; want to map to your criteria${t.withWho}.`,
        `We're building a response in the ${t.amt} range and want to map it to your criteria${t.withWho}.`,
      ], v),
      subIn: (t, v) => pick([
        `Our requirement is roughly ${t.amt}; the committee is still finalizing criteria.`,
        `We're budgeting around ${t.amt}; the committee hasn't locked criteria yet.`,
      ], v),
      closeOut: ["Who's the right person to confirm the timeline with?", "Who should we confirm the timeline with?"],
      closeIn: ["We'll share the criteria once they're set.", "We'll get you the criteria once they're finalized."],
    },
    mid: {
      subjects: ["Mapping to your criteria", "Question on the evaluation"],
      openOut: ["Working through your criteria point by point.", "Going through your criteria one by one."],
      openIn: ["Still aligning internally on requirements.", "Still getting internal alignment on requirements."],
      subOut: (t, v) => pick([
        `Our response covers the ${t.amt} scope — happy to walk each criterion${t.withWho}${t.byClose}.`,
        `Our response addresses the ${t.amt} scope in full — glad to walk through each criterion${t.withWho}${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `We're comparing options around ${t.amt}; no decision yet${t.close ? `, evaluation runs through ${t.close}` : ""}.`,
        `We're still weighing options in the ${t.amt} range; nothing decided${t.close ? `, evaluation continues through ${t.close}` : ""}.`,
      ], v),
      closeOut: ["Let me know if a working session would help.", "Happy to set up a working session if useful."],
      closeIn: ["We'll be in touch as the process moves.", "We'll keep you posted as the process moves along."],
    },
    late: {
      subjects: ["On the evaluation timeline", "Where the process stands"],
      openOut: ["Checking in on where the evaluation stands.", "Wanted to check in on the evaluation."],
      openIn: ["We're still working through the process.", "Still working our way through the process."],
      subOut: (t, v) => pick([
        `Our ${t.amt} proposal is in; I know the committee is finalizing — no rush, just staying close${t.byClose}.`,
        `We've submitted our ${t.amt} proposal; the committee's finalizing — just keeping in touch${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `The committee hasn't finalized; we're still early on the ${t.amt} decision${t.close ? `, targeting ${t.close}` : ""}. Not stalled, just thorough.`,
        `Nothing's final yet on the committee's end; the ${t.amt} decision is still early${t.close ? `, we're targeting ${t.close}` : ""}. Thorough, not stuck.`,
      ], v),
      closeOut: ["Happy to answer anything the committee needs.", "Glad to answer anything else the committee needs."],
      closeIn: ["We'll let you know when there's a decision.", "We'll flag you the moment there's a decision."],
    },
  },
  // A late-stage deal whose cadence has decayed to Stalling/Dark (variability.ts intent) — StageName
  // stays late-funnel throughout (Proposal/Negotiation), but the THREAD goes from "still active" to
  // "gone quiet" as it progresses. Distinct from at-risk-budget: no budget objection was ever raised —
  // this deal simply lost momentum.
  "stalled-portfolio": {
    early: {
      subjects: ["Following up on the proposal", "Any update on our side?"],
      openOut: ["Wanted to follow up on the proposal we sent over.", "Circling back on the proposal from last week."],
      openIn: ["Still reviewing the proposal on our end.", "The proposal's still with the committee."],
      subOut: (t, v) => pick([
        `Wanted to check where things stand on the ${t.amt} proposal${t.byClose}.`,
        `Following up to see where the ${t.amt} proposal landed${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `We're still reviewing the ${t.amt} proposal internally — nothing to report yet.`,
        `The ${t.amt} proposal is still making its way through internal review.`,
      ], v),
      closeOut: ["Any sense of timing on a response?", "Any read on when we might hear back?"],
      closeIn: ["I'll push for an update and get back to you.", "Let me chase this and follow up."],
    },
    mid: {
      subjects: ["Checking in", "Still there?"],
      openOut: ["Haven't heard back in a bit — wanted to check in.", "It's been quiet on this one — following up."],
      openIn: ["Sorry for the slow reply — things have been hectic.", "Apologies for going quiet — been buried."],
      subOut: (t, v) => pick([
        `Wanted to make sure the ${t.amt} proposal didn't get lost in the shuffle${t.byClose}.`,
        `Just making sure the ${t.amt} proposal is still on your radar${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `The ${t.amt} deal is still live on our side, just slower than I'd like — priorities shifted internally.`,
        `We haven't dropped the ${t.amt} deal, it's just slipped behind some other priorities.`,
      ], v),
      closeOut: ["Worth a quick call to get this unstuck?", "Should we hop on a call to get this moving again?"],
      closeIn: ["Let's find time next week once things settle.", "Can we regroup once things calm down on my end?"],
    },
    late: {
      subjects: ["Still interested?", "Closing the loop"],
      openOut: ["Haven't heard back in a while — wanted to check the pulse on this.", "It's been quiet for a bit — checking if this is still active."],
      openIn: ["Sorry — this has fallen off my radar more than it should have.", "I know I've gone quiet; it's not intentional."],
      subOut: (t, v) => pick([
        `Before I mark the ${t.amt} deal stalled on our side, wanted to check if it's still live${t.byClose}.`,
        `Wanted to check in before assuming the ${t.amt} deal has gone cold${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `Honestly the ${t.amt} deal has slipped — priorities shifted and I haven't had a clear window to push it forward.`,
        `The ${t.amt} deal is still technically alive, but priorities moved and I haven't been able to give it the attention it needs.`,
      ], v),
      closeOut: ["Should I check back in a few weeks, or is this still moving?", "Is this still on the table, or should I check back later?"],
      closeIn: ["Let me see if I can get this back on track and circle back.", "I'll try to get this moving again and follow up."],
    },
  },
  // An existing customer's renewal at risk (variability.ts: declining sentiment, a competitor
  // circling, a prior win now souring). Distinct from at-risk-budget: this isn't a net-new deal
  // stalled on a budget objection — it's a RETENTION conversation trending toward loss.
  "churning-account": {
    early: {
      subjects: ["Renewal check-in", "Ahead of the renewal"],
      openOut: ["Wanted to get ahead of the renewal conversation.", "Kicking off the renewal check-in a bit early."],
      openIn: ["We've had some issues worth flagging before renewal.", "Wanted to raise a few things before we talk renewal."],
      subOut: (t, v) => pick([
        `Ahead of the ${t.amt} renewal, wanted to check how things have been running${t.byClose}.`,
        `With the ${t.amt} renewal coming up, wanted to check in on how the deployment's been holding up${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `Usage has been inconsistent and we've had a few incidents — want to talk through it before we commit to another term.`,
        `We've hit some rough patches with the deployment and want those addressed before we talk renewal.`,
      ], v),
      closeOut: ["Can we get some time to review usage before renewal?", "Worth a usage review before we get to renewal terms?"],
      closeIn: ["Let's get a call on the calendar to walk through it.", "Can we set up time to walk through the issues?"],
    },
    mid: {
      subjects: ["Renewal terms", "Where things stand on renewal"],
      openOut: ["Wanted to talk through renewal terms.", "Following up on where renewal stands."],
      openIn: ["We're evaluating options before we commit again.", "We've started looking at alternatives, to be transparent."],
      subOut: (t, v) => pick([
        `On the ${t.amt} renewal — want to make sure we're addressing what's been raised before asking for a signature${t.byClose}.`,
        `Before we move on the ${t.amt} renewal, want to be sure the open issues are actually resolved${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `We're looking at other options — the ${t.amt} renewal isn't a given until we see the issues fixed.`,
        `To be straight with you, we're evaluating alternatives; the ${t.amt} renewal depends on seeing real fixes first.`,
      ], v),
      closeOut: ["What can we get you in writing on the fixes?", "What would you need to see in writing on the fix plan?"],
      closeIn: ["Send over a remediation plan and we'll take it to the team.", "Get us a written plan and I'll bring it to the team."],
    },
    late: {
      subjects: ["Renewal decision", "Where we land on renewal"],
      openOut: ["Wanted to check in before the renewal decision.", "Following up ahead of the renewal deadline."],
      openIn: ["We're close to a decision on renewal, and it isn't looking good.", "I have to be honest — renewal is not looking like a given right now."],
      subOut: (t, v) => pick([
        `I know the ${t.amt} renewal is at risk — want to do whatever we can before the decision is made${t.byClose}.`,
        `I understand the ${t.amt} renewal is genuinely in question — let's talk about what would change that${t.byClose}.`,
      ], v),
      subIn: (t, v) => pick([
        `Leadership has made continued spend contingent on a fix, and right now I don't have one to point to${t.byClose}.`,
        `Without a credible fix, I don't think I can get sign-off on the ${t.amt} renewal${t.byClose}.`,
      ], v),
      closeOut: ["Is there anything we can commit to today to change the trajectory?", "What would it take to turn this around before the decision?"],
      closeIn: ["I'll escalate this internally and let you know where we land.", "I've escalated this — I'll come back with where we land."],
    },
  },
};

function renderEmail(req: CopyRequest, rng: Rng): CopyResult {
  const arc = ARC[req.scenario] ?? ARC["healthy-tech"]!;
  const beat = arc[phaseOf(req.seq)];
  const inbound = /inbound/i.test(req.beatIntent);
  const t = tokensOf(req.facts);
  const v = variantOf(req.id, 2);

  const rawSpeaker = req.speakers[0] ?? "Account Executive";
  // Prefer the writer's voice card (the canonical name); else fall back to the speaker, and if
  // that's the anonymous "Account Executive", seed a stable rep name from the THREAD so the same
  // rep signs every outbound touch on a deal.
  const threadKey = req.id.replace(/-\d+$/, "");
  const speaker = req.voiceCard?.name ?? (rawSpeaker === "Account Executive" ? makeRng(seedFromString(`ae:${threadKey}`)).pick(REP_NAMES) : rawSpeaker);

  // A real thread shares ONE subject; replies prefix "Re:". Fall back to the beat pool when a
  // request carries no seed subject (e.g. ad-hoc tests).
  const subject = req.seedSubject ? (req.seq && req.seq.index > 0 ? `Re: ${req.seedSubject}` : req.seedSubject) : rng.pick(beat.subjects);
  const opener = pick(inbound ? beat.openIn : beat.openOut, v);
  const substance = inbound ? beat.subIn(t, v) : beat.subOut(t, v);
  const closer = pick(inbound ? beat.closeIn : beat.closeOut, v);
  // The thread's first touch grounds itself in the prospect's real world — even on the floor,
  // this makes two companies' opening emails diverge (the LLM tier weaves it throughout).
  const ground = req.seq?.index === 0 && t.pain ? `\n\nOn our read, ${t.pain} is the piece this lands on.` : "";
  const body = `${opener}\n\n${substance}${ground}\n\n${closer}\n\n— ${firstName(speaker)}`;
  return { id: req.id, subject, body, provider: "static" };
}

/** The static floor for a logged-activity Task note: terse, specific, no greeting/sign-off (it's a private
 *  log). 2 variants per phase (picked by variantOf) so two Task beats sharing a phase don't render the
 *  identical note — the same fix applied to renderEmail's ARC. */
function renderTask(req: CopyRequest, _rng: Rng): CopyResult {
  const t = tokensOf(req.facts);
  const activity = /\bmeeting\b/i.test(req.beatIntent) ? "Meeting" : "Call";
  const who = req.facts?.counterpart ?? t.who ?? "the buyer";
  const close = t.close;
  const TASK: Record<Phase, { subjs: string[]; notes: string[] }> = {
    early: {
      subjs: [`${activity} — discovery`, `${activity} — first look`],
      notes: [
        `${activity} with ${who}. Walked the ${t.amt} scope and their evaluation process. Open on requirements and who signs off. Next: confirm criteria and timeline${close ? ` ahead of ${close}` : ""}.`,
        `${activity} with ${who} to walk the ${t.amt} scope and how they evaluate. Still open on who ultimately signs off. Next: pin down criteria and timeline${close ? ` ahead of ${close}` : ""}.`,
      ],
    },
    mid: {
      subjs: [`${activity} — pricing + criteria`, `${activity} — terms discussion`],
      notes: [
        `${activity} with ${who} on the ${t.amt} deal. Reviewed pricing and decision criteria; one open question on terms. Next: send the updated proposal${close ? ` before the ${close} close` : ""}.`,
        `${activity} with ${who} to cover pricing and criteria on the ${t.amt} deal. One open point on terms remains. Next: get the updated proposal over${close ? ` before the ${close} close` : ""}.`,
      ],
    },
    late: {
      subjs: [`${activity} — final terms`, `${activity} — closing details`],
      notes: [
        `${activity} with ${who}. Close to sign-off on the ${t.amt} scope; confirmed the last approval needed. Next: route paperwork${close ? ` ahead of ${close}` : ""}.`,
        `${activity} with ${who} on final terms for the ${t.amt} scope; the last approval is identified. Next: get paperwork moving${close ? ` ahead of ${close}` : ""}.`,
      ],
    },
  };
  const bucket = TASK[phaseOf(req.seq)] ?? TASK.mid!;
  const v = variantOf(req.id, bucket.notes.length);
  return { id: req.id, subject: pick(bucket.subjs, v), body: bucket.notes[v]!, provider: "static" };
}

/** The static floor for a call-recording transcript (ContentVersion VTT): a short multi-speaker
 *  call/meeting recap — or a one-paragraph summary — weaving the deal's real facts. The buyer and
 *  the AE each speak in the scenario's voice (reusing the email arc's inbound/outbound substance),
 *  so the exchange carries quotable, signal-bearing specifics. The marquee path is the LLM tier. */
function renderTranscript(req: CopyRequest, _rng: Rng): CopyResult {
  const t = tokensOf(req.facts);
  const isSummary = /\bsummary\b/i.test(req.beatIntent);
  const activity = /\bmeeting\b/i.test(req.beatIntent) ? "Meeting" : "Call";
  const who = req.facts?.counterpart ?? t.who ?? "the buyer";
  const buyer = firstName(req.speakers[0] ?? who);
  const ae = firstName(req.speakers[1] ?? "Alex");
  const beat = (ARC[req.scenario] ?? ARC["healthy-tech"]!)[phaseOf(req.seq)];
  const v = variantOf(req.id, 2);
  const buyerLine = beat.subIn(t, v); // the buyer's voice (inbound substance)
  const aeLine = beat.subOut(t, v); // the AE's voice (outbound substance)
  if (isSummary) {
    return {
      id: req.id,
      subject: `${activity} summary — ${who}`,
      body: `${activity} with ${who} on the ${t.amt} deal. ${buyerLine} ${aeLine} Next: follow up${t.close ? ` ahead of ${t.close}` : ""}.`,
      provider: "static",
    };
  }
  const body = [`${buyer}: ${buyerLine}`, `${ae}: ${aeLine}`, `${buyer}: Let me take that back to the team.`].join("\n");
  return { id: req.id, subject: `${activity} transcript — ${who}`, body, provider: "static" };
}

export class StaticCopyProvider implements CopyProvider {
  id = "static";
  deterministic = true; // pure function of the request id — the realism gate skips it (regen is identical)
  available() {
    return true;
  }
  async fill(requests: CopyRequest[], ctx: CopyFillContext): Promise<CopyFillOutput> {
    const slice = ctx.limit != null ? requests.slice(0, ctx.limit) : requests;
    const results = slice.map((req) => {
      const rng = makeRng(seedFromString(req.id));
      return req.kind === "task" ? renderTask(req, rng) : req.kind === "transcript" ? renderTranscript(req, rng) : renderEmail(req, rng);
    });
    return { results, estCostUsd: 0, budgetExhausted: false };
  }
}

export default StaticCopyProvider;
