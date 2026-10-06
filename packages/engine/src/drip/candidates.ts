// packages/engine/src/drip/candidates.ts
//
// Org-facing reads for the drip: the open-deal candidate list (select.ts's input), a deal's real
// dossier when the registry still has it, and the raw rows dossier.ts's reconstruction needs when it
// doesn't. Thin — every function here just shapes an SfClient/SOQL result into the plain data the pure
// drip/ modules consume; no decision logic lives here.

import type { SfClient } from "../introspect/sf-client.js";
import { openRegistry, type RegistryStore } from "@dataseed/registry";
import { latestDatasetFor } from "../store/bundle-store.js";
import type { DealDossier } from "@dataseed/core";
import type { DripCandidate } from "./types.js";
import type { ReconstructCastRow, ReconstructEmailRow, ReconstructTaskRow, ReconstructTranscriptRow } from "./dossier.js";

const CANDIDATE_LIMIT = 200;

interface OppRow {
  Id: string;
  Name: string;
  StageName: string;
  Amount?: number;
  CloseDate?: string;
  LastActivityDate?: string | null;
  CreatedDate: string;
  OwnerId?: string;
  Owner?: { Name?: string };
  Account?: { Id?: string; Name?: string };
}

/** Best-effort arc lookup: the registry's latest (org, pack) dataset, if any, indexed by Opportunity
 *  Name → its dossier's `scenario`. Read ONCE per candidate query (not per candidate) — a single dataset
 *  covers every deal it seeded. Returns an empty map (never throws) when there's no registry dataset
 *  for this org — every candidate then gets the neutral "unknown" arc in `findDripCandidates`. */
function arcByOppName(store: RegistryStore, org: string, pack: string): Map<string, string> {
  const ds = latestDatasetFor(store, org, pack);
  const out = new Map<string, string>();
  if (!ds) return out;
  for (const opp of ds.bundle.records.Opportunity ?? []) {
    const name = opp.Name;
    const dossier = (opp._meta as { dossier?: DealDossier } | undefined)?.dossier;
    if (typeof name === "string" && dossier?.scenario) out.set(name, dossier.scenario);
  }
  return out;
}

/** The full list of open-deal candidates for `org` — select.ts's input. One SOQL query + one registry
 *  read (not per-candidate). `lastInteractionDate` uses Opportunity.LastActivityDate (Salesforce's own
 *  Task/Event rollup) falling back to CreatedDate — a serviceable proxy; it doesn't reflect EmailMessage
 *  activity Salesforce doesn't log as a Task, a documented limitation (see docs/drip.md). */
export async function findDripCandidates(client: SfClient, org: string, pack: string): Promise<DripCandidate[]> {
  const rows = await client.query<OppRow>(
    `SELECT Id, Name, StageName, Amount, CloseDate, LastActivityDate, CreatedDate, OwnerId, Owner.Name, Account.Id, Account.Name ` +
      `FROM Opportunity WHERE IsClosed = false AND Account.Name != null ORDER BY LastActivityDate ASC NULLS FIRST, CreatedDate ASC LIMIT ${CANDIDATE_LIMIT}`,
  );
  const store = openRegistry();
  let arcs: Map<string, string>;
  try {
    arcs = arcByOppName(store, org, pack);
  } finally {
    store.close();
  }
  return rows
    .filter((r) => typeof r.Account?.Name === "string")
    .map((r) => ({
      oppId: r.Id,
      oppName: r.Name,
      accountId: r.Account!.Id!,
      accountName: r.Account!.Name!,
      arc: arcs.get(r.Name) ?? "unknown",
      stageName: r.StageName,
      ownerId: r.OwnerId,
      ownerName: r.Owner?.Name,
      lastInteractionDate: r.LastActivityDate ?? r.CreatedDate,
    }));
}

/** The real, originally-authored dossier for one deal — from the registry's latest (org, pack) bundle,
 *  matched by Opportunity Name (the seeder's natural key; see docs/open-questions/m4-loader-hardening.md
 *  on why Name, not a synthetic external id, is how this repo re-finds its own records). null when the
 *  registry has no dataset for this org, or this deal isn't in it — the caller falls back to reconstruction. */
export function findRegistryDossier(org: string, pack: string, oppName: string): DealDossier | null {
  const store = openRegistry();
  try {
    const ds = latestDatasetFor(store, org, pack);
    if (!ds) return null;
    const opp = (ds.bundle.records.Opportunity ?? []).find((o) => o.Name === oppName);
    return (opp?._meta as { dossier?: DealDossier } | undefined)?.dossier ?? null;
  } finally {
    store.close();
  }
}

/** The raw rows dossier.ts's `reconstructDealDossier` needs for one Opportunity, read directly from the
 *  org: its buying committee (OpportunityContactRole → Contact) + existing EmailMessage/Task/ContentVersion
 *  history. Capped per stream so a long-lived deal doesn't blow the SOQL row budget on a daily op. */
