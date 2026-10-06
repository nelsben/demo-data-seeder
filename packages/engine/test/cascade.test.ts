import { describe, it, expect } from "vitest";
import { NarrativeBundle, type TargetPack, type BundleRecords } from "@dataseed/core";
import type { Dataset } from "@dataseed/registry";
import { cascadeEstimate, excludeCascade, salesforceSink } from "../src/sinks/index.js";
import type { LoadTarget, InsertResult } from "../src/load/connection.js";

// Minimal pack: a 4-object load order, two of which fire the cascade.
const fakePack = {
  id: "fake",
  label: "Fake",
  description: "t",
  objects: ["Account", "Contact", "EmailMessage", "Task"],
  cascadeObjects: ["EmailMessage", "Task"],
  picklists: {},
  scenarios: [],
  recordSchemas: {},
  variability: {},
  recordsPerUnitEstimate: 1,
  checkRequirements: () => [],
  generate: () => ({ records: {} }),
} as unknown as TargetPack;

const records: BundleRecords = {
  Account: [{ _ref: "a0", Name: "Acme" }, { _ref: "a1", Name: "Globex" }],
  Contact: [{ _ref: "c0", _refs: { AccountId: "a0" }, LastName: "X" }],
  Opportunity: [{ _ref: "o0", _refs: { AccountId: "a0" }, Name: "D1" }, { _ref: "o1", _refs: { AccountId: "a1" }, Name: "D2" }],
  EmailMessage: Array.from({ length: 5 }, (_, i) => ({ _ref: `e${i}`, Subject: `s${i}` })),
  Task: Array.from({ length: 3 }, (_, i) => ({ _ref: `t${i}`, Subject: `t${i}` })),
};

describe("cascadeEstimate / excludeCascade", () => {
  it("estimates the pipeline blast radius from the cascade-firing inputs", () => {
    const est = cascadeEstimate(fakePack, records);
    expect(est.cascadeObjects.sort()).toEqual(["EmailMessage", "Task"]);
    expect(est.streamRecords).toBe(8); // 5 emails + 3 tasks
    expect(est.estLlmCalls).toBe(8 + 2); // extraction per stream record + ~1 synthesis per affected deal (2)
  });

  it("is zero for a pack with no cascade objects", () => {
    const est = cascadeEstimate({ ...fakePack, cascadeObjects: undefined } as TargetPack, records);
    expect(est.streamRecords).toBe(0);
    expect(est.estLlmCalls).toBe(0);
  });

  it("excludeCascade drops only the cascade objects (structural view)", () => {
    const out = excludeCascade(fakePack, records);
    expect(Object.keys(out).sort()).toEqual(["Account", "Contact", "Opportunity"]);
    expect(out.EmailMessage).toBeUndefined();
    expect(out.Task).toBeUndefined();
    expect(out.Account).toHaveLength(2);
  });
});

// Mock org that records what objects it was asked to insert.
class RecordingTarget implements LoadTarget {
  org = "mock";
  inserted: Record<string, number> = {};
  private id = 0;
  async exists() {
    return true;
  }
  async createableFields() {
    return new Set(["Name", "LastName", "Subject"]);
  }
  async insert(o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    this.inserted[o] = (this.inserted[o] ?? 0) + recs.length;
    return recs.map(() => ({ success: true, id: `${o.slice(0, 2)}-${this.id++}`, errors: [] }));
  }
  async existingValues() {
    return new Set<string>();
  }
  async queryIds() {
    return [];
  }
  async standardPricebookId() {
    return null;
  }
  async idsByField() {
    return new Map<string, string>();
  }
  async idsByCompositeKey() {
    return new Map<string, string>();
  }
  async convertLeads() {
    return [];
  }
  async deleteRecords() {
    return [];
  }
}

const datasetOf = (recs: BundleRecords): Dataset =>
  ({
    id: "ds_fake",
    pack: "fake",
    params: { org: "o", pack: "fake", volume: 1 },
    status: "filled",
    provenance: { engineVersion: "0", createdAt: "t", updatedAt: "t" },
    bundle: NarrativeBundle.parse({ records: recs, plan: { pack: "fake", mode: "inputs", withDc: false, seed: 0, asOf: "2026-01-01T00:00:00.000Z", requestedVolume: 1, volume: 1 } }),
  }) as unknown as Dataset;

describe("salesforce sink — cascade control", () => {
  it("cascade: 'off' loads structurally — the cascade objects are never inserted", async () => {
    const target = new RecordingTarget();
    const sink = salesforceSink({ resolvePack: () => fakePack, connect: async () => target });
    await sink.disperse(datasetOf(records), { target: "myorg", cascade: "off" });
    expect(target.inserted.Account).toBe(2);
    expect(target.inserted.EmailMessage).toBeUndefined(); // dropped
    expect(target.inserted.Task).toBeUndefined();
  });

  it("cascade: 'auto' (default) loads the cascade objects too", async () => {
    const target = new RecordingTarget();
    const sink = salesforceSink({ resolvePack: () => fakePack, connect: async () => target });
    await sink.disperse(datasetOf(records), { target: "myorg" });
    expect(target.inserted.EmailMessage).toBe(5);
    expect(target.inserted.Task).toBe(3);
  });
});
