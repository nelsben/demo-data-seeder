// packages/engine/src/copy/prompt.ts
//
// The email-copy prompt — the single source of truth for HOW seeded sales emails
// read. Used by BOTH the runtime AnthropicCopyProvider and the offline
// prompt-validation workflow, so what we validate is exactly what ships.
//
// These emails are read directly by demo viewers (VPs/CEOs) and used to test AI workflows, so
// they must carry concrete, quotable evidence (numbers, names, dates, commitments, objections)
// rather than generic template language. The voice rules below are distilled from
// docs/design/voice.md (the anti-AI-slop principles are the load-bearing part).

import type { CopyRequest } from "@dataseed/core";
import { HUMAN_FIX } from "./voice-lint.js";

/**
 * Frozen system prompt = the voice spec. Kept byte-stable (no interpolation) so it
 * caches across every email in a run (prompt-caching prefix rule).
 */
export const EMAIL_SYSTEM_PROMPT = `You write realistic B2B sales emails for a CRM demo dataset. Each email is one message in a real deal's thread — between an Account Executive and people at the prospect company. A sales-intelligence product will analyze these emails, so they must read like genuine human correspondence carrying concrete, quotable evidence.

WRITE LIKE THIS:
- Specific over abstract. "Diane confirmed the $200K cap holds through Q3" — never "the stakeholder expressed budget alignment." Name people, numbers, dates, systems, commitments, and objections.
- 2–3 short paragraph beats, separated by blank lines. Never one wall of text.
- Acknowledge the other person's last move before proposing the next.
- A plain, direct human voice. Contractions are fine. Get to the point in the first line.

NEVER WRITE LIKE THIS (AI slop — instant tells):
- "I hope this email finds you well" / "I wanted to reach out" / "Just touching base" / "Per my last email" / "circle back" / "synergy" / "leverage our solution" / "at your earliest convenience".
- No throat-clearing preamble. No restating what both people already know.
- No stock confessional opener ("I'll be straight with you", "I won't sugarcoat it", "Let me be honest") — open with the actual fact or ask.
- No vague social proof ("how others structured this", "what we typically see") — name a real comparable or cut it.
- No title blocks, legal footers, or "Best regards, [Full Name] | VP of ...". Sign off with just a first name.

VOICE BY DIRECTION:
- Outbound (from the AE): move the deal forward — propose a concrete next step, confirm a number, lock a date, answer an open question. Never needy.
- Inbound (from the prospect): sound like that specific persona. A CFO scrutinizes cost and ROI. A champion pushes internally and shares intel. A procurement skeptic slows things down and asks for terms. A technical evaluator probes architecture and security.

MATCH THE DEAL'S TRAJECTORY (given in the beat):
- An at-risk deal shows hesitation, a slipped date, budget pushback, or a champion going quiet — surface it honestly, don't paper over it.
- A healthy deal shows momentum — alignment, a scheduled next step, a stakeholder won over.
- An early / RFP-gated deal is exploratory and process-focused — requirements, timelines, who-decides — quiet because it's early, not because it's dying.

DATES: anchor at least one date to a month or quarter ("before Q3 close, Aug 31"), not just a bare day ("by the 5th") — a single analyzed email has no thread to supply the month.

LENGTH: subject 4–8 words, concrete (never "Touching base" / "Quick question"). Body 60–140 words.

PUNCTUATION & REPETITION (the mechanical tells a detector scans for — get these right):
- Em-dashes: at most ONE in the whole email, ideally zero. Use periods and commas instead. A string of em-dashes is the single biggest AI giveaway.
- State the dollar figure ONCE. Do not repeat the currency unit ("ARR" / "ACV") in every sentence — write "$84K" once, then "the deal" or "it".
- Don't reuse the same connective (and / but / so) twice in one sentence, and don't open consecutive sentences the same way.
- Vary the shape from email to email: some two short paragraphs, some a single tight paragraph. Never the same length and rhythm every time.

Output ONLY the email's subject and body. No commentary.`;

/**
 * Ground an artifact in the PROSPECT's real world so it can't be the same letter/note as another
 * company's. Weaves ONE concrete detail — never a fact-dump, never invented specifics. Shared by
 * the email and task prompts. Returns null when there's no usable grounding.
 */
