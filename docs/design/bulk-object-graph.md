# Bulk Sales-Cloud object graph (the North Star)

**Goal:** point at any org → generate **100K accounts × detailed, realistic data across ALL core
Sales Cloud objects**, deterministically, MCP-callable, load-correct. The bulk/population tier
(`scope.population`) is the scale lever; this doc is the canonical design for the wider object graph
layered onto it. The seeder produces **standard Salesforce objects only** (no `__c`) — see the
repo-root [CLAUDE.md](../../CLAUDE.md) for the authoritative framing and object list. It is the
synthesis of an 8-agent design fan-out + two adversarial critics (the critics caught real load bugs —
see "Picklist corrections" — believe them over a clean-looking draft).

## The density model

One knob — **`scope.bulkDensity`** (0–1, default 0.6) — scales how richly each bulk account is
fleshed out beyond its structural skeleton (Account + Contacts + power-law Opps + one primary OCR):

- `0.0` = pure structural skeleton (~7 records/account) — cheapest, the bare population tier.
- `0.6` = populated-but-affordable (default) — ~14 records/account.
- `1.0` = full graph (~19 records/account) — committees + activity timelines + Assets + Cases.

The plan's record-budget clamp is **density-aware**: `recordsPerPopulationUnitEstimate` (7, structural)
`+ bulkDensity × recordsPerPopulationUnitFullDensityDelta` (12, the wider graph at full density). A
denser run therefore clamps `population` to fewer accounts so storage never silently blows past the
org's `recordBudget`. **Storage reality:** at ~2KB/record, full density × 100K accounts ≈ 2.4M records
≈ ~4.8GB — *exceeds* the 5GB cap of many Dev-Edition / small scratch orgs. Dial `bulkDensity` (or
`population`) down for those; the clamp warns via `plan.budgetCapped`.

## The bulk object families — pack-only, zero-cascade

All emitted in the bulk loop of [generate.ts](../../packs/salescloud/src/generate.ts), tagged
`_meta.tier='bulk'`, scaled by density, fully deterministic (dedicated per-account `bulk` seed stream):

| Family | What | Cascade-safe because |
|---|---|---|
| **OCR expansion** | 1–3 distinct-role committee members/opp (exactly one `IsPrimary`), capped at contact count | structural |
| **Activities — Task** | logged calls/admin, backdated `ActivityDate`, valid `Status`/`Priority` | **omits `TaskSubtype`** → no EAC email-sync fan-out |
| **Activities — Event** | demos/meetings, `Start`/`End` window, `ShowAs` | inert by construction — no downstream automation |
| **Assets** | installed base on **Customer** accounts w/ won history; refs shared `Product2` catalog | not a cascade object |
| **Cases (+ CaseComment)** | post-sale support history on **Customer** accounts, power-law tail-capped 12 | not a cascade object |

**Cascade accounting is tier-aware** ([cascade.ts](../../packages/engine/src/sinks/cascade.ts)): when
a Salesforce sink loads with `cascade:"off"`, the engine drops the *foreground* copy streams (the
EmailMessage/Task/transcript records a target org's automation or Einstein Activity Capture would fan
on insert) so a bulk fill lands purely structurally. A `_meta.tier='bulk'` record of a cascade object
(e.g. a subtype-less bulk Task) fires nothing, so it is **excluded** from `cascadeEstimate` (it would
otherwise overstate the blast radius by ~578K at 100K) and **kept** by `excludeCascade` (a
`cascade:"off"` structural load still gets its activity timeline).

## Picklist corrections (the critics' catches — these would have red-loaded)

Standard-object picklists live in [picklists.ts](../../packs/salescloud/src/picklists.ts), guarded by
Zod in [schemas.ts](../../packs/salescloud/src/schemas.ts). The draft **invented** several; the
verified standard-default sets:

- **`TaskSubtype`** — draft listed `{Call|Email|LogACall|Cadence|…}`. Bulk Tasks **OMIT it entirely**
  (a plain Task is inert and load-safe everywhere). Only the foreground sets `TaskSubtype='Email'`.
- **`Task.Status`** — `{Not Started, In Progress, Completed, Waiting on someone else, Deferred}`.
  `"Open"` (draft) is **not** a member.
- **`Task.Priority`** = `{High, Normal, Low}`; **`Case.Priority`** = `{High, Medium, Low}` (Medium, not Normal).
- **`Case.Status`** `{New, Working, Escalated, Closed}`, **`Case.Origin`** `{Phone, Email, Web}`.
- **OCR `Role`** — the narrative buying-committee uses `"Technical Evaluator"`, but that string is
  **not** in the standard OCR `Role` picklist; the loaded `OpportunityContactRole.Role` uses
  `"Technical Buyer"` (the standard member).
