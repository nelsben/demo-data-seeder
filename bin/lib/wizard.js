// @ts-check
// bin/lib/wizard.js — the setup flow behind `node bin/setup.js` (and the first-run guard in bin/run-op.js).
//
// Check everything, show one table, then walk the missing pieces IN DEPENDENCY ORDER — pnpm → packages →
// Salesforce CLI → org login → AI copy writer — asking before each install and explaining what you lose by
// skipping. Nothing here throws on a failed install: it says what went wrong and how to do it by hand,
// then moves on. Zero dependencies (runs before `pnpm install`).

import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runChecks, pinnedPnpmVersion, depsState } from "./prereqs.js";

/**
 * @typedef {import("./prereqs.js").Sys} Sys
 * @typedef {import("./prereqs.js").Check} Check
 * @typedef {"interactive" | "yes" | "check"} Mode
 * @typedef {{ out: (s: string) => void, ask: (q: string) => Promise<string>, color: boolean, close: () => void }} IO
 */

const ALIAS_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_ALIAS = "demo-org";
const SANDBOX_URL = "https://test.salesforce.com";

/** The real terminal. Readline is created lazily so `--check` never touches stdin. @returns {IO} */
export function terminalIO() {
  /** @type {import("node:readline/promises").Interface | null} */
  let rl = null;
  return {
    out: (s) => void process.stdout.write(s),
    ask: async (q) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    },
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    close: () => rl?.close(),
  };
}

// ── Presentation ──────────────────────────────────────────────────────────────────────────────

/** @param {IO} io */
function styles(io) {
  /** @param {string} code */
  const p = (code) => /** @param {string} s */ (s) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: p("1"), dim: p("2"), red: p("31"), green: p("32"), yellow: p("33"), cyan: p("36") };
}

/** @param {IO} io @param {Check[]} checks */
export function printReport(io, checks) {
  const s = styles(io);
  for (const c of checks) {
    const mark = c.status === "ok" ? s.green("✓") : c.required ? s.red("✗") : s.yellow("!");
    io.out(`  ${mark} ${c.label.padEnd(16)} ${c.status === "ok" ? c.detail : s.dim(c.detail)}\n`);
  }
}

/** @param {Check[]} checks */
const requiredOk = (checks) => checks.every((c) => !c.required || c.status !== "missing");

/**
 * Ask a yes/no question. `--yes` answers for you (and says so); a blank answer takes the default.
 * @param {IO} io @param {Mode} mode @param {string} question @param {boolean} [def]
 */
async function confirm(io, mode, question, def = true) {
  const s = styles(io);
  if (mode === "yes") {
    io.out(`  ${question} ${s.dim("yes (--yes)")}\n`);
    return true;
  }
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(`  ${question} ${s.dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
    if (a === "") return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
    io.out(s.dim("  Please answer y or n.\n"));
  }
  return def;
}

/** @param {IO} io @param {string} title @param {number} n @param {number} total */
function stepHeader(io, title, n, total) {
  const s = styles(io);
  io.out(`\n${s.bold(`Step ${n} of ${total} · ${title}`)}\n`);
}

/** @param {IO} io @param {string} cmd */
function showRunning(io, cmd) {
  io.out(styles(io).dim(`  $ ${cmd}\n`));
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Get pnpm onto the machine. Returns the command prefix to run pnpm with: ["pnpm"] when it's installed,
 * or a one-off ["npx", "--yes", "pnpm@x"] when a global install was declined or failed.
 * @param {Sys} sys @param {IO} io @param {Mode} mode @param {Check} check
 * @returns {Promise<string[]>}
 */
async function stepPnpm(sys, io, mode, check) {
  const s = styles(io);
  const version = pinnedPnpmVersion(sys);
  const oneOff = ["npx", "--yes", `pnpm@${version}`];
  io.out("  pnpm is the package manager this repo is built with.\n");
  const [cmd, args] = check.corepack
    ? /** @type {const} */ (["corepack", ["enable", "pnpm"]])
    : /** @type {const} */ (["npm", ["install", "--global", `pnpm@${version}`]]);
  if (!(await confirm(io, mode, `Install pnpm now (${cmd} ${args.join(" ")})?`))) {
    io.out(s.dim(`  OK — I'll use a one-off copy (${oneOff.join(" ")}) for the install below.\n`));
    return oneOff;
  }
  showRunning(io, `${cmd} ${args.join(" ")}`);
  const r = sys.run(cmd, [...args]);
  if (r.ok && sys.exec("pnpm", ["--version"]).ok) {
    io.out(s.green("  ✓ pnpm installed\n"));
    return ["pnpm"];
  }
  io.out(s.yellow(`  That didn't work (often a permissions issue — see the output above).\n`));
  io.out(`  To install it yourself later: ${s.cyan(`npm install --global pnpm@${version}`)} (you may need sudo)\n`);
  io.out(s.dim(`  For now I'll use a one-off copy: ${oneOff.join(" ")}\n`));
  return oneOff;
}

