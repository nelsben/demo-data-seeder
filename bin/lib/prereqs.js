// @ts-check
// bin/lib/prereqs.js — the prerequisite checks behind `node bin/setup.js`.
//
// ZERO dependencies on purpose: this runs on a fresh clone, BEFORE `pnpm install`, so it may use
// Node builtins only. Plain JS with JSDoc types (type-checked through apps/cli's tsconfig).
// Every side effect goes through a `Sys` object so the checks are testable without a real machine.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_NODE_MAJOR = 22;
const API_KEY_PLACEHOLDER = "sk-ant-...";

/**
 * @typedef {{ ok: boolean, missing: boolean, code: number | null, stdout: string, stderr: string }} ExecResult
 * @typedef {{
 *   root: string,
 *   env: Record<string, string | undefined>,
 *   nodeVersion: string,
 *   exec: (cmd: string, args: string[]) => ExecResult,
 *   run: (cmd: string, args: string[]) => { ok: boolean, missing: boolean },
 *   exists: (path: string) => boolean,
 *   read: (path: string) => string | null,
 *   write: (path: string, content: string) => void,
 * }} Sys
 * @typedef {{ alias: string | null, username: string, connected: boolean, isDefault: boolean, isScratch: boolean }} OrgInfo
 * @typedef {"node" | "pnpm" | "deps" | "sf" | "org" | "copy"} CheckId
 * @typedef {"ok" | "warn" | "missing"} Status
 * @typedef {{
 *   id: CheckId, label: string, required: boolean, status: Status, detail: string,
 *   orgs?: OrgInfo[], corepack?: boolean, envFile?: boolean, placeholderKey?: boolean, claude?: boolean,
 * }} Check
 */

/**
 * The real machine. `exec` captures output (for checks); `run` streams to the terminal (for installs).
 * @param {string} root
 * @returns {Sys}
 */
export function realSys(root) {
  const win = process.platform === "win32"; // npm/pnpm/sf/claude are .cmd shims on Windows
  const childEnv = { ...process.env, SF_AUTOUPDATE_DISABLE: "true" }; // never let a version check self-update sf
  return {
    root,
    env: process.env,
    nodeVersion: process.versions.node,
    exec(cmd, args) {
      const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: win, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, env: childEnv });
      const missing = isMissing(r.error, r.status, r.stderr, win);
      return { ok: !r.error && r.status === 0, missing, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    run(cmd, args) {
      const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: win, env: childEnv });
      return { ok: !r.error && r.status === 0, missing: isMissing(r.error, r.status, "", win) };
    },
    exists: existsSync,
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write(path, content) {
      writeFileSync(path, content);
    },
  };
}

/**
 * @param {Error | undefined} error
 * @param {number | null} status
 * @param {string | null | undefined} stderr
 * @param {boolean} win
 */
function isMissing(error, status, stderr, win) {
  if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return true;
  return win && status === 1 && /is not recognized as an internal or external command/i.test(stderr ?? "");
}

// ── Individual checks ─────────────────────────────────────────────────────────────────────────

/** @param {Sys} sys @returns {Check} */
export function checkNode(sys) {
  const major = Number.parseInt(sys.nodeVersion.split(".")[0] ?? "0", 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    id: "node",
    label: "Node.js",
    required: true,
    status: ok ? "ok" : "missing",
    detail: ok ? `v${sys.nodeVersion}` : `v${sys.nodeVersion} is too old — version ${MIN_NODE_MAJOR} or newer is required`,
  };
}

/** The pnpm version this repo pins in package.json ("packageManager": "pnpm@x.y.z"). @param {Sys} sys */
export function pinnedPnpmVersion(sys) {
  const pkg = sys.read(join(sys.root, "package.json"));
  const m = pkg ? /"packageManager"\s*:\s*"pnpm@([^"+]+)/.exec(pkg) : null;
  return m?.[1] ?? "latest";
}

/** @param {Sys} sys @returns {Check} */
export function checkPnpm(sys) {
  const r = sys.exec("pnpm", ["--version"]);
  if (r.ok) return { id: "pnpm", label: "pnpm", required: true, status: "ok", detail: r.stdout.trim() };
  const corepack = sys.exec("corepack", ["--version"]).ok;
  return {
    id: "pnpm",
    label: "pnpm",
    required: true,
    status: "missing",
    detail: "not installed — the package manager this repo uses",
    corepack,
  };
}

/**
 * Are the repo's packages installed, and installed from the CURRENT lockfile? pnpm mirrors the lockfile
 * it installed from into node_modules/.pnpm/lock.yaml, so a mismatch means `git pull` brought new deps.
 * Filesystem-only (no child processes) — the bin/ entrypoints call this on every run.
 * @param {string} root
 * @param {{ exists: (p: string) => boolean, read: (p: string) => string | null }} fs
 * @returns {"ok" | "missing" | "stale"}
 */
export function depsState(root, fs) {
  const nm = join(root, "node_modules");
  const markers = [join(nm, ".modules.yaml"), join(nm, "tsx", "package.json"), join(nm, "dotenv", "package.json")];
  if (!markers.every((p) => fs.exists(p))) return "missing";
  const lock = fs.read(join(root, "pnpm-lock.yaml"));
  const installed = fs.read(join(nm, ".pnpm", "lock.yaml"));
  return lock !== null && lock === installed ? "ok" : "stale";
}

