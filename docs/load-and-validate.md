# Loading & Validation — how seeded data lands in orgs

This is the load-and-validate reference for the demo-data seeder. It covers: **where** seeded data goes (scratch / customer / shared-dev targets), **how** it loads (mechanisms + the exact insert ORDER imposed by master-detail/lookup chains), **how to re-run safely** (idempotency + teardown), and **how the seeded data is verified** after a load.

This repo seeds **only standard Salesforce Sales Cloud objects** — no custom (`__c`) objects, no managed package. Everything below loads into a stock org. For the authoritative engine framing (the op lifecycle, the `NarrativeBundle` seam, the pack contract), the canonical source is the repo-root [`CLAUDE.md`](../CLAUDE.md) and [`docs/app-architecture.md`](app-architecture.md) — this doc is the loading + validation mechanics only.

Governing rule for everything here: **seed the inputs, let the real pipeline produce the outputs.** Do not hand-author what the copy layer would generate. (See [`narrative-design.md`](narrative-design.md) for the no-vapor-ware rule; this doc is the loading + validation mechanics.)

---

## 0. TL;DR — the canonical happy path

Ops run via `node run-op.js run <id> --<arg> <value>` (`list` to enumerate, `run <id> --help` for args). The lifecycle is **introspect → generate → fill copy → load → verify → teardown**:

```bash
# 1. introspect the target org (limits, objects, picklists) — scopes the run
node run-op.js run profile-org --org <alias>

# 2. plan a demo dataset (the per-account Deal Dossier spine + record skeletons)
node run-op.js run plan-demo --org <alias> --volume 12

# 3. fill the deferred CopyRequests with real prose (the copy layer)
node run-op.js run fill-copy --dataset <id>

# 4. load into the org (standard-object insert order, idempotent)
node run-op.js run load-demo --org <alias> --dataset <id>

# 5. tear down when done
node run-op.js run teardown-demo --org <alias>
```

For corpus-scale (100K accounts, no live org) use `materialize` / `warehouse` instead of `plan-demo` + `load-demo` — see [`docs/design/corpus-warehouse.md`](design/corpus-warehouse.md). To push an already-generated dataset to a sink (Salesforce org, files, etc.) use `disperse` — see [`docs/registry-and-dispersement.md`](registry-and-dispersement.md).

Pick a target (§1), pick a load mechanism (§2), respect the insert order (§2), make it idempotent (§3), then validate (§4).

---

## 1. TARGETS — where seeded data must load

There are three distinct targets with different rules. **Scratch is the certain, safe target.** A shared dev org is shared CI infrastructure (treat as hazardous). Customer orgs hold real data (never bulk-seed).

Because the seeder loads only standard objects, it works against **any** Salesforce org with no managed package and no special provisioning — there is no WITH-feature / NO-feature gate to choose between.

### 1a. Ephemeral scratch orgs — the primary, safe target

Scratch orgs are the default target: cheap, disposable, and safe to bulk-seed. Create them deliberately (`sf org create scratch --alias <alias> --definition-file <def>.json`) rather than blindly — a blind create can blow the Dev-Edition caps (**6 creates/day, 3 active concurrent**) and red CI. The seeder needs no special org features; a vanilla scratch def is sufficient.


### 1b. The shared dev org — the de-facto CI target (HANDLE WITH CARE)

A shared dev org doubles as the per-PR validate target and a demo org. Hazards the seeder MUST respect:

- Manually dev-deploying a **new test class** or seeding orphan data into the shared org can red the test baseline for **ALL** open PRs until it's cleaned. Develop on scratch; let CI deploy up.
- **Never reap/recreate a shared scratch pool while a CI validate is in-flight** against it → `INVALID_CROSS_REFERENCE_KEY` across all tests, looks like a regression.
- The `sf org delete` permission is **denied** in `.claude/settings.json` `permissions.deny` precisely because a seeder runs org tooling. Keep it denied.

