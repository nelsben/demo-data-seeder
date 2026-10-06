# Voice

The seeder's generated copy should read like it came from a **sales rep —
or a colleague who's been watching the deal** — not a dashboard, not a
chatbot, not a corporate KPI deck. Direct, honest, warm, specific. The
Anthropic product voice is the north star.

This file governs every English string the seeder *generates* and lands in
an org: the body of an **EmailMessage** (`TextBody`), an **activity note** on
a Task (`Description`), and the spoken lines of a **call transcript**
(ContentVersion VTT). These are the artifacts a VP or CEO reads in a demo
org and an AI workflow ingests as signal — so they have to read as a real
person wrote them, not as machine fill.

> **The machine-enforced half of these rules lives in
> [`voice-lint.ts`](../../packages/engine/src/copy/voice-lint.ts)** — the
> canonical, exported deny-lists (`FORBIDDEN_PHRASES`, `CONFESSIONAL_OPENERS`,
> cross-instance/structural-uniformity thresholds) the gate runs against
> every generated string. **The realism bar + quality loop is
> [realism-playbook.md](realism-playbook.md).** This file stays the prose
> source of truth for voice; the lint is its automatable subset, the judge is
> its taste check. The "colleague who's been watching the deal" persona this
> leans on is specced in [character.md](./character.md).

---

## Principles

### Direct
Say the thing. No throat-clearing, no "I'd love to share with you
that…", no "here are some insights I've curated." Cut the framing,
keep the point. A rep's email opens on the actual ask, not a windup.

### Honest
Name what's true, including what's not going well. A real account note
says "champion went dark after the pricing pushback," not "stakeholder
engagement trended downward." Show uncertainty as plainly as certainty —
"still don't have the CFO in the room" is a real line a rep writes.

### Warm
Every line is one person talking to another doing a hard job. Use "you"
and "your team," not "the user" or "the contact." A transcript is two
humans on a call, not a system narrating a meeting.

### Specific
Numbers, names, dates. "CFO confirmed $200K cap on Tuesday" beats
"Budget signal detected from Finance contact." "Meridian Q3 Expansion"
beats "Account 12345." Specificity is the single strongest tell that a
human, not a template, wrote the line.

---

## Do / Don't pairs

These pairs are the anti-AI-slop craft. They were written for human-facing
copy and apply verbatim to every generated artifact — an email body, a
logged-call note, a line of transcript dialogue. The left column is the
machine tell; the right column is what a person actually writes.

### Framing and openers

| Don't | Do | Why |
|---|---|---|
| Based on my analysis of the available signals… | Here's where the deal stands: | Cut the preamble — no human emails this way |
| I would recommend that you consider… | I'd push the Stage 4 review to next Tuesday because… | Active voice, specific reason |
| It is worth noting that… | Heads up — | One-word callout, not meta-commentary |
| I wanted to reach out to circle back regarding… | Following up on Thursday's call. | Says what it is in five words |
| In summary, the deal is at risk. | The deal needs you this week. | Strip the meta-commentary, name the action |

### Status and assessment (in a rep's note)

| Don't | Do | Why |
|---|---|---|
| Opportunity health: AT RISK | Champion's gone quiet — needs a nudge by Friday | Action-oriented, not an alarm pill |
| Engagement trending downward | Two emails unanswered since the pricing ask | What actually happened, with a count |
| Budget signal detected from Finance | CFO confirmed the $200K cap on Tuesday's call | A person, a number, a day |
| Stakeholder alignment achieved | Got the Economic Buyer to say "this is a priority" | The literal quote beats the abstraction |

### Honesty about what isn't known

| Don't | Do | Why |
|---|---|---|
| All indicators are positive. | Still haven't met the real decision-maker. | A rep names the gap, doesn't paper over it |
| The deal is progressing well. | Quiet week. Sometimes that's a signal too. | Honest observation, not a confidence-fake |
| No concerns at this time. | One worry: Legal hasn't seen the MSA yet. | Specific risk beats a clean-bill platitude |

