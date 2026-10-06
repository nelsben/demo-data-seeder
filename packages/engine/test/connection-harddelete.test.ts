// packages/engine/test/connection-harddelete.test.ts
//
// JsforceLoadTarget#deleteRows({ hardDelete: true }) — the purge op's write surface. Uses the same
// fakeConn() pattern as connection-routing.test.ts (a hand-rolled jsforce Connection stand-in, cast
// `as never`), extended with `query` (the deterministic UserPermissionAccess pre-check),
// `sobject().destroy` (soft delete), and `soap.emptyRecycleBin` (the fallback's second step).
//
// Two independent safety nets are covered:
//   1. DETERMINISTIC pre-check (hasBulkApiHardDelete): a `SELECT PermissionsBulkApiHardDelete FROM
//      UserPermissionAccess` query, cached per instance. false → skip the Bulk API entirely. undefined
//      (the query itself failed) → fall through and actually attempt it, exactly as if there were no
//      pre-check — the error-message net below is what decides in that case.
//   2. ERROR-MESSAGE fallback (HARD_DELETE_PERMISSION_ERROR): the pre-check said yes (or couldn't tell)
//      but the Bulk API rejected the attempt anyway. The regex is anchored on TWO known fragments,
//      exercised separately below — the sf CLI's own client-side pre-check message, and the RAW jsforce
//      Bulk API error this class actually hits in practice (captured LIVE against dev-frontend,
//      2026-09-05 — name/errorCode "FeatureNotEnabled", see RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE below).
//      Any OTHER error matches neither fragment and is NOT swallowed into the fallback — it propagates.
// A "no recycle bin entry found" emptyRecycleBin error (also observed live) is treated as success, not a
// failure, on either fallback path.

import { describe, it, expect } from "vitest";
import { JsforceLoadTarget } from "../src/load/connection.js";

/** Fragment 1 — the sf CLI's OWN plugin-data pre-check (`HardDeletePermissionError`), thrown client-side
 *  before the Bulk API is ever called. This repo never goes through that CLI command, so this is
 *  speculative insurance, not something observed here — kept as a second matchable fragment regardless. */
const SF_CLI_HARD_DELETE_PERMISSION_ERROR_MESSAGE = 'You need the Bulk API Hard Delete system permission to execute this operation.';

/** Fragment 2 — the RAW jsforce Bulk API error this class actually hits. Captured LIVE against
 *  a Developer-edition scratch org (2026-09-05): `name` and `errorCode` were both "FeatureNotEnabled";
 *  this is `.message`, verbatim. Since `deleteRows` calls jsforce `bulk.load(..., "hardDelete")` DIRECTLY
 *  (never the sf CLI), THIS is the fragment that matters in practice — dev-frontend's scratch-org user
 *  does NOT hold "Bulk API Hard Delete", so this is exactly the error `purge --hard-delete` hits there. */
const RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE = "hardDelete operation requires special user profile permission, please contact your system administrator";

/** Observed live against a demo org: emptyRecycleBin on a row purged elsewhere in the same transaction. */
const RECYCLE_BIN_ALREADY_GONE_MESSAGE = "invalid record id; no recycle bin entry found";

function fakeConn(opts: { bulkLoadError?: Error; emptyRecycleBinError?: Error; hardDeletePermission?: boolean } = {}) {
  const calls = {
    queries: [] as string[],
    bulkLoads: [] as Array<{ op: string; input: Array<Record<string, unknown>> }>,
    destroys: [] as string[][],
    emptyRecycleBins: [] as string[][],
  };
  const conn = {
    // The deterministic pre-check's query. Default (no `hardDeletePermission` given) THROWS — simulating
    // an org/API version that can't answer UserPermissionAccess at all, so hasBulkApiHardDelete() falls
    // through to "undefined" and every EXISTING fallback-focused test below still reaches hardDeleteBulk.
    query: async (soql: string) => {
      calls.queries.push(soql);
      if (opts.hardDeletePermission === undefined) throw new Error("UserPermissionAccess not queryable in this fake");
      return { records: [{ PermissionsBulkApiHardDelete: opts.hardDeletePermission }] };
    },
    sobject: () => ({
      destroy: async (ids: string[], _opts: { allOrNone: boolean }) => {
        calls.destroys.push(ids);
        return ids.map((id) => ({ success: true, id, errors: [] }));
      },
    }),
    bulk: {
      load: async (_type: string, op: string, input: Array<Record<string, unknown>>) => {
        calls.bulkLoads.push({ op, input });
        if (opts.bulkLoadError) throw opts.bulkLoadError;
        return input.map((r) => ({ success: true, id: (r as { Id: string }).Id, errors: [] }));
      },
    },
    soap: {
      emptyRecycleBin: async (ids: string[]) => {
        calls.emptyRecycleBins.push(ids);
        if (opts.emptyRecycleBinError) throw opts.emptyRecycleBinError;
        return ids.map(() => ({ success: true }));
      },
    },
  };
  return { conn, calls };
}

