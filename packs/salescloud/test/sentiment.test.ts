import { describe, it, expect } from "vitest";
import { ratingForForeground, ratingForBulk } from "../src/sentiment.js";
import { SCENARIO_PROFILES } from "../src/variability.js";

describe("sentiment — Account.Rating projection (R2)", () => {
  it("foreground: the dossier sentiment SHAPE maps to Hot/Warm/Cold", () => {
    expect(ratingForForeground("accelerating")).toBe("Hot");
    expect(ratingForForeground("stalling")).toBe("Cold");
    expect(ratingForForeground("steady")).toBe("Warm");
  });

  it("every scenario archetype resolves where its narrative says it should", () => {
    for (const prof of Object.values(SCENARIO_PROFILES)) {
      expect(["Hot", "Warm", "Cold"]).toContain(ratingForForeground(prof.shape));
    }
    expect(ratingForForeground(SCENARIO_PROFILES["healthy-tech"]!.shape)).toBe("Hot");
    expect(ratingForForeground(SCENARIO_PROFILES["at-risk-budget"]!.shape)).toBe("Cold");
    expect(ratingForForeground(SCENARIO_PROFILES["stalled-portfolio"]!.shape)).toBe("Cold");
    expect(ratingForForeground(SCENARIO_PROFILES["churning-account"]!.shape)).toBe("Cold");
    expect(ratingForForeground(SCENARIO_PROFILES["rfp-gated"]!.shape)).toBe("Warm");
  });

  it("bulk: won/lost history maps to Hot/Warm/Cold (total over all 4 inputs)", () => {
    expect(ratingForBulk(true, false)).toBe("Hot"); // healthy customer
    expect(ratingForBulk(false, true)).toBe("Cold"); // lost / at-risk
    expect(ratingForBulk(true, true)).toBe("Warm"); // mixed
    expect(ratingForBulk(false, false)).toBe("Warm"); // open prospect, no signal
  });
});
