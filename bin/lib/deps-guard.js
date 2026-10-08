// @ts-check
// bin/lib/deps-guard.js — the first thing bin/run-op.js and bin/dataseed-mcp.js do.
//
// On a fresh clone `node_modules` doesn't exist yet, and importing tsx would die with a raw
// ERR_MODULE_NOT_FOUND stack trace. Instead: in a terminal, launch the setup wizard and then carry on
// with the command the user typed; anywhere else (pipes, CI, an MCP client) print one clear
// instruction and exit. Filesystem checks only — this runs on every invocation.

import { existsSync, readFileSync } from "node:fs";
import { depsState } from "./prereqs.js";

const fs = {
  /** @param {string} p */
  exists: (p) => existsSync(p),
  /** @param {string} p */
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

/** @param {string} command what the user ran, e.g. "node bin/run-op.js list" */
export function missingDepsMessage(command) {
  return [
    "",
    "demo-data-seeder isn't set up yet — its packages aren't installed.",
    "Run this once in the repo folder, then try again:",
    "",
    "    node bin/setup.js",
    "",
    "It checks Node, installs pnpm and the packages, and walks you through the Salesforce CLI and",
    `org login. (Then re-run: ${command})`,
    "",
  ].join("\n");
}

/**
 * Make sure packages are installed before an entrypoint imports anything from node_modules.
 * @param {{ root: string, command: string, interactive: boolean, exitCode: number }} o
 * @returns {Promise<void>} resolves when it's safe to continue; otherwise exits the process
 */
export async function ensureDeps({ root, command, interactive, exitCode }) {
  const state = depsState(root, fs);
  if (state === "ok") return;
  if (state === "stale") {
    process.stderr.write("note: packages are out of date (pnpm-lock.yaml changed since the last install) — run `pnpm install` if anything fails to load.\n");
    return;
  }
  if (interactive) {
    process.stdout.write("\nLooks like a fresh copy — this repo's packages aren't installed yet, so let's set things up first.\n\n");
    const { runWizard, terminalIO } = await import("./wizard.js");
    const { realSys } = await import("./prereqs.js");
    const io = terminalIO();
    await runWizard({ sys: realSys(root), io, mode: "interactive" });
    io.close();
    if (depsState(root, fs) !== "missing") {
      process.stdout.write(`\nContinuing with: ${command}\n\n`);
      return;
    }
  }
  process.stderr.write(missingDepsMessage(command));
  process.exit(exitCode);
}
