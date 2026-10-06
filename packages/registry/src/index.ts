// packages/registry/src/index.ts
//
// @dataseed/registry — the dataset registry: generated content becomes an
// addressable, queryable, composable artifact (not an overwritten file). The
// substrate beneath reuse, multi-sink dispersement, data stacks, and the
// LLM-callable MCP surface. Default backend is SQLite (node:sqlite, zero-dep);
// the RegistryStore interface keeps Postgres/object-store a swap away.

export * from "./types.js";
export * from "./id.js";
export * from "./dataset.js";
export { SqliteRegistryStore, openRegistry, DEFAULT_REGISTRY_PATH } from "./sqlite-store.js";
