import { describe, it, expect } from "vitest";
import { NarrativeBundle } from "@dataseed/core";
import { teardownBundle } from "../src/load/teardown.js";
import type { LoadTarget, InsertResult } from "../src/load/connection.js";

// A mock org pre-populated with a seeded subtree, exercising the parent-scoped queries.
class MockOrg implements LoadTarget {
  org = "mock";
  deleted: Record<string, string[]> = {};
  queried: Array<{ sobject: string; whereField: string }> = [];
  constructor(
    private cfg: {
      accountsByName?: Record<string, string>; // Name -> Id present in the org
      leadsByEmail?: Record<string, string>; // Email -> Id present in the org
      oppsByAccount?: Record<string, string[]>; // AccountId -> Opp Ids
      contactsByAccount?: Record<string, string[]>; // AccountId -> Contact Ids
      emailsByOpp?: Record<string, string[]>; // Opp Id -> EmailMessage Ids
      contentDocsByOpp?: Record<string, string[]>; // Opp Id -> ContentDocumentIds (resolved from ContentVersion.FirstPublishLocationId)
      tasksByOpp?: Record<string, string[]>; // Opp Id -> Task Ids
      eventsByOpp?: Record<string, string[]>; // Opp Id -> Event Ids
      casesByAccount?: Record<string, string[]>; // AccountId -> Case Ids
      assetsByAccount?: Record<string, string[]>; // AccountId -> Asset Ids
      caseCommentsByCase?: Record<string, string[]>; // Case Id -> CaseComment Ids
      campaignMembersByContact?: Record<string, string[]>; // Contact Id -> CampaignMember Ids
      campaignMembersByLead?: Record<string, string[]>; // Lead Id -> CampaignMember Ids
      failDelete?: Set<string>; // objects whose delete throws
    } = {},
  ) {}
  async exists() {
    return true;
  }
  async createableFields() {
    return new Set<string>();
  }
  async insert(): Promise<InsertResult[]> {
    return [];
  }
  async existingValues() {
    return new Set<string>();
  }
  async standardPricebookId() {
    return null;
  }
  async idsByField() {
    return new Map<string, string>();
  }
  async idsByCompositeKey() {
    return new Map<string, string>();
  }
  async convertLeads() {
    return [];
  }
  async queryIds(sobject: string, whereField: string, values: string[]): Promise<string[]> {
    this.queried.push({ sobject, whereField });
    if (sobject === "Account" && whereField === "Name") return values.map((n) => this.cfg.accountsByName?.[n]).filter(Boolean) as string[];
    if (sobject === "Lead" && whereField === "Email") return values.map((e) => this.cfg.leadsByEmail?.[e]).filter(Boolean) as string[];
    if (sobject === "Opportunity" && whereField === "AccountId") return values.flatMap((a) => this.cfg.oppsByAccount?.[a] ?? []);
    if (sobject === "Contact" && whereField === "AccountId") return values.flatMap((a) => this.cfg.contactsByAccount?.[a] ?? []);
    if (sobject === "EmailMessage" && whereField === "RelatedToId") return values.flatMap((o) => this.cfg.emailsByOpp?.[o] ?? []);
    if (sobject === "Task" && whereField === "WhatId") return values.flatMap((o) => this.cfg.tasksByOpp?.[o] ?? []);
    if (sobject === "Event" && whereField === "WhatId") return values.flatMap((o) => this.cfg.eventsByOpp?.[o] ?? []);
    if (sobject === "Case" && whereField === "AccountId") return values.flatMap((a) => this.cfg.casesByAccount?.[a] ?? []);
    if (sobject === "Asset" && whereField === "AccountId") return values.flatMap((a) => this.cfg.assetsByAccount?.[a] ?? []);
    if (sobject === "CaseComment" && whereField === "ParentId") return values.flatMap((c) => this.cfg.caseCommentsByCase?.[c] ?? []);
    if (sobject === "CampaignMember" && whereField === "ContactId") return values.flatMap((c) => this.cfg.campaignMembersByContact?.[c] ?? []);
    if (sobject === "CampaignMember" && whereField === "LeadId") return values.flatMap((l) => this.cfg.campaignMembersByLead?.[l] ?? []);
    return [];
  }
  async queryField(sobject: string, selectField: string, whereField: string, values: string[]): Promise<string[]> {
    this.queried.push({ sobject, whereField });
    // teardown resolves a transcript's parent ContentDocumentId (a ContentVersion can't be deleted directly).
    if (sobject === "ContentVersion" && selectField === "ContentDocumentId" && whereField === "FirstPublishLocationId") {
      return values.flatMap((o) => this.cfg.contentDocsByOpp?.[o] ?? []);
    }
    return [];
  }
  async deleteRecords(sobject: string, ids: string[]): Promise<InsertResult[]> {
    if (this.cfg.failDelete?.has(sobject)) throw new Error("UNABLE_TO_LOCK_ROW: deadlock");
    this.deleted[sobject] = (this.deleted[sobject] ?? []).concat(ids);
    return ids.map(() => ({ success: true, errors: [] }));
  }
}