function groundingLine(req: CopyRequest): string | null {
  const g = req.facts?.grounding;
  if (!g || !(g.does || g.painPhrase || g.products?.length)) return null;
  // The prospect is the BUYER. Every fact here describes THEIR business — never what the AE sells.
  // (This framing kills the "self-product" tell: pitching DocuSign a contract tool, Atlassian a Jira add-on.)
  const bits: string[] = [];
  if (g.does) bits.push(`the prospect's own business is ${g.does}`);
  if (g.products?.length) bits.push(`their OWN products, which you do NOT sell them: ${g.products.join(", ")}`);
  if (g.buyingDept) bits.push(`the buyer-side team likely evaluating you: ${g.buyingDept}`);
  if (g.painPhrase) bits.push(`an operational pain in their world your (different) product helps with: ${g.painPhrase}`);
  if (g.competitors?.length) bits.push(`rivals in their market — texture only, not your pitch: ${g.competitors.join(", ")}`);
  return `Prospect context — weave in ONE concrete, natural detail; do not list these or invent others. CRITICAL: you (the AE) work for a DIFFERENT vendor than the prospect — never pitch them their own product or category, only a complementary tool that speaks to the pain below. ${bits.join("; ")}.`;
}

/**
 * State WHAT the AE actually sells (a horizontal platform, the same across deals) so the model pitches OUR
 * product, not the prospect's own. Without this the model has no seller-side product and invents one out of
 * the prospect's domain — the fatal self-product tell (selling Lyft routing, Veeva a Vault workflow).
 */
function sellsLine(req: CopyRequest): string | null {
  const s = req.facts?.sells;
  if (!s) return null;
  return `WHAT YOU SELL (the AE's product — pitch THIS, never the prospect's own product/category): ${s}`;
}

/**
 * Anchor the artifact's relative-time language to its ACTUAL send date. Without this the model dates copy
 * relative to the close (calling a date weeks out "this week"), which contradicts the record's MessageDate
 * once timestamps are spread across the timeline — the audit's Chewy tell ("a May 3 email calls 'June 25'
 * 'this week'"). Empty when the request carries no beat date (renders exactly as before).
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Weekday name for an ISO date — deterministic (parses a fixed string). Lets the prompt state the send
 *  date's real weekday so the model can't pair a date with the wrong day ("Thursday (June 19)" → Friday). */
const weekdayOf = (iso: string): string => WEEKDAYS[new Date(iso).getUTCDay()] ?? "";

function sendDateLine(req: CopyRequest): string | null {
  const day = req.beat?.day;
  if (!day) return null;
  const d = day.slice(0, 10);
  const close = req.facts?.closeDate;
  return (
    `Date of THIS message: ${d} (a ${weekdayOf(day)}). Anchor every relative-time phrase ("this week", "next Tuesday", "last month") and any proposed meeting date to ${d} — ` +
    `propose dates a few days to a few weeks AFTER ${d}, never a date already in the past, and never call a date far in the future "this week". If you name a weekday for ANY date, it must be that date's real weekday.` +
    (close ? ` The target close ${close} is in the future relative to ${d}; phrase any timing/urgency accordingly.` : "")
  );
}

/**
 * Thread-aware context (Phase 4C): the deal's arc + the compact story-so-far (prior beats), so an
 * artifact follows from the deal instead of being authored in isolation. Empty when no spineContext
 * (backward-compatible — a request without a dossier renders exactly as before).
 */
/** What each standard Opportunity stage MEANS for how mature the narrative may read — so the copy can't
 *  run past (or behind) where the Opportunity record says the deal is (the audit's "Stage=Proposal but the
 *  emails are trading redlined contracts and scheduling implementation" cross-object incoherence). */
