// packages/engine/src/introspect/storage-census.ts
//
// Pure row-census math for the `storage` op: turn a { object → count | null } map into
// sorted CensusRow[] with an estimated MB/object (RECORDS_PER_MB — the same platform
// constant `probeLimits`'s record-budget math already uses, i.e. 2 KB/row). `null`
// means the COUNT() query for that object failed/was rejected — the census sorts it
// to the bottom (can't rank a `?`) rather than dropping it, so `storage` still SHOWS
// the object it couldn't count.

import { RECORDS_PER_MB } from "@dataseed/core";

export interface CensusRow {
  object: string;
  /** Row count, or null when the COUNT() query for this object failed/was rejected. */
  count: number | null;
  /** count / RECORDS_PER_MB, or null alongside a null count. */
  estimatedMB: number | null;
}

/** Standard objects the seeder (and the target app) write, always probed alongside every custom object discovered in the org. */
export const STORAGE_STANDARD_OBJECTS: readonly string[] = [
  "Account",
  "Contact",
  "Lead",
  "Opportunity",
  "OpportunityContactRole",
  "Task",
  "Event",
  "EmailMessage",
  "ContentVersion",
  "ContentDocumentLink",
  "Case",
  "CaseComment",
  "Campaign",
  "CampaignMember",
  "Asset",
];

/** How many rows `storage` prints (the biggest N). */
export const CENSUS_TOP_N = 20;

/** Build the sorted census: desc by count, failed (`null`) counts sink to the bottom. */
export function buildCensus(counts: Readonly<Record<string, number | null>>): CensusRow[] {
  const rows: CensusRow[] = Object.entries(counts).map(([object, count]) => ({
    object,
    count,
    estimatedMB: count == null ? null : count / RECORDS_PER_MB,
  }));
  return rows.sort((a, b) => {
    if (a.count == null && b.count == null) return 0;
    if (a.count == null) return 1;
    if (b.count == null) return -1;
    return b.count - a.count;
  });
}

/** The top `n` rows of an already-sorted census (default CENSUS_TOP_N). */
export function topRows(rows: readonly CensusRow[], n: number = CENSUS_TOP_N): CensusRow[] {
  return rows.slice(0, n);
}

/** One human-readable census line — `?` for a failed count/estimate. */
export function formatCensusRow(row: CensusRow): string {
  const count = row.count == null ? "?" : row.count.toLocaleString("en-US");
  const mb = row.estimatedMB == null ? "?" : `${row.estimatedMB.toFixed(2)}MB`;
  return `${row.object}: ${count} row(s) (~${mb})`;
}
