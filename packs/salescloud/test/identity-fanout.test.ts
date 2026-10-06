import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, standardProfile, type AccountIdentity, type GenericRecord } from "@dataseed/core";
import { planBundle, generateBundle, generateBundleWithIdentities } from "@dataseed/engine";
import { salescloudPack, ACCOUNT_INDUSTRIES, coerceIndustry, SELLER_COMPETITORS } from "../src/index.js";

const ASOF = "2026-01-01T00:00:00.000Z";
const profile = standardProfile(salescloudPack);
const scope = ScopeParams.parse({ org: "standard", pack: "salescloud", volume: 1, population: 0, scenarioMix: { "healthy-tech": 100 }, dc: "off", seed: 7, asOf: ASOF });
const plan = planBundle(scope, profile, salescloudPack, ASOF);
const idx = plan.units[0]!.index;

// sfIndustry "Logistics" is NOT a valid Account.Industry → must coerce to "Transportation" at the seam.
const IDENT: AccountIdentity = {
  name: "Aurora Provisions",
  sfIndustry: "Logistics",
  domain: "auroraprovisions.com",
  sector: "Food Distribution",
  employees: 2400,
  revenueUsd: 520_000_000,
  hq: "Austin, United States",
  description: "Aurora Provisions is a regional foodservice distribution company serving the South Central US.",
  does: "foodservice distribution and cold-chain logistics",
  products: ["foodservice distribution", "cold chain"],
  buyingDept: "Supply Chain & Finance",
  painPhrase: "reconciling distribution and finance reporting across distribution centers",
};

const withIdentity = () => generateBundleWithIdentities(plan, profile, salescloudPack, new Map([[idx, IDENT]]));

describe("coerceIndustry", () => {
  it("maps near-misses to valid Account.Industry values; everything resolves in-set", () => {
    expect(coerceIndustry("Fintech")).toBe("Finance");
    expect(coerceIndustry("EdTech")).toBe("Education");
    expect(coerceIndustry("Logistics")).toBe("Transportation");
    expect(coerceIndustry("Technology")).toBe("Technology");
    expect(coerceIndustry("absolute nonsense xyz")).toBe("Other");
    for (const raw of ["Fintech", "Healthcare delivery", "SaaS", "Trucking", "", undefined as unknown as string]) {
      expect((ACCOUNT_INDUSTRIES as readonly string[]).includes(coerceIndustry(raw))).toBe(true);
    }
  });
});

describe("the fan-out consuming a synthetic identity", () => {
  it("builds the Account from the identity (name/domain/coerced industry + firmographics)", () => {
    const acct = withIdentity().records.Account![0]!;
    expect(acct.Name).toBe("Aurora Provisions");
    expect(acct.Industry).toBe("Transportation"); // coerced from "Logistics"
    expect((ACCOUNT_INDUSTRIES as readonly string[]).includes(acct.Industry as string)).toBe(true);
    expect(acct.Website).toBe("https://auroraprovisions.com");
    expect(acct.NumberOfEmployees).toBe(2400);
    expect(acct.AnnualRevenue).toBe(520_000_000);
    expect(acct.Description).toContain("Aurora Provisions");
    expect(acct.Type).toBeTruthy(); // existing-customer (healthy-tech priorWin) → a Customer type
  });

  it("threads the identity domain into every contact email", () => {
    const contacts = withIdentity().records.Contact ?? [];
    expect(contacts.length).toBeGreaterThan(0);
    for (const c of contacts) expect((c.Email as string).endsWith("@auroraprovisions.com")).toBe(true);
  });

  it("grounds copy in the identity's pain but keeps the SELLER's competitors (never the prospect's own category)", () => {
    const b = withIdentity();
    const withGrounding = b.copyRequests.find((c) => (c.facts as { grounding?: { painPhrase?: string } } | undefined)?.grounding);
    const grounding = (withGrounding!.facts as { grounding: { painPhrase: string; competitors: string[] } }).grounding;
    expect(grounding.painPhrase).toBe(IDENT.painPhrase);
    expect(grounding.competitors).toEqual(SELLER_COMPETITORS); // self-product cure: always the seller's rivals
    expect(grounding.competitors).not.toContain("Aurora Provisions");
    const dossier = (b.records.Opportunity![0]!._meta as { dossier?: { competitor?: string } }).dossier;
    if (dossier?.competitor) expect(SELLER_COMPETITORS).toContain(dossier.competitor);
  });

  it("the no-identity path stays byte-identical to the plain anchor build (regression guard)", () => {
    const plain = generateBundle(plan, profile, salescloudPack);
    const emptyMap = generateBundleWithIdentities(plan, profile, salescloudPack, new Map());
    expect(JSON.stringify(emptyMap.records)).toBe(JSON.stringify(plain.records));
    // and the synthetic path genuinely differs (the company is the authored one, not the anchor)
    expect((withIdentity().records.Account![0] as GenericRecord).Name).not.toBe(plain.records.Account![0]!.Name);
  });
});
