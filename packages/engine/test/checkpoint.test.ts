import { describe, it, expect } from "vitest";
import { NarrativeBundle, type TargetPack } from "@dataseed/core";
import { loadBundle } from "../src/load/loader.js";
import { memoryCheckpoint } from "../src/load/checkpoint.js";
import type { LoadTarget, InsertResult } from "../src/load/connection.js";

const pack = { id: "fake", objects: ["Account", "Contact"] } as unknown as TargetPack;

// Account a0 → one Contact c0 hanging off it.
const bundle = () =>
  NarrativeBundle.parse({
    records: {
      Account: [{ _ref: "a0", Name: "X" }],
      Contact: [{ _ref: "c0", _refs: { AccountId: "a0" }, LastName: "Y" }],
    },
    plan: { pack: "fake", mode: "inputs", withDc: false, seed: 0, asOf: "2026-01-01T00:00:00.000Z", requestedVolume: 1, volume: 1 },
  });

class MockOrg implements LoadTarget {
  org = "mock";
  inserted: Record<string, Array<Record<string, unknown>>> = {};
  private id = 0;
  constructor(private existingAccounts = new Set<string>()) {}
  async exists() {
    return true;
  }
  async createableFields(o: string) {
    return o === "Contact" ? new Set(["LastName", "AccountId"]) : new Set(["Name"]);
  }
  async insert(o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    this.inserted[o] = (this.inserted[o] ?? []).concat(recs);
    return recs.map(() => ({ success: true, id: `${o.slice(0, 3)}-${this.id++}`, errors: [] }));
  }
  async existingValues(_o: string, _f: string, values: string[]) {
    return new Set(values.filter((v) => this.existingAccounts.has(v)));
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

describe("loadBundle — checkpoint / resume", () => {
  it("a fresh load saves progress then clears the checkpoint on a clean finish", async () => {
    const cp = memoryCheckpoint();
    const org = new MockOrg();
    await loadBundle(bundle(), pack, org, { checkpoint: cp });
    expect(org.inserted.Account).toHaveLength(1);
    expect(org.inserted.Contact).toHaveLength(1);
    expect(cp.load()).toBeNull(); // cleared — next run starts fresh, not a no-op resume
  });

  it("resume skips completed objects and restores their refs so children still resolve", async () => {
    // Pretend Account already loaded in a prior run (a0 → 001ACC), and the run died before Contact.
    const cp = memoryCheckpoint({ completed: ["Account"], refs: { a0: "001ACC000000001" } });
    const org = new MockOrg();
    const report = await loadBundle(bundle(), pack, org, { checkpoint: cp });

    expect(org.inserted.Account).toBeUndefined(); // skipped (already done)
    expect(report.objects.find((o) => o.object === "Account")?.resumed).toBe(true);
    expect(org.inserted.Contact).toHaveLength(1); // the remaining object loads
    expect(org.inserted.Contact![0]!.AccountId).toBe("001ACC000000001"); // parent Id restored from the checkpoint
  });

  it("bypasses additive idempotency on resume (a partially-loaded parent doesn't strip its unloaded children)", async () => {
    // Account "X" now EXISTS in the org (it was inserted last run). Fresh-load idempotency would skip X AND
    // cascade-skip its Contact — but that Contact never loaded. On resume the checkpoint is the source of truth.
    const cp = memoryCheckpoint({ completed: ["Account"], refs: { a0: "001ACC000000001" } });
    const org = new MockOrg(new Set(["X"]));
    await loadBundle(bundle(), pack, org, { idempotency: { object: "Account", field: "Name" }, checkpoint: cp });
    expect(org.inserted.Contact).toHaveLength(1); // NOT stripped by idempotency — it loads against the restored parent
  });
});
