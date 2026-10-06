#!/usr/bin/env node
// =============================================================================
// dataseed-mcp.js — the MCP server ENTRYPOINT for the dataseed app.
//
// Launch this from another agent's MCP client config (command: node, args:
// [".../dataseed-mcp.js"]). A thin shim like run-op.js: re-exec with the
// node:sqlite flag on Node <24, register tsx's ESM loader (no build step), then
// import the stdio server (apps/mcp/src/server.ts).
// =============================================================================

import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);

// node:sqlite (the registry backend) needs --experimental-sqlite on Node 22/23; re-exec once.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24 && !(process.env.NODE_OPTIONS ?? "").includes("experimental-sqlite")) {
  const r = spawnSync(process.execPath, [selfPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim() },
  });
  process.exit(r.status ?? 0);
}

const here = dirname(selfPath);
dotenv.config({ path: join(here, ".env") });
register();
await import(join(here, "apps", "mcp", "src", "server.ts"));
