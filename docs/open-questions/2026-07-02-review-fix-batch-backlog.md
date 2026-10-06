# Review fix batch — what shipped and what's deferred (2026-07-02)

**Context.** A full-repo review (structure, generation, data quality — multi-agent survey +
adversarial verify) surfaced 52 findings. All HIGH-severity correctness/data-quality bugs plus the
cheap high-value MEDIUM/LOW ones shipped in this pass (GENERATOR_VERSION 28 → 29): Opp name
deduplication, churn `daysToRenewal` derivation, `PERSONA_DETAIL` title variety, sentiment-aware
Task Priority, a fixed seller-domain constant (`SELLER_DOMAIN`) for AE/rep email addresses, a
5-scenario prior-Case history pool with a real `ClosedDate`, OLI/Amount reconciliation (license
qty/price no longer silently drifts from `Amount`), the MongoDB/Snowflake/Confluent self-product
anchor exclusion (from the realism-audit backlog, now resolved), the `static`
copy provider's scenario coverage (3 → 5 ARC entries, 2 variants per beat so re-runs don't read
identical), a `CopyProviderId` schema cleanup (dropped the never-implemented `"einstein"` value),
a `ScopeParams.strict()` tightening, an `authorIdentities()` cache-bypass fix (mirrors
`authorDossiers()` — a `--provider static` run no longer risks serving a stale LLM-authored
identity from a prior run's cache), MCP `generate_dataset` DoS-guard clamps + a `disperse()` /
`disperse-demo` op `org` fallback fix, a warehouse `local_ref` index (was a full-table scan at
100K-account scale), and `teardown-demo` gaining `--warehouse`/`--dsId`/`--accounts`/`--leads` so
a warehouse-sourced load can be torn down (previously only registry-dataset loads could).
`pnpm -r typecheck` and `pnpm -r --if-present test` are green (528 tests) after the batch.

**Update (same day, second slice): `teardown-demo` extended from 4 to 12 object types + a
converted-Lead orphan fix.** Re-investigating item #1 below (originally scoped as "real work,
deferred") turned up something bigger: a live-repo audit (loader insert order vs. teardown's
delete plan) found `teardownBundle` only ever deleted `EmailMessage`/`Opportunity`/`Contact`/
`Account` — 4 of the ~14 non-catalog objects the loader actually inserts. It turned out the
`ContentVersion` gap generalized to **six more objects with zero `LoadTarget` interface changes
needed** (the `queryIds`/`deleteRecords` pair was already fully generic — see item #1's
resolution below), so this shipped as its own fix rather than staying deferred:
- `teardownBundle` now deletes, in reverse-dependency order: `CaseComment` → `CampaignMember` →
  `ContentDocument` (the transcript file — deleted via the parent doc, since a `ContentVersion`
  can't be deleted directly; see item #1's live correction) → `Task` → `Event` → `EmailMessage` →
  `Opportunity` → `Case` → `Asset` → `Contact` → `Lead` → `Account`. Catalog objects (`Product2`, `PricebookEntry`, `Campaign`,
  `UserRole`, `User`) are structurally excluded — the plan array is a static literal, never
  derived from `pack.objects`.
- **A converted-Lead adversarial finding, also fixed:** `bundle.directives.convertLeads` entries
  carry no `accountRef`, so Salesforce's `convertLead` mints a brand-new Account named after
  `Lead.Company` — a name that never appears in `records.Account` and was previously permanently
  un-teardownable (every demo/teardown/reseed cycle on the "burn one org" scratch-org workflow
  would leave one more orphaned Account+Contact+Opportunity chain behind). Fixed by also treating
  `Lead.Company` values as candidate seeded-Account names (harmless no-op for a Lead that never
  converted) — no schema or interface change, reuses the existing Name-matching machinery.
- Two independent adversarial reviews ran against this change given its destructive/live-org
  blast radius: a full parent-field audit (every teardown query field cross-checked against the
  generator's actual `_refs` keys) and a completeness audit (every `SALESCLOUD_LOAD_ORDER` object
  accounted for). A new `packs/salescloud/test/teardown-field-contract.test.ts` now pins teardown's
  field assumptions against a REAL generated bundle (not just the hand-rolled unit-test mock), so a
  future `_refs` key rename in `generate.ts` fails loudly here instead of silently orphaning data
  in a live org (previously: a rename would make `queryIds` match zero rows, and "0 matched" reads
  identically to a legitimate empty result). `pnpm -r typecheck`/`test` green, 555 tests.
