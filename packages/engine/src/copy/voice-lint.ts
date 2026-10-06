// packages/engine/src/copy/voice-lint.ts
//
// The realism gate, tier 1: a deterministic, zero-dependency linter that scores how
// FAKE a batch of generated copy reads. It is the machine-checkable half of the realism
// rubric (docs/design/realism-playbook.md) and the floor the whole copy layer is held to:
// CI runs it; the gate regenerates emails that fail; the static tier is its canonical
// NEGATIVE fixture (it fails nearly every rule — that's the point).
//
// Two classes of rule:
//   - per-email / per-thread: mechanical tells a human writer never produces (machine-format
//     money, a sender naming themselves in the third person, concatenation seams, AI-slop).
//   - corpus-level: the tells that only appear ACROSS instances — the fatal one being two
//     deals in the same (scenario, position) that are the same letter with names swapped.
//
// This file is the CANONICAL rule set (the deny-lists are exported so docs/voice.md points
// here rather than duplicating them). No LLM, no network — pure functions over strings.

import type { CopyRequest, CopyResult } from "@dataseed/core";

export type Severity = "low" | "medium" | "high" | "fatal";

export interface LintViolation {
  id: string;
  rule: string;
  severity: Severity;
  detail: string;
}

export interface LintReport {
  violations: LintViolation[];
  byRule: Record<string, number>;
  bySeverity: Record<Severity, number>;
  emailsLinted: number;
  /** Emails with zero violations of any severity. */
  cleanEmails: number;
  /** cleanEmails / emailsLinted (1 = corpus is mechanically clean). */
  passRate: number;
  /** Highest similarity seen between any same-(scenario,position) pair (0 if none compared). */
  maxCrossInstanceSimilarity: number;
}

export interface LintTarget {
  request: Pick<CopyRequest, "id" | "scenario" | "seq">;
  result: Pick<CopyResult, "id" | "subject" | "body">;
}

// ── Canonical deny-lists (the machine half of docs/design/voice.md) ──────────────────

/** AI-slop / sales-cliché phrases no human deal correspondence should contain. */
export const FORBIDDEN_PHRASES = [
  "i hope this email finds you well",
  "hope this finds you well",
  "touching base",
  "circle back",
  "circling back",
  "reach out",
  "synergy",
  "leverage our",
  "at the end of the day",
  "moving forward,",
  "per my last",
  "as per",
  "kindly",
  "needless to say",
  "it goes without saying",
  "in today's fast-paced",
];

/** Stock "confessional" openers — a generator tic that reads as theatrical, not human. */
export const CONFESSIONAL_OPENERS = [
  /^i have to be (straight|honest)\b/i,
  /^i have to raise\b/i,
  /^let me level with you\b/i,
  /^i'?ll be honest\b/i,
  /^i want to be (honest|straight|candid)\b/i,
  /^i'?m going to be (straight|honest)\b/i,
];

const SENTENCE_CONNECTIVES = ["before", "after", "with", "that", "because", "while"];

/**
 * Canonical rule → imperative fix, kept here next to the detector so the corrective copy the
 * realism gate feeds back to the model stays in lockstep with what each rule actually checks.
 * buildRegenPrompt pairs each line with the violation's own `detail` (which names the literal
 * offending token), so the model gets a concrete, fixable instruction — not a blind re-roll.
 */
export const HUMAN_FIX: Record<string, string> = {
  ROUND_NUMBER_FORMAT: "Write money the human way: $1.2M, ~$350K, $84K — never the ledger figure with commas.",
  SELF_REFERENCE: "Do not name yourself anywhere in your own body; you already sign off with your first name.",
  SIGNOFF_SHAPE: "End with just a first name on the final line (or 'Thanks,' then the name).",
  DOUBLED_FUNCTION_WORD: "Recast that sentence so no word repeats back-to-back and no connective (before/after/with/that/because/while) appears twice in one sentence.",
  FORBIDDEN_PHRASE: "Cut that AI-slop phrase and say it plainly.",
  CONFESSIONAL_OPENER: "Drop the confessional opener; lead with the actual fact or ask.",
  EM_DASH_DENSITY: "Use at most one em-dash, ideally zero; replace the rest with periods or commas.",
  CURRENCY_UNIT_REPETITION: "State the unit (ARR/ACV) once, then say 'the deal' or 'it'.",
  CROSS_INSTANCE_SIMILARITY: "This reads too much like another deal's same-position email. Lead with a DIFFERENT concrete detail from the prospect context and change the opening move, sentence rhythm, and paragraph count.",
  STRUCTURAL_UNIFORMITY: "Vary the shape: rewrite with a different paragraph count and rhythm than your previous draft (if it was multi-paragraph make it one tight paragraph, or vice versa).",
};

/** Rules that can only be judged ACROSS the corpus — never on a single email in isolation. */
export const CORPUS_RULES: ReadonlySet<string> = new Set(["CROSS_INSTANCE_SIMILARITY", "STRUCTURAL_UNIFORMITY"]);

