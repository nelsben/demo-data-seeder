import { describe, it, expect } from "vitest";
import { CapabilityProfile, PackRegistry, standardProfile } from "@dataseed/core";
import { makeDatasetService, SqliteRegistryStore } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";

// estimate_dataset is the DRY-RUN sizing surface arbitrary agents call to "calculate" a run before committing.
// It must: resolve any size unit (incl. storage %) against the org, project records/storage/per-object, and
// write NOTHING.

const NOW = "2026-06-22T12:00:00.000Z";
const profileWithStorage = (maxMB: number, remainingMB: number) =>
  CapabilityProfile.parse({
    ...standardProfile(salescloudPack, { org: "test" }),
    recordBudget: 50_000_000, // high → no budget clamp interferes with the storage math
    limits: { dataStorageMB: { max: maxMB, remaining: remainingMB } },
  });

const svc = (profile: CapabilityProfile) =>
  makeDatasetService({
    packs: new PackRegistry().register(salescloudPack),
    store: new SqliteRegistryStore(":memory:"),
    now: () => NOW,
    loadProfile: () => profile,
  });

describe("estimate_dataset — dry-run sizing for arbitrary callers", () => {
  it("sizes by leaveFreePct against the org's storage and projects where the run lands", async () => {
    const s = svc(profileWithStorage(1000, 1000)); // fresh 1 GB org
    const est = await s.estimate({ org: "test", pack: "salescloud", volume: 3, leaveFreePct: 80 });

    expect(est.resolved.unit).toBe("leaveFreePct");
    expect(est.resolved.population).toBeGreaterThan(0);
    expect(est.estimatedRecords).toBeGreaterThan(0);
    expect(est.orgStorage).toBeDefined();
    expect(est.orgStorage!.maxMB).toBe(1000);
    // "leave 80% free" → it should project landing around 20% used (tolerance for rounding/estimate).
    expect(est.orgStorage!.projectedUsedPct).toBeGreaterThan(12);
    expect(est.orgStorage!.projectedUsedPct).toBeLessThan(28);
    expect(est.orgStorage!.freePctAfter).toBeGreaterThan(72);
  });

  it("returns per-object counts in the same ballpark as the total (sample-extrapolated)", async () => {
    const s = svc(profileWithStorage(1000, 1000));
    const est = await s.estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.resolved.population).toBe(4996); // 5000 − volume 4
    expect(est.perObjectCounts.Account).toBeGreaterThan(4000); // ≈ volume + population
    const sum = Object.values(est.perObjectCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(est.estimatedRecords * 0.6);
    expect(sum).toBeLessThan(est.estimatedRecords * 1.5);
  });

  it("WRITES NOTHING — the registry stays empty after an estimate", async () => {
    const s = svc(profileWithStorage(1000, 1000));
    await s.estimate({ org: "test", pack: "salescloud", volume: 5, accounts: 2000 });
    expect(s.list({})).toHaveLength(0);
  });

  it("storage units degrade with a caveat when the profile has no storage facts", async () => {
    const synthetic = standardProfile(salescloudPack, { org: "synthetic" }); // no limits.dataStorageMB
    const est = await svc(synthetic).estimate({ org: "synthetic", pack: "salescloud", volume: 3, storagePct: 50 });
    expect(est.resolved.population).toBe(0);
    expect(est.orgStorage).toBeUndefined();
    expect(est.caveats.join(" ")).toMatch(/no data-storage profile/i);
  });

  it("is deterministic — same request → same resolved population", async () => {
    const s = svc(profileWithStorage(2000, 1500));
    const a = await s.estimate({ org: "test", pack: "salescloud", volume: 3, storagePct: 25 });
    const b = await s.estimate({ org: "test", pack: "salescloud", volume: 3, storagePct: 25 });
    expect(a.resolved.population).toBe(b.resolved.population);
    expect(a.estimatedRecords).toBe(b.estimatedRecords);
  });
});