- Two lower-priority findings from that review were **not** fixed (see items 4 and 5 below):
  unbounded SOQL pagination in `queryIds` (pre-existing infra, now reachable through more/larger
  queries), and the `--accounts`/`--leads` mismatch footgun on warehouse-sourced teardown.

Below are the genuinely new items that came out of the review but were deliberately **not**
fixed in this pass — either because they're a product/design decision that needs Ben's input, or
because the fix has real ripple (touches a public interface across several files) and deserves its
own slice rather than riding along. Each states the question, the working assumption, and what
would force a decision, per this directory's convention.

## 1. ContentVersion (transcript) rows never deleted on teardown — ✅ RESOLVED (see update above)

**Was:** `teardownBundle` had no step for `ContentVersion`, and this item was originally scoped as
requiring a `LoadTarget` interface extension (a `findContentDocumentIds`-shaped method) across the
real implementation + 5 test mocks — real work, deferred.

**What actually shipped:** re-investigation found `ContentVersion.FirstPublishLocationId` is a
directly filterable field the generator already writes (`generate.ts:1118,1687`), so teardown can
scope transcripts to the seeded opps with the generic `LoadTarget` query interface. That same
investigation found teardown was missing six OTHER object types too, all fixable the same
zero-interface-change way — see the update above for the full list.

**Live smoke-test correction (2026-07-04, org-verified on `burn`):** the carried-forward
"a sole-version `ContentVersion` delete cascades to its `ContentDocument`" assumption is **FALSE**.
Deleting a `ContentVersion` directly returns `INSUFFICIENT_ACCESS_OR_READONLY: insufficient access
rights on object id` — even for a single-version document — and leaves BOTH the version and the
document in place. So the first cut (`deleteRecords("ContentVersion", …)`) would have silently
orphaned every transcript file on every teardown. Verified fix: delete the parent **`ContentDocument`**
(deleting it cascades its version away, confirmed live). Teardown now resolves the parent
`ContentDocumentId` via a new optional `LoadTarget.queryField` (a generalization of `queryIds` with
an arbitrary `SELECT` field; `queryIds` delegates to it) and deletes `ContentDocument`, deduped. The
plan step is `ContentDocument`, not `ContentVersion`; `teardown.test.ts` asserts the version is never
deleted directly (regression guard). Live end-to-end proof: real `teardownBundle` on `burn` deleted
1 `ContentDocument` (failed=0) and the `ContentVersion` cascaded to 0.

## 2. `SeedMode`/`DcMode` are vestigial but still on the schema

**Now:** this pass folded `mode`/`withDc` out of the warehouse cache key (they no longer cause
needless cache misses — see the `cache-key.ts` v29 changelog) and documented both exports in
`packages/core/src/scope-params.ts` as unread by any current pack. The fields themselves are
still on `ScopeParams` and still accepted/validated on every plan.

**Why deferred:** removing them is a breaking schema change for anything constructing
`ScopeParams` externally (the web app, MCP callers, saved plans) — wider blast radius than a
same-pass cleanup should take on unilaterally.

**Working assumption:** leave as documented-vestigial until a pack actually needs a seeding-mode
axis again, then either repurpose or formally deprecate+remove with a schema version bump.

## 3. `registerBundle`'s content-addressing is org-independent (now documented, not changed)

**Now:** `datasetIdFromBundle(pack, records)` (`packages/registry/src/id.ts`) hashes on `(pack,
records)` only — `org` never enters the id. `registerBundle()` in
`packages/engine/src/service/dataset-service.ts` upserts by that id, so registering
byte-identical records under two different `org` values overwrites the stored `params.org` on the
same row. A comment is now in place at the `registerBundle` call site explaining this and stating
the rule: callers of an imported/registered bundle must disperse by the returned `datasetId`,
never by org-based resolution.

**Why deferred (documented, not fixed):** salting the id with `org` for the import path only
would fix the overwrite but changes id stability for every existing registered-bundle caller —
needs a look at every `datasetIdFromBundle`/`registerBundle` call site before changing the
hash inputs, which is more scope than this pass's "fix confirmed bugs" mandate.

**Working assumption:** the documented caller contract (disperse by id) is sufficient while the
only registrant is this repo's own tooling. Revisit if/when an external caller starts registering
bundles under varying `org` values for the same record set.

## 4. `queryIds`/`existingValues`/`idsByField` don't paginate past one SOQL page (pre-existing)

