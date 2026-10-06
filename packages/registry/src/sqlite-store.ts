// packages/registry/src/sqlite-store.ts
//
// The default RegistryStore: SQLite via Node's built-in `node:sqlite` (zero-dep,
// no native build). On Node <24 the module is behind --experimental-sqlite; package
// scripts set NODE_OPTIONS=--experimental-sqlite (a no-op on 24+). The bundle is
// stored as a JSON column for now — SQLite handles multi-MB text fine, and the
// RegistryStore interface lets us externalize blobs later without touching callers.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Dataset, DatasetFilter, DatasetMeta, LoadRecord, RegistryStore, Stack } from "./types.js";

// `node:sqlite` is a recent built-in (stable on Node 24+, behind --experimental-sqlite
// on 22/23 — set via NODE_OPTIONS in package scripts). Load it through createRequire so
// Vite/vitest's static resolver never tries to bundle the unknown builtin; the type query
// `typeof import("node:sqlite")` is erased at compile time but keeps full type-checking.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT,
  pack TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datasets_pack ON datasets(pack);
CREATE INDEX IF NOT EXISTS idx_datasets_status ON datasets(status);
CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  sink TEXT NOT NULL,
  target TEXT NOT NULL,
  at TEXT NOT NULL,
  inserted INTEGER,
  failed INTEGER,
  report_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_loads_dataset ON loads(dataset_id);
CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY,
  name TEXT,
  dataset_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Default on-disk registry, alongside the other .dataseed artifacts. */
export const DEFAULT_REGISTRY_PATH = join(process.cwd(), ".dataseed", "registry.db");

interface DatasetRow {
  id: string;
  name: string | null;
  pack: string;
  params_json: string;
  status: string;
  provenance_json: string;
  bundle_json: string;
  created_at: string;
  updated_at: string;
}

export class SqliteRegistryStore implements RegistryStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string = DEFAULT_REGISTRY_PATH) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  put(d: Dataset): void {
    this.db
      .prepare(
        `INSERT INTO datasets (id, name, pack, params_json, status, provenance_json, bundle_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           params_json = excluded.params_json,
           status = excluded.status,
           provenance_json = excluded.provenance_json,
           bundle_json = excluded.bundle_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        d.id,
        d.name ?? null,
        d.pack,
        JSON.stringify(d.params),
        d.status,
        JSON.stringify(d.provenance),
        JSON.stringify(d.bundle),
        d.provenance.createdAt,
        d.provenance.updatedAt,
      );
  }

  get(id: string): Dataset | null {
    const row = this.db.prepare(`SELECT * FROM datasets WHERE id = ?`).get(id) as DatasetRow | undefined;
    if (!row) return null;
    return { ...this.rowToMeta(row), bundle: JSON.parse(row.bundle_json) };
  }

  getMeta(id: string): DatasetMeta | null {
    const row = this.db
      .prepare(`SELECT id, name, pack, params_json, status, provenance_json, created_at, updated_at FROM datasets WHERE id = ?`)
      .get(id) as Omit<DatasetRow, "bundle_json"> | undefined;
    return row ? this.rowToMeta(row) : null;
  }

  list(filter: DatasetFilter = {}): DatasetMeta[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.pack) {
      where.push("pack = ?");
      params.push(filter.pack);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql =
      `SELECT id, name, pack, params_json, status, provenance_json, created_at, updated_at FROM datasets` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : ``) +
      // Newest first. Tie-break by INSERTION order (rowid), not the content-hash id — with equal
      // created_at, "latest" must mean most-recently-inserted (what latestDatasetFor resolves), and an
      // id tie-break would order by an arbitrary hash instead of recency.
      ` ORDER BY created_at DESC, rowid DESC`;
    const rows = this.db.prepare(sql).all(...params) as Omit<DatasetRow, "bundle_json">[];
    return rows.map((r) => this.rowToMeta(r));
  }

  remove(id: string): boolean {
    this.db.prepare(`DELETE FROM loads WHERE dataset_id = ?`).run(id);
    const res = this.db.prepare(`DELETE FROM datasets WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  recordLoad(load: LoadRecord): void {
    this.db
      .prepare(`INSERT INTO loads (dataset_id, sink, target, at, inserted, failed, report_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        load.datasetId,
        load.sink,
        load.target,
        load.at,
        load.inserted ?? null,
        load.failed ?? null,
        load.report === undefined ? null : JSON.stringify(load.report),
      );
  }

  loadsFor(id: string): LoadRecord[] {
    const rows = this.db.prepare(`SELECT * FROM loads WHERE dataset_id = ? ORDER BY id DESC`).all(id) as Array<{
      dataset_id: string;
      sink: string;
      target: string;
      at: string;
      inserted: number | null;
      failed: number | null;
      report_json: string | null;
    }>;
    return rows.map((r) => ({
      datasetId: r.dataset_id,
      sink: r.sink,
      target: r.target,
      at: r.at,
      ...(r.inserted !== null ? { inserted: r.inserted } : {}),
      ...(r.failed !== null ? { failed: r.failed } : {}),
      ...(r.report_json !== null ? { report: JSON.parse(r.report_json) } : {}),
    }));
  }

  putStack(s: Stack): void {
    this.db
      .prepare(
        `INSERT INTO stacks (id, name, dataset_ids_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, dataset_ids_json = excluded.dataset_ids_json`,
      )
      .run(s.id, s.name ?? null, JSON.stringify(s.datasetIds), s.createdAt);
  }

  getStack(id: string): Stack | null {
    const row = this.db.prepare(`SELECT * FROM stacks WHERE id = ?`).get(id) as
      | { id: string; name: string | null; dataset_ids_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, ...(row.name !== null ? { name: row.name } : {}), datasetIds: JSON.parse(row.dataset_ids_json), createdAt: row.created_at };
  }

  listStacks(): Stack[] {
    const rows = this.db.prepare(`SELECT * FROM stacks ORDER BY created_at DESC, id`).all() as Array<{
      id: string;
      name: string | null;
      dataset_ids_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, ...(r.name !== null ? { name: r.name } : {}), datasetIds: JSON.parse(r.dataset_ids_json), createdAt: r.created_at }));
  }

  close(): void {
    this.db.close();
  }

  private rowToMeta(row: Omit<DatasetRow, "bundle_json">): DatasetMeta {
    return {
      id: row.id,
      ...(row.name !== null ? { name: row.name } : {}),
      pack: row.pack,
      params: JSON.parse(row.params_json),
      status: row.status as DatasetMeta["status"],
      provenance: JSON.parse(row.provenance_json),
    };
  }
}

/** Open the registry at `path` (defaults to .dataseed/registry.db under the cwd). */
export function openRegistry(path: string = DEFAULT_REGISTRY_PATH): RegistryStore {
  return new SqliteRegistryStore(path);
}
