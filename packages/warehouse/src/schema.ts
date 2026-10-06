// packages/warehouse/src/schema.ts
//
// DDL for the corpus warehouse: a manifest (cache index) + one table per sObject, mirroring the
// Salesforce object graph so the corpus is plain-SQL queryable. Tables are HYBRID: a small indexed spine
// (the local ref graph + a couple of promoted columns for joins/filters) plus a payload_json holding the
// full record. The full record (incl. _ref/_refs/_softRefs/_meta) is the source of truth — the promoted
// columns are derived, redundant copies that make the warehouse queryable without json_extract gymnastics.
//
// Deliberately NO separate edge table: storing every _refs/_softRefs edge as its own row would make the
// edge rows OUTNUMBER the data rows (~3-5M at 100K) and dominate write time. Refs ride inline in
// payload_json; the ONE parent FK worth joining on is promoted to the `parent_ref` column.

/** A SQLite-safe table name for an sObject API name (My_Object__c → wh_My_Object__c). */
export function tableName(apiName: string): string {
  return "wh_" + apiName.replace(/[^A-Za-z0-9]/g, "_");
}

export const MANIFEST_DDL = `
CREATE TABLE IF NOT EXISTS wh_manifest (
  ds_id             TEXT PRIMARY KEY,        -- registry datasetId, links the corpus to its registry row
  pack              TEXT NOT NULL,
  seed              INTEGER NOT NULL,
  params_hash       TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  cache_key         TEXT NOT NULL UNIQUE,    -- params + generator version: re-materialize iff this changes
  status            TEXT NOT NULL,           -- 'building' | 'ready'
  counts_json       TEXT,                    -- per-object row counts
  total_records     INTEGER,
  built_at          TEXT,
  as_of             TEXT                      -- the corpus timeline anchor (for time-relative queries, e.g. select_accounts urgent)
);
CREATE INDEX IF NOT EXISTS idx_wh_manifest_cache ON wh_manifest(cache_key);
`;

/** Per-sObject table DDL. Standard columns only — promoted analytics columns can be json_extract'd. */
export function objectTableDDL(apiName: string): string {
  const t = tableName(apiName);
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  ds_id        TEXT NOT NULL,      -- which corpus this row belongs to
  seq          INTEGER NOT NULL,   -- emit ordinal within (ds_id) for this object — ORDER BY reproduces order
  local_ref    TEXT,               -- the in-bundle _ref (NULL for ref-less leaves like OCR)
  parent_ref   TEXT,               -- the primary parent's local_ref (first _refs entry) — the join key
  name         TEXT,               -- record.Name when present — the human-readable handle
  payload_json TEXT NOT NULL       -- the full record (source of truth): fields + _ref/_refs/_softRefs/_meta
);
CREATE INDEX IF NOT EXISTS idx_${t}_ds ON ${t}(ds_id);
CREATE INDEX IF NOT EXISTS idx_${t}_parent ON ${t}(ds_id, parent_ref);
CREATE INDEX IF NOT EXISTS idx_${t}_local ON ${t}(ds_id, local_ref);
`;
}
