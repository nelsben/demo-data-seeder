// @dataseed/warehouse — the deterministic, rebuildable corpus warehouse.
// A SQLite store with one table per sObject (queryable, joinable), keyed as a content-addressed cache of
// (pack, byte-determining params, generator version). Materialize once, query with SQL, stream-load later.
export * from "./schema.js";
export * from "./cache-key.js";
export * from "./warehouse-store.js";
