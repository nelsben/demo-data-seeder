# Narrative Design — how to make seed data tell real stories

This is the craft doc for the `demo-data-seeder`. It governs **what stories
the seed data tells** and **how to write the human copy** that makes those
stories land — so that a populated Salesforce org reads as a real company's
pipeline (a champion-silence at-risk deal, a mostly-green accelerating deal,
an early-but-quiet RFP deal) rather than uniform AI mush.

The repo's sibling docs cover mechanics: the object/field map and load order
(`docs/object-audit.md`, `docs/load-and-validate.md`), the engine
architecture (`docs/app-architecture.md`), the copy provider chain
(`docs/copy-layer.md`), and the canonical orientation (`CLAUDE.md`).
**This doc is the brain.** It answers: *which* records to create, *how
varied* they must be, *what each archetype's signal pattern is*, and *how to
write copy that doesn't read as AI slop.*

> **The governing law (no vapor-ware).** Realism comes from **real
> generation**, not hand-authored outputs. The pipeline — anchors →
> variability matrix → per-account Deal Dossier spine → deferred
> `CopyRequest`s → the LLM copy layer → realism gate → LLM-as-VP judge —
> produces the data. Demo magic = choosing *which* records exist, *which*
> scenarios, *which* anchors. Fabrication = hand-editing a generated record's
> prose to fake quality. The first is allowed; the second is forbidden. If
> the output is weak, fix the **source** (the prompt, the grounding
> fact-pack, the variability matrix, the scenario design) — never hand-edit
> the artifact. (`feedback_no_vapor_ware`; canonical statement in
> `CLAUDE.md §2`.)

---

## 0. The pipeline this data feeds (the one-paragraph mental model)

`generate()` (pack `salescloud`, `salescloudGenerate`) reads each account's
**variability traits** + its **scenario profile** and builds a per-account
**Deal Dossier** (arc + cast + beat timeline) — the single spine every object
derives from, so one tight story is told across emails, tasks, and
transcripts. Records land with their copy fields **empty**; for every body
the generator emits a deferred `CopyRequest` (`kind ∈ {email, task,
transcript}`) into the bundle. The copy layer then fills those requests
through the provider chain **anthropic → claude-code → static** (no Einstein
routing), each filled body passes a realism **gate** (voice-lint →
regenerate), and an **LLM-as-VP judge** scores believability. The seeder's
job is to make the **structure + grounding** rich and varied enough that the
copy layer has something real to write about. (Full seam:
`docs/app-architecture.md`; copy chain: `docs/copy-layer.md`.)

The narrative quality lives in the **dossier beats** and the **copy that
fills them** — the email thread on the Opp, the rep's terse Task notes, the
call-recording transcript. Everything in this doc serves that.

---

## 1. The variability matrix — what a believable pipeline must span

A realistic seller dataset is **not random rows**. It spans the dimensions
below so the *emergent* read of each deal (velocity, sentiment trajectory,
persona mix, band cohort) tells distinguishable stories. Get one dimension
flat and the demo collapses (e.g. all-same-day timestamps → every deal reads
"Steady," the predictive punch is gone). The pools live in
`packs/salescloud/src/variability.ts` (`SALESCLOUD_VARIABILITY`,
`SCENARIO_PROFILES`) and `picklists.ts` (`SALESCLOUD_PICKLISTS`).

### 1.1 Industry / vertical (15 values)

`Technology, Healthcare, Financial Services, Manufacturing, Retail,
Energy, Education, Government, Telecommunications, Logistics, Hospitality,
Aerospace, Pharmaceuticals, Insurance, Construction.`

Vertical drives **plausible pain** and **which competitor shows up**:

