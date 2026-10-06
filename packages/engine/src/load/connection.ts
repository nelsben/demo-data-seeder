// packages/engine/src/load/connection.ts
//
// The org WRITE surface for the loader. We reuse the `sf` CLI's existing auth
// (no separate OAuth dance): `sf org display --verbose --json` hands us an access
// token + instance URL, which we wrap in a jsforce Connection for fast in-process
// inserts (the architecture's end-state choice).
//
// LoadTarget is the INTERFACE the loader consumes, so the pure ref-resolution /
// idempotency logic is unit-testable against a mock — no org required.

import { execFile } from "node:child_process";
import { Connection } from "jsforce";
import { withRetry } from "./retry.js";

export interface AccessInfo {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
}

export interface InsertResult {
  success: boolean;
  id?: string;
  errors: string[];
}

export interface LeadConvertInput {
  leadId: string;
  convertedStatus: string;
  opportunityName?: string;
  doNotCreateOpportunity?: boolean;
  accountId?: string;
}

export interface LeadConvertResult {
  success: boolean;
  leadId: string;
  accountId?: string;
  contactId?: string;
  opportunityId?: string;
  errors: string[];
}

/** The minimal write surface the loader needs (mockable). */
export interface LoadTarget {
  readonly org: string;
  /** Does the sObject exist in this org? */
  exists(sobject: string): Promise<boolean>;
  /** Createable field API names for an sObject (empty set if absent / not describable). */
  createableFields(sobject: string): Promise<Set<string>>;
  /** Insert records (chunked); returns one result per input row, in order. */
  insert(sobject: string, records: Array<Record<string, unknown>>): Promise<InsertResult[]>;
  /** Existing values of `field` among `values` (for additive idempotency). */
  existingValues(sobject: string, field: string, values: string[]): Promise<Set<string>>;
  /** Record Ids where `whereField` ∈ `values` (parent-scoped child lookup for teardown). Empty `values` → []. */
  queryIds(sobject: string, whereField: string, values: string[]): Promise<string[]>;
  /**
   * Multi-field ROWS for existing records where `whereField` ∈ `values` — a generalization of `queryField`
   * (which returns just one column) for composite natural-key dedup. Needed because `idsByCompositeKey`'s
   * generic IN-list quoting can't equality-filter a Date/DateTime column (SOQL date/datetime literals must
   * be unquoted); this instead filters on ONE safely-quoted string column (a parent Id) and returns the
   * other columns unfiltered, so the caller compares the natural key CLIENT-SIDE (the drip op's append-only
   * dedupe — see `drip/dedupe.ts`). OPTIONAL: a target without it makes that dedupe fail-open (no existing
   * rows found → nothing is pre-empted client-side; the org's own insert is still the final word on real
   * duplicates). Empty `values` → [].
   */
  queryRows?(sobject: string, selectFields: readonly string[], whereField: string, values: string[]): Promise<Array<Record<string, unknown>>>;
  /**
   * Values of an ARBITRARY `selectField` where `whereField` ∈ `values` — a generalization of
   * queryIds (which is just `selectField="Id"`). Used by teardown to resolve a ContentVersion's
   * parent ContentDocumentId: a ContentVersion CANNOT be deleted directly (Salesforce returns
   * INSUFFICIENT_ACCESS_OR_READONLY — org-verified), so teardown deletes the parent ContentDocument
   * (whose single version cascades away). OPTIONAL: a target without it skips ContentDocument
   * teardown (leaving the file, exactly the prior — broken — behavior), so it's purely additive.
   * Empty `values` → [].
   */
  queryField?(sobject: string, selectField: string, whereField: string, values: string[]): Promise<string[]>;
  /** The org's standard Pricebook2 Id (pre-exists, one per org) — for the product/line-item chain. null if absent/no access. */
  standardPricebookId(): Promise<string | null>;
  /** Map each existing record's `field` value → its Id (for catalog upsert: reuse an existing Product2/PricebookEntry instead of duplicating it). */
  idsByField(sobject: string, field: string, values: string[]): Promise<Map<string, string>>;
  /**
   * Map each existing record's COMPOSITE key (its `fields` values joined by `\u0000`) → its Id — for
   * catalog upsert on objects whose uniqueness needs more than one field (e.g. a config rule object
   * keyed by Name+adapter class, since the rule Name repeats across adapters). `rows` are the
   * tuples being seeded; the query is scoped to their distinct per-column values (bounded for config-
   * sized sets). Empty `rows` → empty map.
   */
  idsByCompositeKey(sobject: string, fields: readonly string[], rows: string[][]): Promise<Map<string, string>>;
  /** Convert leads into Account/Contact/Opportunity (SOAP convertLead); one result per input, in order. */
  convertLeads(conversions: LeadConvertInput[]): Promise<LeadConvertResult[]>;
  /** Delete records by Id (chunked); one result per Id, in order. */
  deleteRecords(sobject: string, ids: string[]): Promise<InsertResult[]>;
  /**
   * Delete records by Id in chunks the caller controls (the `purge` op pre-chunks at 200 via
   * `purge/plan.ts#chunkIds`, mirroring this file's own CHUNK constant) — WITH an optional hard delete:
   * bypass the Recycle Bin via the Bulk API v1 `hardDelete` operation when the running user holds the
   * "Bulk API Hard Delete" permission; when they don't (or the org otherwise rejects it), fall back to a
   * normal (soft) delete followed by `emptyRecycleBin` (SOAP) so storage still actually frees. A SOFT
   * delete alone is not enough to relieve a maxed-out org: deleted rows sit in the Recycle Bin and
   * continue to count against DataStorageMB until it's emptied or the row ages out after 15 days (see
   * docs/storage-and-purge.md for the citation) — that's why `--hard-delete` exists. OPTIONAL: a target
   * without it means the `purge` op simply can't run `--yes` against it; `deleteRecords` (teardown's) is
   * untouched, this is a purely additive sibling capability.
   */
  deleteRows?(sobject: string, ids: string[], opts?: { hardDelete?: boolean }): Promise<InsertResult[]>;
  /**
   * Update records by Id (chunked); one result per row, in order. Used for post-insert SELF-REFERENTIAL
   * lookups (e.g. Contact.ReportsToId → a sibling inserted in the SAME batch, whose Id isn't known until after
   * the batch inserts). OPTIONAL: a target without it simply skips the self-lookup pass — the field stays unset,
   * exactly the prior behavior — so this is a purely additive capability.
   */
  update?(sobject: string, records: Array<Record<string, unknown>>): Promise<InsertResult[]>;
}