export async function fetchReconstructionRows(
  client: SfClient,
  oppId: string,
): Promise<{ cast: ReconstructCastRow[]; emails: ReconstructEmailRow[]; tasks: ReconstructTaskRow[]; transcripts: ReconstructTranscriptRow[] }> {
  const [ocrRows, emailRows, taskRows, cvRows] = await Promise.all([
    client.query<{ ContactId: string; Contact?: { Name?: string }; Role?: string }>(
      `SELECT ContactId, Contact.Name, Role FROM OpportunityContactRole WHERE OpportunityId = '${oppId}'`,
    ),
    client.query<{ Id: string; RelatedToId: string; Subject?: string; TextBody?: string; MessageDate: string; FromName?: string; Incoming?: boolean }>(
      `SELECT Id, RelatedToId, Subject, TextBody, MessageDate, FromName, Incoming FROM EmailMessage WHERE RelatedToId = '${oppId}' ORDER BY MessageDate ASC LIMIT 50`,
    ),
    client.query<{ Id: string; WhatId: string; Who?: { Name?: string }; Subject?: string; Description?: string; ActivityDate: string }>(
      `SELECT Id, WhatId, Who.Name, Subject, Description, ActivityDate FROM Task WHERE WhatId = '${oppId}' ORDER BY ActivityDate ASC LIMIT 50`,
    ),
    client.query<{ Id: string; Title?: string; CreatedDate: string }>(
      `SELECT Id, Title, CreatedDate FROM ContentVersion WHERE FirstPublishLocationId = '${oppId}' ORDER BY CreatedDate ASC LIMIT 50`,
    ),
  ]);
  return {
    cast: ocrRows.filter((r) => !!r.ContactId).map((r) => ({ contactId: r.ContactId, name: r.Contact?.Name ?? "Unknown Contact", role: r.Role })),
    emails: emailRows.map((r) => ({ id: r.Id, relatedToId: r.RelatedToId, subject: r.Subject, textBody: r.TextBody, messageDate: r.MessageDate, fromName: r.FromName, incoming: r.Incoming })),
    tasks: taskRows.map((r) => ({ id: r.Id, whatId: r.WhatId, whoName: r.Who?.Name, subject: r.Subject, description: r.Description, activityDate: r.ActivityDate })),
    transcripts: cvRows.map((r) => ({ id: r.Id, title: r.Title, createdDate: r.CreatedDate })),
  };
}

export interface ContactIdsByNameResult {
  /** Name → Id, for every UNAMBIGUOUS name (exactly one distinct ContactId observed for it). */
  byName: Map<string, string>;
  /** Names that mapped to more than one distinct ContactId — excluded from `byName` entirely rather
   *  than picking one arbitrarily (see the ambiguity note below). The caller logs these. */
  ambiguousNames: string[];
}

/**
 * Real Contact.Id by name, for this Opportunity's buying committee — the reconciliation a REGISTRY
 * dossier needs before its cast can be trusted for a real Salesforce lookup field. A registry dossier's
 * `cast[].ref` is the PLAN-TIME bundle `_ref` ("contact-1-0"), never updated to the real Id the loader
 * assigned at insert time (the registry stores the planned bundle, not a post-load reconciliation) —
 * live-caught on `dev-frontend`: inserting it as `Task.WhoId` fails `MALFORMED_ID`. Matched by
 * Contact.Name (the same natural key `docs/open-questions/m4-loader-hardening.md` uses elsewhere),
 * since a registry cast member's `name` DOES match the real seeded Contact's Name.
 *
 * AMBIGUITY GUARD: when this Opportunity's OpportunityContactRole set has two (or more) DISTINCT
 * Contacts sharing the same Name, matching by name alone can't tell them apart — silently keeping
 * either one risks attaching a beat to the wrong person. Such a name is dropped from `byName` and
 * reported in `ambiguousNames` instead, so the caller can log it and fall back to the existing
 * graceful-degrade path (participant omitted) rather than guess. A name with NO OCR match at all
 * (rare — a Contact renamed/removed post-seed) simply isn't in `byName` either, same fallback.
 */
export async function fetchContactIdsByName(client: SfClient, oppId: string): Promise<ContactIdsByNameResult> {
  const rows = await client.query<{ ContactId: string; Contact?: { Name?: string } }>(
    `SELECT ContactId, Contact.Name FROM OpportunityContactRole WHERE OpportunityId = '${oppId}'`,
  );
  const idsByName = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.Contact?.Name || !r.ContactId) continue;
    const set = idsByName.get(r.Contact.Name) ?? new Set<string>();
    set.add(r.ContactId);
    idsByName.set(r.Contact.Name, set);
  }
  const byName = new Map<string, string>();
  const ambiguousNames: string[] = [];
  for (const [name, ids] of idsByName) {
    if (ids.size === 1) byName.set(name, [...ids][0]!);
    else ambiguousNames.push(name);
  }
  return { byName, ambiguousNames };
}

/** Opportunity Owner + a couple of scalar fields the record/copy layer needs, plus the primary
 *  Contact's name (OCR's first row) — kept separate from `findDripCandidates`'s cheap listing query
 *  since it's only fetched for the deals actually SELECTED for today. */
export async function fetchDealFacts(
  client: SfClient,
  oppId: string,
): Promise<{ amountUsd: number; closeDate?: string; stageName?: string; ownerName: string; ownerEmail?: string }> {
  const rows = await client.query<{ Amount?: number; CloseDate?: string; StageName?: string; Owner?: { Name?: string; Email?: string } }>(
    `SELECT Amount, CloseDate, StageName, Owner.Name, Owner.Email FROM Opportunity WHERE Id = '${oppId}' LIMIT 1`,
  );
  const r = rows[0];
  return {
    amountUsd: r?.Amount ?? 0,
    closeDate: r?.CloseDate,
    stageName: r?.StageName,
    ownerName: r?.Owner?.Name ?? "the Account Executive",
    ownerEmail: r?.Owner?.Email,
  };
}
