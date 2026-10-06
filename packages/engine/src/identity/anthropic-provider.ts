// packages/engine/src/identity/anthropic-provider.ts
//
// AnthropicIdentityProvider — author a synthetic company via the Anthropic Messages API (the
// non-interactive LLM tier; the claude-code provider is the local-subscription path, static the
// always-on floor). Gated on ANTHROPIC_API_KEY. Per the claude-api skill: model claude-opus-4-8,
// STRUCTURED OUTPUT via a forced tool call (`emit_identity`) so the response is a validated object, not
// free text. RESILIENT + BUDGETED: each identity is its own call wrapped in try/catch; a refusal/error/
// self-product draft leaves that request unfilled (the orchestrator static-fills it). Mirrors
// AnthropicCopyProvider.

import Anthropic from "@anthropic-ai/sdk";
import type { IdentityProvider, IdentityRequest, IdentityAuthorContext, IdentityAuthorOutput } from "@dataseed/core";
import { IDENTITY_SYSTEM, identityUserPrompt } from "./prompt.js";
import { validateIdentity } from "./guard.js";

const MODEL = "claude-opus-4-8";
const MAX_CONCURRENT = 5;

/** Opus 4.8 per-MTok rates (USD) for the budget estimate. */
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

/** The forced tool — its input IS the structured identity, validated by the API then by Zod + the guard. */
const IDENTITY_TOOL: Anthropic.Tool = {
  name: "emit_identity",
  description: "Return the finished synthetic company identity.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      sfIndustry: { type: "string" },
      domain: { type: "string", description: "Bare host, e.g. 'meridianfreight.com'." },
      sector: { type: "string" },
      employees: { type: "integer" },
      revenueUsd: { type: "number" },
      hq: { type: "string", description: "'City, Country'." },
      description: { type: "string" },
      does: { type: "string" },
      products: { type: "array", items: { type: "string" } },
      buyingDept: { type: "string" },
      painPhrase: { type: "string" },
    },
    required: ["name", "sfIndustry", "domain", "sector", "employees", "revenueUsd", "hq", "description", "does", "products", "buyingDept", "painPhrase"],
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
    (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) /
    1_000_000
  );
}

export class AnthropicIdentityProvider implements IdentityProvider {
  id = "anthropic";
  private client: Anthropic | null = null;

  available(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("AnthropicIdentityProvider: ANTHROPIC_API_KEY is not set");
      this.client = new Anthropic();
    }
    return this.client;
  }

  private async one(req: IdentityRequest, log: (m: string) => void): Promise<{ identity: IdentityAuthorOutput["identities"][number]; cost: number } | null> {
    try {
      const resp = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: IDENTITY_SYSTEM,
        tools: [IDENTITY_TOOL],
        tool_choice: { type: "tool", name: "emit_identity" },
        messages: [{ role: "user", content: identityUserPrompt(req) }],
      });
      const cost = costOf(resp.usage);
      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const identity = validateIdentity(toolUse?.input);
      if (!identity) {
        log(`${req.unitKey}: model returned no usable identity (stop_reason=${resp.stop_reason}) — will fall back`);
        return null;
      }
      return { identity: { unitKey: req.unitKey, index: req.index, identity }, cost };
    } catch (e) {
      log(`${req.unitKey}: identity authoring failed (${(e as Error).message}) — will fall back`);
      return null;
    }
  }

  async author(requests: IdentityRequest[], ctx: IdentityAuthorContext): Promise<IdentityAuthorOutput> {
    const log = ctx.log ?? (() => {});
    const queue = (ctx.limit != null ? requests.slice(0, ctx.limit) : requests).slice();
    const identities: IdentityAuthorOutput["identities"] = [];
    let spent = 0;
    let budgetExhausted = false;

    const worker = async () => {
      while (queue.length > 0) {
        if (ctx.budgetUsd != null && spent >= ctx.budgetUsd) {
          budgetExhausted = true;
          return;
        }
        const req = queue.shift();
        if (!req) return;
        const out = await this.one(req, log);
        if (out) {
          identities.push(out.identity);
          spent += out.cost;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, () => worker()));
    if (budgetExhausted) log(`identity budget of $${ctx.budgetUsd} reached after $${spent.toFixed(4)} — remaining identities fall back to static`);
    return { identities, estCostUsd: spent, budgetExhausted };
  }
}

export default AnthropicIdentityProvider;