/** The literal placeholder newer `sf` versions substitute for a redacted secret (issue #94). */
const REDACTED_MARKER = "[REDACTED";

/**
 * Pull an access token + instance URL from the authed `sf` CLI. Deliberately NOT
 * `--verbose`: the basic output already carries accessToken/instanceUrl/apiVersion,
 * and --verbose additionally queries the Dev Hub for scratch-org metadata, which
 * flakes ("No information for scratch org … found in Dev Hub") and isn't needed here.
 *
 * #94 (open, https://github.com/nelsben/demo-data-seeder/issues/94): newer `sf` CLI versions redact
 * `accessToken` in `--json` output by default. Without a fix, this function happily resolves the
 * literal string `"[REDACTED…"` as the bearer token, jsforce wraps it into a Connection, and every
 * subsequent callout 401s with no clue why the org "isn't authenticated." Two-layer fix: (1) set
 * `SF_TEMP_SHOW_SECRETS=true` in the child's env — `sf`'s own documented escape hatch that restores
 * the real token in the JSON envelope; (2) defense in depth — even with the env var set, if the
 * token STILL comes back redacted (an sf version where the env var doesn't cover this path, an org
 * config override, etc.) fail fast with a clear diagnosis instead of silently shipping a broken
 * Connection. Never logs the token itself, redacted or real — only that its shape IS the marker.
 */
