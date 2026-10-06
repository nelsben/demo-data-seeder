// packages/engine/src/identity/cache.ts
//
// The identity cache — the determinism contract for synthetic identities (mirrors the dossier cache,
// [[spine/cache.ts]]). An LLM-authored AccountIdentity is CACHED by (seed, account index); a re-run reads
// the cached identity instead of re-authoring (free + byte-stable), and only a miss spends a token. Only
// LLM-authored identities are cached — a static fallback is NOT persisted, so the day an LLM provider is
// available it authors fresh instead of being pinned to a static stand-in.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { AccountIdentity } from "@dataseed/core";

export interface IdentityCache {
  /** A prior authored identity for this unit key, or null on a miss. */
  get(key: string): AccountIdentity | null;
  /** Persist an authored identity so the next run reuses it. */
  set(key: string, identity: AccountIdentity): void;
}

/** Slugify a unit key into a safe filename. */
const slug = (key: string) => key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);

/** File-backed cache (default root: `.dataseed/identities/`). One JSON file per unit key. */
export function fileIdentityCache(root: string): IdentityCache {
  return {
    get(key) {
      const path = join(root, `${slug(key)}.json`);
      if (!existsSync(path)) return null;
      try {
        return AccountIdentity.parse(JSON.parse(readFileSync(path, "utf8"))); // validate — a stale/corrupt cache is a miss, not a crash
      } catch {
        return null;
      }
    },
    set(key, identity) {
      const path = join(root, `${slug(key)}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(identity));
    },
  };
}

/** In-memory cache — tests + a single-process run with no persistence. */
export function memoryIdentityCache(initial?: Record<string, AccountIdentity>): IdentityCache {
  const m = new Map<string, AccountIdentity>(initial ? Object.entries(initial) : []);
  return {
    get: (key) => m.get(key) ?? null,
    set: (key, identity) => void m.set(key, identity),
  };
}