// ── Helpers ──────────────────────────────────────────────────────────────────────────

/** A thread groups emails of one deal: the request id minus the trailing -<index>. */
const threadKey = (id: string) => id.replace(/-\d+$/, "");

// A real email signs off in several shapes — accept all of them:
//   "— Alex"      (em-dash/hyphen form, the static house style)
//   "Taylor"      (a bare first name on its own final line)
//   "Thanks,\nTaylor" / "Best,\nTaylor" (a closing line + name)
const DASH_SIGNOFF = /(?:^|\n)[ \t]*[—-][ \t]*([A-Za-z][\w'’.-]*)[ \t]*$/;
const BARE_SIGNOFF = /(?:^|\n)[ \t]*([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)[ \t]*$/; // 1–2 capitalized words, the whole final line
const CLOSING_LINE = /(?:^|\n)[ \t]*(thanks|thank you|best|cheers|talk soon|warmly|regards|all the best|appreciate it)[,!.]?[ \t]*$/i;

/** Locate the sign-off: the writer's first name + where the signature block starts. */
function signOffMatch(body: string): { name: string; index: number } | null {
  const t = body.trimEnd();
  const dash = DASH_SIGNOFF.exec(t);
  if (dash) return { name: dash[1]!, index: dash.index };
  const bare = BARE_SIGNOFF.exec(t);
  if (bare && bare[1]!.length <= 30) return { name: bare[1]!.split(/\s+/)[0]!, index: bare.index };
  return null;
}

/** The bare first name a body signs off with (any accepted shape), or null. */
function signOffName(body: string): string | null {
  return signOffMatch(body)?.name ?? null;
}

/** Body with the final sign-off (name + any preceding closing line) removed, so rules don't count the signature. */
function bodyWithoutSignoff(body: string): string {
  const t = body.trimEnd();
  const m = signOffMatch(t);
  if (!m) return t;
  return t.slice(0, m.index).replace(CLOSING_LINE, "").trimEnd();
}

/** Normalize a body for cross-instance comparison: blank out the specifics, keep the prose skeleton. */
function maskForSimilarity(body: string): string {
  let s = bodyWithoutSignoff(body);
  s = s.replace(/\$\s?\d[\d.,]*\s?(?:[mMkK]|million|thousand)?(?:\s?ARR)?/g, " AMOUNT "); // money
  s = s.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, " NAME "); // First Last
  s = s.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}\b/gi, " DATE "); // Aug 15
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " DATE ");
  return s.toLowerCase();
}

const tokenSet = (s: string) => new Set(s.split(/[^a-z]+/).filter((t) => t.length > 2));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const paragraphCount = (body: string) => bodyWithoutSignoff(body).split(/\n\s*\n+/).filter((p) => p.trim()).length;

// ── The linter ─────────────────────────────────────────────────────────────────────

/** Similarity at/above this between two same-(scenario,position) emails is a fatal clone. */
export const CROSS_INSTANCE_THRESHOLD = 0.45;
/** A corpus where this fraction or more of emails share one paragraph count is too uniform. */
export const STRUCTURAL_UNIFORMITY_THRESHOLD = 0.7;

/**
 * The minimal set of email ids to reshape to break STRUCTURAL_UNIFORMITY: the over-represented
 * paragraph-count bucket, just enough of them that the bucket falls below the threshold. Empty if
 * the corpus isn't actually uniform. Deterministic (id-sorted) so a re-run targets the same ones.
 */
export function dominantParagraphSubset(targets: LintTarget[]): string[] {
  if (targets.length < 5) return [];
  const buckets = new Map<number, string[]>();
  for (const t of targets) {
    const n = paragraphCount(t.result.body);
    (buckets.get(n) ?? buckets.set(n, []).get(n)!).push(t.result.id);
  }
  let dominant: string[] = [];
  for (const ids of buckets.values()) if (ids.length > dominant.length) dominant = ids;
  const total = targets.length;
  if (dominant.length / total < STRUCTURAL_UNIFORMITY_THRESHOLD) return [];
  const maxAllowed = Math.ceil(STRUCTURAL_UNIFORMITY_THRESHOLD * total) - 1; // largest bucket that won't trip the rule
  const k = Math.max(1, dominant.length - maxAllowed);
  return [...dominant].sort().slice(0, k);
}

