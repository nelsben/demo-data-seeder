// packages/engine/src/sinks/types.ts
//
// A Sink is a dispersal destination — WHERE/HOW a dataset's bundle lands. It is
// orthogonal to the Pack (WHAT is generated): one generated dataset disperses to
// many sinks (a live org, a JSON file, or straight back to a calling agent). This
// "generate once, disperse many" split is the spine of the reusable, LLM-callable
// service.

import type { Dataset } from "@dataseed/registry";

/** A normalized dispersal outcome, uniform across every sink. */
export interface DisperseReport {
  /** Sink id the dataset went through ("salesforce" | "file" | "return"). */
  sink: string;
  /** Where it landed: an org alias, a file path, "(caller)". */
  target: string;
  ok: boolean;
  inserted: number;
  failed: number;
  skipped: number;
  /** One-line human summary. */
  summary: string;
  /** Raw sink-specific report: a LoadReport (salesforce), file info (file), the bundle (return). */
  detail?: unknown;
}

export interface DisperseOptions {
  /** Destination: org alias (salesforce), file path (file); ignored by return. */
  target?: string;
  /** Disable additive-idempotency skip (salesforce only). */
  force?: boolean;
  /**
   * Cascade control (salesforce). "auto" (default) loads everything — the pack's input streams fire the
   * target's pipeline. "off" drops the pack's cascadeObjects so the load lands structurally with ZERO
   * async jobs / LLM calls (fill the org without firing synthesis).
   */
  cascade?: "auto" | "off";
  /** salesforce: checkpoint file path — resume a partially-loaded dataset instead of re-running from object 1. */
  checkpoint?: string;
  /** salesforce: rows-per-object at/above which the loader switches to the Bulk API (default 5000). */
  bulkThreshold?: number;
  onProgress?: (msg: string) => void;
}

/** A dispersal destination. Stateless; constructed with whatever deps it needs (pack resolver, connector). */
export interface Sink {
  id: string;
  label: string;
  disperse(dataset: Dataset, opts: DisperseOptions): Promise<DisperseReport>;
}

/** Total records across all objects in a dataset's bundle. */
export function totalRecords(dataset: Dataset): number {
  return Object.values(dataset.bundle.records).reduce((a, rows) => a + (rows?.length ?? 0), 0);
}
