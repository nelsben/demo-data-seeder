// packages/engine/src/drip/dossier.ts
//
// Getting a DealDossier for a candidate deal — the continuity primitive select.ts/beats.ts build on
// (packages/core/src/dossier.ts). Two sources, cheapest first:
//   1. The registry's own bundle for (org, pack) — if the deal was seeded through plan-demo, its
//      Opportunity carries the REAL authored dossier on `_meta.dossier` (scenario/arc/cast/beats),
//      merged with any spine LLM draft cache (fill-copy --spine). This is strictly the richest source.
//   2. ORG reconstruction (docs/open-questions/m4-loader-hardening.md's "reconstruct from what's
//      there") — when the registry is gone/stale/never ran for this org (e.g. the operator loaded onto an org
//      whose local .dataseed state didn't travel with it). Walks the Opportunity's OpportunityContactRoles
//      + existing EmailMessage/Task/ContentVersion, oldest first, into DossierBeats. `scenario` can't be
//      recovered this way (nothing in the org records it) — reconstructed dossiers get the neutral
//      "steady-progress" arc rather than a guessed one; beats.ts's DEFAULT_TEMPLATE handles it honestly.
//
// Either way, the result (extended with today's new beats by the op) is cached at
// `.dataseed/dossiers/<org>/<oppId>.json` keyed by (seed, org, oppId) so day 2 skips both the registry
// walk and the org reconstruction — pure local-file read, "day 2 is cheap" per the brief.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DealDossier, type DossierBeat, type DossierSentiment } from "@dataseed/core";

const FALLBACK_ARC = "steady-progress";

export interface ReconstructEmailRow {
  id: string;
  relatedToId: string;
  subject?: string | null;
  textBody?: string | null;
  messageDate: string;
  fromName?: string | null;
  incoming?: boolean | null;
}
export interface ReconstructTaskRow {
  id: string;
  whatId: string;
  whoName?: string | null;
  subject?: string | null;
  description?: string | null;
  activityDate: string;
}
export interface ReconstructTranscriptRow {
  id: string;
  title?: string | null;
  createdDate: string;
}
export interface ReconstructCastRow {
  contactId: string;
  name: string;
  role?: string | null;
}

export interface ReconstructInput {
  oppId: string;
  oppName: string;
  accountName: string;
  amountUsd: number;
  closeDate?: string;
  stageName?: string;
  cast: ReconstructCastRow[];
  emails: ReconstructEmailRow[];
  tasks: ReconstructTaskRow[];
  transcripts: ReconstructTranscriptRow[];
}

/** First ~140 chars of a body, collapsed to one line — a compact summary when there's no dossier
 *  narrative to draw one from (org reconstruction only; the real dossier always has authored summaries). */
function synopsize(text: string | null | undefined, fallback: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
}

/** Best-effort OpportunityContactRole Role → a persona label the copy prompt understands (falls back
 *  to a generic "Stakeholder" — never invents a MEDDPICC-flavored persona the role doesn't support). */
function personaFromRole(role: string | null | undefined): string {
  const r = (role ?? "").toLowerCase();
  if (r.includes("decision") || r.includes("economic")) return "Economic Buyer";
  if (r.includes("champion") || r.includes("influencer")) return "Champion";
  if (r.includes("technical") || r.includes("evaluator")) return "Technical Evaluator";
  if (r.includes("procurement") || r.includes("legal")) return "Skeptic";
  if (r.includes("user")) return "End User";
  return "Stakeholder";
}

/** Build a DealDossier skeleton directly from ORG rows (no registry, no LLM) — pure function of
 *  already-fetched data, so it's unit-testable without a live org. */
export function reconstructDealDossier(input: ReconstructInput): DealDossier {
  const cast: DealDossier["cast"] = input.cast.map((c) => ({ ref: c.contactId, name: c.name, persona: personaFromRole(c.role) }));
  const castByName = new Map(cast.map((c) => [c.name, c]));

  type Timed = { day: string; beat: DossierBeat };
  const timed: Timed[] = [];

  for (const e of input.emails) {
    const incoming = !!e.incoming;
    const participant = incoming ? [...castByName.values()].find((c) => c.name === e.fromName) : undefined;
    const sentiment: DossierSentiment = "Neutral"; // unrecoverable from org fields alone — see file header
    timed.push({
      day: e.messageDate,
      beat: {
        ref: e.id,
        kind: "email",
        day: e.messageDate,
        author: e.fromName ?? (incoming ? "the prospect" : "the Account Executive"),
        ...(participant ? { authorRef: participant.ref, participantRef: participant.ref } : {}),
        direction: incoming ? "inbound" : "outbound",
        sentiment,
        summary: synopsize(e.subject || e.textBody, "an email touch on the deal"),
      },
    });
  }
  for (const t of input.tasks) {
    const who = t.whoName ? castByName.get(t.whoName) : undefined;
    timed.push({
      day: `${t.activityDate}T12:00:00.000Z`,
      beat: {
        ref: t.id,
        kind: "task",
        day: `${t.activityDate}T12:00:00.000Z`,
        author: "the Account Executive",
        ...(who ? { participantRef: who.ref } : {}),
        sentiment: "Neutral",
        summary: synopsize(t.subject || t.description, "a logged activity on the deal"),
      },
    });
  }
  for (const c of input.transcripts) {
    timed.push({
      day: c.createdDate,
      beat: {
        ref: c.id,
        kind: "transcript",
        day: c.createdDate,
        author: "the Account Executive",
        sentiment: "Neutral",
        summary: synopsize(c.title, "a recorded call on the deal"),
      },
    });
  }

  timed.sort((a, b) => a.day.localeCompare(b.day));

  return DealDossier.parse({
    scenario: FALLBACK_ARC,
    arc: `${input.accountName}'s deal, reconstructed from ${timed.length} existing interaction(s) — no original narrative was recoverable, so this is a neutral steady-progress read.`,
    cast,
    beats: timed.map((t) => t.beat),
    numbers: { amountUsd: input.amountUsd },
    ...(input.stageName ? { stageName: input.stageName } : {}),
    provenance: "static",
  });
}

