// packages/engine/src/load/loader.ts
//
// The loader: turn a NarrativeBundle into real org records. The hard parts are
// PURE and unit-tested (no org):
//   - ref resolution: `_refs` lookups → real Ids captured as parents insert
//   - field filtering: keep only createable fields (drops `_meta`, and lookups the
//     org doesn't have — e.g. a custom lookup field the target org does not have)
//   - additive idempotency: skip root records that already exist, and cascade-skip
//     their whole subtree (lineage filter), so re-runs don't duplicate
// Orchestration is RESILIENT: one object's (or row's) failure is reported, not
// fatal — the rest of the cascade still loads.

import { STANDARD_PRICEBOOK_REF, EXISTING_REF_PREFIX, parseExistingRef, type BundleRecords, type GenericRecord, type NarrativeBundle, type TargetPack } from "@dataseed/core";
import type { LoadTarget } from "./connection.js";
import type { CheckpointStore } from "./checkpoint.js";

export { STANDARD_PRICEBOOK_REF };

/** Composite catalog-key separator — NUL never appears in a field value, so joined parts can't collide. */
const KEY_SEP = "\u0000";

/** Distinct `@existing:` ref targets across all records' `_refs`/`_softRefs` (pre-existing org records to resolve by natural key). */
export function collectExistingRefs(records: BundleRecords): string[] {
  const out = new Set<string>();
  for (const recs of Object.values(records)) {
    for (const r of recs) {
      for (const t of Object.values((r._refs ?? {}) as Record<string, string>)) if (typeof t === "string" && t.startsWith(EXISTING_REF_PREFIX)) out.add(t);
      for (const t of Object.values((r._softRefs ?? {}) as Record<string, string>)) if (typeof t === "string" && t.startsWith(EXISTING_REF_PREFIX)) out.add(t);
    }
  }
  return [...out];
}

/** Collect every local `_ref` id declared in the bundle (the in-bundle ref namespace). */
export function collectRefs(records: BundleRecords): Set<string> {
  const refs = new Set<string>();
  for (const recs of Object.values(records)) for (const r of recs) if (typeof r._ref === "string") refs.add(r._ref);
  return refs;
}

/** Does any record point a `_refs`/`_softRefs` lookup at `sentinel` (a load-time-resolved external)? */
export function referencesSentinel(records: BundleRecords, sentinel: string): boolean {
  for (const recs of Object.values(records)) {
    for (const r of recs) {
      const hard = Object.values((r._refs ?? {}) as Record<string, string>);
      const soft = Object.values((r._softRefs ?? {}) as Record<string, string>);
      if (hard.includes(sentinel) || soft.includes(sentinel)) return true;
    }
  }
  return false;
}

export interface ResolvedRecord {
  payload?: Record<string, unknown>;
  skip: boolean;
  skipReason?: string;
  droppedFields: string[];
}

/**
 * Build the insert payload for one record: strip `_`-meta, resolve in-bundle
 * `_refs` to real Ids, keep only createable fields. Skips the record if a HARD parent
 * it points to (an in-bundle `_ref` or a resolved sentinel) hasn't been inserted/resolved
 * (so we never orphan-insert). `_softRefs` resolve the same way but, when unresolved, DROP
 * the field instead of skipping the record (the record is valid without that lookup).
 */
