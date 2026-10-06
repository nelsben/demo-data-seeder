// packages/engine/src/ops/drip.ts
//
// `drip` — insert 1-2 new, story-consistent interactions on a few open deals THROUGH THE REAL
// Salesforce trigger→queue→LLM→signal pipeline, so a demo org keeps producing fresh downstream
// signal/brief/summary data instead of reading a frozen world (see docs/drip.md
// and CLAUDE.md's "Why" section). Deliberately NOT loader.ts's cascade: this is an APPEND-ONLY insert
// against EXISTING Salesforce Ids, natural-key deduped per record (drip/dedupe.ts) rather than
// root-Account-grained, and it never touches the dataset registry's own bundle. DRY-RUN BY DEFAULT
// (prints the plan, writes nothing) — pass --yes to actually insert.
//
// check  = auth (post-#94 fix) + storage-reserve probe + candidate deals exist.
// run    = select today's deals (drip/select.ts) → resolve/extend each one's dossier (drip/dossier.ts)
//          → plan the next beat(s) (drip/beats.ts) → realize records (drip/records.ts) → dedupe against
//          the org (drip/dedupe.ts) → fill copy via the REUSED fillCopy pipeline (same prompt, same
//          realism gate as fill-copy.ts) → insert → write the day's manifest (drip/manifest.ts) → record
//          the run in the registry's load-history.
// verify = poll the org read-only for up to 90s for Signal_Ingestion_Queue__c rows the insert caused —
//          "the drip wrote, but the org's pipeline did not hear it" is the demo-truth failure this exists to catch.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRegistry } from "@dataseed/registry";
import type { CopyResult, DealDossier } from "@dataseed/core";
import type { Op } from "./types.js";
import { SfCliClient } from "../introspect/sf-client.js";
import { getAccessInfo, JsforceLoadTarget, type LoadTarget } from "../load/connection.js";
import { buildProviders, fillCopy } from "../copy/index.js";
import { selectDayPlan } from "../drip/select.js";
import { planNextBeats, type DraftBeat } from "../drip/beats.js";
import { realizeBeat, buildInsertPayload, type DrippedArtifact, type RecordParticipant } from "../drip/records.js";
import { dedupeAgainstOrg, naturalKey as dripNaturalKey } from "../drip/dedupe.js";
import { buildManifest, planDripTeardown, type DripManifest, type DripManifestRecord } from "../drip/manifest.js";
import { fileDripDossierCache, dripDossierKey, resolveDripDossier, type DripDossierCache, type DossierResolverDeps } from "../drip/dossier.js";
import { findDripCandidates, findRegistryDossier, fetchReconstructionRows, fetchDealFacts, fetchContactIdsByName } from "../drip/candidates.js";
import type { DripCandidate } from "../drip/types.js";

/** This op only ever touches standard Sales Cloud objects seeded by the salescloud pack — no --pack
 *  flag (matches the brief's fixed arg list); hardcoded rather than defaulted so it's never silently
 *  pointed at a pack that doesn't emit EmailMessage/Task/ContentVersion dossiers. */
const PACK_ID = "salescloud";

/** Mirrors introspect/probes.ts's RESERVE (0.2) — duplicated locally because probes.ts is out of scope
 *  for this task (not in the SEEDER-DRIP brief's file scope) and the drip needs its own storage gate. */
const STORAGE_RESERVE = 0.2;

/** Mirrors packs/salescloud/src/generate.ts's (unexported) SELLER_DOMAIN — duplicated because the
 *  engine may never import a pack back (README's "the engine drives the pack through a contract and
 *  never imports it back"), and generate.ts is out of scope to edit for this task. */
