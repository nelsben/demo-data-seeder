import { describe, it, expect } from "vitest";
import { JsforceLoadTarget } from "../src/load/connection.js";

// A fake jsforce Connection exposing just the two insert paths, counting which got used.
function fakeConn() {
  const calls = { restBatches: 0, restRows: 0, bulkBatches: 0, bulkRows: 0 };
  const conn = {
    sobject: () => ({
      create: async (batch: Array<Record<string, unknown>>) => {
        calls.restBatches++;
        calls.restRows += batch.length;
        return batch.map((_b, i) => ({ success: true, id: `r${i}`, errors: [] }));
      },
    }),
    bulk: {
      load: async (_type: string, _op: string, input: Array<Record<string, unknown>>) => {
        calls.bulkBatches++;
        calls.bulkRows += input.length;
        return input.map((_b, i) => ({ success: true, id: `b${i}`, errors: [] }));
      },
    },
  };
  return { conn, calls };
}

describe("JsforceLoadTarget — REST vs Bulk routing", () => {
  it("uses REST collections below the bulk threshold (200/batch)", async () => {
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never, 5000);
    const res = await t.insert("Account", Array.from({ length: 450 }, (_, i) => ({ Name: `A${i}` })));
    expect(res).toHaveLength(450);
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.bulkBatches).toBe(0);
    expect(calls.restBatches).toBe(3); // ceil(450 / 200)
  });

  it("switches to the Bulk API at/above the threshold (10k/batch, ordered results)", async () => {
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never, 5000);
    const res = await t.insert("Contact", Array.from({ length: 12_000 }, (_, i) => ({ LastName: `C${i}` })));
    expect(res).toHaveLength(12_000);
    expect(calls.restBatches).toBe(0);
    expect(calls.bulkBatches).toBe(2); // ceil(12000 / 10000)
    expect(res[0]!.id).toBe("b0"); // result order preserved (results[i] ↔ records[i])
  });

  it("normalizes Bulk save-result failures into InsertResult errors", async () => {
    const { conn } = fakeConn();
    conn.bulk.load = (async (_t: string, _o: string, input: Array<Record<string, unknown>>) =>
      input.map((_b, i) =>
        i % 2 === 0 ? { success: true, id: `b${i}`, errors: [] } : { success: false, id: null, errors: [{ statusCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "nope" }] },
      )) as never;
    const t = new JsforceLoadTarget("mock", conn as never, 1); // threshold 1 → always bulk
    const res = await t.insert("Account", [{ Name: "A" }, { Name: "B" }]);
    expect(res[0]!.success).toBe(true);
    expect(res[1]!.success).toBe(false);
    expect(res[1]!.errors[0]).toMatch(/FIELD_CUSTOM_VALIDATION_EXCEPTION: nope/);
  });

  it("short-circuits an empty insert (no API call)", async () => {
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never, 5000);
    expect(await t.insert("Account", [])).toEqual([]);
    expect(calls.restBatches + calls.bulkBatches).toBe(0);
  });
});