// ── Cache (file + memory), keyed by (seed, org, oppId) — mirrors checkpoint.ts / spine/cache.ts ─────

export interface DripDossierCache {
  get(key: string): DealDossier | null;
  set(key: string, dossier: DealDossier): void;
}

export const dripDossierKey = (seed: string | number, org: string, oppId: string): string => `${seed}:${org}:${oppId}`;
const slug = (key: string): string => key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 150);

/** File-backed cache under `root` (the op passes `.dataseed/dossiers`, the SAME root the spine's LLM
 *  draft cache uses — distinct filenames via the (seed,org,oppId) key so the two never collide). */
export function fileDripDossierCache(root: string): DripDossierCache {
  return {
    get(key) {
      const path = join(root, `drip-${slug(key)}.json`);
      if (!existsSync(path)) return null;
      try {
        return DealDossier.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return null; // corrupt/stale cache → treat as a miss, never crash the run
      }
    },
    set(key, dossier) {
      const path = join(root, `drip-${slug(key)}.json`);
      mkdirSync(root, { recursive: true });
      writeFileSync(path, JSON.stringify(dossier, null, 2) + "\n");
    },
  };
}

/** In-memory cache — tests + a single-process run with no persistence. */
export function memoryDripDossierCache(initial?: Record<string, DealDossier>): DripDossierCache {
  const m = new Map<string, DealDossier>(initial ? Object.entries(initial) : []);
  return {
    get: (key) => m.get(key) ?? null,
    set: (key, dossier) => void m.set(key, dossier),
  };
}

// ── The fallback chain: cache → registry → org reconstruction ──────────────────────────────────────
//
// Dependency-injected (not tied to SfCliClient/candidates.ts's concrete registry access) so the chain
// itself — which source wins, and that a hit short-circuits the rest — is unit-testable with plain
// mock functions, no real org or registry.db needed. ops/drip.ts supplies the real implementations
// (candidates.ts's `findRegistryDossier`/`fetchReconstructionRows`/`fetchDealFacts`).

export interface DossierResolverDeps {
  /** Registry lookup — synchronous (a local SQLite read), null on a miss. */
  findRegistryDossier: (org: string, pack: string, oppName: string) => DealDossier | null;
  /** Raw org rows for reconstruction (only called on a registry miss). */
  fetchReconstructionRows: (oppId: string) => Promise<{
    cast: ReconstructCastRow[];
    emails: ReconstructEmailRow[];
    tasks: ReconstructTaskRow[];
    transcripts: ReconstructTranscriptRow[];
  }>;
  /** Deal scalars reconstruction needs (only called on a registry miss). */
  fetchDealFacts: (oppId: string) => Promise<{ amountUsd: number; closeDate?: string; stageName?: string }>;
}

export interface ResolveDripDossierInput {
  org: string;
  pack: string;
  seed: string | number;
  oppId: string;
  oppName: string;
  accountName: string;
}

/**
 * Resolve one deal's dossier, cheapest source first: the drip's own extended-dossier cache (day 2+,
 * free) → the registry's originally-authored dossier (richest cold-start; cached once found so day 2
 * skips the registry read too) → org reconstruction (last resort; cached once built). Never throws —
 * a deal with zero recoverable history still gets a minimal reconstructed dossier.
 */
export async function resolveDripDossier(cache: DripDossierCache, deps: DossierResolverDeps, input: ResolveDripDossierInput): Promise<DealDossier> {
  const key = dripDossierKey(input.seed, input.org, input.oppId);
  const cached = cache.get(key);
  if (cached) return cached;

  const fromRegistry = deps.findRegistryDossier(input.org, input.pack, input.oppName);
  if (fromRegistry) {
    cache.set(key, fromRegistry);
    return fromRegistry;
  }

  const rows = await deps.fetchReconstructionRows(input.oppId);
  const facts = await deps.fetchDealFacts(input.oppId);
  const reconstructed = reconstructDealDossier({
    oppId: input.oppId,
    oppName: input.oppName,
    accountName: input.accountName,
    amountUsd: facts.amountUsd,
    ...(facts.closeDate ? { closeDate: facts.closeDate } : {}),
    ...(facts.stageName ? { stageName: facts.stageName } : {}),
    cast: rows.cast,
    emails: rows.emails,
    tasks: rows.tasks,
    transcripts: rows.transcripts,
  });
  cache.set(key, reconstructed);
  return reconstructed;
}
