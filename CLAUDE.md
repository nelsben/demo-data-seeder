# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in **this repo** — a standalone Salesforce **Sales Cloud** demo-/test-data seeder. It is loaded every session (local or cloud), so it must single-handedly orient a fresh Claude with no re-grounding and no re-approval. Read it before doing anything.

---

## 1. Project overview

**This repo is `demo-data-seeder`** — a **standalone app** that generates realistic, narrative-rich **Salesforce Sales Cloud datasets** (Accounts, Contacts, Leads, Opportunities with line items, Campaigns, the communication/activity history, and the wider account graph) for **demos and testing**. It points at any Salesforce org, scopes a run to that org's limits, and produces **grounded synthetic data** that looks like a real company's pipeline.

This repo seeds **only standard Sales Cloud + related standard objects** — nothing custom, no managed package. It works against any stock Salesforce org.

**Two jobs:**

1. **Seed scratch / demo / customer orgs** with believable sales pipelines so a sales engineer can walk a prospect through a populated org in minutes instead of days.
2. **Give any team (or any LLM agent) a substrate of real-looking Salesforce data** to validate workflows, test integrations, and dogfood features against varied data instead of hand-crafted edge cases.

**Identity (canonical):** a **general Salesforce data-testing app**, not a single-customer tool. The core lifecycle — **introspect → generate → load → verify → teardown** — is domain-agnostic and never hard-codes a customer. A **`TargetPack`** plug-in supplies everything domain-specific (objects, picklists, scenarios, record schemas, the generator). Today there is exactly one pack: **`salescloud`** (standard Sales Cloud objects). The engine is genuinely pack-agnostic — it drives a pack through the `TargetPack` contract and `@dataseed/core` never imports a pack back.

**North Star:** point at any org → **100K accounts × detailed, realistic data across ALL core Sales Cloud objects**, deterministic at scale, MCP-callable, load-correct. **Realism is THE product** — this data goes in front of VPs/CEOs and is used to test AI workflows, so a templated "Snowflake == Stripe" feel fails the bar. The generation engine blends **deterministic** (seeded RNG, real public-company anchors), **probabilistic** (a variability matrix sampled per deal), and **novel-LLM** (per-deal scenarios, email/transcript/note copy) generation.

**Deliverable:** a real **app** — a generation/integration **engine** + a **front-end UI** (`apps/web`) + an **MCP service** other agents call. Not a CLI-only script.

### Repo shape (pnpm monorepo, TS strict, ES2022, Node ≥22)

```
packages/
  core/        @dataseed/core      — the TargetPack contract, NarrativeBundle, RNG, plan types. Imports nothing domain-specific.
  engine/      @dataseed/engine    — introspect/plan/generate/fill-copy/load/disperse/teardown ops + the copy layer.
  registry/    @dataseed/registry  — SQLite dataset registry (stores generated bundles, content-addressed).
  warehouse/   @dataseed/warehouse — deterministic rebuildable SQLite corpus store (materialize a 100K corpus, no live org).
packs/
  salescloud/  @dataseed/pack-salescloud — THE pack: standard Sales Cloud objects, scenarios, schemas, the generator.
apps/
  cli/    run ops from the terminal (run-op.js delegates here)
  server/ HTTP API over the engine
  mcp/    the MCP server — exposes the seeder to other LLM agents (`node dataseed-mcp.js`)
  web/    the front-end UI
```

**Op contract:** `{id, name, description, prerequisites, affects, idempotent, args, check(), run(), verify()}`. Run via `node run-op.js run <id> --<arg> <value>` (`list` / `run <id> --help`). Ops: **profile-org** (introspect), **plan-demo**, **materialize** / **warehouse** (corpus), **fill-copy** (LLM copy), **load-demo**, **disperse** (to a sink), **teardown-demo**. All idempotent.

**LLM copy routing:** the copy layer fills deferred `CopyRequest`s (email/task/transcript bodies) through a provider chain **anthropic → claude-code → static** (the claude-code subscription provider is the realism path; static is the always-on deterministic floor). A realism **gate** (lint → regenerate) + an LLM-as-VP **judge** keep generated copy from reading as AI slop.

---

## 2. How we work — operating posture (durable rules)

These are how-Claude-works rules carried across sessions. They are the way of working here, not suggestions.

