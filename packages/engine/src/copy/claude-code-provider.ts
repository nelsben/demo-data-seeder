// packages/engine/src/copy/claude-code-provider.ts
//
// ClaudeCodeCopyProvider — generate copy through the local Claude Code CLI (`claude -p`),
// which runs on the user's Claude subscription instead of the metered Anthropic API. Same
// model quality, ZERO API credits. The tradeoff vs the AnthropicCopyProvider: it shells a
// subprocess per email (~10s each) and is bound by the subscription's usage limits — great for
// demo-scale (tens of deals), not for thousands-at-once (use the API tier for that).
//
// Uses the SAME prompt as the API tier (prompt.ts), so what we validate is what ships. Output is
// parsed PER KIND: an email as "Subject: …\n\n<body>"; a transcript/task keeps its full multi-turn /
// terse body verbatim (the email subject heuristic would strip the first speaker turn). Per-request
// failures are swallowed — the orchestrator static-fills the remainder, so nothing ships blank.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CopyProvider, CopyRequest, CopyFillContext, CopyFillOutput, CopyResult } from "@dataseed/core";
import { buildPrompt, buildRegenPrompt } from "./prompt.js";

const execFileP = promisify(execFile);

/** Pull the subject + body out of the model's output (it's told to emit "Subject: …\n\n<body>"). */
export function parseEmailOutput(text: string): { subject?: string; body: string } {
  const t = text.trim();
  const m = /^subject:\s*(.+?)\s*\n+([\s\S]+)$/i.exec(t);
  if (m) return { subject: m[1]!.trim(), body: m[2]!.trim() };
  // No explicit "Subject:" — treat a short first line as the subject, else body-only.
  const lines = t.split(/\n/);
  if (lines.length > 1 && (lines[0]?.length ?? 0) <= 80 && lines[0]!.trim()) {
    return { subject: lines[0]!.trim(), body: lines.slice(1).join("\n").trim() };
  }
  return { body: t };
}

/**
 * Parse a TRANSCRIPT/TASK output. Unlike an email, the body is multi-turn ("Diane: …\nAlex: …")
 * or a terse log — so the email "short first line is the subject" heuristic MUST NOT run (it would
 * strip the first speaker turn as a bogus subject). Strip ONLY an explicit leading "Subject:" header;
 * otherwise keep the ENTIRE output as the body verbatim and synthesize a subject from the request
 * (matching how the static floor names the artifact). `body` is "" when the model emitted nothing.
 */
export function parseBodyKind(text: string, req: CopyRequest): { subject?: string; body: string } {
  const t = text.trim();
  // Only an explicit, line-leading "Subject:" header is removed — never a speaker turn ("Diane: …").
  const m = /^subject:\s*(.+?)\s*\n+([\s\S]+)$/i.exec(t);
  if (m) return { subject: m[1]!.trim(), body: m[2]!.trim() };
  return { subject: synthSubject(req), body: t };
}

/** A subject consistent with how the static floor names a transcript/task (see static-provider renderTranscript/renderTask). */
export function synthSubject(req: CopyRequest): string {
  const who = req.facts?.counterpart ?? req.facts?.primaryContact ?? "the buyer";
  const activity = /\bmeeting\b/i.test(req.beatIntent) ? "Meeting" : "Call";
  if (req.kind === "task") return `${activity} note — ${who}`;
  // transcript: a verbatim excerpt vs. an AI summary, mirroring the static floor's two shapes.
  const form = /\bsummary\b/i.test(req.beatIntent) ? "summary" : "transcript";
  return `${activity} ${form} — ${who}`;
}

/**
 * The trailing output contract appended to every prompt — PER KIND. The bug this fixes: a single
 * hard-coded email instruction ("Output ONLY the email — a line 'Subject: …' …") was appended to
 * EVERY request, overriding the transcript/task system prompt and forcing a speaker-labeled transcript
 * to be mangled into a fake "Subject:" line, which then fell through to the static floor. Transcript and
 * task system prompts already state their output shape, so we only add a light email nudge for "email".
 * Every kind ends with the same neutral no-preamble guard.
 */
export function outputInstruction(kind: string): string {
  const NO_PREAMBLE = "Do not add any preamble, commentary, or code fences.";
  if (kind === "email") {
    return `Output ONLY the email — a single line "Subject: <subject>", then a blank line, then the body. ${NO_PREAMBLE}`;
  }
  // transcript / task: the system prompt already specifies the shape (speaker-labeled turns or a
  // terse log). Forcing an email "Subject:" header here is exactly what corrupted the output.
  return NO_PREAMBLE;
}

const CONCURRENCY = 3; // a few headless agents at once; gentle on subscription rate limits

export class ClaudeCodeCopyProvider implements CopyProvider {
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

  async fill(requests: CopyRequest[], ctx: CopyFillContext): Promise<CopyFillOutput> {
    const slice = ctx.limit != null ? requests.slice(0, ctx.limit) : requests;
    const results: CopyResult[] = [];
    let next = 0;

    const worker = async () => {
      while (next < slice.length) {
        const req = slice[next++]!;
        try {
          // A regen hint (from the realism gate) → corrective prompt that names the tells to fix.
          const hints = ctx.regenHints?.get(req.id);
          const { system, user } = hints?.length ? buildRegenPrompt(req, hints) : buildPrompt(req);
          const prompt = `${system}\n\n---\n\n${user}\n\n${outputInstruction(req.kind)}`;
          const { stdout } = await execFileP("claude", ["-p", prompt, "--output-format", "text"], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
          // Email parses with the "short first line is a subject" heuristic; a transcript/task body is
          // multi-turn/terse and must be kept VERBATIM (that heuristic would eat the first speaker turn).
          const parsed = req.kind === "email" ? parseEmailOutput(stdout) : parseBodyKind(stdout, req);
          if (parsed.body) results.push({ id: req.id, subject: parsed.subject, body: parsed.body, provider: "claude-code" });
        } catch (e) {
          ctx.log?.(`claude-code: ${req.id} failed — ${(e as Error).message.slice(0, 80)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));
    return { results, estCostUsd: 0, budgetExhausted: false };
  }
}

export default ClaudeCodeCopyProvider;