- **Org-configurable → OMITTED** (NULL fail-soft): `Asset.Status`, `Case.Type`/`Reason`, Task/Event subtype.
- Every new object (`Event`, `Asset`, `Case`, `CaseComment`) is registered in **both**
  `SALESCLOUD_LOAD_ORDER` and `SALESCLOUD_RECORD_SCHEMAS` — the draft left them unregistered (silent drop).

## The sales-rep User pool + OwnerId distribution

The biggest remaining realism tell (100K accounts owned by one running user) — built from a second
design fan-out + two adversarial critics (who caught a load-breaking bug: a self-referential UserRole
`ParentRoleId` can't resolve in the loader's single-pass resolve-then-batch-insert, so the planned
2-level hierarchy would have silently collapsed). The shipped v1:

- **One knob — `scope.userPoolSize`** (0–50, default **0** = off, fully backward-compatible). Resolved
  at plan-time: gated on the org exposing the `User` object, clamped to ≤50.
- **A shared, once-seeded pool** ([generate.ts](../../packs/salescloud/src/generate.ts) `emitUserPool`):
  N Users + a **flat** set of UserRoles (one per region — *not* a hierarchy; see below), drawn from a
  dedicated `userpool` rng stream so it's purely additive (zero perturbation of the bulk streams).
- **OwnerId is a `_softRef`** on bulk Account/Opp/Task/Event, assigned round-robin as a **pure function
  of the account index** (no rng draw). A whole book of business (account + its opps + their activities)
  shares one rep. The **fail-soft is the whole point**: if the pool can't seat (license-exhausted /
  Manage-Users denied — the inserts are *attempted* and fail per-row), the unresolved OwnerId soft-refs
  **drop the field and keep the record** → the org degrades cleanly to running-user ownership, never a
  skipped Account subtree. The load op surfaces a `⚠ User pool unavailable` warning when 0 users seat.
- **ProfileId** is a HARD `@existing:Profile:Name:<userProfileName>` ref (default "Standard User";
  `scope.userProfileName` is the escape hatch for license-tight orgs). **Catalog-deduped** by `Username`
  (globally unique) / `DeveloperName`, and **excluded from teardown** (Users aren't hard-deletable — the
  dedup makes persistence idempotent-safe). Foreground hero deals stay running-user-owned (so the
  demo driver still sees them in their OwnerId-scoped Home).

**Still deferred here:** the **2-level UserRole hierarchy** (needs a loader two-pass / `@existing`
top-role anchor for `ParentRoleId` — flat roles ship now); **region-territory ownership**
(`ownerStrategy: by-region` mapping a bulk account's region to that region's reps — round-robin ships
now); and an **opt-in `IsActive=false` deactivation** teardown step (parked — dedup covers correctness).

## Deferred (designed, not yet built) — the follow-on backlog, highest value first

Not shipped because each is feature-gated, license-hazardous, or lower value/cost. Captured so the
cut is explicit, not silent:

1. **Closed-Won-per-band floor** — [narrative-design.md](../narrative-design.md) wants ≥5 backdated
   Closed-Won deals **per** of the 6 deal-size bands (`LT10K`…`GTE1M`) so each band has a won cohort
   (no thin/empty bands at the top end). Bulk samples band+state independently; assert/enforce the
   per-band won cohort in the bulk opp distribution.
2. **Quote-to-cash** — Quote + QuoteLineItem (Status `Draft`, lines reconciled to Amount) on
   won/late-stage opps; Contract (Draft) + Order/OrderItem behind `--with-orders` (default off).
   Requires `Opportunity.Pricebook2Id` set once on bulk opps (shared with an OLI-expand PR).
   Loader already fail-softs absent objects via `target.exists()` — safe to add.
3. **Top-of-funnel bulk** — extend the shared Campaign catalog (~5→16), bulk Leads (~1.5×population,
   disjoint namer slice, `Lead.Status` remap-to-default fail-soft), CampaignMembers (need the
   per-campaign `CampaignMemberStatus` child rows to contain the statuses used).
4. **Account.ParentId hierarchy** — ~5–10% of bulk accounts as children of a same-Industry parent
   (self-lookup, parents-before-children) — believable enterprise parent/subsidiary structure.
5. **Account/Contact/Opp CreatedDate gradient** — backdate audit fields across a 3-year window IF the
   org has "Set Audit Fields upon Record Creation" enabled (describe-gated); else surface as a known
   limitation. Without it every logo reads net-new (no "customer since" tenure).

See the full per-family field designs in the design fan-out output (8 agents + 2 critics, 2026-06-19).
