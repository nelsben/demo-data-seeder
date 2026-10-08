#!/usr/bin/env node
// @ts-check
// =============================================================================
// setup.js — the first-run setup wizard. Safe to run any time; it only changes
// what you say yes to.
//
//   node bin/setup.js          check everything, then offer to install each missing piece
//   node bin/setup.js --check  report only, change nothing (exit 1 if something required is missing)
//   node bin/setup.js --yes    install everything without asking (org login still needs you)
//
// Zero dependencies: it runs before `pnpm install`. Logic lives in bin/lib/.
// =============================================================================

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realSys } from "./lib/prereqs.js";
import { runWizard, terminalIO } from "./lib/wizard.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "Usage: node bin/setup.js [--check | --yes]",
      "",
      "  (no flags)  check prerequisites, then offer to install each missing piece",
      "  --check     report only; exit 1 if something required is missing",
      "  --yes       install everything without prompting (org login is skipped — it needs your browser)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
const explicitCheck = args.includes("--check");
const yes = args.includes("--yes") || args.includes("-y");
// No terminal to ask questions in (piped, CI) and no --yes: report instead of hanging on a prompt.
const mode = explicitCheck ? "check" : yes ? "yes" : interactive ? "interactive" : "check";

const io = terminalIO();
const { ok } = await runWizard({ sys: realSys(root), io, mode, nonInteractive: mode === "check" && !explicitCheck });
io.close();
process.exit(ok ? 0 : 1);
