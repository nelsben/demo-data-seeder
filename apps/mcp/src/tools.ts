// apps/mcp/src/tools.ts
//
// The dataseed MCP surface — the tools another LLM agent calls to "have static
// data created" (generate) or "move static data in" (disperse), over the dataset
// registry + sinks. Thin adapters: parse args → call the headless DatasetService →
// return JSON. The server (server.ts) wires real deps; tests inject fakes and drive
// these through an in-memory transport.

import { mkdirSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PackRegistry, standardProfile } from "@dataseed/core";
import {
  type DatasetService,
  ACCOUNT_STATES,
  assembleProfile,
  SfCliClient,
  profileObjects,
  profilePath,
  PROFILE_DIR,
  totalRecords,
} from "@dataseed/engine";

export interface McpDeps {
  service: DatasetService;
  packs: PackRegistry;
  now: () => string;
  /** Introspect a live org → persist a CapabilityProfile. Default: SfCliClient + assembleProfile. Injected for tests. */
  profileOrg?: (org: string, packId?: string) => Promise<{ profilePath: string; recordBudget: number; objectsProbed: number }>;
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const toolError = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true as const });
/** Run a synchronous service call, returning a CLEAN tool error instead of leaking a raw Zod/SQLite stack
 *  (the corpus tools accept free-form SQL + loose args, so a throw is an expected path, not a server crash). */
