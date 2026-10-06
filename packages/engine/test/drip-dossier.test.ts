// Coverage for drip/dossier.ts's fallback chain (review finding #4): resolveDripDossier resolves one
// deal's dossier cheapest-first — cache → registry → org reconstruction — and each hit short-circuits
// every later, more expensive source. Dependency-injected (DossierResolverDeps) so the chain is
// unit-testable with plain mock functions: no real org, no real registry.db.

import { describe, it, expect, vi } from "vitest";
import { DealDossier } from "@dataseed/core";
import { resolveDripDossier, memoryDripDossierCache, dripDossierKey, type DossierResolverDeps } from "../src/drip/dossier.js";

const registryDossier = DealDossier.parse({
  scenario: "at-risk-budget",
  arc: "Acme's budget got contested; the champion is going quiet.",
  cast: [{ ref: "003A", name: "Dana Kessler", persona: "Champion" }],
  beats: [{ ref: "email-0", kind: "email", day: "2026-08-20T15:00:00.000Z", author: "Alex", direction: "outbound", sentiment: "Neutral", summary: "AE confirms the pilot timeline" }],
  numbers: { amountUsd: 500_000 },
  provenance: "static",
});

const input = { org: "dev-frontend", pack: "salescloud", seed: "demo-seed", oppId: "006A", oppName: "Acme — Platform Expansion", accountName: "Acme" };

function deps(overrides: Partial<DossierResolverDeps> = {}): DossierResolverDeps {
  return {
    findRegistryDossier: vi.fn(() => null),
    fetchReconstructionRows: vi.fn(async () => ({ cast: [], emails: [], tasks: [], transcripts: [] })),
    fetchDealFacts: vi.fn(async () => ({ amountUsd: 250_000 })),
    ...overrides,
  };
}

describe("resolveDripDossier — cache → registry → org reconstruction, cheapest first", () => {
  it("a cache hit short-circuits everything else — the registry and reconstruction deps are never called", async () => {
    const cache = memoryDripDossierCache({ [dripDossierKey(input.seed, input.org, input.oppId)]: registryDossier });
    const d = deps();
    const result = await resolveDripDossier(cache, d, input);
    expect(result).toEqual(registryDossier);
    expect(d.findRegistryDossier).not.toHaveBeenCalled();
    expect(d.fetchReconstructionRows).not.toHaveBeenCalled();
    expect(d.fetchDealFacts).not.toHaveBeenCalled();
  });

  it("a registry hit short-circuits reconstruction, AND caches the result so day 2 skips the registry too", async () => {
    const cache = memoryDripDossierCache();
    const d = deps({ findRegistryDossier: vi.fn(() => registryDossier) });
    const result = await resolveDripDossier(cache, d, input);
    expect(result).toEqual(registryDossier);
    expect(d.fetchReconstructionRows).not.toHaveBeenCalled();
    expect(d.fetchDealFacts).not.toHaveBeenCalled();

    // day 2: cache now has it — a fresh deps object (asserting no calls) still resolves correctly
    const freshDeps = deps({ findRegistryDossier: vi.fn(() => registryDossier) });
    const second = await resolveDripDossier(cache, freshDeps, input);
    expect(second).toEqual(registryDossier);
    expect(freshDeps.findRegistryDossier).not.toHaveBeenCalled();
  });

  it("falls back to org reconstruction on a registry miss, and caches the reconstructed dossier", async () => {
    const cache = memoryDripDossierCache();
    const d = deps({
      findRegistryDossier: vi.fn(() => null),
      fetchReconstructionRows: vi.fn(async () => ({
        cast: [{ contactId: "003A", name: "Dana Kessler", role: "Decision Maker" }],
        emails: [],
        tasks: [],
        transcripts: [],
      })),
      fetchDealFacts: vi.fn(async () => ({ amountUsd: 250_000, closeDate: "2026-12-31", stageName: "Proposal" })),
    });
    const result = await resolveDripDossier(cache, d, input);
    expect(result.scenario).toBe("steady-progress"); // FALLBACK_ARC — reconstruction can't recover the real scenario
    expect(result.numbers.amountUsd).toBe(250_000);
    expect(result.cast.map((c) => c.name)).toContain("Dana Kessler");
    expect(d.fetchReconstructionRows).toHaveBeenCalledWith(input.oppId);
    expect(d.fetchDealFacts).toHaveBeenCalledWith(input.oppId);

    // cached now — a second resolve never touches the deps again
    const freshDeps = deps();
    const second = await resolveDripDossier(cache, freshDeps, input);
    expect(second).toEqual(result);
    expect(freshDeps.findRegistryDossier).not.toHaveBeenCalled();
    expect(freshDeps.fetchReconstructionRows).not.toHaveBeenCalled();
  });

  it("a deal with zero recoverable org history still gets a minimal dossier (empty cast/beats), never throws", async () => {
    const cache = memoryDripDossierCache();
    const d = deps(); // registry miss, empty reconstruction rows, bare deal facts
    const result = await resolveDripDossier(cache, d, input);
    expect(result.cast).toEqual([]);
    expect(result.beats).toEqual([]);
    expect(result.scenario).toBe("steady-progress");
  });
});
