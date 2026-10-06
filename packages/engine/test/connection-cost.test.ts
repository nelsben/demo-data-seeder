import { describe, it, expect } from "vitest";
import { estimateObjectInsertCost, DEFAULT_BULK_THRESHOLD } from "../src/load/connection.js";

// estimateObjectInsertCost is the single source of truth an up-front estimate calls to preview the
// Salesforce API-call cost of a load — it must mirror JsforceLoadTarget.insert()'s actual REST(200/call)
// vs Bulk(10k/batch) switch exactly, or an estimate could tell a caller "safe" when the real load isn't.

describe("estimateObjectInsertCost", () => {
  it("returns zero cost for zero (or negative) rows", () => {
    expect(estimateObjectInsertCost(0)).toEqual({ restApiCalls: 0, bulkApiBatches: 0 });
    expect(estimateObjectInsertCost(-5)).toEqual({ restApiCalls: 0, bulkApiBatches: 0 });
  });

  it("below the threshold: REST collections at 200 rows/call, no bulk batches", () => {
    expect(estimateObjectInsertCost(1)).toEqual({ restApiCalls: 1, bulkApiBatches: 0 });
    expect(estimateObjectInsertCost(200)).toEqual({ restApiCalls: 1, bulkApiBatches: 0 });
    expect(estimateObjectInsertCost(201)).toEqual({ restApiCalls: 2, bulkApiBatches: 0 });
    expect(estimateObjectInsertCost(DEFAULT_BULK_THRESHOLD - 1)).toEqual({ restApiCalls: Math.ceil((DEFAULT_BULK_THRESHOLD - 1) / 200), bulkApiBatches: 0 });
  });

  it("at/above the threshold: Bulk API at 10,000 rows/batch, zero REST calls", () => {
    expect(estimateObjectInsertCost(DEFAULT_BULK_THRESHOLD)).toEqual({ restApiCalls: 0, bulkApiBatches: 1 });
    expect(estimateObjectInsertCost(10_000)).toEqual({ restApiCalls: 0, bulkApiBatches: 1 });
    expect(estimateObjectInsertCost(10_001)).toEqual({ restApiCalls: 0, bulkApiBatches: 2 });
    expect(estimateObjectInsertCost(1_000_000)).toEqual({ restApiCalls: 0, bulkApiBatches: 100 });
  });

  it("honors a custom bulkThreshold (a scratch org's lower cutover point)", () => {
    expect(estimateObjectInsertCost(500, 200)).toEqual({ restApiCalls: 0, bulkApiBatches: 1 }); // now routes to Bulk
    expect(estimateObjectInsertCost(199, 200)).toEqual({ restApiCalls: 1, bulkApiBatches: 0 }); // still under it
  });
});
