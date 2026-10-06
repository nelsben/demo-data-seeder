# Dataset Registry, Sinks & the LLM-Callable Surface — the productization spine

> **Why this doc.** The seeder is a standalone app — a grounded synthetic-data engine that's reusable and callable by other LLMs to create data and data stacks — which forces a decision on **how generated content is stored, integrated, and dispersed**. This is the canonical reference for that spine. The engine internals live in [`app-architecture.md`](./app-architecture.md); this doc is the layer above the `NarrativeBundle` seam. For the authoritative product framing, see the repo-root [`CLAUDE.md`](../CLAUDE.md).

---

## 0. The decisions (locked 2026-06-18)

| Fork | Choice | Why |
|---|---|---|
| **Storage** | **SQLite registry + blobs** (`node:sqlite`, zero-dep) | Generated content becomes an *addressable, queryable, composable* artifact — not an overwritten file. Local-first, zero-ops; the `RegistryStore` interface graduates to Postgres/object-store for a hosted service without touching callers. |
| **Build toward** | **Substrate → MCP service** | The registry + Sink abstraction is the shared floor the App *and* the MCP service both stand on. The MCP surface is the actual "callable by other LLMs" differentiator. |
| **Dispersement** | **Pluggable Sinks** | Generate-once, disperse-many: one dataset → Salesforce org A *and* org B *and* a file, idempotent per sink. |

**What you are:** a *grounded synthetic-data engine* — point it at a target schema (a pack) + a scope, generate realistic narrative-rich data (deterministic anchors/seeds + sampled variability + novel LLM copy), then disperse it into live systems. The pack is `salescloud` (standard Sales Cloud objects), not the product. The moat vs Mockaroo/Snaplet/Tonic/faker: narrative grounding + seeding *inputs* that make a real pipeline derive *outputs* + callability by other agents.

---

## 1. The dataset — the unit of generated content

Today generated content is a single flat `.dataseed/bundles/<org>-<pack>.json`, keyed by `(org, pack)` and overwritten each run. The registry replaces that with a first-class **Dataset**:

```
Dataset = {
  id          // ds_<hash> — content-addressed on (pack, canonical params)
  name?       // optional human label (not part of identity)
  pack        // "salescloud"
  params      // the ScopeParams request that produced it
  status      // "planned" (records only) | "filled" (LLM copy generated)
  provenance  // engineVersion, createdAt/updatedAt/filledAt, llm{Provider,Model,CostUsd}, recordCounts
  bundle      // the NarrativeBundle (records + copyRequests + plan + directives)
}
```

**Content-addressed identity** (`datasetId(pack, params)` = `ds_` + sha256(pack + canonical-params)[:12]): equal generation requests get the same id, so re-planning is idempotent (updates the same dataset, preserving `createdAt`) and a caller can address a dataset purely by the request that would produce it. The `name` is a label, never hashed.

A **LoadRecord** is one dispersal (`{datasetId, sink, target, at, inserted, failed, report}`) — the dataset's load-history. A **Stack** is an ordered composition of datasets (`{id: stk_<hash>, datasetIds[], …}`) loaded in array order — the "data stack" an LLM composes from reusable layers.

---

## 2. `@dataseed/registry` — the storage substrate (shipped: PR A)

