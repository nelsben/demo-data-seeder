# Source Variety — The Artifact Shapes the Seeder Emits

> **What this file is.** The wire shapes of the *copy-bearing source artifacts* the seeder
> produces — the email thread, the rep's activity note, the call-recording transcript. These are
> the records whose prose fields the copy layer fills (provider chain anthropic → claude-code →
> static → realism gate → LLM-as-VP judge). This doc is the per-kind format contract: the field
> the body lands in, the parent it hangs off, the realism craft that makes each read human, and
> the restricted-picklist traps that red the load.
>
> **Scope.** Standard Salesforce objects only — no `__c`, no managed package. The three
> narrative-bearing artifacts are **EmailMessage**, **Task** (activity note), and
> **ContentVersion** (VTT transcript). For the full object graph + insert order see
> `CLAUDE.md` §4; for how the copy layer fills these fields see `docs/copy-layer.md`; for the
> per-deal narrative spine that decides *what* each artifact says see
> `docs/design/narrative-engine.md`.
>
> **Governing rule (no-vapor-ware).** The copy layer generates these bodies from the per-account
> Deal Dossier. If an artifact reads weak, fix the source — the prompt, the grounding fact-pack,
> the variability sample, the scenario — never hand-edit a generated body to fake quality. See
> `CLAUDE.md` §2 and `docs/design/voice.md` (mandatory before writing any copy string).

---

## 0. How an artifact is built — the empty-field + deferred-CopyRequest seam

Every copy-bearing record is generated in two passes, so generation and prose-filling stay
decoupled:

```
per-account Deal Dossier (arc + cast + beat timeline)
        │
        ▼
generator (salescloudGenerate) emits the record with its STRUCTURE filled
   — parent links, dates, picklists, participants — but the prose field EMPTY,
   plus a deferred CopyRequest describing what that body should say
        │
        ▼
fill-copy op → copy layer (anthropic → claude-code → static)
   → realism gate (lint → regenerate) → LLM-as-VP judge
        │
        ▼
record's prose field now carries human-reading copy
```

The three prose fields, by artifact:

| Artifact | Prose field | Parent link | Models |
|---|---|---|---|
| `EmailMessage` | `TextBody` | `RelatedToId` → Opportunity | the email thread (4–8 per foreground deal) |
| `Task` | `Description` | `WhatId` → Opp, `WhoId` → Contact | the rep's logged activity note; `TaskSubtype='Email'` = EAC-synced email |
| `ContentVersion` | `VersionData` (VTT) | `FirstPublishLocationId` → Opp | the call-recording transcript (Gong/Einstein-shaped) |

Only **foreground** deals (`--volume`) get the full copy treatment. Bulk/population accounts
(`--population`) are structural — realistic at scale, no copy streams. See `CLAUDE.md` §4.

**Velocity comes from timestamps.** Backdate `MessageDate` / `ActivityDate` / `CreatedDate`
across weeks so a deal's artifacts span its arc — front-load the last 14d for an accelerating
deal, cluster 14–28d ago and go quiet for a stalling one, last touch > 30d for a ghosted one.
Flat same-day timestamps make every deal read identical and kill the velocity signal.

---

## 1. EmailMessage — the email thread

**Source object:** `EmailMessage`. **Prose field:** `TextBody`. **Parent:** `RelatedToId` =
the **Opportunity** Id (mandatory — this is how the thread hangs off the deal).

### Field shape
- **`TextBody`** — the body (plain text). `HtmlBody` is an alternative; if you write HTML it
  reads as a styled mail client, but `TextBody` is the simpler default the copy layer fills.
- **`FromName`** / **`FromAddress`** — the sender display name + address. For attribution to
  resolve to a real stakeholder, `FromAddress` should match a seeded `Contact.Email`
  (lower-cased) so the email reads as *from* that person, with their `Contact.Title`.
- **`Subject`** — thread subject (`Re: Pricing proposal`, etc.); reuse across a thread.
- **`MessageDate`** — the send timestamp; backdate it (§0).
- **`Status`** = `'0'` (New) — seed as `'0'`.

### Realism craft (so it reads human, not canned)
First-name greeting + sign-off · dropped apostrophes ("Ill circle back", "whats the timeline") ·
hedges ("I hate to be the bearer of bad news") · specific numbers ("budget cut by 30%", "40%
above what we can justify", "20+ hours per week") · named third parties ("our CMIO has brought in
Epic") · real competitor names where a deal warrants it (Clari, Gong, Chorus, People.ai,
Outreach, SalesLoft). For the hero risk beat, quote full prior emails in the thread with
`To:`/`From:` headers and a bracketed `[SENT 2026-05-23 — NO REPLY]` annotation to manufacture
the champion-silence tell. Per-persona voice is non-negotiable — a CFO and a champion never sound
alike (see `docs/design/voice.md`).

### A signature block adds realism
A real email ends with a signature — append one (`\n\nBest regards,\nSarah Chen\nCFO, Acme
Corp`). It reads as a genuine sign-off and reinforces the sender's persona/title.