export function resolveRecord(
  rec: GenericRecord,
  allRefs: Set<string>,
  refToId: ReadonlyMap<string, string>,
  createable: ReadonlySet<string>,
): ResolvedRecord {
  const droppedFields: string[] = [];
  const lookups: Record<string, unknown> = {};
  const refs = (rec._refs ?? {}) as Record<string, string>;

  for (const [field, target] of Object.entries(refs)) {
    if (allRefs.has(target)) {
      // an in-bundle parent (or a resolved sentinel) — must already be inserted/resolved
      const id = refToId.get(target);
      if (!id) return { skip: true, skipReason: `unresolved parent ${field} → ${target}`, droppedFields };
      if (createable.has(field)) lookups[field] = id;
      else droppedFields.push(field);
    } else {
      // an external value (e.g. an External_Id for an object not loaded here) — can't map to an Id generically
      droppedFields.push(field);
    }
  }

  // Soft refs: resolve to an Id when available, else DROP the field and keep the record.
  const softRefs = (rec._softRefs ?? {}) as Record<string, string>;
  for (const [field, target] of Object.entries(softRefs)) {
    const id = refToId.get(target);
    if (id && createable.has(field)) lookups[field] = id;
    else droppedFields.push(field);
  }

  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith("_")) continue;
    if (createable.has(k)) base[k] = v;
    else droppedFields.push(k);
  }

  return { payload: { ...base, ...lookups }, skip: false, droppedFields };
}

export interface Idempotency {
  /** The root object to dedupe on (e.g. "Account"). */
  object: string;
  /** The field whose existing values mean "already loaded" (e.g. "Name"). */
  field: string;
}

/**
 * Drop root records whose `field` value already exists in the org, and cascade-skip
 * every descendant that transitively depends on a dropped root (lineage filter).
 * Processed in pack-load order so parents are decided before children.
 */
export function filterExisting(
  records: BundleRecords,
  loadOrder: readonly string[],
  allRefs: Set<string>,
  idem: Idempotency,
  existing: ReadonlySet<string>,
): { filtered: BundleRecords; skipped: number } {
  const skipRefs = new Set<string>();
  const filtered: BundleRecords = {};
  let skipped = 0;

  for (const obj of loadOrder) {
    const recs = records[obj];
    if (!recs) continue;
    const kept: GenericRecord[] = [];
    for (const rec of recs) {
      const isRoot = obj === idem.object;
      const val = isRoot ? rec[idem.field] : undefined;
      const existsAlready = isRoot && typeof val === "string" && existing.has(val);
      const refs = (rec._refs ?? {}) as Record<string, string>;
      const parentDropped = Object.values(refs).some((t) => allRefs.has(t) && skipRefs.has(t));
      if (existsAlready || parentDropped) {
        if (typeof rec._ref === "string") skipRefs.add(rec._ref);
        skipped++;
        continue;
      }
      kept.push(rec);
    }
    filtered[obj] = kept;
  }
  return { filtered, skipped };
}

export interface ObjectLoadResult {
  object: string;
  present: boolean;
  attempted: number;
  inserted: number;
  failed: number;
  skipped: number; // unresolved-parent skips within this object
  reused: number; // catalog records resolved to an existing org record (upsert) instead of inserted
  droppedFields: string[]; // distinct fields dropped (not createable / unmappable)
  errors: string[]; // sample of insert errors
  resumed?: boolean; // skipped because a checkpoint marked it already loaded in a prior run
}

export interface LeadConversionResult {
  attempted: number;
  converted: number;
  opportunitiesCreated: number;
  errors: string[];
}

/** Post-insert self-referential lookup wiring (e.g. Contact.ReportsToId → a sibling), per object. */
export interface SelfLookupResult {
  object: string;
  fields: string[]; // the self-lookup fields linked (e.g. ["ReportsToId"])
  attempted: number; // records with a now-resolvable same-object soft ref
  linked: number; // successful updates
  errors: string[];
}

export interface LoadReport {
  org: string;
  pack: string;
  objects: ObjectLoadResult[];
  totalInserted: number;
  idempotencySkipped: number;
  /** Post-load lead conversions (Lead→Account/Contact/Opportunity), when the pack emits directives. */
  conversions?: LeadConversionResult;
  /** Post-insert self-referential lookups linked in a second pass (e.g. Contact.ReportsToId). */
  selfLookups?: SelfLookupResult[];
}

export interface LoadOptions {
  /** Additive idempotency root (skip existing + their subtrees). Omit to load everything. */
  idempotency?: Idempotency;
  /**
   * Resume a partially-completed load: skip objects the checkpoint marks done, restore their ref→Id map,
   * and persist progress after each object (so a crash/rate-kill resumes instead of re-running). On resume
   * the additive idempotency filter is bypassed — the checkpoint, not org-existence, is the source of truth.
   */
  checkpoint?: CheckpointStore;
  /** Progress callback (per object). */
  onProgress?: (msg: string) => void;
}

