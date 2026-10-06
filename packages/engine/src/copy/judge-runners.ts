// packages/engine/src/copy/judge-runners.ts
//
// Concrete JudgeRunners — they turn one thread into a verdict by actually calling a model. Kept
// out of judge.ts so the loop stays pure/testable. Two tiers, matching the copy providers:
//   - claude-code: shells `claude -p` (runs on the Claude subscription, no API credits)
//   - anthropic:   the Messages API with a forced structured tool (needs ANTHROPIC_API_KEY + credits)
// makeJudgeRunner maps a provider id to the right runner (null for a tier that can't judge: static,
// which is deterministic — regenerating yields identical bytes), so the caller can skip judging cleanly.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { JUDGE_SYSTEM, buildJudgePrompt, parseVerdict, type JudgeRunner, type JudgeVerdict, type JudgeThread } from "./judge.js";

const execFileP = promisify(execFile);
const MODEL = "claude-opus-4-8";

/** Judge via the local Claude Code CLI (subscription tier). */
export const claudeCodeJudge: JudgeRunner = async (thread) => {
  try {
    const prompt = `${JUDGE_SYSTEM}\n\n---\n\n${buildJudgePrompt(thread)}`;
    const { stdout } = await execFileP("claude", ["-p", prompt, "--output-format", "text"], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    return parseVerdict(stdout, thread.threadId);
  } catch {
    return null;
  }
};

const VERDICT_TOOL: Anthropic.Tool = {
  name: "emit_verdict",
  description: "Return the believability verdict for the thread.",
  input_schema: {
    type: "object",
    properties: {
      score: { type: "integer", description: "1 (obviously AI) to 5 (indistinguishable from real)." },
      believable: { type: "boolean", description: "True only if you'd accept it as genuine without a second thought." },
      issues: { type: "array", items: { type: "string" }, description: "Specific tells; empty if it reads clean." },
      critique: { type: "string", description: "One short sentence." },
    },
    required: ["score", "believable", "issues", "critique"],
  },
};

/** Judge via the Anthropic Messages API (forced structured tool → a validated verdict). */
export const anthropicJudge: JudgeRunner = async (thread) => {
  try {
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: JUDGE_SYSTEM,
      tools: [VERDICT_TOOL],
      tool_choice: { type: "tool", name: "emit_verdict" },
      messages: [{ role: "user", content: buildJudgePrompt(thread) }],
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const v = toolUse?.input as Partial<JudgeVerdict> | undefined;
    if (!v || typeof v.score !== "number") return null;
    const score = Math.min(5, Math.max(1, Math.round(v.score)));
    return {
      threadId: thread.threadId,
      score,
      believable: typeof v.believable === "boolean" ? v.believable : score >= 4,
      issues: Array.isArray(v.issues) ? v.issues.map(String).filter(Boolean) : [],
      critique: typeof v.critique === "string" ? v.critique : "",
    };
  } catch {
    return null;
  }
};

/** The judge runner for a given copy provider, or null if that tier can't judge. */
export function makeJudgeRunner(providerId: string): JudgeRunner | null {
  if (providerId === "claude-code") return claudeCodeJudge;
  if (providerId === "anthropic") return anthropicJudge;
  return null; // static (deterministic) → no semantic judge
}