### Concrete shape
```
FromName     = 'Sarah Chen'
FromAddress  = 'sarah.chen@acme.example'      // ← match a seeded Contact.Email for attribution
Subject      = 'Re: Pricing proposal'
Status       = '0'
MessageDate  = 2026-06-05T14:22:00Z           // ← backdated to the deal arc
RelatedToId  = <oppId>                         // ← Opportunity Id, mandatory
TextBody     =
  Thanks for the revised numbers. The $150k year-one figure works for our FY
  budget, but I need to loop in procurement before we can sign — and our renewal
  date is tighter than I flagged on the call.

  Best regards,
  Sarah Chen
  CFO, Acme Corp
```
> **PII hygiene.** Don't seed real-looking credit-card or SSN strings into a body. The artifacts
> go in front of execs and into AI test workflows; keep generated prose free of anything that
> reads as live PII. Use `.example` domains for all addresses.

---

## 2. ContentVersion — the call-recording transcript (WebVTT)

**Source object:** `ContentVersion` (WebVTT text in `VersionData`). **Prose field:**
`VersionData`. **Parent:** `FirstPublishLocationId` = the **Opportunity** Id. This is the shape a
tool like Gong / Einstein Conversation Insights produces.

### Linking it to the Opp
`FirstPublishLocationId` is the deal context **and** the key for speaker→Contact attribution. Set
it by linking the ContentVersion to the Opp: insert the ContentVersion, then a
`ContentDocumentLink` with `LinkedEntityId = <oppId>` (or set `FirstPublishLocationId = <oppId>`
on insert).

> **Sink note.** A Salesforce-sink load needs `VersionData` base64-encoded plus the
> `ContentDocumentLink`. The file sink stores the VTT as plain text. See `CLAUDE.md` §4.

### Field shape
- **`Title`** — the *file* title, where source-system flavor lives:
  `Gong Call — Acme Discovery 2026-06-03.vtt`.
- **`VersionData`** — the WebVTT body (below).
- **`CreatedDate`** — the call timestamp; backdate it (§0).

### The WebVTT structure to write into `VersionData`
```
WEBVTT

1
00:00:01.000 --> 00:00:04.000
Sarah Chen: Good to connect — I pulled the budget numbers ahead of this call.

2
00:00:05.000 --> 00:00:18.000
Sarah Chen: The CFO confirmed the $200k budget is approved for Q2, so funding is not the blocker here.

3
00:00:19.000 --> 00:00:31.000
Tom Bradley: On our side procurement still needs to run the security review before we can sign anything.

4
00:00:32.000 --> 00:00:39.000
Tom Bradley: Realistically that pushes our go-live from Q2 into Q3 if the review slips.
```

Format rules that keep the transcript well-formed and attributable:
- **Header:** start with the `WEBVTT` line.
- **Cues:** each utterance is a numeric cue id on its own line, a
  `HH:MM:SS.mmm --> HH:MM:SS.mmm` timing line, then a `Speaker Name: utterance` content line,
  separated by a blank line.
- **Speaker → Contact attribution:** the speaker label (text before the first `:`) must contain
  the stakeholder's first / last / full name (`Sarah Chen:` or `Sarah:`), and that Contact should
  be an `OpportunityContactRole` on the Opp. Keep the speaker name on the *content* line, not the
  cue line.
- **Substance per line:** keep each kept utterance substantive (≈20+ chars of real content after
  the colon) — a stated number, a named blocker, a commitment or refusal. Thin small-talk
  ("Hi.", "Sounds good.") reads as filler and carries no signal.
- **Plain `Name: text` convention, no `<v>` voice tags.** Some real Gong/Zoom exports use
  `<v Sarah Chen>...</v>` voice tags; emit the simple `Speaker Name: utterance` convention
  instead — it's the readable, attributable shape.

### Realism craft
Speaker-labeled dialogue with hedges and filler, but every kept line carries a quotable decision
beat: a number, a blocker, a commitment. The transcript is the densest evidence surface in the
deal — it's where "the CFO confirmed the $200k cap on Tuesday" gets *said*, not summarized.

---

## 3. Task — the rep's activity note

**Source object:** `Task`. **Prose field:** `Description`. **Parent:** `WhatId` → Opportunity,
`WhoId` → Contact. This is the rep's terse, after-the-fact account of a call or email — logged
activity, not polished prose.

### Field shape
- **`Subject`** — a short verb-led title (`Email: Re: contract redline`, `Call — pricing
  pushback`). Lead with the action.
