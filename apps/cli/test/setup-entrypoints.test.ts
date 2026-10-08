// End to end: the real bin/ entrypoints on a fresh copy of the repo (no node_modules) and a bare PATH.
// The bug this guards against: `node bin/run-op.js` on a fresh clone died with a raw
// ERR_MODULE_NOT_FOUND stack trace instead of telling the user what to do.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingDepsMessage } from "../../../bin/lib/deps-guard.js";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
let fresh = "";
let emptyPath = "";

beforeAll(() => {
  fresh = mkdtempSync(join(tmpdir(), "dataseed-fresh-"));
  cpSync(join(REPO, "bin"), join(fresh, "bin"), { recursive: true });
  for (const f of ["package.json", "pnpm-lock.yaml", ".env.example"]) cpSync(join(REPO, f), join(fresh, f));
  emptyPath = join(fresh, ".empty-path");
  mkdirSync(emptyPath);
});
afterAll(() => rmSync(fresh, { recursive: true, force: true }));

/** Run a bin/ script with no TTY (stdin closed) and nothing on PATH — not even pnpm, sf or claude. */
const runBin = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, [join(fresh, "bin", script), ...args], {
    cwd: fresh,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: emptyPath, HOME: fresh, NO_COLOR: "1" },
    timeout: 30_000,
  });

describe("fresh clone, no packages installed", () => {
  it("bin/run-op.js prints one instruction (not a stack trace) and exits 5", () => {
    const r = runBin("run-op.js", ["list"]);
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("node bin/setup.js");
    expect(r.stderr).toContain("node bin/run-op.js list");
    expect(r.stderr + r.stdout).not.toMatch(/ERR_MODULE_NOT_FOUND|at .*node:internal/);
  });

  it("bin/dataseed-mcp.js keeps stdout clean (it's the MCP channel) and exits 1", () => {
    const r = runBin("dataseed-mcp.js");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(missingDepsMessage("node bin/dataseed-mcp.js"));
  });

  it("bin/setup.js --check runs with zero packages and reports what's missing", () => {
    const r = runBin("setup.js", ["--check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("✗ pnpm");
    expect(r.stdout).toContain("✗ Packages");
    expect(r.stdout).toContain("! Salesforce CLI");
    expect(r.stdout).toContain("2 required items missing.");
  });

  it("bin/setup.js with no terminal falls back to a report instead of hanging on a prompt", () => {
    const r = runBin("setup.js");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("node bin/setup.js --yes");
  });

  it("bin/setup.js --help", () => {
    const r = runBin("setup.js", ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: node bin/setup.js");
  });
});

describe("installed, but the lockfile moved on (after a git pull)", () => {
  it("bin/run-op.js warns on stderr and carries on to the real import", () => {
    const nm = join(fresh, "node_modules");
    for (const d of [nm, join(nm, "tsx"), join(nm, "dotenv"), join(nm, ".pnpm")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(nm, ".modules.yaml"), "x");
    writeFileSync(join(nm, "tsx", "package.json"), "{}");
    writeFileSync(join(nm, "dotenv", "package.json"), "{}");
    writeFileSync(join(nm, ".pnpm", "lock.yaml"), "an older lockfile");
    const r = runBin("run-op.js", ["list"]);
    expect(r.stderr).toContain("packages are out of date");
    expect(r.stderr).not.toContain("isn't set up yet"); // not treated as a fresh clone
    rmSync(nm, { recursive: true, force: true });
  });
});
