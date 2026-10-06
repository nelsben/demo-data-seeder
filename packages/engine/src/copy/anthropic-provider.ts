// packages/engine/src/copy/anthropic-provider.ts
//
// AnthropicCopyProvider — the marquee copy path: real LLM-generated email bodies
// via the Anthropic Messages API (the preferred non-interactive copy tier; the
// claude-code provider is the local-subscription path, static the always-on
// fallback). Gated on ANTHROPIC_API_KEY at runtime.
//
// Per the claude-api skill: model claude-opus-4-8. STRUCTURED OUTPUT via a forced
// tool call (`tool_choice` → a single `emit_email` tool whose input_schema is
// {subject, body}) — so the response is a validated object, never free text to
// parse, and it typechecks against the stable SDK surface (the newer
// `output_config` structured-output param is beta-only in this SDK version).
// RESILIENT + BUDGETED: each email is its own call wrapped in try/catch; a refusal
// or error just leaves that request unfilled (the orchestrator static-fills it).
// It stops calling the model once running spend would exceed ctx.budgetUsd.

import Anthropic from "@anthropic-ai/sdk";
import type { CopyProvider, CopyRequest, CopyFillContext, CopyFillOutput, CopyResult } from "@dataseed/core";
import { buildPrompt, buildRegenPrompt } from "./prompt.js";

const MODEL = "claude-opus-4-8";
const MAX_CONCURRENT = 5;

/** Opus 4.8 per-MTok rates (USD) for the budget estimate. */
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

/** The forced tool — its input IS the structured email, validated by the API. */
const EMAIL_TOOL: Anthropic.Tool = {
  name: "emit_email",
  description: "Return the finished sales email.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Concrete 4-8 word subject line." },
      body: { type: "string", description: "The 60-140 word email body, paragraph beats separated by blank lines, first-name sign-off." },
    },
    required: ["subject", "body"],
  },
};

interface Usagelike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}
function costOf(u: Usagelike): number {
  return (
    (u.input_tokens * PRICE.input +
      u.output_tokens * PRICE.output +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) /
    1_000_000
  );
}

export class AnthropicCopyProvider implements CopyProvider {
  id = "anthropic";
  private client: Anthropic | null = null;

  available(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("AnthropicCopyProvider: ANTHROPIC_API_KEY is not set");
      this.client = new Anthropic();
    }
    return this.client;
  }

  /** Generate one email. Returns null on refusal / error / empty result so the caller can fall back. */
  private async one(req: CopyRequest, log: (m: string) => void, hints?: ReadonlyArray<{ rule: string; severity: string; detail: string }>): Promise<{ result: CopyResult; cost: number } | null> {
    // A regen hint (from the realism gate) → corrective prompt that names the tells to fix.
    const { system, user } = hints?.length ? buildRegenPrompt(req, hints) : buildPrompt(req);
    try {
      const resp = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: [EMAIL_TOOL],
        tool_choice: { type: "tool", name: "emit_email" },
        messages: [{ role: "user", content: user }],
      });
      const cost = costOf(resp.usage);
      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const email = toolUse?.input as { subject?: string; body?: string } | undefined;
      if (!email || typeof email.body !== "string" || !email.body.trim()) {
        log(`${req.id}: model returned no usable email (stop_reason=${resp.stop_reason}) — will fall back`);
        return null;
      }
      return { result: { id: req.id, subject: email.subject ?? "", body: email.body, provider: "anthropic" }, cost };
    } catch (e) {
      log(`${req.id}: generation failed (${(e as Error).message}) — will fall back`);
      return null;
    }
  }

  async fill(requests: CopyRequest[], ctx: CopyFillContext): Promise<CopyFillOutput> {
    const log = ctx.log ?? (() => {});
    const queue = (ctx.limit != null ? requests.slice(0, ctx.limit) : requests).slice();
    const results: CopyResult[] = [];
    let spent = 0;
    let budgetExhausted = false;

    // A small fixed-size worker pool. Each worker checks the running spend BEFORE
    // taking a request, so the budget is honored across concurrent calls (we may
    // overshoot by at most the in-flight calls' cost — acceptable for a soft cap).
    const worker = async () => {
      while (queue.length > 0) {
        if (ctx.budgetUsd != null && spent >= ctx.budgetUsd) {
          budgetExhausted = true;
          return;
        }
        const req = queue.shift();
        if (!req) return;
        const out = await this.one(req, log, ctx.regenHints?.get(req.id));
        if (out) {
          results.push(out.result);
          spent += out.cost;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, () => worker()));
    if (budgetExhausted) log(`budget of $${ctx.budgetUsd} reached after $${spent.toFixed(4)} — remaining emails fall back to static`);
    return { results, estCostUsd: spent, budgetExhausted };
  }
}

export default AnthropicCopyProvider;
