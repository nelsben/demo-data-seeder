import { describe, it, expect } from "vitest";
import { ANCHORS } from "../src/anchors.js";

// The standard Salesforce Account.Industry picklist values — anchors must map to one of
// these so a load is FLS/picklist-correct (restricted picklists silently red a row).
const STANDARD_INDUSTRIES = new Set([
  "Agriculture", "Apparel", "Banking", "Biotechnology", "Chemicals", "Communications",
  "Construction", "Consulting", "Education", "Electronics", "Energy", "Engineering",
  "Entertainment", "Environmental", "Finance", "Food & Beverage", "Government", "Healthcare",
  "Hospitality", "Insurance", "Machinery", "Manufacturing", "Media", "Not For Profit",
  "Other", "Recreation", "Retail", "Shipping", "Technology", "Telecommunications",
  "Transportation", "Utilities",
]);

describe("ANCHORS", () => {
  it("ships a broad anchor set (the BRIEF's ~50 real-company axis)", () => {
    expect(ANCHORS.length).toBeGreaterThanOrEqual(50);
  });

  it("has unique names and domains (distinct-until-exhausted assignment relies on this)", () => {
    expect(new Set(ANCHORS.map((a) => a.name)).size).toBe(ANCHORS.length);
    expect(new Set(ANCHORS.map((a) => a.domain)).size).toBe(ANCHORS.length);
  });

  it("spans many industries — widening the variability matrix", () => {
    expect(new Set(ANCHORS.map((a) => a.sfIndustry)).size).toBeGreaterThanOrEqual(15);
  });

  it("every sfIndustry is a VALID standard Account.Industry value (load-correct)", () => {
    const bad = ANCHORS.filter((a) => !STANDARD_INDUSTRIES.has(a.sfIndustry));
    expect(bad.map((a) => `${a.name}:${a.sfIndustry}`)).toEqual([]);
  });

  it("every domain is well-formed (a plausible email host)", () => {
    for (const a of ANCHORS) {
      expect(a.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(a.name.trim()).toBe(a.name);
    }
  });
});