const bundle = NarrativeBundle.parse({
  records: {
    Account: [
      { _ref: "a0", Name: "Stripe" },
      { _ref: "a1", Name: "Okta" },
    ],
  },
  plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 2, volume: 2 },
});

const bundleWithLead = NarrativeBundle.parse({
  records: {
    Account: [{ _ref: "a0", Name: "Stripe" }],
    Lead: [{ _ref: "l0", Email: "jamie@acme-prospect.com" }],
  },
  plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 2, volume: 2 },
});

// A Lead that CONVERTED (bundle.directives.convertLeads, no accountRef): Salesforce mints a brand-new
// Account named after Lead.Company, which never appears in records.Account — see teardown.ts's header.
const bundleWithConvertedLead = NarrativeBundle.parse({
  records: {
    Account: [{ _ref: "a0", Name: "Stripe" }],
    Lead: [{ _ref: "l0", Email: "quinta.romero@crowdstrike.com", Company: "CrowdStrike" }],
  },
  plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 1, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 2, volume: 2 },
});

const fullOrg = () =>
  new MockOrg({
    accountsByName: { Stripe: "001A", Okta: "001B" },
    oppsByAccount: { "001A": ["006A"], "001B": ["006B"] },
    contactsByAccount: { "001A": ["003A1", "003A2"], "001B": ["003B"] },
    emailsByOpp: { "006A": ["02sA1", "02sA2"], "006B": ["02sB"] },
    contentDocsByOpp: { "006A": ["069A"], "006B": [] },
    tasksByOpp: { "006A": ["00TA1", "00TA2"], "006B": ["00TB"] },
    eventsByOpp: { "006A": ["00UA"], "006B": [] },
    casesByAccount: { "001A": ["500A"], "001B": [] },
    assetsByAccount: { "001A": ["02iA"], "001B": [] },
    caseCommentsByCase: { "500A": ["00aA1", "00aA2"] },
    campaignMembersByContact: { "003A1": ["00vA1"], "003B": ["00vB1"] },
  });

