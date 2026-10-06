import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, existingRef, type GenericRecord, type BundleRecords } from "@dataseed/core";
import { buildBundle, planBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";
import { SALESCLOUD_LOAD_ORDER, SALESCLOUD_RECORD_SCHEMAS } from "../src/schemas.js";

const ASOF = "2026-06-17T00:00:00.000Z";
// objects:[] makes resolveUserPoolSize fail-open (User assumed present); pass an explicit object list to gate.
const profile = (over: Record<string, unknown> = {}) => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF, ...over });
const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 2, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
const buildWith = (scopeOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) =>
  buildBundle(scope(scopeOver), profile(profileOver), salescloudPack, ASOF);

const isBulk = (r: GenericRecord) => (r._meta as { tier?: string } | undefined)?.tier === "bulk";
const softOwner = (r: GenericRecord) => (r._softRefs as Record<string, string> | undefined)?.OwnerId;

/** Strip everything the pool adds — pool records + every bulk record's OwnerId soft-ref — so what's left
 *  is the pre-pool bundle. If the pool is purely additive, this equals a userPoolSize:0 bundle byte-for-byte. */
function stripPool(records: BundleRecords): BundleRecords {
  const out: BundleRecords = {};
  for (const [obj, recs] of Object.entries(records)) {
    if (obj === "User" || obj === "UserRole") continue; // pool records — gone entirely
    out[obj] = (recs ?? []).map((r) => {
      const soft = r._softRefs as Record<string, string> | undefined;
      if (!soft || !("OwnerId" in soft)) return r;
      const { OwnerId, ...restSoft } = soft;
      const clone = { ...r };
      if (Object.keys(restSoft).length) clone._softRefs = restSoft;
      else delete clone._softRefs;
      return clone;
    });
  }
  return out;
}

