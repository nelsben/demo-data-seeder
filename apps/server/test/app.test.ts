import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CapabilityProfile } from "@dataseed/core";
import { buildApp } from "../src/app.js";

const ORG = "test-org";
const ASOF = "2026-06-17T00:00:00.000Z";

// A stub profile so routes never hit a live org.
const stubProfile = (org: string) =>
  CapabilityProfile.parse({
    org,
    capturedAt: ASOF,
    recordBudget: 100_000,
    namespacePrefix: null,
    copyProvider: "anthropic",
    dataCloud: { licensed: true, available: true, evidence: "stub", gateState: null, instrumentedLimits: false },
    objects: [{ apiName: "Account", present: true, blockedRequiredFields: [] }],
  });

const app = buildApp({ introspect: async (org) => stubProfile(org) });

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(join(process.cwd(), ".dataseed"), { recursive: true, force: true });
});

describe("GET /api/preflight", () => {
  it("reports the first-run environment check (sf / claude / anthropic-key) as booleans", async () => {
    const res = await app.inject({ method: "GET", url: "/api/preflight" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(typeof b.sf).toBe("boolean");
    expect(typeof b.claudeCode).toBe("boolean");
    expect(typeof b.anthropicKey).toBe("boolean");
  });
});

describe("GET /api/health + /api/packs", () => {
  it("reports healthy with the registered packs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("lists the salescloud pack with scenarios + variability dimensions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/packs" });
    expect(res.statusCode).toBe(200);
    const salescloud = res.json().packs.find((p: { id: string }) => p.id === "salescloud");
    expect(salescloud.scenarios).toContain("at-risk-budget");
    expect(salescloud.variabilityDimensions).toContain("dealSizeBand");
  });
});

describe("POST /api/profile → GET /api/profile/:org", () => {
  it("introspects (stub), persists, and returns the profile + pack requirements", async () => {
    const res = await app.inject({ method: "POST", url: "/api/profile", payload: { org: ORG, pack: "salescloud" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.org).toBe(ORG);
    // salescloud targets standard objects only → no blocking requirements
    expect(body.requirements.every((r: { severity: string }) => r.severity !== "blocking")).toBe(true);

    const get = await app.inject({ method: "GET", url: `/api/profile/${ORG}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().profile.org).toBe(ORG);
  });

  it("404s an unknown pack", async () => {
    const res = await app.inject({ method: "POST", url: "/api/profile", payload: { org: ORG, pack: "nope" } });
    expect(res.statusCode).toBe(404);
  });

  it("400s a missing org", async () => {
    const res = await app.inject({ method: "POST", url: "/api/profile", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/plan", () => {
  it("plans + generates a dry-run preview from the persisted profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { org: ORG, pack: "salescloud", volume: 6, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, seed: "demo", asOf: ASOF },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.volume).toBe(6);
    expect(body.preview.sampleDeals.length).toBeGreaterThan(0);
    expect(body.preview.copyRequests).toBeGreaterThan(0);
  });

  it("surfaces per-deal line-item economics that reconcile to Amount (Phase A)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { org: ORG, pack: "salescloud", volume: 3, scenarioMix: { "healthy-tech": 100 }, seed: "econ", asOf: ASOF },
    });
    const deal = res.json().preview.sampleDeals.find((d: { lineItems?: unknown[] }) => d.lineItems?.length);
    expect(deal).toBeTruthy();
    const sum = deal.lineItems.reduce((s: number, l: { quantity: number; unitPrice: number }) => s + l.quantity * l.unitPrice, 0);
    expect(sum).toBe(deal.amount); // the reconciliation guarantee, surfaced to the SE
    expect(deal.reconciled).toBe(true);
  });

  it("returns the full bundle when full=true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { org: ORG, pack: "salescloud", volume: 3, scenarioMix: { "healthy-tech": 100 }, full: true, asOf: ASOF },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bundle.records.Account).toHaveLength(3);
  });

  it("400s a scenario mix that doesn't sum to 100", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { org: ORG, pack: "salescloud", volume: 3, scenarioMix: { "healthy-tech": 50 }, asOf: ASOF },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s when the org has no profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { org: "never-profiled", pack: "salescloud", volume: 3, scenarioMix: { "healthy-tech": 100 } },
    });
    expect(res.statusCode).toBe(404);
  });
});
