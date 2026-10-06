import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PackRegistry, CapabilityProfile, GenericRecord, type TargetPack } from "@dataseed/core";
import { SqliteRegistryStore, makeDatasetService } from "@dataseed/engine";
import { WarehouseStore } from "@dataseed/warehouse";
import { buildMcpServer, type McpDeps } from "../src/tools.js";

const NOW = "2026-06-18T12:00:00.000Z";

const fakePack: TargetPack = {
  id: "fake",
  label: "Fake",
  description: "test pack",
  objects: ["Account", "Opportunity"],
  picklists: {},
  scenarios: ["alpha", "beta", "gamma"],
  recordSchemas: { Account: GenericRecord, Opportunity: GenericRecord },
  variability: {},
  recordsPerUnitEstimate: 2,
  recordsPerPopulationUnitEstimate: 1, // each bulk unit = 1 extra Account (so population flows end-to-end)
  checkRequirements: () => [],
  generate: (ctx) => ({
    records: {
      Account: [
        { _ref: "a0", Name: "Acme", Rating: "Hot" },
        { _ref: "a1", Name: "Globex", Rating: "Cold" },
        ...Array.from({ length: ctx.plan.population }, (_, i) => ({ _ref: `b${i}`, Name: `Bulk ${i}`, Rating: "Warm" })),
      ],
      Opportunity: [{ _ref: "o0", _refs: { AccountId: "a0" }, Name: "Acme Deal", Amount: 50000, StageName: "Prospecting", CloseDate: "2026-09-01" }],
    },
  }),
};

const stubProfile = (org: string) =>
  CapabilityProfile.parse({
    org,
    capturedAt: NOW,
    recordBudget: 100_000,
    namespacePrefix: null,
    copyProvider: "static",
    dataCloud: { licensed: false, available: false, evidence: "stub", gateState: null, instrumentedLimits: false },
    objects: [{ apiName: "Account", present: true, blockedRequiredFields: [] }],
  });

async function connect() {
  const packs = new PackRegistry().register(fakePack);
  // Inject an in-memory warehouse so corpus tools don't touch the real .dataseed/warehouse.db. One
  // connection per service so materialize + query (same client) share the same :memory: db.
  const service = makeDatasetService({ packs, store: new SqliteRegistryStore(":memory:"), warehouse: new WarehouseStore(":memory:"), now: () => NOW, loadProfile: stubProfile });
  const deps: McpDeps = {
    service,
    packs,
    now: () => NOW,
    profileOrg: async (org, pack) => ({ profilePath: `/x/${org}.json`, recordBudget: 100_000, objectsProbed: pack ? 5 : 3 }),
  };
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(deps).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = res.content[0]!.text;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text; // error tools return a plain message, not JSON
  }
  return { isError: res.isError ?? false, data, text };
};

