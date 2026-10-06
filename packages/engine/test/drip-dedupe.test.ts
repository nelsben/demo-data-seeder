import { describe, it, expect } from "vitest";
import { dedupeAgainstOrg, existingNaturalKeys, naturalKey, partitionNew } from "../src/drip/dedupe.js";
import type { LoadTarget, InsertResult } from "../src/load/connection.js";

// A MockLoadTarget "pre-loaded with day-1 records" — implements the house LoadTarget mock pattern
// (loader.test.ts) plus `queryRows`, the additive capability the drip's org-facing dedupe needs.
class MockLoadTarget implements LoadTarget {
  org = "mock";
  constructor(private rows: Record<string, Array<Record<string, unknown>>> = {}) {}
  async exists() {
    return true;
  }
  async createableFields() {
    return new Set<string>();
  }
  async insert(_o: string, recs: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    return recs.map((_r, i) => ({ success: true, id: `id-${i}`, errors: [] }));
  }
  async existingValues() {
    return new Set<string>();
  }
  async queryIds() {
    return [] as string[];
  }
  async queryRows(sobject: string, selectFields: readonly string[], whereField: string, values: string[]) {
    const all = this.rows[sobject] ?? [];
    return all.filter((r) => values.includes(String(r[whereField]))).map((r) => Object.fromEntries(selectFields.map((f) => [f, r[f]])));
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

describe("naturalKey — the per-object dedup tuple", () => {
  it("truncates the date field to day granularity (EmailMessage/Task) but not other fields", () => {
    const a = naturalKey("EmailMessage", { RelatedToId: "006A", Subject: "Budget check-in", MessageDate: "2026-09-04T09:00:00.000Z" });
    const b = naturalKey("EmailMessage", { RelatedToId: "006A", Subject: "Budget check-in", MessageDate: "2026-09-04T21:45:00.000Z" });
    expect(a).toBe(b); // same day, different time-of-day → same key
    const c = naturalKey("EmailMessage", { RelatedToId: "006A", Subject: "Budget check-in", MessageDate: "2026-09-05T09:00:00.000Z" });
    expect(a).not.toBe(c); // different day → different key
  });

  it("ContentVersion has no date component (Title uniqueness under the Opportunity is enough)", () => {
    const k = naturalKey("ContentVersion", { FirstPublishLocationId: "006A", Title: "ECI transcript — Acme (2026-09-04)" });
    expect(k).toContain("006A");
    expect(k).toContain("ECI transcript");
  });
});

describe("partitionNew — pure in-memory dedupe", () => {
  it("skips a candidate already present in the existing-keys set", () => {
    const existing = new Set([naturalKey("Task", { WhatId: "006A", Subject: "Pricing call", ActivityDate: "2026-09-04" })]);
    const candidates = [{ WhatId: "006A", Subject: "Pricing call", ActivityDate: "2026-09-04" }, { WhatId: "006A", Subject: "Security review", ActivityDate: "2026-09-04" }];
    const { toInsert, skipped } = partitionNew("Task", candidates, existing);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0]!.Subject).toBe("Security review");
    expect(skipped).toHaveLength(1);
  });

  it("also dedupes WITHIN the same batch (two candidates landing on the same key)", () => {
    const candidates = [{ WhatId: "006A", Subject: "Pricing call", ActivityDate: "2026-09-04" }, { WhatId: "006A", Subject: "Pricing call", ActivityDate: "2026-09-04" }];
    const { toInsert } = partitionNew("Task", candidates, new Set());
    expect(toInsert).toHaveLength(1);
  });
});

describe("existingNaturalKeys / dedupeAgainstOrg — the org-facing check", () => {
  it("a second run of the SAME DAY inserts 0 against a MockLoadTarget pre-loaded with day-1 records", async () => {
    const day1Email = { Id: "02s000000001", RelatedToId: "006AAA", Subject: "Acme — next steps", TextBody: "…", MessageDate: "2026-09-04T15:00:00.000Z" };
    const day1Task = { Id: "00T000000001", WhatId: "006AAA", Subject: "Pricing call — budget cap", Description: "…", ActivityDate: "2026-09-04" };
    const day1Cv = { Id: "068000000001", FirstPublishLocationId: "006AAA", Title: "Einstein Conversation Insights transcript — Acme (2026-09-04)" };
    const target = new MockLoadTarget({ EmailMessage: [day1Email], Task: [day1Task], ContentVersion: [day1Cv] });

    // Day 2's re-run plans the EXACT SAME beats (same subjects/day) — as a scheduler retry would.
    const rerunEmail = { RelatedToId: "006AAA", Subject: "Acme — next steps", TextBody: "…", MessageDate: "2026-09-04T09:30:00.000Z" };
    const rerunTask = { WhatId: "006AAA", Subject: "Pricing call — budget cap", Description: "…", ActivityDate: "2026-09-04" };
    const rerunCv = { FirstPublishLocationId: "006AAA", Title: "Einstein Conversation Insights transcript — Acme (2026-09-04)" };

    const email = await dedupeAgainstOrg(target, "EmailMessage", [rerunEmail], ["006AAA"]);
    const task = await dedupeAgainstOrg(target, "Task", [rerunTask], ["006AAA"]);
    const cv = await dedupeAgainstOrg(target, "ContentVersion", [rerunCv], ["006AAA"]);

    expect(email.toInsert).toHaveLength(0);
    expect(task.toInsert).toHaveLength(0);
    expect(cv.toInsert).toHaveLength(0);
    expect(email.skipped).toHaveLength(1);
  });

  it("still inserts a GENUINELY new beat alongside an existing one for the same deal", async () => {
    const day1 = { Id: "02s000000001", RelatedToId: "006AAA", Subject: "Acme — next steps", MessageDate: "2026-09-04T15:00:00.000Z" };
    const target = new MockLoadTarget({ EmailMessage: [day1] });
    const candidates = [{ RelatedToId: "006AAA", Subject: "Acme — next steps", MessageDate: "2026-09-04T09:00:00.000Z" }, { RelatedToId: "006AAA", Subject: "Acme — security review", MessageDate: "2026-09-04T09:00:00.000Z" }];
    const { toInsert } = await dedupeAgainstOrg(target, "EmailMessage", candidates, ["006AAA"]);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0]!.Subject).toBe("Acme — security review");
  });

  it("fails open (empty existing set) for a LoadTarget with no queryRows capability", async () => {
    const target: LoadTarget = {
      org: "mock",
      exists: async () => true,
      createableFields: async () => new Set(),
      insert: async () => [],
      existingValues: async () => new Set(),
      queryIds: async () => [],
      standardPricebookId: async () => null,
      idsByField: async () => new Map(),
      idsByCompositeKey: async () => new Map(),
      convertLeads: async () => [],
      deleteRecords: async () => [],
      // no queryRows
    };
    const keys = await existingNaturalKeys(target, "Task", ["006AAA"]);
    expect(keys.size).toBe(0);
  });
});
