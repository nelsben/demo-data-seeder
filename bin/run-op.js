#!/usr/bin/env node
// =============================================================================
// run-op.js — the op-runner ENTRYPOINT for the dataseed app.
//
// As of M1 the runner itself is TypeScript (packages/engine/src/cli) and the
// op + pack wiring lives in the composition root (apps/cli/src/main.ts). This
// file is a thin shim: it registers tsx's ESM loader so the TS graph runs with
// no build step, then imports the composition root (which parses argv, runs the
// op lifecycle, and calls process.exit with the contract's code).
//
//   node bin/run-op.js list                  # list available ops
//   node bin/run-op.js run <id> [--<arg> v]  # run one op (check -> run -> verify)
//   node bin/run-op.js run <id> --help       # one op's args / prereqs / affects
//   node bin/run-op.js run <id> --json       # machine-readable result
//
// Reachable as `dataseed ...` once linked (see "bin" in package.json).
// Exit codes (unchanged contract): 0 ok/skipped · 3 bad args · 4 verify failed · 5 error.
// =============================================================================

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDeps } from "./lib/deps-guard.js";

const selfPath = fileURLToPath(import.meta.url);
const here = join(dirname(selfPath), ".."); // repo root (this shim lives in bin/)

// Fresh clone? Packages aren't installed yet: in a terminal this launches the setup wizard and then
// carries on; piped/CI it prints one instruction and exits 5 — never a raw ERR_MODULE_NOT_FOUND.
await ensureDeps({
  root: here,
  command: `node bin/run-op.js ${process.argv.slice(2).join(" ")}`.trim(),
  interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
  exitCode: 5,
});

// The registry backend uses node:sqlite, which is unflagged on Node >=24 but needs
// --experimental-sqlite on Node 22/23. Re-exec once with the flag so the CLI works
// across every supported Node version (the child sees NODE_OPTIONS set → no re-loop).
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24 && !(process.env.NODE_OPTIONS ?? "").includes("experimental-sqlite")) {
  const r = spawnSync(process.execPath, [selfPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim() },
  });
  process.exit(r.status ?? 0);
}

const { register } = await import("tsx/esm/api");
const { default: dotenv } = await import("dotenv");
// Load secrets (e.g. ANTHROPIC_API_KEY) from a gitignored .env at the repo root, so the
// copy providers see them no matter which shell launched the op (cwd-independent).
dotenv.config({ path: join(here, ".env") });
register();
await import(join(here, "apps", "cli", "src", "main.ts"));
