import { describe, it, expect } from "vitest";
import { AccountIdentity, type BundlePlan, type IdentityProvider, type IdentityRequest } from "@dataseed/core";
import { authorIdentities, StaticIdentityProvider, staticIdentity, memoryIdentityCache, parseIdentity, validateIdentity, isLikelySelfProduct } from "../src/identity/index.js";

const FIXTURE: AccountIdentity = {
  name: "Northwind Carriers",
  sfIndustry: "Transportation",
  domain: "northwindcarriers.com",
  sector: "Regional Freight",
  employees: 1800,
  revenueUsd: 360_000_000,
  hq: "Denver, United States",
  description: "Northwind Carriers is a regional freight and distribution company serving the Mountain West.",
  does: "regional freight and distribution",
  products: ["LTL freight", "warehousing"],
  buyingDept: "Operations & Finance",
  painPhrase: "reconciling dispatch, billing, and fuel-cost reporting across terminals",
};

/** A one-unit plan (authorIdentities only reads plan.seed + plan.units). */
const plan = (): BundlePlan =>
  ({ seed: 42, units: [{ index: 0, scenario: "healthy-tech", seed: 123, traits: { dealSizeBand: "50K_100K", region: "NA" } }] } as unknown as BundlePlan);

class MockIdentity implements IdentityProvider {
  id = "claude-code";
  calls = 0;
  constructor(private fn: (r: IdentityRequest) => AccountIdentity | null = () => FIXTURE) {}
  available() {
    return true;
  }
  async author(reqs: IdentityRequest[]) {
    this.calls++;
    const identities = reqs.map((r) => ({ unitKey: r.unitKey, index: r.index, identity: this.fn(r) })).filter((x): x is { unitKey: string; index: number; identity: AccountIdentity } => !!x.identity);
    return { identities, estCostUsd: 0.01 * reqs.length, budgetExhausted: false };
  }
}

describe("guard — parseIdentity + self-product", () => {
  it("parses a fenced/prefixed JSON identity", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify(FIXTURE) + "\n```";
    expect(parseIdentity(text)?.name).toBe("Northwind Carriers");
  });

  it("returns null on garbage", () => {
    expect(parseIdentity("no json here")).toBeNull();
  });

  it("drops a self-product draft (a BI/analytics/data vendor — would sell them their own product)", () => {
    const selfProduct = { ...FIXTURE, does: "a business intelligence and analytics platform", products: ["BI dashboards", "data warehouse"] };
    expect(isLikelySelfProduct(selfProduct)).toBe(true);
    expect(validateIdentity(selfProduct)).toBeNull();
    expect(validateIdentity(FIXTURE)).not.toBeNull(); // the clean one survives
  });
});

describe("staticIdentity — the deterministic floor", () => {
  const req: IdentityRequest = { unitKey: "42:0", index: 0, hints: { dealSizeBand: "50K_100K", region: "NA", nonce: "abc" } };

  it("is deterministic for the same request (byte-stable, no LLM)", () => {
    expect(staticIdentity(req)).toEqual(staticIdentity(req));
  });

  it("produces a valid, non-self-product identity", () => {
    const id = staticIdentity(req);
    expect(AccountIdentity.safeParse(id).success).toBe(true);
    expect(isLikelySelfProduct(id)).toBe(false);
  });

  it("honors an industry hint", () => {
    const id = staticIdentity({ ...req, hints: { ...req.hints, industry: "Healthcare" } });
    expect(id.sfIndustry).toBe("Healthcare");
  });
});

describe("authorIdentities — orchestration", () => {
  it("authors via the primary provider and resolves a Map<index, identity>", async () => {
    const mock = new MockIdentity();
    const { identities, report } = await authorIdentities(plan(), [mock, new StaticIdentityProvider()], { requestedProvider: "claude-code", asOf: "2026-01-01T00:00:00.000Z" });
    expect(report.authored).toBe(1);
    expect(identities.get(0)?.name).toBe("Northwind Carriers");
  });

  it("caches by (seed, index): a second run reuses the identity, no re-author", async () => {
    const cache = memoryIdentityCache();
    const mock = new MockIdentity();
    const r1 = await authorIdentities(plan(), [mock, new StaticIdentityProvider()], { requestedProvider: "claude-code", asOf: "2026-01-01T00:00:00.000Z", cache });
    expect(r1.report.authored).toBe(1);
    expect(mock.calls).toBe(1);
    const r2 = await authorIdentities(plan(), [mock, new StaticIdentityProvider()], { requestedProvider: "claude-code", asOf: "2026-01-01T00:00:00.000Z", cache });
    expect(r2.report.cached).toBe(1);
    expect(r2.report.authored).toBe(0);
    expect(mock.calls).toBe(1); // the cache served it
  });

  it("static-fills a unit the model skips (no hole left, not cached)", async () => {
    const cache = memoryIdentityCache();
    const skip = new MockIdentity(() => null); // authors nothing
    const { identities, report } = await authorIdentities(plan(), [skip, new StaticIdentityProvider()], { requestedProvider: "claude-code", asOf: "2026-01-01T00:00:00.000Z", cache });
    expect(report.authored).toBe(0);
    expect(report.staticFilled).toBe(1);
    expect(identities.get(0)).toBeDefined(); // the static floor filled it
    // a static fallback is NOT cached → the next run with an LLM available authors fresh, not a static stand-in
    const r2 = await authorIdentities(plan(), [new MockIdentity(), new StaticIdentityProvider()], { requestedProvider: "claude-code", asOf: "2026-01-01T00:00:00.000Z", cache });
    expect(r2.report.authored).toBe(1);
  });

  it("--provider static synthesizes deterministically with no model call", async () => {
    const mock = new MockIdentity();
    const { identities, report } = await authorIdentities(plan(), [mock, new StaticIdentityProvider()], { requestedProvider: "static", asOf: "2026-01-01T00:00:00.000Z" });
    expect(mock.calls).toBe(0);
    expect(report.provider).toBe("static");
    expect(identities.get(0)).toBeDefined();
  });

  it("--provider static ignores a STALE LLM-authored cache entry from a prior run (never ships a wrong identity)", async () => {
    const cache = memoryIdentityCache();
    cache.set("42:0", FIXTURE); // simulates a prior --provider claude-code/anthropic run's cache entry
    const mock = new MockIdentity();
    const { identities, report } = await authorIdentities(plan(), [mock, new StaticIdentityProvider()], {
      requestedProvider: "static",
      asOf: "2026-01-01T00:00:00.000Z",
      cache,
    });
    expect(mock.calls).toBe(0); // never touches the LLM
    expect(report.provider).toBe("static");
    expect(report.cached).toBe(0); // the cache was skipped, not consulted
    expect(identities.get(0)?.name).not.toBe(FIXTURE.name); // NOT the stale cached identity
  });
});