- **Concise, execute-over-ask.** Default to action. The ask-time test: **within-fence → act**; **moving-the-fence → propose**; **a real fence (irreversible, cross-cutting, or a named guardrail below) → stop and ask**. Don't ask the user to do something you can do.
- **No vapor-ware (the governing rule).** Realism comes from **real generation**, not hand-authored outputs. The seed pipeline (anchors → variability → dossier spine → LLM copy → gate → judge) produces the data; if the output is weak, fix the **source** — the prompt, the grounding fact-pack, the variability matrix, the scenario design — **never hand-edit a generated record's prose to fake quality.** Allowed: choosing which records exist, which scenarios, which anchors. Not allowed: fabricating a believable artifact by hand and passing it off as generated.
- **Realism is the bar.** This data goes in front of VPs/CEOs and is used to test AI. Specifics over abstractions: "CFO confirmed $200K cap on Tuesday," not "stakeholder expressed budget alignment." Read `docs/design/voice.md` before writing any human-facing copy string — it is the anti-AI-slop spec.
- **Test-first.** Every feature ships with tests. Factory coverage for every object, unhappy paths, prompt/contract assertions, CI thresholds. Testing is a product goal, not a chore.
- **Scope discipline.** Timebox hardening against *actual* scale; recommend stopping before gold-plating. Within-fence ≠ worth-doing-now. Prefer the smallest valuable cut.
- **Proceed on read-only searches.** Standing permission for read-only searches (web, grep, SOQL queries). Don't pause to confirm — just run.
- **Research before pivoting.** When an architectural recommendation is challenged, research with citations **before** pivoting. "Sounds plausible" is not evidence.
- **Switch to Opus when uncertain.** If you're unsure about an approach, escalate the model rather than guessing.
- **Idempotency + durability are non-negotiable for seeds.** Additive seeds skip existing records; catalog objects (products, campaigns, the User pool) upsert by a natural key. Resolve org records **by name/query, never by literal Id.**
- **Verify before claiming you can't run something.** Orgs are usually authed (Salesforce DX MCP is configured), chromium is installed. Run the diagnostic first, then run the thing.
- **Canonical-vs-satellite.** For any topic spanning >3 paragraphs across files, pick ONE canonical source and make every other mention a 2–4 line pointer. Don't scatter facts.
- **Defer, don't drop.** Design knobs that come up mid-task but aren't worth deciding now go to `docs/open-questions/` with rationale, so they survive the session.

**Guardrails (real fences — stop):** the `permissions.deny` list (no `rm -rf /`, no `git reset --hard`, no force-push, no `git push --delete`, **no `sf org delete`** — especially relevant for a seeder that targets live orgs) and the `permissions.ask` list (edits to `.claude/**` config, `.github/workflows/**`). Develop on scratch; let CI deploy up. Never seed orphan data into a shared org during an in-flight CI validate. `ANTHROPIC_API_KEY` lives only in `.env` (gitignored) — never tracked or printed; don't spend API credits without asking (the claude-code subscription provider is fine).

---

## 3. What the seeder produces — the Sales Cloud object model

The seeder generates a connected graph of **standard Salesforce objects** in dependency order. There are no custom (`__c`) objects — everything loads into a stock Salesforce org with no managed package.

**Foreground deals** (the hero/demo records, `--volume`) get the full narrative treatment: a per-account **Deal Dossier** (arc + cast + beat timeline) drives every object so one tight story is told across emails, tasks, and transcripts. **Bulk/population** accounts (`--population`, scaled by `--bulkDensity`) are structural — realistic at scale, cheaper per record, no copy streams.

**Insert order (master-detail / lookup chain):**
```
Product2 → PricebookEntry → Campaign → UserRole → User → Account → Contact
  → Opportunity (needs AccountId) → OpportunityContactRole → OpportunityLineItem
  → Lead → CampaignMember → EmailMessage → ContentVersion → Task → Event → Asset → Case → CaseComment
```

**The narrative-bearing records:**
- **Opportunity** — the deal. Stage, Amount (band-sampled), CloseDate, dates spread over ~3 years for velocity. Some accounts carry a PRIOR closed-won Opp (cross-deal history).
- **EmailMessage** (`RelatedToId` → Opp) — the email thread, 4–8 per foreground deal. Body in `TextBody` (filled by the copy layer).
- **Task** (`WhatId` → Opp, `WhoId` → Contact) — logged-activity notes; the rep's terse account of a call. Body in `Description`. `TaskSubtype='Email'` models EAC-synced email activity.
- **ContentVersion** (`FirstPublishLocationId` → Opp) — **call-recording transcripts** (VTT files), the shape a tool like Gong/Einstein Conversation Insights produces. Transcript text in `VersionData` (filled by the copy layer). *(Note: a Salesforce-sink load of ContentVersion needs `VersionData` base64-encoded + the file links via `FirstPublishLocationId`/`ContentDocumentLink` — the file sink stores plain text.)*
- **Case / CaseComment** — support history; the churn/health leading indicator.
- **Asset** — installed base on Customer accounts.

