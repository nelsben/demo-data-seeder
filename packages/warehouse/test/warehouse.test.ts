import { describe, it, expect } from "vitest";
import type { BundleRecords, BundlePlan } from "@dataseed/core";
import { WarehouseStore } from "../src/warehouse-store.js";
import { corpusKey, GENERATOR_VERSION } from "../src/cache-key.js";
import { tableName } from "../src/schema.js";

const MANIFEST = { dsId: "ds_test01", pack: "salescloud", seed: 42, paramsHash: "ph", generatorVersion: GENERATOR_VERSION, cacheKey: "ck_test" };
const BUILT_AT = "2026-01-01T00:00:00.000Z";

const records = (): BundleRecords => ({
  Account: [
    { _ref: "a0", Name: "Acme" },
    { _ref: "a1", Name: "Globex" },
  ],
  Opportunity: [
    { _ref: "o0", _refs: { AccountId: "a0" }, Name: "Acme Expansion", Amount: 100_000, StageName: "Closed Won", _meta: { tier: "bulk" } },
    { _ref: "o1", _refs: { AccountId: "a1" }, Name: "Globex Eval", Amount: 50_000, StageName: "Prospecting", _meta: { tier: "bulk" } },
    { _ref: "o2", _refs: { AccountId: "a0" }, Name: "Acme Renewal", Amount: 25_000, StageName: "Closed Won", _meta: { tier: "bulk" } },
  ],
});

const open = () => new WarehouseStore(":memory:");

describe("WarehouseStore — per-sObject tables, content-addressed", () => {
  it("writes a bundle and round-trips every record byte-identically (emit order preserved)", () => {
    const wh = open();
    const src = records();
    const counts = wh.writeBundle(MANIFEST, src, BUILT_AT);
    expect(counts).toEqual({ Account: 2, Opportunity: 3 });
    // readObject reconstructs the EXACT records (the payload_json is the source of truth).
    expect(JSON.stringify(wh.readObject("ds_test01", "Account"))).toBe(JSON.stringify(src.Account));
    expect(JSON.stringify(wh.readObject("ds_test01", "Opportunity"))).toBe(JSON.stringify(src.Opportunity));
    wh.close();
  });

  it("is SQL-queryable — promoted columns + json_extract over the payload", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    // promoted parent_ref column → real joins without touching JSON
    const parents = wh.query(`SELECT name, parent_ref FROM ${tableName("Opportunity")} WHERE ds_id='ds_test01' ORDER BY seq`) as { name: string; parent_ref: string }[];
    expect(parents.map((r) => r.parent_ref)).toEqual(["a0", "a1", "a0"]);
    // json_extract reaches any field in the payload — pipeline by stage
    const byStage = wh.query(`SELECT json_extract(payload_json,'$.StageName') AS stage, count(*) AS n, sum(json_extract(payload_json,'$.Amount')) AS total FROM ${tableName("Opportunity")} WHERE ds_id='ds_test01' GROUP BY stage ORDER BY n DESC`) as { stage: string; n: number; total: number }[];
    expect(byStage[0]).toEqual({ stage: "Closed Won", n: 2, total: 125_000 });
    expect(byStage[1]).toEqual({ stage: "Prospecting", n: 1, total: 50_000 });
    wh.close();
  });

  it("rejects anything but a single read-only SELECT", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    expect(() => wh.query("DELETE FROM wh_Account")).toThrow();
    expect(() => wh.query("SELECT 1; DROP TABLE wh_Account")).toThrow();
    wh.close();
  });

  it("finds a corpus by cache key (idempotency) and re-write replaces in place", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    expect(wh.findByCacheKey("ck_test")?.totalRecords).toBe(5);
    expect(wh.findByCacheKey("nope")).toBeUndefined();
    // re-materialize the same dsId → replaced, not duplicated
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    expect(wh.query(`SELECT count(*) AS n FROM ${tableName("Account")}`)).toEqual([{ n: 2 }]);
    wh.close();
  });

  it("purges a corpus entirely", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    wh.purge("ds_test01");
    expect(wh.getManifest("ds_test01")).toBeUndefined();
    expect(wh.readObject("ds_test01", "Account")).toEqual([]);
    wh.close();
  });

  // R2: the categorized-retrieval primitives behind select_accounts.
  it("selectAccountRefs returns matching refs (capped) plus the TOTAL match count", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, { Account: [
      { _ref: "a0", Name: "Hot", Rating: "Hot" },
      { _ref: "a1", Name: "Cold", Rating: "Cold" },
      { _ref: "a2", Name: "Hot2", Rating: "Hot" },
    ] }, BUILT_AT);
    const all = wh.selectAccountRefs("ds_test01", "json_extract(a.payload_json,'$.Rating')='Hot'", 10);
    expect(all.total).toBe(2);
    expect(all.refs.sort()).toEqual(["a0", "a2"]);
    const capped = wh.selectAccountRefs("ds_test01", "json_extract(a.payload_json,'$.Rating')='Hot'", 1);
    expect(capped.refs).toHaveLength(1); // limited…
    expect(capped.total).toBe(2); // …but total still reflects all matches
    wh.close();
  });

  it("readByRefs fetches exactly the requested rows (empty refs → [])", () => {
    const wh = open();
    wh.writeBundle(MANIFEST, records(), BUILT_AT);
    expect(wh.readByRefs("ds_test01", "Account", ["a1"]).map((r) => r.Name)).toEqual(["Globex"]);
    expect(wh.readByRefs("ds_test01", "Account", [])).toEqual([]);
    wh.close();
  });
});

describe("corpusKey — covers every byte-determining input", () => {
  const base = { pack: "salescloud", mode: "inputs", withDc: false, seed: 42, asOf: "2026-01-01T00:00:00.000Z", requestedVolume: 10, volume: 10, population: 100, bulkDensity: 0.6, userPoolSize: 10, userProfileName: "Standard User", scenarioCounts: { a: 10 }, namespacePrefix: null } as unknown as BundlePlan;
  it("is stable for identical inputs and changes when any byte-determining field changes", () => {
    expect(corpusKey(base).cacheKey).toBe(corpusKey({ ...base }).cacheKey);
    expect(corpusKey({ ...base, seed: 43 }).cacheKey).not.toBe(corpusKey(base).cacheKey);
    expect(corpusKey({ ...base, population: 200 }).cacheKey).not.toBe(corpusKey(base).cacheKey);
    expect(corpusKey({ ...base, asOf: "2025-01-01T00:00:00.000Z" }).cacheKey).not.toBe(corpusKey(base).cacheKey);
    expect(corpusKey({ ...base, userPoolSize: 0 }).cacheKey).not.toBe(corpusKey(base).cacheKey);
  });
});