export function getAccessInfo(org: string, timeoutMs = 30_000): Promise<AccessInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      "sf",
      ["org", "display", "--target-org", org, "--json"],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, SF_TEMP_SHOW_SECRETS: "true" } },
      (err, stdout, stderr) => {
        try {
          const env = JSON.parse(stdout || "{}");
          if (env.status !== 0 || !env.result?.accessToken) {
            return reject(new Error(env.message ?? stderr ?? `sf org display failed for ${org}`));
          }
          const r = env.result;
          if (typeof r.accessToken === "string" && r.accessToken.startsWith(REDACTED_MARKER)) {
            return reject(
              new Error(
                `sf org display for "${org}" returned a REDACTED accessToken (sf issue #94) even with SF_TEMP_SHOW_SECRETS=true set. ` +
                  `Update the sf CLI (\`sf update\`) or check for an org/global config forcing secret redaction, then retry.`,
              ),
            );
          }
          resolve({ accessToken: r.accessToken, instanceUrl: r.instanceUrl, apiVersion: String(r.apiVersion ?? "62.0") });
        } catch {
          reject(new Error(stderr || (err as Error)?.message || "could not parse sf org display"));
        }
      },
    );
  });
}

const CHUNK = 200; // SObject Collections (REST) API ceiling — one HTTP call per 200 rows
const BULK_BATCH = 10_000; // Bulk API v1 batch ceiling — one async batch per 10k rows
export const DEFAULT_BULK_THRESHOLD = 5_000; // ≥ this many rows for one object → use Bulk API (fewer calls, won't blow the daily REST budget)

/**
 * Salesforce API-call cost of inserting `rows` records into ONE object, mirroring `insert()`'s REST/Bulk
 * switch exactly (same CHUNK/BULK_BATCH/threshold constants) — the single source of truth an up-front
 * estimate calls, so it can never drift from what a real load would actually do.
 */
export function estimateObjectInsertCost(rows: number, bulkThreshold: number = DEFAULT_BULK_THRESHOLD): { restApiCalls: number; bulkApiBatches: number } {
  if (rows <= 0) return { restApiCalls: 0, bulkApiBatches: 0 };
  if (rows >= bulkThreshold) return { restApiCalls: 0, bulkApiBatches: Math.ceil(rows / BULK_BATCH) };
  return { restApiCalls: Math.ceil(rows / CHUNK), bulkApiBatches: 0 };
}
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
/** Map a jsforce save-result row → our InsertResult (errors normalized to strings). */
function toInsertResult(r: { success?: boolean; id?: string | null; errors?: unknown }): InsertResult {
  const errs = (r.errors ?? []) as Array<string | { errorCode?: string; statusCode?: string; message?: string }>;
  return {
    success: !!r.success,
    id: r.success ? (r.id ?? undefined) : undefined,
    errors: r.success ? [] : errs.map((e) => (typeof e === "string" ? e : `${e.errorCode ?? e.statusCode ?? "ERROR"}: ${e.message ?? "error"}`)),
  };
}
const soqlEscape = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * Two KNOWN error shapes trigger the error-message fallback (the second net — see `hasBulkApiHardDelete`
 * for the deterministic first one) — anchored separately since they come from unrelated code paths:
 *   1. "Bulk API Hard Delete" — the sf CLI's OWN plugin-data pre-check (`HardDeletePermissionError`,
 *      thrown client-side before the Bulk API is ever called): "You need the Bulk API Hard Delete system
 *      permission…". This repo never goes through that CLI command, so this fragment is speculative
 *      insurance, not something observed here.
 *   2. "requires special user profile permission" — the RAW jsforce Bulk API error this class actually
 *      hits, captured LIVE against dev-frontend (2026-09-05): `name`/`errorCode` both "FeatureNotEnabled",
 *      message "hardDelete operation requires special user profile permission, please contact your system
 *      administrator". Since `deleteRows` calls jsforce `bulk.load(..., "hardDelete")` DIRECTLY (never the
 *      sf CLI), this is the fragment that matters in practice.
 * Any OTHER hardDeleteBulk error matches neither and propagates — never silently masquerading as a
 * permission issue (a transport blip, a genuinely bad Id, etc. should surface, not vanish into an
 * unrelated soft-delete).
 */
