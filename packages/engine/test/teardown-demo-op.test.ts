// Op-level coverage for teardown-demo's `--include-drip` fix: previously `run()` threw BEFORE ever
// reaching the --include-drip logic when there was no resolvable plan-demo/load-demo dataset for the
// org — so a demo-only org that only ever ran `drip`, never `plan-demo`/`load-demo`, had NO way to tear
// down its drip-inserted records. `--include-drip` must work standalone, with no base dataset at all.
//
// The registry lookup (`openRegistry`) and the org connection (`JsforceLoadTarget.create`) are mocked
// so this never touches a real sqlite registry file or a real org — `resolveAccountsToTeardown`'s
// registry path always resolves to "no dataset" (an empty `list()`), exactly the state under test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PackRegistry } from "@dataseed/core";
import type { OpContext } from "../src/ops/types.js";
import type { DripManifest } from "../src/drip/manifest.js";

const emptyRegistryStore = { list: () => [], get: () => null, put: () => undefined, close: () => undefined };

vi.mock("@dataseed/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dataseed/registry")>();
  return { ...actual, openRegistry: vi.fn(() => emptyRegistryStore) };
});

vi.mock("../src/load/connection.js", () => ({
  JsforceLoadTarget: { create: vi.fn(async (org: string) => ({ org, deleteRecords: vi.fn(async () => [{ success: true, errors: [] }]) })) },
}));

const TEST_ORG = "test-teardown-drip-only-org";
const DRIP_DIR = join(process.cwd(), ".dataseed", "drip", TEST_ORG);
const TEARDOWN_DIR = join(process.cwd(), ".dataseed", "teardowns");

function writeDripManifest(day: string, records: DripManifest["records"]): void {
  mkdirSync(DRIP_DIR, { recursive: true });
  const manifest: DripManifest = { org: TEST_ORG, day, createdAt: `${day}T00:00:00.000Z`, runStartedAt: `${day}T00:00:00.000Z`, seed: "s", accounts: 1, beatsPerAccount: 1, provider: "test", records };
  writeFileSync(join(DRIP_DIR, `${day}.json`), JSON.stringify(manifest));
}

function ctx(): OpContext {
  return { targetOrg: TEST_ORG, packs: new PackRegistry(), log: () => {} };
}

describe("teardown-demo — --include-drip without a base dataset", () => {
  beforeEach(() => {
    rmSync(DRIP_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(DRIP_DIR, { recursive: true, force: true });
    rmSync(join(TEARDOWN_DIR, `${TEST_ORG}-salescloud.json`), { force: true });
  });

  it("check() reports datasetFound:false without throwing, and dripRecordsFound reflects manifests on disk", async () => {
    const { teardownDemoOp } = await import("../src/ops/teardown-demo.js");
    writeDripManifest("2026-09-01", [{ object: "Task", id: "00T1", naturalKey: "k1" }]);
    const result = await teardownDemoOp.check({ org: TEST_ORG, pack: "salescloud", yes: false, includeDrip: true }, ctx());
    expect(result.datasetFound).toBe(false);
    expect(result.dripRecordsFound).toBe(1);
  });

  it("run() throws the original 'no dataset' error WITHOUT --include-drip (regression guard)", async () => {
    const { teardownDemoOp } = await import("../src/ops/teardown-demo.js");
    await expect(teardownDemoOp.run({ org: TEST_ORG, pack: "salescloud", yes: false, includeDrip: false }, ctx())).rejects.toThrow(/no dataset for/);
  });

  it("run() with --include-drip and NO base dataset does not throw, and dry-run previews drip records only", async () => {
    const { teardownDemoOp } = await import("../src/ops/teardown-demo.js");
    writeDripManifest("2026-09-01", [
      { object: "Task", id: "00T1", naturalKey: "k1" },
      { object: "EmailMessage", id: "02s1", naturalKey: "k2" },
    ]);
    const logs: unknown[] = [];
    await teardownDemoOp.run({ org: TEST_ORG, pack: "salescloud", yes: false, includeDrip: true }, { ...ctx(), log: (...a) => logs.push(a.join(" ")) });

    const rp = join(TEARDOWN_DIR, `${TEST_ORG}-salescloud.json`);
    expect(existsSync(rp)).toBe(true);
    const report = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(rp, "utf8")));
    expect(report.accountsMatched).toBe(0); // no base dataset → the base plan is the empty fast path
    expect(report.drip.dryRun).toBe(true);
    expect(report.drip.objects.map((o: { object: string; matched: number }) => [o.object, o.matched])).toEqual(
      expect.arrayContaining([
        ["Task", 1],
        ["EmailMessage", 1],
      ]),
    );
    expect(logs.some((l) => String(l).includes("skipping the base teardown plan"))).toBe(true);
  });

  it("run() with --include-drip --yes and NO base dataset actually deletes the drip records", async () => {
    const { teardownDemoOp } = await import("../src/ops/teardown-demo.js");
    const { JsforceLoadTarget } = await import("../src/load/connection.js");
    writeDripManifest("2026-09-01", [{ object: "Task", id: "00T1", naturalKey: "k1" }]);

    await teardownDemoOp.run({ org: TEST_ORG, pack: "salescloud", yes: true, includeDrip: true }, ctx());

    const target = await (JsforceLoadTarget as unknown as { create: (org: string) => Promise<{ deleteRecords: ReturnType<typeof vi.fn> }> }).create(TEST_ORG);
    // the SAME mocked create() always returns a fresh vi.fn(), so assert via the report file instead —
    // the mock's per-call deleteRecords always succeeds, so a real deletion attempt shows up as deleted:1.
    void target;
    const rp = join(TEARDOWN_DIR, `${TEST_ORG}-salescloud.json`);
    const report = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(rp, "utf8")));
    expect(report.drip.dryRun).toBe(false);
    expect(report.drip.totalDeleted).toBe(1);
  });

  it("run() with --include-drip and NO base dataset and NO drip manifests either: completes with 'nothing to tear down', never throws", async () => {
    const { teardownDemoOp } = await import("../src/ops/teardown-demo.js");
    const logs: unknown[] = [];
    await teardownDemoOp.run({ org: TEST_ORG, pack: "salescloud", yes: false, includeDrip: true }, { ...ctx(), log: (...a) => logs.push(a.join(" ")) });
    expect(logs.some((l) => String(l).includes("nothing to tear down"))).toBe(true);
  });
});
