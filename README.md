# demo-data-seeder

Generates realistic, narrative-rich **Salesforce Sales Cloud** datasets — Accounts, Contacts, Leads, Opportunities (with line items), Campaigns, the communication/activity history (emails, call transcripts, activity notes), and the wider account graph (Assets, Cases) — for **demos and testing**.

Point it at any Salesforce org. It introspects the org's limits, scopes a run, generates **grounded synthetic data** that looks like a real company's pipeline, and loads it (or disperses it to a file / SQLite corpus / MCP consumer). Everything it generates is **standard Salesforce objects** — no custom objects, no managed package required.

---

## Why it exists

**Realism is the product.** A prospect says *"show me with my data"* — what they actually want is **believable data for their industry**. SE teams burn days hand-populating trial orgs. This seeder generates an industry-varied, narrative-coherent demo org in minutes. The same data is a substrate for **testing AI workflows and integrations** against varied, real-looking records instead of hand-crafted edge cases.

**No vapor-ware.** The data comes from a real generation pipeline — real public-company anchors, a per-deal variability matrix, a per-account narrative **Deal Dossier**, then LLM-authored email/transcript/note copy behind a realism **gate** + an LLM-as-VP **judge**. If the output reads weak, you fix the *source* (prompt, grounding, scenario), never hand-edit a record to fake quality.

**A general engine, one pack.** The core lifecycle — introspect → generate → load → verify → teardown — is domain-agnostic. Everything Salesforce-Sales-Cloud-specific lives in a pluggable **`salescloud`** `TargetPack`. The engine drives the pack through a contract and never imports it back.

---

## Quickstart

```bash
pnpm install
pnpm -r build            # or: pnpm -r typecheck / pnpm -r test

# List the ops
node run-op.js list

# Plan a run (foreground "hero" deals + a bulk population tier), targeting an org alias
node run-op.js run plan-demo --org <alias> --pack salescloud --volume 5 --population 20

# Fill the email/transcript/note copy with the realism pipeline (subscription provider)
node run-op.js run fill-copy --org <alias> --pack salescloud --provider claude-code

# Load into the org — or disperse to a file / corpus instead
node run-op.js run load-demo --org <alias> --pack salescloud
node run-op.js run disperse  --org <alias> --pack salescloud --sink file --target ./out.json

# Materialize a large deterministic corpus with no live org (SQLite)
node run-op.js run materialize --org <alias> --pack salescloud --population 100000

# Clean teardown for a re-run
node run-op.js run teardown-demo --org <alias> --pack salescloud

# See what's filling an org (read-only), then delete a targeted set of rows
node run-op.js run storage --org <alias>
node run-op.js run purge   --org <alias> --sobject Task --older-than-days 30 --yes
```

### Keeping a demo org alive: `drip`

A loaded org is a snapshot — any downstream automation or AI pipeline in the org reads the same
frozen activity forever unless something keeps feeding it. `drip` inserts 1-2 new,
story-consistent interactions on a few open deals each day, as ordinary `EmailMessage`/`Task`/
`ContentVersion` records, so whatever automation the org runs on activity (triggers, flows, AI
summaries) keeps seeing fresh records instead of a dead org. Dry-run by default (`node run-op.js run drip --org <alias>`);
pass `--yes` to write. See [docs/drip.md](docs/drip.md) for the daily command, scheduling it
locally, reading the manifest, and removing drip records via `teardown-demo --include-drip`.

### Local correctness gate

`pnpm install` sets a `core.hooksPath` that activates a **pre-push hook** (`.githooks/pre-push`) running `pnpm -r typecheck && pnpm -r test` before
every push (bypass a docs-only/WIP push with `git push --no-verify`). Run it by hand any time with `pnpm gate`.

The suite includes a **golden-corpus byte fixture** (`packs/salescloud/test/golden-corpus.test.ts`): a hash of
every object's payload at a frozen `(seed, asOf, volume, population)`, blessed against the current
`GENERATOR_VERSION`. It catches the recurring trap of changing the generator but **forgetting to bump
`GENERATOR_VERSION`** (which silently serves the stale cached corpus). After a deliberate generator change:
bump `GENERATOR_VERSION` in `packages/warehouse/src/cache-key.ts`, then re-bless with **`pnpm bless:golden`**
and review the snapshot diff in your PR.

All ops are **idempotent**: additive seeds skip existing records; catalog objects (products, campaigns, the User pool) upsert by a natural key. Run `node run-op.js run <id> --help` for an op's args.

The MCP server exposes the same surface to other LLM agents: `node dataseed-mcp.js`.

---

## Repo shape

pnpm monorepo, TypeScript strict, ES2022, Node ≥ 22.

```
packages/
  core/        @dataseed/core      — the TargetPack contract, NarrativeBundle, RNG, plan types (domain-agnostic)
  engine/      @dataseed/engine    — the ops (introspect/plan/generate/fill-copy/load/disperse/teardown) + copy layer
  registry/    @dataseed/registry  — SQLite dataset registry (content-addressed generated bundles)
  warehouse/   @dataseed/warehouse — deterministic rebuildable SQLite corpus store (100K accounts, no live org)
packs/
  salescloud/  @dataseed/pack-salescloud — THE pack: standard Sales Cloud objects, scenarios, schemas, generator
apps/
  cli/    terminal op runner (run-op.js delegates here)
  server/ HTTP API over the engine
  mcp/    the MCP server (dataseed-mcp.js)
  web/    the front-end UI
```

---

## Docs

Start with [`CLAUDE.md`](CLAUDE.md) — the full orientation (what the seeder produces, the object model, the operating posture, the doc map). Then:

- [`docs/app-architecture.md`](docs/app-architecture.md) — authoritative engine architecture.
- [`docs/narrative-design.md`](docs/narrative-design.md) — variability matrix, deal archetypes, copy-realism craft.
- [`docs/load-and-validate.md`](docs/load-and-validate.md) — how data lands in orgs.
- [`docs/design/voice.md`](docs/design/voice.md) — the anti-AI-slop voice spec (read before writing any copy).
- [`docs/design/corpus-warehouse.md`](docs/design/corpus-warehouse.md) · [`docs/registry-and-dispersement.md`](docs/registry-and-dispersement.md) · [`docs/mcp-surface.md`](docs/mcp-surface.md) — the productization spine.
- [`docs/storage-and-purge.md`](docs/storage-and-purge.md) — see what's filling an org and delete a targeted set of rows, dry-run by default.

## What this is not

- Not a Salesforce app or managed package. It writes data into an org; it installs nothing.
- Not a customer-data tool. It writes **synthetic** standard-object data into demo / scratch / dev orgs.