describe("Phase 4F — sales-rep User pool + OwnerId distribution", () => {
  it("defaults to OFF — no pool, no OwnerId on any bulk record (backward-compatible)", () => {
    const b = buildWith({ volume: 2, population: 200 });
    expect(b.plan.userPoolSize).toBe(0);
    expect(b.records.User!).toHaveLength(0);
    expect(b.records.UserRole!).toHaveLength(0);
    expect(b.records.Account!.filter(isBulk).every((a) => softOwner(a) === undefined)).toBe(true);
  });

  it("is PURELY ADDITIVE — adding the pool does not perturb any existing bulk stream (the load-bearing guard)", () => {
    const without = buildWith({ volume: 2, population: 300, seed: "add", userPoolSize: 0 });
    const withPool = buildWith({ volume: 2, population: 300, seed: "add", userPoolSize: 20 });
    expect(JSON.stringify(stripPool(withPool.records))).toBe(JSON.stringify(stripPool(without.records)));
  });

  it("seats a deterministic, byte-identical pool per seed", () => {
    const a = buildWith({ volume: 1, population: 100, seed: "pool", userPoolSize: 12 });
    const b = buildWith({ volume: 1, population: 100, seed: "pool", userPoolSize: 12 });
    expect(a.records.User!.length).toBe(12);
    expect(a.records.UserRole!.length).toBe(3); // flat: one role per region
    expect(JSON.stringify(a.records.User)).toBe(JSON.stringify(b.records.User));
    expect(JSON.stringify(a.records.UserRole)).toBe(JSON.stringify(b.records.UserRole));
  });

  it("distributes OwnerId round-robin as a SOFT ref, index-derived, coherent across a book of business", () => {
    const b = buildWith({ volume: 1, population: 15, seed: "rr", userPoolSize: 5 });
    const ownerByAcct = new Map<string, string>();
    for (const a of b.records.Account!.filter(isBulk)) {
      const i = Number((a._ref as string).replace("bulk-acct-", ""));
      const owner = softOwner(a);
      expect(owner).toBe(`user-${i % 5}`); // round-robin by account index
      expect((a._refs as Record<string, string> | undefined)?.OwnerId).toBeUndefined(); // SOFT, never hard
      ownerByAcct.set(a._ref as string, owner!);
    }
    // every opp/task/event inherits its account's owner (same rep owns the whole book)
    for (const o of b.records.Opportunity!.filter(isBulk)) {
      const acct = String((o._refs as Record<string, string>).AccountId);
      expect(softOwner(o)).toBe(ownerByAcct.get(acct));
    }
    for (const obj of ["Task", "Event"] as const) {
      for (const r of b.records[obj]!.filter(isBulk)) expect(softOwner(r)).toMatch(/^user-\d+$/);
    }
  });

  it("leaves the FOREGROUND hero deals owned by the running user (no OwnerId), even with a pool", () => {
    const b = buildWith({ volume: 3, population: 50, userPoolSize: 8 });
    for (const obj of ["Account", "Opportunity"] as const) {
      for (const r of b.records[obj]!.filter((x) => !isBulk(x))) {
        expect(softOwner(r)).toBeUndefined();
        expect((r._refs as Record<string, string> | undefined)?.OwnerId).toBeUndefined();
      }
    }
  });

  it("generates globally-unique, non-routable usernames + short aliases; different seeds are disjoint", () => {
    const b = buildWith({ volume: 1, population: 10, seed: "u1", userPoolSize: 20 });
    const names = b.records.User!.map((u) => u.Username as string);
    expect(new Set(names).size).toBe(20); // unique within pool
    for (const u of b.records.User!) {
      expect(u.Username as string).toMatch(/@dataseed-[a-z0-9]+\.example$/);
      expect((u.Alias as string).length).toBeLessThanOrEqual(8);
      expect(u.IsActive).toBe(true);
    }
    const other = buildWith({ volume: 1, population: 10, seed: "u2", userPoolSize: 20 });
    const overlap = names.filter((n) => other.records.User!.some((u) => u.Username === n));
    expect(overlap).toHaveLength(0); // different seed → disjoint namespace
  });

  it("points ProfileId at a HARD @existing Profile ref and UserRoleId at an emitted role (soft)", () => {
    const b = buildWith({ volume: 1, population: 10, userPoolSize: 6, userProfileName: "Standard Platform User" });
    const roleRefs = new Set(b.records.UserRole!.map((r) => r._ref));
    for (const u of b.records.User!) {
      expect((u._refs as Record<string, string>).ProfileId).toBe(existingRef("Profile", "Name", "Standard Platform User"));
      expect(roleRefs.has((u._softRefs as Record<string, string>).UserRoleId)).toBe(true);
    }
  });

  it("registers User/UserRole in load order + schemas + catalog, correctly ordered", () => {
    const lo = SALESCLOUD_LOAD_ORDER as readonly string[];
    expect(lo.indexOf("UserRole")).toBeLessThan(lo.indexOf("User"));
    expect(lo.indexOf("User")).toBeLessThan(lo.indexOf("Account"));
    expect(Object.keys(SALESCLOUD_RECORD_SCHEMAS)).toEqual(expect.arrayContaining(["User", "UserRole"]));
    const cat = salescloudPack.catalog!.map((c) => c.object);
    expect(cat.indexOf("UserRole")).toBeLessThan(cat.indexOf("User")); // dedup ordering: role before user
    expect(salescloudPack.catalog!.find((c) => c.object === "User")?.keyField).toBe("Username");
  });

  it("plan resolver: gated on User presence, clamped, flat estimate term", () => {
    // org WITHOUT the User object → pool suppressed even when requested
    const gated = buildWith({ volume: 1, population: 50, userPoolSize: 30 }, { objects: [{ apiName: "Account", present: true }] });
    expect(gated.plan.userPoolSize).toBe(0);
    expect(gated.records.User!).toHaveLength(0);
    // requested over the cap → clamped to 50
    const clamped = buildWith({ volume: 1, population: 50, userPoolSize: 999 }, { objects: [{ apiName: "User", present: true }] });
    expect(clamped.plan.userPoolSize).toBe(50);
    // plan-TIME estimate (pre-generation, for budget display) adds a FLAT +userPoolSize term…
    const planBase = planBundle(scope({ volume: 1, population: 100, seed: "e", userPoolSize: 0 }), profile(), salescloudPack, ASOF);
    const planPool = planBundle(scope({ volume: 1, population: 100, seed: "e", userPoolSize: 20 }), profile(), salescloudPack, ASOF);
    expect(planPool.estimatedRecords - planBase.estimatedRecords).toBe(20);
    // …and the realized count grows only by the actual pool records (users + flat roles), independent of population.
    const built = buildWith({ volume: 1, population: 100, seed: "e", userPoolSize: 20 });
    const poolRecords = built.records.User!.length + built.records.UserRole!.length;
    const base = buildWith({ volume: 1, population: 100, seed: "e", userPoolSize: 0 });
    expect(built.plan.estimatedRecords - base.plan.estimatedRecords).toBe(poolRecords);
    const built2 = buildWith({ volume: 1, population: 260, seed: "e", userPoolSize: 20 });
    const base2 = buildWith({ volume: 1, population: 260, seed: "e", userPoolSize: 0 });
    expect(built2.plan.estimatedRecords - base2.plan.estimatedRecords).toBe(poolRecords); // flat — same delta at higher population
  });
});
