// packages/registry/src/types.ts
//
// The dataset-registry contracts. A "dataset" is the unit of generated content —
// a first-class, ADDRESSABLE artifact (id + the request that made it + the bundle +
// provenance + where it was dispersed), not an overwritten file. This is the
// substrate that makes generated content reusable, composable into stacks, and
// referenceable by a calling LLM (which gets back a dataset id, not a blob).

import type { NarrativeBundle, ScopeParams } from "@dataseed/core";

/** Lifecycle of a dataset's content. `planned` = records only; `filled` = LLM copy generated. */
export type DatasetStatus = "planned" | "filled";

/** How/when/by-what a dataset was produced. Queryable metadata — never the content itself. */
export interface DatasetProvenance {
  /** Engine/generator version that produced the bundle. */
  engineVersion: string;
  /** ISO timestamp the dataset was first generated. */
  createdAt: string;
  /** ISO timestamp of the last mutation (re-plan, fill, rename). */
  updatedAt: string;
  /** ISO timestamp copy was generated (set on the planned→filled transition). */
  filledAt?: string;
  /** Copy provider (e.g. "claude-code", "anthropic", "static"). */
  llmProvider?: string;
  /** Copy model id. */
  llmModel?: string;
  /** USD spent generating copy for this dataset. */
  llmCostUsd?: number;
  /** Record counts by sobject, for at-a-glance sizing without loading the bundle. */
  recordCounts?: Record<string, number>;
}

/** The addressable metadata of a generated dataset — everything but the bundle blob. */
export interface DatasetMeta {
  /** Stable, content-addressed id: `ds_<hash>` of (pack + canonical params). */
  id: string;
  /** Optional human label (distinguishes intent when params collide). */
  name?: string;
  /** Target pack that generated it (e.g. "salescloud"). */
  pack: string;
  /** The generation request that produced it (scope, seed, scenarioMix, volume, …). */
  params: ScopeParams;
  status: DatasetStatus;
  provenance: DatasetProvenance;
}

/** A full dataset: metadata + the generated content bundle. */
export interface Dataset extends DatasetMeta {
  bundle: NarrativeBundle;
}

/** One dispersal of a dataset to a sink/target — the load-history entry. */
export interface LoadRecord {
  datasetId: string;
  /** Sink id the dataset was dispersed through ("salesforce" | "file" | "return" | …). */
  sink: string;
  /** Where it landed: an org alias, a file path, etc. */
  target: string;
  /** ISO timestamp of the dispersal. */
  at: string;
  inserted?: number;
  failed?: number;
  /** The full sink report (shape is sink-specific). */
  report?: unknown;
}

/** A data stack — an ordered composition of datasets, loaded in array order (layers). */
export interface Stack {
  id: string;
  name?: string;
  /** Dataset ids in load order. */
  datasetIds: string[];
  createdAt: string;
}

/** Filter for listing datasets. */
export interface DatasetFilter {
  pack?: string;
  status?: DatasetStatus;
}

/**
 * Pluggable persistence for the dataset registry. The SQLite impl is the default
 * (local-first, zero-ops); the interface keeps the door open to a Postgres /
 * object-store backend for a hosted, multi-tenant service without touching callers.
 */
export interface RegistryStore {
  /** Insert or replace a dataset (by id). */
  put(dataset: Dataset): void;
  /** Full dataset (incl. bundle), or null if absent. */
  get(id: string): Dataset | null;
  /** Metadata only (no bundle blob decode) — for cheap listing/inspection. */
  getMeta(id: string): DatasetMeta | null;
  /** Metadata for all datasets matching the filter, newest first. */
  list(filter?: DatasetFilter): DatasetMeta[];
  /** Delete a dataset + its load-history. Returns whether a row was removed. */
  remove(id: string): boolean;
  /** Append a dispersal to a dataset's load-history. */
  recordLoad(load: LoadRecord): void;
  /** A dataset's dispersals, newest first. */
  loadsFor(id: string): LoadRecord[];
  /** Insert or replace a stack (by id). */
  putStack(stack: Stack): void;
  getStack(id: string): Stack | null;
  listStacks(): Stack[];
  /** Release the underlying handle. */
  close(): void;
}
