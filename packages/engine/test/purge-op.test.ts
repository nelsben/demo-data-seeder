// packages/engine/test/purge-op.test.ts
//
// Direct coverage for ops/purge.ts's two review-round-1 additions that purge-run.test.ts
// (which only drives the pure src/purge/run.ts against fakes) can't reach: the REAL fs-backed
// manifest writer (fsManifestWriter — writes BOTH the timestamped audit file and the stable
// <sobject>.latest.json pointer), and verify()'s status-aware branch that reads whichever
// state a crash left behind (see purge/manifest.ts's header + docs/storage-and-purge.md).
//
// verify() with --yes always re-queries a live COUNT() through SfCliClient (same shape as
// teardown-demo's verify()) — unavoidable to confirm the delete actually stuck, so it's
// mocked at the module boundary here (vi.mock, vi.hoisted to dodge TDZ) rather than skipped.
// Everything else (describe/limits aren't exercised on this path) stays real, including the
// actual filesystem under a throwaway PURGE_DIR/<org> the test cleans up afterward.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { OpContext } from "../src/ops/types.js";
import type { PurgeManifest } from "../src/purge/manifest.js";

const { mockQuery, mockLimits } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLimits: vi.fn(),
}));

vi.mock("../src/introspect/sf-client.js", () => ({
  SfCliClient: vi.fn().mockImplementation(() => ({
    query: mockQuery,
    limits: mockLimits,
    describe: vi.fn(),
  })),
}));

const { purgeOp, PURGE_DIR, fsManifestWriter, purgeStatePath } = await import("../src/ops/purge.js");

const ORG = "test-purge-op-manifest-org";
const SOBJECT = "Test_Purge_Manifest__c";

function fakeCtx(): OpContext {
  return { targetOrg: ORG, packs: {} as OpContext["packs"], log: vi.fn() };
}

function manifest(overrides: Partial<PurgeManifest>): PurgeManifest {
  return {
    org: ORG,
    sobject: SOBJECT,
    predicate: "",
    hardDelete: false,
    dryRun: false,
    status: "done",
    matchedCount: 0,
    deletedCount: 0,
    ids: [],
    timestamp: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([{ cnt: 0 }]);
  mockLimits.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  rmSync(join(PURGE_DIR, ORG), { recursive: true, force: true });
});

describe("fsManifestWriter — real fs writes", () => {
  it("writes the SAME serialized bytes to the timestamped audit file AND the stable <sobject>.latest.json pointer", async () => {
    const writer = fsManifestWriter(ORG, SOBJECT);
    await writer.write(manifest({ status: "planned", matchedCount: 3, deletedCount: 0, ids: ["a1", "a2", "a3"] }));

    const statePath = purgeStatePath(ORG, SOBJECT);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state).toMatchObject({ status: "planned", matchedCount: 3, deletedCount: 0, ids: ["a1", "a2", "a3"] });

    const files = readdirSync(join(PURGE_DIR, ORG));
    expect(files).toContain(`${SOBJECT}.latest.json`);
    // A second, timestamped audit file distinct from the stable pointer.
    expect(files.some((f) => f !== `${SOBJECT}.latest.json` && f.endsWith(".json"))).toBe(true);
  });

  it("overwrites the SAME stable pointer file on every subsequent write (planned -> in_progress -> done)", async () => {
    const writer = fsManifestWriter(ORG, SOBJECT);
    const statePath = purgeStatePath(ORG, SOBJECT);

    await writer.write(manifest({ status: "planned", matchedCount: 2, deletedCount: 0, ids: ["a1", "a2"] }));
    expect(JSON.parse(readFileSync(statePath, "utf8")).status).toBe("planned");

    await writer.write(manifest({ status: "in_progress", matchedCount: 2, deletedCount: 1, ids: ["a1"] }));
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ status: "in_progress", deletedCount: 1 });

    await writer.write(manifest({ status: "done", matchedCount: 2, deletedCount: 2, ids: ["a1", "a2"] }));
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ status: "done", deletedCount: 2 });

    // Exactly one timestamped audit file across all three writes (fsManifestWriter computes ONE
    // Date.now() up front and reuses it) plus the one stable pointer — two files total, not three-plus.
    const files = readdirSync(join(PURGE_DIR, ORG));
    expect(files).toHaveLength(2);
  });
});

describe("purgeOp.verify() — status-aware branch reading whichever manifest state exists", () => {
  it('returns success:false with an honest "did not complete" reason when the manifest was left mid-flight (status in_progress)', async () => {
    const writer = fsManifestWriter(ORG, SOBJECT);
    await writer.write(manifest({ status: "in_progress", matchedCount: 3, deletedCount: 1, ids: ["a1"] }));

    const result = await purgeOp.verify({ org: ORG, sobject: SOBJECT, all: true, yes: true, hardDelete: false }, fakeCtx());

    expect(result.success).toBe(false);
    expect(result.matchedCount).toBe(3);
    expect(result.deletedCount).toBe(1);
    expect(String(result.reason)).toMatch(/did not complete/);
    expect(String(result.reason)).toContain('"in_progress"');
    expect(String(result.reason)).toContain("1/3");
  });

  it('also returns success:false for a manifest stuck at "planned" (crashed before the first chunk)', async () => {
    const writer = fsManifestWriter(ORG, SOBJECT);
    await writer.write(manifest({ status: "planned", matchedCount: 5, deletedCount: 0, ids: ["a1", "a2", "a3", "a4", "a5"] }));

    const result = await purgeOp.verify({ org: ORG, sobject: SOBJECT, all: true, yes: true, hardDelete: false }, fakeCtx());

    expect(result.success).toBe(false);
    expect(String(result.reason)).toContain('"planned"');
    expect(result.deletedCount).toBe(0);
  });

  it("returns success:true off a status:done manifest when the live re-count confirms nothing remains", async () => {
    const writer = fsManifestWriter(ORG, SOBJECT);
    await writer.write(manifest({ status: "done", matchedCount: 2, deletedCount: 2, ids: ["a1", "a2"] }));
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }]);

    const result = await purgeOp.verify({ org: ORG, sobject: SOBJECT, all: true, yes: true, hardDelete: false }, fakeCtx());

    expect(result).toMatchObject({ success: true, matchedCount: 2, deletedCount: 2, remainingCount: 0 });
  });

  it("returns success:false with no manifest at all (run() never wrote one)", async () => {
    const result = await purgeOp.verify({ org: ORG, sobject: SOBJECT, all: true, yes: true, hardDelete: false }, fakeCtx());
    expect(result).toMatchObject({ success: false, reason: expect.stringContaining("no purge manifest found") });
  });
});