const HARD_DELETE_PERMISSION_ERROR = /Bulk API Hard Delete|requires special user profile permission/i;

/** Default LoadTarget over jsforce. */
export class JsforceLoadTarget implements LoadTarget {
  private describeCache = new Map<string, Set<string> | null>(); // null = absent
  /** Tri-state cache for hasBulkApiHardDelete(): undefined = not yet resolved (or unresolvable). */
  private hardDeletePermission?: boolean;

  constructor(
    public readonly org: string,
    private readonly conn: Connection,
    /** Rows-per-object at/above which insert switches from REST collections to the Bulk API. */
    private readonly bulkThreshold: number = DEFAULT_BULK_THRESHOLD,
    /** Progress/diagnostic sink (e.g. an op's ctx.log) — currently used only by deleteRows's hard-delete
     *  precheck/fallback logging. Defaults to a no-op so every existing caller/test stays unaffected. */
    private readonly onProgress: (msg: string) => void = () => {},
  ) {}

  static async create(org: string, opts: { bulkThreshold?: number; onProgress?: (msg: string) => void } = {}): Promise<JsforceLoadTarget> {
    const info = await getAccessInfo(org);
    const conn = new Connection({ instanceUrl: info.instanceUrl, accessToken: info.accessToken, version: info.apiVersion });
    return new JsforceLoadTarget(org, conn, opts.bulkThreshold, opts.onProgress);
  }

  /**
   * Deterministic pre-check: does the running user hold "Bulk API Hard Delete"? Queries the
   * UserPermissionAccess pseudo-object (one row, implicitly scoped to the running user — no WHERE clause)
   * ONCE per instance and caches the result. Returns `undefined` (a real DON'T-KNOW, distinct from a
   * confirmed `false`) when the query itself fails (older API version, no access to the pseudo-object) —
   * the caller then still attempts the Bulk API and lets the error-message fallback (HARD_DELETE_PERMISSION_ERROR,
   * the second net) decide, exactly as if this pre-check didn't exist.
   */
  private async hasBulkApiHardDelete(): Promise<boolean | undefined> {
    if (this.hardDeletePermission !== undefined) return this.hardDeletePermission;
    try {
      const res = await this.conn.query<{ PermissionsBulkApiHardDelete?: boolean }>(`SELECT PermissionsBulkApiHardDelete FROM UserPermissionAccess`);
      this.hardDeletePermission = !!res.records[0]?.PermissionsBulkApiHardDelete;
      return this.hardDeletePermission;
    } catch {
      return undefined;
    }
  }

  /** Soft-delete, then immediately empty the Recycle Bin (SOAP) for the rows that actually soft-deleted, so
   *  storage still frees now rather than waiting on the 15-day retention lapse. Shared by both the
   *  deterministic pre-check's skip and the error-message fallback's second net (deleteRows, below). */
  private async softDeleteAndEmptyRecycleBin(sobject: string, ids: string[]): Promise<InsertResult[]> {
    const soft = await this.deleteRecords(sobject, ids);
    const softDeletedIds = soft.filter((r) => r.success && r.id).map((r) => r.id!);
    if (softDeletedIds.length > 0) {
      try {
        await this.conn.soap.emptyRecycleBin(softDeletedIds);
      } catch {
        // Best-effort, swallowed either way — the rows are at least soft-deleted regardless of whether
        // the bin itself could be emptied (storage still frees on the 15-day Recycle Bin retention lapse
        // if not). This INCLUDES the "invalid record id; no recycle bin entry found" error observed live
        // against a demo org, when a hard-delete elsewhere in the same transaction already purged the row
        // before this call reached it — that's a SUCCESS (the row is gone), not a failure, so treating it
        // identically to any other swallowed error here is correct, not an oversight.
      }
    }
    return soft;
  }

