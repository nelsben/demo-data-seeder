// A fake machine for the setup wizard: binaries that exist (and what they print), files on disk, and a
// record of every install the wizard runs. Lets every branch of bin/lib/wizard.js run in milliseconds
// without touching the real PATH, network, or global npm prefix.

import { join } from "node:path";
import type { ExecResult, Sys } from "../../../bin/lib/prereqs.js";
import type { IO } from "../../../bin/lib/wizard.js";

export const ROOT = "/repo";
export const at = (rel: string) => join(ROOT, rel);

type Bin = (args: string[]) => Partial<ExecResult>;

export interface Machine {
  sys: Sys;
  bins: Record<string, Bin>;
  files: Record<string, string>;
  runs: string[];
}

/** Files a successfully-installed checkout has. */
export const INSTALLED: Record<string, string> = {
  "node_modules/.modules.yaml": "x",
  "node_modules/tsx/package.json": "{}",
  "node_modules/dotenv/package.json": "{}",
  "node_modules/.pnpm/lock.yaml": "lock-v1",
};

export function machine(o: {
  node?: string;
  bins?: Record<string, Bin>;
  files?: Record<string, string>;
  env?: Record<string, string>;
  /** Simulate an install: return false to make it fail; mutate `m` to change the machine. */
  onRun?: (cmd: string, args: string[], m: Machine) => boolean;
} = {}): Machine {
  const files: Record<string, string> = {
    "package.json": '{ "name": "demo-data-seeder", "packageManager": "pnpm@11.7.0" }',
    "pnpm-lock.yaml": "lock-v1",
    ".env.example": "# Anthropic API key\n# ANTHROPIC_API_KEY=sk-ant-...\n",
    ...o.files,
  };
  const abs = Object.fromEntries(Object.entries(files).map(([k, v]) => [at(k), v]));
  const m: Machine = {
    bins: { ...o.bins },
    files: abs,
    runs: [],
    sys: undefined as unknown as Sys,
  };
  m.sys = {
    root: ROOT,
    env: o.env ?? {},
    nodeVersion: o.node ?? "24.1.0",
    exec(cmd, args) {
      const bin = m.bins[cmd];
      if (!bin) return { ok: false, missing: true, code: null, stdout: "", stderr: "" };
      return { ok: true, missing: false, code: 0, stdout: "", stderr: "", ...bin(args) };
    },
    run(cmd, args) {
      m.runs.push([cmd, ...args].join(" "));
      if (!m.bins[cmd]) return { ok: false, missing: true };
      return { ok: o.onRun ? o.onRun(cmd, args, m) : true, missing: false };
    },
    exists: (p) => p in m.files,
    read: (p) => m.files[p] ?? null,
    write: (p, c) => void (m.files[p] = c),
  };
  return m;
}

/** Mark the repo's packages installed (what a successful `pnpm install` does). */
export function install(m: Machine) {
  for (const [k, v] of Object.entries(INSTALLED)) m.files[at(k)] = v;
}

/** `sf org list --json` — with the secrets sf really includes, to prove they never leak out. */
export function orgListJson(orgs: Array<Record<string, unknown>>) {
  return JSON.stringify({
    status: 0,
    result: {
      nonScratchOrgs: orgs.filter((o) => !o.isScratch).map((o) => ({ accessToken: "00D!SECRET-TOKEN", instanceUrl: "https://x.my.salesforce.com", ...o })),
      scratchOrgs: orgs.filter((o) => o.isScratch).map((o) => ({ accessToken: "00D!SECRET-TOKEN", ...o })),
      other: orgs.filter((o) => !o.isScratch).map((o) => ({ accessToken: "00D!SECRET-TOKEN", ...o })), // sf repeats orgs across categories
    },
  });
}

/** A terminal that answers prompts from a script and records everything printed. */
export function scriptedIO(answers: string[] = []) {
  const queue = [...answers];
  const prompts: string[] = [];
  let printed = "";
  const io: IO = {
    out: (s) => void (printed += s),
    ask: async (q) => {
      prompts.push(q);
      printed += q + "\n";
      const a = queue.shift();
      if (a === undefined) throw new Error(`unexpected prompt: ${q}`);
      return a;
    },
    color: false,
    close: () => {},
  };
  return { io, prompts, output: () => printed, remaining: () => queue.length };
}

/** Binaries for a machine where everything optional is already present. */
export const READY_BINS: Record<string, Bin> = {
  pnpm: () => ({ stdout: "11.7.0\n" }),
  sf: (args) =>
    args[0] === "--version"
      ? { stdout: "@salesforce/cli/2.152.14 darwin-arm64 node-v24.2.0\n" }
      : { stdout: orgListJson([{ alias: "demo-org", username: "rep@acme.example", connectedStatus: "Connected", isDefaultUsername: true }]) },
  claude: () => ({ stdout: "2.1.287 (Claude Code)\n" }),
};
