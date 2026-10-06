import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { ScopeParams, NarrativeBundle } from "@dataseed/core";
import { SqliteRegistryStore, openRegistry, datasetId, stackId, canonicalJson, buildDataset, recordCounts } from "../src/index.js";
import type { Dataset } from "../src/index.js";

const params = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 5, scenarioMix: { "healthy-tech": 100 }, ...over });

const bundle = (records: Record<string, unknown[]> = { Account: [{ _ref: "a0", Name: "Stripe" }, { _ref: "a1", Name: "Okta" }] }) =>
  NarrativeBundle.parse({
    records,
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 42, asOf: "2026-06-18T00:00:00.000Z", requestedVolume: 5, volume: 5 },
  });

const NOW = "2026-06-18T12:00:00.000Z";
const LATER = "2026-06-18T18:00:00.000Z";

function planned(over: { params?: ReturnType<typeof params>; now?: string; name?: string } = {}): Dataset {
  return buildDataset({ pack: "salescloud", params: over.params ?? params(), bundle: bundle(), engineVersion: "test-1", now: over.now ?? NOW, ...(over.name ? { name: over.name } : {}) });
}

describe("datasetId / canonicalJson / stackId", () => {
  it("content-addresses datasets: same request → same id, different request → different id", () => {
    expect(datasetId("salescloud", params())).toBe(datasetId("salescloud", params()));
    expect(datasetId("salescloud", params({ volume: 5 }))).not.toBe(datasetId("salescloud", params({ volume: 6 })));
    expect(datasetId("salescloud", params())).not.toBe(datasetId("acme", params()));
    expect(datasetId("salescloud", params())).toMatch(/^ds_[0-9a-f]{12}$/);
    // asOf is a timeline anchor, NOT identity — re-planning the same knobs at a later asOf is a refresh.
    expect(datasetId("salescloud", params({ asOf: "2026-01-01T00:00:00.000Z" }))).toBe(datasetId("salescloud", params({ asOf: "2026-12-31T00:00:00.000Z" })));
    // ...but seed IS identity (it changes the generated data).
    expect(datasetId("salescloud", params({ seed: 1 }))).not.toBe(datasetId("salescloud", params({ seed: 2 })));
  });

  it("canonical JSON is key-order-insensitive (so equal params hash equally)", () => {
    expect(canonicalJson({ b: 1, a: [3, { y: 1, x: 2 }] })).toBe(canonicalJson({ a: [3, { x: 2, y: 1 }], b: 1 }));
  });

  it("stack id is order-sensitive (stacks are layered)", () => {
    expect(stackId(["ds_a", "ds_b"])).toBe(stackId(["ds_a", "ds_b"]));
    expect(stackId(["ds_a", "ds_b"])).not.toBe(stackId(["ds_b", "ds_a"]));
    expect(stackId(["ds_a"])).toMatch(/^stk_[0-9a-f]{12}$/);
  });
});

describe("recordCounts / buildDataset", () => {
  it("counts records per sobject", () => {
    expect(recordCounts(bundle({ Account: [{}, {}], Contact: [{}] }))).toEqual({ Account: 2, Contact: 1 });
  });
  it("builds a planned dataset with content-addressed id + injected clock", () => {
    const d = planned();
    expect(d.id).toBe(datasetId("salescloud", params()));
    expect(d.status).toBe("planned");
    expect(d.provenance.createdAt).toBe(NOW);
    expect(d.provenance.updatedAt).toBe(NOW);
    expect(d.provenance.recordCounts).toEqual({ Account: 2 });
  });
  it("on re-plan preserves createdAt + name, bumps updatedAt", () => {
    const first = planned({ name: "hero" });
    const refilled = buildDataset({ pack: "salescloud", params: params(), bundle: bundle(), engineVersion: "test-2", now: LATER, status: "filled", prior: first });
    expect(refilled.id).toBe(first.id);
    expect(refilled.name).toBe("hero"); // preserved from prior
    expect(refilled.status).toBe("filled");
    expect(refilled.provenance.createdAt).toBe(NOW); // preserved
    expect(refilled.provenance.updatedAt).toBe(LATER); // bumped
  });
});

