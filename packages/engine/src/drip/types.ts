// packages/engine/src/drip/types.ts
//
// Shared shapes for the drip op (SEEDER-DRIP). Kept in one place so select/beats/dedupe/manifest
// agree on vocabulary without importing each other.

/** The three standard objects the drip appends to an existing deal — no custom objects, matches the
 *  rest of this repo's "standard Sales Cloud only" scope. */
export type DripObject = "EmailMessage" | "Task" | "ContentVersion";

/** One open deal the drip could pick for today, as read from the org (candidates.ts) — deliberately
 *  a plain data shape (not a LoadTarget call) so `select.ts` stays pure and unit-testable. */
export interface DripCandidate {
  oppId: string;
  oppName: string;
  accountId: string;
  accountName: string;
  /** The deal's narrative arc/scenario id (e.g. "at-risk-budget"), best-effort resolved from the
   *  registry/dossier cache; "unknown" when no origin story is recoverable. */
  arc: string;
  stageName?: string;
  ownerId?: string;
  ownerName?: string;
  /** ISO date of the deal's most recent observed interaction (candidates.ts's best-effort proxy). */
  lastInteractionDate: string;
}
