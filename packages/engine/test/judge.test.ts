import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseVerdict, judgeCopy, JUDGE_SYSTEM, type JudgeThread, type JudgeRunner } from "../src/copy/judge.js";

const thread = (id: string, account: string, n: number): JudgeThread => ({
  threadId: id,
  account,
  subject: `${account} — budget`,
  emails: Array.from({ length: n }, (_, i) => ({ from: i % 2 ? "Diane" : "Alex", direction: (i % 2 ? "inbound" : "outbound") as "inbound" | "outbound", body: `Body ${i} for ${account}.` })),
});

describe("buildJudgePrompt", () => {
  it("renders the thread with direction labels and asks for a strict JSON verdict", () => {
    const p = buildJudgePrompt(thread("t-0", "Snowflake", 2));
    expect(p).toContain("Snowflake");
    expect(p).toContain("FROM REP"); // outbound label
    expect(p).toContain("FROM PROSPECT"); // inbound label
    expect(p).toMatch(/ONLY a JSON object/i);
    expect(p).toContain('"believable"');
    expect(JUDGE_SYSTEM).toMatch(/skeptical/i); // the persona is hard to fool
  });
});

describe("parseVerdict", () => {
  it("extracts a clean JSON verdict and clamps the score to 1–5", () => {
    const v = parseVerdict('{"score": 5, "believable": true, "issues": [], "critique": "reads real"}', "t-0");
    expect(v).toEqual({ threadId: "t-0", score: 5, believable: true, issues: [], critique: "reads real" });
    expect(parseVerdict('{"score": 9, "believable": true, "issues": [], "critique": "x"}', "t-0")!.score).toBe(5);
    expect(parseVerdict('{"score": 0, "believable": false, "issues": [], "critique": "x"}', "t-0")!.score).toBe(1);
  });

  it("tolerates surrounding prose / a code fence and coerces issues to strings", () => {
    const v = parseVerdict('Here is my verdict:\n```json\n{"score":2,"believable":false,"issues":["generic","too neat"],"critique":"filler"}\n```', "t-1");
    expect(v).toMatchObject({ threadId: "t-1", score: 2, believable: false, issues: ["generic", "too neat"] });
  });

  it("defaults `believable` from the score when the model omits it", () => {
    expect(parseVerdict('{"score": 4, "issues": [], "critique": "ok"}', "t-2")!.believable).toBe(true);
    expect(parseVerdict('{"score": 3, "issues": [], "critique": "meh"}', "t-2")!.believable).toBe(false);
  });

  it("returns null on unparseable / scoreless output (the runner then skips that thread)", () => {
    expect(parseVerdict("the model rambled with no json", "t-3")).toBeNull();
    expect(parseVerdict('{"believable": true}', "t-3")).toBeNull(); // no score
  });
});

describe("judgeCopy", () => {
  const runner = (scoreByAccount: Record<string, number>): JudgeRunner => async (t) => ({
    threadId: t.threadId,
    score: scoreByAccount[t.account] ?? 5,
    believable: (scoreByAccount[t.account] ?? 5) >= 4,
    issues: (scoreByAccount[t.account] ?? 5) < 4 ? ["too neat"] : [],
    critique: "c",
  });

  it("summarizes believability and flags sub-bar threads worst-first", async () => {
    const threads = [thread("a", "Snowflake", 2), thread("b", "Stripe", 2), thread("c", "Lyft", 2)];
    const report = await judgeCopy(threads, runner({ Stripe: 2, Lyft: 3 }), { log: () => {} });
    expect(report.total).toBe(3);
    expect(report.believable).toBe(1); // only Snowflake (5)
    expect(report.avgScore).toBeCloseTo((5 + 2 + 3) / 3);
    expect(report.flagged.map((v) => v.threadId)).toEqual(["b", "c"]); // 2 before 3 (worst first)
  });

  it("skips a thread whose runner returns null, without failing the batch", async () => {
    const flaky: JudgeRunner = async (t) => (t.account === "Stripe" ? null : { threadId: t.threadId, score: 5, believable: true, issues: [], critique: "c" });
    const report = await judgeCopy([thread("a", "Snowflake", 2), thread("b", "Stripe", 2)], flaky, { log: () => {} });
    expect(report.total).toBe(1); // Stripe skipped
    expect(report.believable).toBe(1);
  });
});