/** @param {Sys} sys @param {IO} io @param {Mode} mode @param {string[]} pnpm */
async function stepDeps(sys, io, mode, pnpm) {
  const s = styles(io);
  const stale = depsState(sys.root, sys) === "stale";
  io.out(
    stale
      ? "  The lockfile changed since the last install (usually after a git pull), so some packages are missing.\n"
      : "  Downloads this repo's packages into ./node_modules (about a minute the first time).\n",
  );
  const cmd = [...pnpm, "install"];
  if (!(await confirm(io, mode, `Run ${cmd.join(" ")} now?`))) {
    io.out(s.yellow(`  Skipped — nothing in the repo will run until you do: ${cmd.join(" ")}\n`));
    return;
  }
  showRunning(io, cmd.join(" "));
  const [bin = "pnpm", ...rest] = cmd;
  const r = sys.run(bin, rest);
  if (r.ok && depsState(sys.root, sys) !== "missing") io.out(s.green("  ✓ packages installed\n"));
  else io.out(s.yellow(`  The install didn't finish — see the output above, then retry: ${cmd.join(" ")}\n`));
}

/** @param {Sys} sys @param {IO} io @param {Mode} mode @returns {Promise<boolean>} sf usable afterwards */
async function stepSf(sys, io, mode) {
  const s = styles(io);
  io.out("  The Salesforce CLI (sf) is how the seeder reads and writes your org. Skip it if you only want to\n");
  io.out("  generate data offline — you can come back to this any time.\n");
  if (!(await confirm(io, mode, "Install it now (npm install --global @salesforce/cli, a minute or two)?"))) {
    io.out(s.dim("  Skipped. Install later with: npm install --global @salesforce/cli\n"));
    return false;
  }
  showRunning(io, "npm install --global @salesforce/cli");
  const r = sys.run("npm", ["install", "--global", "@salesforce/cli"]);
  if (r.ok && sys.exec("sf", ["--version"]).ok) {
    io.out(s.green("  ✓ Salesforce CLI installed\n"));
    return true;
  }
  io.out(s.yellow("  That didn't work (see the output above).\n"));
  io.out(`  Install it yourself: ${s.cyan("npm install --global @salesforce/cli")} (may need sudo), or the installer at\n`);
  io.out("  https://developer.salesforce.com/tools/salesforcecli — then re-run node bin/setup.js.\n");
  return false;
}

/** @param {Sys} sys @param {IO} io @param {Mode} mode @param {Check} check */
async function stepOrg(sys, io, mode, check) {
  const s = styles(io);
  const later = `sf org login web --alias ${DEFAULT_ALIAS}`;
  if (check.status === "warn") io.out("  You have orgs on file, but none has a live session — logging in again fixes that.\n");
  else io.out("  Log in once and the seeder can profile, load and tear down data in that org.\n");
  if (mode === "yes") {
    io.out(s.dim(`  Skipped under --yes (login opens your browser). When you're ready: ${later}\n`));
    return;
  }
  io.out("  Which kind of org?\n");
  io.out(`    1) Production or Developer Edition ${s.dim("(login.salesforce.com)")}\n`);
  io.out(`    2) Sandbox ${s.dim("(test.salesforce.com)")}\n`);
  io.out("    3) Not now\n");
  let choice = "";
  for (let i = 0; i < 3 && !["1", "2", "3"].includes(choice); i++) choice = (await io.ask(`  Choose ${s.dim("[1]")} `)).trim() || "1";
  if (choice !== "1" && choice !== "2") {
    io.out(s.dim(`  Skipped. When you're ready: ${later}\n`));
    io.out(s.dim("  (Custom My Domain? add --instance-url https://<yourdomain>.my.salesforce.com)\n"));
    return;
  }
  let alias = "";
  for (let i = 0; i < 3 && !ALIAS_RE.test(alias); i++) {
    alias = (await io.ask(`  Name for this org — you'll pass it as --org ${s.dim(`[${DEFAULT_ALIAS}]`)} `)).trim() || DEFAULT_ALIAS;
    if (!ALIAS_RE.test(alias)) io.out(s.dim("  Letters, numbers, dots, dashes and underscores only.\n"));
  }
  if (!ALIAS_RE.test(alias)) alias = DEFAULT_ALIAS;
  const args = ["org", "login", "web", "--alias", alias, "--set-default", ...(choice === "2" ? ["--instance-url", SANDBOX_URL] : [])];
  io.out("  Opening your browser — log in there, then come back here.\n");
  showRunning(io, `sf ${args.join(" ")}`);
  const r = sys.run("sf", args);
  if (r.ok) io.out(s.green(`  ✓ logged in as "${alias}"\n`));
  else io.out(s.yellow(`  Login didn't complete. Retry any time: sf ${args.join(" ")}\n`));
}