  private async fields(sobject: string): Promise<Set<string> | null> {
    if (this.describeCache.has(sobject)) return this.describeCache.get(sobject)!;
    try {
      const d = await this.conn.sobject(sobject).describe();
      const set = new Set(d.fields.filter((f) => f.createable).map((f) => f.name));
      this.describeCache.set(sobject, set);
      return set;
    } catch {
      this.describeCache.set(sobject, null);
      return null;
    }
  }

  async exists(sobject: string): Promise<boolean> {
    return (await this.fields(sobject)) !== null;
  }

  async createableFields(sobject: string): Promise<Set<string>> {
    return (await this.fields(sobject)) ?? new Set();
  }

  async insert(sobject: string, records: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    if (records.length === 0) return [];
    // Big objects → Bulk API (≈50× fewer API calls, so a 2M-row load doesn't blow the daily REST budget).
    if (records.length >= this.bulkThreshold) return this.insertBulk(sobject, records);
    const out: InsertResult[] = [];
    for (const batch of chunk(records, CHUNK)) {
      // Per-batch retry: a transient rate/transport blip on one batch retries just that batch (no double-insert of prior batches).
      const results = await withRetry(() => this.conn.sobject(sobject).create(batch, { allOrNone: false }));
      const arr = Array.isArray(results) ? results : [results];
      for (const r of arr) out.push(toInsertResult(r));
    }
    return out;
  }

  /** High-volume insert via Bulk API v1 — ordered results (results[i] ↔ records[i]), 10k rows/batch. */
  private async insertBulk(sobject: string, records: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    const out: InsertResult[] = [];
    // jsforce's bulk.load returns an awaitable Batch resolving to ordered save-results; the cast skips its
    // complex CSV/stream overloads for the array-input form we use.
    const load = this.conn.bulk.load.bind(this.conn.bulk) as unknown as (type: string, op: "insert", input: unknown) => Promise<Array<{ id?: string | null; success?: boolean; errors?: unknown }>>;
    for (const batch of chunk(records, BULK_BATCH)) {
      const results = await withRetry(() => load(sobject, "insert", batch));
      for (const r of results) out.push(toInsertResult(r));
    }
    return out;
  }

  async existingValues(sobject: string, field: string, values: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (values.length === 0) return found;
    for (const batch of chunk(values, CHUNK)) {
      const inList = batch.map((v) => `'${soqlEscape(v)}'`).join(",");
      const res = await this.conn.query<Record<string, unknown>>(`SELECT ${field} FROM ${sobject} WHERE ${field} IN (${inList})`);
      for (const rec of res.records) {
        const v = rec[field];
        if (typeof v === "string") found.add(v);
      }
    }
    return found;
  }

  async standardPricebookId(): Promise<string | null> {
    try {
      const res = await this.conn.query<{ Id?: string }>(`SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1`);
      const id = res.records[0]?.Id;
      return typeof id === "string" ? id : null;
    } catch {
      return null; // org has no Pricebook2 / no access → the chain degrades gracefully
    }
  }

  async queryIds(sobject: string, whereField: string, values: string[]): Promise<string[]> {
    return this.queryField(sobject, "Id", whereField, values);
  }

  async queryField(sobject: string, selectField: string, whereField: string, values: string[]): Promise<string[]> {
    const out: string[] = [];
    if (values.length === 0) return out;
    for (const batch of chunk(values, CHUNK)) {
      const inList = batch.map((v) => `'${soqlEscape(v)}'`).join(",");
      const res = await this.conn.query<Record<string, unknown>>(`SELECT ${selectField} FROM ${sobject} WHERE ${whereField} IN (${inList})`);
      for (const rec of res.records) {
        const val = rec[selectField];
        if (typeof val === "string") out.push(val);
      }
    }
    return out;
  }

