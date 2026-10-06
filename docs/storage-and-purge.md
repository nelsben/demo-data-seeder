# Storage & purge

## Why

On 2026-09-04 the demo org hit `DataStorageMB` **0/5** and the demo deploy failed for a
night, because nothing in the tooling could (a) show what was filling it or (b) delete
a targeted set of rows to recover. Ben's standing policy:

> Data deletion is fine — that's the whole point of the data server: on-demand data for
> demo purposes, but also for testing purposes. The seeder is the sanctioned
> create-AND-delete tool.

`storage` and `purge` are the two ops that make that real. `storage` is read-only.
`purge` is dry-run by default and only touches an org when you pass `--yes`.

## `storage` — see what's filling an org (read-only)

```bash
node run-op.js run storage --org <alias>
```

Prints:

1. `DataStorageMB` and `FileStorageMB` remaining/max, from `sf org list limits`.
2. A row census: `COUNT()` per sObject across a fixed standard-object list (the objects
   the seeder writes: `Account`, `Contact`, `Lead`, `Opportunity`,
   `OpportunityContactRole`, `Task`, `Event`, `EmailMessage`, `ContentVersion`,
   `ContentDocumentLink`, `Case`, `CaseComment`, `Campaign`, `CampaignMember`, `Asset`)
   **plus every custom object that exists in the org**, discovered via
   `sf sobject list --sobject custom` (Custom Metadata Types `__mdt` and Platform
   Events `__e` are excluded — the former is config, not row-counted "data"; the
   latter isn't queryable/countable via SOQL at all).
3. The census sorted descending by row count, top 20 shown, each with an estimated MB
   at `RECORDS_PER_MB` (512 rows/MB — the same platform constant `profile-org`'s
   record-budget math already uses, i.e. ~2 KB/row).

**Never modifies anything.** A `COUNT()` that fails for one object (no access, not
queryable, etc.) prints `?` for that row instead of aborting — the op always exits 0.
A JSON copy of the report lands at `.dataseed/storage/<org>.json`.

## `purge` — delete a targeted set of rows (dry-run by default)

```bash
node run-op.js run purge --org <alias> --sobject <ApiName> \
  [--where "<SOQL where clause>"] [--older-than-days N] [--date-field <Field>] \
  [--limit N] [--all] [--yes] [--hard-delete]
```

- **You must scope the delete.** Pass `--where` and/or `--older-than-days` (AND-ed
  together when both are given). With neither, `purge` refuses — pass `--all`
  explicitly to purge every row of `--sobject` on purpose. This is the guard against
  an accidental bare purge.
- **The DENY list wins even over `--all`.** `purge` refuses outright on:
  `User`, `Profile`, `PermissionSet`, `Organization`, any `*__mdt` (Custom Metadata
  Type — config, never data). An installed app's own custom config objects are NOT
  hardcoded here (the engine stays domain-agnostic). Protect them **per working copy**
  instead — both sources are optional and merged with the built-in list:
  `DATASEED_PURGE_DENY="My_Config__c,My_Rule__c"` (env, comma-separated) and/or
  `.dataseed/purge-deny.json` (a JSON array of API names; `.dataseed/` is gitignored).
  A malformed file is ignored (fail-soft) — the built-in list always applies.
- **Dry run (default, no `--yes`).** Prints the plan — object, predicate, matched
  count, a sample of 5 Ids (with `Name`/`Subject`/`Title` when the object has one),
  and the estimated MB that would free — and writes nothing.
- **`--yes`** fetches the matching Ids (capped at `--limit`, or 10,000 as a safety
  valve when you don't pass one) and deletes them in batches of 200 (the same REST
  chunking `connection.ts` already uses everywhere else in this repo). The manifest is
  **durable across a crash mid-delete**, not just a post-hoc report: it's written to
  `.dataseed/purge/<org>/<timestamp>.json` (object, predicate, the Ids involved,
  matched/deleted counts — same shape family as the other op reports in this repo,
  teardown's report and the load report) — plus a stable
  `.dataseed/purge/<org>/<sobject>.latest.json` pointer that `verify()` reads back —
  THREE times per real purge: once with `status: "planned"` (the full candidate Id set,
  before the first chunk deletes anything), once with `status: "in_progress"` after
  **every** chunk (the Ids deleted so far), and a final `status: "done"` once every
  chunk completes. A crash between chunks leaves the last `"in_progress"` write on
  disk, so `verify()` can still report exactly how many of how many deleted before it
  stopped, instead of finding nothing at all.
- **`--hard-delete`** tries the Bulk API's `hardDelete` operation (bypasses the
  Recycle Bin entirely), guarded by a **deterministic pre-check plus an error-message
  fallback as a second net**:
  1. **Pre-check (first, deterministic):** `SELECT PermissionsBulkApiHardDelete FROM
     UserPermissionAccess` — a one-row pseudo-object implicitly scoped to the running
     user. If it comes back `false`, the Bulk API is never even attempted: `purge` goes
     straight to soft-delete + `emptyRecycleBin` and logs one line (`"<sobject>: user
     lacks Bulk API Hard Delete; soft delete + empty recycle bin"`). The result is
     cached per run (one query, not one per chunk). If the query itself fails
     (unresolvable — an older API version, a describe hiccup), that's treated as "can't
     tell," **not** "definitely no": the code falls through and actually attempts the
     Bulk API, letting the error-message net below decide.
  2. **Error-message fallback (second net):** if the pre-check said yes (or couldn't
     tell) but the Bulk API rejects the call anyway, the error is matched against two
     known fragments, case-insensitively:
     - `"Bulk API Hard Delete"` — the sf CLI's own client-side `plugin-data`
       pre-check message. This repo never goes through that CLI command, so this
       fragment is speculative insurance, not something observed here.
     - `"requires special user profile permission"` — the **RAW jsforce Bulk API
       error this class actually hits**, captured LIVE against `dev-frontend`
       (2026-09-05, org user lacking the permission): `name` and `errorCode` were
       both `FeatureNotEnabled`, and `.message` was, verbatim:
       > `hardDelete operation requires special user profile permission, please contact your system administrator`

       Since `deleteRows` calls jsforce `bulk.load(..., "hardDelete")` **directly**
       (never the sf CLI), this second fragment is the one that matters in practice —
       it's exactly what `dev-frontend`'s scratch-org user hits, confirming that org's
       user does **not** hold Bulk API Hard Delete (matching what the deterministic
       pre-check independently reports there).

     Either match triggers the same fallback: a normal (soft) delete immediately
     followed by `emptyRecycleBin` (the SOAP API call jsforce exposes as
     `conn.soap.emptyRecycleBin(ids)`) for whichever rows soft-deleted — so storage
     still actually frees rather than waiting out the Recycle Bin's retention window.
     Any OTHER hard-delete failure (a transport blip, a genuinely bad Id) matches
     neither fragment and is **not** swallowed into the fallback — it propagates, so a
     real problem is never silently masked as a permission issue. On the fallback
     path, an `emptyRecycleBin` error reading "no recycle bin entry found" (observed
     live: a row already purged elsewhere in the same transaction) is treated as
     success, not a failure — the row is gone either way.
- **`verify`** re-runs the `COUNT()` and expects it to have dropped to at most
  `matchedCount − deletedCount` (0 in the common case); it exits **4** if the count
  did not drop, and prints the post-delete `DataStorageMB`.

### Why `--hard-delete` matters — the Recycle Bin fact, cited

A **soft** delete (the default) does not free `DataStorageMB` by itself: the deleted
rows sit in the org's Recycle Bin, and **rows in the Recycle Bin continue to count
against the org's data storage allocation** until the bin is emptied, the row is
manually purged, or it ages out — Salesforce's default retention is **15 days**, and
the bin's own capacity is roughly 25× the org's storage allocation in record count
before older entries are evicted early. This is *why* "empty the Recycle Bin" is the
standard first troubleshooting step for a storage-maxed org, and why `purge` treats
`--hard-delete` as a distinct, more powerful mode rather than a cosmetic flag.

Sources: Salesforce Help, *Data and File Storage Allocations*
(`help.salesforce.com` article id `xcloud.overview_storage.htm`) and *Recycle Bin*
(article id `xcloud.recycle_bin.htm`) — both are JS-rendered pages that couldn't be
captured verbatim by an automated fetch during this doc's verification pass, so the
statement above is corroborated against multiple independent practitioner write-ups
that agree with each other and with the platform's well-known operational behavior:
[Flosum — 10 Tips to Navigate Salesforce Storage Limits](https://www.flosum.com/blog/salesforce-storage-limits),
[GRAX — Salesforce Recycle Bin Limits](https://www.grax.com/blog/salesforce-recycle-bin-limits/),
[CapStorm — How to Overcome 15-Day Limits to Salesforce's Recycle Bin](https://www.capstorm.com/blog/data-unleashed-recycle-bin-limits/).
If you need a load-bearing citation for an external audience, verify directly against
the two `help.salesforce.com` articles above in a signed-in browser session.

The **Bulk API Hard Delete** permission itself is not on the standard System
Administrator profile — it must be granted via a permission set. See
[Salesforce Help — How to Enable the Bulk API Hard Delete Permission](https://help.salesforce.com/s/articleView?language=en_US&id=000328731&type=1).

## How to free a maxed-out demo org in 3 commands

```bash
# 1. See what's filling it
node run-op.js run storage --org <alias>

# 2. Preview the delete (dry run — nothing happens yet)
node run-op.js run purge --org <alias> --sobject Task --older-than-days 30

# 3. Actually delete, bypassing the Recycle Bin so storage really frees
node run-op.js run purge --org <alias> --sobject Task --older-than-days 30 --yes --hard-delete
```

Re-run `storage` afterward to confirm `DataStorageMB` recovered.

## Testing

Pure modules, no live org (`packages/engine/test/`):

- `purge-plan.test.ts` — predicate composition, the bare-purge refusal, the DENY-list
  refusal, 200-row chunking, and the manifest round-trip.
- `purge-run.test.ts` — dry-run never calls `deleteRows`; `--yes` calls it once per
  200-row chunk; `--hard-delete` passes through to every chunk; `verifyPurge`'s
  exit-4 case (the count didn't drop); the incremental manifest (`planned` before the
  first chunk, `in_progress` after every chunk, `done` at the end) — including a
  simulated crash on chunk 2 of 3 that leaves exactly chunk 1's Ids on disk.
- `storage-census.test.ts` — census sorting, the `?` display for a failed count, and
  the MB estimate.
- `connection-harddelete.test.ts` — `JsforceLoadTarget#deleteRows({ hardDelete: true })`:
  the deterministic `UserPermissionAccess` pre-check's three outcomes (`false` skips
  the Bulk API entirely and logs one line; `true` attempts it normally; an
  unresolvable/throwing query falls through to attempting it, matching pre-pre-check
  behavior); both error-message fallback fragments (the sf-CLI-style string and the
  RAW jsforce string captured live, see above) trigger the same soft-delete +
  `emptyRecycleBin` fallback for the same Ids; any OTHER hardDeleteBulk error is NOT
  swallowed into that fallback; a "no recycle bin entry found" `emptyRecycleBin` error
  is treated as success.
- `purge-op.test.ts` — direct coverage of `ops/purge.ts`'s two op-level (not
  pure-module) pieces that `purge-run.test.ts` can't reach: `fsManifestWriter` actually
  writes both the timestamped audit file and the stable `<sobject>.latest.json`
  pointer to a real (throwaway, cleaned-up) filesystem location, and `verify()`'s
  status-aware branch reports `success: false` with an honest "did not complete"
  reason off a manifest left at `"planned"` or `"in_progress"` (`SfCliClient` is
  mocked at the module boundary for the live re-count `verify()` always issues on
  `--yes`, mirroring how `teardown-demo`'s `verify()` also needs a live client).

Live validation (a disposable dev org only — **never** a shared CI-validate org):
`storage`, then `purge --sobject Task --older-than-days 30` dry-run, then
`--yes`, then `storage` again — outputs pasted in the PR that introduced these ops.
Separately (2026-09-05), the raw jsforce Bulk API `hardDelete` error text quoted above
was captured live against `dev-frontend` by calling the (otherwise private)
`hardDeleteBulk` path directly on a handful of throwaway `Task` rows, bypassing the
pre-check/regex on purpose to force the real Salesforce error to surface; the rows
were then confirmed soft-deleted in cleanup. `dev-frontend`'s scratch-org user does
**not** hold Bulk API Hard Delete, so both the deterministic pre-check and the
error-message fallback are exercised for real on that org today.
