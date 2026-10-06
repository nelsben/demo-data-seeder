// apps/mcp/src/server.ts
//
// The dataseed MCP server entrypoint (stdio transport) — the composition root that
// wires real deps (the SQLite registry + the salescloud pack) into the tool surface so
// another LLM agent can spawn it and call generate/disperse/etc. The engine never
// imports a pack; this root does.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PackRegistry } from "@dataseed/core";
import { openRegistry, makeDatasetService } from "@dataseed/engine";
import { WarehouseStore } from "@dataseed/warehouse";
import { salescloudPack } from "@dataseed/pack-salescloud";
import { buildMcpServer } from "./tools.js";

const now = () => new Date().toISOString();
const store = openRegistry();
const warehouse = new WarehouseStore(); // the corpus warehouse (.dataseed/warehouse.db) — one connection for the server's life
const packs = new PackRegistry().register(salescloudPack);
const service = makeDatasetService({ packs, store, warehouse, now });
const server = buildMcpServer({ service, packs, now });

const shutdown = () => {
  for (const close of [() => store.close(), () => warehouse.close()]) {
    try {
      close();
    } catch {
      /* already closed */
    }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