describe("SqliteRegistryStore (in-memory)", () => {
  let store: SqliteRegistryStore;
  afterEach(() => store?.close());

  it("put → get roundtrips the full dataset incl. bundle", () => {
    store = new SqliteRegistryStore(":memory:");
    const d = planned({ name: "hero" });
    store.put(d);
    const got = store.get(d.id);
    expect(got).not.toBeNull();
    expect(got!.bundle).toEqual(d.bundle);
    expect(got!.params).toEqual(d.params);
    expect(got!.name).toBe("hero");
    expect(got!.provenance.recordCounts).toEqual({ Account: 2 });
    expect(store.get("ds_nope")).toBeNull();
  });

  it("getMeta returns metadata without decoding the bundle blob", () => {
    store = new SqliteRegistryStore(":memory:");
    const d = planned();
    store.put(d);
    const meta = store.getMeta(d.id)!;
    expect(meta.id).toBe(d.id);
    expect(meta.pack).toBe("salescloud");
    expect("bundle" in (meta as unknown as Record<string, unknown>)).toBe(false);
  });

  it("upsert: re-put updates status/provenance, preserves identity", () => {
    store = new SqliteRegistryStore(":memory:");
    const first = planned();
    store.put(first);
    const filled = buildDataset({ pack: "salescloud", params: params(), bundle: bundle(), engineVersion: "test-2", now: LATER, status: "filled", prior: first });
    store.put(filled);
    expect(store.list()).toHaveLength(1); // same id → one row
    const got = store.get(first.id)!;
    expect(got.status).toBe("filled");
    expect(got.provenance.createdAt).toBe(NOW);
    expect(got.provenance.updatedAt).toBe(LATER);
  });

  it("list filters by pack/status and orders newest-first", () => {
    store = new SqliteRegistryStore(":memory:");
    const a = buildDataset({ pack: "salescloud", params: params({ volume: 5 }), bundle: bundle(), engineVersion: "t", now: NOW });
    const b = buildDataset({ pack: "salescloud", params: params({ volume: 9 }), bundle: bundle(), engineVersion: "t", now: LATER, status: "filled" });
    store.put(a);
    store.put(b);
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]); // LATER first
    expect(store.list({ status: "filled" }).map((m) => m.id)).toEqual([b.id]);
    expect(store.list({ pack: "salescloud" })).toHaveLength(2);
    expect(store.list({ pack: "absent" })).toHaveLength(0);
  });

  it("remove deletes the dataset + cascades its load-history", () => {
    store = new SqliteRegistryStore(":memory:");
    const d = planned();
    store.put(d);
    store.recordLoad({ datasetId: d.id, sink: "salesforce", target: "demo-org", at: NOW, inserted: 12 });
    expect(store.loadsFor(d.id)).toHaveLength(1);
    expect(store.remove(d.id)).toBe(true);
    expect(store.get(d.id)).toBeNull();
    expect(store.loadsFor(d.id)).toHaveLength(0); // cascaded
    expect(store.remove(d.id)).toBe(false); // already gone
  });

  it("records dispersals as load-history, newest-first, fields intact", () => {
    store = new SqliteRegistryStore(":memory:");
    const d = planned();
    store.put(d);
    store.recordLoad({ datasetId: d.id, sink: "salesforce", target: "demo-org", at: NOW, inserted: 10, failed: 0, report: { ok: true } });
    store.recordLoad({ datasetId: d.id, sink: "file", target: "/tmp/out.json", at: LATER, inserted: 10 });
    const loads = store.loadsFor(d.id);
    expect(loads.map((l) => l.sink)).toEqual(["file", "salesforce"]); // newest-first
    const sf = loads.find((l) => l.sink === "salesforce")!;
    expect(sf.inserted).toBe(10);
    expect(sf.report).toEqual({ ok: true });
    expect(loads.find((l) => l.sink === "file")!.report).toBeUndefined();
  });

  it("stores + composes stacks (ordered dataset layers)", () => {
    store = new SqliteRegistryStore(":memory:");
    const s = { id: stackId(["ds_a", "ds_b"]), name: "fintech-demo", datasetIds: ["ds_a", "ds_b"], createdAt: NOW };
    store.putStack(s);
    expect(store.getStack(s.id)).toEqual(s);
    expect(store.listStacks()).toHaveLength(1);
    store.putStack({ ...s, name: "renamed" }); // upsert
    expect(store.getStack(s.id)!.name).toBe("renamed");
    expect(store.listStacks()).toHaveLength(1);
  });
});

describe("SqliteRegistryStore (on disk)", () => {
  const dbPath = join(tmpdir(), `dataseed-registry-test-${process.pid}.db`);
  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  });

  it("persists across close/reopen", () => {
    const first = openRegistry(dbPath);
    const d = planned({ name: "persisted" });
    first.put(d);
    first.close();
    expect(existsSync(dbPath)).toBe(true);

    const reopened = openRegistry(dbPath);
    const got = reopened.get(d.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe("persisted");
    expect(got!.bundle).toEqual(d.bundle);
    reopened.close();
  });
});