// apiCost — the Salesforce API-call cost estimate (rest calls / bulk batches), so a scratch org's tight
// daily budget can be checked BEFORE loading rather than discovered mid-load as REQUEST_LIMIT_EXCEEDED.
describe("estimate_dataset — apiCost (Salesforce API-call budget preview)", () => {
  it("reports restApiCalls/bulkApiBatches with no org-limit data when the profile has none", async () => {
    const s = svc(profileWithStorage(1000, 1000)); // no limits.dailyApiRequests/dailyBulkApiBatches
    const est = await s.estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.apiCost.bulkThreshold).toBe(5000); // the loader's own default
    expect(est.apiCost.restApiCalls).toBeGreaterThan(0);
    expect(est.apiCost.org).toBeUndefined(); // no daily-limit facts to cross-check against
  });

  it("lowering bulkThreshold shifts cost from restApiCalls onto bulkApiBatches", async () => {
    const s = svc(profileWithStorage(1000, 1000));
    const normal = await s.estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    const lowered = await s.estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000, bulkThreshold: 200 });
    expect(lowered.apiCost.bulkThreshold).toBe(200);
    expect(lowered.apiCost.bulkApiBatches).toBeGreaterThan(normal.apiCost.bulkApiBatches);
    expect(lowered.apiCost.restApiCalls).toBeLessThan(normal.apiCost.restApiCalls);
  });

  it("flags wouldExceedDailyApi + adds a caveat when the estimate exceeds the org's remaining daily REST budget", async () => {
    const tight = CapabilityProfile.parse({
      ...standardProfile(salescloudPack, { org: "test" }),
      recordBudget: 50_000_000,
      limits: { dataStorageMB: { max: 1000, remaining: 1000 }, dailyApiRequests: { max: 15_000, remaining: 5 } }, // a scratch org that's nearly out for the day
    });
    const est = await svc(tight).estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.apiCost.org).toBeDefined();
    expect(est.apiCost.org!.dailyApiRemaining).toBe(5);
    expect(est.apiCost.org!.wouldExceedDailyApi).toBe(true);
    expect(est.caveats.join(" ")).toMatch(/exceeds the org's remaining daily budget/);
  });

  it("does NOT flag wouldExceedDailyApi when the org has ample remaining budget", async () => {
    const roomy = CapabilityProfile.parse({
      ...standardProfile(salescloudPack, { org: "test" }),
      recordBudget: 50_000_000,
      limits: { dataStorageMB: { max: 1000, remaining: 1000 }, dailyApiRequests: { max: 15_000, remaining: 15_000 } },
    });
    const est = await svc(roomy).estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.apiCost.org!.wouldExceedDailyApi).toBe(false);
    expect(est.caveats.join(" ")).not.toMatch(/exceeds the org's remaining daily budget/);
  });

  it("uses null (not -1) for a daily limit that wasn't captured, so 'unknown' is never mistaken for a real number", async () => {
    const apiOnly = CapabilityProfile.parse({
      ...standardProfile(salescloudPack, { org: "test" }),
      recordBudget: 50_000_000,
      limits: { dataStorageMB: { max: 1000, remaining: 1000 }, dailyApiRequests: { max: 15_000, remaining: 15_000 } }, // dailyBulkApiBatches NOT captured
    });
    const est = await svc(apiOnly).estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.apiCost.org!.dailyApiRemaining).toBe(15_000);
    expect(est.apiCost.org!.dailyBulkBatchesRemaining).toBeNull();
    expect(est.apiCost.org!.wouldExceedDailyBulk).toBe(false); // absent limit never falsely trips
  });

  it("flags a stale daily-limit snapshot with a caveat (the org's real counters move continuously)", async () => {
    // standardProfile's synthetic capturedAt (2020) is years before the injected clock (NOW, 2026) — a
    // deliberately extreme staleness case, cheap to assert without wiring a custom capturedAt.
    const stale = CapabilityProfile.parse({
      ...standardProfile(salescloudPack, { org: "test" }),
      recordBudget: 50_000_000,
      limits: { dataStorageMB: { max: 1000, remaining: 1000 }, dailyApiRequests: { max: 15_000, remaining: 15_000 } },
    });
    const est = await svc(stale).estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000 });
    expect(est.apiCost.org!.profileAgeMs).toBeGreaterThan(60 * 60 * 1000);
    expect(est.caveats.join(" ")).toMatch(/daily-limit snapshot is .* minutes old/);
  });

  it("flags uncertainObjects when a per-object estimate lands close to bulkThreshold (REST-vs-Bulk classification may flip)", async () => {
    const s = svc(profileWithStorage(1000, 1000));
    // accounts=4996 (population, after subtracting volume) sits within 20% of the default 5000 threshold —
    // the Account object's own estimated count should be flagged as uncertain.
    const est = await s.estimate({ org: "test", pack: "salescloud", volume: 4, accounts: 5000, bulkThreshold: 5000 });
    expect(est.apiCost.uncertainObjects).toContain("Account");
    expect(est.caveats.join(" ")).toMatch(/close enough to bulkThreshold/);
  });

  it("uncertainObjects is empty when nothing is close to the threshold", async () => {
    const s = svc(profileWithStorage(1000, 1000));
    const est = await s.estimate({ org: "test", pack: "salescloud", volume: 2, accounts: 10 }); // tiny — nowhere near 5000
    expect(est.apiCost.uncertainObjects).toEqual([]);
  });
});
