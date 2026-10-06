import { describe, it, expect } from "vitest";
import { ScopeParams, standardProfile, type GenericRecord } from "@dataseed/core";
import { buildBundle, planBundle, streamMaterialize, fillForegroundCopy } from "@dataseed/engine";
import { WarehouseStore, corpusKey, GENERATOR_VERSION } from "@dataseed/warehouse";
import { salescloudPack } from "../src/index.js";

const ASOF = "2026-01-01T00:00:00.000Z";
const scopeOf = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "standard", pack: "salescloud", volume: 3, population: 400, userPoolSize: 10, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
const corpus = (over: Record<string, unknown> = {}) => buildBundle(scopeOf(over), standardProfile(salescloudPack), salescloudPack, ASOF);
const manifestFor = (plan: { seed: number }, dsId: string) => {
  const { paramsHash, cacheKey } = corpusKey(plan as never);
  return { dsId, pack: "salescloud", seed: plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey };
};

const isBulk = (r: GenericRecord) => (r._meta as { tier?: string } | undefined)?.tier === "bulk";
/** The account index a bulk ref belongs to: the first numeric segment of `bulk-<type>-<i>[-...]`. */
const acctIndexOf = (ref: string): string | null => ref.match(/^bulk-[a-z]+-(\d+)/)?.[1] ?? null;

