// packages/engine/test/purge-plan.test.ts
//
// RED-FIRST: the pure purge-plan pipeline — predicate composition from --where /
// --older-than-days, the bare-purge refusal, the DENY-list refusal, 200-row chunking,
// and the purge manifest's round-trip. No org, no fs — everything here is a pure
// function of its input (see packages/engine/src/purge/plan.ts + manifest.ts).

import { describe, it, expect } from "vitest";
import { buildPredicate, buildPurgePlan, chunkIds, PURGE_CHUNK_SIZE } from "../src/purge/plan.js";
import { isDenied } from "../src/purge/deny-list.js";
import { PurgeManifest, serializePurgeManifest, parsePurgeManifest } from "../src/purge/manifest.js";

describe("buildPredicate", () => {
  it("combines --where and --older-than-days with AND", () => {
    expect(buildPredicate({ where: "Status__c = 'Stale'", olderThanDays: 30 })).toBe("(Status__c = 'Stale') AND CreatedDate < LAST_N_DAYS:30");
  });

  it("uses only --where when olderThanDays is absent", () => {
    expect(buildPredicate({ where: "Name != null" })).toBe("(Name != null)");
  });

  it("uses only --older-than-days when where is absent, defaulting dateField to CreatedDate", () => {
    expect(buildPredicate({ olderThanDays: 7 })).toBe("CreatedDate < LAST_N_DAYS:7");
  });

  it("supports a custom --date-field", () => {
    expect(buildPredicate({ olderThanDays: 5, dateField: "LastModifiedDate" })).toBe("LastModifiedDate < LAST_N_DAYS:5");
  });

  it("is empty when neither predicate is given (the bare-purge case)", () => {
    expect(buildPredicate({})).toBe("");
  });

  it("ignores a blank/whitespace-only --where", () => {
    expect(buildPredicate({ where: "   " })).toBe("");
  });

  it("throws on a negative --older-than-days", () => {
    expect(() => buildPredicate({ olderThanDays: -1 })).toThrow(/non-negative/);
  });

  it("floors a fractional --older-than-days", () => {
    expect(buildPredicate({ olderThanDays: 7.9 })).toBe("CreatedDate < LAST_N_DAYS:7");
  });
});

describe("isDenied", () => {
  it("is case-insensitive on the exact DENY names", () => {
    expect(isDenied("user")).toBe(true);
    expect(isDenied("USER")).toBe(true);
    expect(isDenied("Organization")).toBe(true);
  });

  it("denies any __mdt object regardless of name", () => {
    expect(isDenied("Slack_Config__mdt")).toBe(true);
    expect(isDenied("Anything_Else__mdt")).toBe(true);
  });

  it("allows an ordinary data object, including an app's own custom objects", () => {
    expect(isDenied("Signal_Event__c")).toBe(false);
    expect(isDenied("Audit_Log__c")).toBe(false);
    expect(isDenied("Custom_Framework__c")).toBe(false);
  });
});

describe("buildPurgePlan — refusals", () => {
  it("refuses a bare purge with neither --where, --older-than-days, nor --all", () => {
    const plan = buildPurgePlan({ sobject: "Audit_Log__c" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/bare purge/);
  });

  it("allows a bare purge when --all is explicit", () => {
    const plan = buildPurgePlan({ sobject: "Audit_Log__c", all: true });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.predicate).toBe("");
      expect(plan.whereClause).toBe("");
    }
  });

  it.each(["User", "Profile", "PermissionSet", "Organization", "My_Config__mdt"])(
    "refuses the DENY-listed object %s even with a real predicate",
    (sobject) => {
      const plan = buildPurgePlan({ sobject, where: "Id != null" });
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/DENY list/);
    },
  );

  it("DENY-list refusal wins even over --all", () => {
    const plan = buildPurgePlan({ sobject: "User", all: true });
    expect(plan.ok).toBe(false);
  });

  it("builds a real plan for an allowed object with a predicate", () => {
    const plan = buildPurgePlan({ sobject: "Audit_Log__c", olderThanDays: 30 });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.sobject).toBe("Audit_Log__c");
      expect(plan.predicate).toBe("CreatedDate < LAST_N_DAYS:30");
      expect(plan.whereClause).toBe(" WHERE CreatedDate < LAST_N_DAYS:30");
    }
  });
});

describe("chunkIds", () => {
  it("chunks into groups of 200 by default", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(PURGE_CHUNK_SIZE).toBe(200);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(50);
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns no chunks for an empty list", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("supports a custom chunk size", () => {
    expect(chunkIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("purge manifest — round trip", () => {
  const manifest: PurgeManifest = {
    org: "dev-frontend",
    sobject: "Audit_Log__c",
    predicate: "CreatedDate < LAST_N_DAYS:30",
    hardDelete: false,
    dryRun: false,
    status: "done",
    matchedCount: 12,
    deletedCount: 12,
    ids: ["a01", "a02"],
    timestamp: "2026-09-05T00:00:00.000Z",
  };

  it("serializes and re-parses to an equivalent manifest", () => {
    const json = serializePurgeManifest(manifest);
    expect(parsePurgeManifest(json)).toEqual(manifest);
  });

  it("defaults hardDelete/dryRun/status when omitted", () => {
    const { hardDelete, dryRun, status, ...rest } = manifest;
    void hardDelete;
    void dryRun;
    void status;
    const parsed = PurgeManifest.parse(rest);
    expect(parsed.hardDelete).toBe(false);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.status).toBe("done");
  });

  it("accepts the planned/in_progress durable-progress states", () => {
    expect(PurgeManifest.parse({ ...manifest, status: "planned", ids: ["a01", "a02", "a03"], deletedCount: 0 }).status).toBe("planned");
    expect(PurgeManifest.parse({ ...manifest, status: "in_progress", ids: ["a01"], deletedCount: 1 }).status).toBe("in_progress");
  });

  it("rejects a malformed manifest", () => {
    expect(() => parsePurgeManifest(JSON.stringify({ org: "x" }))).toThrow();
  });

  it("rejects an unknown status value", () => {
    expect(() => PurgeManifest.parse({ ...manifest, status: "bogus" })).toThrow();
  });
});
