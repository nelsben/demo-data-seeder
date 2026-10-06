# The dataseed MCP surface — callable by other agents

`@dataseed/mcp` exposes the seeder as an **MCP server** so another LLM agent (mid-development, mid-testing) can call it to either **have static data created** or **move static data into its org** — without shelling the CLI or knowing the internals. It sits directly on the dataset **registry** + **sinks**: generate once, disperse many.

## Register it

Point an MCP client at the bin (`dataseed-mcp`). It speaks **stdio**. Example `.mcp.json` (Claude Code) / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dataseed": {
      "command": "node",
      "args": ["/path/to/demo-data-seeder/bin/dataseed-mcp.js"]
    }
  }
}
```

Prereqs: Node ≥22 (the bin self-handles the `node:sqlite` flag on 22/23), and the `sf` CLI authenticated to any org you want to `profile_org` / load into. Secrets (e.g. `ANTHROPIC_API_KEY` for LLM copy) come from the repo-root `.env`.

## The tools

| Tool | Purpose |
|---|---|
| `list_packs` | What can be generated (a pack = schema + scenario vocabulary; today one pack: `salescloud`). |
| `profile_org` | Introspect a live org → a persisted CapabilityProfile. **Run once per org before `generate_dataset`.** |
| `estimate_dataset` | **DRY-RUN sizing — writes nothing.** Given any size unit (`accounts` / `records` / `storageMB` / `storagePct` / `leaveFreePct` / `population`), return what it resolves to: the final volume + bulk population, total records, storage MB, **per-object record counts**, the org's storage headroom + where the run would land it (`projectedUsedPct` / `freePctAfter`), `budgetCapped`, and the foreground LLM-copy call count. How a caller "calculates" a run and iterates **before** committing. |
| `generate_dataset` | Generate a realistic, narrative-rich, **deterministic** dataset (seeded) and register it (addressable by `ds_…` id). `volume` = foreground narrative deals (the hero records, full copy treatment); the **bulk tier is sized by ANY unit** — `population`/`accounts`/`records`/`storageMB`/`storagePct`/`leaveFreePct` (the same flexible sizing `estimate_dataset` resolves; storage units need a live profile). `fill` defaults to `static`; pass an LLM provider for richer copy. Returns the id + a summary (incl. `budgetCapped`). |
| `disperse_dataset` | Send a dataset to a **sink**: `salesforce` (load into an org), `file` (write the bundle JSON), or `return` (hand the records back to you). Resolve by `datasetId` or the latest for `org`+`pack`. Every dispersal is recorded in the dataset's load-history. |
| `register_bundle` | Ingest **your own** authored records as a dataset — the "move in static data I already have" path. Content-addressed (re-registering the same records is a no-op). |
| `list_datasets` | List datasets (newest first) — id, pack, status, params, record counts. |
| `get_dataset` | One dataset's metadata + provenance + load-history (where it's been dispersed). |
| `compose_stack` | Group datasets into an ordered **stack** (layers) — e.g. a config layer + a deals layer + a conversations layer. |
| `disperse_stack` | Disperse a stack's datasets through one sink **in order** (the layered load); each member's dispersal is recorded in its own load-history. |
| `list_stacks` / `get_stack` | List stacks / inspect one stack + its member datasets. |
| `materialize_corpus` | Generate a corpus into the **SQLite warehouse** (one queryable table per sObject) instead of returning records — the way to have a **large, up-to-100K-account corpus across all objects sitting ready in a database, no live org**. Streams when the pack supports it (bounded memory: ~530MB at 100K). Content-addressed + **idempotent** (same seed+params = no-op). Run `profile_org { synthetic: true }` first for a no-org build. |
| `query_corpus` | Read a materialized corpus: no args → **list** corpora; `datasetId` → per-object **counts**; `+ object` → **sample** rows; `sql` → a single **read-only SELECT** against the `wh_<sObject>` tables (`json_extract(payload_json,'$.Field')` reaches any field). Row-capped. |

## The flows

**0. "Decide how much, then seed" — size against the org before committing (the dynamic-sizing loop):**
```
profile_org      { org: "my-scratch" }                                          (once — captures storage/budget)
estimate_dataset { org: "my-scratch", volume: 10, leaveFreePct: 80 }            → { resolved: { population }, estimatedRecords, perObjectCounts, orgStorage: { projectedUsedPct, freePctAfter } }
generate_dataset { org: "my-scratch", volume: 10, leaveFreePct: 80 }            → { datasetId }   (same units; resolves identically)
disperse_dataset { datasetId, sink: "salesforce" }                              → { inserted, … }
```
A caller sizes however it thinks — `accounts: 5000`, `records: 250000`, `storageMB: 400`, `storagePct: 25`, or `leaveFreePct: 80` (leave 80% of the org's data storage free). `estimate_dataset` writes nothing, so iterate freely; then pass the SAME size unit to `generate_dataset` (or `materialize_corpus`). Storage units need a live profile; `accounts`/`records` work with any (incl. synthetic).

**1. "Have static data created" — get the records back (no org writes):**
```
generate_dataset { org, pack: "salescloud", volume: 10, fill: "static" }   → { datasetId }
disperse_dataset { datasetId, sink: "return" }                             → { bundle: { records: … } }
```
(Or `sink: "file", target: "/path/fixtures.json"` to write it to disk.)

**2. "Move static data into an org" — load a scratch/dev org for testing:**
```
profile_org      { org: "my-scratch" }                                     (once)
generate_dataset { org: "my-scratch", pack: "salescloud", volume: 30 }     → { datasetId }
disperse_dataset { datasetId, sink: "salesforce" }                         → { inserted, … }   (additive, idempotent by Account.Name)
```

**2b. "Fill an org to N accounts" — make it feel like a lived-in org at scale:**
```
generate_dataset { org, pack: "salescloud", volume: 20, accounts: 100000 }  → { datasetId, plan: { population, budgetCapped } }
disperse_dataset { datasetId, sink: "salesforce" }
```
`volume` deals get the full narrative treatment (emails/tasks/transcripts driven by a per-account Deal Dossier); the other ~99,980 are **bulk** accounts — rich fields (industry, size, revenue, geography) + a realistic **opps-per-account power law** (most with 0–1, a tail with many; open/won/lost history over ~3 years) — but **no email/task/transcript copy streams** (~7 records each vs ~24 for a foreground deal). Names are procedurally unique (no `"(Div N)"`). `population` is **clamped to the org's record budget** (`profile_org` learns it); the summary flags `budgetCapped`. Use `accounts` for a target total, or `population` for the bulk count directly.

**3. "Have a 100K-account corpus ready in a queryable database" — no org, dial to scale:**
```
profile_org        { org: "standard", pack: "salescloud", synthetic: true }     (once, no live org)
materialize_corpus { org: "standard", pack: "salescloud", accounts: 100000 }    → { datasetId, recordCounts, totalRecords }
query_corpus       { datasetId }                                                 → per-object counts
query_corpus       { sql: "SELECT json_extract(payload_json,'$.StageName') stage, count(*) n FROM wh_Opportunity GROUP BY stage" }
```
Unlike `generate_dataset` (which blobs the bundle into the registry), `materialize_corpus` writes the records as **rows in per-sObject tables** you SELECT against — a full 100K-account corpus across all ~20 objects materializes in ~4s at ~530MB RAM, **byte-identical every run**, ready to `disperse` into a real org when you have one. `population` (≤200,000) and `volume` (≤2,000) are **clamped** on this surface (an arbitrary-agent DoS guard); the result flags `populationClamped`/`volumeClamped` if so.

> **Query-surface notes.** `query_corpus`'s `sql` runs a **single read-only SELECT** (a leading `WITH`/CTE and statement chaining via `;` are rejected) and is **warehouse-wide** — it reads across every materialized corpus unless you filter by `ds_id` (the tables carry a `ds_id` column; counts/sample are per-corpus). The result set is row-capped (`capped: true` when truncated). Queries run **synchronously** against a local SQLite cache of synthetic data; a pathological aggregate/join blocks only the caller's own request.

> **Copy-stream control.** `generate`'s result includes a **`cascade` estimate** — how many LLM copy calls filling the *foreground* streams would fire (bulk adds zero). To fill an org with **no copy cost at all**, disperse with `cascade: "off"` — it drops the foreground copy inputs (emails/tasks/transcripts) so the load lands purely structurally. Default `auto` loads everything, including the narrative copy on the foreground deals.

> **High-volume loading.** The loader scales for the bulk fill: each object's insert auto-switches from REST collections (200/call) to the **Bulk API** (10k/batch) at/above `bulkThreshold` (default 5000) — ~50× fewer API calls, so a multi-million-row load doesn't exhaust the daily REST budget. Every batch is wrapped in **exponential-backoff retry** for transient rate/transport errors (a blip on batch 800/1000 retries just that batch, never double-inserting). Pass a **`checkpoint`** file path to make a long load resumable — if it dies, re-running disperse with the same path skips the completed objects (restoring their parent Ids) and continues, instead of re-loading from object 1.

**3. "Move in data I already authored" — register your own bundle, then disperse it:**
```
register_bundle  { pack: "salescloud", records: { Account: [{ _ref: "a0", Name: "Acme" }], … } }   → { datasetId }
disperse_dataset { datasetId, sink: "salesforce", target: "my-scratch" }                           → { inserted, … }
```
`records` is keyed by sObject; use `_ref` (a local id per record) + `_refs` (`{ field: ref }`) for relationships — the loader resolves them in dependency order.

**4. "Compose a layered world" — stack datasets and load them in order:**
```
compose_stack    { datasetIds: ["ds_config…", "ds_deals…", "ds_convos…"], name: "fintech demo" }   → { id: "stk_…" }
disperse_stack   { stackId: "stk_…", sink: "salesforce", target: "my-scratch" }                     → { reports: [ … per layer ] }
```

Datasets are **content-addressed** (same knobs → same `ds_` id, so re-generating is a no-op refresh) and **reusable**: generate once, then disperse the same dataset to org A, org B, and a file. To reset an org, the CLI's `teardown-demo` deletes a dataset's seeded records.

> Determinism: the generated records + the choice of *which* records exist are seeded and reproducible. The human-facing copy (emails/notes) is LLM- or static-generated; `static` is byte-stable for a given seed. This is the no-vapor-ware contract — seed realistic **inputs**, let the target system derive its own **outputs**.