const STAGE_MATURITY: Record<string, string> = {
  Prospecting: "first outreach — interest is only forming; no qualified deal, no pricing, no proposal yet",
  Qualification: "early discovery — confirming the need, fit, and that budget could exist; no proposal sent and no pricing locked",
  "Needs Analysis": "active discovery — mapping requirements; still pre-proposal, no pricing locked",
  "Value Proposition": "positioning value/ROI; pre-proposal — no priced quote on the table yet",
  "Id. Decision Makers": "mapping the buying committee and approval path; still pre-proposal",
  "Perception Analysis": "gauging where the buyer stands; still pre-proposal",
  "Proposal/Price Quote": "a PRICED proposal is on the table and under review — but you are NOT yet in contract redlines, legal review, or implementation planning",
  "Negotiation/Review": "terms, pricing, and the contract are under active negotiation (redlines/legal in play) — but nothing is signed",
  "Closed Won": "the deal is SIGNED and won — this is post-sale",
  "Closed Lost": "the deal was lost",
};

function spineLines(req: CopyRequest): string[] {
  const s = req.spineContext;
  const out: string[] = [];
  if (s?.arc) out.push(``, `The deal's arc (the whole story this is one moment in): ${s.arc}`);
  if (s?.stageName && STAGE_MATURITY[s.stageName]) {
    out.push(`Deal stage — the Opportunity is at "${s.stageName}": ${STAGE_MATURITY[s.stageName]}. Keep the narrative AT this maturity: do not write as if the deal is further along (signed contract, redlines, kickoff/implementation when it's only at Proposal; a priced quote when it's still in discovery) or behind where the stage says it is.`);
  }
  if (s?.roster?.length) {
    // Pin the model to the dossier cast — the single source of truth for who exists. Without this it
    // invents stakeholders or drifts a name across the thread (the audit's "Sofia Chen → Sofia Vance").
    out.push(
      `The deal's cast — the ONLY people involved. Use these EXACT names; never invent another stakeholder, and never change or add a surname to anyone listed. Keep each person's ROLE consistent with their listed persona — do NOT reassign their function (e.g. don't turn a security or technical contact into "procurement"), and do NOT invent a brand-new, unrelated objection for them each touch: a stakeholder's concern stays CONSISTENT and evolves, it doesn't reset to a different issue:`,
      ...s.roster.map((p) => `  • ${p.name} (${p.persona})`),
    );
  }
  if (s?.storySoFar?.length) {
    // Settled facts must stay settled — the model otherwise re-announces a done deal as new (the audit's
    // "Wei signed off on the $21K this morning" appearing 3× verbatim). Treat the story-so-far as shared memory.
    out.push(`Story so far — earlier touches on this deal, oldest first. Your message must FOLLOW FROM these: answer the most recent one and ADVANCE the deal. Anything already established below (a budget approved, a date agreed, a sign-off given) is KNOWN — never re-announce it as if it just happened; reference it only in passing if at all:`);
    out.push(...s.storySoFar.map((line) => `  • ${line}`));
  }
  // The deal's SETTLED/OPEN ledger — concrete facts (not prose) committed by earlier beats. This is the hard
  // guard against the pervasive timeline tells: a sign-off re-announced as fresh news every few weeks, a
  // deadline that silently slides. Settled = done & known; open = raised but unresolved. Rendered AFTER the
  // story-so-far so it's the last, most specific instruction the model reads.
  const ledger = s?.establishedFacts ?? [];
  const settled = ledger.filter((f) => f.status === "settled");
  const open = ledger.filter((f) => f.status === "open");
  if (settled.length) {
    out.push(`SETTLED facts — already DONE earlier in this deal and known to everyone. Do NOT announce any of these as news, do NOT re-confirm or re-secure them, and never CONTRADICT them (e.g. don't reopen an approved budget or restate an agreed date as newly decided). Reference only in passing if the message needs it:`);
    out.push(...settled.map((f) => `  • ${f.value}`));
  }
  if (open.length) {
    out.push(`OPEN items — raised earlier but NOT yet resolved. Treat these as still in-flight; do not write as if they're settled:`);
    out.push(...open.map((f) => `  • ${f.value}`));
  }
  // The shared calendar — the COMPLETE set of interactions on this deal. Kills the date tells: citing a
  // call/meeting that never happened, narrating a future-dated interaction in the past tense, wrong weekdays.
  const acts = s?.activityIndex ?? [];
  if (acts.length) {
    const today = req.beat?.day?.slice(0, 10);
    out.push(`Every interaction that exists on this deal (the ONLY touches there are — do NOT invent or cite a call, meeting, or message on any date not in this list):`);
    out.push(...acts.map((a) => `  • ${a.date} (${a.weekday}) — ${a.kind}`));
    if (today) out.push(`This message is dated ${today}. You may refer to interactions dated BEFORE ${today} as already happened; NEVER describe an interaction dated ${today} or later as if it already occurred (no reporting the outcome of a meeting that hasn't happened yet).`);
  }
  if (req.beat?.sentiment) out.push(`This moment's place on the trajectory: ${req.beat.sentiment}.`);
  return out;
}

