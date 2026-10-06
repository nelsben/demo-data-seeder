// packages/engine/src/copy/judge.ts
//
// The realism gate, tier 3: an LLM-as-judge that reads each deal THREAD the way a skeptical VP of
// Sales would and decides whether it reads as genuine human correspondence. The lint (tier 1) and
// the regenerate loop (tier 2) are MECHANICAL — they catch format tells and byte-identical clones.
// This catches the SEMANTIC misses no regex can: implausible numbers, a persona that doesn't sound
// like a real CFO, a reply that ignores the prior message, an arc that's suspiciously tidy.
//
// v1 is ADVISORY: it scores each thread and surfaces the weak ones (you see WHICH deals read fake
// and WHY). Feeding the critique back into regeneration (judge → critique → regenerate → re-judge,
// mirroring the gate) is the next increment — judgeCopy is shaped to make that drop-in.
//
// Pure of any model SDK: judgeCopy takes an injected JudgeRunner, so it's testable with a mock and
// works over any provider (claude -p on the subscription, the Anthropic API, …) via judge-runners.ts.

export interface JudgeEmail {
  from: string;
  direction: "outbound" | "inbound";
  body: string;
}

/** One deal's conversation — the unit the judge reads (realism is a property of the whole thread). */
export interface JudgeThread {
  threadId: string;
  account: string;
  subject: string;
  emails: JudgeEmail[];
  /** Phase 4D — the deal's intended dossier arc. When present, the judge also checks the thread DELIVERS it. */
  intendedArc?: string;
}

export interface JudgeVerdict {
  threadId: string;
  /** Would a skeptical VP accept this as real correspondence? */
  believable: boolean;
  /** 1 (obviously synthetic) … 5 (indistinguishable from real). */
  score: number;
  /** The specific tells the judge flagged (empty when it read clean). */
  issues: string[];
  /** One-line summary. */
  critique: string;
}

export interface JudgeReport {
  verdicts: JudgeVerdict[];
  total: number;
  believable: number;
  avgScore: number;
  /** Threads at/below the believability bar — the ones worth a look (worst first). */
  flagged: JudgeVerdict[];
}

/** A judge runner turns one thread into a verdict (owns the model call). Returns null on error. */
export type JudgeRunner = (thread: JudgeThread) => Promise<JudgeVerdict | null>;

/** The frozen judge persona — a hard-to-fool reviewer who trusts their gut. Byte-stable (cacheable). */
export const JUDGE_SYSTEM = `You are a skeptical, time-poor VP of Sales spot-checking email threads in your CRM. You have read tens of thousands of real sales emails. Your only question about a thread: does it read like GENUINE human correspondence between a rep and a real prospect, or like AI-generated filler?

You are hard to fool. Call out anything that feels off:
- numbers or claims no real buyer or rep would write, or that don't add up
- a persona that doesn't sound like a real CFO / champion / procurement lead / technical evaluator
- a reply that doesn't actually respond to the prior message
- an arc that's too neat, too symmetrical, or resolves too cleanly
- generic detail, hedging, or filler where a real person would be specific
- anything that smells synthetic

Reward concrete specificity and real business texture (named systems, real constraints, messy human timing). When you're given the deal's INTENDED storyline, also check the thread actually delivers it — the arc and its sentiment trajectory should be visible across the messages; a thread that doesn't tell its intended story is a miss even if each email reads fine on its own. Otherwise judge it cold. Be concise and concrete.`;

/** Render one thread + the scoring ask. Kept separate from the runner so it's unit-testable. */
export function buildJudgePrompt(thread: JudgeThread): string {
  const convo = thread.emails
    .map((e, i) => `[${i + 1}] ${e.direction === "inbound" ? "FROM PROSPECT" : "FROM REP"} — ${e.from}\n${e.body.trim()}`)
    .join("\n\n———\n\n");
  return [
    `Thread for the deal at "${thread.account}". Subject: ${thread.subject}`,
    ...(thread.intendedArc ? [``, `INTENDED STORY (what this deal was meant to convey — judge whether the thread DELIVERS it): ${thread.intendedArc}`] : []),
    ``,
    convo,
    ``,
    `Rate this thread's believability as real human correspondence.`,
    `- score: 1 (obviously AI) to 5 (indistinguishable from real)`,
    `- believable: true only if you'd accept it as genuine without a second thought (score 4-5)`,
    `- issues: the specific tells you noticed (empty array if it reads clean)`,
    `- critique: one short sentence`,
    ``,
    `Respond with ONLY a JSON object, no prose, no code fence:`,
    `{"score": <1-5>, "believable": <true|false>, "issues": ["..."], "critique": "..."}`,
  ].join("\n");
}

/** Pull a JudgeVerdict out of a model's text reply (tolerant of surrounding prose / code fences). */
export function parseVerdict(text: string, threadId: string): JudgeVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const rawScore = Number(obj.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.min(5, Math.max(1, Math.round(rawScore)));
  const issues = Array.isArray(obj.issues) ? obj.issues.map((x) => String(x)).filter(Boolean) : [];
  const believable = typeof obj.believable === "boolean" ? obj.believable : score >= 4;
  const critique = typeof obj.critique === "string" ? obj.critique : "";
  return { threadId, believable, score, issues, critique };
}

/** Threads at or below this score are flagged for review (the believability bar). */
export const BELIEVABILITY_BAR = 4;

const CONCURRENCY = 3;

/** Judge every thread (bounded concurrency) and summarize. A thread whose run errors is skipped. */
export async function judgeCopy(threads: JudgeThread[], run: JudgeRunner, opts: { bar?: number; log?: (m: string) => void } = {}): Promise<JudgeReport> {
  const bar = opts.bar ?? BELIEVABILITY_BAR;
  const log = opts.log ?? (() => {});
  const verdicts: JudgeVerdict[] = [];
  let next = 0;
  const worker = async () => {
    while (next < threads.length) {
      const t = threads[next++]!;
      const v = await run(t);
      if (v) verdicts.push(v);
      else log(`judge: no verdict for "${t.account}" (${t.threadId}) — skipped`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, threads.length) }, worker));

  const total = verdicts.length;
  const believable = verdicts.filter((v) => v.believable).length;
  const avgScore = total ? verdicts.reduce((s, v) => s + v.score, 0) / total : 0;
  const flagged = verdicts.filter((v) => v.score < bar || !v.believable).sort((a, b) => a.score - b.score);
  return { verdicts, total, believable, avgScore, flagged };
}

export default judgeCopy;
