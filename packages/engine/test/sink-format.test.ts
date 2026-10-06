import { describe, it, expect } from "vitest";
import { formatLoadObjectLines } from "@dataseed/engine";
import type { LoadReport, ObjectLoadResult } from "@dataseed/engine";

// formatLoadObjectLines renders a LoadReport into the lines a user reads after a load. It's pure but branchy
// (object-absent, dropped fields, failure/skip counts, the first error sample) — a silent formatting
// regression here misreports what actually landed, so it's worth pinning.

const obj = (over: Partial<ObjectLoadResult>): ObjectLoadResult => ({
  object: "Account", present: true, attempted: 0, inserted: 0, failed: 0, skipped: 0, reused: 0, droppedFields: [], errors: [], ...over,
});
const report = (objects: ObjectLoadResult[]): LoadReport => ({ objects } as LoadReport);

describe("formatLoadObjectLines — load report → display lines", () => {
  it("renders a clean insert as `+N`", () => {
    expect(formatLoadObjectLines(report([obj({ object: "Account", inserted: 33, attempted: 33 })]))).toEqual(["  Account: +33"]);
  });

  it("marks an object absent from the org (no insert attempted)", () => {
    expect(formatLoadObjectLines(report([obj({ object: "Widget__c", present: false, attempted: 12 })]))).toEqual([
      "  Widget__c: not in org — skipped 12",
    ]);
  });

  it("surfaces failures, skips, dropped fields, and a sample error", () => {
    const lines = formatLoadObjectLines(
      report([obj({ object: "Contact", inserted: 140, failed: 1, skipped: 3, droppedFields: ["Foo__c", "Bar__c"], errors: ["DUPLICATE_VALUE: dupe"] })]),
    );
    expect(lines[0]).toBe("  Contact: +140 ✗1 ⤳3 skipped (dropped: Foo__c, Bar__c)");
    expect(lines[1]).toBe("    e.g. DUPLICATE_VALUE: dupe");
  });

  it("omits the failure/skip/drop decorations when there are none", () => {
    expect(formatLoadObjectLines(report([obj({ object: "Lead", inserted: 5 })]))).toEqual(["  Lead: +5"]);
  });

  it("renders multiple objects in order", () => {
    const lines = formatLoadObjectLines(report([obj({ object: "Account", inserted: 2 }), obj({ object: "Opportunity", inserted: 4 })]));
    expect(lines).toEqual(["  Account: +2", "  Opportunity: +4"]);
  });
});
