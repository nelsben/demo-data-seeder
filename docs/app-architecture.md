# demo-data-seeder — App Architecture (authoritative)

> This is the authoritative engine architecture: the package layout, the `NarrativeBundle`
> seam, the staged pure-engine design, and the op lifecycle. For the one-paragraph repo
> framing (what the seeder is, the standard-object model, the operating posture) read the
> repo-root [`CLAUDE.md`](../CLAUDE.md) §1 first — this doc assumes it and does not re-derive it.

The buildable target is a pnpm monorepo with a **pure, strongly-typed TypeScript engine** as the durable asset, exposed through the locked `run-op.js` op-contract, and fronted by a Vite + React SPA (`apps/web`) over a thin server (`apps/server`) plus an MCP service (`apps/mcp`). The engine blends three generation modes — deterministic seeded RNG → probabilistic variability-matrix sampling → novel LLM copy — behind one load-bearing seam, the `NarrativeBundle`.

---

> **Productization spine.** The layer *above* the `NarrativeBundle` seam — how generated content is stored (a SQLite **dataset registry**, content-addressed artifacts), dispersed (pluggable **Sinks**, generate-once-disperse-many), and exposed to other LLMs (an **MCP** surface) — is specified in [`registry-and-dispersement.md`](./registry-and-dispersement.md) and [`mcp-surface.md`](./mcp-surface.md). That is what makes the engine a reusable, agent-callable product rather than a one-org seeder.

## 1. Decision

**Stack:** a pnpm monorepo (TS strict, ES2022, Node ≥22) with a pure TypeScript engine (`packages/engine`) as the durable asset, exposed through the `run-op.js` op-contract and fronted by a Vite + React SPA (`apps/web`) over a thin server (`apps/server`). Everything domain-specific lives behind the **`TargetPack`** contract (`@dataseed/core`); today there is exactly one pack, **`salescloud`** (`@dataseed/pack-salescloud`), and `@dataseed/core`/`engine` never import a pack back. The engine is staged — **introspect → plan → generate → fill-copy → load** (plus `disperse`/`teardown`) — with the `NarrativeBundle` as the single seam, and every record/profile/op-arg/picklist-set expressed as a **Zod schema that is both the TS type and the runtime guard**. The three generation modes (deterministic skeleton → probabilistic sampling → novel LLM copy) blend inside the pack generator + the engine `copy/` layer, with LLM copy resolved off a `CopyRequest[]` manifest through a content-addressed cache so warm runs are byte-identical and $0.

**Why this shape:** purity is the highest-leverage testability move — the pure stages (`plan`, the pack generator) are snapshot-testable with zero org access, and Zod-as-types-and-guards means a record that violates a restricted picklist fails in a unit test, never as `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` at org load. A long-lived server host (not a serverless process) is the deliberate choice because minutes-long LLM ops and streaming load progress need it. The op-contract (`run-op.js`, exit codes `0/3/4/5`) is the single command layer — web, CLI, and the MCP tools all call the same `runOp()`.

---

## 2. The Three-Mode Engine

`packages/engine` is the durable asset. It is framework-agnostic (zero React/server/jsforce imports in the pure stages) and pack-agnostic (it drives a pack through the `TargetPack` contract from `@dataseed/core`). It is structured as **staged ops behind one seam**, the `NarrativeBundle`:

```
introspect/  (impure, SF reads only)   → CapabilityProfile        [op: profile-org]
plan/        (PURE) (profile, scope, seed) → SeedPlan             [op: plan-demo]
generate/    (PURE) (SeedPlan, rng) via pack → NarrativeBundle (+ CopyRequest[])
copy/        (impure, LLM + cache)     → patches copy fields onto the bundle  [op: fill-copy]
load/        (impure, conn writes)     → LoadResult               [op: load-demo]
disperse/    (impure, sink writes)     → DisperseResult           [op: disperse]
ops/         (thin orchestration)      → composes the stages; holds NO generation logic
```

The staged split and the pure `plan/` artifact give a clean seam (cleaner than folding clamping into the generators). `plan/` is the single place the `CapabilityProfile` constrains everything — it is independently snapshot-testable, and `generate/` never sees the org. The corpus path (`materialize`/`warehouse` ops) materializes a true bulk corpus into a deterministic rebuildable SQLite store with no live org — canonical in [`corpus-warehouse.md`](./design/corpus-warehouse.md).

