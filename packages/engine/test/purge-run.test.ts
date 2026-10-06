// packages/engine/test/purge-run.test.ts
//
// runPurge/verifyPurge orchestration against stub PurgeReader/PurgeDeleter doubles —
// the house pattern (pure modules + a MockLoadTarget-style double), no live org.
// Confirms: dry-run never deletes; --yes chunks deleteRows at 200; --hard-delete
// passes through to every chunk; verify's exit-4 case (count did not drop).

import { describe, it, expect } from "vitest";
import { runPurge, verifyPurge, DEFAULT_ID_FETCH_CAP, type PurgeReader, type PurgeDeleter, type PurgeDeleteResult, type PurgeManifestWriter } from "../src/purge/run.js";
import type { PurgeManifest } from "../src/purge/manifest.js";

class MockReader implements PurgeReader {
  calls: string[] = [];
  constructor(
    private cfg: {
      present?: boolean;
      deletable?: boolean;
      fields?: string[];
      count?: number;
      sample?: Array<Record<string, unknown>>;
      ids?: string[];
    },
  ) {}
  async describe() {
    return { present: this.cfg.present ?? true, deletable: this.cfg.deletable ?? true, fields: this.cfg.fields ?? ["Name"] };
  }
  async query<T>(soql: string): Promise<T[]> {
    this.calls.push(soql);
    if (soql.startsWith("SELECT COUNT(Id)")) return [{ cnt: this.cfg.count ?? 0 }] as unknown as T[];
    if (soql.includes("LIMIT 5")) return (this.cfg.sample ?? []) as unknown as T[];
    return (this.cfg.ids ?? []).map((Id) => ({ Id })) as unknown as T[];
  }
}

class MockDeleter implements PurgeDeleter {
  calls: Array<{ sobject: string; ids: string[]; hardDelete?: boolean }> = [];
  constructor(private failIds: Set<string> = new Set()) {}
  async deleteRows(sobject: string, ids: string[], opts?: { hardDelete?: boolean }): Promise<PurgeDeleteResult[]> {
    this.calls.push({ sobject, ids, hardDelete: opts?.hardDelete });
    return ids.map((id) => (this.failIds.has(id) ? { success: false, errors: ["boom"] } : { success: true, id, errors: [] }));
  }
}

/** A deleter that throws on its Nth call (0-based) — simulates a mid-run crash. */
class ThrowingDeleter implements PurgeDeleter {
  calls: Array<{ sobject: string; ids: string[] }> = [];
  constructor(private throwOnCallIndex: number) {}
  async deleteRows(sobject: string, ids: string[]): Promise<PurgeDeleteResult[]> {
    const callIndex = this.calls.length;
    this.calls.push({ sobject, ids });
    if (callIndex === this.throwOnCallIndex) throw new Error("simulated crash");
    return ids.map((id) => ({ success: true, id, errors: [] }));
  }
}

/** Captures every manifest write in order — the in-memory stand-in for the op's fs-backed writer. */
class RecordingWriter implements PurgeManifestWriter {
  manifests: PurgeManifest[] = [];
  write(manifest: PurgeManifest): void {
    this.manifests.push(manifest);
  }
}

describe("runPurge — dry run (no --yes)", () => {
  it("never calls deleteRows and reports the plan + sample", async () => {
    const reader = new MockReader({ count: 12, sample: [{ Id: "a01", Name: "Stale" }] });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30 });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.matchedCount).toBe(12);
    expect(result.sample).toEqual([{ id: "a01", display: "Stale" }]);
    expect(result.estimatedMBFreed).toBeGreaterThan(0);
    expect(result.manifest).toBeUndefined();
    expect(deleter.calls).toHaveLength(0);
  });

  it("refuses a bare purge before ever touching the reader", async () => {
    const reader = new MockReader({ count: 999 });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c" });
    expect(result.ok).toBe(false);
    expect(reader.calls).toHaveLength(0);
    expect(deleter.calls).toHaveLength(0);
  });

  it("refuses a DENY-listed object", async () => {
    const reader = new MockReader({ count: 1 });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "PermissionSet", all: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DENY list/);
  });

  it("refuses an absent object", async () => {
    const reader = new MockReader({ present: false, count: 0 });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Ghost__c", all: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist/);
  });

  it("refuses a non-deletable object", async () => {
    const reader = new MockReader({ deletable: false, count: 0 });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "SomeObj__c", all: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not deletable/);
  });
});

