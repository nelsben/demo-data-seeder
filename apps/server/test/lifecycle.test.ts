import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CapabilityProfile } from "@dataseed/core";
import type { LoadTarget, InsertResult } from "@dataseed/engine";
import { buildApp } from "../src/app.js";

const ORG = "test-lifecycle";
const ASOF = "2026-06-17T00:00:00.000Z";

const stubProfile = (org: string) =>
  CapabilityProfile.parse({
    org,
    capturedAt: ASOF,
    recordBudget: 100_000,
    namespacePrefix: null,
    copyProvider: "static",
    dataCloud: { licensed: false, available: false, evidence: "stub", gateState: null, instrumentedLimits: false },
    objects: [{ apiName: "Account", present: true, blockedRequiredFields: [] }],
  });

// An in-memory org: every object exists, every field is createable, inserts succeed.
// Tracks inserted Account names → Id so teardown's Name-scoped query only resolves names that
// were ACTUALLY inserted (a converted Lead's minted-Account name, which this mock's convertLeads()
// never actually creates, must NOT resolve — a positional/count-based fake would over-match).
class MockTarget implements LoadTarget {
  org = "mock";
  inserted: Record<string, number> = {};
  deletedTotal = 0;
  private seq = 0;
  private acctIdByName = new Map<string, string>();
  private allFields = { has: () => true } as unknown as Set<string>;

  async exists() {
    return true;
  }
  async createableFields() {
    return this.allFields;
  }
  async insert(obj: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    this.inserted[obj] = (this.inserted[obj] ?? 0) + recs.length;
    return recs.map((r) => {
      const id = `${obj.slice(0, 3)}-${this.seq++}`;
      if (obj === "Account" && typeof r.Name === "string") this.acctIdByName.set(r.Name, id);
      return { success: true, id, errors: [] };
    });
  }
  async existingValues() {
    return new Set<string>(); // nothing pre-exists → no idempotency skip
  }
  async queryIds(sobject: string, whereField: string, values: string[]): Promise<string[]> {
    // Accounts resolve by Name (only names actually inserted); children scoped by parent return none here.
    if (sobject === "Account" && whereField === "Name") return values.map((v) => this.acctIdByName.get(v)).filter((v): v is string => !!v);
    return [];
  }
  async standardPricebookId() {
    return "01s000000000001AAA"; // a present standard pricebook → the product chain loads
  }
  async idsByField() {
    return new Map<string, string>(); // empty org → catalog inserts fresh (no reuse)
  }
  async idsByCompositeKey() {
    return new Map<string, string>(); // empty org → adapter rules insert fresh
  }
  async convertLeads() {
    return [];
  }
  async deleteRecords(_sobject: string, ids: string[]): Promise<InsertResult[]> {
    this.deletedTotal += ids.length;
    return ids.map(() => ({ success: true, errors: [] }));
  }
}

const mock = new MockTarget();
const app = buildApp({
  introspect: async (org) => stubProfile(org),
  createLoadTarget: async () => mock,
  probeSynthesis: async (org, pack) => ({
    org,
    pack: pack.id,
    supported: true,
    inputs: [
      { object: "Account", label: "Accounts", present: true, count: 3 },
      { object: "Task", label: "Activity notes", present: true, count: 8 },
      { object: "OpportunityLineItem", label: "Line items", present: true, count: 12 },
    ],
    probes: [
      { object: "Signal_Event__c", label: "Signals", present: true, count: 27, sample: "Budget blocker" },
      { object: "Deal_Brief__c", label: "Strategy briefs", present: true, count: 1, sample: '{"Metrics":"Red"}' },
    ],
    total: 28,
  }),
});

beforeAll(async () => {
  await app.ready();
  // Profile + plan so a bundle exists for ORG.
  await app.inject({ method: "POST", url: "/api/profile", payload: { org: ORG, pack: "salescloud" } });
  await app.inject({
    method: "POST",
    url: "/api/plan",
    payload: { org: ORG, pack: "salescloud", volume: 4, scenarioMix: { "at-risk-budget": 50, "healthy-tech": 50 }, seed: "lifecycle", asOf: ASOF },
  });
});
afterAll(async () => {
  await app.close();
  rmSync(join(process.cwd(), ".dataseed"), { recursive: true, force: true });
});

describe("POST /api/fill-copy", () => {
  it("fills every email body (static) and returns samples", async () => {
    const res = await app.inject({ method: "POST", url: "/api/fill-copy", payload: { org: ORG, pack: "salescloud", provider: "static" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emails.total).toBeGreaterThan(0);
    expect(body.emails.withBody).toBe(body.emails.total); // no email ships blank
    expect(body.samples.length).toBeGreaterThan(0);
    expect(body.samples[0].body.length).toBeGreaterThan(20);
    expect(body.estCostUsd).toBe(0); // static is free
    // Phase A: the 2nd signal stream (Task notes) is filled + reported too, not just emails.
    expect(body.tasks.total).toBeGreaterThan(0);
    expect(body.tasks.withBody).toBe(body.tasks.total);
    expect(body.taskSamples.length).toBeGreaterThan(0);
    expect(body.taskSamples[0].body.length).toBeGreaterThan(20);
  });

  it("404s when the org has no bundle", async () => {
    const res = await app.inject({ method: "POST", url: "/api/fill-copy", payload: { org: "no-bundle", pack: "salescloud" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/load", () => {
  it("loads the bundle through the (mock) org and reports per-object inserts", async () => {
    const res = await app.inject({ method: "POST", url: "/api/load", payload: { org: ORG, pack: "salescloud" } });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.totalInserted).toBeGreaterThan(0);
    const acct = report.objects.find((o: { object: string }) => o.object === "Account");
    expect(acct.inserted).toBe(4);
    expect(mock.inserted.Account).toBe(4);
  });

  it("404s an unknown pack", async () => {
    const res = await app.inject({ method: "POST", url: "/api/load", payload: { org: ORG, pack: "nope" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/teardown", () => {
  it("dry-runs by default — matches accounts, deletes nothing", async () => {
    const before = mock.deletedTotal;
    const res = await app.inject({ method: "POST", url: "/api/teardown", payload: { org: ORG, pack: "salescloud" } });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.dryRun).toBe(true);
    expect(report.accountsMatched).toBe(4);
    expect(mock.deletedTotal).toBe(before); // nothing deleted on a dry-run
  });

  it("deletes when yes=true", async () => {
    const res = await app.inject({ method: "POST", url: "/api/teardown", payload: { org: ORG, pack: "salescloud", yes: true } });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.dryRun).toBe(false);
    expect(report.totalDeleted).toBeGreaterThan(0); // at least the 4 accounts
  });
});

describe("POST /api/synthesis", () => {
  it("returns the pipeline's derived-record summary", async () => {
    const res = await app.inject({ method: "POST", url: "/api/synthesis", payload: { org: ORG, pack: "salescloud" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supported).toBe(true);
    expect(body.total).toBe(28);
    expect(body.probes.find((p: { label: string }) => p.label === "Signals").count).toBe(27);
  });

  it("404s an unknown pack", async () => {
    const res = await app.inject({ method: "POST", url: "/api/synthesis", payload: { org: ORG, pack: "nope" } });
    expect(res.statusCode).toBe(404);
  });
});
