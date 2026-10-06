// packages/engine/src/load/teardown.ts
//
// teardownBundle — delete the records a bundle seeded so an org can be cleanly
// re-loaded (the recovery path for the M4 partial-load limitation, and the reset
// for demo iteration). SAFE BY DESIGN:
//   - scoped to the seeded ACCOUNTS (matched by Name) + LEADS (matched by Email) and
//     their subtree — child records are found by PARENT Id (Opps/Contacts/Cases/Assets
//     under those accounts, Tasks/Events/EmailMessage/ContentDocument (the transcript
//     file, deleted via its parent ContentDocument since a ContentVersion can't be) under those opps,
//     CampaignMembers under those contacts/leads, CaseComments under those cases), so
//     it never blanket-deletes an object.
//   - a CONVERTED Lead (bundle.directives.convertLeads, no accountRef) makes Salesforce
//     mint a brand-new Account named after Lead.Company — that Account never appears in
//     `records.Account`. So Lead.Company values are ALSO treated as candidate seeded
//     Account names (harmless no-op query for a Lead that never converted), closing what
//     would otherwise be a permanently un-teardownable orphan subtree.
//   - reverse dependency order, explicit at EVERY level (never relies on Salesforce's
//     own Account-delete cascade, so the report's per-object counts are accurate and
//     deletion doesn't depend on org-specific cascade config): CaseComment →
//     CampaignMember → ContentDocument → Task → Event → EmailMessage → Opportunity →
//     Case → Asset → Contact → Lead → Account. OpportunityLineItem and
//     OpportunityContactRole are true master-detail/cascade children of Opportunity —
//     Salesforce deletes them automatically, so they're never deleted explicitly here.
//   - NEVER touches catalog/shared objects (Product2, PricebookEntry, Campaign,
//     UserRole, User) — those are upserted by natural key and reused across every
//     dataset loaded in the org; deleting them here would break every OTHER dataset.
//   - resilient: a failed delete request is reported, not fatal.
// Like the loader's dedup, account matching is by bare Name and lead matching is by
// bare Email (see docs/open-questions/m4-loader-hardening.md) — point it at dedicated
// demo/scratch orgs, and preview with dry-run first.

import type { NarrativeBundle } from "@dataseed/core";
import type { LoadTarget } from "./connection.js";

/** teardownBundle only ever reads `.records.Account` (Name-matching) and `.records.Lead`
 *  (Email-matching) — a structural type, not the full NarrativeBundle schema, so a caller
 *  resolving records from a warehouse slice (rather than a full registered bundle) doesn't
 *  need to fabricate the rest of the schema just to call this. */
export type TeardownableBundle = Pick<NarrativeBundle, "records">;

export interface ObjectTeardownResult {
  object: string;
  matched: number;
  deleted: number;
  failed: number;
  errors: string[];
}

export interface TeardownReport {
  org: string;
  dryRun: boolean;
  accountsMatched: number;
  leadsMatched: number;
  objects: ObjectTeardownResult[];
  totalDeleted: number;
}