const guarded = async (label: string, fn: () => unknown) => {
  try {
    return json(await fn()); // await so async service methods (e.g. materializeCorpus) resolve before json()
  } catch (e) {
    return toolError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

async function defaultProfileOrg(packs: PackRegistry, now: () => string, org: string, packId?: string) {
  const pack = packId && packs.has(packId) ? packs.get(packId) : undefined;
  const profile = await assembleProfile(new SfCliClient(org), { objects: profileObjects(pack?.objects), capturedAt: now() });
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(profilePath(org), JSON.stringify(profile, null, 2) + "\n");
  return { profilePath: profilePath(org), recordBudget: profile.recordBudget, objectsProbed: profile.objects.length };
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const profileOrg = deps.profileOrg ?? ((org: string, packId?: string) => defaultProfileOrg(deps.packs, deps.now, org, packId));

  // Flexible BULK-sizing units shared by estimate/generate/materialize — a caller sizes the run however it
  // thinks (records / storage MB / % of storage), on top of the `accounts`/`population` already on each tool.
  // Storage units need a LIVE org profile (data-storage facts). Precedence: population > accounts > records >
  // storageMB > storagePct > leaveFreePct. Run `estimate_dataset` first to see what any of these resolves to.
  const sizeFields = {
    records: z.number().int().positive().optional().describe("Size by a target TOTAL record count across all objects (back-solved to a bulk account count)."),
    storageMB: z.number().positive().optional().describe("Size by a target data-storage footprint in MB (~2KB/record → 512 records/MB)."),
    storagePct: z.number().min(0).max(100).optional().describe("Size to fill up to this % of the org's TOTAL data storage (accounts for what's already used; 100 = use all remaining). Needs a live org profile."),
    leaveFreePct: z.number().min(0).max(100).optional().describe("Size to LEAVE this % of the org's total data storage free (= fill 100 − leaveFreePct). Needs a live org profile."),
  };

  server.registerTool(
    "list_packs",
    {
      title: "List target packs",
      description: "List the target packs available to generate data for (each pack = a schema + scenario vocabulary, e.g. 'salescloud'). Call this first to see what can be generated.",
      inputSchema: {},
    },
    async () => json({ packs: deps.service.listPacks() }),
  );

  server.registerTool(
    "profile_org",
    {
      title: "Profile a Salesforce org",
      description: "Introspect a live Salesforce org (limits, licensing, object/field availability, Data Cloud) into a CapabilityProfile, persisted for later generate calls. Run this once per org before generate_dataset. Requires the `sf` CLI authenticated to the org. Pass synthetic=true to instead write a generous SYNTHETIC standard-org profile (every pack object present, no record budget, no Data Cloud) so you can generate a corpus with NO live org — the loader conforms it to a real org at load time.",
      inputSchema: {
        org: z.string().min(1).describe("Target org alias (must be `sf`-authenticated). With synthetic=true, just the label to file under (e.g. 'standard')."),
        pack: z.string().optional().describe("Also probe this pack's custom objects (default: standard objects only). REQUIRED with synthetic=true."),
        synthetic: z.boolean().optional().describe("Skip the live org and write a synthetic standard-org profile (org-agnostic generation). Requires `pack`."),
      },
    },
    async ({ org, pack, synthetic }) => {
      if (synthetic) {
        if (!pack) return { content: [{ type: "text" as const, text: "synthetic=true requires `pack`" }], isError: true };
        const profile = standardProfile(deps.packs.get(pack), { org });
        mkdirSync(PROFILE_DIR, { recursive: true });
        writeFileSync(profilePath(org), JSON.stringify(profile, null, 2) + "\n");
        return json({ profilePath: profilePath(org), synthetic: true, objectsPresent: profile.objects.length, recordBudget: null });
      }
      return json(await profileOrg(org, pack));
    },
  );

  server.registerTool(
    "generate_dataset",
    {
      title: "Generate a dataset",
      description: "Generate a realistic, narrative-rich dataset for an org+pack and register it (addressable by id). `volume` = foreground narrative deals (live, cascade-firing). The BULK tier (structural accounts that fill the org WITHOUT firing the pipeline) is sized by ANY of: `population` (direct), `accounts` (total), `records` (total record count), `storageMB`, `storagePct`/`leaveFreePct` (relative to the org's data storage — needs a live profile). Call `estimate_dataset` first to see what a size resolves to (records/storage/per-object) before committing. Deterministic from the seed; fills copy via `fill` (default 'static' = free + instant). Returns the dataset id + a summary (incl. budgetCapped if the org's budget clamped it). Requires a profile (profile_org) first.",
      inputSchema: {
        org: z.string().min(1).describe("Target org alias (must have a profile)."),
        pack: z.string().default("salescloud").describe("Target pack id."),
        volume: z.number().int().positive().default(12).describe("Foreground NARRATIVE deals (live, full signal streams, fire the trigger cascade). Clamped to the org's record budget."),
        population: z.number().int().nonnegative().optional().describe("Bulk BACKGROUND accounts beyond `volume` — rich structural records (realistic opps-per-account distribution) with NO email/task/transcript streams, so they fire no cascade. The 'fill the org to scale' knob. Clamped to the remaining budget."),
        accounts: z.number().int().positive().optional().describe("Convenience: target TOTAL account count. Back-solves population = max(0, accounts − volume). Use this when you just want 'fill the org to N accounts'."),
        ...sizeFields,
        bulkDensity: z.number().min(0).max(1).optional().describe("Bulk-graph richness 0–1 (default 0.6) — also scales the per-account record cost used to size by records/storage."),
        userPoolSize: z.number().int().nonnegative().optional().describe("Sales-rep User pool for OwnerId distribution (0 = off, ≤50)."),
        scenarioMix: z.record(z.string(), z.number()).optional().describe("Share per scenario, summing to 100 (default: even split of the pack's arcs)."),
        seed: z.union([z.number().int(), z.string().min(1)]).optional().describe("Reproducibility seed (number or memorable string; default 42)."),
        asOf: z.string().optional().describe("ISO anchor for all timelines (default: now)."),
        dc: z.enum(["auto", "on", "off"]).optional().describe("Data Cloud branch (default auto)."),
        fill: z.enum(["none", "static", "claude-code", "anthropic"]).optional().describe("Fill deferred copy: 'none' (planned only), 'static' (free/instant, default), or an LLM provider. Only foreground deals carry copy; bulk accounts have none."),
        name: z.string().optional().describe("Optional human label for the dataset."),
      },
    },
    async (args) => json(await deps.service.generate(args as Parameters<typeof deps.service.generate>[0])),
  );

  server.registerTool(
    "estimate_dataset",
    {
      title: "Estimate a dataset (dry-run — no writes)",
      description: "DRY-RUN sizing: given any size request (accounts / records / storageMB / storagePct / leaveFreePct / population), return — WITHOUT generating or writing anything — what it resolves to: the final volume + bulk population, total records, storage MB, per-object record counts, the org's storage headroom + where this run would leave it (used%/free% after), whether the org's record budget would clamp it, the foreground LLM-copy call count a `fill` would fire, and the SALESFORCE API-CALL cost a `disperse --sink salesforce` load would incur (restApiCalls/bulkApiBatches, cross-checked against the org's remaining daily limits when known — catches a scratch-org API-budget blowout BEFORE loading, not mid-load as a REQUEST_LIMIT_EXCEEDED failure). This is how a caller 'calculates different things' and iterates before committing to generate_dataset / materialize_corpus. Storage-relative units need a live org profile (profile_org); accounts/records work with any profile (incl. synthetic).",
      inputSchema: {
        org: z.string().min(1).describe("Org alias whose profile (storage/budget) to size against. Use a synthetic profile's label for storage-agnostic sizing (storage units won't resolve)."),
        pack: z.string().default("salescloud").describe("Target pack id."),
        volume: z.number().int().positive().optional().describe("Foreground narrative deals (default 12)."),
        population: z.number().int().nonnegative().optional().describe("Direct bulk account count."),
        accounts: z.number().int().positive().optional().describe("Target TOTAL accounts → population = max(0, accounts − volume)."),
        ...sizeFields,
        bulkDensity: z.number().min(0).max(1).optional().describe("Bulk-graph richness 0–1 (default 0.6) — scales the per-account record cost."),
        userPoolSize: z.number().int().nonnegative().optional().describe("Sales-rep User pool (affects the flat record count)."),
        scenarioMix: z.record(z.string(), z.number()).optional(),
        seed: z.union([z.number().int(), z.string().min(1)]).optional(),
        asOf: z.string().optional(),
        bulkThreshold: z.number().int().positive().optional().describe("Preview apiCost AS IF loaded with this REST→Bulk switch threshold (default 5000, matching disperse_dataset's default). Lower it to preview a scratch-org-safer load."),
      },
    },
    async (args) => guarded("estimate_dataset", () => deps.service.estimate(args as Parameters<typeof deps.service.estimate>[0])),
  );

  server.registerTool(
    "disperse_dataset",
    {
      title: "Disperse a dataset to a sink",
      description: "Disperse a dataset to a destination: 'salesforce' (load into an org), 'file' (write the bundle JSON to a path), or 'return' (hand the records back to you). Resolve the dataset by `datasetId`, or the latest for `org`+`pack`. Generate once, disperse many — every dispersal is recorded in the dataset's load-history.",
      inputSchema: {
        datasetId: z.string().optional().describe("Dataset id to disperse (overrides org/pack resolution)."),
        org: z.string().optional().describe("Resolve the latest dataset for this org (with pack) when datasetId is omitted; also the salesforce target."),
        pack: z.string().optional().describe("Pack id for org-based resolution (default salescloud)."),
        sink: z.enum(["salesforce", "file", "return"]).describe("Where to disperse."),
        target: z.string().optional().describe("Destination: org alias (salesforce, defaults to `org`) or file path (file)."),
        force: z.boolean().optional().describe("salesforce: load even if matching Accounts exist (disables the idempotency skip)."),
        cascade: z.enum(["auto", "off"]).optional().describe("salesforce: 'off' drops the pack's trigger-firing input streams (emails/tasks/transcripts) so the load fills the org STRUCTURALLY with zero async jobs / LLM calls. Default 'auto' (load everything; the pipeline fires). Check generate's `cascade` estimate for the blast radius."),
        checkpoint: z.string().optional().describe("salesforce: a file path to checkpoint load progress. If a large load dies (rate limit / crash), re-running disperse with the SAME path resumes from where it stopped instead of re-loading from object 1. Cleared automatically on a clean finish."),
        bulkThreshold: z.number().int().positive().optional().describe("salesforce: rows-per-object at/above which the loader uses the Bulk API instead of REST collections (default 5000). Lower it to force the Bulk path sooner."),
      },
    },
    async (args) => {
      const report = await deps.service.disperse(args);
      // For 'return', the whole bundle is the payload (the agent asked for the data); else a compact report.
      if (report.sink === "return") return json({ sink: report.sink, records: report.inserted, bundle: report.detail });
      return json({ sink: report.sink, target: report.target, ok: report.ok, inserted: report.inserted, failed: report.failed, skipped: report.skipped, summary: report.summary });
    },
  );

  server.registerTool(
    "list_datasets",
    {
      title: "List datasets in the registry",
      description: "List generated datasets (newest first) with their id, pack, status, params, and record counts. Filter by pack or status ('planned' | 'filled').",
      inputSchema: {
        pack: z.string().optional(),
        status: z.enum(["planned", "filled"]).optional(),
      },
    },
    async ({ pack, status }) =>
      json({
        datasets: deps.service.list({ ...(pack ? { pack } : {}), ...(status ? { status } : {}) }).map((m) => ({
          id: m.id,
          name: m.name,
          pack: m.pack,
          status: m.status,
          org: m.params.org,
          volume: m.params.volume,
          recordCounts: m.provenance.recordCounts ?? {},
          createdAt: m.provenance.createdAt,
        })),
      }),
  );

  server.registerTool(
    "get_dataset",
    {
      title: "Get a dataset's metadata + load-history",
      description: "Inspect one dataset by id: its params, status, record counts, and where it has been dispersed (load-history). To get the actual records, call disperse_dataset with sink='return'.",
      inputSchema: { id: z.string().describe("Dataset id (ds_...).") },
    },
    async ({ id }) => {
      const ds = deps.service.get(id);
      if (!ds) return { content: [{ type: "text" as const, text: `no dataset "${id}"` }], isError: true };
      return json({
        id: ds.id,
        name: ds.name,
        pack: ds.pack,
        status: ds.status,
        params: ds.params,
        totalRecords: totalRecords(ds),
        recordCounts: ds.provenance.recordCounts ?? {},
        provenance: ds.provenance,
        loads: deps.service.loads(id),
      });
    },
  );

  server.registerTool(
    "register_bundle",
    {
      title: "Register your own authored data as a dataset",
      description: "Ingest data YOU authored (not generated here) as a dataset, so you can disperse it like any other — the 'move in static data' path when you already have the records. `records` is keyed by sObject; use _ref (a local id on each record) + _refs ({ field: ref }) for relationships, and the loader resolves them in order. Content-addressed: re-registering the same records is a no-op.",
      inputSchema: {
        pack: z.string().describe("Target pack the records conform to (e.g. 'salescloud')."),
        records: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).describe("sObject → array of record objects (with _ref/_refs for links)."),
        org: z.string().optional().describe("Org this data is intended for (stored in params; default 'imported')."),
        name: z.string().optional(),
      },
    },
    async (args) => json(deps.service.registerBundle(args as { pack: string; records: Record<string, Array<Record<string, unknown>>>; org?: string; name?: string })),
  );

  server.registerTool(
    "compose_stack",
    {
      title: "Compose datasets into a stack",
      description: "Group datasets into an ordered stack (layers), e.g. a config layer + a deals layer + a conversations layer. disperse_stack loads the members in array order. Returns the stack id (stk_…).",
      inputSchema: {
        datasetIds: z.array(z.string()).min(1).describe("Dataset ids (ds_…) in load order."),
        name: z.string().optional(),
      },
    },
    async ({ datasetIds, name }) => json(deps.service.composeStack({ datasetIds, ...(name ? { name } : {}) })),
  );

  server.registerTool(
    "disperse_stack",
    {
      title: "Disperse a stack (its datasets, in order)",
      description: "Disperse every dataset in a stack through one sink, in array order — the layered load. Each member's dispersal is recorded in its own load-history. (File sink writes one file per layer.)",
      inputSchema: {
        stackId: z.string().describe("Stack id (stk_…)."),
        sink: z.enum(["salesforce", "file", "return"]),
        target: z.string().optional().describe("Org alias (salesforce) or base file path (file)."),
        force: z.boolean().optional(),
      },
    },
    async (args) => json(await deps.service.disperseStack(args)),
  );

  server.registerTool(
    "list_stacks",
    { title: "List stacks", description: "List composed stacks (id, name, member dataset ids).", inputSchema: {} },
    async () => json({ stacks: deps.service.listStacks() }),
  );

  server.registerTool(
    "get_stack",
    {
      title: "Get a stack + its member datasets",
      description: "Inspect one stack by id: its ordered member dataset ids + each member's metadata.",
      inputSchema: { id: z.string().describe("Stack id (stk_…).") },
    },
    async ({ id }) => {
      const got = deps.service.getStack(id);
      if (!got) return { content: [{ type: "text" as const, text: `no stack "${id}"` }], isError: true };
      return json(got);
    },
  );

  server.registerTool(
    "materialize_corpus",
    {
      title: "Materialize a corpus into the queryable warehouse",
      description:
        "Generate a corpus and write it into the deterministic SQLite WAREHOUSE — one queryable table per sObject — instead of returning records. This is how you get a LARGE (up to 100K-account) corpus across all objects sitting ready in a database, queryable with query_corpus, WITHOUT a live org. Streams when the pack supports it (bounded memory: ~530MB at 100K). Content-addressed + idempotent: re-running the same (seed, params) is a no-op. Run profile_org with synthetic=true first for a no-org build. Returns the corpus id (ds_…) + per-object counts.",
      inputSchema: {
        org: z.string().min(1).describe("Org alias whose profile to use ('standard' for the synthetic profile)."),
        pack: z.string().default("salescloud").describe("Target pack id."),
        volume: z.number().int().nonnegative().optional().describe("Foreground narrative deals (default 12)."),
        population: z.number().int().nonnegative().optional().describe("Bulk background accounts — the scale knob (e.g. 100000). Clamped to 200000 on this surface."),
        accounts: z.number().int().positive().optional().describe("Convenience: target TOTAL accounts → population = max(0, accounts − volume)."),
        ...sizeFields,
        bulkDensity: z.number().min(0).max(1).optional().describe("Bulk graph richness 0–1 (default 0.6) — also scales the per-account record cost used to size by records/storage."),
        userPoolSize: z.number().int().nonnegative().optional().describe("Sales-rep User pool for OwnerId distribution (0 = off; ≤50)."),
        scenarioMix: z.record(z.string(), z.number()).optional().describe("Share per scenario, summing to 100 (default even split)."),
        seed: z.union([z.number().int(), z.string().min(1)]).optional().describe("Reproducibility seed (number or string; default 42)."),
        asOf: z.string().optional().describe("Timeline anchor (default a fixed date so re-runs are cache no-ops)."),
        batch: z.number().int().positive().optional().describe("Accounts per streaming batch (default 5000)."),
        rematerialize: z.boolean().optional().describe("Rebuild even if a matching corpus already exists."),
      },
    },
    async (args) => guarded("materialize_corpus", () => deps.service.materializeCorpus(args as Parameters<typeof deps.service.materializeCorpus>[0])),
  );

  server.registerTool(
    "query_corpus",
    {
      title: "Query the corpus warehouse",
      description:
        "Read a materialized corpus (the accessible-database surface). No args → LIST all corpora. With datasetId → per-object record counts. With datasetId + object → sample rows for that sObject. With sql → run a single read-only SELECT against the warehouse tables (named wh_<sObject>, e.g. wh_Account, wh_Opportunity; the full record is in payload_json — use json_extract(payload_json,'$.Field')). Results are row-capped.",
      inputSchema: {
        datasetId: z.string().optional().describe("Corpus id (ds_…) to inspect. Omit (with no sql) to list all corpora."),
        object: z.string().optional().describe("Sample rows for this sObject (needs datasetId)."),
        limit: z.number().int().positive().optional().describe("Row cap for samples / a SELECT (hard-capped)."),
        sql: z.string().optional().describe('A single read-only SELECT, e.g. "SELECT json_extract(payload_json,\'$.StageName\') AS stage, count(*) n FROM wh_Opportunity GROUP BY stage".'),
      },
    },
    async (args) => guarded("query_corpus", () => deps.service.queryCorpus(args as Parameters<typeof deps.service.queryCorpus>[0])),
  );

  server.registerTool(
    "select_accounts",
    {
      title: "Select accounts by state + their full graph",
      description:
        "Pull N accounts of a given overall STATE from a materialized corpus, WITH every related record (the referentially-closed account graph: Contacts, Opportunities, line items, emails, tasks, transcripts, cases, …) — built so an agent can test a feature against a specific data state. States: 'healthy' (customer sentiment good — Account.Rating Hot), 'at-risk' (sentiment going badly — Rating Cold, any reason), 'mixed' (contested / watch — Rating Warm), 'expansion' (a prior Closed-Won plus a still-open deal), 'urgent' (an open deal closing within ~30 days of the corpus asOf — time pressure), 'churning' (Rating Cold AND an active Escalated support Case — a converging churn signal, narrower/more actionable than plain at-risk). Returns accountsMatched (how many of that state exist in the corpus) vs accountsReturned, per-object counts, and the records. Capped for safety (≤500 accounts, ≤100K records).",
      inputSchema: {
        datasetId: z.string().describe("The materialized corpus id (ds_…) — from materialize_corpus / query_corpus."),
        state: z.enum([...ACCOUNT_STATES] as [string, ...string[]]).describe("Overall account state to pull: healthy | at-risk | mixed | expansion | urgent | churning."),
        count: z.number().int().positive().optional().describe("How many accounts to return (their full graph comes along). Default 10; capped at 500."),
        maxRecords: z.number().int().positive().optional().describe("Hard ceiling on total records returned (trims accounts to fit). Default 25000; capped at 100000."),
      },
    },
    async (args) => guarded("select_accounts", () => deps.service.selectAccounts(args as Parameters<typeof deps.service.selectAccounts>[0])),
  );
}

/** Build an McpServer with the dataseed tools registered. */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "dataseed", version: "0.1.0" });
  registerTools(server, deps);
  return server;
}