/** @param {Sys} sys @param {IO} io @param {Mode} mode @param {Check} check */
async function stepCopy(sys, io, mode, check) {
  const s = styles(io);
  const envPath = join(sys.root, ".env");
  if (check.placeholderKey) {
    io.out("  .env still has the template's placeholder API key, so the API provider would fail on every call.\n");
    if (await confirm(io, mode, "Comment that line out for now (you can add a real key later)?")) {
      const text = sys.read(envPath) ?? "";
      sys.write(envPath, text.replace(/^(\s*)(ANTHROPIC_API_KEY\s*=\s*["']?sk-ant-\.\.\.["']?\s*)$/m, "$1# $2"));
      io.out(s.green("  ✓ placeholder commented out in .env\n"));
    }
    return;
  }
  io.out("  Emails, call notes and transcripts read most real when an LLM writes them. The easiest way is the\n");
  io.out("  Claude Code CLI, which runs on your Claude subscription — no API key needed.\n");
  if (await confirm(io, mode, "Install it now (npm install --global @anthropic-ai/claude-code)?")) {
    showRunning(io, "npm install --global @anthropic-ai/claude-code");
    const r = sys.run("npm", ["install", "--global", "@anthropic-ai/claude-code"]);
    if (r.ok && sys.exec("claude", ["--version"]).ok) {
      io.out(s.green("  ✓ installed") + ` — run ${s.cyan("claude")} once to sign in with your Claude account.\n`);
      return;
    }
    io.out(s.yellow("  That didn't work (see the output above). Other install options: https://claude.com/claude-code\n"));
  }
  io.out(s.dim("  Alternative: put ANTHROPIC_API_KEY=sk-ant-… in .env to use the API (billed separately).\n"));
  if (!check.envFile && mode !== "yes" && (await confirm(io, mode, "Create .env from the template now?", false))) {
    sys.write(envPath, sys.read(join(sys.root, ".env.example")) ?? "# ANTHROPIC_API_KEY=sk-ant-...\n");
    io.out(s.green("  ✓ created .env") + " — edit it to add your key.\n");
  }
}

// ── Next steps ────────────────────────────────────────────────────────────────────────────────

/** @param {IO} io @param {Check[]} checks */
export function printNextSteps(io, checks) {
  const s = styles(io);
  const deps = checks.find((c) => c.id === "deps");
  if (deps && deps.status === "missing") {
    io.out(`\n${s.bold("One thing left:")} install the packages with ${s.cyan("pnpm install")}, then run ${s.cyan("node bin/setup.js")} again.\n`);
    return;
  }
  const orgs = checks.find((c) => c.id === "org")?.orgs ?? [];
  const usable = orgs.filter((o) => o.connected && o.alias);
  const alias = (usable.find((o) => o.isDefault) ?? usable[0])?.alias ?? null;
  /** @param {string} cmd @param {string} why */
  const line = (cmd, why) => io.out(`  ${s.cyan(cmd)}\n      ${s.dim(why)}\n`);
  io.out(`\n${s.bold("You're set. Try:")}\n`);
  line("node bin/run-op.js list", "every operation and what it does");
  if (alias) {
    line(`node bin/run-op.js run profile-org --org ${alias} --pack salescloud`, "read your org's limits and objects (read-only)");
    line(`node bin/run-op.js run plan-demo --org ${alias} --pack salescloud --volume 5`, "plan 5 story-driven deals (local file, nothing written to the org yet)");
  } else {
    io.out(s.dim("  No org yet? Everything up to the load step works offline:\n"));
    line("node bin/run-op.js run profile-org --org standard --synthetic --pack salescloud", "a stand-in profile of a standard org");
    line("node bin/run-op.js run plan-demo --org standard --pack salescloud --volume 5", "plan 5 story-driven deals");
  }
  line("pnpm dev:server   (and in a second terminal)   pnpm dev:web", "the web UI at http://localhost:5173");
  io.out(s.dim(`\n  Re-check any time: node bin/setup.js --check\n`));
}

// ── The flow ──────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ sys: Sys, io: IO, mode: Mode, nonInteractive?: boolean }} o
 * @returns {Promise<{ ok: boolean, checks: Check[] }>}
 */
export async function runWizard({ sys, io, mode, nonInteractive = false }) {
  const s = styles(io);
  io.out(`${s.bold("demo-data-seeder · setup")}\n${s.dim("Checking your machine…")}\n\n`);
  let checks = runChecks(sys);
  printReport(io, checks);

  const node = checks.find((c) => c.id === "node");
  if (node && node.status !== "ok") {
    io.out(`\n${s.red("Node.js needs an upgrade before anything else.")} Install Node 22 or newer from ${s.cyan("https://nodejs.org")}\n`);
    io.out(`(or ${s.cyan("brew install node")} / ${s.cyan("nvm install 22")}), then run ${s.cyan("node bin/setup.js")} again.\n`);
    return { ok: false, checks };
  }

  const todo = checks.filter((c) => c.status !== "ok");
  if (todo.length === 0) {
    io.out(`\n${s.green("Everything's ready.")}\n`);
    printNextSteps(io, checks);
    return { ok: true, checks };
  }

  if (mode === "check") {
    const missing = todo.filter((c) => c.required && c.status === "missing").length;
    io.out(
      `\n${missing ? s.red(`${missing} required item${missing > 1 ? "s" : ""} missing.`) : s.green("Required pieces are in place.")}` +
        ` ${todo.length - missing ? s.dim(`${todo.length - missing} optional item${todo.length - missing > 1 ? "s" : ""} to look at.`) : ""}\n`,
    );
    io.out(
      nonInteractive
        ? `Run ${s.cyan("node bin/setup.js")} in a terminal to fix these step by step, or ${s.cyan("node bin/setup.js --yes")} to install without prompts.\n`
        : `Run ${s.cyan("node bin/setup.js")} to fix these step by step.\n`,
    );
    return { ok: requiredOk(checks), checks };
  }

  /** @param {Check["id"]} id */
  const get = (id) => /** @type {Check} */ (checks.find((c) => c.id === id));
  const sfMissing = get("sf").status !== "ok";
  const steps = /** @type {Array<[string, () => Promise<void>]>} */ ([]);
  /** @type {string[]} */
  let pnpm = ["pnpm"];
  let sfOk = !sfMissing;
  if (get("pnpm").status !== "ok") steps.push(["pnpm", async () => void (pnpm = await stepPnpm(sys, io, mode, get("pnpm")))]);
  if (get("deps").status !== "ok") steps.push(["Packages", () => stepDeps(sys, io, mode, pnpm)]);
  if (sfMissing) steps.push(["Salesforce CLI", async () => void (sfOk = await stepSf(sys, io, mode))]);
  if (get("org").status !== "ok")
    steps.push([
      "Salesforce org",
      async () => {
        if (sfOk) await stepOrg(sys, io, mode, get("org"));
        else io.out(s.dim("  Needs the Salesforce CLI — skipping. Re-run node bin/setup.js after installing it.\n"));
      },
    ]);
  if (get("copy").status !== "ok") steps.push(["AI copy writer", () => stepCopy(sys, io, mode, get("copy"))]);

  for (const [i, [title, run]] of steps.entries()) {
    stepHeader(io, title, i + 1, steps.length);
    await run();
  }

  io.out(`\n${s.bold("Where things stand")}\n`);
  checks = runChecks(sys);
  printReport(io, checks);
  printNextSteps(io, checks);
  return { ok: requiredOk(checks), checks };
}
