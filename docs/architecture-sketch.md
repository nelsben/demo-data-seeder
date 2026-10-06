# Architecture Sketch — Sales Cloud Demo-Data Seeder

> **Status:** forward-looking layer sketch, explicitly revisable. This is the conceptual layer model behind the seeder — NOT the authoritative current-state architecture.
> **Authoritative current state:** see [`app-architecture.md`](./app-architecture.md) (the packages, the `NarrativeBundle` seam, the op lifecycle, the testing strategy). Where this sketch and `app-architecture.md` disagree, `app-architecture.md` wins.
> **Canonical orientation:** the repo-root [`CLAUDE.md`](../CLAUDE.md) owns the one-paragraph framing (what the seeder is, the object model, the ops). This sketch points at it rather than re-deriving.

---

## 0. What this sketch is for

`app-architecture.md` describes the *as-built* engine. This file keeps the **layer model** — the four conceptual layers data flows through (config → generate → copy → load) and the design intents at each — so a fresh reader can reason about *why* the stages exist before diving into the package map. Read `app-architecture.md` for the real shapes; read this for the forward-looking intent and the deltas not yet built.

The seeder is a **config-driven, deterministic generator** that emits realistic, narrative-rich demo data for **standard Salesforce Sales Cloud objects** — no custom (`__c`) objects, no managed package. It points at any Salesforce org, scopes a run to that org's limits, and produces grounded synthetic data that reads like a real company's pipeline. One `TargetPack` (`salescloud`, `@dataseed/pack-salescloud`) supplies everything domain-specific; the engine stays pack-agnostic. Full framing in [`CLAUDE.md`](../CLAUDE.md) §1.

**Governing law (durable, from [`CLAUDE.md`](../CLAUDE.md) §2):**
- **No vapor-ware** — seed the **inputs** and let the real generation pipeline produce the **outputs**. If copy is weak, fix the source (prompt / fact-pack / variability matrix / scenario design), never hand-edit a generated record's prose.
- **Realism is the bar** — this data goes in front of VPs/CEOs and is used to test AI workflows. Specifics over abstractions. Read [`design/voice.md`](./design/voice.md) before writing any human-facing copy string.
- **Deterministic by default** — same `--seed` + same config ⇒ same dataset, modulo live-LLM copy (which is content-addressed cached so a warm cache is fully deterministic too).


---