| Vertical | Authentic pain hooks | Plausible blocker / competitor |
|---|---|---|
| Healthcare | HIPAA validation, EHR/Epic integration, physician training windows, CMIO sign-off | Epic clinical-decision-support eval; residency-training go-live deadline |
| Financial Services | SOC2, audit trail, compliance automation, regulator deadlines | RFP procurement gate; security review |
| Manufacturing | ERP migration, plant-floor downtime cost, shift-change reporting | Legacy-vendor switching cost |
| Technology | API/integration timeline, data-warehouse scale, POC benchmarks | Build-vs-buy; a named rev-intel competitor |
| Government | Procurement cycle, FedRAMP, fiscal-year-end use-it-or-lose-it budget | Multi-bid mandate |

A foreground deal leans *hard* on vertical authenticity (e.g. a Healthcare
deal naming the HIPAA gate, an Epic competitor, a CMIO title, a July
physician-residency training window) — that specificity is what makes it
land. **Rule:** a vertical's pain must be nameable by someone in that
industry, or it reads generic. (Anchors + grounding fact-packs:
`packs/salescloud/src/anchors.ts`, `grounding.ts`.)

### 1.2 Deal-size bands (six fixed Amount bands)

The cohort grain is six fixed Amount bands (`SALESCLOUD_VARIABILITY.dealSizeBand`
+ `BAND_RANGE` in `variability.ts`), contiguous and exclusive-on-ceiling —
every non-negative amount maps to exactly one:

| code | label | floor (inclusive) | ceiling (exclusive) |
|---|---|---|---|
| `LT10K` | Under $10K | 0 | 10000 |
| `10K_50K` | $10K–$50K | 10000 | 50000 |
| `50K_100K` | $50K–$100K | 50000 | 100000 |
| `100K_250K` | $100K–$250K | 100000 | 250000 |
| `250K_1M` | $250K–$1M | 250000 | 1000000 |
| `GTE1M` | $1M+ | 1000000 | (open) |

The default weights tilt toward mid-market (`50K_100K` / `100K_250K`) but
**every band is represented** — and you should **seed multiple deals into the
*same* band**, especially as **Closed-Won**, so a "this deal vs your
comparable closed-wons" pacing read has a cohort to compute against. A flat
single deal per band reads as a toy dataset.

### 1.3 Stage distribution (10 standard SF stages)

`Prospecting, Qualification, Needs Analysis, Value Proposition, Id. Decision
Makers, Perception Analysis, Proposal/Price Quote, Negotiation/Review, Closed
Won, Closed Lost` (`STAGES` in `variability.ts`).

Each scenario profile pins its candidate **open** stages (`generate` picks
one via the unit RNG), and the generator splits closed deals ~50/50 between
Closed Won and Closed Lost:

| scenario | candidate open stages |
|---|---|
| `at-risk-budget` | Negotiation/Review · Proposal/Price Quote |
| `healthy-tech` | Proposal/Price Quote · Negotiation/Review · Value Proposition |
| `rfp-gated` | Qualification · Needs Analysis |
| `stalled-portfolio` | Negotiation/Review · Perception Analysis |
| `churning-account` | Closed Lost · Negotiation/Review |

**CRITICAL coherence rule:** stage must agree with signal density and
sentiment. A `Negotiation/Review` deal with a silent champion is the at-risk
story; a `Qualification` deal with two light touches is correctly
"early/quiet," NOT "at risk." A `Prospecting` deal carrying a full risk-laden
thread is incoherent — the demo viewer will feel the wrongness even if they
can't name it.

### 1.4 The 7 buying personas (the buying committee)

The buying-committee enum is **exactly** (`PERSONAS` in `picklists.ts`):

`Champion, Economic Buyer, Technical Evaluator, Coach, Skeptic, Blocker, End
User.`