- **`Description`** — the note body; the rep's shorthand summary of what happened and what's next.
- **`WhatId`** — the Opportunity Id (the deal the activity belongs to).
- **`WhoId`** — a **Contact** Id for attribution (a Lead won't attribute to a stakeholder).
- **`ActivityDate`** — the activity date; backdate it (§0).
- **`TaskSubtype`** — `'Email'` models an EAC-synced email activity (native "Sync Email as
  Salesforce Activity"); leave default for a logged call/note.

### Restricted picklists (a wrong value fails at LOAD)
- **`Task.Status`:** `Not Started | In Progress | Completed | Waiting on someone else | Deferred`
  — **NOT** "Open". Logged-after-the-fact notes are `Completed`.
- **`Task.Priority`:** `High | Normal | Low` — Task uses **Normal**, not "Medium".

Full restricted-picklist set in `packs/salescloud/src/picklists.ts` (`SALESCLOUD_PICKLISTS`) and
`CLAUDE.md` §4.

### Realism craft
A rep's note is terse and specific, not a press release: "Mike from procurement: legal wants a
90-day opt-out, our draft has 30. Redlining. He's pushing go-live to Q3." Names, numbers, the
next step — the smart-colleague-watching-the-deal voice from `docs/design/character.md`. It reads
as something typed in 30 seconds between meetings.

### Concrete shape
```
Subject      = 'Email: Re: contract redline'
Description  = 'Mike from procurement: legal needs a 90-day opt-out, our draft has 30-day, so
                we are redlining. He pushed go-live from Q2 to Q3 if security review slips.'
Status       = 'Completed'                     // ← NOT 'Open'
Priority     = 'Normal'                         // ← NOT 'Medium'
TaskSubtype  = 'Email'                          // ← models EAC-synced email
WhatId       = <oppId>                          // ← Opportunity
WhoId        = <contactId>                       // ← a Contact, not a Lead, for attribution
ActivityDate = 2026-06-04                        // ← backdated to the deal arc
```

---

## 4. Source-system spread — weaving variety into one pipeline

A believable seller dataset weaves the three artifacts across weeks so a deal's history tells a
distinguishable story (velocity, sentiment trajectory, persona mix). Each artifact carries
source-system flavor differently:

| Artifact (§) | Carries which "source" | Where the flavor shows | Backdated timestamp field |
|---|---|---|---|
| EmailMessage (§1) | native Salesforce / EAC email | `FromName`/`FromAddress`, signature | `MessageDate` |
| Task (§3) | logged call OR EAC-synced email (`TaskSubtype='Email'`) | `Subject`, `TaskSubtype` | `ActivityDate` |
| ContentVersion (§2) | Gong / Einstein / Zoom call recording | `Title` (e.g. `Gong Call — ….vtt`) | `CreatedDate` |

Span the variability matrix across deals — 15 industries × 6 deal-size bands (`LT10K`…`GTE1M`) ×
10 stages × the 7-role buying committee (Champion, Economic Buyer, Technical Evaluator, Coach,
Skeptic, Blocker, End User), with positive→risk sentiment trajectories over time. That matrix is
`SALESCLOUD_VARIABILITY`; the deal archetypes (champion-silence at-risk deal, healthy
accelerating deal, early RFP-gated deal, stalled-portfolio, churning-account) are
`SALESCLOUD_SCENARIOS`. See `packs/salescloud/src/scenarios.ts` and `docs/narrative-design.md`.

---

## 5. Per-artifact realism checklist

Quick pre-flight so each artifact lands well-formed and reads real:

1. **Parent link set:** EmailMessage `RelatedToId` → Opp · Task `WhatId` → Opp + `WhoId` →
   Contact · ContentVersion `FirstPublishLocationId` → Opp.
2. **Attribution resolves:** the `FromAddress` / `WhoId` / VTT speaker label points at a seeded
   Contact (for transcripts, also an `OpportunityContactRole` on the Opp, with the speaker label
   containing its first/last/full name).
3. **Picklists honored:** `Task.Status` ≠ "Open" (use `Completed`); `Task.Priority` = `Normal`;
   `EmailMessage.Status` = `'0'`. (Full set: `CLAUDE.md` §4 / `picklists.ts`.)
4. **VTT well-formed:** `WEBVTT` header + numeric cue ids + `HH:MM:SS.mmm --> HH:MM:SS.mmm`
   timing + `Speaker Name: utterance` lines, each substantive (≈20+ chars post-colon), no `<v>`
   tags.
5. **Timestamps backdated** (§0) so velocity, sentiment trajectory, and "days since last touch"
   read non-trivially across the deal arc.
6. **Voice held:** per-persona, specific (numbers + names + dates), no AI slop. Read
   `docs/design/voice.md` before writing any body.
7. **No live-looking PII:** `.example` domains, no real-looking card/SSN strings in any body.

---

## 6. Where the shapes live in this repo

| File | What it owns |
|---|---|
| `packs/salescloud/src/scenarios.ts` | `SALESCLOUD_SCENARIOS` deal archetypes + `SALESCLOUD_VARIABILITY` |
| `packs/salescloud/src/picklists.ts` | `SALESCLOUD_PICKLISTS` — the restricted standard-picklist set |
| `packs/salescloud/src/generate.ts` | `salescloudGenerate` — emits records + deferred CopyRequests |
| `docs/copy-layer.md` | the provider chain + gate + judge that fill the prose fields |
| `docs/design/narrative-engine.md` | the per-account Deal Dossier spine every artifact derives from |
| `docs/design/voice.md` | the anti-AI-slop spec (mandatory before writing copy) |
| `CLAUDE.md` §4 | the full Sales Cloud object model + insert order + picklist traps |