**Now:** `JsforceLoadTarget`'s query-based methods (`packages/engine/src/load/connection.ts`)
call `this.conn.query(...)` with jsforce's default `autoFetch:false` — a single call only returns
the first REST query page (~2,000 rows); `res.done`/`nextRecordsUrl` are never checked, and
`queryMore` is never called. If any single `WHERE field IN (≤200 ids)` batch has more than ~2,000
matching child rows, the excess is silently dropped: no error, the `matched` count under-reports,
`teardownBundle` reports success, and the excess children survive untouched.

**Why deferred:** pre-existing (not introduced by the teardown extension), and fixing it properly
means adding `queryMore` pagination to a shared low-level helper used by several `LoadTarget`
methods — worth its own slice with its own tests, not a ride-along. The teardown extension does
make this more *reachable* than before, since `CampaignMember`/`Task`/`EmailMessage`/
`ContentDocument`/`Case`/`Asset`/`CaseComment` now all route through `queryIds` (or `queryField`
for the ContentDocument resolution, which shares the same un-paginated `CHUNK` helper), and those
are exactly the objects whose per-account fan-out scales into the hundreds of thousands at corpus
scale (see `project_bulk_tier_v15.md` in memory).

**Working assumption:** low risk at today's actual usage (a single teardown's per-parent-batch
child count rarely approaches 2,000 in practice — dozens of Tasks/Emails per Opportunity, not
thousands). Revisit if `teardown-demo --accounts` is ever run at a size where a single 200-Id
batch's children could plausibly exceed ~2,000.

## 5. Warehouse-sourced teardown trusts `--accounts`/`--leads` to match the original load

**Now:** `teardown-demo --warehouse ... --dsId ...` re-slices the corpus with `{accounts:
args.accounts ?? 100, leads: args.leads ?? 0}` — if these don't match the values you actually
loaded with (`load-warehouse --accounts 500 --leads 200`, then tearing down with the
`accounts:100, leads:0` defaults), the slice silently resolves a SMALLER set than what's in the
org. Teardown reports a clean, successful deletion of "the seeded records" while hundreds of
account subtrees and leads permanently survive, with no error or mismatch warning.

**Why deferred:** the code's own comments already flag this ("pass the SAME --accounts/--dsId/
--warehouse you loaded with"), and closing it properly needs a persisted "what did I actually
load" manifest (recorded by `load-warehouse`, read back by `teardown-demo`) rather than trusting
repeated CLI args — a small but real design addition, not a one-line fix.

**Working assumption:** acceptable given today's usage is a single operator running both commands
by hand in the same session. Revisit if warehouse-sourced load/teardown becomes a scripted/CI path
where a mismatched re-invocation is more likely.

## 6. Minor / low-priority (noted, no action needed yet)

- **`GenerateContext.asOf` duplicates `plan.asOf`.** Redundant field, never observed to drift, but
  two sources of truth for the same value. Low priority — collapse to one when next touching
  `GenerateContext`.
- **Registry SQLite `PRAGMA foreign_keys = ON` is a no-op** — no FK constraints are actually
  declared in the schema, so the pragma buys nothing today. Harmless; worth adding real FKs only
  if the registry schema grows enough to benefit from cascade/restrict semantics.
- **`cascade`/`accounts` arg vocabulary is inconsistent across ops** — `load-warehouse`'s
  `cascade: "on"|"off"` vs. the sink layer's `"auto"|"off"`; `--accounts` means "how many to
  slice" in `load-warehouse` but "how many to tear down" in `teardown-demo`. Confusing but not
  incorrect. A naming pass across `apps/cli`'s op args would clean this up; low priority.
- **Bulk `Event.Subject` can produce odd combinations** (e.g., "Demo: the thread" when the
  template's noun phrase doesn't fit the sentence frame). Cosmetic, population-tier only (no
  foreground copy bar to clear). Fix by auditing the subject-template × filler cross-product in
  the bulk Event generator.

## Already tracked elsewhere (confirmed still open, not duplicated here)

- **Idempotency sentinel field for shared/customer orgs** + **per-child natural-key backfill on
  partial load** — `m4-loader-hardening.md` items 1 and 2.
- **Blank foreground bodies in a no-fill-copy warehouse slice** + **load-warehouse tier
  preference** — `m4-loader-hardening.md` item 4.
- **Bulk-tier ZIP/phone area-code state coherence** — `2026-06-25-wave2-deferrals.md` items 3–4.
- **Non-Claude judge option, hero-deal curated set, silence-beat design call** —
  `docs/design/realism-playbook.md`.
- **LLM multi-artifact consistency, template-mold beat-structure variety, persona
  title-vs-behavior drift, BOM/OLI copy-vs-line-item module mismatch** —
  carried from the realism-audit backlog (items 2–5; that audit log is no longer in this repo).