describe("JsforceLoadTarget#deleteRows — deterministic hard-delete pre-check", () => {
  it("skips the Bulk API entirely when the pre-check says the user lacks the permission", async () => {
    const { conn, calls } = fakeConn({ hardDeletePermission: false });
    const t = new JsforceLoadTarget("mock", conn as never);
    const ids = ["a01", "a02"];
    const res = await t.deleteRows("Audit_Log__c", ids, { hardDelete: true });
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.bulkLoads).toHaveLength(0); // never even attempted
    expect(calls.destroys).toHaveLength(1);
    expect(calls.destroys[0]).toEqual(ids);
    expect(calls.emptyRecycleBins[0]).toEqual(ids);
  });

  it("logs exactly one line via onProgress when the pre-check skips the Bulk API", async () => {
    const { conn } = fakeConn({ hardDeletePermission: false });
    const logs: string[] = [];
    const t = new JsforceLoadTarget("mock", conn as never, undefined, (m) => logs.push(m));
    await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("user lacks Bulk API Hard Delete");
  });

  it("attempts the Bulk API directly when the pre-check says the user HAS the permission", async () => {
    const { conn, calls } = fakeConn({ hardDeletePermission: true });
    const t = new JsforceLoadTarget("mock", conn as never);
    const res = await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.bulkLoads).toHaveLength(1);
    expect(calls.destroys).toHaveLength(0);
  });

  it("caches the pre-check result across multiple deleteRows calls on the same instance", async () => {
    const { conn, calls } = fakeConn({ hardDeletePermission: false });
    const t = new JsforceLoadTarget("mock", conn as never);
    await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    await t.deleteRows("Audit_Log__c", ["a02"], { hardDelete: true });
    expect(calls.queries).toHaveLength(1); // UserPermissionAccess queried once, not once per chunk
  });

  it("falls through to attempting the Bulk API when the pre-check query itself is unresolvable", async () => {
    // fakeConn()'s default (no `hardDeletePermission` given) makes the UserPermissionAccess query throw.
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never);
    const res = await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.bulkLoads).toHaveLength(1); // still tried — an unresolvable pre-check is not treated as "definitely no"
  });
});

