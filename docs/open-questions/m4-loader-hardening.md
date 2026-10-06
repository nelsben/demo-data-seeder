# M4 loader — deferred hardening

Parked items from the loader adversarial review. The cheap correctness gaps were
already fixed (request-level insert resilience; `verify()` now checks Opportunities so
a half-load fails loudly). These two are real but larger and are scoped to later work.
Recorded here so they aren't silently forgotten. The objects below are all standard
Sales Cloud objects — see CLAUDE.md §4 for the object model.

## 1. Sentinel-namespaced dedup (review #3 — medium)
**Now:** idempotency dedupes on bare `Account.Name`. In a dedicated demo/scratch org
(the primary target, which starts empty) this is correct and clean. **Risk:** in a
shared/customer org, a pre-existing Account literally named after an anchor (a real
"Stripe") suppresses the seeded subtree; and two different seeds drawing the same
anchor collide.
**Fix (when we target shared/customer orgs):** write a sentinel the dedup scopes to —
a `[DATASEED:<seed>]` marker in a *filterable* standard field (NOT `Description` — Long
Text Areas aren't SOQL-filterable; a short text field like `Account.AccountNumber` or
`Site` works). Dedupe on `Name AND <sentinel>` so unrelated records never collide and
same-seed re-runs stay idempotent. Aligns with CLAUDE.md's "resolve org records by
name/query, never by literal Id" rule. (No `__c` external-id field — this repo seeds
only standard objects.)

## 2. Per-child backfill / partial-load recovery (review #2, #5 — high)
**Now:** idempotency is root-Account-grained. A load that fails part-way (Accounts
committed, children not — no cross-object transaction) is not auto-healed: a default
re-run sees the Account exists and cascade-skips its whole subtree. `verify()` now
catches this (checks Opportunities), so it fails loudly. **Recovery shipped:**
`teardown-demo` deletes the seeded subtree (reverse order, parent-scoped, dry-run by
default) so the org can be cleanly re-loaded — `teardown-demo --yes` then re-`load-demo`.
**Still open (Diff & Review, M7):** dedupe each child object on a stable natural key
(Contact by Email, Opportunity by Name, OCR by Opp+Contact, EmailMessage by
Subject+MessageDate) so missing children backfill under an existing Account while
complete ones are skipped — true additive idempotency that "reproduces the beat on
re-synthesis." Pairs naturally with the teardown op.

## 3. ContentVersion transcript load to a Salesforce sink — ✅ RESOLVED (PR #74, #75)
**Was:** a Salesforce-sink load of `ContentVersion` needs `VersionData` **base64-encoded**
and the Opportunity link via `FirstPublishLocationId`; the generic loader sent plain text,
so transcripts landed as binary garbage (or unlinked). **Live-confirmed defect** on the
first warehouse→org load.
**Fixed:** the loader (`loadBundle`) now base64-encodes a non-empty `ContentVersion.VersionData`
on the way out (the Salesforce-sink path — the file sink still stores plain text). The
Opportunity link already resolves through the generic `_ref` → `FirstPublishLocationId`
(Salesforce auto-creates the `ContentDocumentLink`). Empty deferred-copy `VersionData`
(a materialized corpus loaded without fill-copy) is **skipped**, not failed (PR #75).
Live-proven: a loaded transcript downloads as readable WEBVTT, linked to its Opp.

## 4. Blank foreground bodies in a no-fill-copy (warehouse) corpus (medium, realism)
**Now:** `materialize`/`warehouse` build the structural bundle with **deferred** CopyRequests —
foreground EmailMessage `TextBody`, Task `Description`, ContentVersion `VersionData` are
empty until the separate `fill-copy` (LLM) step runs. The **bulk** tier fills everything
combinatorially (self-contained), but the **foreground** tier does not. So a warehouse
slice that includes foreground accounts (they emit first → first in the slice) loads them
with **blank emails/tasks** (valid but empty) and **skipped transcripts** (empty VersionData,
PR #75). On a real corpus this is ~14 blank emails + 6 blank tasks per ~2 foreground accounts.
**The design question (defer — Ben):** the warehouse→org bridge is really a **bulk-scale**
vehicle; hero foreground accounts are meant to go through `load-demo` (plan → fill-copy →
load). Options: (a) `load-warehouse` / `buildWarehouseSlice` prefers **bulk-tier** accounts
(`_meta.tier==="bulk"`), so the bridge never lands blank foreground shells — clean semantic
split (warehouse = scale, load-demo = hero); (b) `materialize` runs the **static** copy floor
(deterministic, no API) so every body is non-empty in the corpus itself — aligns with "static
is the always-on deterministic floor", but couples materialize→copy and must handle the
streaming path. Leaning (a) (smaller, matches the bridge's purpose). Until decided, the loader
correctly skips/loads what it can (no failures), but foreground-in-warehouse reads thin.
