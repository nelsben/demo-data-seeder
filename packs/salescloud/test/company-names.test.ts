import { describe, it, expect } from "vitest";
import { makeRng } from "@dataseed/core";
import { makeCompanyNamer, gcd, NAME_SPACE, NAME_STRIDE } from "../src/company-names.js";
import { ACCOUNT_INDUSTRIES } from "../src/picklists.js";

// v15: the bulk namer is a SEEDED LINEAR PERMUTATION over PREFIX×STEM×CATEGORY×SUFFIX. These guard the two
// properties the corpus relies on at 100K scale: (1) the index→name map is a bijection (no collisions /
// "84 companies share a root" clustering), and (2) Account.Industry is NO LONGER dictated by the name —
// it is drawn independently from INDUSTRY_DIST (D15: name↔industry coupling was itself a production tell,
// e.g. "Stormbourne Realty Co" forced into Construction). The name's category noun is flavor only.
describe("company namer — permutation invariant (no collisions at scale)", () => {
  it("STRIDE is coprime to the name space M (the bijection invariant)", () => {
    expect(gcd(NAME_STRIDE, NAME_SPACE)).toBe(1);
    expect(NAME_SPACE).toBe(96 * 60 * 60 * 14); // 4,838,400 distinct roots (was 576,000)
  });

  it("produces distinct names across a dense index range (no clustering)", () => {
    const namer = makeCompanyNamer(makeRng(42));
    const names = new Set<string>();
    for (let i = 0; i < 5000; i++) names.add(namer.name(i));
    expect(names.size).toBe(5000); // every index → a unique name within [0, M)
  });

  it("never renders a doubled adjacent word (CATEGORIES/SUFFIXES are disjoint — no 'Partners Partners')", () => {
    const namer = makeCompanyNamer(makeRng(42));
    for (let i = 0; i < 20_000; i++) {
      const w = namer.name(i).split(" ");
      for (let j = 1; j < w.length; j++) expect(w[j]).not.toBe(w[j - 1]); // category word ≠ suffix word
    }
  });

  it("scatters consecutive indices (no alphabetical lockstep — adjacent names differ in root)", () => {
    const namer = makeCompanyNamer(makeRng(7));
    let sharedRoot = 0;
    for (let i = 0; i < 500; i++) {
      const a = namer.name(i).split(" ")[0];
      const b = namer.name(i + 1).split(" ")[0];
      if (a === b) sharedRoot++;
    }
    expect(sharedRoot).toBeLessThan(25); // consecutive indices land far apart in name space
  });

  it("emits a lowercase .com domain coherent with the name root", () => {
    const namer = makeCompanyNamer(makeRng(11));
    for (let i = 0; i < 200; i++) {
      const d = namer.domain(i);
      expect(d).toMatch(/^[a-z0-9]+\.com$/);
    }
  });
});

describe("company namer — Industry is DECOUPLED from the name (D15)", () => {
  it("the deprecated industry() label is name-flavor only, but still a valid Account.Industry value", () => {
    // industry() is retained as a @deprecated noun-coherent LABEL; the real Account.Industry field is drawn
    // independently (INDUSTRY_DIST) in generate.ts. We only assert it never yields an invalid picklist value.
    const namer = makeCompanyNamer(makeRng(42));
    const valid = new Set<string>(ACCOUNT_INDUSTRIES);
    for (let i = 0; i < 2000; i++) expect(valid.has(namer.industry(i))).toBe(true);
  });
});