export interface TeardownOptions {
  /** Preview only — resolve the plan + counts, delete nothing. */
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

const ERROR_SAMPLE = 5;
const dedupe = (ids: string[]): string[] => [...new Set(ids)];

export async function teardownBundle(bundle: TeardownableBundle, target: LoadTarget, opts: TeardownOptions = {}): Promise<TeardownReport> {
  const log = opts.onProgress ?? (() => {});
  const dryRun = opts.dryRun ?? false;
  const acctNames = [
    ...new Set([
      ...(bundle.records.Account ?? []).map((a) => a.Name).filter((v): v is string => typeof v === "string"),
      // a converted Lead's minted Account is named after Lead.Company (see header comment) — never in records.Account
      ...(bundle.records.Lead ?? []).map((l) => l.Company).filter((v): v is string => typeof v === "string"),
    ]),
  ];
  const leadEmails = [...new Set((bundle.records.Lead ?? []).map((l) => l.Email).filter((v): v is string => typeof v === "string"))];

  const objects: ObjectTeardownResult[] = [];
  const empty: TeardownReport = { org: target.org, dryRun, accountsMatched: 0, leadsMatched: 0, objects, totalDeleted: 0 };
  if (acctNames.length === 0 && leadEmails.length === 0) return empty;

  const acctIds = acctNames.length ? await target.queryIds("Account", "Name", acctNames) : [];
  const leadIds = leadEmails.length ? await target.queryIds("Lead", "Email", leadEmails) : [];
  if (acctIds.length === 0 && leadIds.length === 0) {
    log("teardown: no matching Account/Lead in the org — nothing to delete.");
    return empty;
  }

  // Child id sets, scoped to the seeded accounts/leads (only ever their subtree).
  const oppIds = acctIds.length ? await target.queryIds("Opportunity", "AccountId", acctIds) : [];
  const contactIds = acctIds.length ? await target.queryIds("Contact", "AccountId", acctIds) : [];
  const emailIds = oppIds.length ? await target.queryIds("EmailMessage", "RelatedToId", oppIds) : [];
  // A ContentVersion (the transcript file) CANNOT be deleted directly — Salesforce returns
  // INSUFFICIENT_ACCESS_OR_READONLY (org-verified). To remove the file we delete its parent
  // ContentDocument, whose single version cascades away. Resolve the ContentDocumentIds behind
  // the seeded transcripts (deduped — a doc could carry >1 version). queryField is optional; a
  // target lacking it simply skips file teardown (the prior behavior, minus the failed deletes).
  const contentDocIds = oppIds.length && target.queryField ? dedupe(await target.queryField("ContentVersion", "ContentDocumentId", "FirstPublishLocationId", oppIds)) : [];
  const taskIds = oppIds.length ? await target.queryIds("Task", "WhatId", oppIds) : [];
  const eventIds = oppIds.length ? await target.queryIds("Event", "WhatId", oppIds) : [];
  const caseIds = acctIds.length ? await target.queryIds("Case", "AccountId", acctIds) : [];
  const assetIds = acctIds.length ? await target.queryIds("Asset", "AccountId", acctIds) : [];
  const caseCommentIds = caseIds.length ? await target.queryIds("CaseComment", "ParentId", caseIds) : [];
  const campaignMemberByContact = contactIds.length ? await target.queryIds("CampaignMember", "ContactId", contactIds) : [];
  const campaignMemberByLead = leadIds.length ? await target.queryIds("CampaignMember", "LeadId", leadIds) : [];
  const campaignMemberIds = dedupe([...campaignMemberByContact, ...campaignMemberByLead]);

  // Reverse dependency order, explicit at every level (see the header comment for why).
  // OpportunityLineItem and OpportunityContactRole cascade with their Opportunity, so
  // they're never deleted explicitly.
  const plan: Array<{ object: string; ids: string[] }> = [
    { object: "CaseComment", ids: caseCommentIds },
    { object: "CampaignMember", ids: campaignMemberIds },
    { object: "ContentDocument", ids: contentDocIds },
    { object: "Task", ids: taskIds },
    { object: "Event", ids: eventIds },
    { object: "EmailMessage", ids: emailIds },
    { object: "Opportunity", ids: oppIds },
    { object: "Case", ids: caseIds },
    { object: "Asset", ids: assetIds },
    { object: "Contact", ids: contactIds },
    { object: "Lead", ids: leadIds },
    { object: "Account", ids: acctIds },
  ];

  let totalDeleted = 0;
  for (const step of plan) {
    if (step.ids.length === 0) {
      objects.push({ object: step.object, matched: 0, deleted: 0, failed: 0, errors: [] });
      continue;
    }
    if (dryRun) {
      log(`${step.object}: would delete ${step.ids.length}`);
      objects.push({ object: step.object, matched: step.ids.length, deleted: 0, failed: 0, errors: [] });
      continue;
    }
    let deleted = 0;
    let failed = 0;
    const errors: string[] = [];
    try {
      const res = await target.deleteRecords(step.object, step.ids);
      for (const r of res) {
        if (r.success) deleted++;
        else {
          failed++;
          if (errors.length < ERROR_SAMPLE) errors.push(r.errors.join("; ") || "unknown delete error");
        }
      }
    } catch (e) {
      failed = step.ids.length;
      errors.push(`delete threw: ${(e as Error).message}`);
      log(`${step.object}: delete request failed (${(e as Error).message}) — continuing`);
    }
    totalDeleted += deleted;
    log(`${step.object}: deleted ${deleted}/${step.ids.length}${failed ? `, ${failed} failed` : ""}`);
    objects.push({ object: step.object, matched: step.ids.length, deleted, failed, errors });
  }

  return { org: target.org, dryRun, accountsMatched: acctIds.length, leadsMatched: leadIds.length, objects, totalDeleted };
}