export function lintCopy(targets: LintTarget[]): LintReport {
  const violations: LintViolation[] = [];
  const add = (id: string, rule: string, severity: Severity, detail: string) => violations.push({ id, rule, severity, detail });

  // ── per-email ──
  for (const { result } of targets) {
    const { id, body } = result;
    const subject = result.subject ?? "";
    const haystack = `${subject}\n${body}`;
    const proper = bodyWithoutSignoff(body);

    const money = /\$\d{1,3}(?:,\d{3})+/.exec(haystack);
    if (money) add(id, "ROUND_NUMBER_FORMAT", "high", `machine-format money "${money[0]}" — humans write $1.2M / ~$350K`);

    const sign = signOffName(body);
    if (sign) {
      const selfRef = new RegExp(`\\b${sign}\\b`).exec(proper);
      if (selfRef) add(id, "SELF_REFERENCE", "fatal", `sender signs "— ${sign}" but names "${sign}" in their own body (third-person-self)`);
    } else {
      add(id, "SIGNOFF_SHAPE", "low", "no first-name sign-off (— Name, a bare 'Name' line, or 'Thanks,\\nName')");
    }

    const dupAdjacent = /\b(\w+)\s+\1\b/i.exec(proper);
    if (dupAdjacent) add(id, "DOUBLED_FUNCTION_WORD", "high", `doubled word "${dupAdjacent[0]}"`);
    for (const sentence of proper.split(/[.!?]\s+/)) {
      for (const c of SENTENCE_CONNECTIVES) {
        const n = (sentence.toLowerCase().match(new RegExp(`\\b${c}\\b`, "g")) ?? []).length;
        if (n >= 2) {
          add(id, "DOUBLED_FUNCTION_WORD", "high", `"${c}" appears ${n}× in one sentence (concatenation seam)`);
          break;
        }
      }
    }

    const lc = haystack.toLowerCase();
    for (const p of FORBIDDEN_PHRASES) if (lc.includes(p)) add(id, "FORBIDDEN_PHRASE", "high", `AI-slop phrase "${p}"`);

    const firstLine = proper.split(/\n/)[0]?.trim() ?? "";
    for (const re of CONFESSIONAL_OPENERS) if (re.test(firstLine)) { add(id, "CONFESSIONAL_OPENER", "medium", `stock confessional opener "${firstLine.slice(0, 40)}…"`); break; }

    const emDashes = (proper.match(/—/g) ?? []).length;
    if (emDashes > 2) add(id, "EM_DASH_DENSITY", "low", `${emDashes} em-dashes (AI tic; keep ≤2)`);
  }

  // ── per-thread: "ARR" (or any unit) should not repeat on every email ──
  const threads = new Map<string, LintTarget[]>();
  for (const t of targets) {
    const k = threadKey(t.request.id);
    (threads.get(k) ?? threads.set(k, []).get(k)!).push(t);
  }
  for (const group of threads.values()) {
    const withArr = group.filter((t) => /\bARR\b/.test(t.result.body));
    if (withArr.length > 1) for (const t of withArr.slice(1)) add(t.result.id, "CURRENCY_UNIT_REPETITION", "medium", `"ARR" repeated across the thread (state it once, then "the deal"/"the expansion")`);
  }

  // ── corpus-level: cross-instance similarity (the headline anti-clone check) ──
  const byPosition = new Map<string, LintTarget[]>();
  for (const t of targets) {
    if (!t.request.seq) continue;
    const k = `${t.request.scenario}#${t.request.seq.index}`;
    (byPosition.get(k) ?? byPosition.set(k, []).get(k)!).push(t);
  }
  let maxSim = 0;
  for (const group of byPosition.values()) {
    if (group.length < 2) continue;
    const masked = group.map((t) => ({ id: t.result.id, set: tokenSet(maskForSimilarity(t.result.body)) }));
    for (let i = 0; i < masked.length; i++)
      for (let j = i + 1; j < masked.length; j++) {
        const sim = jaccard(masked[i]!.set, masked[j]!.set);
        if (sim > maxSim) maxSim = sim;
        if (sim >= CROSS_INSTANCE_THRESHOLD)
          add(masked[j]!.id, "CROSS_INSTANCE_SIMILARITY", "fatal", `${(sim * 100) | 0}% identical to ${masked[i]!.id} (same template, names swapped)`);
      }
  }

  // ── corpus-level: structural uniformity ──
  if (targets.length >= 5) {
    const counts = new Map<number, number>();
    for (const t of targets) counts.set(paragraphCount(t.result.body), (counts.get(paragraphCount(t.result.body)) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / targets.length >= STRUCTURAL_UNIFORMITY_THRESHOLD)
      add("<corpus>", "STRUCTURAL_UNIFORMITY", "high", `${((top / targets.length) * 100) | 0}% of emails share one paragraph count — vary structure`);
  }

  // ── tally ──
  const byRule: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { low: 0, medium: 0, high: 0, fatal: 0 };
  const dirtyIds = new Set<string>();
  for (const v of violations) {
    byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    bySeverity[v.severity]++;
    if (v.id !== "<corpus>") dirtyIds.add(v.id);
  }
  const emailsLinted = targets.length;
  const cleanEmails = emailsLinted - dirtyIds.size;
  return {
    violations,
    byRule,
    bySeverity,
    emailsLinted,
    cleanEmails,
    passRate: emailsLinted ? cleanEmails / emailsLinted : 1,
    maxCrossInstanceSimilarity: maxSim,
  };
}