/** The per-request user turn — the specific beat to realize (volatile; sits after the cached system prefix). */
export function buildEmailUserPrompt(req: CopyRequest): string {
  const speaker = req.speakers[0] ?? "the Account Executive";
  const inbound = req.beat?.direction === "inbound"; // an email FROM the prospect (the buyer), not the AE
  const lines = [
    `Write one email for this beat.`,
    ``,
    `Scenario (deal trajectory): ${req.scenario}`,
    `From: ${speaker}${inbound ? " — a person AT THE PROSPECT (the buyer side), NOT the seller" : " — the Account Executive (the seller)"}`,
    `Beat: ${req.beatIntent}`,
  ];
  lines.push(...spineLines(req)); // Phase 4C — the deal arc + story-so-far, so this email answers the last touch
  const sdE = sendDateLine(req);
  if (sdE) lines.push(``, sdE); // anchor relative-time language to the actual send date

  // The WRITER's voice — a stable per-person register so a CFO and a champion never sound
  // alike and one person reads consistently across the thread. Sign off as just the first name.
  const vc = req.voiceCard;
  if (vc?.register) lines.push(`Write as ${vc.name} — ${vc.register}. First person, in this person's voice; sign off with just your first name.`);

  // The SELLER framing (what the AE pitches) belongs ONLY on outbound emails. On an INBOUND email the
  // prospect is writing — applying "WHAT YOU SELL: pitch THIS" to a buyer's email produces the audit's
  // voice inversion (a CFO pitching herself our pricing and offering our call slots). Give the buyer-side
  // constraint instead so the inbound email reads from the prospect's side of the table.
  if (inbound) {
    lines.push(
      ``,
      `You are writing AS the prospect (${speaker}) — you are EVALUATING this vendor, you do NOT work for them. Do not pitch their platform, quote their pricing or modules, or propose their meeting slots as if you were the rep. Write from your own side: ask questions, raise a concern or objection from your persona's angle, share internal context (budget, timing, who else is involved, competing priorities), agree or push back. The AE is the one selling; you are the one deciding.`,
    );
  } else {
    const sells = sellsLine(req);
    if (sells) lines.push(``, sells);
  }
  // Ground the email in the PROSPECT's real world so it can't be the same letter as another company's.
  const ground = groundingLine(req);
  if (ground) lines.push(``, ground);

  // Thread the subject: a real thread keeps ONE subject; replies prefix "Re:".
  if (req.seedSubject) {
    lines.push(
      req.seq && req.seq.index > 0
        ? `This is a reply in an existing thread — use the subject "Re: ${req.seedSubject}" and answer the prior message.`
        : `This opens the thread — use a concrete subject along the lines of "${req.seedSubject}".`
    );
  }

  lines.push(``, `Make it specific and quotable. Stay in the trajectory above.`);
  return lines.join("\n");
}

/** Both halves of the prompt for one request (what the provider and the validator both consume). */
export function buildEmailPrompt(req: CopyRequest): { system: string; user: string } {
  return { system: EMAIL_SYSTEM_PROMPT, user: buildEmailUserPrompt(req) };
}