describe("teardownBundle", () => {
  it("dry-run resolves the FULL parent-scoped plan (Task/Event/Case/CaseComment/Asset/ContentVersion/CampaignMember included) but deletes nothing", async () => {
    const org = fullOrg();
    const report = await teardownBundle(bundle, org, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.accountsMatched).toBe(2);
    expect(report.totalDeleted).toBe(0);
    expect(org.deleted).toEqual({}); // nothing deleted
    const byObj = Object.fromEntries(report.objects.map((o) => [o.object, o.matched]));
    expect(byObj).toEqual({
      CaseComment: 2,
      CampaignMember: 2,
      ContentDocument: 1,
      Task: 3,
      Event: 1,
      EmailMessage: 3,
      Opportunity: 2,
      Case: 1,
      Asset: 1,
      Contact: 3,
      Lead: 0,
      Account: 2,
    });
  });

  it("deletes the whole subtree in reverse dependency order, never touching catalog objects", async () => {
    const org = fullOrg();
    const report = await teardownBundle(bundle, org, {});
    const expectedTotal = 2 + 2 + 1 + 3 + 1 + 3 + 2 + 1 + 1 + 3 + 2; // every non-zero bucket above
    expect(report.totalDeleted).toBe(expectedTotal);
    // OLI/OCR are never deleted explicitly (cascade with their Opportunity)
    expect(org.deleted.OpportunityContactRole).toBeUndefined();
    expect(org.deleted.OpportunityLineItem).toBeUndefined();
    // catalog/shared objects (upserted by natural key, reused across every dataset) are NEVER touched
    for (const catalogObject of ["Product2", "PricebookEntry", "Campaign", "UserRole", "User"]) {
      expect(org.deleted[catalogObject]).toBeUndefined();
      expect(org.queried.some((q) => q.sobject === catalogObject)).toBe(false);
    }
    expect(org.deleted.EmailMessage).toEqual(["02sA1", "02sA2", "02sB"]);
    // Transcript files are deleted via their parent ContentDocument (cascades the version) —
    // a ContentVersion CANNOT be deleted directly (INSUFFICIENT_ACCESS_OR_READONLY, org-verified).
    expect(org.deleted.ContentDocument).toEqual(["069A"]);
    expect(org.deleted.ContentVersion).toBeUndefined(); // regression guard: never delete the version directly
    expect(org.deleted.Task).toEqual(["00TA1", "00TA2", "00TB"]);
    expect(org.deleted.CaseComment).toEqual(["00aA1", "00aA2"]);
    expect(org.deleted.Account).toEqual(["001A", "001B"]);
    // order: children before their parents at every level
    const order = report.objects.map((o) => o.object);
    expect(order).toEqual(["CaseComment", "CampaignMember", "ContentDocument", "Task", "Event", "EmailMessage", "Opportunity", "Case", "Asset", "Contact", "Lead", "Account"]);
    expect(order.indexOf("CaseComment")).toBeLessThan(order.indexOf("Case"));
    expect(order.indexOf("Case")).toBeLessThan(order.indexOf("Account"));
    expect(order.indexOf("ContentDocument")).toBeLessThan(order.indexOf("Opportunity"));
    expect(order.indexOf("Task")).toBeLessThan(order.indexOf("Opportunity"));
    expect(order.indexOf("CampaignMember")).toBeLessThan(order.indexOf("Contact"));
  });

  it("also tears down Leads (Email-matched) and their CampaignMembers", async () => {
    const org = new MockOrg({
      leadsByEmail: { "jamie@acme-prospect.com": "00Q1" },
      accountsByName: { Stripe: "001A" },
      campaignMembersByLead: { "00Q1": ["00vL1"] },
    });
    const report = await teardownBundle(bundleWithLead, org, {});
    expect(report.leadsMatched).toBe(1);
    expect(org.deleted.Lead).toEqual(["00Q1"]);
    expect(org.deleted.CampaignMember).toEqual(["00vL1"]);
  });

  it("also finds a CONVERTED Lead's minted Account via Lead.Company (closes the convertLead orphan gap)", async () => {
    const org = new MockOrg({
      leadsByEmail: { "quinta.romero@crowdstrike.com": "00Q2" },
      accountsByName: { Stripe: "001A", CrowdStrike: "001C" }, // "CrowdStrike" was never in records.Account
      oppsByAccount: { "001C": ["006C"] }, // the Opportunity convertLead minted alongside the new Account
      contactsByAccount: { "001C": ["003C1"] },
    });
    const report = await teardownBundle(bundleWithConvertedLead, org, {});
    expect(org.deleted.Account).toContain("001C"); // the minted Account is found and deleted
    expect(org.deleted.Opportunity).toContain("006C");
    expect(org.deleted.Contact).toContain("003C1");
    expect(org.deleted.Lead).toEqual(["00Q2"]);
  });

  it("no matching Account/Lead → nothing to do", async () => {
    const org = new MockOrg({});
    const report = await teardownBundle(bundle, org, {});
    expect(report.accountsMatched).toBe(0);
    expect(report.leadsMatched).toBe(0);
    expect(report.totalDeleted).toBe(0);
  });

  it("is resilient — a failed delete request is reported, the cascade continues", async () => {
    const org = new MockOrg({
      accountsByName: { Stripe: "001A", Okta: "001B" },
      oppsByAccount: { "001A": ["006A"] },
      emailsByOpp: { "006A": ["02sA1"] },
      failDelete: new Set(["EmailMessage"]), // the email delete throws
    });
    const report = await teardownBundle(bundle, org, {});
    const email = report.objects.find((o) => o.object === "EmailMessage")!;
    expect(email.failed).toBe(1);
    expect(email.errors[0]).toMatch(/delete threw.*UNABLE_TO_LOCK_ROW/);
    // …but accounts still get deleted (cascade survived)
    expect(report.objects.find((o) => o.object === "Account")!.deleted).toBe(2);
  });
});
