import { describe, it, expect } from "vitest";
import { voiceCardFor } from "../src/voice-cards.js";

describe("voiceCardFor", () => {
  it("gives the AE a proactive selling register", () => {
    const c = voiceCardFor("Alex", undefined, true);
    expect(c.persona).toBe("Account Executive");
    expect(c.register).toMatch(/account executive/i);
  });

  it("differentiates personas — a CFO and a champion do not share a register", () => {
    const cfo = voiceCardFor("Diane Okafor", "Economic Buyer", false);
    const champ = voiceCardFor("Maya Reyes", "Champion", false);
    expect(cfo.register).toMatch(/CFO|ROI|budget/i);
    expect(champ.register).toMatch(/champion/i);
    expect(cfo.register).not.toBe(champ.register);
  });

  it("is deterministic (same person ⇒ same card)", () => {
    expect(voiceCardFor("Diane Okafor", "Economic Buyer", false)).toEqual(voiceCardFor("Diane Okafor", "Economic Buyer", false));
  });

  it("keeps two same-persona writers from being clones (per-name quirk)", () => {
    const a = voiceCardFor("Diane Okafor", "Economic Buyer", false);
    const b = voiceCardFor("Omar Haddad", "Economic Buyer", false);
    expect(a.register).not.toBe(b.register); // same base register, different quirk
  });
});