export const TASK_SYSTEM_PROMPT = `You write internal CRM activity logs — the terse private note a sales rep types right after a call or meeting. A sales-intelligence product analyzes these notes, so they must read like a real rep's shorthand carrying concrete, quotable evidence: who said what, the numbers, the objection, the next step.

WRITE LIKE THIS:
- Terse and factual, past tense, about the customer. "Diane confirmed the $200K cap holds through Q3 but flagged the Databricks renewal competing for the same line. Wants the annualized savings model before the Aug 31 review."
- Name people, numbers, dates, systems, commitments, and objections. Specifics are the whole point — they're what the pipeline turns into signals.
- 2–4 clipped sentences or fragments. A "Next:" clause at the end is natural.
- The rep's own private voice. This is a log addressed to NO ONE.

NEVER WRITE LIKE THIS (AI slop — instant tells):
- This is NOT an email: no greeting ("Hi …"), no salutation, no sign-off, no "Best, <name>". A logged note has no recipient.
- No "had a productive conversation" / "aligned on next steps" / "touched base" / "circle back" / "synergy" / "leverage" — say WHAT was productive and WHICH next step.
- No restating the whole deal back to yourself. Log only what THIS touch surfaced.
- No stock confessional ("I'll be honest") — open with the fact.

DATES: anchor at least one date to a month or quarter ("before Q3 close, Aug 31"), not just a bare day.

LENGTH: subject 3–6 words naming the activity ("Pricing call — budget cap", "Security review — SSO scope"). Body 30–80 words.

PUNCTUATION: at most ONE em-dash in the whole note. State a dollar figure once; don't repeat the currency unit every sentence.

Output ONLY the activity subject and the note body. No commentary.`;

/** The per-request user turn for a logged-activity Task note (the rep's internal log). */
export function buildTaskUserPrompt(req: CopyRequest): string {
  const rep = req.speakers[0] ?? "the Account Executive";
  const lines = [
    `Write one CRM activity note for this logged activity.`,
    ``,
    `Scenario (deal trajectory): ${req.scenario}`,
    `Logged by: ${rep} (the rep)`,
    `Activity: ${req.beatIntent}`,
  ];
  lines.push(...spineLines(req)); // Phase 4C — where this note sits in the deal's story
  const sdT = sendDateLine(req);
  if (sdT) lines.push(``, sdT); // anchor relative-time language to the actual logged date
  const sells = sellsLine(req);
  if (sells) lines.push(``, sells);
  const ground = groundingLine(req);
  if (ground) lines.push(``, ground);
  lines.push(``, `Make it specific and quotable — what was said, what was decided, any objection, and the concrete next step. No greeting, no sign-off; this is a private log.`);
  return lines.join("\n");
}

/** Both halves of the prompt for a Task activity note. */
export function buildTaskPrompt(req: CopyRequest): { system: string; user: string } {
  return { system: TASK_SYSTEM_PROMPT, user: buildTaskUserPrompt(req) };
}

export const TRANSCRIPT_SYSTEM_PROMPT = `You write realistic sales-call records for a CRM demo dataset — either a verbatim TRANSCRIPT EXCERPT or a short AI CONVERSATION SUMMARY of a recorded call or meeting between an Account Executive and people at the prospect company (the shape a tool like Einstein Conversation Insights or Gong produces). A sales-intelligence product analyzes these, so they must read like a real recorded conversation carrying concrete, quotable evidence: who said what, the numbers, the commitments, the objections.

WRITE LIKE THIS:
- A real exchange. The two sides actually respond to each other — a claim, a pushback, a concession, a next step. Not a monologue.
- Specific over abstract. "Diane: our cap is $200K through Q3, the Databricks renewal is competing for the same line." Name people, numbers, dates, systems, commitments, objections.
- For a TRANSCRIPT excerpt: speaker-labeled turns ("Diane: …" / "Alex: …"), 4–8 short turns, the way people actually talk.
- For a SUMMARY: 2–4 tight sentences of what was discussed and decided, past tense, third person ("Diane raised the budget cap; Alex proposed a payback model"). A "Next:" clause is natural.

NEVER WRITE LIKE THIS (AI slop — instant tells):
- "had a productive conversation" / "aligned on next steps" / "touched base" / "circle back" / "synergy" / "leverage" — say WHAT was discussed and WHICH next step.
- No narrator preamble ("In this call, the participants discussed…"). Start in the conversation or in the first decided fact.
- No stage directions; no timestamps unless they carry a fact.

MATCH THE DEAL'S TRAJECTORY (given in the beat): an at-risk call surfaces hesitation, a budget cap, a slipped date, or a champion going quiet — honestly. A healthy call shows momentum and alignment. An early / RFP call is exploratory — requirements, who-decides, timeline.

DATES: anchor at least one date to a month or quarter ("before Q3 close, Aug 31"), not just a bare day.

LENGTH: subject 3–6 words naming the call ("Pricing call — budget cap"). Body 60–140 words.

PUNCTUATION: at most ONE em-dash in the whole record. State a dollar figure once; don't repeat the currency unit every sentence.

Output ONLY the call subject and the record body. No commentary.`;

