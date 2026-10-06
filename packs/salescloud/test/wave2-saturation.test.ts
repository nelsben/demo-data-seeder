import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";
import { ANCHOR_HQ, geoForCountry, US_STATE_ZIP3 } from "../src/anchor-hq.js";
import { ANCHORS } from "../src/anchors.js";
import { splitHq } from "../src/identity.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const profile = () => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF });
const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 9, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
const build = (over = {}) => buildBundle(scope(over), profile(), salescloudPack, ASOF);

const dialPrefix = (phone: string): string => (/^(\+\d+)\s/.exec(phone)?.[1] ?? "");
const fgAccounts = (b: ReturnType<typeof build>) => b.records.Account!.filter((a) => (a._meta as { scenario?: string }).scenario);
const fgContacts = (b: ReturnType<typeof build>) => b.records.Contact!.filter((c) => (c._meta as { persona?: string }).persona);
const acctOf = (b: ReturnType<typeof build>, ref: string) => b.records.Account!.find((a) => a._ref === ref);

describe("wave-2 — ANCHOR_HQ table integrity", () => {
  it("covers EVERY anchor by exact name (so no cycle-0 anchor falls back to a region-random HQ)", () => {
    const missing = ANCHORS.map((a) => a.name).filter((n) => !ANCHOR_HQ[n]);
    expect(missing).toEqual([]);
  });

  it("every curated HQ is well-formed — non-empty city, dual-emit consistent codes", () => {
    for (const [name, g] of Object.entries(ANCHOR_HQ)) {
      expect(g.city, name).not.toBe("");
      expect(g.country, name).not.toBe("");
      if (g.countryCode) expect(g.countryCode.length, name).toBe(2);
      // a state present ⇔ a state code present (never a label without its ISO code, or vice versa)
      expect(Boolean(g.state), `${name} state/stateCode must agree`).toBe(Boolean(g.stateCode));
    }
  });
});

describe("wave-2 — synthetic HQ helpers (label-only safety)", () => {
  it("geoForCountry recovers ISO codes for known countries, returns undefined for unknown (→ label-only, no fabricated code)", () => {
    expect(geoForCountry("United States")?.countryCode).toBe("US");
    expect(geoForCountry("United Arab Emirates")).toBeUndefined(); // not in GEO_BY_REGION → synthetic stays code-less
  });

  it("splitHq parses 'City, Country' and defaults country sensibly", () => {
    expect(splitHq("Dubai, United Arab Emirates")).toEqual({ city: "Dubai", country: "United Arab Emirates" });
    expect(splitHq("Austin")).toEqual({ city: "Austin", country: "United States" });
  });
});

