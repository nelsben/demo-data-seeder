#!/usr/bin/env node
// =============================================================================
// dataseed-mcp.js — the MCP server ENTRYPOINT for the dataseed app.
//
// Launch this from another agent's MCP client config (command: node, args:
// [".../bin/dataseed-mcp.js"]). A thin shim like run-op.js (same dir): re-exec with the
// node:sqlite flag on Node <24, register tsx's ESM loader (no build step), then
// import the stdio server (apps/mcp/src/server.ts).
// =============================================================================

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDeps } from "./lib/deps-guard.js";

const selfPath = fileURLToPath(import.meta.url);
const here = join(dirname(selfPath), ".."); // repo root (this shim lives in bin/)

// Never interactive: stdout is the MCP protocol channel. Missing packages → one instruction on stderr, exit 1.
await ensureDeps({ root: here, command: "node bin/dataseed-mcp.js", interactive: false, exitCode: 1 });

// node:sqlite (the registry backend) needs --experimental-sqlite on Node 22/23; re-exec once.
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
dotenv.config({ path: join(here, ".env") });
register();
await import(join(here, "apps", "mcp", "src", "server.ts"));