const ERROR_SAMPLE = 5;

/**
 * Load a bundle into an org through a LoadTarget. Inserts object-by-object in the
 * pack's load order, capturing each row's Id so child lookups resolve. Resilient:
 * absent objects + failed rows are reported, never fatal.
 *
 * Takes only `records` (+ optional `directives`) — never `plan` — so a warehouse SLICE
 * (assembled records with no full BundlePlan) can be loaded directly, not just a registry Dataset.
 */
export async function loadBundle(
  bundle: Pick<NarrativeBundle, "records" | "directives">,
  pack: TargetPack,
  target: LoadTarget,
  opts: LoadOptions = {},
): Promise<LoadReport> {
  const log = opts.onProgress ?? (() => {});
  const loadOrder = pack.objects.filter((o) => bundle.records[o]?.length);
  const allRefs = collectRefs(bundle.records);

  // Resume: restore prior progress (completed objects + ref→Id) so a re-run continues instead of redoing.
  const cp = opts.checkpoint?.load() ?? null;
  const completed = new Set(cp?.completed ?? []);

  let records = bundle.records;
  let idempotencySkipped = 0;
  // Skip the additive-idempotency filter on a RESUME: a partially-loaded account exists in the org but its
  // children may not be loaded yet — the checkpoint's `completed` set, not org-existence, decides what's done.
  if (!cp && opts.idempotency && records[opts.idempotency.object]) {
    const { object, field } = opts.idempotency;
    const rootVals = (records[object] ?? [])
      .map((r) => r[field])
      .filter((v): v is string => typeof v === "string");
    const existing = await target.existingValues(object, field, rootVals);
    if (existing.size > 0) {
      const res = filterExisting(records, pack.objects, allRefs, opts.idempotency, existing);
      records = res.filtered;
      idempotencySkipped = res.skipped;
      log(`idempotency: ${existing.size} existing ${object}.${field} → skipped ${res.skipped} record(s) (with subtrees)`);
    }
  }

  const refToId = new Map<string, string>();
  if (cp) {
    for (const [ref, id] of Object.entries(cp.refs)) refToId.set(ref, id);
    log(`resume: ${completed.size} object(s) already loaded, ${Object.keys(cp.refs).length} ref(s) restored`);
  }
  const objects: ObjectLoadResult[] = [];
  const catalogByObject = new Map((pack.catalog ?? []).map((c) => [c.object, c]));

  // Resolve the standard-Pricebook2 sentinel ONCE (a pre-existing org record the product/line-item
  // chain points at). If any record references it, add it to the in-bundle ref namespace so HARD
  // refs (PricebookEntry.Pricebook2Id) resolve — or, when the org has no standard pricebook, cleanly
  // SKIP (and their OpportunityLineItem children cascade-skip), while soft refs (Opportunity) drop it.
  if (referencesSentinel(records, STANDARD_PRICEBOOK_REF)) {
    allRefs.add(STANDARD_PRICEBOOK_REF);
    const stdId = await target.standardPricebookId();
    if (stdId) refToId.set(STANDARD_PRICEBOOK_REF, stdId);
    else log(`standard Pricebook2 not resolvable — PricebookEntry/OpportunityLineItem will skip; Opportunity loads without a pricebook`);
  }

  // Resolve `@existing:` refs ONCE — targets that point at a PRE-EXISTING org record (config the seeder
  // does NOT generate) matched by a natural key, e.g. a config rule's lookups to
  // framework or concept-library records. Group by (object, field), batch-resolve via idsByField, and add
  // EVERY target to the in-bundle ref namespace (allRefs) so resolveRecord treats it like any parent:
  // resolved → maps to the Id; UNRESOLVED (org lacks that record) → the HARD ref cleanly SKIPS the
  // record (a mapping rule without its framework is useless) instead of silently dropping the lookup.
  const existingTargets = collectExistingRefs(records);
  if (existingTargets.length > 0) {
    const groups = new Map<string, { sobject: string; field: string; valueToRef: Map<string, string> }>();
    for (const t of existingTargets) {
      const p = parseExistingRef(t);
      if (!p) continue;
      allRefs.add(t);
      const gk = `${p.sobject}.${p.field}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { sobject: p.sobject, field: p.field, valueToRef: new Map() }));
      g.valueToRef.set(p.value, t);
    }
    for (const g of groups.values()) {
      const found = await target.idsByField(g.sobject, g.field, [...g.valueToRef.keys()]);
      for (const [value, ref] of g.valueToRef) {
        const id = found.get(value);
        if (id) refToId.set(ref, id);
      }
      const missing = [...g.valueToRef.keys()].filter((v) => !found.has(v));
      if (missing.length) log(`@existing ${g.sobject}.${g.field}: ${missing.length} unresolved (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}) — dependent records will skip`);
    }
  }

  for (const obj of loadOrder) {
    const recs = records[obj] ?? [];
    if (recs.length === 0) continue;

    if (completed.has(obj)) {
      log(`${obj}: resumed (already loaded) — skipping ${recs.length}`);
      objects.push({ object: obj, present: true, attempted: recs.length, inserted: 0, failed: 0, skipped: 0, reused: 0, droppedFields: [], errors: [], resumed: true });
      continue;
    }

    if (!(await target.exists(obj))) {
      log(`${obj}: not present in org — skipping ${recs.length}`);
      objects.push({ object: obj, present: false, attempted: recs.length, inserted: 0, failed: 0, skipped: recs.length, reused: 0, droppedFields: [], errors: [] });
      continue;
    }

    const createable = await target.createableFields(obj);
    const dropped = new Set<string>();
    let skipped = 0;
    let reused = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const payloadRefs: Array<string | undefined> = [];

    // Catalog UPSERT: for shared no-Account-root objects (Product2, PricebookEntry), resolve an
    // existing org record by a natural key and reuse its Id (remapping the in-bundle ref) instead
    // of inserting a duplicate — so the catalog persists across loads rather than accumulating.
    const cat = catalogByObject.get(obj);
    const keyOf = (rec: GenericRecord): string | null => {
      if (cat?.keyFields) {
        const parts = cat.keyFields.map((f) => rec[f]);
        if (parts.some((v) => v == null)) return null; // every key field must be present to dedupe
        return parts.map(String).join(KEY_SEP);
      }
      if (cat?.keyField) {
        const v = rec[cat.keyField];
        return v == null ? null : String(v);
      }
      if (cat?.keyByRef) {
        const ref = (rec._refs as Record<string, string> | undefined)?.[cat.keyByRef];
        const id = ref ? refToId.get(ref) : undefined; // the parent (e.g. Product2) was resolved earlier in load order
        return id ?? null;
      }
      return null;
    };
    let existingByKey: Map<string, string> | null = null;
    if (cat?.keyFields) {
      // Composite natural key (e.g. a config rule by Name+adapter) — the existing-org map is
      // keyed by the SAME NUL-joined tuple as keyOf, so a seeded rule reuses its twin instead of duplicating.
      const fields = cat.keyFields;
      const rows = recs.map((r) => fields.map((f) => (r[f] == null ? null : String(r[f])))).filter((row): row is string[] => row.every((v) => v != null));
      existingByKey = await target.idsByCompositeKey(obj, fields, rows);
    } else if (cat) {
      const lookupField = cat.keyField ?? cat.keyByRef!;
      const keys = recs.map(keyOf).filter((k): k is string => k != null);
      existingByKey = await target.idsByField(obj, lookupField, [...new Set(keys)]);
    }

    for (const rec of recs) {
      if (existingByKey) {
        const k = keyOf(rec);
        if (k != null && existingByKey.has(k)) {
          if (typeof rec._ref === "string") refToId.set(rec._ref, existingByKey.get(k)!);
          reused++;
          continue;
        }
      }
      const r = resolveRecord(rec, allRefs, refToId, createable);
      r.droppedFields.forEach((f) => dropped.add(f));
      if (r.skip) {
        skipped++;
        continue;
      }
      // ContentVersion.VersionData is a base64-encoded BLOB on the Salesforce side, but the bundle carries the
      // file's PLAIN text (the VTT transcript — the file sink stores it as-is). Two load-time concerns:
      //  (1) a deferred-copy transcript whose VersionData was never filled (a materialized corpus loaded
      //      WITHOUT fill-copy) has no file content — VersionData is REQUIRED, so skip the empty shell rather
      //      than fail the row (both caught on a live load);
      //  (2) encode the real text, else Salesforce decodes the raw text AS base64 and stores garbage.
      if (obj === "ContentVersion") {
        const vd = r.payload!.VersionData;
        if (typeof vd !== "string" || vd.length === 0) {
          skipped++;
          continue;
        }
        r.payload!.VersionData = Buffer.from(vd, "utf8").toString("base64");
      }
      // A CampaignMember must reference a member — a Lead OR a Contact. If neither ref resolved (e.g. a sliced
      // funnel CM whose Lead wasn't loaded), the member id is null and Salesforce rejects the row; skip the
      // unloadable member-less CM rather than fail it (the slice enforces this too, but be resilient to any path).
      if (obj === "CampaignMember" && r.payload!.ContactId == null && r.payload!.LeadId == null) {
        skipped++;
        continue;
      }
      payloads.push(r.payload!);
      payloadRefs.push(typeof rec._ref === "string" ? rec._ref : undefined);
    }

    const errors: string[] = [];
    let inserted = 0;
    let failed = 0;
    if (payloads.length > 0) {
      try {
        const results = await target.insert(obj, payloads);
        results.forEach((res, i) => {
          if (res.success) {
            inserted++;
            const ref = payloadRefs[i];
            if (ref && res.id) refToId.set(ref, res.id);
          } else {
            failed++;
            if (errors.length < ERROR_SAMPLE) errors.push(res.errors.join("; ") || "unknown insert error");
          }
        });
      } catch (e) {
        // A request-level rejection (session expiry, REQUEST_LIMIT_EXCEEDED, dropped
        // socket) — jsforce throws rather than returning per-row failures. Honor the
        // "not fatal" contract: mark the whole object failed and continue. Its children
        // then cascade-skip (their parent Ids were never captured), all reported.
        failed = payloads.length;
        errors.push(`insert threw: ${(e as Error).message}`);
        log(`${obj}: insert request failed (${(e as Error).message}) — continuing with remaining objects`);
      }
    }

    log(`${obj}: inserted ${inserted}/${payloads.length}${failed ? `, ${failed} failed` : ""}${reused ? `, ${reused} reused (existing catalog)` : ""}${skipped ? `, ${skipped} skipped (unloadable: unresolved parent / empty required content / no member)` : ""}`);
    objects.push({ object: obj, present: true, attempted: recs.length, inserted, failed, skipped, reused, droppedFields: [...dropped], errors });

    // Persist progress after each object so a crash/rate-kill resumes here instead of from the top.
    completed.add(obj);
    opts.checkpoint?.save({ completed: [...completed], refs: Object.fromEntries(refToId) });
  }

  // Post-insert SELF-REFERENTIAL lookups (e.g. Contact.ReportsToId → a sibling Contact). Every row of an
  // object inserts in ONE batch, so a same-object `_softRef` target has no Id yet at insert time → resolveRecord
  // DROPS it. Now that all Ids are captured, wire them in a second UPDATE pass. Generic: any `_softRef` whose
  // target is another record of the SAME object. Requires `target.update` (optional) — without it the field
  // stays unset (the prior behavior), so this is purely additive. On resume the checkpoint restores refToId, so
  // the pass still resolves. (Cross-object soft refs need no pass — load order means the parent's Id is already
  // known when the child inserts.)
  const selfLookups: SelfLookupResult[] = [];
  if (target.update) {
    for (const obj of loadOrder) {
      const recs = records[obj] ?? [];
      if (recs.length === 0) continue;
      const ownRefs = new Set<string>();
      for (const rec of recs) if (typeof rec._ref === "string") ownRefs.add(rec._ref);
      const createable = await target.createableFields(obj); // cached in the real target
      const linkedFields = new Set<string>();
      const updates: Array<Record<string, unknown>> = [];
      for (const rec of recs) {
        const recId = typeof rec._ref === "string" ? refToId.get(rec._ref) : undefined;
        if (!recId) continue; // this record never inserted (skipped / absent object) → nothing to link
        const soft = (rec._softRefs ?? {}) as Record<string, string>;
        const patch: Record<string, unknown> = {};
        for (const [field, tgt] of Object.entries(soft)) {
          if (!ownRefs.has(tgt) || !createable.has(field)) continue; // SELF-reference + writeable field only
          const id = refToId.get(tgt);
          if (id && id !== recId) { patch[field] = id; linkedFields.add(field); } // never point a record at itself
        }
        if (Object.keys(patch).length) updates.push({ Id: recId, ...patch });
      }
      if (updates.length === 0) continue;
      const errors: string[] = [];
      let linked = 0;
      try {
        const results = await target.update(obj, updates);
        results.forEach((r) => { if (r.success) linked++; else if (errors.length < ERROR_SAMPLE) errors.push(r.errors.join("; ") || "unknown update error"); });
      } catch (e) {
        errors.push(`update threw: ${(e as Error).message}`);
      }
      selfLookups.push({ object: obj, fields: [...linkedFields], attempted: updates.length, linked, errors });
      log(`${obj}: linked ${linked}/${updates.length} self-lookup(s) [${[...linkedFields].join(", ")}]`);
    }
  }

  // Post-load: lead conversions. Lead→Account/Contact/Opportunity isn't a bulk insert — it's the SOAP
  // convertLead call. Resolve each directive's in-bundle refs to the Ids just inserted; a lead that was
  // skipped (idempotency / failed insert) simply drops its conversion. Fail-soft: a conversion error is
  // reported, never thrown.
  let conversions: LeadConversionResult | undefined;
  const convDirectives = bundle.directives?.convertLeads ?? [];
  if (convDirectives.length > 0 && (await target.exists("Lead"))) {
    const inputs = convDirectives
      .map((d) => {
        const leadId = refToId.get(d.leadRef);
        if (!leadId) return null; // lead never landed → nothing to convert
        return { leadId, convertedStatus: d.convertedStatus, opportunityName: d.opportunityName, doNotCreateOpportunity: d.doNotCreateOpportunity, accountId: d.accountRef ? refToId.get(d.accountRef) : undefined };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    conversions = { attempted: inputs.length, converted: 0, opportunitiesCreated: 0, errors: [] };
    if (inputs.length > 0) {
      try {
        const res = await target.convertLeads(inputs);
        conversions.converted = res.filter((r) => r.success).length;
        conversions.opportunitiesCreated = res.filter((r) => r.opportunityId).length;
        res.filter((r) => !r.success).forEach((r) => conversions!.errors.length < ERROR_SAMPLE && conversions!.errors.push(r.errors.join("; ") || "unknown convert error"));
      } catch (e) {
        conversions.errors.push(`convertLead threw: ${(e as Error).message}`);
      }
      log(`Lead conversion: ${conversions.converted}/${inputs.length} converted (${conversions.opportunitiesCreated} opportunities created)`);
    }
  }

  // Clean finish — drop the checkpoint so the next run of this dataset starts fresh (not a no-op resume).
  opts.checkpoint?.clear();

  return {
    org: target.org,
    pack: pack.id,
    objects,
    totalInserted: objects.reduce((a, o) => a + o.inserted, 0),
    idempotencySkipped,
    conversions,
    ...(selfLookups.length ? { selfLookups } : {}),
  };
}