  async queryRows(sobject: string, selectFields: readonly string[], whereField: string, values: string[]): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    if (values.length === 0) return out;
    const sel = [...new Set([...selectFields, whereField])].join(", "); // whereField itself is often wanted back too
    for (const batch of chunk(values, CHUNK)) {
      const inList = batch.map((v) => `'${soqlEscape(v)}'`).join(",");
      const res = await this.conn.query<Record<string, unknown>>(`SELECT ${sel} FROM ${sobject} WHERE ${whereField} IN (${inList})`);
      out.push(...res.records);
    }
    return out;
  }

  async idsByField(sobject: string, field: string, values: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (values.length === 0) return out;
    for (const batch of chunk(values, CHUNK)) {
      const inList = batch.map((v) => `'${soqlEscape(v)}'`).join(",");
      const res = await this.conn.query<Record<string, unknown>>(`SELECT Id, ${field} FROM ${sobject} WHERE ${field} IN (${inList})`);
      for (const rec of res.records) {
        const key = rec[field];
        if (typeof rec.Id === "string" && (typeof key === "string" || typeof key === "number")) out.set(String(key), rec.Id);
      }
    }
    return out;
  }

  async idsByCompositeKey(sobject: string, fields: readonly string[], rows: string[][]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (rows.length === 0 || fields.length === 0) return out;
    // Scope the query to the seeded tuples: each column's distinct values as an IN-filter, AND-ed.
    // (An over-broad cartesian filter, but bounded — catalog/config sets are tens of rows.) Then build
    // the composite key client-side and keep only org records that match. NUL joins the key parts so a
    // value containing the separator can't collide.
    const clauses: string[] = [];
    for (let ci = 0; ci < fields.length; ci++) {
      const vals = [...new Set(rows.map((r) => r[ci]).filter((v): v is string => v != null))];
      if (vals.length === 0) return out; // a column with no values → no possible match
      clauses.push(`${fields[ci]} IN (${vals.map((v) => `'${soqlEscape(v)}'`).join(",")})`);
    }
    const sel = ["Id", ...fields].join(", ");
    const res = await this.conn.query<Record<string, unknown>>(`SELECT ${sel} FROM ${sobject} WHERE ${clauses.join(" AND ")}`);
    for (const rec of res.records) {
      if (typeof rec.Id !== "string") continue;
      const key = fields.map((f) => String(rec[f] ?? "")).join("\u0000");
      out.set(key, rec.Id);
    }
    return out;
  }

  async convertLeads(conversions: LeadConvertInput[]): Promise<LeadConvertResult[]> {
    if (conversions.length === 0) return [];
    // Resolve the org's actual "converted" lead status (MasterLabel where IsConverted=true) — orgs
    // rename it, and SOAP convertLead rejects a status that isn't a converted one.
    let status = conversions[0]!.convertedStatus;
    try {
      const r = await this.conn.query<{ MasterLabel?: string }>(`SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder LIMIT 1`);
      if (typeof r.records[0]?.MasterLabel === "string") status = r.records[0].MasterLabel;
    } catch {
      /* keep the directive's status */
    }
    // Build each LeadConvert with ONLY defined fields — passing `accountId: undefined` to SOAP
    // serializes as an empty/garbage id and the call fails with "MALFORMED_ID: bad id undefined".
    const input = conversions.map((c) => {
      const o: Record<string, unknown> = {
        leadId: c.leadId,
        convertedStatus: status,
        doNotCreateOpportunity: c.doNotCreateOpportunity ?? false,
        overwriteLeadSource: false,
        sendNotificationEmail: false,
      };
      if (c.opportunityName) o.opportunityName = c.opportunityName;
      if (c.accountId) o.accountId = c.accountId;
      return o;
    });
    const res = await this.conn.soap.convertLead(input);
    const arr = Array.isArray(res) ? res : [res];
    return arr.map((r, i) => ({
      success: !!r.success,
      leadId: conversions[i]!.leadId,
      accountId: (r as { accountId?: string }).accountId,
      contactId: (r as { contactId?: string }).contactId,
      opportunityId: (r as { opportunityId?: string }).opportunityId,
      errors: r.success ? [] : ((r.errors ?? []) as Array<string | { statusCode?: string; message: string }>).map((e) => (typeof e === "string" ? e : `${e.statusCode ?? "ERROR"}: ${e.message}`)),
    }));
  }

  async update(sobject: string, records: Array<Record<string, unknown>>): Promise<InsertResult[]> {
    const out: InsertResult[] = [];
    if (records.length === 0) return out;
    for (const batch of chunk(records, CHUNK)) {
      // Per-batch retry (same as insert): a transient blip retries just this batch. Each row carries its Id
      // (the loader builds `{Id, ...patch}`); jsforce's update types require it, hence the cast.
      const results = await withRetry(() => this.conn.sobject(sobject).update(batch as unknown as Array<{ Id: string }>, { allOrNone: false }));
      const arr = Array.isArray(results) ? results : [results];
      for (const r of arr) out.push(toInsertResult(r));
    }
    return out;
  }

  async deleteRecords(sobject: string, ids: string[]): Promise<InsertResult[]> {
    const out: InsertResult[] = [];
    if (ids.length === 0) return out;
    for (const batch of chunk(ids, CHUNK)) {
      const results = await this.conn.sobject(sobject).destroy(batch, { allOrNone: false });
      const arr = Array.isArray(results) ? results : [results];
      for (const r of arr) {
        out.push({
          success: !!r.success,
          id: r.success ? (r.id ?? undefined) : undefined,
          errors: r.success ? [] : (r.errors ?? []).map((e) => (typeof e === "string" ? e : `${e.errorCode ?? "ERROR"}: ${e.message}`)),
        });
      }
    }
    return out;
  }

  async deleteRows(sobject: string, ids: string[], opts: { hardDelete?: boolean } = {}): Promise<InsertResult[]> {
    if (ids.length === 0) return [];
    if (!opts.hardDelete) return this.deleteRecords(sobject, ids);

    // Deterministic pre-check FIRST: when we already know the running user lacks "Bulk API Hard Delete",
    // skip the guaranteed-to-fail Bulk API round trip entirely and go straight to the same fallback the
    // error-message net below would eventually reach anyway.
    if ((await this.hasBulkApiHardDelete()) === false) {
      this.onProgress(`${sobject}: user lacks Bulk API Hard Delete; soft delete + empty recycle bin`);
      return this.softDeleteAndEmptyRecycleBin(sobject, ids);
    }

    try {
      return await this.hardDeleteBulk(sobject, ids);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!HARD_DELETE_PERMISSION_ERROR.test(message)) throw e; // an unrelated failure — don't mask it behind a silent fallback
      // The pre-check said yes (or couldn't tell) but the Bulk API rejected it anyway — the second net.
      this.onProgress(`${sobject}: Bulk API hardDelete rejected (${message}); soft delete + empty recycle bin`);
      return this.softDeleteAndEmptyRecycleBin(sobject, ids);
    }
  }

  /** High-volume HARD delete via Bulk API v1 (bypasses the Recycle Bin entirely) — same shape as insertBulk. */
  private async hardDeleteBulk(sobject: string, ids: string[]): Promise<InsertResult[]> {
    const out: InsertResult[] = [];
    const load = this.conn.bulk.load.bind(this.conn.bulk) as unknown as (type: string, op: "hardDelete", input: unknown) => Promise<Array<{ id?: string | null; success?: boolean; errors?: unknown }>>;
    for (const batch of chunk(ids, BULK_BATCH)) {
      const results = await withRetry(() => load(sobject, "hardDelete", batch.map((id) => ({ Id: id }))));
      for (const r of results) out.push(toInsertResult(r));
    }
    return out;
  }
}