**Restricted standard picklists the seeder must honor** (full set in `packs/salescloud/src/picklists.ts`; a wrong value fails at LOAD with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`):
- `Task.Status`: `Not Started | In Progress | Completed | Waiting on someone else | Deferred` (NOT "Open").
- `Task.Priority` / `Event.Priority`: `High | Normal | Low`. `Event.ShowAs`: `Busy | OutOfOffice | Free`.
- `Case.Status`: `New | Working | Escalated | Closed`. `Case.Origin`: `Phone | Email | Web`. `Case.Priority`: `High | Medium | Low` (Case uses Medium, Task uses Normal).
- Org-configurable picklists (Task/Event subtype, Case Type/Reason, Asset Status) are **omitted** to stay load-safe on an untouched org.

**Realism craft (so seed data reads real):** span the variability matrix — 15 industries, 6 deal-size bands (`LT10K`…`GTE1M` — seed multiple deals per band), 10 standard stages, a 7-role buying committee (Champion, Economic Buyer, Technical Evaluator, Coach, Skeptic, Blocker, End User — not all Champions), positive→risk **sentiment trajectories over time**, win/loss outcomes, and **backdated timestamps** to manufacture velocity. Copy rules: verb-led imperative action titles, exact quote + attribution evidence, never fabricate stakeholder names, per-persona voice (a CFO and a champion never sound alike). The deal archetypes live in `packs/salescloud/src/scenarios.ts` + `docs/narrative-design.md`.

---

## 4. Doc map

Canonical sources for this repo. Read the relevant one before working in its area; keep facts in ONE place and point at it elsewhere.

**Orientation + architecture:**
- `README.md` — the repo's front door (what it is, quickstart, op list).
- `docs/app-architecture.md` — the authoritative engine architecture (packages, the `NarrativeBundle` seam, the op lifecycle).
- `docs/architecture-sketch.md` — the forward-looking layer sketch (introspection → scope → generation → load).
- `docs/design/bulk-object-graph.md` — the North-Star bulk/population tier (100K accounts across all core objects).
- `docs/design/corpus-warehouse.md` — canonical for `@dataseed/warehouse` (the deterministic rebuildable SQLite corpus + `materialize`/`warehouse` ops).
- `docs/registry-and-dispersement.md` — the dataset registry, sinks, and the productization spine (generate once, disperse many).
- `docs/mcp-surface.md` — the `@dataseed/mcp` surface other agents call.

**Seed-reference (the data the seeder produces + how it lands):**
- `docs/narrative-design.md` — the variability matrix, the deal archetypes + their signal patterns, copy-realism craft, the no-vapor-ware anti-patterns.
- `docs/source-variety.md` — the input-format contracts per copy kind (EmailMessage, Task note, ContentVersion VTT transcript).
- `docs/object-audit.md` — the sales-cycle standard-object audit (which objects matter, ranked) + the seeding decisions.
- `docs/load-and-validate.md` — how data lands in orgs: the seeding tracks, load order, idempotency/teardown.
- `docs/copy-layer.md` — how the seeder turns deferred CopyRequests into prose (the provider chain + gate + judge).

**Voice + realism (mandatory before writing copy):**
- `docs/design/voice.md` — **the anti-AI-slop spec.** Do/Don't pairs, "specific = numbers + names + dates." Read before writing any generated copy string.
- `docs/design/character.md` — the "smart colleague who's been watching the deal" persona that `voice.md` leans on.
- `docs/design/references.md` — the voice/brand anchors `voice.md` references.
- `docs/design/realism-playbook.md` — making demo data read as real to VPs/CEOs.
- `docs/design/narrative-engine.md` — the spine-first generation core (the per-account Deal Dossier every object derives from).
- `docs/design/anti-patterns.md` — what we deliberately don't do.
- `docs/open-questions/` — parking lot for deferred design knobs, with rationale.


**Claude Code config:**
- `.claude/settings.json` — committed: `permissions.deny`/`ask`/`allow` + the `pre-git-guard` hook.
- `.claude/settings.local.json` — per-developer, gitignored (your pre-approved tools, `enabledMcpjsonServers`).
- `.mcp.example.json` — Salesforce DX MCP server template (`@salesforce/mcp`, toolsets `orgs,metadata,data,users`). Copy to `.mcp.json` (gitignored) and set `--orgs` to your org alias.

**Org targets:** ephemeral scratch orgs (primary), a shared dev org, and real customer orgs. The seeder loads only standard objects, so it works against any Salesforce org with no managed package. Any `sf` CLI alias works (`--org <alias>`); Dev-Edition Dev Hub caps: 6 scratch creates/day, 3 active. See `config/scratch/README.md`.

---

This file is the antidote to starting from zero. When in doubt about a Salesforce data shape or field, check the live org describe (`profile-org`, or the Salesforce DX MCP) before guessing.
