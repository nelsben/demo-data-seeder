// packages/engine/src/purge/deny-list.ts
//
// The purge DENY list — sObjects `purge` must never touch, regardless of predicate
// (bare-purge or otherwise). Platform identity/config objects are never "demo data"
// (User, Profile, PermissionSet, Organization), and any `__mdt` (Custom Metadata
// Type) is denied outright for the same reason: it's declarative config Salesforce
// treats specially, not a row a seeder or a downstream app wrote.
//
// An installed app's OWN custom config objects ("config is never data") are not
// hardcoded here — the engine stays domain-agnostic. Protect them per working copy
// instead, via either source `loadExtraDenyList()` reads (both optional, merged):
//   • env  DATASEED_PURGE_DENY="My_Config__c,My_Rule__c"   (comma-separated)
//   • file .dataseed/purge-deny.json  → ["My_Config__c", "My_Rule__c"]  (gitignored dir)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DENY_EXACT: readonly string[] = ["User", "Profile", "PermissionSet", "Organization"];

/** The built-in DENY list, for docs/help output. */
export const PURGE_DENY_LIST: readonly string[] = [...DENY_EXACT, "*__mdt"];

/** Env var naming extra DENY-listed sObjects (comma-separated). */
export const PURGE_DENY_ENV = "DATASEED_PURGE_DENY";
/** Per-working-copy file of extra DENY-listed sObjects (a JSON array of API names), relative to cwd. */
export const PURGE_DENY_FILE = join(".dataseed", "purge-deny.json");

/**
 * Is `sobject` on the purge DENY list? Case-insensitive; any `__mdt` suffix is denied
 * outright. `extra` adds working-copy-specific names (see `loadExtraDenyList`).
 */
export function isDenied(sobject: string, extra: readonly string[] = []): boolean {
  const lower = sobject.toLowerCase();
  if (lower.endsWith("__mdt")) return true;
  return DENY_EXACT.some((d) => d.toLowerCase() === lower) || extra.some((d) => d.toLowerCase() === lower);
}

/**
 * Extra DENY-listed sObjects for THIS working copy: the env var + the JSON file, merged,
 * de-duplicated, blanks dropped. Fail-soft — an unreadable/malformed file contributes
 * nothing rather than blocking a purge (the built-in list still applies). Pure given
 * (env, cwd); injectable for tests.
 */
export function loadExtraDenyList(opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const out = new Set<string>();
  for (const name of (env[PURGE_DENY_ENV] ?? "").split(",")) {
    const t = name.trim();
    if (t) out.add(t);
  }
  const file = join(cwd, PURGE_DENY_FILE);
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) {
        for (const v of parsed) if (typeof v === "string" && v.trim()) out.add(v.trim());
      }
    } catch {
      // malformed file — ignore; the built-in list still applies
    }
  }
  return [...out];
}