- **`RegistryStore` interface** — `put / get / getMeta / list(filter) / remove / recordLoad / loadsFor / putStack / getStack / listStacks / close`. The pluggable seam: the SQLite impl is default; Postgres/object-store is a later swap.
- **`SqliteRegistryStore`** — `node:sqlite` (Node's built-in driver: zero native deps, no build step). Tables: `datasets`, `loads`, `stacks`. The bundle is a JSON column for now (SQLite handles multi-MB text fine; externalizing blobs is an interface-internal change). DB at `.dataseed/registry.db` (gitignored).
- **`buildDataset` / `recordCounts`** — turn a freshly-generated bundle into a Dataset; timestamps are **injected** (never `Date.now()` in the package — the repo's reproducibility rule), so the caller owns the clock and tests stay deterministic.

**Node-version note:** `node:sqlite` is stable on Node ≥24 and behind `--experimental-sqlite` on 22/23. Package scripts set `NODE_OPTIONS=--experimental-sqlite` (a harmless no-op on 24+), so CI (Node 22) and local (25) both work with **no `.github/workflows` change**. The module is loaded via `createRequire` so Vite/vitest's static resolver doesn't choke on the new builtin.

---

## 3. Sinks — pluggable dispersement (roadmap: PR B)

Split **WHAT to generate** (the `TargetPack` — exists) from **WHERE/HOW to disperse** (a `Sink`):

```
interface Sink { id; label; disperse(dataset, opts): Promise<DisperseReport> }
```

- **`SalesforceSink`** — wraps today's order-aware, idempotent jsforce loader (`packages/engine/load/`).
- **`FileSink`** — JSON/CSV export to disk (datasets become portable fixtures).
- **`ReturnSink`** — hands the bundle back to the caller (for an MCP-driving LLM that wants the data, not a load).

`load-demo` becomes `disperse(datasetId, sink, target)`; every dispersal appends a `LoadRecord`. Generate-once, disperse-many; idempotent per sink. The ops migrate from `(org, pack)` flat-files to reading/writing the registry by dataset id.

### Data Cloud — a *future optional* sink, never a generator concept (decided 2026-06-21)

**Decision (panel-grounded + live-probed): Data Cloud is at most a future optional `DataCloudSink`, never a
generator branch or a scratch-org concern.** The salescloud pivot already removed DC from the data path (the
DC-specific generation branch and its custom inbox/normalizer objects were deleted; transcripts → standard
`ContentVersion` VTT). The seeder produces **standard Sales Cloud objects against any stock org**, and the
native way that data enters Data Cloud is the **CRM Connector ingesting standard Account/Contact/Opportunity
over Data Streams** — so a great standard-object load is ~80% of any DC story *for free* (load standard objects
→ connect → DC self-populates). A future `DataCloudSink` is therefore near-zero seeder-side code, not a parallel
ingestion pipeline. **Trigger to build it:** a real prospect with an already-provisioned DC tenant who wants to
ground Agentforce/Einstein on seeded data. Until then DC is a solution to a problem no current user has.

The only residual DC surface kept is a **read-only introspection probe** (`probeDataCloud`) — an honest "is this
org a DC candidate?" readout on the Connect screen. It fails **closed** (PSL presence ≠ provisioned, so an
unconfirmable probe reports `available: false`). There is no user-facing DC generation toggle (removed — it
configured nothing). Full rationale: the `project_data_cloud_decision` memory.

---

## 4. MCP server — the callable-by-other-LLMs surface (roadmap: PR C)

`apps/mcp` exposes the engine as MCP tools so any LLM agent can build data + data stacks:

- `list_packs()`, `profile_org(org)`
- `generate_dataset(params) → {dataset_id, summary}`
- `fill_copy(dataset_id) → {dataset_id, cost}`
- `disperse(dataset_id, {sink, target}) → report`
- `compose_stack({name, dataset_ids}) → stack_id`
- `list_datasets(filter)`, `get_dataset(id)`

The registry is what makes these tools stateful and composable: a tool returns a **dataset id**, not a blob, and later tools operate on it.

---

## 5. Execution order

- **PR A — `@dataseed/registry`** ✅ — SQLite dataset registry (addressable datasets + load-history + stacks), pluggable `RegistryStore`, `node:sqlite` zero-dep.
- **PR B — Sinks + op migration** — `Sink` abstraction (`SalesforceSink`/`FileSink`/`ReturnSink`); ops read/write the registry; `load-demo` → `disperse`. Live-prove generate→registry→disperse on a scratch org.
- **PR C — MCP server (`apps/mcp`)** — the LLM-callable tools over registry + sinks.
- **PR D — Stacks + App wiring** — `compose_stack` + the web app reads the registry (list / re-disperse).