### The NarrativeBundle seam (`@dataseed/core` → `bundle.ts`)
A plain typed object keyed by **exact Salesforce standard-object API names**, with the load topology (master-detail / lookup chain) encoded once. The records are standard Sales Cloud objects only — no custom (`__c`) objects:
```ts
NarrativeBundle = {
  records: { Account[], Contact[], Lead[], Opportunity[], OpportunityContactRole[],
             OpportunityLineItem[], Product2[], PricebookEntry[], Campaign[], CampaignMember[],
             User[], UserRole[], EmailMessage[], Task[], Event[], Case[], CaseComment[],
             Asset[], ContentVersion[] },
  copyRequests: CopyRequest[],   // empty copy fields + the intent to fill them
  plan: { perObjectCounts, ... },
}
```
Every member is a **Zod schema**. A record that violates a restricted picklist (`Task.Status`, `Case.Status`, etc. — see CLAUDE.md §4) fails in a unit test, never as `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` at org load — the strongest testability lever.

### Mode 1 — Deterministic skeleton
`@dataseed/core` → `rng.ts` (mulberry32). One root seed → `deriveSeed(root, accountIndex, field)` gives each entity/field an independent sub-stream, so adding a draw to one generator never shifts another's output (the contract a "re-roll just this deal" action depends on). The rng is threaded **explicitly as a function argument**, never module-global, so every pure function is testable in isolation. A single injected `asOf` date anchors all relative timelines; dates are **backdated** to manufacture velocity over ~3 years. **No `Math.random` / `Date.now` / `uuid` in the generation path** — the seed-stability test enforces byte-identical bundles. Anchors load from a real-public-company set. `seedFromString("meridian-q3")` hashes a memorable string to a uint32 root.

### Mode 2 — Probabilistic sampling
The pack's variability matrix (`SALESCLOUD_VARIABILITY`) + **pure distribution functions** (`@dataseed/core` → `sample.ts`), each taking the rng and a config table. Draws span the variability matrix — **15 industries × 6 deal-size bands (`LT10K`..`GTE1M`) × 10 standard stages × a 7-role buying committee** (Champion, Economic Buyer, Technical Evaluator, Coach, Skeptic, Blocker, End User) × sentiment trajectories × velocity classes (Dark/Stalling/Accelerating/Steady, manufactured by **backdating `CreatedDate`** per the arc's chronological script) × win/loss. Cohort floors are enforced here as **distribution constraints, not randomness** (e.g. seed multiple deals per band, a mixed open pipeline). The persona sampler deliberately lands the right role where a beat needs it (e.g. an Economic Buyer for a budget-confirmation beat) — not all deals are all Champions.

