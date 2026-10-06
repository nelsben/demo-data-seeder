// apps/server/src/orgs.ts
//
// List the authed `sf` orgs (aliases + usernames) for the Connect screen. Shells
// `sf org list --json`; fail-soft to an empty list so the UI still renders.

import { execFile } from "node:child_process";

export interface OrgSummary {
  alias: string | null;
  username: string;
  isScratch: boolean;
  isExpired: boolean;
}

export function listOrgs(): Promise<OrgSummary[]> {
  return new Promise((resolve) => {
    execFile("sf", ["org", "list", "--json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      try {
        const j = JSON.parse(stdout || "{}");
        const scratch = (j.result?.scratchOrgs ?? []).map((o: Record<string, unknown>) => ({
          alias: (o.alias as string) ?? null,
          username: (o.username as string) ?? "",
          isScratch: true,
          isExpired: !!o.isExpired,
        }));
        const other = (j.result?.nonScratchOrgs ?? []).map((o: Record<string, unknown>) => ({
          alias: (o.alias as string) ?? null,
          username: (o.username as string) ?? "",
          isScratch: false,
          isExpired: false,
        }));
        resolve([...scratch, ...other]);
      } catch {
        resolve([]);
      }
    });
  });
}
