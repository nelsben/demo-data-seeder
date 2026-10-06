# The corpus warehouse — a deterministic, rebuildable SQLite record store

> Canonical source for `@dataseed/warehouse` + the `materialize` / `warehouse` ops. The "have the data
> in a database, well-groomed, ready to connect to an org, dial up to 100K" layer — built so a corpus
> exists and is queryable WITHOUT a live org you don't have yet.

## Why this exists

The registry (`@dataseed/registry`) blobs a whole bundle as one JSON row per dataset — fine for a handful
of generated datasets, useless as "a database of all the records across all objects you can SELECT against."
The warehouse is the opposite shape: **one SQLite table per sObject**, every record a row, so the corpus
is plain-SQL queryable and joinable — and it's a deterministic **cache** of `(pack, byte-determining params,
generator version)`, so it's rebuildable, not precious. Delete it, re-`materialize`, get byte-identical rows.

## Architecture (PR1 — the materialize/write side)

- **`@dataseed/warehouse`** — depends only on `core` + `registry`, never a pack. Modules:
  - `schema.ts` — `wh_manifest` (the cache index) + per-sObject `wh_<sanitized>` tables.
  - `warehouse-store.ts` — `WarehouseStore` over `node:sqlite` (WAL, `synchronous=NORMAL`). `writeBundle`
    (eager, one transaction), `readObject` (byte-identical reconstruction), `query` (guarded read-only
    SELECT), `findByCacheKey`, `purge`.
  - `cache-key.ts` — `corpusKey(plan)` → `{paramsHash, cacheKey}` + `GENERATOR_VERSION`.
- **per-sObject table** = `ds_id, seq, local_ref, parent_ref, name, payload_json`. `payload_json` is the
  **source of truth** (the full record incl. `_ref/_refs/_softRefs/_meta`); the other columns are derived,
  promoted copies for indexing/joins. `seq` preserves emit order so `ORDER BY seq` reconstructs the bundle.
- **`materialize` op** — generate (eager) → write to the warehouse, keyed + idempotent. Run against the
  synthetic `standard` profile (`profile-org --synthetic`) to build with **no live org**. Default `asOf` is
  pinned (`2026-01-01`) so re-runs are cache no-ops.
- **`warehouse` op** — list corpora, per-object counts, sample rows, or a single read-only SELECT.

```
profile-org --org standard --pack salescloud --synthetic
materialize  --org standard --population 10000 --userPoolSize 25 --seed bench
warehouse    --sql "SELECT json_extract(payload_json,'$.StageName') stage, count(*) n FROM wh_Opportunity GROUP BY stage"
```

## What the adversarial design review changed (the critic must-fixes)

A design+critique workflow (6 agents) flagged five load-bearing risks. How PR1 answers each:

1. **"wh_refs would be the row-count dominator (3–5M edge rows)."** → **No separate edge table.** Refs ride
   inline in `payload_json`; only the one parent FK worth joining on is promoted to `parent_ref`. Row count
   = record count, not record + edge count.
2. **"A hand-curated content-hash of generator inputs silently goes stale."** → **`GENERATOR_VERSION` is an
   explicit constant the author bumps**, not a hash over a file list that forgets an input. A stale key is a
   code-review miss, not a silent corruption.
3. **Ref-locality is an invariant, not a guarantee — a future cross-account bulk ref breaks eviction
   silently.** → **`warehouse-corpus.test.ts` derives locality from the ACTUAL emitted refs** (every bulk
   ref must be index-`i`-local or a non-bulk shared ref) and fails CI the day that stops being true. The
   test trusts the refs, not a hand-set flag.
4. **"SQLite write throughput is unmodeled."** → **benchmarked, honestly** (below). Throughput is a
   non-issue; memory is the real wall.
5. **The stream-LOADER into a real org (eviction + the checkpoint that re-serializes the whole ref map at
   `loader.ts:391`) is a risky net-new rewrite.** → **deferred entirely.** You don't have a 100K org to load
   into yet; the existing loader already loads a materialized bundle at moderate scale. That rewrite is its
   own PR, gated on actually needing it.

## The honest benchmark (10K accounts, eager)

| metric | value |
|---|---|
| records | 137,658 (across 20 objects) |
| materialize time | 546 ms (≈ **250K records/sec**, generate + write combined) |
| peak RSS | **391 MB** |
| warehouse.db | 50 MB |

**Read:** throughput and disk are fine. The one wall was **memory** — eager holds the whole bundle, so RSS
scales linearly → ~3.9GB at 100K. That's what **streaming** (PR2, below) removes.

## Streaming materialize (PR2 — true 100K, bounded RSS)

`materialize` streams by default when the pack's bulk tier is **account-major** (`pack.bulkRefLocality ===
'account-major'`): generate the up-front scaffold once, then the bulk tier in account batches, writing each
batch in its own transaction. Peak RSS is bounded by **one batch**, not the corpus.

The seam is `GenerateContext.bulkRange` — `generate` emits either the scaffold (`scaffold: true`, no bulk)
or a bulk slice (`scaffold: false`, accounts `[start, end)`). It's safe to slice **only because the bulk
tier derives purely from `(seed, accountIndex)` and never reads the foreground rng** — verified in
`generate.ts` and locked by two tests: **stream-parity** (scaffold + batches is byte-identical to a full
eager generate) and **batch-invariance** (batch size never changes the bytes). The engine driver is
`streamMaterialize` (`packages/engine/src/generate/stream.ts`); it threads a per-object `seq` across batches
so `ORDER BY seq` reproduces full emit order.

| | eager (extrapolated) | **streaming (measured)** |
|---|---|---|
| 100K accounts | ~3.9 GB RSS ❌ | **~700 MB RSS ✅** |
| time | — | **~49s** (3.1M records, 20 batches, GENERATOR_VERSION 21) |
| db size | ~500 MB | ~1.1 GB |

So a full **100K-account corpus across all ~20 objects materializes in ~49s at ~700MB RSS** (the load-bearing
claim — streaming keeps RSS bounded by one batch — still holds; the record count has since grown 1.37M→3.1M as
v17–v21 added the demand-gen funnel, the EAC/ECI activity layer, and filled hero copy, so the wall time grew
with it). Byte-identical to eager, queryable, with no live org. `--eager` forces the in-memory path (parity
testing); `--batch N` tunes the RSS/throughput trade. (Re-benchmark on a generator-version bump.)

## Loading the corpus into an org

`load-warehouse` lands a bounded, account-rooted **slice** through the proven `loadBundle` (a Dev/scratch org
can't physically hold 100K accounts — storage caps). The loader auto-switches each object from REST collections
to the **Bulk API v1** at ≥5000 rows/object (`--bulkThreshold` tunes it). **Live-proven** (2026-06-22): a slice
loaded with `--bulkThreshold 50` drove the Bulk-API branch on every high-volume object — Contact, OCR,
OpportunityLineItem, EmailMessage, Task, Event, CampaignMember — **1083 records, zero failures**, records
durable + SOQL-queryable (the audit's "never-executed bulk path / activity-object eligibility" fear, retired).
Use `--bulkThreshold 50` to exercise the bulk path cheaply on a small slice.

## Deferred (follow-on)

- **Account-window stream-loader** — `load-warehouse` builds the whole slice + a monotonically growing
  ref→Id map in memory, so the max slice is bounded by RAM, not org capacity (and `--checkpoint` re-serializes
  the full ref map per object). The fix is to load accounts in windows, evicting each window's child refs once
  loaded (ref-locality is account-major, so a window's refs are dead after it). **Deliberately deferred:** the
  *binding* constraint on slice size is org **storage**, not RAM — a Dev/scratch org caps out (~a few thousand
  accounts) far below the in-memory limit, and that slice loads RAM-fine today. Build the windowed loader when
  a real use case needs a single-org load larger than storage allows (a high-storage prod/sandbox org).