describe("JsforceLoadTarget#deleteRows — error-message fallback (the second net)", () => {
  it("falls back to soft-delete + emptyRecycleBin on the sf-CLI-style permission error (fragment 1)", async () => {
    const { conn, calls } = fakeConn({ bulkLoadError: new Error(SF_CLI_HARD_DELETE_PERMISSION_ERROR_MESSAGE) });
    const t = new JsforceLoadTarget("mock", conn as never);
    const ids = ["a01", "a02", "a03"];
    const res = await t.deleteRows("Audit_Log__c", ids, { hardDelete: true });

    expect(res).toHaveLength(3);
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.destroys).toHaveLength(1);
    expect(calls.destroys[0]).toEqual(ids);
    expect(calls.emptyRecycleBins[0]).toEqual(ids);
  });

  it("falls back to soft-delete + emptyRecycleBin on the RAW jsforce Bulk API error (fragment 2, captured live)", async () => {
    const { conn, calls } = fakeConn({ bulkLoadError: new Error(RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE) });
    const t = new JsforceLoadTarget("mock", conn as never);
    const ids = ["a01", "a02", "a03"];
    const res = await t.deleteRows("Audit_Log__c", ids, { hardDelete: true });

    expect(res).toHaveLength(3);
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.destroys).toHaveLength(1);
    expect(calls.destroys[0]).toEqual(ids); // soft-deletes the SAME Ids the hard delete was attempted on
    expect(calls.emptyRecycleBins).toHaveLength(1);
    expect(calls.emptyRecycleBins[0]).toEqual(ids); // empties the bin for the Ids that actually soft-deleted
  });

  it("does NOT swallow an unrelated hardDeleteBulk error into the fallback — it propagates", async () => {
    const { conn, calls } = fakeConn({ bulkLoadError: new Error("UNKNOWN_EXCEPTION: something else broke") });
    const t = new JsforceLoadTarget("mock", conn as never);
    await expect(t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true })).rejects.toThrow("UNKNOWN_EXCEPTION: something else broke");
    expect(calls.destroys).toHaveLength(0); // never fell back
    expect(calls.emptyRecycleBins).toHaveLength(0);
  });

  it('treats a "no recycle bin entry found" emptyRecycleBin error as success-already-purged, not a failure', async () => {
    const { conn, calls } = fakeConn({
      bulkLoadError: new Error(RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE),
      emptyRecycleBinError: new Error(RECYCLE_BIN_ALREADY_GONE_MESSAGE),
    });
    const t = new JsforceLoadTarget("mock", conn as never);
    const res = await t.deleteRows("Audit_Log__c", ["a01", "a02"], { hardDelete: true });

    // The whole call still resolves (doesn't reject) and reports the soft-delete as successful — the row
    // being already gone from the Recycle Bin is not treated as this operation having failed.
    expect(res.every((r) => r.success)).toBe(true);
    expect(calls.emptyRecycleBins).toHaveLength(1);
  });

  it("swallows any OTHER emptyRecycleBin error too (best-effort) — rows are already soft-deleted regardless", async () => {
    const { conn } = fakeConn({
      bulkLoadError: new Error(RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE),
      emptyRecycleBinError: new Error("UNEXPECTED_ERROR: recycle bin service unavailable"),
    });
    const t = new JsforceLoadTarget("mock", conn as never);
    const res = await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    expect(res.every((r) => r.success)).toBe(true);
  });

  it("skips emptyRecycleBin entirely when the soft-delete fallback itself deletes nothing", async () => {
    const calls = { destroys: [] as string[][], emptyRecycleBins: [] as string[][] };
    const destroyFailConn = {
      query: async () => {
        throw new Error("UserPermissionAccess not queryable in this fake");
      },
      sobject: () => ({
        destroy: async (ids: string[]) => {
          calls.destroys.push(ids);
          return ids.map((id) => ({ success: false, id: undefined, errors: [`INSUFFICIENT_ACCESS: cannot delete ${id}`] }));
        },
      }),
      bulk: {
        load: async () => {
          throw new Error(RAW_JSFORCE_HARD_DELETE_ERROR_MESSAGE);
        },
      },
      soap: {
        emptyRecycleBin: async (ids: string[]) => {
          calls.emptyRecycleBins.push(ids);
          return ids.map(() => ({ success: true }));
        },
      },
    };
    const t = new JsforceLoadTarget("mock", destroyFailConn as never);
    const res = await t.deleteRows("Audit_Log__c", ["a01"], { hardDelete: true });
    expect(res.every((r) => !r.success)).toBe(true);
    expect(calls.emptyRecycleBins).toHaveLength(0); // nothing soft-deleted → nothing to empty
  });

  it("plain (non-hard) delete never touches the Bulk API, the pre-check, or emptyRecycleBin", async () => {
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never);
    await t.deleteRows("Audit_Log__c", ["a01"]);
    expect(calls.queries).toHaveLength(0);
    expect(calls.bulkLoads).toHaveLength(0);
    expect(calls.emptyRecycleBins).toHaveLength(0);
    expect(calls.destroys).toHaveLength(1);
  });

  it("short-circuits an empty id list (no API call at all)", async () => {
    const { conn, calls } = fakeConn();
    const t = new JsforceLoadTarget("mock", conn as never);
    expect(await t.deleteRows("Audit_Log__c", [], { hardDelete: true })).toEqual([]);
    expect(calls.queries).toHaveLength(0);
    expect(calls.bulkLoads).toHaveLength(0);
    expect(calls.destroys).toHaveLength(0);
  });
});
