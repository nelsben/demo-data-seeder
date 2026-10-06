// packages/engine/src/drip/records.ts
//
// Turn one planned DraftBeat (beats.ts) into the actual insertable record + its CopyRequest — the
// field shapes mirror packs/salescloud/src/generate.ts's own dossier→record emission (same fields,
// same TaskSubtype='Email' requirement downstream email/activity triggers fan out on: a Call-subtype Task
// yields zero signals) so an appended beat is indistinguishable from one the original seed authored.
// Copy fields (Subject/TextBody/Description/VersionData) start empty; fillCopy/applyCopy (reused
// verbatim from the copy layer, not reimplemented — see ops/drip.ts) fill them from the CopyRequest
// built alongside each record here, matched by the shared `id`/`_ref`.

import type { CopyRequest, DossierBeat, GenericRecord } from "@dataseed/core";
import type { DraftBeat } from "./beats.js";

/** What the AE's fictional employer sells — deliberately mirrors generate.ts's own (unexported)
 *  SELLER_PITCH text so a drip-appended thread keeps pitching the SAME fictional vendor/product as the
 *  original seed. Not imported: generate.ts is out of scope to edit (and doesn't export it) for this task. */
export const DRIP_SELLER_PITCH =
  "a horizontal data, analytics & integration platform (Platform License + Advanced Analytics, API/Integrations, Sandbox, and Data Storage modules) that the AE's company sells INTO businesses across every industry. It is a back-office/operations tool for the prospect's INTERNAL teams (RevOps, data, IT, finance) — it is NOT the prospect's own product, industry, or customer-facing capability. Pitch how THIS platform helps their internal teams; never pitch them anything they themselves make or sell.";

/** Per-persona voice register — a short, stable descriptor so `voiceCard.register` (the copy prompt's
 *  "write as X, who sounds like Y" instruction) reads consistently, mirroring the intent of generate.ts's
 *  per-contact voice cards without needing the original (unrecoverable, for a reconstructed dossier) copy. */
const PERSONA_REGISTER: Record<string, string> = {
  "Economic Buyer": "terse and numbers-first, skeptical of anything not tied to ROI",
  Champion: "enthusiastic internally, direct, pushes for momentum",
  "Technical Evaluator": "precise, asks pointed technical questions",
  Skeptic: "guarded, raises objections plainly",
  Coach: "candid, shares internal context freely",
  Blocker: "noncommittal, slow to respond, hedges",
  "End User": "practical, focused on day-to-day usability",
  Stakeholder: "measured and professional",
};

export interface RecordParticipant {
  contactId: string;
  name: string;
  email?: string;
  persona: string;
}

export interface RecordTarget {
  oppId: string;
  accountName: string;
  amountUsd: number;
  closeDate?: string;
  primaryContactName?: string;
  aeName: string;
  aeEmail: string;
  /** The beat's buyer-side participant (resolved by the caller against the dossier's cast by ref),
   *  when the beat names one. Absent → the beat is entirely selling-side (an internal Task, e.g.). */
  participant?: RecordParticipant;
}

/** One planned beat realized as (record payload, CopyRequest) — both keyed by `id`, the ONLY value
 *  `applyCopy` needs to match a filled body back onto its record (`record._ref === copyRequest.id`).
 *  `record` still carries `_ref`/`_meta` bookkeeping keys; strip those (see `stripBookkeeping`) before
 *  handing the payload to a LoadTarget. */
export interface DrippedArtifact {
  id: string;
  object: "EmailMessage" | "Task" | "ContentVersion";
  record: GenericRecord;
  copyRequest: CopyRequest;
}

const priorityFor = (sentiment: DraftBeat["sentiment"]): string => (sentiment === "Risk" || sentiment === "Negative" ? "High" : "Normal");