/** @param {Sys} sys @returns {Check} */
export function checkDeps(sys) {
  const state = depsState(sys.root, sys);
  const detail = { ok: "installed", missing: "not installed — nothing in this repo runs without them", stale: "out of date — the lockfile changed since the last install" }[state];
  return { id: "deps", label: "Packages", required: true, status: state === "ok" ? "ok" : state === "stale" ? "warn" : "missing", detail };
}

/** @param {Sys} sys @returns {Check} */
export function checkSf(sys) {
  const r = sys.exec("sf", ["--version"]);
  if (r.ok) {
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const version = /@salesforce\/cli\/(\S+)/.exec(first)?.[1] ?? first;
    return { id: "sf", label: "Salesforce CLI", required: false, status: "ok", detail: version };
  }
  return {
    id: "sf",
    label: "Salesforce CLI",
    required: false,
    status: "missing",
    detail: "not installed — needed to connect to an org (offline generation works without it)",
  };
}

/**
 * Parse `sf org list --json` into the few fields the wizard shows. Orgs repeat across the envelope's
 * categories, so dedupe by username. Tokens and URLs in the envelope are never copied out.
 * @param {string} json
 * @returns {OrgInfo[]}
 */
export function parseOrgList(json) {
  /** @type {any} */
  let env;
  try {
    env = JSON.parse(json);
  } catch {
    return [];
  }
  const result = env?.result;
  if (!result || typeof result !== "object") return [];
  /** @type {Map<string, OrgInfo>} */
  const byUser = new Map();
  for (const list of Object.values(result)) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (!o || typeof o.username !== "string") continue;
      const connected = o.connectedStatus === "Connected" || (o.isScratch === true && o.status === "Active");
      const prev = byUser.get(o.username);
      byUser.set(o.username, {
        alias: typeof o.alias === "string" && o.alias ? o.alias : (prev?.alias ?? null),
        username: o.username,
        connected: connected || (prev?.connected ?? false),
        isDefault: o.isDefaultUsername === true || (prev?.isDefault ?? false),
        isScratch: o.isScratch === true,
      });
    }
  }
  return [...byUser.values()];
}

/** @param {Sys} sys @param {boolean} sfOk @returns {Check} */
export function checkOrg(sys, sfOk) {
  const base = { id: /** @type {const} */ ("org"), label: "Salesforce org", required: false };
  if (!sfOk) return { ...base, status: "missing", detail: "needs the Salesforce CLI first", orgs: [] };
  const r = sys.exec("sf", ["org", "list", "--json"]);
  const orgs = parseOrgList(r.stdout);
  const usable = orgs.filter((o) => o.connected && o.alias);
  if (usable.length) {
    const names = usable.map((o) => o.alias);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` (+${names.length - 3} more)` : "");
    return { ...base, status: "ok", detail: `logged in: ${shown}`, orgs };
  }
  if (orgs.length) return { ...base, status: "warn", detail: `${orgs.length} known but none connected with an alias — log in again`, orgs };
  return { ...base, status: "missing", detail: "none logged in yet", orgs };
}

/**
 * Read ANTHROPIC_API_KEY from the environment or the repo-root .env (simple KEY=VALUE parse, no dotenv).
 * @param {Sys} sys
 * @returns {{ envFile: boolean, key: string | null }}
 */
export function readApiKey(sys) {
  const text = sys.read(join(sys.root, ".env"));
  let key = sys.env.ANTHROPIC_API_KEY?.trim() || null;
  if (!key && text) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) key = (m[1] ?? "").trim().replace(/^["']|["']$/g, "") || null;
    }
  }
  return { envFile: text !== null, key };
}

/** @param {Sys} sys @returns {Check} */
export function checkCopy(sys) {
  const claude = sys.exec("claude", ["--version"]);
  const { envFile, key } = readApiKey(sys);
  const placeholderKey = key === API_KEY_PLACEHOLDER;
  const realKey = !!key && !placeholderKey;
  const base = { id: /** @type {const} */ ("copy"), label: "AI copy writer", required: false, envFile, placeholderKey, claude: claude.ok };
  if (placeholderKey) {
    return { ...base, status: "warn", detail: "ANTHROPIC_API_KEY in .env is still the template placeholder — set a real key or comment it out" };
  }
  const parts = [];
  if (claude.ok) parts.push(`claude CLI ${claude.stdout.trim().split(" ")[0] ?? ""} (your Claude subscription)`);
  if (realKey) parts.push("ANTHROPIC_API_KEY set");
  if (parts.length) return { ...base, status: "ok", detail: parts.join(" + ") };
  return {
    ...base,
    status: "warn",
    detail: "no claude CLI or API key — emails/transcripts fall back to built-in templates (less realistic)",
  };
}

/**
 * Every check, in the order the wizard fixes them (each later step can depend on an earlier one).
 * @param {Sys} sys
 * @returns {Check[]}
 */
export function runChecks(sys) {
  const node = checkNode(sys);
  const deps = checkDeps(sys);
  let pnpm = checkPnpm(sys);
  // pnpm is only REQUIRED to get the packages in. Once they're installed (e.g. via a one-off npx pnpm
  // after a global install failed), the repo runs fine; pnpm is then just needed for `pnpm dev:*` / updates.
  if (pnpm.status !== "ok" && deps.status === "ok") {
    pnpm = { ...pnpm, required: false, status: "warn", detail: "not installed globally — needed for `pnpm dev:*` and future installs" };
  }
  const sf = checkSf(sys);
  const org = checkOrg(sys, sf.status === "ok");
  const copy = checkCopy(sys);
  return [node, pnpm, deps, sf, org, copy];
}