Seeding **data** (records) into a shared org is acceptable (that's what a demo refresh does); deploying new **metadata/test classes** is not.

### 1c. Customer orgs — real Salesforce, never bulk-seeded

These seed paths are **not** for customer orgs — customer data is real and FLS/permset/existing-data-bound. If the seeder ever runs there, additive seeds must skip existing records and resolve everything by name/query, never by literal Id.

**Recommendation: target scratch by default; only touch a shared org for data refreshes; treat customer orgs as out of scope for record seeding.**

---

## 2. LOAD MECHANISM + INSERT ORDER

### 2a. The loading mechanism

The Salesforce sink loads records through the **Composite REST API** (`SObject Collections` — `POST /services/data/vXX.0/composite/sobjects`, batched **200 records/call, `allOrNone:false`**), auth via the org's access token. **Per object**, once its row count reaches `bulkThreshold` (default **5,000**), insert auto-switches to the **Bulk API v1** instead (**10,000 rows/batch** — ~50× fewer API calls). This exists specifically to protect a **scratch org's daily REST-call budget**: scratch orgs have a small fixed daily allotment (commonly 15,000 calls/day), and a naive one-call-per-200-rows load can exhaust it in a single large run, locking the org out until the daily rollover.

- **Preview the cost first:** `estimate_dataset` (MCP) / `DatasetService.estimate()` returns an `apiCost` field — `restApiCalls`, `bulkApiBatches`, and (when the org has a live profile with captured `dailyApiRequests`/`dailyBulkApiBatches`) a cross-check against the org's actual remaining daily limits, flagging `wouldExceedDailyApi`/`wouldExceedDailyBulk` before you ever load. Pass a candidate `bulkThreshold` to preview under that threshold.
- **Lower the threshold to load safer:** `--bulkThreshold` is a real, working knob on `load-demo`, `load-warehouse`, the generic `disperse` op, and the MCP `disperse_dataset` tool — lowering it (e.g. to 200) routes more objects onto the Bulk API sooner, trading REST-call budget for Bulk-batch budget (`dailyBulkApiBatches` is a separate, usually much roomier, limit).
- Catalog objects (Product2, Campaign, the User pool) **upsert by a natural key**; transactional records (Accounts, Opportunities, the activity graph) are additive inserts that skip records already present.

A non-Salesforce sink (the **file sink**) writes the same `NarrativeBundle` to disk instead of an org — see the ContentVersion nuance in §2c and [`docs/registry-and-dispersement.md`](registry-and-dispersement.md).

### 2b. Record-level insert ORDER (master-detail + lookup chain)

This order is imposed by the relationship graph — a child cannot insert before its master/lookup parents exist. It is a **hard dependency chain**:

```
Product2 → PricebookEntry → Campaign → UserRole → User
  → Account
    → Contact (AccountId)
      → Opportunity (AccountId)
        → OpportunityContactRole (OpportunityId + ContactId)
        → OpportunityLineItem   (OpportunityId + PricebookEntryId)
      → Lead
      → CampaignMember          (CampaignId + Lead/Contact)
        → EmailMessage          (RelatedToId = Opportunity Id)
        → ContentVersion        (FirstPublishLocationId = Opportunity Id; VTT transcript)
        → Task                  (WhatId = Opportunity Id, WhoId = Contact Id)
        → Event
      → Asset                   (AccountId; installed base on Customer accounts)
      → Case                    (AccountId)
        → CaseComment           (ParentId = Case Id)
```

The narrative-bearing records and where their copy lands:

- **Opportunity** — the deal. Stage, Amount (band-sampled), CloseDate, dates spread over ~3 years for velocity. Some accounts carry a PRIOR closed-won Opp (cross-deal history).
- **EmailMessage** (`RelatedToId` → Opp) — the email thread, body in `TextBody`. `TaskSubtype='Email'` on the related Task models EAC-synced email activity.
- **Task** (`WhatId` → Opp, `WhoId` → Contact) — logged-activity notes; the rep's terse account of a call. Body in `Description`.
- **ContentVersion** (`FirstPublishLocationId` → Opp) — **call-recording transcripts** as VTT files (the shape a tool like Gong/Einstein Conversation Insights produces). Transcript text in `VersionData`.
- **Case / CaseComment** — support history; the churn/health leading indicator.

**Load-bearing constraints (get these exactly right or the insert reds):**

- **ContentVersion is special.** A Salesforce-sink load needs `VersionData` **base64-encoded** and the file linked to its Opportunity via `FirstPublishLocationId` (which creates the `ContentDocumentLink` on first publish). The **file sink stores the transcript as plain text** — no base64, no link record — so the two sinks diverge only on this object.
- **Restricted standard picklists** must be honored exactly or the insert fails with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`. The full set lives in `packs/salescloud/src/picklists.ts` (`SALESCLOUD_PICKLISTS`). Highlights:
  - `Task.Status`: `Not Started | In Progress | Completed | Waiting on someone else | Deferred` (NOT "Open").
  - `Task.Priority` / `Event.Priority`: `High | Normal | Low`. `Event.ShowAs`: `Busy | OutOfOffice | Free`.
  - `Case.Status`: `New | Working | Escalated | Closed`. `Case.Origin`: `Phone | Email | Web`. `Case.Priority`: `High | Medium | Low` (Case uses **Medium**, Task uses **Normal**).
  - Org-configurable picklists (Task/Event subtype, Case Type/Reason, Asset Status) are **omitted** to stay load-safe on an untouched org.
- **`OpportunityLineItem` requires the standard Pricebook to be active** and a matching `PricebookEntry` for the Product2 — hence Product2 → PricebookEntry precede any OLI.
- **Resolve org records by name/query, never by literal Id.** Hardcoded record Ids are an org-specific portability anti-pattern; the seeder looks up Pricebook/Campaign/User parents by their natural key at load time.

The picklist/required-field source of truth is `packs/salescloud/src/picklists.ts`; mirror its values in any new generator code. The data shapes are defined by the `salescloud` pack ([`@dataseed/pack-salescloud`](../packs/salescloud)).

### 2c. Copy is filled BEFORE load, not by a trigger

There is no in-org trigger cascade to account for — these are stock objects. The narrative engine produces records with **empty copy fields plus deferred `CopyRequest`s**; the `fill-copy` op resolves those through the copy-layer provider chain (**anthropic → claude-code → static**) before the records are ever loaded. By load time every `TextBody` / `Description` / `VersionData` is already populated. (Provider chain + the realism gate + the LLM-as-VP judge: [`docs/copy-layer.md`](copy-layer.md).)

So the load step is a pure, deterministic insert of finished records — no async synthesis, no token spend at load, no debounce timing to manage.

---

## 3. IDEMPOTENCY / RE-RUNNABILITY / TEARDOWN

All ops are **idempotent** — re-running is safe. The two patterns:

- **Catalog objects upsert by a natural key** (Product2 by name, Campaign by name, the User pool by username/alias, UserRole by name). Re-running reconciles rather than duplicates.
- **Transactional records are additive and skip existing.** A second `load-demo` against the same dataset detects already-loaded records and does not duplicate them.

| Asset | Idempotency | Teardown |
|-------|-------------|----------|
| Product2 / PricebookEntry / Campaign / UserRole / User (catalog) | upsert by natural key | left in place (shared scaffolding) |
| Account + the per-account graph (Contact, Opp, OCR, OLI, Lead, CampaignMember, EmailMessage, ContentVersion, Task, Event, Asset, Case, CaseComment) | additive; skip existing by name/query | `teardown-demo` deletes in **reverse dependency order** (children before masters; master-detail children cascade with their parent) |
| The dataset bundle itself | content-addressed in `@dataseed/registry` (regenerating the same plan yields the same bundle) | registry entry is disposable; deleting it does not touch the org |

`teardown-demo` is the inverse of `load-demo`: it queries the records the seeder created (tagged/scoped so it never deletes unrelated org data) and deletes them children-first. **Never** rely on `sf org delete` (denied guardrail) — tear down records, keep the org.

> A loaded dataset's record Ids are org-specific and disposable — never treat them as portable state. They are stale the moment the org changes; always resolve by name/query.

---

## 4. VALIDATION — proving the seed landed and reads real

Each op's `verify()` step confirms the load. Two things to check: **structural** (the records exist and respect the relationship graph + picklists) and **realism** (the data manufactures the narrative signals a demo/test needs).

### 4a. Structural verification

After `load-demo`, `verify()` queries the org and asserts the expected counts and links exist — e.g. every foreground Opportunity has its EmailMessage thread, its Tasks (`WhatId` set), its ContentVersion transcript, and its OpportunityContactRoles; restricted picklist values all loaded (no `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` survivors). A failed insert in a `allOrNone:false` batch surfaces here as a missing child.

### 4b. Velocity must be backdated or every deal reads "recent/steady"

The single most important realism lever at load time is **backdated timestamps**. Activity that all lands "today" makes every deal look identically fresh and the data loses its predictive punch. The generator spreads Opportunity dates over ~3 years and backdates the activity stream (emails/tasks/transcripts) along each deal's sentiment trajectory, so:

- a **stalled / at-risk** deal has its activity 14–28 days back with little in the last 14 (champion-silence shape),
- a **ghosted** deal's last touch is > 30 days back,
- a **healthy accelerating** deal front-loads activity into the recent window.

When seeding into a real org, control the activity `ActivityDate` / created timestamps to match the archetype — flat same-day timestamps flatten the whole dataset. (Archetype-by-archetype recipes live in [`narrative-design.md`](narrative-design.md).)

### 4c. The cohort requirement (so comparisons have something to compare against)

Any "this deal vs your comparable closed-wons" comparison needs a **populated band**. The deal-size bands are the six fixed Amount tiers in `SALESCLOUD_VARIABILITY` (`LT10K`, `10K_50K`, `50K_100K`, `100K_250K`, `250K_1M`, `GTE1M`; contiguous, exclusive-on-ceiling). **A band with only one deal produces no comparison** — so the seeder populates **multiple Closed-Won deals per band**. Likewise, account-level churn/white-space realism needs **multiple Opps per Account + a Closed-Lost + cross-deal history** and a declining sentiment arc across the activity stream.

### 4d. Realism gate + judge (copy quality)

Copy quality is validated upstream of load, in `fill-copy`: a realism **gate** (lint → regenerate the offending strings) and an **LLM-as-VP judge** keep generated prose from reading as AI slop before it's ever written to an org. This is why the load step can trust the copy it inserts. (Canonical: [`docs/copy-layer.md`](copy-layer.md).)

---

## 5. Quick reference — failure-mode lookup

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` on Task/Event/Case | a non-canonical picklist value | Use the exact values in `packs/salescloud/src/picklists.ts` (§2b) — e.g. Task.Status, never "Open"; Case uses "Medium", Task uses "Normal" |
| `OpportunityLineItem` insert fails | no active standard Pricebook / no matching `PricebookEntry` | Load Product2 → PricebookEntry before any OLI (§2b) |
| ContentVersion transcript missing / unlinked in the org | `VersionData` not base64-encoded or `FirstPublishLocationId` not set | Base64-encode `VersionData` + set `FirstPublishLocationId` for the Salesforce sink (§2c); the file sink stores plain text |
| Every deal reads "recent/steady" | flat same-day activity timestamps | Backdate the activity stream to match each archetype (§4b) |
| Comparison/benchmark shows nothing | only one deal in a size band | Seed multiple Closed-Won deals per band (§4c) |
| Re-run created duplicates | a transactional object treated as a catalog object (or vice versa) | Catalog upserts by natural key; transactional records skip-existing by name/query (§3) |
| CI baseline reds across all PRs after seeding | seeded/deployed into a shared CI org | Seed scratch only; never dev-deploy new test classes to a shared org (§1b) |
| Teardown left orphan children | deleted masters before children | `teardown-demo` deletes reverse-dependency (children first); re-run it (§3) |

---

## Related docs in this repo

- [`CLAUDE.md`](../CLAUDE.md) — canonical orientation: the object model, op contract, picklist guardrails.
- [`app-architecture.md`](app-architecture.md) — the authoritative engine architecture (the `NarrativeBundle` seam, the op lifecycle).
- [`narrative-design.md`](narrative-design.md) — the variability matrix, deal archetypes, copy realism, the no-vapor-ware rule.
- [`source-variety.md`](source-variety.md) — the per-copy-kind input-format contracts (EmailMessage body, Task note, ContentVersion VTT transcript).
- [`copy-layer.md`](copy-layer.md) — the provider chain (anthropic → claude-code → static) + the realism gate + the LLM-as-VP judge.
- [`registry-and-dispersement.md`](registry-and-dispersement.md) — the dataset registry + sinks (generate once, disperse many).
- [`design/corpus-warehouse.md`](design/corpus-warehouse.md) — the deterministic rebuildable 100K-account corpus (`materialize` / `warehouse`).