const AE_EMAIL_DOMAIN = "meridianiq.com";
const syntheticAeEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${AE_EMAIL_DOMAIN}`;

export const DRIP_DIR = (org: string) => join(process.cwd(), ".dataseed", "drip", org);
export const dripManifestPath = (org: string, day: string) => join(DRIP_DIR(org), `${day}.json`);
export const DOSSIER_CACHE_ROOT = join(process.cwd(), ".dataseed", "dossiers");

/** Every drip manifest ever written for `org` (used by both `verify()` display and `teardown-demo
 *  --include-drip`). Missing/corrupt files are skipped, not fatal. */
export function readAllDripManifests(org: string): DripManifest[] {
  const dir = DRIP_DIR(org);
  if (!existsSync(dir)) return [];
  const out: DripManifest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as DripManifest);
    } catch {
      /* corrupt/partial file — skip it, never crash a read */
    }
  }
  return out;
}

function writeDripManifest(m: DripManifest): void {
  mkdirSync(DRIP_DIR(m.org), { recursive: true });
  writeFileSync(dripManifestPath(m.org, m.day), JSON.stringify(m, null, 2) + "\n");
}

interface DripArgs extends Record<string, unknown> {
  org: string;
  seed: string | number;
  day: string;
  accounts: number;
  beats: number;
  provider: string;
  yes: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Builds the dependency-injected fallback-chain deps for `resolveDripDossier` (drip/dossier.ts),
 *  binding candidates.ts's registry/org-reconstruction helpers to this op's live `client`. The chain
 *  itself — cache → registry → org reconstruction — lives in dossier.ts so it's unit-testable with
 *  plain mock deps; this is just the glue. */
function dossierDeps(client: SfCliClient): DossierResolverDeps {
  return {
    findRegistryDossier: (org, pack, oppName) => findRegistryDossier(org, pack, oppName),
    fetchReconstructionRows: (oppId) => fetchReconstructionRows(client, oppId),
    fetchDealFacts: (oppId) => fetchDealFacts(client, oppId),
  };
}

/** kind → which record fields carry the filled subject/body — mirrors copy/orchestrate.ts's FIELD_MAP.
 *  Reimplemented (not imported) because `applyCopy` takes a full `NarrativeBundle`, and building a fake
 *  one just to satisfy that type would be more code than this table for the 3 kinds the drip emits. */
const COPY_FIELD_MAP: Record<DrippedArtifact["object"], { subject?: string; body: string }> = {
  EmailMessage: { subject: "Subject", body: "TextBody" },
  Task: { subject: "Subject", body: "Description" },
  ContentVersion: { body: "VersionData" },
};

function applyFilledCopy(artifacts: DrippedArtifact[], results: CopyResult[]): void {
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const a of artifacts) {
    const res = byId.get(a.id);
    if (!res) continue;
    const map = COPY_FIELD_MAP[a.object];
    if (map.subject && res.subject != null) a.record[map.subject] = res.subject;
    a.record[map.body] = res.body;
  }
}

/** One deal's plan for today — built once, then either printed (dry run) or realized (--yes). */
interface DealPlan {
  candidate: DripCandidate;
  dossier: DealDossier;
  draftBeats: DraftBeat[];
  artifacts: DrippedArtifact[];
}

async function buildDealPlans(client: SfCliClient, cache: DripDossierCache, args: DripArgs, day: string, selected: DripCandidate[], log: (...a: unknown[]) => void): Promise<DealPlan[]> {
  const beatsCount: 1 | 2 = args.beats === 2 ? 2 : 1;
  const plans: DealPlan[] = [];
  for (const cand of selected) {
    const dossier = await resolveDripDossier(cache, dossierDeps(client), { org: args.org, pack: PACK_ID, seed: args.seed, oppId: cand.oppId, oppName: cand.oppName, accountName: cand.accountName });
    const draftBeats = planNextBeats(dossier, { seed: args.seed, day, count: beatsCount });
    if (draftBeats.length === 0) {
      plans.push({ candidate: cand, dossier, draftBeats: [], artifacts: [] });
      continue;
    }
    const facts = await fetchDealFacts(client, cand.oppId);
    const aeName = facts.ownerName;
    const aeEmail = facts.ownerEmail ?? syntheticAeEmail(aeName);
    const primaryContact = dossier.cast[0];
    const castByRef = new Map(dossier.cast.map((c) => [c.ref, c]));
    // A REGISTRY dossier's cast[].ref is a plan-time bundle ref ("contact-1-0"), never the real
    // Salesforce Id the loader assigned — reconcile by Contact.Name before trusting it as WhoId
    // (live-caught on dev-frontend: MALFORMED_ID on Task.WhoId without this).
    const { byName: realContactIdByName, ambiguousNames } = await fetchContactIdsByName(client, cand.oppId);
    for (const name of ambiguousNames) {
      log(`${cand.accountName} — "${cand.oppName}": ambiguous contact name "${name}" (multiple distinct Contacts share it) — omitting the participant rather than guessing which one`);
    }

    const artifacts = draftBeats.map((beat, i) => {
      const id = `drip-${day}-${cand.oppId}-${i}`;
      const p = beat.participantRef ? castByRef.get(beat.participantRef) : undefined;
      const realContactId = p ? realContactIdByName.get(p.name) : undefined;
      const participant: RecordParticipant | undefined = p && realContactId ? { contactId: realContactId, name: p.name, persona: p.persona } : undefined;
      return realizeBeat(
        id,
        beat,
        {
          oppId: cand.oppId,
          accountName: cand.accountName,
          amountUsd: facts.amountUsd,
          ...(facts.closeDate ? { closeDate: facts.closeDate } : {}),
          ...(primaryContact ? { primaryContactName: primaryContact.name } : {}),
          aeName,
          aeEmail,
          ...(participant ? { participant } : {}),
        },
        { scenario: dossier.scenario, day },
      );
    });
    plans.push({ candidate: cand, dossier, draftBeats, artifacts });
  }
  return plans;
}

function formatPlanLine(plan: DealPlan, index: number): string[] {
  const lines: string[] = [];
  const { candidate: c, artifacts } = plan;
  lines.push(`  ${index + 1}. ${c.accountName} — "${c.oppName}" (arc: ${c.arc})`);
  if (artifacts.length === 0) {
    lines.push(`     (quiet today — this arc's cadence skipped authoring a beat)`);
    return lines;
  }
  for (const a of artifacts) {
    const headline = a.object === "EmailMessage" ? (a.copyRequest.seedSubject ?? "(no subject)") : a.object === "ContentVersion" ? (a.record.Title as string) : a.copyRequest.beatIntent;
    lines.push(`     beat: ${a.object} (${a.copyRequest.beat?.sentiment ?? "Neutral"}) — ${a.copyRequest.speakers[0] ?? "the Account Executive"} — "${headline}"`);
  }
  return lines;
}