## 1. The four-layer model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ (a) NARRATIVE / SCENARIO CONFIG          archetypes × variability matrix      │
│     anchors · SALESCLOUD_SCENARIOS · personas · SALESCLOUD_VARIABILITY        │
│           │  seeded RNG (mulberry32) — deterministic draws                    │
│           ▼                                                                   │
│ (b) ENTITY GENERATORS (salescloudGenerate)   honor the picklist/field truth   │
│     Account · Contact · Opportunity · OCR · OLI · Lead · Campaign · …         │
│     EmailMessage · Task · Event · ContentVersion · Case · Asset               │
│           │  emits a NarrativeBundle (in-memory) + deferred CopyRequest[]     │
│           ▼                                                                   │
│ (c) LLM COPY LAYER                       realistic emails / notes / transcripts│
│     provider chain: anthropic → claude-code → static  ·  gate → judge         │
│     content-addressed cache · voice.md-grounded prompts · budget cap          │
│           │  fills TextBody / Description / VTT VersionData on the bundle      │
│           ▼                                                                   │
│ (d) LOADER / SINK                        order-aware · idempotent             │
│     Composite REST | Bulk 2.0 | file/SQLite sinks                             │
│     dependency-ordered insert · resolve-by-name dedup · manifest teardown     │
└─────────────────────────────────────────────────────────────────────────────┘
```

The **`NarrativeBundle`** is the seam between layers (canonical: `app-architecture.md` §2). (b) builds it as plain typed records keyed by standard SF API name; (c) mutates only the copy fields; (d) topologically loads it. Layers are independently testable: (a)+(b) run dry with static copy and produce a deterministic JSON snapshot at zero org or LLM cost.

---

## 2. Layer (a) — Narrative / Scenario config

### 2.1 Anchors (the real-company substrate)

Real public-company anchors (name, industry, country, headcount/revenue band, synthetic `.example` domain) ground the data — "I'm prepping a deal at Stripe" reads far better than "Acme Corp". The fictional layer is the *workflow* around them. **Email addresses are always synthetic** (`<first>.<last>@<domain>` where `domain` ends in `.example`) — we never emit a real person's address.

### 2.2 Scenarios (the named deal archetypes)

`SALESCLOUD_SCENARIOS` (in `packs/salescloud/src/scenarios.ts`) — generic B2B deal archetypes, each a **distinguishable narrative pattern**:

| Scenario | Pattern | Reads as |
|---|---|---|
| `at-risk-budget` | champion goes silent → procurement escalates → pricing lands ~40% over budget → competitive eval opens | a deal in serious trouble; a hero re-engage email |
| `healthy-tech` | economic-buyer approval → POC exceeds bar → legal clears → strategic alignment | an accelerating, mostly-healthy deal |
| `rfp-gated` | interest → pain articulated → formal multi-vendor RFP → IT pulled in | an early, honest "not-at-risk-but-no-champion-yet" deal |
| `stalled-portfolio` | ghosting contact + budget cut + timeline conflict | a stalling/dark multi-deal portfolio |
| `churning-account` | multi-Opp account + a prior Closed-Lost + cross-deal risk | a churn/health-decline narrative |

A scenario declares: stage, deal-size band target, a **chronological beat timeline** (each beat = a sentiment + a days-ago offset + a copy hint), the buying-committee mix, and the velocity intent (`accelerating | steady | stalling | dark`). A scenario writes the **inputs** the copy pipeline derives from — never a finished output. The deal-archetype design lives in [`narrative-design.md`](./narrative-design.md); the per-account spine in [`design/narrative-engine.md`](./design/narrative-engine.md).

### 2.3 Variability matrix (so a dataset reads as varied, not random)

`SALESCLOUD_VARIABILITY` (canonical: [`narrative-design.md`](./narrative-design.md) + [`CLAUDE.md`](../CLAUDE.md) §4). A believable seller dataset must span:

1. **Industry / vertical** — 15 values. Vertical drives plausible pain (HIPAA for Healthcare, SOC2 for FinServ) and which competitor appears.
2. **Deal-size bands** — 6 bands `LT10K | 10K_50K | 50K_100K | 100K_250K | 250K_1M | GTE1M`. Seed **multiple deals per band** so a band cohort exists.
3. **Stage distribution** — the 10 standard SF Opportunity stages, weighted per scenario; stage must **cohere** with signal density and outcome (a Negotiation deal with a silent champion reads at-risk; a Prospecting deal with sparse data reads correctly "early/quiet").
4. **The 7-role buying committee** — Champion, Economic Buyer, Technical Evaluator, Coach, Skeptic, Blocker, End User (modeled via `OpportunityContactRole`). A real deal has a MIX, not all Champions.
5. **Sentiment trajectories** — positive→risk as a **trajectory across time**, not a static blend. A degrading deal earns its red.
6. **Win/loss outcomes** — Closed Won + Closed Lost (the churn narrative).
7. **Velocity** — manufactured by **backdating timestamps** across ~3 years (see §3.3). Flat same-day timestamps make every deal read "recent" and the dataset loses its punch.

### 2.4 Seeded RNG (determinism)

A `mulberry32(seed)` PRNG is threaded explicitly through every draw (anchor pick, committee-role assignment, stage roll, day-offset jitter). One root seed (`--seed N`) deterministically derives per-account and per-record sub-seeds, so the dataset is reproducible end-to-end and adding a draw to one generator never shifts another's output. **Never** call `Math.random()`, `Date.now()`, or `uuid()` in the generation path. A single injected `as-of` date anchors all relative timelines. (Canonical: `app-architecture.md` §2, "Mode 1 — Deterministic skeleton".)

---

## 3. Layer (b) — Entity generators

`salescloudGenerate` emits source-format records keyed by **exact standard SF API name**, respecting the master-detail / required-field / restricted-picklist contracts. The seeder produces a connected graph of standard objects only — no `__c` objects. Insert/dependency order (canonical: [`CLAUDE.md`](../CLAUDE.md) §4):

```
Product2 → PricebookEntry → Campaign → UserRole → User → Account → Contact
  → Opportunity (AccountId) → OpportunityContactRole → OpportunityLineItem
  → Lead → CampaignMember → EmailMessage → ContentVersion → Task → Event → Asset → Case → CaseComment