describe("dataseed MCP tools — agent-callable surface", () => {
  it("exposes the tool surface agents discover", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "compose_stack",
        "disperse_dataset",
        "disperse_stack",
        "estimate_dataset",
        "generate_dataset",
        "get_dataset",
        "get_stack",
        "list_datasets",
        "list_packs",
        "list_stacks",
        "materialize_corpus",
        "profile_org",
        "query_corpus",
        "register_bundle",
        "select_accounts",
      ].sort(),
    );
  });

  it("estimate_dataset is a DRY-RUN — resolves a size, projects records, writes nothing", async () => {
    const client = await connect();
    const r = await call(client, "estimate_dataset", { org: "demo-org", pack: "fake", volume: 4, accounts: 100 });
    expect(r.isError).toBe(false);
    expect(r.data.resolved.population).toBe(96); // 100 − volume 4
    expect(r.data.resolved.unit).toBe("accounts");
    expect(r.data.estimatedRecords).toBeGreaterThan(0);
    expect(Array.isArray(r.data.caveats)).toBe(true);
    // apiCost — the Salesforce API-call budget preview (regression: it must actually reach the tool response,
    // not get dropped by a future handler rewrite).
    expect(r.data.apiCost.bulkThreshold).toBe(5000);
    expect(typeof r.data.apiCost.restApiCalls).toBe("number");
    const list = await call(client, "list_datasets", {});
    expect(list.data.datasets).toHaveLength(0); // estimate registered nothing
  });

  it("estimate_dataset forwards a caller-supplied bulkThreshold through to apiCost", async () => {
    const client = await connect();
    const r = await call(client, "estimate_dataset", { org: "demo-org", pack: "fake", volume: 4, accounts: 100, bulkThreshold: 10 });
    expect(r.isError).toBe(false);
    expect(r.data.apiCost.bulkThreshold).toBe(10); // NOT the 5000 default — proves the arg actually reached service.estimate()
  });

  it("generate_dataset `accounts` back-solves population = accounts − volume", async () => {
    const client = await connect();
    const r = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 3, accounts: 10, fill: "none" });
    expect(r.data.plan.population).toBe(7); // 10 total − 3 foreground
    expect(r.data.recordCounts.Account).toBe(2 + 7); // 2 base + 7 bulk
  });

  it("generate_dataset accepts an explicit population (the bulk fill knob)", async () => {
    const client = await connect();
    const r = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 1, population: 25, fill: "none" });
    expect(r.data.plan.population).toBe(25);
    expect(r.data.recordCounts.Account).toBe(2 + 25);
  });

  it("generate_dataset returns a cascade blast-radius estimate", async () => {
    const client = await connect();
    const r = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 1, fill: "none" });
    expect(r.data.cascade).toBeDefined();
    expect(typeof r.data.cascade.streamRecords).toBe("number"); // fakePack has no cascadeObjects → 0
  });

  it("generate_dataset clamps an oversized volume (DoS guard, regression) and flags it", async () => {
    const client = await connect();
    const r = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 999_999, fill: "none" });
    expect(r.isError ?? false).toBe(false);
    expect(r.data.volumeClamped).toBe(999_999); // reports the original request; the dataset used the cap
    expect(r.data.plan.volume).toBeLessThan(999_999);
  });

  it("register_bundle → disperse: ingest the agent's OWN data, then get it back", async () => {
    const client = await connect();
    const reg = await call(client, "register_bundle", {
      pack: "fake",
      records: { Account: [{ _ref: "a0", Name: "Agent Authored" }] },
      name: "authored",
    });
    expect(reg.data.datasetId).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(reg.data.status).toBe("filled");
    const disp = await call(client, "disperse_dataset", { datasetId: reg.data.datasetId, sink: "return" });
    expect(disp.data.bundle.records.Account[0].Name).toBe("Agent Authored");
  });

  it("compose_stack → disperse_stack: layer datasets and disperse them in order", async () => {
    const client = await connect();
    const a = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 2, seed: "A", fill: "none" });
    const b = await call(client, "register_bundle", { pack: "fake", records: { Account: [{ _ref: "x", Name: "Layer B" }] } });
    const stack = await call(client, "compose_stack", { datasetIds: [a.data.datasetId, b.data.datasetId], name: "world" });
    expect(stack.data.id).toMatch(/^stk_[0-9a-f]{12}$/);

    const disp = await call(client, "disperse_stack", { stackId: stack.data.id, sink: "return" });
    expect(disp.data.reports.map((r: { datasetId: string }) => r.datasetId)).toEqual([a.data.datasetId, b.data.datasetId]);
    expect(disp.data.reports.every((r: { ok: boolean }) => r.ok)).toBe(true);

    const list = await call(client, "list_stacks");
    expect(list.data.stacks).toHaveLength(1);
    const got = await call(client, "get_stack", { id: stack.data.id });
    expect(got.data.datasets).toHaveLength(2);
  });

  it("list_packs returns what can be generated", async () => {
    const client = await connect();
    const { data } = await call(client, "list_packs");
    expect(data.packs[0].id).toBe("fake");
  });

  it("profile_org delegates to the injected introspector", async () => {
    const client = await connect();
    const { data } = await call(client, "profile_org", { org: "demo-org", pack: "fake" });
    expect(data.objectsProbed).toBe(5);
    expect(data.recordBudget).toBe(100_000);
  });

  it("generate_dataset → disperse_dataset(return): create static data + get it back", async () => {
    const client = await connect();
    const gen = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 2, fill: "none" });
    expect(gen.data.datasetId).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(gen.data.totalRecords).toBe(3);

    const disp = await call(client, "disperse_dataset", { datasetId: gen.data.datasetId, sink: "return" });
    expect(disp.data.sink).toBe("return");
    expect(disp.data.bundle.records.Account).toHaveLength(2);
  });

  it("list_datasets + get_dataset reflect the registry (incl. load-history)", async () => {
    const client = await connect();
    const gen = await call(client, "generate_dataset", { org: "demo-org", pack: "fake", volume: 2, fill: "none" });
    await call(client, "disperse_dataset", { datasetId: gen.data.datasetId, sink: "return" });

    const list = await call(client, "list_datasets", {});
    expect(list.data.datasets).toHaveLength(1);
    expect(list.data.datasets[0].id).toBe(gen.data.datasetId);

    const got = await call(client, "get_dataset", { id: gen.data.datasetId });
    expect(got.data.totalRecords).toBe(3);
    expect(got.data.loads).toHaveLength(1);
    expect(got.data.loads[0].sink).toBe("return");
  });

  it("get_dataset on an unknown id is a clean tool error", async () => {
    const client = await connect();
    const res = await call(client, "get_dataset", { id: "ds_does_not_xx" });
    expect(res.isError).toBe(true);
  });

  it("materialize_corpus → query_corpus: build a corpus in the warehouse, then read it back", async () => {
    const client = await connect();
    const mat = await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 2, population: 5, seed: "corp" });
    expect(mat.data.datasetId).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(mat.data.alreadyMaterialized).toBe(false);
    expect(mat.data.recordCounts.Account).toBe(7); // 2 fixed + 5 bulk
    expect(mat.data.totalRecords).toBe(8); // + 1 Opportunity

    // list corpora
    const list = await call(client, "query_corpus", {});
    expect(list.data.mode).toBe("list");
    expect(list.data.corpora).toHaveLength(1);
    expect(list.data.corpora[0].datasetId).toBe(mat.data.datasetId);

    // per-object counts
    const counts = await call(client, "query_corpus", { datasetId: mat.data.datasetId });
    expect(counts.data.mode).toBe("counts");
    expect(counts.data.counts.Account).toBe(7);

    // sample rows for an object
    const sample = await call(client, "query_corpus", { datasetId: mat.data.datasetId, object: "Account", limit: 3 });
    expect(sample.data.mode).toBe("sample");
    expect(sample.data.total).toBe(7);
    expect(sample.data.rows).toHaveLength(3);

    // select_accounts: pull accounts by sentiment state + their closed graph (Acme is the only Hot account)
    const sel = await call(client, "select_accounts", { datasetId: mat.data.datasetId, state: "healthy", count: 5 });
    expect(sel.data.mode).toBe("select");
    expect(sel.data.found).toBe(true);
    expect(sel.data.accountsMatched).toBe(1);
    expect(sel.data.records.Account).toHaveLength(1);
    expect(sel.data.records.Account[0].Rating).toBe("Hot");
    expect(sel.data.records.Account[0].Name).toBe("Acme");
  });

  it("query_corpus runs a row-capped read-only SELECT (json_extract over payload)", async () => {
    const client = await connect();
    await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 2, population: 3, seed: "sql" });
    const res = await call(client, "query_corpus", { sql: "SELECT json_extract(payload_json,'$.StageName') AS stage, count(*) n FROM wh_Opportunity GROUP BY stage" });
    expect(res.data.mode).toBe("sql");
    expect(res.data.rows).toEqual([{ stage: "Prospecting", n: 1 }]);
  });

  it("query_corpus rejects a non-SELECT (no writes through the read surface)", async () => {
    const client = await connect();
    await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 1, population: 1, seed: "guard" });
    const res = await call(client, "query_corpus", { sql: "DELETE FROM wh_Account" });
    expect(res.isError).toBe(true);
  });

  it("materialize_corpus is idempotent on the cache key (re-run = no-op)", async () => {
    const client = await connect();
    const a = await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 2, population: 4, seed: "idem" });
    const b = await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 2, population: 4, seed: "idem" });
    expect(a.data.alreadyMaterialized).toBe(false);
    expect(b.data.alreadyMaterialized).toBe(true);
    expect(b.data.datasetId).toBe(a.data.datasetId);
  });

  it("corpora differing only in asOf COEXIST — no silent eviction (regression)", async () => {
    const client = await connect();
    const base = { org: "standard", pack: "fake", volume: 2, population: 3, seed: "asof" };
    const a = await call(client, "materialize_corpus", { ...base, asOf: "2026-01-01T00:00:00.000Z" });
    const b = await call(client, "materialize_corpus", { ...base, asOf: "2025-06-01T00:00:00.000Z" });
    expect(b.data.datasetId).not.toBe(a.data.datasetId); // distinct asOf → distinct corpus id
    const ids = () => (call(client, "query_corpus", {}) as Promise<{ data: { corpora: Array<{ datasetId: string }> } }>).then((r) => r.data.corpora.map((c) => c.datasetId).sort());
    expect(await ids()).toEqual([a.data.datasetId, b.data.datasetId].sort()); // BOTH present
    // re-materializing A is an idempotent no-op AND B is untouched
    const a2 = await call(client, "materialize_corpus", { ...base, asOf: "2026-01-01T00:00:00.000Z" });
    expect(a2.data.alreadyMaterialized).toBe(true);
    expect(a2.data.datasetId).toBe(a.data.datasetId);
    expect(await ids()).toHaveLength(2);
  });

  it("materialize_corpus clamps an oversized volume (DoS guard) and flags it", async () => {
    const client = await connect();
    const r = await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 999_999, population: 1, seed: "clamp" });
    expect(r.isError ?? false).toBe(false);
    expect(r.data.volumeClamped).toBe(999_999); // reports the original request; the corpus used the cap
  });

  it("query_corpus returns a CLEAN tool error on bad SQL (no raw SQLite/Zod leak)", async () => {
    const client = await connect();
    await call(client, "materialize_corpus", { org: "standard", pack: "fake", volume: 1, population: 1, seed: "err" });
    const res = await call(client, "query_corpus", { sql: "SELECT * FROM wh_DoesNotExist" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/query_corpus failed/);
  });
});