### Mode 3 — Novel LLM scenarios
`generate/` (the pack generator, `salescloudGenerate`) emits the bundle with **copy fields empty** plus a `CopyRequest[]` manifest — each request carries `{ kind: email|task-note|vtt-transcript, voiceContext, arcBeat, speakers, beatIntent }` (keeps `generate/` network-free and snapshot-pure). The separate engine `copy/` module resolves those requests, grounded **on** the deterministic+probabilistic skeleton, never inventing structure. The spine-first generation core — a per-account **Deal Dossier** every object derives from — is canonical in [`design/narrative-engine.md`](./design/narrative-engine.md); the input-format contracts per copy kind (EmailMessage `TextBody`, Task `Description`, ContentVersion VTT transcript) are in [`source-variety.md`](./source-variety.md). Each prompt carries the beat intent (sentiment + who + the specific gap + the anchor's real industry) plus `docs/design/voice.md` rules.

**Provider routing** (the copy layer, canonical in [`copy-layer.md`](./copy-layer.md)): the chain is **anthropic → claude-code → static** — the claude-code subscription provider is the realism path, static is the always-on deterministic floor. A realism **gate** (lint → regenerate) and an **LLM-as-VP judge** keep generated copy from reading as AI slop. Model IDs are resolved **live at runtime**, never hardcoded.

### Content-addressed cache & reproducibility
The copy cache is a content-addressed store keyed `sha256(provider + model + normalizedPrompt)`, behind a `CacheStore` interface with a checked-in filesystem store. The canonical demo set's cache is committed to git, so a clean clone reproduces the exact demo dataset at $0. The seed-stability test asserts: same `--seed` + warm cache ⇒ byte-identical bundle. The UI shows cache hit/miss per record and supports regenerating one item in isolation. (Generated bundles are also persisted content-addressed in the SQLite **dataset registry** — `@dataseed/registry`, see [`registry-and-dispersement.md`](./registry-and-dispersement.md).)

---

## 3. Org-Introspection (point at any org)

Introspection is the **mandatory first stage** and a first-class engine module (`introspect/`), productized as the **`profile-org` op** (full op-contract parity, idempotent, CLI-runnable). Generation refuses to run until a fresh `CapabilityProfile` exists for the target alias.

The profile is one **Zod-typed object** assembled from **independent, fail-open probes** — each `(SfClient) → Partial<CapabilityProfile>`, degrading to a smaller-valid result and recording a `gap` entry rather than throwing:

| Probe | Mechanism | Drives |
|---|---|---|
| Limits | jsforce `conn.limits()` / `sf org list limits --json` | `DataStorageMB.remaining × (1-RESERVE) ÷ ~2KB/rec` → **caps `--volume`/`--population`**. `FileStorageMB`, `DailyApiRequests/BulkApiBatches` → load-mechanism gate. |
| Edition / sandbox / namespace | `Organization` SOQL; `NamespacePrefix` | edition feature gating; managed-vs-source api-name resolution |
| GenAI entitlement | PermissionSetLicense probe | informs copy-provider availability |
| Object/field + FLS | Tooling `EntityDefinition`/`FieldDefinition` + REST describe `createable` **per REQUIRED field** | a present-but-non-createable REQUIRED field is a **blocking finding, not a silent red** |
| Live picklists | REST describe → `picklistValues` for the standard restricted picklists (Task/Event/Case status, priority, origin, …) | **overrides** the static pack picklist set; feeds `plan/` validation |
| Existing data | `COUNT()` per object + resolve anchors by Name + Opportunity Amount distribution across bands | additive idempotency + fill thin cohorts; detect prior generated runs by sentinel |

**Honest gaps:** any probe with no confirmed read path is emitted as `{ instrumented: false }` and surfaced in `profile.gaps[]`. The UI **shows these honestly**, never fakes a gauge (per voice.md).

**Surfaced as:** the app's opening **"Point at an org"** screen — pick a `sf` alias (or paste one), run `profile-org`, render a **CapabilityScorecard** in plain language: a record-budget gauge ("3.1 MB free → ~1,500 records → capped to 18 accounts"), an edition/managed badge, a GenAI-provider badge, a green/amber/red per-required-field write-capability checklist, picklist-drift warnings, and an explicit Gaps panel. **The gate is structural: no profile → no Scope screen.** Every profile is persisted per-alias with a freshness timestamp, is re-runnable, and a `profile.json` snapshot is captured at run time so a run reproduces even if the org later drifts.

---

## 4. The App Experience

A guided SPA. The journey is **Point at an org → Introspect → Scope → Preview/Curate → Load & Watch → Verify**, with Projects/Runs history wrapping it. Screens:

1. **Org Connect & Introspect** *(mandatory first)* — alias picker + CapabilityScorecard (§3). Hard gate: no profile, no Scope.
2. **Scope Composer** — the parameter cockpit: `--volume`/`--population` sliders **hard-clamped** to the introspected record budget; `--bulkDensity`; a scenario-mix editor as draggable % bars across the named scenarios (`at-risk-budget` / `healthy-tech` / `rfp-gated` / `stalled-portfolio` / `churning-account`) that must sum to 100; industry/band/persona distribution editors with live coverage previews; `--seed` (string via `seedFromString`, or number); a `--budget` USD cap. A live "this plan will create N Accounts / M Opps / K transcripts, ~$X LLM, ~Y% storage" estimate from a dry-run engine call.
3. **Plan Preview (dry-run, $0)** — renders the deterministic+probabilistic bundle **before any LLM or org write**: a tree of Accounts→Opps→records-to-be on a timeline, plus a **variability-matrix coverage heatmap** (industries × bands × personas × velocity) with a **red flag when any populated band is under its cohort floor** — turns the easily-missed cohort floor into a visible pre-load assertion — the `CopyRequest` count + estimated tokens/cost, and a read-only JSON view.
4. **Copy / Curate Studio** *(no-vapor-ware enforced in UI)* — review/regenerate LLM copy per record, **side-by-side prompt + output**, a voice-lint badge (verb-led titles, numbers/names/dates present, no AI-slop phrases), provider/cache indicator, budget meter. Per-record actions: pin, **edit-the-input-prompt-and-regenerate (never edit the output)**, re-roll-this-deal, exclude-from-load — makes no-vapor-ware the easy path.
5. **Transcript Studio** — a dedicated view rendering call-recording **ContentVersion VTT transcripts** (transcript text in `VersionData`, linked to the Opportunity via `FirstPublishLocationId`) — the shape a tool like Gong / Einstein Conversation Insights produces; speaker→OCR attribution resolving live; the small-talk filter and PII masking applied.
6. **Diff & Review (before load)** — classify this bundle vs **live org state** as **NEW vs SKIP-existing vs CONFLICT** (a real safety surface for shared/customer orgs), JSON/VTT diff panes, a final pre-load checklist (load order, sentinel tag, budget).
7. **Load & Watch** — one-click load with a streaming SSE progress log following the insert order (Product2 → PricebookEntry → Campaign → User → Account → Contact → Opportunity → … → ContentVersion → Task → Case), idempotency skips shown inline ("Stripe Account exists → skipped"), open-in-org deep links per record.
8. **Verify & Outcome** — per-stage SOQL assertion checklist (per-object counts present, benchmark cohorts meet their band floors, open pipeline mixed, the narrative records landed on their parents) and an **Outcome read-back** view: what landed in the org, side-by-side with the plan that produced it.
9. **Runs Library & Teardown** — every introspection + load is a reproducible card (seed, scope, profile snapshot, manifest, cost); re-run byte-for-byte, or scoped purge by a `[dataseed-gen:<runId>]` sentinel in reverse dependency order with a dry-run diff first (`teardown-demo`).
10. **Op Console (power-user drawer)** — every screen action shown as its `node run-op.js run <op> --<arg> <value>` equivalent (copyable), proving op-contract parity.

---

## 5. Loader + Salesforce integration

`packages/engine/load/` is the engine's only write side: **order-aware, idempotent, additive, namespace-aware**, driven entirely by the `CapabilityProfile`. Mechanisms chosen per object/volume:

- **Composite REST** (jsforce `conn.requestPost /composite/sobjects`, 200/batch, `allOrNone:false`) — default ≤~10k records; gated on `DailyApiRequests`. jsforce **in-process** is the deliberate choice — it gives streaming composite/Bulk2/Tooling that shelling `sf` cannot, and the responsive progress UX a live demo needs.
- **Bulk API 2.0** (jsforce `bulk2`) — large/historical backfills (>10k, population/whale cohorts), job-per-object.
- **Special handling for `ContentVersion`** — a Salesforce-sink load needs `VersionData` base64-encoded and the file linked via `FirstPublishLocationId` / `ContentDocumentLink`. (A **file sink** stores the plain transcript text instead — see the sinks in [`registry-and-dispersement.md`](./registry-and-dispersement.md).)

**Order-aware** via a pure topo-sort encoded once in the load topology, following the master-detail / lookup chain (Product2 → PricebookEntry → Campaign → UserRole → User → Account → Contact → Opportunity → OpportunityContactRole → OpportunityLineItem → Lead → CampaignMember → EmailMessage → ContentVersion → Task → Event → Asset → Case → CaseComment). **Fails loud** on an unresolved parent Id; never silently drops.

**Idempotent + additive:** resolve EVERYTHING by Name/query at load time (**NEVER literal Id** — a hardcoded Id is the named anti-pattern); catalog objects (Product2, Campaign, the User pool) upsert by a natural key; tag every generated record with a `[dataseed-gen:<runId>]` sentinel; `check()` skips an account whose Account exists. Every write is validated against the **live-describe picklist snapshot** captured at introspection before the batch goes out.

**Dispersement (generate-once-disperse-many):** the loader is one **Sink**; the `disperse` op writes a registered dataset to a pluggable sink (Salesforce org, file tree, …). Canonical in [`registry-and-dispersement.md`](./registry-and-dispersement.md).

**The op-contract IS the command layer.** Each op is the locked `{id, name, description, prerequisites, affects, idempotent, args, check(), run(), verify()}` shape with exit codes `0/3/4/5`. `run-op.js` (the existing CLI) delegates into `apps/cli`, which imports the engine ops. The server routes, the CLI, and the MCP tools all call the identical `runOp(op, args, ctx)` — org/LLM I/O injected via the `ctx` object (`conn, rng, cache, llm, log`). Ops: **profile-org** (introspect), **plan-demo**, **materialize** / **warehouse** (corpus), **fill-copy** (LLM copy), **load-demo**, **disperse**, **teardown-demo** — all idempotent.

---

## 6. Repo layout + tech choices

pnpm workspaces + Turborepo. The engine is the shared asset; web, CLI, server, and MCP are clients. The authoritative repo shape is in [`CLAUDE.md`](../CLAUDE.md) §1 — summarized here for the architectural seam:

```
demo-data-seeder/
├── packages/
│   ├── core/        @dataseed/core      # the TargetPack contract, NarrativeBundle, RNG, sample/, plan types. Imports nothing domain-specific.
│   ├── engine/      @dataseed/engine    # introspect/plan/generate/fill-copy/load/disperse/teardown ops + the copy layer
│   ├── registry/    @dataseed/registry  # SQLite dataset registry (stores generated bundles, content-addressed)
│   └── warehouse/   @dataseed/warehouse # deterministic rebuildable SQLite corpus store (materialize a 100K corpus, no live org)
├── packs/
│   └── salescloud/  @dataseed/pack-salescloud  # THE pack: standard Sales Cloud objects, scenarios, schemas, the generator (salescloudGenerate)
├── apps/
│   ├── cli/         # run ops from the terminal (run-op.js delegates here)
│   ├── server/      # HTTP API over the engine (thin transport, ZERO business logic) + SSE progress
│   ├── mcp/         # the MCP server — exposes the seeder to other LLM agents (node dataseed-mcp.js)
│   └── web/         # Vite + React + TS SPA (the PRODUCT)
├── run-op.js        # PRESERVED CLI entry → delegates into apps/cli → engine ops
└── docs/            # canonical grounding (CLAUDE.md front door, BRIEF, narrative-design, design/voice.md…)
```

**Tech choices & rationale:** TypeScript strict + **Zod** (one artifact = type + runtime guard, the testability lever). **jsforce** in-process for streaming SF I/O; `sf` CLI shelled only where it's the path of least resistance (`org display --json` for the access token — **no auth at rest**). The copy layer routes **anthropic → claude-code → static**; model IDs resolved live. **SQLite** (synchronous, embedded, zero-daemon) backs both the dataset registry and the rebuildable corpus warehouse. **Vitest** (unit/contract/snapshot), **Playwright** (UI e2e), **Vite** (web), `tsc --noEmit` (typecheck gate). `ANTHROPIC_API_KEY` lives only in `.env` (gitignored).


---

## 7. Testing strategy

Test-first; every feature ships with tests. Purity is the enabling design choice — every stage except the SF edges is unit-testable with zero org access. Cheap deterministic tiers run every commit; org-touching tiers gate releases.

1. **Engine unit + factory** (Vitest) — a factory per object; unhappy paths; samplers asserted for distribution shape over N draws within tolerance; topo-sort asserts parents precede children + cycle detection.
2. **Seed-stability snapshot** — same `--seed` + warm cache twice ⇒ **byte-identical** `NarrativeBundle` (catches a stray `Math.random`/`Date.now`/`uuid`); a canonical static-copy bundle is a committed snapshot so generation drift is a reviewable diff.
3. **Zod contract tests** — every record validates against its schema before becoming a load candidate (a bad shape fails in unit, never at org load).
4. **Live-picklist contract** — the pack picklist set diffed against the recorded describe (and, in the integration lane, the live describe) so a picklist drift fails loudly, not as `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`.
5. **Copy/voice contract** — golden prompt structure + a voice.md keyword-assertion set (verb-led titles, numbers/names/dates present, banned AI-slop phrases, ≥20-char VTT utterances, OCR-attributed speakers) over a frozen warm cache, plus the gate + LLM-as-VP judge.
6. **Provider chain** — mock anthropic/claude-code to assert fallback order (anthropic → claude-code → static), budget-cap **abort-before-spend**, and cache hit/miss.
7. **Introspection fail-open** — each probe against recorded fixtures asserting the right `CapabilityProfile` + degrade-to-smaller-valid on malformed responses, never throws.
8. **Op-contract parity** — every op validates check/run/verify presence, arg-schema shape, exit-code semantics; the same op runs via CLI, via the server route, and via the MCP tool with identical structured results.
9. **UI** — Vitest + React Testing Library on components (CapabilityScorecard, Scope clamping, curate persistence, Diff NEW/SKIP/CONFLICT classification); **Playwright e2e** for the full Connect→Scope→Preview→Load→Verify happy path against a mocked server.
10. **Loader integration** *(opt-in, nightly/on-demand)* — create a scratch org, run `profile-org` + `plan-demo` + `fill-copy` + `load-demo` + verify, assert per-stage counts, then `teardown-demo` and assert clean.

**CI** (GitHub Actions): `tsc --noEmit` + tiers 1–9 (deterministic, $0) on every PR; tier 10 nightly/on-demand, respecting Dev-Edition create caps and **never reaping a shared dev org mid-validate**.

---

## 8. Phased build plan

Each milestone is a **thin vertical slice** that ships something runnable. Order is chosen so the engine (the durable asset) is proven before the GUI thickens, and so the first end-to-end demo lands fast.

- **M0 — Monorepo + engine skeleton + core schemas.** pnpm workspaces + Turborepo; the `@dataseed/core` RNG + the `NarrativeBundle`, `CapabilityProfile`, `ScopeParams`, op-arg **Zod schemas** + the `TargetPack` contract; `run-op.js` working as the CLI entry. Tests: rng determinism, Zod schema round-trips.
- **M1 — `profile-org` op + introspection (engine + CLI).** All §3 probes, fail-open, against recorded fixtures; `CapabilityProfile` emitted and persisted; gaps surfaced honestly. Ships: `node run-op.js run profile-org --org <alias>`.
- **M2 — Pure `plan-demo` + the salescloud generator (deterministic + probabilistic) + dry-run preview.** `(profile, scope, seed) → SeedPlan → NarrativeBundle` with empty copy fields + `CopyRequest[]`; the variability-matrix samplers + cohort-floor constraints. Tests: seed-stability snapshot, sampler distributions, cohort floors.
- **M3 — The web shell: Connect → Scope → Plan Preview.** Server + SSE + SQLite; the SPA with the CapabilityScorecard (hard gate), the clamped Scope Composer, and the dry-run Plan Preview + coverage heatmap. **The first real "app."** Playwright happy-path through preview.
- **M4 — Loader + Load & Watch + Verify (REST).** Composite-REST loader, topo-sort, sentinel idempotency, the Verify/Outcome read-back. **First end-to-end: point at a scratch → generate → load → verify.** Integration tier (lease scratch, assert counts, `teardown-demo` clean).
- **M5 — LLM copy layer + Copy/Curate Studio.** The `fill-copy` op + provider chain (anthropic → claude-code → static), content-addressed cache, the gate + LLM-as-VP judge, the curate-the-input UI + voice-lint. Commit the canonical-anchor warm cache.
- **M6 — Transcript Studio + Bulk 2.0 + Diff & Review + Runs Library + scoped teardown.** ContentVersion VTT transcripts, historical Bulk-2.0 backfills, diff-before-load (NEW/SKIP/CONFLICT) for shared-org safety, reproducible run history, reverse-order purge.
- **M7 — Productization spine + scale.** The dataset registry, the `disperse` op + sinks, the MCP surface; the `materialize`/`warehouse` corpus path toward the 100K-account North Star. Then harden against actual scale (timeboxed — stop before gold-plating).