/** Drop every `_`-prefixed bookkeeping key (`_ref`, `_meta`, ...) — what a LoadTarget actually inserts. */
export function stripBookkeeping(record: GenericRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

/**
 * Build the final insert-ready payload for one artifact: strip bookkeeping keys, keep only
 * createable fields, and — for a ContentVersion — base64-encode VersionData. Salesforce stores
 * ContentVersion.VersionData as a base64-encoded BLOB; loader.ts's own cascade encodes it at
 * insert-build time (load/loader.ts), but the drip's append-only path never goes through
 * loader.ts, so without this step a transcript beat's plain-text VersionData would insert as
 * unencoded bytes (Salesforce decodes the raw text AS base64 and stores garbage — the exact
 * failure mode loader.ts's own comment documents). Encoding an empty string is a no-op (stays "").
 */
export function buildInsertPayload(object: DrippedArtifact["object"], record: GenericRecord, createable: ReadonlySet<string>): Record<string, unknown> {
  const raw = stripBookkeeping(record);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (createable.has(k)) filtered[k] = v;
  if (object === "ContentVersion" && typeof filtered.VersionData === "string" && filtered.VersionData.length > 0) {
    filtered.VersionData = Buffer.from(filtered.VersionData, "utf8").toString("base64");
  }
  return filtered;
}

/** Realize one beat: build its record (copy fields blank) + its CopyRequest (facts/voice/beat wired
 *  through, exactly the shape fillCopy/applyCopy already know how to consume). `scenario`/`threadId`
 *  are the drip's own day-scoped values — the beat isn't part of the ORIGINAL generation thread, so it
 *  gets a thread of its own rather than a fabricated position in one it wasn't generated alongside. */
export function realizeBeat(id: string, beat: DraftBeat, target: RecordTarget, opts: { scenario: string; day: string }): DrippedArtifact {
  const fullBeat: DossierBeat = { ...beat, ref: id };
  const beatIntent = `${beat.summary}${beat.conveys ? ` ${beat.conveys}` : ""}`;
  const facts: NonNullable<CopyRequest["facts"]> = {
    amountUsd: target.amountUsd,
    ...(target.closeDate ? { closeDate: target.closeDate } : {}),
    ...(target.primaryContactName ? { primaryContact: target.primaryContactName } : {}),
    ...(target.participant ? { counterpart: target.participant.name } : {}),
    sells: DRIP_SELLER_PITCH,
  };
  const threadId = `drip-${opts.day}-${id}`;

  if (beat.kind === "email") {
    const incoming = beat.direction === "inbound";
    const p = target.participant;
    const record: GenericRecord = {
      _ref: id,
      RelatedToId: target.oppId,
      MessageDate: beat.day,
      Incoming: incoming,
      Status: incoming ? "0" : "3", // EmailMessage.Status (required): 0=New (inbound) / 3=Sent (outbound)
      FromAddress: incoming ? (p?.email ?? target.aeEmail) : target.aeEmail,
      FromName: beat.author,
      ToAddress: incoming ? target.aeEmail : (p?.email ?? target.aeEmail),
      Subject: "",
      TextBody: "",
      _meta: { drip: true, sentiment: beat.sentiment },
    };
    const copyRequest: CopyRequest = {
      id,
      kind: "email",
      scenario: opts.scenario,
      beatIntent,
      speakers: [beat.author],
      facts,
      seq: { index: 0, total: 1 },
      ...(p ? { voiceCard: { name: p.name, persona: p.persona, register: PERSONA_REGISTER[p.persona] ?? PERSONA_REGISTER.Stakeholder! } } : { voiceCard: { name: target.aeName, register: "direct, concrete, moves the deal forward" } }),
      threadId,
      seedSubject: `${target.accountName} — next steps`,
      beat: fullBeat,
    };
    return { id, object: "EmailMessage", record, copyRequest };
  }

  if (beat.kind === "task") {
    const p = target.participant;
    const record: GenericRecord = {
      _ref: id,
      WhatId: target.oppId,
      ...(p ? { WhoId: p.contactId } : {}),
      Subject: "",
      Description: "",
      ActivityDate: beat.day.slice(0, 10),
      Status: "Completed",
      Priority: priorityFor(beat.sentiment),
      TaskSubtype: "Email", // REQUIRED — many downstream email/activity triggers only fan out on Email-subtype Tasks; a Call-subtype Task produces no signal
      _meta: { drip: true, sentiment: beat.sentiment },
    };
    const copyRequest: CopyRequest = {
      id,
      kind: "task",
      scenario: opts.scenario,
      beatIntent,
      speakers: [target.aeName],
      facts,
      seq: { index: 0, total: 1 },
      voiceCard: { name: target.aeName, register: "direct, concrete, moves the deal forward" },
      threadId,
      beat: fullBeat,
    };
    return { id, object: "Task", record, copyRequest };
  }

  // transcript
  const day = beat.day.slice(0, 10);
  const p = target.participant;
  const record: GenericRecord = {
    _ref: id,
    FirstPublishLocationId: target.oppId, // Salesforce auto-creates the ContentDocumentLink on insert
    Title: `Einstein Conversation Insights transcript — ${target.accountName} (${day})`,
    PathOnClient: `eci-call-${day}.vtt`,
    VersionData: "",
    Description: `Transcript of a call with ${p?.name ?? "the prospect"} on the ${target.accountName} deal, via Einstein Conversation Insights.`,
    _meta: { drip: true, sentiment: beat.sentiment },
  };
  const copyRequest: CopyRequest = {
    id,
    kind: "transcript",
    scenario: opts.scenario,
    beatIntent,
    speakers: [p?.name ?? target.aeName, target.aeName],
    facts,
    seq: { index: 0, total: 1 },
    ...(p ? { voiceCard: { name: p.name, persona: p.persona, register: PERSONA_REGISTER[p.persona] ?? PERSONA_REGISTER.Stakeholder! } } : {}),
    threadId,
    beat: fullBeat,
  };
  return { id, object: "ContentVersion", record, copyRequest };
}