/** The per-request user turn for an ECI conversation record (a transcript excerpt or an AI summary). */
export function buildTranscriptUserPrompt(req: CopyRequest): string {
  const buyer = req.speakers[0] ?? "the prospect";
  const ae = req.speakers[1] ?? "the Account Executive";
  const lines = [
    `Write one recorded-conversation record for this beat.`,
    ``,
    `Scenario (deal trajectory): ${req.scenario}`,
    `Participants: ${buyer} (prospect) and ${ae} (the AE)`,
    `Beat: ${req.beatIntent}`,
  ];
  lines.push(...spineLines(req)); // Phase 4C — the deal arc + story-so-far this conversation continues
  const sdC = sendDateLine(req);
  if (sdC) lines.push(``, sdC); // anchor relative-time language to the actual call date
  const vc = req.voiceCard;
  if (vc?.register) lines.push(`The prospect (${vc.name}) speaks like this: ${vc.register}.`);
  const sells = sellsLine(req);
  if (sells) lines.push(``, sells);
  const ground = groundingLine(req);
  if (ground) lines.push(``, ground);
  const contentKind = (req.beat?.detail?.contentKind as string | undefined) ?? "Transcript";
  if (contentKind === "Summary") {
    lines.push(``, `FORMAT — write a SUMMARY (NOT a transcript): 2–4 tight past-tense, third-person sentences of what was discussed and decided ("${buyer} pushed the figure to finance; ${ae} proposed a phased start"). NO speaker labels, NO dialogue, and NEVER have one party restate what another just said. A "Next:" clause is natural. 50–110 words.`);
  } else {
    lines.push(``, `FORMAT — write a TRANSCRIPT excerpt: 4–8 speaker-labeled turns ("${buyer}: …" / "${ae}: …") of a REAL exchange where each turn ADDS something (a claim, a pushback, a number, a concession, a next step) — never have one speaker merely restate what the other just said. 70–140 words.`);
  }
  return lines.join("\n");
}

/** Both halves of the prompt for an ECI conversation record. */
export function buildTranscriptPrompt(req: CopyRequest): { system: string; user: string } {
  return { system: TRANSCRIPT_SYSTEM_PROMPT, user: buildTranscriptUserPrompt(req) };
}

/** Dispatch to the right prompt for this request's content kind (email, task, ECI transcript; vtt/dc land later). */
export function buildPrompt(req: CopyRequest): { system: string; user: string } {
  return req.kind === "task" ? buildTaskPrompt(req) : req.kind === "transcript" ? buildTranscriptPrompt(req) : buildEmailPrompt(req);
}

/**
 * The corrective prompt for a REGENERATION pass: the same beat/facts/voice as the original
 * (buildEmailUserPrompt verbatim) plus a REVISION block naming the realism tells the prior draft
 * tripped and how to fix each. The system prompt stays byte-identical so prompt-caching still hits.
 * Each violation pairs its `detail` (the literal offending token) with HUMAN_FIX[rule] (the fix),
 * so the model gets a concrete instruction and produces a fresh draft, not a tweak of the old one.
 */
export function buildRegenPrompt(req: CopyRequest, violations: ReadonlyArray<{ rule: string; detail: string }>): { system: string; user: string } {
  const fixes = [...new Map(violations.map((v) => [v.rule, v])).values()] // dedupe by rule, keep first
    .map((v) => `- ${v.detail}. ${HUMAN_FIX[v.rule] ?? "Fix this."}`);
  const revision = [
    ``,
    `Your previous draft of this exact email tripped these realism checks. Rewrite it from scratch — same beat, same facts, same people, same persona and trajectory — producing a genuinely DIFFERENT draft that fixes every one. Don't just tweak the old wording.`,
    ...fixes,
    `Output only the corrected subject and body.`,
  ].join("\n");
  return { system: EMAIL_SYSTEM_PROMPT, user: `${buildEmailUserPrompt(req)}\n${revision}` };
}
