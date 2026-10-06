// packages/engine/src/identity/claude-code-provider.ts
//
// ClaudeCodeIdentityProvider — author a synthetic company through the local Claude Code CLI (`claude -p`),
// on the user's subscription (zero API credits). One structured call per account. Output is JSON parsed +
// validated (Zod + self-product guard) into an AccountIdentity; an identity that fails to parse or trips
// the guard is dropped (the orchestrator falls back to static). Mirrors ClaudeCodeSpineProvider.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IdentityProvider, IdentityRequest, IdentityAuthorContext, IdentityAuthorOutput } from "@dataseed/core";
import { buildIdentityCliPrompt } from "./prompt.js";
import { parseIdentity } from "./guard.js";

const execFileP = promisify(execFile);
const CONCURRENCY = 3; // gentle on subscription rate limits

export class ClaudeCodeIdentityProvider implements IdentityProvider {
  id = "claude-code";
  private availCache?: boolean;

  async available(): Promise<boolean> {
    if (this.availCache !== undefined) return this.availCache;
    try {
      await execFileP("claude", ["--version"], { timeout: 10_000 });
      this.availCache = true;
    } catch {
      this.availCache = false;
    }
    return this.availCache;
  }

  async author(requests: IdentityRequest[], ctx: IdentityAuthorContext): Promise<IdentityAuthorOutput> {
    const slice = ctx.limit != null ? requests.slice(0, ctx.limit) : requests;
    const identities: IdentityAuthorOutput["identities"] = [];
    let next = 0;

    const worker = async () => {
      while (next < slice.length) {
        const req = slice[next++]!;
        try {
          const prompt = buildIdentityCliPrompt(req);
          const { stdout } = await execFileP("claude", ["-p", prompt, "--output-format", "text"], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
          const identity = parseIdentity(stdout);
          if (identity) identities.push({ unitKey: req.unitKey, index: req.index, identity });
          else ctx.log?.(`claude-code identity: ${req.unitKey} — unparseable or self-product draft, falling back`);
        } catch (e) {
          ctx.log?.(`claude-code identity: ${req.unitKey} failed — ${(e as Error).message.slice(0, 80)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));
    return { identities, estCostUsd: 0, budgetExhausted: false };
  }
}

export default ClaudeCodeIdentityProvider;