export const dripOp: Op<DripArgs> = {
  id: "drip",
  name: "Daily story-consistent interactions through the org's activity pipeline",
  description:
    "Insert 1-2 new EmailMessage/Task/ContentVersion interactions on a few open deals, story-consistent with each deal's dossier, so a demo org's real trigger→queue→LLM→signal pipeline keeps producing fresh intelligence instead of reading a frozen snapshot. Append-only (natural-key deduped, not root-Account idempotency) — never touches the plan-demo/load-demo registry bundle. DRY-RUN BY DEFAULT; pass --yes to write.",
  idempotent: true,
  prerequisites: ["a previously loaded org with open Opportunities (load-demo, or any real pipeline)", "sf authenticated to the org"],
  affects: [
    "<org>: inserts a small number of EmailMessage/Task/ContentVersion records on existing open Opportunities (dry-run by default; --yes to write)",
    ".dataseed/drip/<org>/<day>.json (manifest of what was inserted)",
    ".dataseed/dossiers/ (drip's reconstructed-dossier cache, keyed by seed+org+opp)",
    "registry: appends a load-history entry (op=drip) — --yes only",
  ],
  args: {
    org: { type: "string", required: true, description: "Target org alias." },
    seed: { type: "string", default: 42, description: "Reproducibility seed for deal selection + beat authoring (number or memorable string)." },
    day: { type: "string", description: "ISO date (YYYY-MM-DD) to drip for (default: today, local machine's UTC date)." },
    accounts: { type: "number", default: 3, description: "Max open deals to touch today." },
    beats: { type: "number", default: 1, description: "New beats per touched deal — 1 or 2 (validated at run time; ArgSpec.enum is string-only and would misfire against the CLI's numeric coercion)." },
    provider: { type: "string", default: "claude-code", enum: ["auto", "anthropic", "claude-code", "static"], description: "Copy provider for the new beats' prose — same providers/realism gate as fill-copy." },
    yes: { type: "boolean", default: false, description: "Actually write. Without it: DRY RUN — prints the plan (deal, cast member, beat kind, subject line, record count) and writes nothing." },
  },

  async check(args, ctx) {
    const day = args.day || todayIso();
    let authOk = true;
    let authError: string | undefined;
    try {
      await getAccessInfo(args.org);
    } catch (e) {
      authOk = false;
      authError = (e as Error).message;
    }

    let storageOk = true;
    let remainingStorageMB: number | undefined;
    let storageMaxMB: number | undefined;
    if (authOk) {
      try {
        const client = new SfCliClient(args.org);
        const rows = await client.limits();
        const ds = rows.find((r) => r.name === "DataStorageMB");
        if (ds && ds.max > 0) {
          remainingStorageMB = ds.remaining;
          storageMaxMB = ds.max;
          storageOk = ds.remaining / ds.max >= STORAGE_RESERVE;
        }
      } catch (e) {
        ctx.log(`storage probe failed (continuing): ${(e as Error).message}`);
      }
    }

    let candidateCount = 0;
    if (authOk) {
      try {
        const client = new SfCliClient(args.org);
        const candidates = await findDripCandidates(client, args.org, PACK_ID);
        candidateCount = candidates.length;
      } catch (e) {
        ctx.log(`candidate probe failed (continuing): ${(e as Error).message}`);
      }
    }

    return {
      alreadyDone: false,
      day,
      authOk,
      ...(authError ? { authError } : {}),
      storageOk,
      ...(remainingStorageMB !== undefined ? { remainingStorageMB, storageMaxMB } : {}),
      candidateCount,
    };
  },

  async run(args, ctx) {
    const day = args.day || todayIso();
    if (args.beats !== 1 && args.beats !== 2) throw new Error(`--beats must be 1 or 2 (got ${args.beats})`);
    const runStartedAt = new Date().toISOString();

    await getAccessInfo(args.org); // throws with the #94 message on a redacted token

    const client = new SfCliClient(args.org);
    const sfLimits = await client.limits();
    const ds = sfLimits.find((r) => r.name === "DataStorageMB");
    if (ds && ds.max > 0 && ds.remaining / ds.max < STORAGE_RESERVE) {
      throw new Error(`refusing to write — ${args.org} data storage reserve exhausted: ${ds.remaining}MB / ${ds.max}MB remaining (${((ds.remaining / ds.max) * 100).toFixed(1)}% < ${STORAGE_RESERVE * 100}% reserve)`);
    }

    const candidates = await findDripCandidates(client, args.org, PACK_ID);
    if (candidates.length === 0) {
      throw new Error(`no open-deal candidates found in ${args.org} — nothing to drip. Load a dataset first (load-demo) or check IsClosed=false Opportunities exist.`);
    }

    const selected = selectDayPlan(candidates, { seed: args.seed, day, accounts: args.accounts });
    ctx.log(`selected ${selected.length}/${candidates.length} open deal(s) for ${day} (seed=${args.seed})`);

    const cache = fileDripDossierCache(DOSSIER_CACHE_ROOT);
    const plans = await buildDealPlans(client, cache, args, day, selected, ctx.log);

    const dryRun = !args.yes;
    ctx.log(dryRun ? "DRY RUN — previewing the plan (nothing will be written). Re-run with --yes to write." : `writing (--yes) via provider=${args.provider}`);
    plans.forEach((p, i) => formatPlanLine(p, i).forEach((l) => ctx.log(l)));

    const totalPlannedArtifacts = plans.reduce((n, p) => n + p.artifacts.length, 0);
    ctx.log(`plan: ${totalPlannedArtifacts} would-be record(s) across ${plans.filter((p) => p.artifacts.length > 0).length} deal(s)`);

    if (dryRun) {
      ctx.log("re-run with --yes to write these and start the pipeline.");
      return;
    }
    if (totalPlannedArtifacts === 0) {
      ctx.log("nothing to write today (every selected deal's arc stayed quiet) — no manifest, no registry entry.");
      return;
    }

    const target: LoadTarget = await JsforceLoadTarget.create(args.org);

    // Natural-key dedupe per object, scoped to the parent Ids actually touched today (re-running the
    // same day after a partial failure must insert 0 duplicates — see drip/dedupe.ts).
    const byObject = { EmailMessage: [] as DrippedArtifact[], Task: [] as DrippedArtifact[], ContentVersion: [] as DrippedArtifact[] };
    for (const p of plans) for (const a of p.artifacts) byObject[a.object].push(a);

    const toInsert: DrippedArtifact[] = [];
    for (const obj of ["EmailMessage", "Task", "ContentVersion"] as const) {
      const artifacts = byObject[obj];
      if (artifacts.length === 0) continue;
      const parentField = obj === "ContentVersion" ? "FirstPublishLocationId" : obj === "Task" ? "WhatId" : "RelatedToId";
      const parentIds = [...new Set(artifacts.map((a) => a.record[parentField] as string))];
      // dedupeAgainstOrg reads its natural-key fields straight off `a.record` — the extra `_ref`/`_meta`
      // bookkeeping keys are simply ignored, so records pass through untouched and `_ref` (=== a.id)
      // survives to correlate the surviving rows back to their artifacts below.
      const { toInsert: fresh, skipped } = await dedupeAgainstOrg(target, obj, artifacts.map((a) => a.record), parentIds);
      const freshIds = new Set(fresh.map((r) => r._ref as string));
      if (skipped.length) ctx.log(`${obj}: ${skipped.length} already exist for today (re-run) — skipped`);
      toInsert.push(...artifacts.filter((a) => freshIds.has(a.id)));
    }

    if (toInsert.length === 0) {
      ctx.log("everything planned for today already exists in the org (re-run) — nothing new to insert.");
      return;
    }

    // Copy fill — the SAME fillCopy pipeline fill-copy.ts drives (same prompt, same realism gate);
    // only the new beats' CopyRequests are handed in, so this never touches the original seed's copy.
    const requests = toInsert.map((a) => a.copyRequest);
    const report = await fillCopy(requests, buildProviders(), {
      requestedProvider: args.provider as "auto" | "anthropic" | "claude-code" | "static",
      asOf: runStartedAt,
      log: (m) => ctx.log(m),
    });
    applyFilledCopy(toInsert, report.results);
    ctx.log(`copy: filled ${report.results.length} request(s) via ${report.provider}${report.fallbacks ? `, ${report.fallbacks} via static fallback` : ""}`);

    // Insert, grouped by object (createable-field filtered, mirroring loader.ts's own hygiene).
    const manifestRecords: DripManifestRecord[] = [];
    let totalInserted = 0;
    for (const obj of ["EmailMessage", "Task", "ContentVersion"] as const) {
      const artifacts = toInsert.filter((a) => a.object === obj);
      if (artifacts.length === 0) continue;
      const createable = await target.createableFields(obj);
      const payloads = artifacts.map((a) => buildInsertPayload(a.object, a.record, createable));
      const results = await target.insert(obj, payloads);
      results.forEach((r, i) => {
        if (r.success && r.id) {
          totalInserted++;
          manifestRecords.push({ object: obj, id: r.id, naturalKey: dripNaturalKey(obj, artifacts[i]!.record) });
        } else {
          ctx.log(`${obj}: insert failed — ${r.errors.join("; ") || "unknown error"}`);
        }
      });
      ctx.log(`${obj}: inserted ${results.filter((r) => r.success).length}/${payloads.length}`);
    }

    // Persist the day's extended dossier (new beats appended) so day+1's cache read is cheap.
    for (const p of plans) {
      if (p.draftBeats.length === 0) continue;
      const withRefs = p.artifacts.map((a) => ({ ...a.copyRequest.beat! }));
      const extended: DealDossier = { ...p.dossier, beats: [...p.dossier.beats, ...withRefs] };
      cache.set(dripDossierKey(args.seed, args.org, p.candidate.oppId), extended);
    }

    const manifest = buildManifest({
      org: args.org,
      day,
      createdAt: new Date().toISOString(),
      runStartedAt,
      seed: args.seed,
      accounts: selected.length,
      beatsPerAccount: args.beats,
      provider: report.provider,
      records: manifestRecords,
    });
    writeDripManifest(manifest);
    ctx.log(`manifest: ${dripManifestPath(args.org, day)} (${manifestRecords.length} record(s))`);

    const store = openRegistry();
    try {
      store.recordLoad({
        datasetId: `drip:${args.org}`,
        sink: "drip",
        target: args.org,
        at: new Date().toISOString(),
        inserted: totalInserted,
        failed: 0,
        report: { op: "drip", day, accounts: selected.length, beats: args.beats, provider: report.provider, recordCount: manifestRecords.length },
      });
    } finally {
      store.close();
    }
    ctx.log(`registry: recorded drip run for ${day} (op=drip)`);
  },

  async verify(args, ctx) {
    const day = args.day || todayIso();
    if (!args.yes) return { success: true, dryRun: true, note: "dry run — nothing written, nothing to verify" };

    const path = dripManifestPath(args.org, day);
    if (!existsSync(path)) return { success: true, note: "nothing was inserted today (every selected deal stayed quiet) — nothing to verify" };
    const manifest = JSON.parse(readFileSync(path, "utf8")) as DripManifest;
    const m = manifest.records.length;
    if (m === 0) return { success: true, note: "manifest has 0 records — nothing to verify" };

    const client = new SfCliClient(args.org);
    const ids = manifest.records.map((r) => r.id);
    const idList = ids.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const startedAtLiteral = manifest.runStartedAt; // ISO datetime — SOQL accepts it unquoted

    const deadline = Date.now() + 90_000;
    let enqueued = new Set<string>();
    for (;;) {
      try {
        const rows = await client.query<{ Source_Record_Id__c: string }>(
          `SELECT Source_Record_Id__c FROM Signal_Ingestion_Queue__c WHERE CreatedDate >= ${startedAtLiteral} AND Source_Record_Id__c IN (${idList})`,
        );
        enqueued = new Set(rows.map((r) => r.Source_Record_Id__c));
      } catch (e) {
        ctx.log(`verify poll failed (retrying): ${(e as Error).message}`);
      }
      if (enqueued.size >= m || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }

    const n = enqueued.size;
    ctx.log(`pipeline: ${n} of ${m} records enqueued`);
    return { success: n > 0, enqueued: n, written: m, ...(n === 0 ? { reason: "the drip wrote records but the org's downstream pipeline enqueued nothing within 90s" } : {}) };
  },
};

export default dripOp;

/** Read-only helper for teardown-demo's `--include-drip`: every manifest's records → object → Ids. */
export function planDripTeardownFor(org: string): ReturnType<typeof planDripTeardown> {
  return planDripTeardown(readAllDripManifests(org));
}