```

### 3.1 The narrative-bearing records (where the copy lands)

- **Opportunity** — the deal. Stage, Amount (band-sampled), CloseDate; dates spread over ~3 years for velocity. Some accounts carry a PRIOR Closed-Won Opp (cross-deal history).
- **EmailMessage** (`RelatedToId` → Opp) — the email thread, 4–8 per foreground deal. Body in **`TextBody`** (filled by the copy layer). `TaskSubtype='Email'` on a synced activity models EAC-synced email.
- **Task** (`WhatId` → Opp, `WhoId` → Contact) — logged-activity notes; the rep's terse account of a call. Body in **`Description`**.
- **ContentVersion** (`FirstPublishLocationId` → Opp) — **call-recording transcripts** as VTT files, the shape a Gong/Einstein Conversation Insights tool produces. Transcript text in **`VersionData`** (filled by the copy layer). A Salesforce-sink load needs `VersionData` base64-encoded + the file linked via `FirstPublishLocationId`/`ContentDocumentLink`; a file sink stores plain text.
- **Case / CaseComment** — support history; the churn/health leading indicator.
- **Asset** — installed base on Customer accounts.

### 3.2 Restricted-picklist & required-field truth (DO NOT guess — a wrong value fails at LOAD)

`SALESCLOUD_PICKLISTS` (canonical: `packs/salescloud/src/picklists.ts`; summarized in [`CLAUDE.md`](../CLAUDE.md) §4). A wrong value fails with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`. Key restricted standard picklists:

| Field | Allowed values |
|---|---|
| `Task.Status` | `Not Started \| In Progress \| Completed \| Waiting on someone else \| Deferred` (NOT "Open") |
| `Task.Priority` / `Event.Priority` | `High \| Normal \| Low` |
| `Event.ShowAs` | `Busy \| OutOfOffice \| Free` |
| `Case.Status` | `New \| Working \| Escalated \| Closed` |
| `Case.Origin` | `Phone \| Email \| Web` |
| `Case.Priority` | `High \| Medium \| Low` (Case uses Medium; Task uses Normal) |

Org-configurable picklists (Task/Event subtype, Case Type/Reason, Asset Status) are **omitted** to stay load-safe on an untouched org. A picklist contract test diffs `SALESCLOUD_PICKLISTS` against the live org describe so a metadata drift fails the seeder loudly instead of at load time.

### 3.3 Velocity is manufactured — backdate timestamps

The seeder spreads Opportunity/activity dates over ~3 years and backdates the per-beat timestamps from each scenario's chronological script, so the dataset shows realistic velocity (accelerating / stalling / dark) rather than every deal reading "recent". For a live Salesforce sink, true `CreatedDate` is system-controlled — velocity then leans on the activity-date fields and the timeline spread rather than audit-field overrides (an open knob; see §6).

---

## 4. Layer (c) — LLM copy layer

This is the seam that turns structural records into prose a VP believes. Canonical: [`copy-layer.md`](./copy-layer.md). The summary:

`generate/` emits the bundle with **copy fields empty** plus a deferred `CopyRequest[]` manifest (each `{ kind: email|note|transcript, voiceContext, beatIntent, speakers, … }`), keeping generation network-free and snapshot-pure. The `copy/` module resolves those requests, grounded on the deterministic+probabilistic skeleton, never inventing structure.

### 4.1 Provider routing

Provider chain **`anthropic → claude-code → static`**:
1. **anthropic** — `@anthropic-ai/sdk` direct, under a `--budget` USD cap. Model IDs are resolved **live at runtime** (the `claude-api` skill / `client.models.list()`), never hardcoded from training data.
2. **claude-code** — the subscription provider (the realism path; no API spend).
3. **static** — deterministic templates; the always-on zero-cost floor for CI smoke tests.

There is **no Einstein / `LlmService` routing** and **no Data Cloud path** in this repo — the seeder targets standard objects only.

### 4.2 Voice grounding + the gate + the judge

Every copy prompt is grounded in [`design/voice.md`](./design/voice.md) (the mandatory anti-AI-slop spec). Filled copy then passes a realism **gate** (voice-lint → regenerate on failure) and an **LLM-as-VP judge**, so generated prose can't read as AI slop. Hard rules the prompts enforce: specific = numbers + names + dates ("CFO confirmed $200K cap on Tuesday"); emails read human (first-name greeting + sign-off, hedges, specific figures, a named competitor); transcripts carry a real DECISION beat (a stated number, a named blocker, a commitment/refusal); notes sound like a rushed AE. **Never fabricate stakeholder names** — copy references only Contacts that exist on the deal.

### 4.3 Content-addressed cache (determinism + cost)

