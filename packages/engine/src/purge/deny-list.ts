// packages/engine/src/purge/deny-list.ts
//
// The purge DENY list — sObjects `purge` must never touch, regardless of predicate
// (bare-purge or otherwise). Platform identity/config objects are never "demo data"
// (User, Profile, PermissionSet, Organization), and any `__mdt` (Custom Metadata
// Type) is denied outright for the same reason: it's declarative config Salesforce
// treats specially, not a row a seeder or a downstream app wrote. An app's own
// custom config objects ("config is never data") are not hardcoded here — the engine
// stays domain-agnostic — so scope a purge with --where / --older-than-days rather
// than relying on this list to protect app config.

const DENY_EXACT: readonly string[] = ["User", "Profile", "PermissionSet", "Organization"];

/** The DENY list, for docs/help output. */
export const PURGE_DENY_LIST: readonly string[] = [...DENY_EXACT, "*__mdt"];

/** Is `sobject` on the purge DENY list? Case-insensitive; any `__mdt` suffix is denied outright. */
export function isDenied(sobject: string): boolean {
  const lower = sobject.toLowerCase();
  if (lower.endsWith("__mdt")) return true;
  return DENY_EXACT.some((d) => d.toLowerCase() === lower);
}