A realistic deal has a **mix**, never all-Champions — the mix is what lets a
reader reason about *who* to engage, not just *what*. Each scenario profile
pins an ordered persona list (truncated to that deal's `contactRange`); the
personas become Contacts, with the primary one wired as the
`OpportunityContactRole` the transcript speaker-matches against:

| scenario | persona mix (ordered) |
|---|---|
| `at-risk-budget` | Champion · Economic Buyer · Skeptic · Technical Evaluator |
| `healthy-tech` | Champion · Economic Buyer · Technical Evaluator · Coach |
| `rfp-gated` | Technical Evaluator · Coach · End User |
| `stalled-portfolio` | Champion · Economic Buyer · Blocker |
| `churning-account` | Economic Buyer · Skeptic · Blocker |

> Note: the **`OpportunityContactRole.Role`** picklist (standard set:
> Economic Buyer, Technical Buyer, Business User, Evaluator, Influencer,
> Executive Sponsor — `BULK_OCR_ROLES`) is a *different*, narrower vocabulary
> than the 7-persona committee above. Persona = the narrative archetype the
> dossier reasons with; OCR Role = the load-safe standard-picklist value that
> lands on the record. Don't conflate them.

Give personas distinct **voice and cadence** (a CFO and a champion never
sound alike; see §3) and a plausible responsiveness (an Economic Buyer
replies slower than a Champion). Per-persona voice is a realism lever, not
decoration.

### 1.5 Sentiment arcs (a trajectory, not a static blend)

The compelling craft is a **trajectory across time**, not a static blend.
An at-risk deal's champion shows a *tone shift*: early "warm email asking
about timeline" → mid "I'm now being asked to evaluate multiple options" →
then a multi-week silence. **Order the email/task beats chronologically so a
deal degrades (or strengthens) over weeks** — because velocity reads off
cadence over time windows (§1.7), and the copy layer keys each body's tone to
the beat's position in the arc. Positive → risk over time is the spine of the
at-risk story; the reverse (warming) is the healthy story.

### 1.6 Win / loss outcomes

Both `Closed Won` and `Closed Lost` must be present (the generator splits
closed deals ~50/50). They are narrative *fuel*, not noise:

- **Closed-Won in the same band** → the cohort that powers a pacing read
  ("this deal vs your comparable closed-wons").
- **Closed-Lost** → the churn/health leading indicator and the "what a
  stalled deal looks like at the end" comparison.
- Some accounts carry a **prior closed-won Opp** (`priorWin` in the scenario
  profile) so the account has real cross-deal history (`healthy-tech` =
  expansion on a prior land; `churning-account` = a renewal now at risk).
  The prior win has no email/task streams — it's historical context, nothing
  new to narrate.

### 1.7 Deal velocity (emergent — backdate to manufacture it)

Velocity is **NOT a stored field.** It is the read you get from the cadence
of the dated activity (EmailMessage / Task / ContentVersion) on a deal — the
density in the recent window vs the prior window:

- `recent` = touches in roughly the last 14 days
- `prior` = touches in the 28–14d window
- `daysSinceLastTouch` = days since the most recent dated activity

The shapes the scenario profiles drive (`SentimentShape` in `variability.ts`):

```
Dark / ghosted = last touch > 30 days ago (or none)
Accelerating   = prior > 0 AND recent > prior
Stalling       = prior > 0 AND recent < prior * 0.5
Steady         = otherwise
```

**To manufacture velocity you MUST backdate the activity timestamps** —
`EmailMessage.MessageDate`, `Task.ActivityDate` / `CreatedDate`,
`ContentVersion.CreatedDate` — into the past:

| Target shape | Activity placement |
|---|---|
| **accelerating** | Front-load: most touches in the last 14 days, fewer in 28–14d |
| **stalling** | Cluster touches 14–28 days ago, ≤ half as many in the last 14d |
| **dark / ghosted** | Last touch > 30 days ago (or none) |
| **steady** | Even cadence across both windows |

**Flat same-day timestamps make every deal read "Steady/recent" — the demo
loses its predictive punch.** Dates are also spread over ~3 years across the
whole dataset (CloseDate, prior wins) so the org shows realistic velocity
*history*, not a single cohort created yesterday.

### 1.8 Multi-touch interaction timelines (email + call + note over weeks)

A realistic deal weaves source types over weeks. The narrative-bearing
records and where their copy lands (canonical map in `CLAUDE.md §4`,
`docs/source-variety.md`):

| Source record | Lookup to the deal | Copy field (filled by the copy layer) |
|---|---|---|
| `EmailMessage` | `RelatedToId` → Opp | `TextBody` (the email thread, 4–8 per foreground deal) |
| `Task` (logged call / activity note) | `WhatId` → Opp, `WhoId` → Contact | `Description` (terse rep account; `TaskSubtype='Email'` models EAC-synced email) |
| `ContentVersion` (VTT transcript) | `FirstPublishLocationId` → Opp | `VersionData` (the call-recording transcript; see §3.3) |

Cadence over weeks is what the velocity windows and "days since last touch"
reads consume. The generator spreads `EmailMessage.MessageDate` over the past
weeks and creates the per-scenario email + task counts (`emailRange` /
`taskRange`); add a transcript so a single deal shows
email→call→transcript→email texture rather than one channel.

---

## 2. Deal archetypes — the signal pattern each produces

These are the five named, parameterized arcs (`SALESCLOUD_SCENARIOS` in
`scenarios.ts`; per-arc knobs in `SCENARIO_PROFILES`). Each is defined by the
**structural signal pattern** its dossier lays down — so the recipe is "seed
this shape, and the copy layer writes the story." The shapes are generic B2B
deal-health/sentiment patterns; no methodology vocabulary is baked in.

### ARCHETYPE 1 — `at-risk-budget`: the champion-silence / contested-budget deal (the HERO)

**Profile:** late stage (`Negotiation/Review` / `Proposal/Price Quote`),
**stalling** velocity, 5–7 emails + 2–3 tasks, personas Champion · Economic
Buyer · Skeptic · Technical Evaluator. The sizzle-demo "gut punch" anchor —
best seeded in the `GTE1M` band, Healthcare/Financial Services. The dossier
lays down a risk-leaning beat per dimension so the read is honestly grim:

| Dimension | Beat | Sentiment |
|---|---|---|
| Champion | Gone dark ~21 days; tone shift; "pulled into a competing evaluation committee" | Risk |
| Competition | An active competitor eval (named, vertical-plausible); dedicated committee; demo scheduled | Risk |
| Budget / metrics | Proposal ~40% over the procurement ceiling; CFO scrutiny | Negative |
| Economic buyer | An unidentified Finance approver surfaces late with veto power, never engaged | Risk |
| Decision criteria | A validation / integration review left open, used as a stall | Negative |
| Decision process | The buying committee can't convene until the competing eval concludes; 2wk → 6wk slip | Risk |
| Timeline / pain | A go-live slipped a quarter; a hard external window closing | Negative |

Each beat needs: a risk/negative tone, a concrete next-action hook (a named
gap + a named person), and a **quotable line with attribution + date** the
copy layer can surface as evidence. **Velocity:** stalling/dark (cluster the
touches 14–28d ago, champion last touch > 21d). **Produces:** a thread that
degrades over weeks, a re-engage-the-champion hero email, terse "deal's gone
quiet" rep notes.

### ARCHETYPE 2 — `healthy-tech`: the accelerating winning deal

**Profile:** `Proposal/Price Quote` / `Negotiation/Review` /
`Value Proposition`, **accelerating** velocity, 6–8 emails + 2–4 tasks,
personas Champion · Economic Buyer · Technical Evaluator · Coach, carries a
`priorWin` (an existing customer expanding). Best in the `250K_1M` band,
Technology. The contrast deal that makes the at-risk deal pop. Mostly-positive
beats:

| Dimension | Beat | Sentiment |
|---|---|---|
| Decision criteria | A technical sponsor confirms the POC exceeded benchmarks | Positive |
| Champion | A VP-level champion is selling internally to the CEO | Positive |
| Budget / metrics | Budget approved for the quarter | Positive |
| Timeline / pain | Engineering is asking for an integration timeline (pull, not push) | Positive |
| Paper process | Legal review underway, no blockers | Neutral |

**Velocity:** accelerating (front-load the last 14 days). **Produces:** a
warming thread, an arm-the-champion next-step email, confident rep notes.

### ARCHETYPE 3 — `rfp-gated`: the early-stage honest-quiet deal

**Profile:** `Qualification` / `Needs Analysis`, **steady** velocity, 3–5
emails + 1–2 tasks, personas Technical Evaluator · Coach · End User (note: no
champion yet). Best in the `250K_1M` band, Financial Services. Proves the
dataset distinguishes silence-from-earliness from silence-from-ghosting.
**Sparse** beats (2–3):

| Dimension | Beat | Sentiment |
|---|---|---|
| Pain / financial | Budget owner interested; a quantified manual-process pain (e.g. 200+ hrs/qtr) | Neutral |
| Process / competition | A formal multi-vendor RFP being set up | Neutral |

**Produces:** a light, professional thread; the honest "early/quiet, not at
risk" read — no champion, RFP underway, but no risk flags either.

### ARCHETYPE 4 — `stalled-portfolio`: the late-stage decaying deal (scale)

**Profile:** `Negotiation/Review` / `Perception Analysis`, **stalling**
velocity, 4–6 emails + 1–3 tasks, personas Champion · Economic Buyer ·
Blocker. The volume archetype — late-stage skew, cadence decayed to
Stalling/Dark (backdate the last touches 14–28d+). Beats: a ghosting champion,
a competitive threat, a budget cut, a timeline conflict. This is the
portfolio texture that makes a "3 of 12 need attention" scan land.

### ARCHETYPE 5 — `churning-account`: the cross-deal account-intelligence arc

**Profile:** `Closed Lost` / `Negotiation/Review`, **stalling** velocity, 4–6
emails + 1–2 tasks, personas Economic Buyer · Skeptic · Blocker, carries a
`priorWin` (bought ~1–1.7y ago; the renewal/expansion is now at risk).
**Requires multiple Opps per Account + at least one Closed-Lost + risk-leaning
activity across them** — that cross-deal shape is the churn/health signal
(declining sentiment, a recent loss). The leading indicator a Case/CaseComment
support history reinforces.

---

## 3. How to write copy that doesn't read as AI slop

The email bodies, Task notes, and transcript text are what a reader sees and
what the LLM judge scores. **If the copy reads canned, the dataset reads
canned.** The carried voice spec (`docs/design/voice.md`) is the law; this
section is its application to seed copy. The copy layer enforces it through
the gate (voice-lint → regenerate) and the LLM-as-VP judge — but the dossier
beats must *give it something specific to write*.

### 3.1 The four voice principles (from `docs/design/voice.md`)

- **Direct** — say the thing. No "I'd love to share," no "here are some
  insights I've curated."
- **Honest** — when the deal is quiet, say it's quiet. "The deal's been
  quiet. Sometimes that's a signal too." beats a confidence-faking summary.
- **Warm** — a reader is a person doing a hard job. "you" / "your deal," not
  "the user" / "the opportunity."
- **Specific** — **numbers, names, dates.** *"CFO confirmed $200K cap on
  Tuesday"* beats *"Budget signal detected from Finance contact."*

**Banned phrases** (anywhere a human reads the copy): "Based on my analysis…",
"here are some insights", "I'd love to share…", "It is worth noting that…",
"In summary…", "Strategic Insights." The full do/don't pairs are in
`docs/design/voice.md` and `docs/design/anti-patterns.md` — read them before
writing any human-facing copy string.

### 3.2 Emails (`EmailMessage.TextBody`) — read human

Realism markers that make an email read like a person sent it:

- **First-name greeting + sign-off** ("Hi Dana," … "— Sarah").
- **Dropped apostrophes / casual contractions** ("Ill circle back",
  "whats happening", "weve gone quiet").
- **Hedge language** ("I hate to be the bearer of bad news", "to be
  straight with you").
- **Specific numbers** ("budget cut by 30%", "40% above what we can
  justify", "20+ hours per week").
- **Named third parties** ("our CFO has brought in {competitor}", "Mike
  from procurement").
- **Real competitor names** (vertical-plausible): `Clari, Gong, Chorus,
  People.ai, InsightSquared, Aviso, Revenue.io, Outreach, SalesLoft,
  ZoomInfo` and the like.

Append a real signature block so the thread reads as genuine mail, and make
the `FromAddress` match a `Contact.Email` on the deal so the message
attributes to a real persona. To demo PII handling, an occasional body can
carry a 16-digit card number or `123-45-6789` SSN.

**Example EmailMessage shape (`RelatedToId` = Opp):**

```
FromName    = 'Sarah Chen'
FromAddress = 'sarah.chen@acme.example'   (matches a Contact.Email → attributes to that persona)
Subject     = 'Re: Pricing proposal'
MessageDate = <backdated DateTime>        (drives velocity — §1.7)
RelatedToId = <oppId>
Status      = '0'
TextBody    =
  "Thanks for the revised numbers. The $150k year-one figure works for our
   FY budget. I need to loop in procurement before we sign — Mike runs that
   and hes been slammed.

   Best regards,
   Sarah Chen
   CFO, Acme Corp
   sent from my iPhone"
```

### 3.3 Transcripts (VTT in `ContentVersion.VersionData`) — speaker dynamics + a decision beat

Call-recording transcripts are `ContentVersion` records with WebVTT in
`VersionData`, linked to the Opportunity via `FirstPublishLocationId` — the
shape a tool like Gong / Einstein Conversation Insights produces. (Note: a
real Salesforce-sink load needs `VersionData` base64-encoded plus the
`ContentDocumentLink`; the file sink stores plain text — see `CLAUDE.md §4`.)

**Format the seeder emits:**

```
WEBVTT

1
00:00:01.000 --> 00:00:04.000
Sarah Chen: Good to connect — I pulled the budget numbers ahead of this call.

2
00:00:05.000 --> 00:00:18.000
Sarah Chen: The CFO confirmed the $200k budget is approved for Q2, so funding is not the blocker.

3
00:00:19.000 --> 00:00:31.000
Tom Bradley: On our side procurement still needs to run the security review before we can sign anything.
```

Rules to honor:

- **Standard WebVTT:** the `WEBVTT` header, numeric cue ids, and
  `HH:MM:SS.mmm --> HH:MM:SS.mmm` timing lines.
- **Substance per utterance:** every meaningful line needs real content
  after the speaker label — a stated number, a named blocker, a commitment or
  a refusal. Strip the small talk; a transcript of "Hi." / "Sounds good."
  reads as filler.
- **Speaker → Contact match:** the label before the first colon should match
  a Contact on the Opp (full / first / last name), and that Contact must be
  an **OpportunityContactRole** on the deal so the speaker attributes to a
  real persona. Use `Name: text`, **not** `<v Name>` voice tags.
- `FirstPublishLocationId` **must be the Opportunity Id.**

Write speaker-labeled dialogue with hedges and filler **and a DECISION beat**
— a stated number, a named blocker, a commitment or a refusal — so the
transcript carries the substance a real call would.

### 3.4 Notes / logged activities (`Task.Description`) — sound like a rushed AE

Task notes are the rep's terse account of a call — fragmented, telegraphic,
with embedded numbers + pain. These land in `Task.Description`
(`WhatId` → Opp, `WhoId` → Contact; `TaskSubtype='Email'` for EAC-synced
email activity):

```
"Met with Dana (VP Eng). Mentioned needing SOC2 before they can expand. Budget
 discussion went well — seems like they have authority to approve up to $120k."

"Currently using Gong but unhappy with reporting. Manual data entry taking 20+
 hours/week. Champion is frustrated, wants a demo of the dashboards next week."

"QBR prep: renewed last quarter but usage dropped 15%. They reverted to
 spreadsheets for forecasting. Risk of churn if we dont re-engage by EOM."
```

Don't pre-clean the note copy — raw is more real. A logged-activity Subject
follows a verb-led pattern (`Call: discovery follow-up`,
`Schedule technical deep-dive` — see `BULK_TASK_SUBJECTS`); the Description is
the substance underneath it.

### 3.5 Universal copy rules

The copy must support these reads (they're what a VP-grade reader expects):

- **Action-oriented next steps** — verb-led imperatives (Send / Schedule /
  Confirm / Push / Call / Email / Draft…) that name *who/what*. **NEVER**
  diagnoses ("Complete absence of…"), verdicts ("Deal is at risk"), or
  abstract goals ("Build champion alignment"). So each beat must carry a
  concrete next-action hook (a named person + a specific gap).
- **Evidence = exact quote + attribution** (who + when). So every
  narrative-bearing body must contain a real quotable line with attribution —
  a generic paraphrase can't power an evidence read.
- **Never fabricate stakeholder names.** Reference only Contacts that exist
  on the deal. A body that invents a name fails the realism bar — the cast is
  the dossier's, not the copy layer's to invent.

---

## 4. Anti-patterns — the no-vapor-ware checklist

1. **Do NOT hand-author copy the pipeline should generate.** Seed the
   structure + grounding, then run the real copy layer (anthropic →
   claude-code → static) through the gate + judge. If a body reads weak, fix
   the **source** — the prompt, the grounding fact-pack, the variability
   matrix, the scenario design — never hand-edit the artifact.
   (`feedback_no_vapor_ware`; canonical in `CLAUDE.md §2`.)
2. **"Demo magic" allowed; fabrication NOT.** Allowed: choosing *which*
   records exist, *which* scenarios, *which* anchors. Not allowed:
   fabricating a believable artifact by hand and passing it off as generated.
3. **If the output is weak, fix the SOURCE, not the artifact** — the prompt
   structure, the grounding fact-pack, the scenario design, the dossier beat
   density/specificity. A boring deal means the beats lack specificity, not
   that you should hand-write the prose.
4. **Demo-first / work backwards** (`feedback_demo_first_thinking`): every
   seeded surface justifies itself against a sizzle-reel beat (a populated
   pipeline a VP scans, a champion-silence deal that lands as a gut-punch, an
   honest early-quiet read). If a record doesn't serve a beat, scope it down.
5. **Idempotency + durability** (`CLAUDE.md §2`): additive seeds skip existing
   records; catalog objects (products, campaigns, the User pool) upsert by a
   natural key. Resolve org records **by name/query, never by literal Id** —
   literals don't survive a fresh scratch org.
6. **Picklist traps that fail the load** (get these EXACTLY right — full set
   in `packs/salescloud/src/picklists.ts`; a wrong value fails at LOAD with
   `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`):
   - `Task.Status` ∈ `{Not Started, In Progress, Completed, Waiting on
     someone else, Deferred}` (NOT "Open").
   - `Task.Priority` / `Event.Priority` ∈ `{High, Normal, Low}`;
     `Event.ShowAs` ∈ `{Busy, OutOfOffice, Free}`.
   - `Case.Status` ∈ `{New, Working, Escalated, Closed}`; `Case.Origin` ∈
     `{Phone, Email, Web}`; `Case.Priority` ∈ `{High, Medium, Low}` (Case
     uses **Medium**, Task uses **Normal**).
   - Org-configurable picklists (Task/Event subtype, Case Type/Reason, Asset
     Status) are **omitted** to stay load-safe on an untouched org.
7. **Coherence over volume.** A `Negotiation/Review` deal with one positive
   touch and no risks isn't a story; a `Qualification` deal dressed as a
   late-stage crisis is a lie. Stage, activity density, sentiment trajectory,
   and velocity must agree (§1.3, §1.7). One coherent deal beats ten flat
   ones.

---

## 5. The realistic-data checklist (so data loads AND tells a story)

Before declaring a seeded deal "done," confirm:

1. **Insert order respected.** The master-detail / lookup chain loads in
   dependency order (`Product2 → PricebookEntry → Campaign → UserRole → User
   → Account → Contact → Opportunity → OpportunityContactRole →
   OpportunityLineItem → Lead → CampaignMember → EmailMessage →
   ContentVersion → Task → Event → Asset → Case → CaseComment`). Canonical in
   `CLAUDE.md §4`.
2. **Every Opportunity has its narrative cast** — Contacts wired as
   `OpportunityContactRole`s, a persona mix (not all Champions), with the
   primary persona matchable by a transcript speaker label.
3. **Contacts have `Email`** matching the `EmailMessage.FromAddress` (so the
   email attributes to a persona); for transcripts the speaker Contact is also
   an `OpportunityContactRole`.
4. **EmailMessage** has `RelatedToId = oppId`, `Status='0'`, a real signature
   block, and a backdated `MessageDate`.
5. **VTT** = `WEBVTT` header + numeric cue ids + timing lines + `Speaker
   Name: utterance` (with real substance), no `<v>` tags;
   `FirstPublishLocationId = oppId`.
6. **Activity is backdated** to manufacture the intended velocity shape
   (§1.7); the deal degrades or strengthens over weeks, and dates spread over
   ~3 years across the dataset.
7. **Persona mix is varied** (not all Champions); the buying committee spans
   distinct voices and plausible responsiveness.
8. **Band coverage** — multiple Closed-Won deals share a band so a pacing
   cohort exists; the bands are otherwise spread per
   `SALESCLOUD_VARIABILITY`.
9. **Cross-deal / churn prerequisites** — `churning-account` deals have
   multiple Opps + ≥1 Closed-Lost + risk-leaning cross-deal activity + a
   declining sentiment trajectory (reinforced by Case/CaseComment history).
10. **Copy passes the gate + judge** — every filled body clears the
    voice-lint gate and the LLM-as-VP judge before the dataset is called done
    (`docs/copy-layer.md`).

---

## 6. Where the implementation lives (parameterize these, don't re-derive)

| File | What it is |
|---|---|
| `packs/salescloud/src/scenarios.ts` | `SALESCLOUD_SCENARIOS` — the five archetype ids (§2) |
| `packs/salescloud/src/variability.ts` | `SALESCLOUD_VARIABILITY`, `BAND_RANGE`, `STAGES`, `SCENARIO_PROFILES` — the variability matrix (§1) |
| `packs/salescloud/src/picklists.ts` | `SALESCLOUD_PICKLISTS` + `PERSONAS` — restricted standard picklists (§4.6) and the buying committee (§1.4) |
| `packs/salescloud/src/dossier.ts` | the per-account Deal Dossier spine every object derives from |
| `packs/salescloud/src/generate.ts` | `salescloudGenerate` — emits records + deferred `CopyRequest`s |
| `packs/salescloud/src/anchors.ts`, `grounding.ts` | real public-company anchors + per-vertical grounding fact-packs (§1.1) |
| `docs/design/voice.md` | the anti-AI-slop voice spec — §3 is its application to seed copy |
| `docs/copy-layer.md` | the copy provider chain + gate + judge that fills the requests |
| `CLAUDE.md` | the canonical orientation (object model, ops, insert order, guardrails) |

---

*That's the narrative spec. Build the dossier spine; let the copy layer write
the prose; make each deal cohere across stage, cadence, and sentiment so a
real seller would recognize the pipeline. — the demo-data seeder*
