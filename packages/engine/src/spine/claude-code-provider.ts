// packages/engine/src/spine/claude-code-provider.ts
//
// ClaudeCodeSpineProvider — author a deal's dossier narrative through the local Claude Code CLI
// (`claude -p`), on the user's subscription (zero API credits). One structured call per deal (cheaper
// than the per-email copy calls it coordinates). Output is JSON parsed into a DossierDraft; a deal that
// fails to parse is simply dropped (the orchestrator keeps that deal's static skeleton). Mirrors
// ClaudeCodeCopyProvider — same subprocess shape, same swallow-and-fall-back contract.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DossierDraft, type SpineProvider, type SpineRequest, type SpineAuthorContext, type SpineAuthorOutput } from "@dataseed/core";
import { buildSpineCliPrompt } from "./prompt.js";

const execFileP = promisify(execFile);
const CONCURRENCY = 3; // a few headless agents at once; gentle on subscription rate limits

/** Extract the JSON object from a CLI response (tolerant of stray prose / code fences). */
export function parseDraft(text: string): DossierDraft | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return DossierDraft.parse(JSON.parse(t.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export class ClaudeCodeSpineProvider implements SpineProvider {
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

  async author(requests: SpineRequest[], ctx: SpineAuthorContext): Promise<SpineAuthorOutput> {
    const slice = ctx.limit != null ? requests.slice(0, ctx.limit) : requests;
    const drafts: SpineAuthorOutput["drafts"] = [];
    let next = 0;

    const worker = async () => {
      while (next < slice.length) {
        const req = slice[next++]!;
        try {
          const prompt = buildSpineCliPrompt(req);
          const { stdout } = await execFileP("claude", ["-p", prompt, "--output-format", "text"], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
          const draft = parseDraft(stdout);
          if (draft) drafts.push({ dealKey: req.dealKey, draft });
          else ctx.log?.(`claude-code spine: ${req.dealKey} — unparseable draft, keeping static`);
        } catch (e) {
          ctx.log?.(`claude-code spine: ${req.dealKey} failed — ${(e as Error).message.slice(0, 80)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));
    return { drafts, estCostUsd: 0, budgetExhausted: false };
  }
}

export default ClaudeCodeSpineProvider;
