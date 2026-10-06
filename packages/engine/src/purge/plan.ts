// packages/engine/src/purge/plan.ts
//
// Pure purge-plan construction — no org, no fs. Composes the SOQL predicate from
// --where / --older-than-days (AND-ed when both are given), refuses a BARE purge (no
// predicate at all) unless --all is explicit, refuses any DENY-listed sObject outright
// (see deny-list.ts), and chunks Ids into org-safe batches. The impure orchestration
// (org queries, delete, manifest I/O) lives in run.ts; the `purge` op wires both to a
// real org.

import { isDenied } from "./deny-list.js";

export interface PurgePlanInput {
  sobject: string;
  /** Free-form SOQL WHERE-clause fragment (no leading "WHERE"). */
  where?: string;
  /** Convenience predicate: rows whose date field is older than N days (LAST_N_DAYS:N boundary). */
  olderThanDays?: number;
  /** Field the --older-than-days predicate applies to (default CreatedDate). */
  dateField?: string;
  /** Explicit opt-in to purge with NO predicate at all (matches every row of `sobject`). */
  all?: boolean;
}

export type PurgePlanResult =
  | { ok: true; sobject: string; predicate: string; whereClause: string }
  | { ok: false; reason: string };

const DEFAULT_DATE_FIELD = "CreatedDate";

/** Compose the WHERE predicate from --where / --older-than-days. "" (empty) = no predicate — a bare purge, only valid with --all. */
export function buildPredicate(input: Pick<PurgePlanInput, "where" | "olderThanDays" | "dateField">): string {
  const clauses: string[] = [];
  const where = input.where?.trim();
  if (where) clauses.push(`(${where})`);
  if (input.olderThanDays != null) {
    if (!Number.isFinite(input.olderThanDays) || input.olderThanDays < 0) {
      throw new Error(`--older-than-days must be a non-negative number (got ${input.olderThanDays})`);
    }
    clauses.push(`${input.dateField ?? DEFAULT_DATE_FIELD} < LAST_N_DAYS:${Math.floor(input.olderThanDays)}`);
  }
  return clauses.join(" AND ");
}

/** Build the plan, or refuse: DENY-listed object (checked first — wins even over --all), or a bare purge without --all. */
export function buildPurgePlan(input: PurgePlanInput): PurgePlanResult {
  if (isDenied(input.sobject)) {
    return { ok: false, reason: `refusing to purge "${input.sobject}" — on the purge DENY list (config/identity object, never data)` };
  }
  const predicate = buildPredicate(input);
  if (!predicate && !input.all) {
    return { ok: false, reason: `refusing a bare purge of "${input.sobject}" — pass --where or --older-than-days, or --all to explicitly purge every row` };
  }
  return { ok: true, sobject: input.sobject, predicate, whereClause: predicate ? ` WHERE ${predicate}` : "" };
}

/** SObject Collections REST ceiling (mirrors connection.ts's CHUNK) — one delete request per 200 rows. */
export const PURGE_CHUNK_SIZE = 200;

/** Split ids into org-safe batches. */
export function chunkIds(ids: readonly string[], size: number = PURGE_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
