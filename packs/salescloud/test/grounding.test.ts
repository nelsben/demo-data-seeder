import { describe, it, expect } from "vitest";
import { resolveGrounding } from "../src/grounding.js";
import { ANCHORS } from "../src/anchors.js";

describe("resolveGrounding", () => {
  it("returns curated, accurate facts for a marquee anchor", () => {
    const g = resolveGrounding({ name: "Snowflake", sfIndustry: "Technology" });
    expect(g.does).toMatch(/data warehous/i);
    expect(g.products).toContain("Snowpark");
    expect(g.painPhrase.length).toBeGreaterThan(0);
  });

  it("falls back to a sector template for an unknown company in a known industry", () => {
    const g = resolveGrounding({ name: "Nonexistent Co", sfIndustry: "Insurance" });
    expect(g.painPhrase).toMatch(/claims/i);
    expect(g.buyingDept.length).toBeGreaterThan(0);
  });

  it("falls back to a generic pack for an unknown industry", () => {
    const g = resolveGrounding({ name: "Nonexistent Co", sfIndustry: "Underwater Basket Weaving" });
    expect(g.does).toBe("its business");
  });

  it("every shipped anchor resolves to a complete, non-empty pack", () => {
    for (const a of ANCHORS) {
      const g = resolveGrounding(a);
      expect(g.does.length, a.name).toBeGreaterThan(0);
      expect(g.painPhrase.length, a.name).toBeGreaterThan(0);
      expect(g.buyingDept.length, a.name).toBeGreaterThan(0);
      expect(g.products.length, a.name).toBeGreaterThan(0);
    }
  });
});
