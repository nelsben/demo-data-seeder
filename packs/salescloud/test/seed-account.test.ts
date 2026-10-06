import { describe, it, expect, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackRegistry } from "@dataseed/core";
import { seedAccountOp, type OpContext } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";

const whPath = join(tmpdir(), `seed-account-smoke-${process.pid}.db`);
const ctx: OpContext = { targetOrg: null, packs: new PackRegistry().register(salescloudPack), log: () => {} };
const args = { pack: "salescloud", seed: "seed-account-smoke", scenario: "healthy-tech", provider: "static", warehouse: whPath, reseed: true };

afterAll(() => {
  for (const p of [whPath, `${whPath}-wal`, `${whPath}-shm`]) if (existsSync(p)) rmSync(p, { force: true });
});

describe("seed-account op (offline, --provider static)", () => {
  it("seeds ONE synthetic account end-to-end into the warehouse: identity → full graph → prose", async () => {
    await seedAccountOp.run(args, ctx);
    const verify = (await seedAccountOp.verify(args, ctx)) as Record<string, unknown>;
    expect(verify.success).toBe(true);
    expect(verify.accounts).toBe(1);
    expect(verify.industryOk).toBe(true);
    expect(verify.emails as number).toBeGreaterThan(0);
    expect(verify.emailsWithBody).toBe(verify.emails); // every email body filled (no blanks)
    expect(verify.transcripts as number).toBeGreaterThan(0);
  });

  it("is idempotent: a second check reports alreadyDone (cache hit, no rebuild)", async () => {
    const check = (await seedAccountOp.check({ ...args, reseed: false }, ctx)) as Record<string, unknown>;
    expect(check.alreadyDone).toBe(true);
    expect(check.totalRecords as number).toBeGreaterThan(0);
  });
});