describe("wave-2 — geo-coherent billing + phone (anchor path)", () => {
  it("a foreground anchor Account carries its CURATED real HQ (never a random city)", () => {
    for (const a of fgAccounts(build())) {
      const hq = ANCHOR_HQ[a.Name as string];
      expect(hq, `${a.Name} must be curated`).toBeDefined();
      expect(a.BillingCity).toBe(hq!.city);
      expect(a.BillingCountry).toBe(hq!.country);
      expect(typeof a.Phone).toBe("string");
      expect(a.BillingStreet).toBeTruthy();
    }
  });

  it("ONE HQ per account — every contact's MailingCity == its account's BillingCity, and phone dial codes agree", () => {
    const b = build();
    for (const c of fgContacts(b)) {
      const a = acctOf(b, (c._refs as Record<string, string>).AccountId!)!;
      expect(c.MailingCity).toBe(a.BillingCity);
      expect(c.MailingCountry).toBe(a.BillingCountry);
      expect(dialPrefix(c.Phone as string)).toBe(dialPrefix(a.Phone as string)); // same country → same dial code
      expect(dialPrefix(c.Phone as string)).not.toBe("");
    }
  });

  it("v19 dual-emit invariant — a *State is present IFF its *StateCode is (never a guessed code, never a code-less label)", () => {
    const rows = [...fgAccounts(build()), ...fgContacts(build())] as Record<string, unknown>[];
    for (const r of rows) {
      expect(Boolean(r.BillingState) === Boolean(r.BillingStateCode), "Billing state/code must agree").toBe(true);
      expect(Boolean(r.MailingState) === Boolean(r.MailingStateCode), "Mailing state/code must agree").toBe(true);
      for (const code of [r.BillingStateCode, r.BillingCountryCode, r.MailingStateCode, r.MailingCountryCode]) {
        if (code !== undefined) expect((code as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("BillingPostalCode is BOUND to the state — a US ZIP's first 3 digits match the state's ZIP region (never a cross-state ZIP)", () => {
    for (const a of fgAccounts(build())) {
      const zip = a.BillingPostalCode as string | undefined;
      const stateCode = a.BillingStateCode as string | undefined;
      if (a.BillingCountryCode === "US" && stateCode) {
        expect(zip, `${a.Name} (US) should carry a state-coherent ZIP`).toBeTruthy();
        expect(zip!.slice(0, 3)).toBe(US_STATE_ZIP3[stateCode]); // CA→941xx, MA→021xx — never a TX ZIP on a CA address
      } else {
        expect(zip, `${a.Name} (non-US/no-state) must omit the ZIP rather than fake a US format`).toBeUndefined();
      }
    }
  });

  it("never fabricates Ownership for a real anchor (the v25 no-firmographic-fabrication stance holds)", () => {
    for (const a of fgAccounts(build())) expect(a.Ownership).toBeUndefined();
  });
});

describe("wave-2 — Contact.ReportsToId org chart", () => {
  const RANK: Record<string, number> = { "Economic Buyer": 0, Champion: 1, Skeptic: 1, "Technical Evaluator": 2, Blocker: 2, Coach: 3, "End User": 4 };

  it("is acyclic, points strictly up-rank, stays in-cast, and never makes a CFO report to anyone", () => {
    const b = build();
    const personaOf = (ref: string) => (b.records.Contact!.find((c) => c._ref === ref)?._meta as { persona?: string })?.persona ?? "End User";
    const acctOfRef = (ref: string) => (b.records.Contact!.find((c) => c._ref === ref)?._refs as Record<string, string>).AccountId;
    for (const c of fgContacts(b)) {
      const mgr = (c._softRefs as Record<string, string> | undefined)?.ReportsToId;
      if (personaOf(c._ref as string) === "Economic Buyer") { expect(mgr, "a CFO has no manager in-cast").toBeUndefined(); continue; }
      if (!mgr) continue; // top-of-tree (no senior present) is allowed
      // in-cast: the target is a real contact in the SAME account
      const target = b.records.Contact!.find((x) => x._ref === mgr);
      expect(target, "ReportsToId points to a real in-bundle contact").toBeDefined();
      expect(acctOfRef(mgr)).toBe((c._refs as Record<string, string>).AccountId);
      // strictly up-rank → acyclic
      expect(RANK[personaOf(mgr)]!).toBeLessThan(RANK[personaOf(c._ref as string)]!);
    }
  });

  it("a Champion reports to the Economic Buyer whenever an EB is in the cast", () => {
    const b = build();
    const byAcct = new Map<string, Record<string, unknown>[]>();
    for (const c of fgContacts(b)) {
      const aid = (c._refs as Record<string, string>).AccountId!;
      const arr = byAcct.get(aid) ?? byAcct.set(aid, []).get(aid)!;
      arr.push(c as Record<string, unknown>);
    }
    for (const cast of byAcct.values()) {
      const eb = cast!.find((c) => (c._meta as { persona?: string }).persona === "Economic Buyer");
      const champ = cast!.find((c) => (c._meta as { persona?: string }).persona === "Champion");
      if (eb && champ) expect((champ._softRefs as Record<string, string>)?.ReportsToId).toBe(eb._ref);
    }
  });
});

describe("wave-2 — determinism", () => {
  it("is byte-stable: two builds at the same seed produce identical Account + Contact records", () => {
    const a = build(), c = build();
    expect(JSON.stringify(a.records.Account)).toBe(JSON.stringify(c.records.Account));
    expect(JSON.stringify(a.records.Contact)).toBe(JSON.stringify(c.records.Contact));
  });
});
