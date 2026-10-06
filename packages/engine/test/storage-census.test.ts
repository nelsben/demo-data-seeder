// packages/engine/test/storage-census.test.ts
//
// Pure census math: sorting (desc by count, failed `null` counts sink to the bottom),
// the RECORDS_PER_MB MB estimate, the top-N cap, and the `?` display convention for a
// failed count. No org, no fs.

import { describe, it, expect } from "vitest";
import { RECORDS_PER_MB } from "@dataseed/core";
import { buildCensus, topRows, formatCensusRow, CENSUS_TOP_N, STORAGE_STANDARD_OBJECTS } from "../src/introspect/storage-census.js";

describe("buildCensus", () => {
  it("sorts descending by count", () => {
    const rows = buildCensus({ Account: 10, Contact: 500, Task: 50 });
    expect(rows.map((r) => r.object)).toEqual(["Contact", "Task", "Account"]);
  });

  it("estimates MB at RECORDS_PER_MB rows/MB", () => {
    const [row] = buildCensus({ Account: RECORDS_PER_MB * 2 });
    expect(row!.estimatedMB).toBeCloseTo(2);
  });

  it("sinks a failed (null) count to the bottom regardless of the other counts", () => {
    const rows = buildCensus({ Broken__c: null, Account: 5, Contact: 1 });
    expect(rows.map((r) => r.object)).toEqual(["Account", "Contact", "Broken__c"]);
    expect(rows[2]!.estimatedMB).toBeNull();
  });

  it("keeps a stable (no-crash) order when every count failed", () => {
    const rows = buildCensus({ A__c: null, B__c: null });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === null)).toBe(true);
  });

  it("handles an empty counts map", () => {
    expect(buildCensus({})).toEqual([]);
  });
});

describe("topRows", () => {
  it("caps at CENSUS_TOP_N (20) by default", () => {
    expect(CENSUS_TOP_N).toBe(20);
    const counts = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Obj${i}__c`, 30 - i]));
    const rows = topRows(buildCensus(counts));
    expect(rows).toHaveLength(20);
    expect(rows[0]!.object).toBe("Obj0__c"); // count 30, the biggest
  });

  it("supports a custom n", () => {
    const rows = topRows(buildCensus({ A: 3, B: 2, C: 1 }), 2);
    expect(rows.map((r) => r.object)).toEqual(["A", "B"]);
  });
});

describe("formatCensusRow", () => {
  it("renders `?` for a failed count and its estimate", () => {
    const line = formatCensusRow({ object: "Weird__c", count: null, estimatedMB: null });
    expect(line).toContain("Weird__c");
    expect(line).toContain("?");
  });

  it("renders count + estimated MB for a normal row", () => {
    const line = formatCensusRow({ object: "Account", count: 1024, estimatedMB: 2 });
    expect(line).toContain("Account");
    expect(line).toContain("1,024");
    expect(line).toContain("2.00MB");
  });
});

describe("STORAGE_STANDARD_OBJECTS", () => {
  it("covers the fixed list of seeder-written standard objects", () => {
    for (const obj of ["Account", "Contact", "Opportunity", "OpportunityContactRole", "EmailMessage", "ContentVersion", "ContentDocumentLink", "CaseComment", "CampaignMember", "Asset"]) {
      expect(STORAGE_STANDARD_OBJECTS).toContain(obj);
    }
  });
});
