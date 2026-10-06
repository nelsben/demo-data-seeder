// packages/warehouse/src/warehouse-store.ts
//
// WarehouseStore — the corpus record store: per-sObject SQLite tables + a manifest cache index. One DB
// multiplexes many keyed corpora (every row is ds_id-scoped), so corpora are purged precisely without a
// global DROP. Uses Node's built-in node:sqlite (zero-dep), same loader pattern as @dataseed/registry.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BundleRecords, GenericRecord } from "@dataseed/core";
import { MANIFEST_DDL, objectTableDDL, tableName } from "./schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** Default on-disk warehouse, alongside the other .dataseed artifacts. */
export const DEFAULT_WAREHOUSE_PATH = join(process.cwd(), ".dataseed", "warehouse.db");

export interface ManifestInput {
  dsId: string;
  pack: string;
  seed: number;
  paramsHash: string;
  generatorVersion: string;
  cacheKey: string;
  /** The corpus timeline anchor (every generated date is relative to it). Surfaced so time-relative queries
   *  like select_accounts `urgent` (a deal closing soon) can compare CloseDate against it. */
  asOf?: string;
}
export interface ManifestRow extends ManifestInput {
  status: string;
  counts: Record<string, number>;
  totalRecords: number;
  builtAt: string | null;
}

interface RawManifest {
  ds_id: string; pack: string; seed: number; params_hash: string; generator_version: string;
  cache_key: string; status: string; counts_json: string | null; total_records: number | null; built_at: string | null; as_of: string | null;
}

/** The primary parent ref to promote as the join column — the first _refs entry (AccountId, WhatId, …). */
function parentRef(rec: GenericRecord): string | null {
  const refs = rec._refs as Record<string, string> | undefined;
  if (refs) for (const v of Object.values(refs)) return v ?? null;
  return null;
}

