// apps/server/src/preflight.ts
//
// First-run environment check for the local-first app: are the CLIs the lifecycle
// depends on actually present? The Connect screen reads this so an SE learns about a
// missing `sf` auth or `claude` CLI BEFORE they're mid-demo, not as a surprise failure.

import { execFile } from "node:child_process";

export interface Preflight {
  /** `sf` CLI present (org listing + the loader's auth depend on it). */
  sf: boolean;
  /** `claude` CLI present (the default copy provider — runs on the SE's subscription). */
  claudeCode: boolean;
  /** ANTHROPIC_API_KEY set on the server (the API fallback provider). */
  anthropicKey: boolean;
}

/** Resolve true if `cmd args` runs without error (the binary exists + is runnable). */
function probe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8_000 }, (err) => resolve(!err));
  });
}

export async function preflight(): Promise<Preflight> {
  const [sf, claudeCode] = await Promise.all([probe("sf", ["--version"]), probe("claude", ["--version"])]);
  return { sf, claudeCode, anthropicKey: !!process.env.ANTHROPIC_API_KEY };
}
