// packages/registry/src/id.ts
//
// Content-addressed ids. Equal generation requests get the SAME dataset id, so
// re-planning is idempotent (it updates the same dataset) and a caller can address
// a dataset purely by the request that would produce it. Stacks get an id derived
// from their member ids + a salt so distinct compositions don't collide.

import { createHash } from "node:crypto";
import type { ScopeParams } from "@dataseed/core";

/** Stable JSON with recursively sorted object keys, so semantically-equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

// Params fields excluded from dataset IDENTITY — volatile/incidental, not part of the logical
// request. `asOf` is the timeline anchor (defaults to wall-clock now): re-planning the same knobs
// at a later asOf REFRESHES the same dataset, not a new one, so excluding it keeps re-plan
// idempotent (matches the old flat-file overwrite). The latest asOf still wins in stored params.
const NON_IDENTITY_PARAM_FIELDS = ["asOf"] as const;

/**
 * `ds_<12 hex>` of (pack + canonical identity-params). Deterministic: the same logical
 * request gives the same id (re-planning updates the same dataset). `name` and the volatile
 * fields above are intentionally NOT hashed — they are not part of identity.
 */
export function datasetId(pack: string, params: ScopeParams): string {
  const identity: Record<string, unknown> = { ...params };
  for (const f of NON_IDENTITY_PARAM_FIELDS) delete identity[f];
  const h = createHash("sha256").update(pack).update(" ").update(canonicalJson(identity)).digest("hex");
  return "ds_" + h.slice(0, 12);
}

/**
 * `ds_<12 hex>` for an EXTERNALLY-AUTHORED bundle (an agent's own static data — no ScopeParams).
 * Content-addressed on the records, with an "import" salt so it can never collide with a generated
 * dataset's id. Re-registering the same records yields the same id (idempotent ingest).
 */
export function datasetIdFromBundle(pack: string, records: unknown): string {
  const h = createHash("sha256").update(pack).update(" import ").update(canonicalJson(records)).digest("hex");
  return "ds_" + h.slice(0, 12);
}

/** `stk_<12 hex>` of the ordered member ids (+ optional name salt). Order matters — stacks are layered. */
export function stackId(datasetIds: readonly string[], name?: string): string {
  const h = createHash("sha256").update(datasetIds.join(",")).update(" ").update(name ?? "").digest("hex");
  return "stk_" + h.slice(0, 12);
}
