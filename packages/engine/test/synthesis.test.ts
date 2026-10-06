import { describe, it, expect } from "vitest";
import { probeSynthesis } from "../src/introspect/synthesis.js";
import type { SfClient } from "../src/introspect/sf-client.js";
import type { TargetPack } from "@dataseed/core";

// A pack with two probes — one queryable, one absent — to exercise fail-soft per probe.
const pack = {
  id: "p",
  synthesisView: {
    probes: [
      { object: "Signal_Event__c", label: "Signals", sampleField: "Signal_Summary__c" },
      { object: "Missing__c", label: "Missing" },
    ],
  },
} as unknown as TargetPack;

const noViewPack = { id: "bare" } as unknown as TargetPack;

// Mock SfClient — only query() is used by probeSynthesis.
const client = {
  async query(soql: string) {
    if (/Missing__c/.test(soql)) throw new Error("INVALID_TYPE: sObject type 'Missing__c' is not supported.");
    if (/COUNT\(Id\)/.test(soql)) return [{ c: 27 }];
    return [{ Signal_Summary__c: "Budget blocker and deal delay risk" }];
  },
} as unknown as SfClient;

describe("probeSynthesis", () => {
  it("counts derived records + samples a field, and is fail-soft per absent object", async () => {
    const summary = await probeSynthesis(client, pack, "demo-org");
    expect(summary.supported).toBe(true);
    expect(summary.org).toBe("demo-org");

    const signals = summary.probes.find((p) => p.object === "Signal_Event__c")!;
    expect(signals.present).toBe(true);
    expect(signals.count).toBe(27);
    expect(signals.sample).toBe("Budget blocker and deal delay risk");

    const missing = summary.probes.find((p) => p.object === "Missing__c")!;
    expect(missing.present).toBe(false); // INVALID_TYPE → reported, not thrown
    expect(missing.count).toBe(0);

    expect(summary.total).toBe(27); // only the present object contributes
  });

  it("reports unsupported when the pack declares no synthesisView", async () => {
    const summary = await probeSynthesis(client, noViewPack, "demo-org");
    expect(summary.supported).toBe(false);
    expect(summary.probes).toHaveLength(0);
  });
});