describe("runPurge — --yes", () => {
  it("chunks deleteRows at 200 and builds a manifest matching the deleted count", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const reader = new MockReader({ count: 450, ids });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30, yes: true }, { now: () => "2026-09-05T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(deleter.calls).toHaveLength(3);
    expect(deleter.calls[0]!.ids).toHaveLength(200);
    expect(deleter.calls[1]!.ids).toHaveLength(200);
    expect(deleter.calls[2]!.ids).toHaveLength(50);
    expect(result.deletedCount).toBe(450);
    expect(result.failedCount).toBe(0);
    expect(result.manifest).toEqual({
      org: "dev-frontend",
      sobject: "Audit_Log__c",
      predicate: "CreatedDate < LAST_N_DAYS:30",
      hardDelete: false,
      dryRun: false,
      status: "done",
      matchedCount: 450,
      deletedCount: 450,
      ids,
      timestamp: "2026-09-05T00:00:00.000Z",
    });
  });

  it("passes --hard-delete through to every deleteRows chunk", async () => {
    const reader = new MockReader({ count: 2, ids: ["a", "b"] });
    const deleter = new MockDeleter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30, yes: true, hardDelete: true });
    expect(deleter.calls[0]!.hardDelete).toBe(true);
    expect(result.manifest?.hardDelete).toBe(true);
  });

  it("counts partial failures separately from deletedCount", async () => {
    const reader = new MockReader({ count: 2, ids: ["a", "b"] });
    const deleter = new MockDeleter(new Set(["b"]));
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true });
    expect(result.deletedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it("caps the id fetch at --limit when given", async () => {
    const reader = new MockReader({ count: 999, ids: ["a", "b"] }); // stub always returns its fixed ids array regardless of LIMIT text
    const deleter = new MockDeleter();
    await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true, limit: 5 });
    const idFetch = reader.calls.find((c) => c.startsWith("SELECT Id FROM"))!;
    expect(idFetch).toContain("LIMIT 5");
  });

  it("falls back to the default id-fetch cap when --limit is omitted", async () => {
    const reader = new MockReader({ count: 1, ids: [] });
    const deleter = new MockDeleter();
    await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true });
    const idFetch = reader.calls.find((c) => c.startsWith("SELECT Id FROM"))!;
    expect(idFetch).toContain(`LIMIT ${DEFAULT_ID_FETCH_CAP}`);
  });
});

describe("runPurge — incremental manifest durability", () => {
  it("writes the manifest BEFORE the first delete (status planned, the full planned Id set)", async () => {
    const ids = ["a", "b", "c"];
    const reader = new MockReader({ count: 3, ids });
    const deleter = new MockDeleter();
    const writer = new RecordingWriter();
    await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true }, { manifestWriter: writer });
    expect(writer.manifests[0]).toMatchObject({ status: "planned", ids, deletedCount: 0, matchedCount: 3 });
  });

  it("flushes the manifest after EVERY chunk (status in_progress, deleted-so-far Ids) and finalizes to done", async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `id-${i}`); // 3 chunks: 200 / 200 / 1
    const reader = new MockReader({ count: 401, ids });
    const deleter = new MockDeleter();
    const writer = new RecordingWriter();
    const result = await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true }, { manifestWriter: writer });

    // planned, then one in_progress write per chunk, then a final done write.
    expect(writer.manifests.map((m) => m.status)).toEqual(["planned", "in_progress", "in_progress", "in_progress", "done"]);
    expect(writer.manifests[1]!.ids).toHaveLength(200);
    expect(writer.manifests[2]!.ids).toHaveLength(400);
    expect(writer.manifests[3]!.ids).toHaveLength(401);
    expect(writer.manifests[3]!.deletedCount).toBe(401);

    const done = writer.manifests[4]!;
    expect(done.ids).toEqual(ids);
    expect(done.deletedCount).toBe(401);
    expect(result.manifest).toEqual(done);
  });

  it("crash on chunk 2 of 3: the manifest on disk lists exactly chunk 1's Ids with status in_progress", async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `id-${i}`); // 3 chunks: 200 / 200 / 1
    const reader = new MockReader({ count: 401, ids });
    const deleter = new ThrowingDeleter(1); // throws on the 2nd deleteRows call (index 1 = chunk 2)
    const writer = new RecordingWriter();

    await expect(
      runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1, yes: true }, { manifestWriter: writer }),
    ).rejects.toThrow("simulated crash");

    expect(deleter.calls).toHaveLength(2); // chunk 1 (succeeded) + chunk 2 (threw) — chunk 3 never attempted
    const last = writer.manifests[writer.manifests.length - 1]!;
    expect(last.status).toBe("in_progress");
    expect(last.ids).toEqual(ids.slice(0, 200)); // exactly chunk 1's Ids — chunk 2 never completed
    expect(last.deletedCount).toBe(200);
  });

  it("never writes a manifest on a dry run", async () => {
    const reader = new MockReader({ count: 5, sample: [] });
    const deleter = new MockDeleter();
    const writer = new RecordingWriter();
    await runPurge(reader, deleter, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 1 }, { manifestWriter: writer });
    expect(writer.manifests).toHaveLength(0);
  });
});

describe("verifyPurge", () => {
  it("succeeds when the count dropped to the expected remainder", async () => {
    const reader = new MockReader({ count: 0 });
    const result = await verifyPurge(reader, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30 }, { preCount: 12, deletedCount: 12 });
    expect(result.success).toBe(true);
    expect(result.remainingCount).toBe(0);
  });

  it("succeeds on a partial delete when the count dropped by at least that much", async () => {
    const reader = new MockReader({ count: 2 });
    const result = await verifyPurge(reader, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30 }, { preCount: 12, deletedCount: 10 });
    expect(result.success).toBe(true);
  });

  it("fails (exit-4 case) when the count did not drop", async () => {
    const reader = new MockReader({ count: 12 });
    const result = await verifyPurge(reader, { org: "dev-frontend", sobject: "Audit_Log__c", olderThanDays: 30 }, { preCount: 12, deletedCount: 12 });
    expect(result.success).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
