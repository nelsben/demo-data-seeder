import { describe, it, expect } from "vitest";
import { AccountIdentity } from "../src/identity.js";

const VALID = {
  name: "Meridian Freight Systems",
  sfIndustry: "Transportation",
  domain: "meridianfreight.com",
  sector: "Regional LTL Trucking",
  employees: 4200,
  revenueUsd: 880_000_000,
  hq: "Columbus, United States",
  description: "Meridian Freight Systems is a regional LTL trucking and last-mile logistics carrier.",
  does: "regional freight and last-mile logistics",
  products: ["LTL freight", "last-mile delivery"],
  buyingDept: "Operations & Finance",
  painPhrase: "reconciling operations and finance reporting across acquired regional carriers",
};

describe("AccountIdentity schema", () => {
  it("accepts a complete, well-formed identity", () => {
    const parsed = AccountIdentity.parse(VALID);
    expect(parsed.name).toBe("Meridian Freight Systems");
    expect(parsed.products).toHaveLength(2);
  });

  it("rejects a missing required field", () => {
    const { painPhrase, ...missing } = VALID;
    expect(AccountIdentity.safeParse(missing).success).toBe(false);
  });

  it("rejects an empty products array (must reference at least one offering)", () => {
    expect(AccountIdentity.safeParse({ ...VALID, products: [] }).success).toBe(false);
  });

  it("rejects a non-numeric headcount", () => {
    expect(AccountIdentity.safeParse({ ...VALID, employees: "lots" }).success).toBe(false);
  });

  it("rejects an unknown extra field (strict — what we validate is what ships)", () => {
    expect(AccountIdentity.safeParse({ ...VALID, competitors: ["Tableau"] }).success).toBe(false);
  });

  it("rejects a too-short description", () => {
    expect(AccountIdentity.safeParse({ ...VALID, description: "a carrier" }).success).toBe(false);
  });
});
