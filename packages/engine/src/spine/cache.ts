// packages/engine/src/spine/cache.ts
//
// The dossier cache (Phase 4B). Ben's locked decision: an LLM-authored dossier is CACHED by
// (seed, account) and that cache IS the determinism contract — a re-run reads the cached draft
// instead of re-authoring (free + byte-stable), and only a cache miss spends a token. Mirrors the
// load checkpoint store: a tiny injectable interface with a file-backed impl + an in-memory one for tests.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DossierDraft } from "@dataseed/core";

export interface DossierCache {
  /** A prior authored draft for this deal key, or null on a miss. */
  get(key: string): DossierDraft | null;
  /** Persist an authored draft so the next run reuses it. */
  set(key: string, draft: DossierDraft): void;
}

/** Slugify a deal key into a safe filename. */
const slug = (key: string) => key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);

/** File-backed cache (default root: `.dataseed/dossiers/`). One JSON file per deal key. */
export function fileDossierCache(root: string): DossierCache {
  return {
    get(key) {
      const path = join(root, `${slug(key)}.json`);
      if (!existsSync(path)) return null;
      try {
        return DossierDraft.parse(JSON.parse(readFileSync(path, "utf8"))); // validate — a stale/corrupt cache is a miss, not a crash
      } catch {
        return null;
      }
    },
    set(key, draft) {
      const path = join(root, `${slug(key)}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(draft));
    },
  };
}

/** In-memory cache — tests + a single-process run with no persistence. */
export function memoryDossierCache(initial?: Record<string, DossierDraft>): DossierCache {
  const m = new Map<string, DossierDraft>(initial ? Object.entries(initial) : []);
  return {
    get: (key) => m.get(key) ?? null,
    set: (key, draft) => void m.set(key, draft),
  };
}