export class WarehouseStore {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(path: string = DEFAULT_WAREHOUSE_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL + relaxed sync = far higher bulk-insert throughput; safe for a rebuildable cache (a torn write
    // just means re-materialize). temp_store=MEMORY + a large page cache keep index builds off disk.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;");
    this.db.exec(MANIFEST_DDL);
    // additive migration: as_of column (v24 `urgent` retrieval) — warehouse DBs created before it lack the column.
    try { this.db.exec("ALTER TABLE wh_manifest ADD COLUMN as_of TEXT"); } catch { /* already present */ }
  }

  /** Create the per-object tables for the objects this corpus will write (idempotent). */
  ensureObjects(objects: readonly string[]): void {
    for (const obj of objects) this.db.exec(objectTableDDL(obj));
  }

  /** A ready manifest for this cache key, or undefined — the idempotency check. */
  findByCacheKey(cacheKey: string): ManifestRow | undefined {
    const row = this.db.prepare("SELECT * FROM wh_manifest WHERE cache_key = ? AND status = 'ready'").get(cacheKey) as RawManifest | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** A manifest by ds_id (any status). */
  getManifest(dsId: string): ManifestRow | undefined {
    const row = this.db.prepare("SELECT * FROM wh_manifest WHERE ds_id = ?").get(dsId) as RawManifest | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  listManifests(): ManifestRow[] {
    return (this.db.prepare("SELECT * FROM wh_manifest ORDER BY built_at DESC").all() as unknown as RawManifest[]).map((r) => this.hydrate(r));
  }

  /**
   * EAGER materialize: write a fully-generated bundle into the warehouse for `dsId`, in ONE transaction
   * (a crash rolls back to nothing — no half-built corpus). Replaces any prior rows for this dsId first.
   * Returns per-object counts. (The streaming variant, for 100K, lands in a follow-on.)
   */
  writeBundle(manifest: ManifestInput, records: BundleRecords, builtAt: string): Record<string, number> {
    const objects = Object.keys(records).filter((o) => (records[o]?.length ?? 0) > 0);
    this.ensureObjects(objects);
    const counts: Record<string, number> = {};
    this.db.exec("BEGIN");
    try {
      this.purgeRows(manifest.dsId, objects);
      this.db.prepare("DELETE FROM wh_manifest WHERE ds_id = ?").run(manifest.dsId);
      for (const obj of objects) {
        const rows = records[obj] ?? [];
        const stmt = this.db.prepare(`INSERT INTO ${tableName(obj)} (ds_id, seq, local_ref, parent_ref, name, payload_json) VALUES (?,?,?,?,?,?)`);
        rows.forEach((rec, seq) => {
          stmt.run(manifest.dsId, seq, (rec._ref as string) ?? null, parentRef(rec), (rec.Name as string) ?? null, JSON.stringify(rec));
        });
        counts[obj] = rows.length;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      this.db.prepare(
        `INSERT INTO wh_manifest (ds_id, pack, seed, params_hash, generator_version, cache_key, status, counts_json, total_records, built_at, as_of)
         VALUES (?,?,?,?,?,?, 'ready', ?, ?, ?, ?)`,
      ).run(manifest.dsId, manifest.pack, manifest.seed, manifest.paramsHash, manifest.generatorVersion, manifest.cacheKey, JSON.stringify(counts), total, builtAt, manifest.asOf ?? null);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return counts;
  }

  // ── streaming write (for 100K: never holds the whole corpus in memory) ───────────────────────────
  /**
   * Open a streaming corpus: purge any prior rows for this dsId and write the manifest as 'building'
   * (so a crash mid-stream leaves a non-'ready' row that findByCacheKey skips — no half-corpus served).
   */
  beginStream(manifest: ManifestInput): void {
    this.purge(manifest.dsId);
    this.db.prepare(
      `INSERT INTO wh_manifest (ds_id, pack, seed, params_hash, generator_version, cache_key, status, counts_json, total_records, built_at, as_of)
       VALUES (?,?,?,?,?,?, 'building', '{}', 0, NULL, ?)`,
    ).run(manifest.dsId, manifest.pack, manifest.seed, manifest.paramsHash, manifest.generatorVersion, manifest.cacheKey, manifest.asOf ?? null);
  }

  /**
   * Append one batch of records (one transaction — bounded RSS: only this batch is in memory). `seqBase`
   * is the running per-object next-seq the caller threads across batches so `seq` stays continuous (and
   * ORDER BY seq reproduces emit order across the whole stream). Returns per-object counts appended.
   */
  appendObjects(dsId: string, records: BundleRecords, seqBase: Record<string, number>): Record<string, number> {
    const objects = Object.keys(records).filter((o) => (records[o]?.length ?? 0) > 0);
    this.ensureObjects(objects);
    const appended: Record<string, number> = {};
    this.db.exec("BEGIN");
    try {
      for (const obj of objects) {
        const rows = records[obj] ?? [];
        const base = seqBase[obj] ?? 0;
        const stmt = this.db.prepare(`INSERT INTO ${tableName(obj)} (ds_id, seq, local_ref, parent_ref, name, payload_json) VALUES (?,?,?,?,?,?)`);
        rows.forEach((rec, k) => {
          stmt.run(dsId, base + k, (rec._ref as string) ?? null, parentRef(rec), (rec.Name as string) ?? null, JSON.stringify(rec));
        });
        appended[obj] = rows.length;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return appended;
  }

  /** Close a streaming corpus: flip the manifest to 'ready' with final counts. */
  finishStream(dsId: string, counts: Record<string, number>, builtAt: string): void {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    this.db.prepare("UPDATE wh_manifest SET status='ready', counts_json=?, total_records=?, built_at=? WHERE ds_id=?")
      .run(JSON.stringify(counts), total, builtAt, dsId);
  }

  /** Per-object row counts for a corpus. */
  counts(dsId: string): Record<string, number> {
    return this.getManifest(dsId)?.counts ?? {};
  }

  /** Reconstruct the records for one object (emit order preserved) — the round-trip / stream-load read. */
  readObject(dsId: string, object: string): GenericRecord[] {
    if (!this.tableExists(tableName(object))) return [];
    const rows = this.db.prepare(`SELECT payload_json FROM ${tableName(object)} WHERE ds_id = ? ORDER BY seq`).all(dsId) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as GenericRecord);
  }

  /**
   * Read an object's rows whose `parent_ref` (the promoted first-_refs FK) is one of `parentRefs` — the
   * subtree read that powers a bounded account-rooted SLICE (children of the accounts/opps already chosen).
   * Uses the (ds_id, parent_ref) index; the `IN` list is CHUNKED (≤800/query) to stay under SQLite's bound-
   * variable limit so an arbitrarily large parent set is safe. Order is per-chunk by seq (an object's rows
   * load together, so cross-chunk ordering is immaterial to ref resolution). Empty `parentRefs` → [].
   */
  readChildren(dsId: string, object: string, parentRefs: readonly string[]): GenericRecord[] {
    if (!this.tableExists(tableName(object)) || parentRefs.length === 0) return [];
    const out: GenericRecord[] = [];
    const CHUNK = 800; // + the ds_id bind stays well under the 999 floor of SQLITE_MAX_VARIABLE_NUMBER
    for (let i = 0; i < parentRefs.length; i += CHUNK) {
      const chunk = parentRefs.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT payload_json FROM ${tableName(object)} WHERE ds_id = ? AND parent_ref IN (${placeholders}) ORDER BY seq`)
        .all(dsId, ...chunk) as { payload_json: string }[];
      for (const r of rows) out.push(JSON.parse(r.payload_json) as GenericRecord);
    }
    return out;
  }

  /**
   * Read an object's rows whose `local_ref` (the in-bundle _ref) is one of `refs` — the TARGETED read that
   * powers a FILTERED account-rooted slice (e.g. "only the accounts matching a sentiment query"). Same chunking
   * as readChildren (≤800/query) so an arbitrarily large ref set is safe; order is per-chunk by seq. Empty → [].
   */
  readByRefs(dsId: string, object: string, refs: readonly string[]): GenericRecord[] {
    if (!this.tableExists(tableName(object)) || refs.length === 0) return [];
    const out: GenericRecord[] = [];
    const CHUNK = 800;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const chunk = refs.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT payload_json FROM ${tableName(object)} WHERE ds_id = ? AND local_ref IN (${placeholders}) ORDER BY seq`)
        .all(dsId, ...chunk) as { payload_json: string }[];
      for (const r of rows) out.push(JSON.parse(r.payload_json) as GenericRecord);
    }
    return out;
  }

  /**
   * Account `local_ref`s matching a state PREDICATE (a SQL fragment over wh_Account aliased `a`, optionally
   * EXISTS-joining wh_Opportunity aliased `o`) — powers `select_accounts` (pull accounts by sentiment/state).
   * Returns the first `limit` refs (emit order) plus the TOTAL match count so the caller can report "N of M".
   * `dsId` is bound; `predicate` is built by the trusted service from a CLOSED state enum, never user input.
   */
  selectAccountRefs(dsId: string, predicate: string, limit: number): { refs: string[]; total: number } {
    if (!this.tableExists(tableName("Account"))) return { refs: [], total: 0 };
    const cap = Math.max(0, Math.floor(limit));
    const total = (this.db.prepare(`SELECT count(*) n FROM wh_Account a WHERE a.ds_id = ? AND (${predicate})`).get(dsId) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT a.local_ref ref FROM wh_Account a WHERE a.ds_id = ? AND (${predicate}) ORDER BY a.seq LIMIT ${cap}`)
      .all(dsId) as { ref: string }[];
    return { refs: rows.map((r) => r.ref), total };
  }

  /** A sample of an object's rows (for inspection/demos). */
  sample(dsId: string, object: string, limit = 20): GenericRecord[] {
    if (!this.tableExists(tableName(object))) return [];
    const rows = this.db.prepare(`SELECT payload_json FROM ${tableName(object)} WHERE ds_id = ? ORDER BY seq LIMIT ?`).all(dsId, limit) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as GenericRecord);
  }

  /**
   * A guarded read-only SQL passthrough for EDA/demos — a single SELECT, nothing else. The guard requires a
   * leading SELECT (so a leading `WITH`/CTE — incl. `WITH RECURSIVE`, the only way to author an unbounded
   * row generator — is rejected) and forbids `;` (no statement chaining). `maxRows` caps the RESULT SET by
   * wrapping in `SELECT * FROM (<sql>) LIMIT n`; maxRows is a controlled integer (floored, non-negative) —
   * safe to interpolate; the user SQL stays a bound prepared statement.
   *
   * NB: `maxRows` bounds rows RETURNED (memory), NOT compute/latency — an aggregate or cartesian join still
   * scans fully before the outer LIMIT applies. node:sqlite's DatabaseSync runs SYNCHRONOUSLY with no
   * statement-level interrupt, so a pathological query blocks the caller's thread until it finishes. Fine for
   * the local single-client surface this serves; a multi-tenant/networked exposure would need a worker+deadline.
   */
  query(sql: string, opts: { maxRows?: number } = {}): unknown[] {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (!/^select\b/i.test(trimmed) || /;/.test(trimmed)) throw new Error("warehouse.query accepts a single read-only SELECT statement");
    if (opts.maxRows != null) {
      const cap = Math.max(0, Math.floor(opts.maxRows));
      return this.db.prepare(`SELECT * FROM (${trimmed}) LIMIT ${cap}`).all();
    }
    return this.db.prepare(trimmed).all();
  }

  /** Delete a corpus entirely (all object rows + its manifest). */
  purge(dsId: string): void {
    const m = this.getManifest(dsId);
    const objects = m ? Object.keys(m.counts) : [];
    this.db.exec("BEGIN");
    try {
      this.purgeRows(dsId, objects);
      this.db.prepare("DELETE FROM wh_manifest WHERE ds_id = ?").run(dsId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ── internals ───────────────────────────────────────────────────────────
  private purgeRows(dsId: string, objects: readonly string[]): void {
    for (const obj of objects) if (this.tableExists(tableName(obj))) this.db.prepare(`DELETE FROM ${tableName(obj)} WHERE ds_id = ?`).run(dsId);
  }
  private tableExists(table: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  }
  private hydrate(r: RawManifest): ManifestRow {
    return {
      dsId: r.ds_id, pack: r.pack, seed: r.seed, paramsHash: r.params_hash, generatorVersion: r.generator_version,
      cacheKey: r.cache_key, status: r.status, counts: r.counts_json ? JSON.parse(r.counts_json) : {},
      totalRecords: r.total_records ?? 0, builtAt: r.built_at, ...(r.as_of != null ? { asOf: r.as_of } : {}),
    };
  }
}