The cache is keyed `sha256(provider + model + normalizedPrompt)`. A warm cache makes even live-LLM runs fully deterministic and re-runnable at $0; the canonical anchor set's cache is checked in so a fresh clone reproduces the demo dataset without spending tokens. `--budget <usd>` caps direct-Anthropic spend with an abort-before-overspend check.

---

## 5. Layer (d) — Loader / sink

Order-aware, idempotent, additive. The bundle is **dispersed** to a pluggable **Sink** (canonical: [`registry-and-dispersement.md`](./registry-and-dispersement.md) — generate once, disperse many). Mechanisms by target/volume:

| Mechanism | When |
|---|---|
| **Composite REST** (200/batch, `allOrNone:false`) | default Salesforce sink, ≤~10k records; dependency-ordered |
| **Bulk API 2.0** | large/historical backfills (>10k), portfolio/whale cohorts |
| **File / SQLite sinks** | offline corpus, registry-backed artifacts (the warehouse materializes a 100K corpus with no live org — see [`design/corpus-warehouse.md`](./design/corpus-warehouse.md)) |

**Insert order (topological):** the loader sorts the bundle by the §3 dependency graph and fails loud if a parent Id is unresolved (never silently drops). **Idempotent + additive:** resolve EVERYTHING by Name / natural key at load time — **never by literal Id**; `check()` skips a record whose parent already exists; catalog objects (Product2, Campaign, the User pool) upsert by natural key. A run is tagged with a sentinel and tracked in a manifest; teardown deletes in **reverse dependency order**.

> The Mode A / Mode B framing and the WITH-DC / NO-DC dual-mode gate from earlier drafts are **gone** — there are no derived objects to seed and no Data Cloud path. The seeder loads standard objects into any stock org with no managed package.

---

## 6. Op contract + open knobs

**Op contract** (canonical: `app-architecture.md` §5, [`CLAUDE.md`](../CLAUDE.md) §1): every operation is `{id, name, description, prerequisites, affects, idempotent, args, check(), run(), verify()}`, run via `node bin/run-op.js run <id> --<arg> <value>` (`list` / `run <id> --help`). Ops, all idempotent:

| op | role |
|---|---|
| `profile-org` | introspect the target org's limits/edition/objects → a `CapabilityProfile` that caps the run |
| `plan-demo` | `(profile, scope, seed) → SeedPlan` |
| `materialize` / `warehouse` | build the rebuildable SQLite corpus (no live org) |
| `fill-copy` | resolve the deferred `CopyRequest`s through the copy layer |
| `load-demo` | load a dataset into a Salesforce org |
| `disperse` | disperse a registered dataset to a sink |
| `teardown-demo` | reverse-order purge by the run sentinel |

**Open design knobs** (decide as scope lands; burn-mode parking lot is [`open-questions/`](./open-questions/)):
1. **Copy provider default** — `claude-code` (subscription, the realism path) vs `anthropic`-direct under the budget cap vs `static` for CI. Don't spend API credits without asking.
2. **Non-test `CreatedDate` backdating** — for a live Salesforce sink, audit fields are system-controlled; velocity then leans on activity-date fields + the timeline spread. Needs an org-capability spike if true backdating is wanted.
3. **How many anchors / how much variety is "enough"** — timebox against actual scale; ship the smallest set that covers the variability matrix + the band cohorts, expand on demand.

---

## 7. Determinism + tests (forward-looking deltas)

Authoritative testing strategy is `app-architecture.md` §7. The intents this sketch keeps:
- **Seed-stability** — same `--seed` twice ⇒ byte-identical bundle (catches a stray `Math.random()`/`Date.now()`).
- **Dry-run snapshot** — `--dry-run` with static copy pins a deterministic `NarrativeBundle` JSON; generation drift shows as a reviewable diff.
- **Picklist contract** — `SALESCLOUD_PICKLISTS` diffed against the live org describe.
- **Copy/voice contract** — golden prompt structure + a voice-keyword assertion set (verb-led titles, numbers/names/dates present, no AI-slop phrases) over a frozen warm cache.
- **Loader integration** — lease a scratch, run `profile-org` → `load-demo` → `verify`, assert per-stage counts, `teardown-demo`, assert clean.

---

This is a layer sketch, not a frozen spec. For the as-built packages, the op lifecycle, and the screen-by-screen app experience, read [`app-architecture.md`](./app-architecture.md); for the canonical one-paragraph framing and the object model, read [`CLAUDE.md`](../CLAUDE.md).
