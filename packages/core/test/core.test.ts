import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ScopeParams,
  ScenarioMix,
  CapabilityProfile,
  NarrativeBundle,
  PackRegistry,
  existingRef,
  parseExistingRef,
  type TargetPack,
} from "../src/index.js";

describe("ScopeParams (generic)", () => {
  it("applies defaults and round-trips a minimal scope", () => {
    const parsed = ScopeParams.parse({
      org: "demo-org",
      pack: "salescloud",
      volume: 12,
      scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 },
    });
    expect(parsed.mode).toBe("inputs");
    expect(parsed.dc).toBe("auto");
    expect(parsed.seed).toBe(42);
    expect(parsed.options).toEqual({});
  });

  it("requires a target pack and a positive volume", () => {
    expect(() => ScopeParams.parse({ org: "x", volume: 1, scenarioMix: { a: 100 } } as never)).toThrow();
    expect(() => ScopeParams.parse({ org: "x", pack: "p", volume: 0, scenarioMix: { a: 100 } })).toThrow();
  });

  it("enforces scenario-mix summing to 100 (names are the pack's, not core's)", () => {
    expect(() => ScenarioMix.parse({ a: 30, b: 30 })).toThrow();
    expect(ScenarioMix.parse({ a: 50, b: 50 })).toBeTruthy();
  });
});

describe("CapabilityProfile (generic, fail-open)", () => {
  it("parses a near-empty profile with gaps", () => {
    const p = CapabilityProfile.parse({
      org: "any-org",
      capturedAt: "2026-06-17T12:00:00.000Z",
      gaps: ["DC consumption limits: no confirmed read path"],
    });
    expect(p.copyProvider).toBe("static");
    expect(p.objects).toEqual([]);
    expect(p.installedPackages).toEqual([]);
  });

  it("has no pack-specific fields (domain-agnostic)", () => {
    const shape = Object.keys((CapabilityProfile as unknown as z.ZodObject<z.ZodRawShape>).shape);
    expect(shape).not.toContain("salescloud");
    expect(shape).toContain("objects");
    expect(shape).toContain("installedPackages");
  });
});

describe("existingRef / parseExistingRef (pre-existing org record targets)", () => {
  it("round-trips an object/field/value", () => {
    const ref = existingRef("Custom_Framework__c", "External_Id__c", "MEDDPICC_V1");
    expect(ref).toBe("@existing:Custom_Framework__c:External_Id__c:MEDDPICC_V1");
    expect(parseExistingRef(ref)).toEqual({ sobject: "Custom_Framework__c", field: "External_Id__c", value: "MEDDPICC_V1" });
  });
  it("keeps a value containing ':' intact (only the first two separators are structural)", () => {
    expect(parseExistingRef(existingRef("X__c", "URL__c", "https://a.test/x"))).toEqual({ sobject: "X__c", field: "URL__c", value: "https://a.test/x" });
  });
  it("returns null for a non-@existing string", () => {
    expect(parseExistingRef("@standardPricebook")).toBeNull();
    expect(parseExistingRef("plain-ref")).toBeNull();
    expect(parseExistingRef("@existing:OnlyOnePart")).toBeNull();
  });
});

describe("NarrativeBundle (generic container)", () => {
  it("keys records by sObject name and carries an opaque pack config", () => {
    const b = NarrativeBundle.parse({
      config: { anything: "the pack shapes this" },
      records: { Account: [{ Name: "Stripe" }], Signal_Event__c: [{ x: 1 }] },
      plan: { pack: "salescloud", mode: "inputs", withDc: false, seed: 42, asOf: "2026-06-17T00:00:00.000Z", requestedVolume: 1, volume: 1 },
    });
    expect(b.records.Account).toHaveLength(1);
    expect(b.plan.pack).toBe("salescloud");
  });
});

describe("PackRegistry + TargetPack", () => {
  const fakePack: TargetPack = {
    id: "fake",
    label: "Fake",
    description: "test pack",
    objects: ["Account"],
    picklists: { "Account.Type": ["Customer", "Prospect"] },
    scenarios: ["happy"],
    recordSchemas: { Account: z.object({ Name: z.string() }) },
    variability: { region: [{ value: "NA", weight: 1 }] },
    recordsPerUnitEstimate: 1,
    checkRequirements: (profile) =>
      profile.objects.some((o) => o.apiName === "Account" && o.present)
        ? []
        : [{ kind: "object:Account", detail: "Account not present", severity: "blocking" }],
    generate: () => ({ records: { Account: [] } }),
  };

  it("registers, resolves, and rejects duplicates/unknowns", () => {
    const reg = new PackRegistry().register(fakePack);
    expect(reg.get("fake").label).toBe("Fake");
    expect(reg.has("fake")).toBe(true);
    expect(() => reg.register(fakePack)).toThrow(/already registered/);
    expect(() => reg.get("nope")).toThrow(/unknown pack/);
  });

  it("checkRequirements flags a missing object as blocking", () => {
    const profile = CapabilityProfile.parse({ org: "o", capturedAt: "2026-06-17T00:00:00.000Z" });
    const reqs = fakePack.checkRequirements(profile);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.severity).toBe("blocking");
  });
});
