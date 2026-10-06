import { describe, it, expect } from "vitest";
import { CapabilityProfile } from "@dataseed/core";
import { salescloudPack, SALESCLOUD_LOAD_ORDER } from "../src/index.js";

describe("salescloudPack implements TargetPack", () => {
  it("exposes id, scenarios, picklists, objects in load order", () => {
    expect(salescloudPack.id).toBe("salescloud");
    expect(salescloudPack.scenarios).toContain("at-risk-budget");
    expect(salescloudPack.objects).toEqual(SALESCLOUD_LOAD_ORDER);
    // load order: parents before children (the master-detail / lookup chain)
    expect(salescloudPack.objects.indexOf("Account")).toBeLessThan(salescloudPack.objects.indexOf("Opportunity"));
    expect(salescloudPack.objects.indexOf("Opportunity")).toBeLessThan(
      salescloudPack.objects.indexOf("OpportunityLineItem"),
    );
  });

  it("has a record schema for every object it declares", () => {
    for (const obj of salescloudPack.objects) {
      expect(salescloudPack.recordSchemas[obj], `missing schema for ${obj}`).toBeDefined();
    }
  });

  it("targets only standard Sales Cloud objects (no custom __c objects)", () => {
    const custom = salescloudPack.objects.filter((o) => o.endsWith("__c"));
    expect(custom).toEqual([]);
  });
});

describe("checkRequirements against a CapabilityProfile", () => {
  const emptyProfile = () => CapabilityProfile.parse({ org: "o", capturedAt: "2026-06-17T00:00:00.000Z", objects: [] });

  it("never blocks — standard objects ship in every Salesforce org", () => {
    const reqs = salescloudPack.checkRequirements(emptyProfile());
    expect(reqs).toEqual([]);
  });
});