describe("corpus warehouse — the real generated corpus round-trips + is evictable", () => {
  it("materializes a real corpus and reads back every object byte-identically", () => {
    const b = corpus();
    const wh = new WarehouseStore(":memory:");
    const { paramsHash, cacheKey } = corpusKey(b.plan);
    const counts = wh.writeBundle({ dsId: "ds_corp", pack: "salescloud", seed: b.plan.seed, paramsHash, generatorVersion: GENERATOR_VERSION, cacheKey }, b.records, ASOF);
    // every object reconstructs exactly (payload_json is the source of truth) AND counts match the bundle
    for (const [obj, rows] of Object.entries(b.records)) {
      if (!rows?.length) continue;
      expect(counts[obj]).toBe(rows.length);
      expect(JSON.stringify(wh.readObject("ds_corp", obj))).toBe(JSON.stringify(rows));
    }
    wh.close();
  });

  it("REF-LOCALITY INVARIANT — every bulk ref is index-i-local or a pinned shared ref (eviction safety)", () => {
    // Derived from the ACTUAL emitted refs, not a hand-set flag: a bulk record may only point at records
    // in its OWN account's subtree (bulk-*-${i}-*) or at a non-bulk shared ref (catalog/user/role/@existing/
    // pricebook). A future cross-account bulk relationship breaks this — and a streaming loader that evicts
    // an account's refs after loading it would then silently drop records. This test fails the day that lands.
    const b = corpus();
    const offenders: string[] = [];
    for (const rows of Object.values(b.records)) {
      for (const rec of rows ?? []) {
        if (!isBulk(rec)) continue;
        const self = (rec._ref as string | undefined) ?? "";
        const refs = { ...(rec._refs as Record<string, string> | undefined), ...(rec._softRefs as Record<string, string> | undefined) };
        // the record's own account index — from its _ref, else from a bulk parent ref it points at
        const i = acctIndexOf(self) ?? Object.values(refs).map((t) => acctIndexOf(t)).find((x) => x != null) ?? null;
        for (const target of Object.values(refs)) {
          if (!target.startsWith("bulk-")) continue; // non-bulk = shared/pinned (allowed, never evicted)
          const tj = acctIndexOf(target);
          if (tj !== i) offenders.push(`${self || "(ref-less)"} → ${target} (acct ${i} → ${tj})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the corpus key is stable per (seed, params) and re-keys when population changes", () => {
    expect(corpusKey(corpus().plan).cacheKey).toBe(corpusKey(corpus().plan).cacheKey);
    expect(corpusKey(corpus({ population: 401 }).plan).cacheKey).not.toBe(corpusKey(corpus().plan).cacheKey);
  });
});

describe("streaming materialize — byte-identical to eager (the 100K-without-OOM path)", () => {
  it("STREAM PARITY — scaffold + batched bulk == a full eager generate, byte-for-byte, every object", async () => {
    const scope = scopeOf({ population: 400 });
    const profile = standardProfile(salescloudPack);
    const plan = planBundle(scope, profile, salescloudPack, ASOF);

    // eager (whole bundle) → warehouse
    const eager = buildBundle(scope, profile, salescloudPack, ASOF);
    const whE = new WarehouseStore(":memory:");
    whE.writeBundle(manifestFor(plan, "ds_eager"), eager.records, ASOF);

    // streamed with a DELIBERATELY small batch → forces many batches + seq continuity across them
    const whS = new WarehouseStore(":memory:");
    const res = await streamMaterialize(plan, profile, salescloudPack, whS, manifestFor(plan, "ds_stream"), ASOF, { batch: 37 });
    expect(res.batches).toBeGreaterThan(1); // genuinely multi-batch

    // every object reconstructs identically (same records, same emit order) from both paths
    const objects = new Set([...Object.keys(eager.records), ...Object.keys(whS.counts("ds_stream"))]);
    for (const obj of objects) {
      expect(JSON.stringify(whS.readObject("ds_stream", obj)), `object ${obj} differs`).toBe(JSON.stringify(whE.readObject("ds_eager", obj)));
    }
    // and the totals match
    expect(res.totalRecords).toBe(Object.values(whE.counts("ds_eager")).reduce((a, b) => a + b, 0));
  });

  it("streaming is deterministic and batch-size-invariant (batch=37 == batch=400)", async () => {
    const scope = scopeOf({ population: 400 });
    const profile = standardProfile(salescloudPack);
    const plan = planBundle(scope, profile, salescloudPack, ASOF);
    const run = async (batch: number, ds: string) => {
      const wh = new WarehouseStore(":memory:");
      await streamMaterialize(plan, profile, salescloudPack, wh, manifestFor(plan, ds), ASOF, { batch });
      return JSON.stringify(wh.readObject(ds, "Account")) + JSON.stringify(wh.readObject(ds, "Opportunity"));
    };
    expect(await run(37, "ds_a")).toBe(await run(400, "ds_b")); // batch size never changes the bytes
  });
});

// v21: HERO COPY IN THE CORPUS — materialize fills foreground deal bodies so a warehouse→org load never ships
// its centerpiece deals blank. The fill is deterministic (static floor) and copyMode is part of the cache key.
describe("hero copy in the corpus — foreground bodies filled, deterministic, keyed by copyMode", () => {
  const fgOf = (b: { records: Record<string, GenericRecord[]> }, obj: string) => (b.records[obj] ?? []).filter((r) => !isBulk(r));
  const blankCount = (recs: GenericRecord[], field: string) => recs.filter((r) => !((r[field] as string | undefined) ?? "")).length;

  it("fillForegroundCopy(static) fills EVERY foreground EmailMessage/Task/ContentVersion body — no blank hero deals", async () => {
    const b = corpus({ population: 0 }); // foreground only
    expect(b.copyRequests.length).toBeGreaterThan(0);
    expect(blankCount(fgOf(b, "EmailMessage"), "TextBody")).toBeGreaterThan(0); // before: deferred → blank
    await fillForegroundCopy(b, "static", ASOF);
    const emails = fgOf(b, "EmailMessage"), tasks = fgOf(b, "Task"), cvs = fgOf(b, "ContentVersion");
    expect(emails.length).toBeGreaterThan(0);
    expect(blankCount(emails, "TextBody")).toBe(0); // every hero email has a body
    expect(blankCount(tasks, "Description")).toBe(0);
    expect(blankCount(cvs, "VersionData")).toBe(0); // transcripts non-empty (would otherwise be skipped on load)
  });

  it("the fill is DETERMINISTIC — same bundle + static → byte-identical bodies", async () => {
    const a = corpus({ population: 0 }), b = corpus({ population: 0 });
    await fillForegroundCopy(a, "static", ASOF);
    await fillForegroundCopy(b, "static", ASOF);
    expect(JSON.stringify(a.records.EmailMessage)).toBe(JSON.stringify(b.records.EmailMessage));
  });

  it("copyMode is part of the corpus identity — static / none / claude-code key to DIFFERENT datasets", () => {
    const plan = planBundle(scopeOf({ population: 0 }), standardProfile(salescloudPack), salescloudPack, ASOF);
    const key = (copyMode: string) => corpusKey({ ...plan, copyMode } as never).cacheKey;
    expect(key("static")).not.toBe(key("none"));
    expect(key("static")).not.toBe(key("claude-code"));
  });

  it("--copy none leaves foreground bodies deferred (blank) — the pure-structural escape hatch", async () => {
    const b = corpus({ population: 0 });
    await fillForegroundCopy(b, "none", ASOF);
    const emails = fgOf(b, "EmailMessage");
    expect(emails.length).toBeGreaterThan(0);
    expect(blankCount(emails, "TextBody")).toBe(emails.length); // untouched — all still blank
  });
});