---

## Per-artifact voice (per copy kind)

Each generated copy kind has its own *grammar*. The shape of the artifact
determines the grammar of the voice, not the temperature — all kinds stay
direct, honest, warm, specific. Input-format contracts per kind live in
[source-variety.md](../source-variety.md); this is the voice layer on top.

| Artifact | Where it lands | Voice rule | Example |
|---|---|---|---|
| **Email body** | `EmailMessage.TextBody` (`RelatedToId` → Opp) | Two or three paragraph beats split on `\n\n`, never one wall. Acknowledge the other person's last move before proposing the next. Sign off `— {repFirstName}`. Per-persona voice — a CFO and a champion never sound alike. | *"Tom — thank you for taking point on the commercial track. I've heard clearly the proposal is above your cycle ceiling, so here's a phased option that keeps us under it…"* |
| **Activity note** | `Task.Description` (`WhatId` → Opp, `WhoId` → Contact) | The rep's terse, after-the-fact account of a call or touch. Past tense, first-person-implied, no greeting. Names the person, the move, the next step. Verb-led title. | *"Walked Nina through the HIPAA architecture. She has the Epic comparison ready and wants pricing before the 14th. Owe her the phased quote."* |
| **Call transcript** | `ContentVersion` VTT (`VersionData`; `FirstPublishLocationId` → Opp) | Spoken dialogue between named speakers — the shape Gong / Einstein Conversation Insights produces. People interrupt, hedge, trail off. The opening line is the literal first thing said, not a description of the call. | *Rep:* "Hey — I want to be straight with you. We've both gone a little quiet and I don't want that to mean we've lost momentum." |

**Universal rules across artifacts:**
- **Title** (Task) = verb-led, names the person or deal. Never a verdict,
  never a diagnosis ("Reviewed pricing with Tom," not "At-risk deal").
- **Body** = sounds like a person who was *in* the deal, not a system
  reporting on it. Exact quote + attribution as evidence, never an
  abstract paraphrase.
- **Evidence** = name a person, a number, or a date in every claim. Never
  "the data suggests." If a line can't carry a specific, it's filler — cut it.
- **Never fabricate a stakeholder name.** Use only the cast the Deal
  Dossier supplies; an invented contact is a load-time and a realism failure.

---

## First-person

A rep speaks as "I" — but it's always a *person* talking, never a model.

- ✅ "I'm pulling the last 30 emails on this — give me a sec." (a rep)
- ✅ "I think the champion went quiet after Friday's pushback."
- ❌ "I am an AI model trained by…" (never — this is the loudest tell)
- ❌ "As an AI assistant, I would recommend…" (cut it entirely)

The copy is the rep's, the colleague's, the speaker's — never the
seeder's and never an assistant's. If a line reveals the machine behind
it, it has failed.

---

## Length

A real email or note is as long as it needs to be and no longer. These are
the per-artifact targets the generator and gate hold to.

| Surface | Target |
|---|---|
| Activity note (`Task.Description`) | 1–3 sentences — a rep's terse log, not a memo |
| Verb-led task title | 3–8 words |
| Email body (`EmailMessage.TextBody`) | 2–3 short paragraph beats; lead with the point, never bury the ask |
| Email opening line | 1 sentence — the actual reason for the email |
| Transcript turn | The length a person actually speaks — fragments and interruptions are real |

If the message won't fit, the message is wrong, not the length. Cut
framing, cut hedging, cut "please note" and "I wanted to reach out."

---

## References

- Anthropic product voice — direct, honest, warm. See
  [references.md](./references.md#anthropic).
- Linear's docs and product copy — clarity at every interaction. See
  [references.md](./references.md#linear).
- "AI products that say less, mean more" — see
  [references.md](./references.md#voice-articles).
