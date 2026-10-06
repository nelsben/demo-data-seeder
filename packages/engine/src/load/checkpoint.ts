// packages/engine/src/load/checkpoint.ts
//
// Load checkpointing. A multi-million-row load can run for an hour+; if it dies on object
// 18/22 (rate limit, expired session, crash), re-running from scratch wastes the whole prior
// effort AND re-inserts everything. A CheckpointStore persists progress after each object — the
// completed objects + the ref→Id map — so a resume SKIPS what's done and continues, parents
// already resolved. (On resume the loader also bypasses additive idempotency, since the checkpoint,
// not org-existence, is the source of truth for what loaded — see loader.ts.)

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface CheckpointState {
  /** sObject API names fully loaded (skipped on resume). */
  completed: string[];
  /** In-bundle `_ref` → inserted Salesforce Id (so a resumed object's child lookups resolve). */
  refs: Record<string, string>;
}

export interface CheckpointStore {
  /** Prior state, or null for a fresh load. */
  load(): CheckpointState | null;
  /** Persist progress (called after each object). */
  save(state: CheckpointState): void;
  /** Remove the checkpoint (called on a clean finish). */
  clear(): void;
}

/** File-backed checkpoint (default location: `.dataseed/checkpoints/<id>.json`). */
export function fileCheckpoint(path: string): CheckpointStore {
  return {
    load() {
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as CheckpointState;
      } catch {
        return null; // a corrupt checkpoint → start fresh rather than crash
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

/** In-memory checkpoint — tests + intra-process resume. */
export function memoryCheckpoint(initial: CheckpointState | null = null): CheckpointStore {
  let state = initial;
  return {
    load: () => state,
    save: (s) => {
      state = s;
    },
    clear: () => {
      state = null;
    },
  };
}
