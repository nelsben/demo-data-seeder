import { describe, it, expect } from "vitest";
import type { CopyRequest } from "@dataseed/core";
import {
  parseEmailOutput,
  parseBodyKind,
  outputInstruction,
  synthSubject,
  ClaudeCodeCopyProvider,
} from "../src/copy/claude-code-provider.js";

/** A minimal CopyRequest for the parse/subject helpers (only fields they read). */
function req(over: Partial<CopyRequest> = {}): CopyRequest {
  return {
    id: "t-1",
    kind: "transcript",
    scenario: "at-risk-budget",
    beatIntent: "Pricing call where the buyer flags the budget cap",
    speakers: ["Diane", "Alex"],
    facts: { primaryContact: "Diane Wu" },
    ...over,
  } as CopyRequest;
}

describe("parseEmailOutput", () => {
  it("splits an explicit 'Subject:' header from the body", () => {
    const { subject, body } = parseEmailOutput(`Subject: Snowflake — pilot results\n\nDiane,\n\nThe numbers held.\n\n— Alex`);
    expect(subject).toBe("Snowflake — pilot results");
    expect(body).toBe("Diane,\n\nThe numbers held.\n\n— Alex");
  });

  it("is case-insensitive and tolerates extra blank lines after the header", () => {
    const { subject, body } = parseEmailOutput(`subject:  Re: budget\n\n\nMarcus,\n\nLet me check.`);
    expect(subject).toBe("Re: budget");
    expect(body).toBe("Marcus,\n\nLet me check.");
  });

  it("treats a short first line as the subject when there's no header", () => {
    const { subject, body } = parseEmailOutput(`Quick question on timing\n\nAre you free Wednesday?`);
    expect(subject).toBe("Quick question on timing");
    expect(body).toBe("Are you free Wednesday?");
  });

  it("falls back to body-only when the first line is long prose (no subject)", () => {
    const long = "This is a single long opening sentence that clearly is not a subject line because it runs well past any reasonable subject length.";
    const { subject, body } = parseEmailOutput(long);
    expect(subject).toBeUndefined();
    expect(body).toBe(long);
  });

  it("strips surrounding whitespace", () => {
    const { body } = parseEmailOutput(`Subject: x\n\n  hello  \n`);
    expect(body).toBe("hello");
  });
});

describe("parseBodyKind (transcript/task — verbatim, no email subject heuristic)", () => {
  it("keeps a multi-turn transcript whole — the first speaker turn is NOT stripped as a subject", () => {
    const output = `Diane: our cap is $200K through Q3, the Databricks renewal competes for the same line.\nAlex: I'll send a payback model before the Aug 31 review.\nDiane: Let me take that back to the team.`;
    const { subject, body } = parseBodyKind(output, req());
    // Body is byte-for-byte the model output — every speaker turn survives, including the first.
    expect(body).toBe(output);
    expect(body.startsWith("Diane:")).toBe(true);
    // Subject is synthesized from the request, never lifted from the first line.
    expect(subject).not.toContain("Diane:");
    expect(subject).toBe(synthSubject(req()));
  });

  it("strips ONLY an explicit leading 'Subject:' header and keeps the rest verbatim", () => {
    const output = `Subject: Pricing call — budget cap\n\nDiane: our cap is $200K.\nAlex: noted.`;
    const { subject, body } = parseBodyKind(output, req());
    expect(subject).toBe("Pricing call — budget cap");
    expect(body).toBe("Diane: our cap is $200K.\nAlex: noted.");
  });

  it("synthesizes a transcript subject consistent with the static floor's naming", () => {
    expect(synthSubject(req({ beatIntent: "Pricing call", facts: { counterpart: "Diane" } }))).toBe("Call transcript — Diane");
    expect(synthSubject(req({ beatIntent: "Kickoff meeting summary", facts: { counterpart: "Diane" } }))).toBe("Meeting summary — Diane");
    expect(synthSubject(req({ kind: "task", beatIntent: "Discovery call", facts: { counterpart: "Marcus" } }))).toBe("Call note — Marcus");
  });

  it("returns an empty body for empty model output (so the orchestrator falls back to static)", () => {
    const { body } = parseBodyKind("   \n  ", req());
    expect(body).toBe("");
  });
});

describe("outputInstruction (per-kind — no email 'Subject:' suffix leaks into transcript/task)", () => {
  it("appends the email Subject/body contract ONLY for kind 'email'", () => {
    const email = outputInstruction("email");
    expect(email).toContain('"Subject: <subject>"');
    expect(email).toContain("Do not add any preamble, commentary, or code fences.");
  });

  it("does NOT leak the email Subject suffix into a transcript or task prompt", () => {
    for (const kind of ["transcript", "task"]) {
      const instr = outputInstruction(kind);
      expect(instr).not.toContain("Subject:");
      expect(instr).not.toMatch(/email/i);
      // Still ends with the neutral no-preamble guard shared across kinds.
      expect(instr).toBe("Do not add any preamble, commentary, or code fences.");
    }
  });
});

describe("ClaudeCodeCopyProvider", () => {
  it("identifies as claude-code and reports availability as a boolean (no API key required)", async () => {
    const p = new ClaudeCodeCopyProvider();
    expect(p.id).toBe("claude-code");
    expect(typeof (await p.available())).toBe("boolean"); // true here (claude installed), false in CI — never throws
  });
});
