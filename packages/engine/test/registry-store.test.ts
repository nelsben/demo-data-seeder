import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericRecord, NarrativeBundle, ScopeParams, type TargetPack, type BundleRecords } from "@dataseed/core";
import {
  SqliteRegistryStore,
  savePlanned,
  saveFilled,
  latestDatasetFor,
  salesforceSink,
  fileSink,
  returnSink,
  disperseDataset,
  type Dataset,
  type Sink,
  type LoadTarget,
  type InsertResult,
} from "@dataseed/engine";

const NOW = "2026-06-18T12:00:00.000Z";
const LATER = "2026-06-19T09:00:00.000Z";

const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 4, scenarioMix: { "healthy-tech": 100 }, ...over });

const bundle = (records: BundleRecords = { Account: [{ _ref: "a0", Name: "Stripe" }, { _ref: "a1", Name: "Okta" }] }) =>
  NarrativeBundle.parse({
    records,
    plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 42, asOf: NOW, requestedVolume: 4, volume: 4 },
  });

const mem = () => new SqliteRegistryStore(":memory:");

// ── A minimal mock LoadTarget (no org) for the salesforce sink test ──────────
class MockLoadTarget implements LoadTarget {
  org = "mock";
  inserted: Record<string, Array<Record<string, unknown>>> = {};
  private id = 0;
  constructor(private fields: Record<string, Set<string>>) {}
  async exists(o: string) {
    return o in this.fields;
  }
  async createableFields(o: string) {
    return this.fields[o] ?? new Set<string>();
  }
  async insert(o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    this.inserted[o] = (this.inserted[o] ?? []).concat(recs);
    return recs.map(() => ({ success: true, id: `${o.slice(0, 3)}-${this.id++}`, errors: [] }));
  }
  async existingValues() {
    return new Set<string>();
  }
  async queryIds() {
    return [] as string[];
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
  async deleteRecords(_o: string, ids: string[]) {
    return ids.map(() => ({ success: true, errors: [] as string[] }));
  }
}

const fakePack: TargetPack = {
  id: "fake",
  label: "Fake",
  description: "test",
  objects: ["Account"],
  picklists: {},
  scenarios: ["s"],
  recordSchemas: { Account: GenericRecord },
  variability: {},
  recordsPerUnitEstimate: 1,
  checkRequirements: () => [],
  generate: () => ({ records: {} }),
};

describe("bundle-store — registry-backed (org,pack) ergonomics", () => {
  it("savePlanned registers a content-addressed dataset; re-plan updates the same row + preserves createdAt", () => {
    const store = mem();
    const a = savePlanned(store, { pack: "salescloud", params: scope(), bundle: bundle(), now: NOW });
    expect(a.id).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(a.status).toBe("planned");
    expect(a.provenance.recordCounts).toEqual({ Account: 2 });
    // Re-plan the same params later → same id, one row, createdAt preserved, updatedAt bumped.
    const b = savePlanned(store, { pack: "salescloud", params: scope(), bundle: bundle(), now: LATER });
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect(b.provenance.createdAt).toBe(NOW);
    expect(b.provenance.updatedAt).toBe(LATER);
    store.close();
  });

  it("saveFilled flips planned→filled, swaps the bundle, stamps copy provenance, preserves identity", () => {
    const store = mem();
    const planned = savePlanned(store, { pack: "salescloud", params: scope(), bundle: bundle(), now: NOW });
    const filledBundle = bundle({ Account: [{ _ref: "a0", Name: "Stripe" }], EmailMessage: [{ _ref: "e0", TextBody: "hi" }] });
    const filled = saveFilled(store, planned, { bundle: filledBundle, now: LATER, provider: "claude-code", costUsd: 0.42 });
    expect(filled.id).toBe(planned.id);
    expect(filled.status).toBe("filled");
    expect(filled.provenance.createdAt).toBe(NOW); // preserved
    expect(filled.provenance.filledAt).toBe(LATER);
    expect(filled.provenance.llmProvider).toBe("claude-code");
    expect(filled.provenance.llmCostUsd).toBe(0.42);
    expect(filled.provenance.recordCounts).toEqual({ Account: 1, EmailMessage: 1 });
    expect(store.get(planned.id)!.status).toBe("filled");
    store.close();
  });

  it("latestDatasetFor returns the newest dataset for (org, pack); null for an unknown org", () => {
    const store = mem();
    const a = savePlanned(store, { pack: "salescloud", params: scope({ seed: 1 }), bundle: bundle(), now: NOW });
    const b = savePlanned(store, { pack: "salescloud", params: scope({ seed: 2 }), bundle: bundle(), now: LATER });
    expect(a.id).not.toBe(b.id); // seed is part of identity
    expect(latestDatasetFor(store, "demo-org", "salescloud")?.id).toBe(b.id); // newest first
    expect(latestDatasetFor(store, "other-org", "salescloud")).toBeNull();
    store.close();
  });
});

describe("sinks — generate once, disperse many", () => {
  const dataset = (): Dataset => ({
    id: "ds_test12345678",
    pack: "fake",
    params: scope(),
    status: "planned",
    provenance: { engineVersion: "t", createdAt: NOW, updatedAt: NOW, recordCounts: { Account: 2 } },
    bundle: bundle(),
  });

  it("fileSink writes the bundle JSON to the target path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sink-"));
    const path = join(dir, "out.json");
    const report = await fileSink().disperse(dataset(), { target: path });
    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).records.Account).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returnSink hands the bundle back to the caller (no side effect)", async () => {
    const report = await returnSink().disperse(dataset(), {});
    expect(report.sink).toBe("return");
    expect(report.detail).toEqual(dataset().bundle);
    expect(report.inserted).toBe(2);
  });

  it("disperseDataset records the dispersal in the dataset's load-history (lightweight)", async () => {
    const store = mem();
    const d = savePlanned(store, { pack: "salescloud", params: scope(), bundle: bundle(), now: NOW });
    const fakeSink: Sink = {
      id: "fake",
      label: "fake",
      async disperse() {
        return { sink: "fake", target: "X", ok: true, inserted: 7, failed: 0, skipped: 1, summary: "did it", detail: { huge: "ignored" } };
      },
    };
    const report = await disperseDataset(store, d, fakeSink, { now: LATER });
    expect(report.inserted).toBe(7);
    const loads = store.loadsFor(d.id);
    expect(loads).toHaveLength(1);
    expect(loads[0]!.sink).toBe("fake");
    expect(loads[0]!.target).toBe("X");
    expect(loads[0]!.inserted).toBe(7);
    expect((loads[0]!.report as { summary: string }).summary).toBe("did it"); // summary kept, heavy detail dropped
    store.close();
  });

  it("salesforceSink loads through a LoadTarget + maps the LoadReport", async () => {
    const target = new MockLoadTarget({ Account: new Set(["Name"]) });
    const sink = salesforceSink({ resolvePack: () => fakePack, connect: async () => target });
    const report = await sink.disperse(dataset(), { target: "demo-org" });
    expect(report.sink).toBe("salesforce");
    expect(report.target).toBe("demo-org");
    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(2); // both Accounts insert
    expect(target.inserted.Account).toHaveLength(2);
  });
});
