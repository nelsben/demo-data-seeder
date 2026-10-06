import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, type GenericRecord } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack } from "../src/index.js";
import { SALESCLOUD_LOAD_ORDER, SALESCLOUD_RECORD_SCHEMAS } from "../src/schemas.js";
import { TASK_STATUS, TASK_PRIORITY, TASK_SUBTYPE, CALL_TYPE, EMAIL_STATUS, EVENT_SHOW_AS, CASE_STATUS, CASE_ORIGIN, CASE_PRIORITY } from "../src/picklists.js";
import { GEO_BY_REGION, PROBABILITY, FORECASTCATEGORY, COUNTRY_DIAL } from "../src/variability.js";
import { NAME_SPACE } from "../src/company-names.js";
import { US_STATE_ZIP3 } from "../src/anchor-hq.js";
import { SELLER_DOMAIN } from "../src/generate.js";

const ASOF = "2026-06-17T00:00:00.000Z";
const profile = () => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF });
const scope = (over: Record<string, unknown>) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 1, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });
// A dense, sizable bulk population so every optional family is exercised.
const dense = buildBundle(scope({ volume: 1, population: 600, bulkDensity: 1, seed: "bulk-graph" }), profile(), salescloudPack, ASOF);
const isBulk = (r: GenericRecord) => (r._meta as { tier?: string } | undefined)?.tier === "bulk";

describe("Phase 4E bulk Sales-Cloud graph — load-correctness", () => {
  it("registers every new object in the load order AND gives it a record schema", () => {
    for (const o of ["Event", "Asset", "Case", "CaseComment"]) {
      expect(SALESCLOUD_LOAD_ORDER).toContain(o);
      expect(Object.keys(SALESCLOUD_RECORD_SCHEMAS)).toContain(o);
    }
  });

  it("bulk Tasks carry a valid EAC TaskSubtype + (for calls) the ECI telephony fields — picklist-correct, inert by tier", () => {
    const tasks = dense.records.Task!.filter(isBulk);
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(TASK_SUBTYPE as readonly string[]).toContain(t.TaskSubtype); // v18: every bulk task is now EAC-typed
      expect(TASK_STATUS as readonly string[]).toContain(t.Status);
      expect(TASK_PRIORITY as readonly string[]).toContain(t.Priority);
      expect(typeof t.ActivityDate).toBe("string");
      expect((t._refs as Record<string, string>).WhatId).toMatch(/^bulk-opp-/);
      expect((t._meta as { tier?: string }).tier).toBe("bulk"); // inert by TIER (fires no cascade), not by lacking a subtype
      if (t.TaskSubtype === "Call") {
        expect(CALL_TYPE as readonly string[]).toContain(t.CallType); // the ECI telephony shape
        expect(typeof t.CallDurationInSeconds).toBe("number");
        expect(typeof t.CallDisposition).toBe("string");
      } else {
        expect(t.CallType).toBeUndefined(); // non-call subtypes carry no telephony fields
      }
    }
    // The EAC shape is VARIED across the corpus — multiple subtypes incl. logged calls (not all plain 'Task').
    const subtypes = new Set(tasks.map((t) => t.TaskSubtype));
    expect(subtypes.size).toBeGreaterThanOrEqual(2);
    expect([...subtypes]).toContain("Call");
  });

  it("bulk EmailMessage threads are EAC-shaped — threaded, RelatedTo an Opp, coherent From/To, valid Status", () => {
    const emails = dense.records.EmailMessage!.filter(isBulk);
    expect(emails.length).toBeGreaterThan(0);
    const oppRefs = new Set(dense.records.Opportunity!.map((o) => o._ref));
    const byThread = new Map<string, number>();
    for (const e of emails) {
      expect((e._refs as Record<string, string>).RelatedToId).toMatch(/^bulk-opp-/); // wired to the Opp, never the Account
      expect(oppRefs.has((e._refs as Record<string, string>).RelatedToId)).toBe(true);
      expect(EMAIL_STATUS as readonly string[]).toContain(e.Status); // '0' inbound / '3' outbound
      expect(e.Incoming === true ? e.Status : "x").toBe(e.Incoming === true ? "0" : "x"); // inbound ⇒ New
      expect(typeof e.TextBody).toBe("string");
      expect((e.TextBody as string).length).toBeGreaterThan(0); // bulk bodies are filled INLINE (no empty CopyRequest seam)
      expect(typeof e.ThreadIdentifier).toBe("string");
      // From/To flip with direction: inbound is FROM the buyer (their own domain), outbound is FROM
      // the rep on OUR fixed seller brand (never derived from the prospect's own domain — that read as
      // impersonation, e.g. "ae@zscaler-sales.com").
      if (e.Incoming === true) expect(e.FromAddress).not.toMatch(new RegExp(SELLER_DOMAIN.replace(".", "\\.") + "$"));
      else expect(e.FromAddress).toMatch(new RegExp(SELLER_DOMAIN.replace(".", "\\.") + "$"));
      byThread.set(e.ThreadIdentifier as string, (byThread.get(e.ThreadIdentifier as string) ?? 0) + 1);
    }
    // Real threads exist (a shared ThreadIdentifier groups multiple messages), not all singletons.
    expect([...byThread.values()].some((n) => n >= 2)).toBe(true);
  });

  it("bulk ContentVersion transcripts are well-formed WebVTT, published against an Opp", () => {
    const cvs = dense.records.ContentVersion!.filter(isBulk);
    expect(cvs.length).toBeGreaterThan(0);
    const oppRefs = new Set(dense.records.Opportunity!.map((o) => o._ref));
    for (const cv of cvs) {
      expect(oppRefs.has((cv._refs as Record<string, string>).FirstPublishLocationId)).toBe(true);
      expect(cv.PathOnClient as string).toMatch(/\.vtt$/);
      const vtt = cv.VersionData as string;
      expect(vtt.startsWith("WEBVTT")).toBe(true); // the WebVTT header
      expect(vtt).toMatch(/\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d/); // at least one cue timestamp
      expect(vtt).toMatch(/\n[^\n]+: /); // at least one "Speaker: line"
    }
  });

  it("bulk Events carry a valid ShowAs and a well-ordered Start/End window", () => {
    const events = dense.records.Event!.filter(isBulk);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(EVENT_SHOW_AS as readonly string[]).toContain(e.ShowAs);
      expect(new Date(e.EndDateTime as string).getTime()).toBeGreaterThan(new Date(e.StartDateTime as string).getTime());
    }
  });

  it("bulk Cases use the standard Status/Origin/Priority sets; Closed cases carry a ClosedDate", () => {
    const cases = dense.records.Case!.filter(isBulk);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(CASE_STATUS as readonly string[]).toContain(c.Status);
      expect(CASE_ORIGIN as readonly string[]).toContain(c.Origin);
      expect(CASE_PRIORITY as readonly string[]).toContain(c.Priority);
      if (c.Status === "Closed") expect(typeof c.ClosedDate).toBe("string");
    }
    // Cases only attach to CUSTOMER accounts (the support/health story is post-sale).
    const customerAccts = new Set(dense.records.Account!.filter((a) => String(a.Type).startsWith("Customer")).map((a) => a._ref));
    for (const c of cases) expect(customerAccts.has((c._refs as Record<string, string>).AccountId)).toBe(true);
  });

  it("bulk Assets reference the shared catalog + an Account, and omit the org-configurable Status", () => {
    const assets = dense.records.Asset!.filter(isBulk);
    expect(assets.length).toBeGreaterThan(0);
    const products = new Set(dense.records.Product2!.map((p) => p._ref));
    for (const a of assets) {
      const refs = a._refs as Record<string, string>;
      expect(products.has(refs.Product2Id)).toBe(true);
      expect(refs.AccountId).toMatch(/^bulk-acct-/);
      expect(a.Status).toBeUndefined(); // NULL fail-soft — Asset.Status is org-configurable
    }
  });

  it("committee OCR expands to distinct contacts with exactly one primary per opp", () => {
    const byOpp = new Map<string, GenericRecord[]>();
    for (const ocr of dense.records.OpportunityContactRole!.filter(isBulk)) {
      const opp = String((ocr._refs as Record<string, string>).OpportunityId);
      const arr = byOpp.get(opp) ?? [];
      arr.push(ocr);
      byOpp.set(opp, arr);
    }
    expect(byOpp.size).toBeGreaterThan(0);
    for (const ocrs of byOpp.values()) {
      expect(ocrs.filter((o) => o.IsPrimary === true)).toHaveLength(1); // exactly one primary
      const contacts = ocrs.map((o) => (o._refs as Record<string, string>).ContactId);
      expect(new Set(contacts).size).toBe(contacts.length); // distinct contacts (no double-roled contact)
    }
  });

  it("is fully deterministic across the whole graph (same seed → byte-identical)", () => {
    const again = buildBundle(scope({ volume: 1, population: 600, bulkDensity: 1, seed: "bulk-graph" }), profile(), salescloudPack, ASOF);
    for (const o of ["Task", "Event", "Case", "CaseComment", "Asset", "OpportunityContactRole", "OpportunityLineItem"]) {
      expect(JSON.stringify(again.records[o])).toBe(JSON.stringify(dense.records[o]));
    }
  });
});

// v15 bulk-tier realism overhaul — the corpus-quality guarantees that the 100K audit drove. These lock in the
// hollow-record fills, the variety floors (so "10 distinct subjects / 505K rows" can't regress), the real line
// items, and the cross-field coherence (dates / Type / name-decoupling / billing) that a VP would catch.
describe("Phase v15 bulk graph — realism: hollow-record fills + variety + coherence", () => {
  const bulkTasks = dense.records.Task!.filter(isBulk);
  const bulkCases = dense.records.Case!.filter(isBulk);
  const bulkOpps = dense.records.Opportunity!.filter(isBulk);
  const bulkComments = dense.records.CaseComment!.filter(isBulk);
  const oppById = new Map<string, GenericRecord>(bulkOpps.map((o) => [String(o._ref), o]));
  const str = (r: GenericRecord, f: string) => (r[f] as string | undefined) ?? "";
  const ratio = (vals: string[]) => new Set(vals).size / Math.max(1, vals.length);

  it("FILLS the previously-hollow fields: every bulk Task + Case carries a non-empty Description", () => {
    expect(bulkTasks.length).toBeGreaterThan(0);
    expect(bulkCases.length).toBeGreaterThan(0);
    for (const t of bulkTasks) expect(str(t, "Description").length).toBeGreaterThan(0);
    for (const c of bulkCases) expect(str(c, "Description").length).toBeGreaterThan(0);
  });

  it("subjects + comment bodies are VARIED (not a 10-item pool repeated across the corpus)", () => {
    expect(ratio(bulkTasks.map((t) => str(t, "Subject")))).toBeGreaterThan(0.4); // was 10 distinct / many-thousands
    expect(ratio(dense.records.Event!.filter(isBulk).map((e) => str(e, "Subject")))).toBeGreaterThan(0.3);
    // v20: EmailMessage subjects were a 20-line static pool (44 distinct / 226 — the "Kicking off onboarding"
    // ×26 tell). Now {Account}/{Dept}/{object}-tokened → grounded + high-cardinality (≈65% distinct on the corpus).
    // EmailMessage subjects are shared within a thread (the opener's subject + "Re:" replies), so the distinct
    // COUNT is the right tell — not the ratio (Re: chains depress it). Was a ~20-line static pool (≤40 distinct
    // incl. Re:, "Kicking off onboarding" ×26); now {Account}/{Dept}/{object}-tokened → hundreds of distinct.
    expect(new Set(dense.records.EmailMessage!.filter(isBulk).map((e) => str(e, "Subject"))).size).toBeGreaterThan(200);
    expect(ratio(bulkComments.map((c) => str(c, "CommentBody")))).toBeGreaterThan(0.5); // was 9 distinct / 126K
    // CaseComment threads are status-coherent: no "resolved/closed" language on a still-open case.
    const openCaseRefs = new Set(bulkCases.filter((c) => c.Status !== "Closed").map((c) => c._ref));
    const reResolved = /\b(resolved|closed the ticket|marking (this )?resolved)\b/i;
    for (const cm of bulkComments) {
      if (openCaseRefs.has((cm._refs as Record<string, string>).ParentId)) {
        expect(reResolved.test(str(cm, "CommentBody"))).toBe(false);
      }
    }
  });

  it("bulk Opportunities carry REAL line items that reconcile to Amount (was 0 OLIs at scale)", () => {
    const oliByOpp = new Map<string, GenericRecord[]>();
    for (const li of dense.records.OpportunityLineItem!.filter(isBulk)) {
      const opp = String((li._refs as Record<string, string>).OpportunityId);
      (oliByOpp.get(opp) ?? oliByOpp.set(opp, []).get(opp)!).push(li);
    }
    expect(oliByOpp.size).toBeGreaterThan(0);
    for (const o of bulkOpps) {
      const lines = oliByOpp.get(o._ref as string) ?? [];
      expect(lines.length).toBeGreaterThanOrEqual(1); // every deal has products now
      const sum = lines.reduce((a, li) => a + (li.UnitPrice as number) * (li.Quantity as number), 0);
      const licenseQty = (lines[0]!.Quantity as number) || 1; // only rounding source: License UnitPrice = round(share/seats)
      expect(Math.abs(sum - (o.Amount as number))).toBeLessThanOrEqual(licenseQty); // Σ ≈ Amount within License-rounding
    }
  });

  it("activity dates are BOUNDED to the deal: no Task/Event dated after its opp's CloseDate", () => {
    for (const t of bulkTasks) {
      const opp = oppById.get(String((t._refs as Record<string, string>).WhatId));
      if (opp) expect(str(t, "ActivityDate") <= str(opp, "CloseDate")).toBe(true);
    }
    for (const e of dense.records.Event!.filter(isBulk)) {
      const opp = oppById.get(String((e._refs as Record<string, string>).WhatId));
      if (opp) expect((e.StartDateTime as string).slice(0, 10) <= str(opp, "CloseDate")).toBe(true);
    }
  });

  it("Account.Type is DERIVED from won-history: no Prospect carries a Closed-Won opp", () => {
    const wonAccts = new Set(bulkOpps.filter((o) => o.StageName === "Closed Won").map((o) => (o._refs as Record<string, string>).AccountId));
    for (const a of dense.records.Account!.filter(isBulk)) {
      if (wonAccts.has(a._ref as string)) expect(String(a.Type).startsWith("Customer")).toBe(true);
    }
  });

  it("Opp.Name is DECOUPLED from won/lost state; Probability/ForecastCategory DERIVE from stage", () => {
    // no name leaks the outcome (the old "— Subscription"=won / "— Evaluation"=lost tell is gone)
    for (const o of bulkOpps) expect(/— (Subscription|Evaluation|Opportunity)$/.test(str(o, "Name"))).toBe(false);
    // the deal-noun vocabulary is SHARED across outcomes (won & lost draw from the same shapes)
    const lastTok = (o: GenericRecord) => str(o, "Name").split(/\s+/).pop()!;
    const wonToks = new Set(bulkOpps.filter((o) => o.StageName === "Closed Won").map(lastTok));
    const lostToks = bulkOpps.filter((o) => o.StageName === "Closed Lost").map(lastTok);
    expect(lostToks.some((t) => wonToks.has(t))).toBe(true); // outcomes are NOT partitioned by name
    // Probability + ForecastCategory are pure functions of StageName
    for (const o of bulkOpps) {
      expect(o.Probability).toBe(PROBABILITY[str(o, "StageName")] ?? 10);
      expect(o.ForecastCategoryName).toBe(FORECASTCATEGORY[str(o, "StageName")] ?? "Pipeline");
    }
  });

  it("BillingState coheres with the city/country (no cross-country state mismatch)", () => {
    const stateByCountry = new Map<string, Set<string>>();
    for (const region of Object.values(GEO_BY_REGION))
      for (const g of region) {
        if (!stateByCountry.has(g.country)) stateByCountry.set(g.country, new Set());
        if (g.state) stateByCountry.get(g.country)!.add(g.state);
      }
    for (const a of dense.records.Account!.filter(isBulk)) {
      const st = a.BillingState as string | undefined;
      if (st !== undefined) expect(stateByCountry.get(a.BillingCountry as string)?.has(st)).toBe(true);
    }
  });

  it("v19 load-safety: every bulk Account carries the ISO country/state CODE + canonical label (picklist-org safe)", () => {
    // The valid (label, code) pairs straight from GEO — what a State/Country-Picklist org will accept.
    const countryCode = new Map<string, string>();
    const stateCode = new Map<string, string>(); // key: `${country}|${state}`
    for (const region of Object.values(GEO_BY_REGION))
      for (const g of region) {
        countryCode.set(g.country, g.countryCode);
        if (g.state) stateCode.set(`${g.country}|${g.state}`, g.stateCode);
      }
    // states only exist where SF has a sub-state picklist — never a bare code like "CA" as the label
    for (const region of Object.values(GEO_BY_REGION))
      for (const g of region)
        if (g.state) expect(g.state.length, `state label "${g.state}" looks like a bare code`).toBeGreaterThan(2);
    for (const a of dense.records.Account!.filter(isBulk)) {
      expect(typeof a.BillingCountryCode).toBe("string"); // the ISO code is always emitted
      expect(a.BillingCountryCode).toBe(countryCode.get(a.BillingCountry as string)); // code↔label consistent
      const st = a.BillingState as string | undefined;
      if (st !== undefined) {
        expect(a.BillingStateCode).toBe(stateCode.get(`${a.BillingCountry}|${st}`)); // state code↔label consistent
      } else {
        expect(a.BillingStateCode).toBeUndefined(); // no half-emitted state (label without code or vice-versa)
      }
    }
  });
});

// v16 mechanical sweep — the residual per-object tells the report-card audit caught. These lock in the
// cross-field coherence fixes (channel agreement, grammar, geo-correct phones, decoupled-but-coherent names).
describe("Phase v16 bulk graph — mechanical realism (channel/grammar/geo/name coherence)", () => {
  const bulkTasks = dense.records.Task!.filter(isBulk);
  const bulkCases = dense.records.Case!.filter(isBulk);
  const bulkComments = dense.records.CaseComment!.filter(isBulk);
  const bulkOpps = dense.records.Opportunity!.filter(isBulk);
  const bulkAccts = dense.records.Account!.filter(isBulk);
  const str = (r: GenericRecord, f: string) => (r[f] as string | undefined) ?? "";

  it("Task subject channel AGREES with the body (no Email subject + spoken/voicemail body, & vice-versa)", () => {
    const SPOKEN = /left a message|no answer|short call|ran late|picked up|voicemail|quick call|good call/i;
    const WRITTEN = /replied|sent and waiting|dropped .* a note|no reply yet|quick email|quick text/i;
    for (const t of bulkTasks) {
      const subj = str(t, "Subject"); const body = str(t, "Description");
      if (/^(Email|Text|LinkedIn):/.test(subj)) expect(SPOKEN.test(body)).toBe(false);
      if (/^(Call|Voicemail):/.test(subj)) expect(WRITTEN.test(body)).toBe(false);
    }
  });

  it("no double-determiner grammar bug ('the the' / 'their the') in Case Description or CaseComment", () => {
    const BUG = /\b(the the|their the|a the|an the)\b/i;
    for (const c of bulkCases) expect(BUG.test(str(c, "Description"))).toBe(false);
    for (const cm of bulkComments) expect(BUG.test(str(cm, "CommentBody"))).toBe(false);
  });

  it("Phone dial code matches the country (no +1 on a Munich/Shanghai account)", () => {
    const dialOf = (country: string) => COUNTRY_DIAL[country]?.code;
    for (const a of bulkAccts) {
      const code = dialOf(str(a, "BillingCountry"));
      if (code) expect(str(a, "Phone").startsWith(code + " ")).toBe(true);
    }
    for (const c of dense.records.Contact!.filter(isBulk)) {
      const code = dialOf(str(c, "MailingCountry"));
      if (code) expect(str(c, "Phone").startsWith(code + " ")).toBe(true);
    }
  });

  it("Opp.Description is combinatorial now (>> the old 12 distinct strings)", () => {
    const distinct = new Set(bulkOpps.map((o) => str(o, "Description"))).size;
    expect(distinct).toBeGreaterThan(50); // was 12 corpus-wide; combinatorial lead×tail×band now
  });

  it("no Event is scheduled on a weekend (Sat/Sun)", () => {
    for (const e of dense.records.Event!.filter(isBulk)) {
      const dow = new Date(e.StartDateTime as string).getUTCDay();
      expect(dow === 0 || dow === 6).toBe(false);
    }
  });

  it("Opp Name motion AGREES with Type (Renewal/Expansion ⟹ Existing Business; Net-New ⟹ New Business)", () => {
    for (const o of bulkOpps) {
      const name = str(o, "Name"); const type = str(o, "Type");
      if (/\b(Renewal|Upsell|Cross-Sell)\b/.test(name)) expect(type).toBe("Existing Business");
      if (/\bNet-New\b/.test(name)) expect(type).toBe("New Business");
    }
  });

  it("no account name carries a mismatched country-bound legal suffix (GmbH/PLC dropped from the pool)", () => {
    for (const a of bulkAccts) expect(/\b(GmbH|PLC)\b/.test(str(a, "Name"))).toBe(false);
    expect(NAME_SPACE).toBe(96 * 60 * 60 * 14); // suffix pool stayed length 14 (no cardinality churn)
  });
});

// v17 demand-gen funnel — the bulk top-of-funnel that was absent at scale (7 Leads / 7 CampaignMembers for
// 100K accounts). These guard the new bulk Lead population (net-new, SF-correct) + the CampaignMember wiring.
describe("Phase v17 bulk graph — demand-gen funnel (Leads + CampaignMembers at scale)", () => {
  const leads = dense.records.Lead!.filter(isBulk);
  const members = dense.records.CampaignMember!.filter(isBulk);
  const campaigns = dense.records.Campaign!;
  const acctNames = new Set(dense.records.Account!.map((a) => a.Name as string));
  const contactRefs = new Set(dense.records.Contact!.map((c) => c._ref as string));
  const leadRefs = new Set(leads.map((l) => l._ref as string));
  const campRefs = new Set(campaigns.map((c) => c._ref as string));
  const LEAD_STATUS = new Set(["Open - Not Contacted", "Working - Contacted", "Closed - Not Converted"]);
  const RATING = new Set(["Hot", "Warm", "Cold"]);
  const CM_STATUS = new Set(["Sent", "Received", "Responded"]);

  it("the shared campaign set is scaled (~30 quarterly + always-on programs, was 5)", () => {
    expect(campaigns.length).toBeGreaterThanOrEqual(24);
  });

  it("emits a real bulk Lead population — net-new prospects, NO account FK (SF-correct), valid picklists", () => {
    expect(leads.length).toBeGreaterThan(50); // 600 accounts × a power-law ≈ hundreds of leads
    for (const l of leads) {
      expect(l._refs).toBeUndefined(); // a Lead has no hard FK → parent_ref stays null (not an account child)
      expect((l as GenericRecord).AccountId).toBeUndefined();
      expect(LEAD_STATUS.has(l.Status as string)).toBe(true);
      expect(RATING.has(l.Rating as string)).toBe(true);
      expect(acctNames.has(l.Company as string)).toBe(false); // net-new company, not one of our accounts
    }
  });

  it("CampaignMembers wire in-corpus Contacts/Leads to a real campaign (account-major locality)", () => {
    expect(members.length).toBeGreaterThan(100);
    for (const m of members) {
      const refs = m._refs as Record<string, string>;
      expect(campRefs.has(String(refs.CampaignId))).toBe(true); // a real (scaffold) campaign
      const who = refs.ContactId ?? refs.LeadId; // links a Contact OR a Lead, never both
      expect(contactRefs.has(String(who)) || leadRefs.has(String(who))).toBe(true); // in-corpus, account-major
      expect(CM_STATUS.has(m.Status as string)).toBe(true);
    }
  });

  it("the funnel is fully deterministic (same seed → byte-identical Leads + CampaignMembers)", () => {
    const again = buildBundle(scope({ volume: 1, population: 600, bulkDensity: 1, seed: "bulk-graph" }), profile(), salescloudPack, ASOF);
    expect(JSON.stringify(again.records.Lead)).toBe(JSON.stringify(dense.records.Lead));
    expect(JSON.stringify(again.records.CampaignMember)).toBe(JSON.stringify(dense.records.CampaignMember));
  });
});

// v22 — bulk coherence: disjoint name pools (no "X X"), one champion per deal, grounded bodies (numbers/dates).
describe("Phase 4E bulk Sales-Cloud graph — v22 realism coherence", () => {
  it("(a) no bulk Account name has a doubled adjacent word (disjoint CATEGORIES/SUFFIXES pools)", () => {
    const names = dense.records.Account!.filter(isBulk).map((a) => String(a.Name));
    expect(names.length).toBeGreaterThan(100);
    const doubled = names.filter((n) => {
      const w = n.split(/\s+/);
      return w.some((tok, idx) => idx > 0 && tok === w[idx - 1]);
    });
    expect(doubled).toEqual([]); // e.g. "Meadowline Partners Partners" must not occur
  });

  it("(b) one buyer per email thread — every inbound message in a thread is from the SAME contact", () => {
    const emails = dense.records.EmailMessage!.filter(isBulk);
    const inboundFromByThread = new Map<string, Set<string>>();
    for (const e of emails) {
      if (e.Incoming !== true) continue; // inbound = from the buyer
      const tid = e.ThreadIdentifier as string;
      (inboundFromByThread.get(tid) ?? inboundFromByThread.set(tid, new Set()).get(tid)!).add(e.FromAddress as string);
    }
    expect(inboundFromByThread.size).toBeGreaterThan(0);
    for (const buyers of inboundFromByThread.values()) expect(buyers.size).toBe(1); // never a different buyer mid-thread
  });

  it("(b) one champion per deal — the modal contact dominates an opp's logged Tasks", () => {
    const byOpp = new Map<string, string[]>(); // oppRef → [WhoId,...]
    for (const t of dense.records.Task!.filter(isBulk)) {
      const refs = t._refs as Record<string, string>;
      if (!refs.WhoId || !refs.WhatId) continue;
      (byOpp.get(refs.WhatId) ?? byOpp.set(refs.WhatId, []).get(refs.WhatId)!).push(refs.WhoId);
    }
    const shares: number[] = [];
    for (const whos of byOpp.values()) {
      if (whos.length < 4) continue; // only opps with enough touches to have a "dominant" contact
      const counts = new Map<string, number>();
      for (const w of whos) counts.set(w, (counts.get(w) ?? 0) + 1);
      shares.push(Math.max(...counts.values()) / whos.length);
    }
    expect(shares.length).toBeGreaterThan(0);
    const avgShare = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(avgShare).toBeGreaterThan(0.5); // a dominant champion, NOT a fresh random contact per touch
  });

  it("(c) every bulk transcript is grounded — carries a $ amount AND a close quarter", () => {
    const vtts = dense.records.ContentVersion!.filter(isBulk).map((cv) => String(cv.VersionData));
    expect(vtts.length).toBeGreaterThan(0);
    for (const vtt of vtts) {
      expect(vtt).toMatch(/\$\d/); // a real dollar figure
      expect(vtt).toMatch(/Q[1-4]\s+FY?\d/); // a close quarter (e.g. "Q2 FY24")
    }
  });

  it("(c) bulk email threads are grounded — most carry a $ amount somewhere in the thread", () => {
    const emails = dense.records.EmailMessage!.filter(isBulk);
    const threads = new Map<string, string[]>();
    for (const e of emails) (threads.get(e.ThreadIdentifier as string) ?? threads.set(e.ThreadIdentifier as string, []).get(e.ThreadIdentifier as string)!).push(String(e.TextBody));
    const grounded = [...threads.values()].filter((bodies) => bodies.some((b) => /\$\d/.test(b)));
    expect(grounded.length / threads.size).toBeGreaterThan(0.8); // the rep's opener always cites the deal's number
  });
});

// v24 — per-account customer sentiment in the standard Account.Rating field.
describe("Phase 4F bulk Sales-Cloud graph — v24 account sentiment (Rating)", () => {
  it("every account carries a valid standard Rating, spanning all three states at scale", () => {
    const accts = dense.records.Account!.filter(isBulk);
    expect(accts.length).toBeGreaterThan(100);
    const ratings = accts.map((a) => String(a.Rating));
    expect(ratings.every((r) => ["Hot", "Warm", "Cold"].includes(r))).toBe(true);
    expect(new Set(ratings).size).toBe(3); // Hot, Warm, and Cold all present in a dense corpus
  });

  it("Rating coheres with won/lost history (a Hot account is never one with only losses)", () => {
    for (const a of dense.records.Account!.filter(isBulk)) {
      const m = (a._meta as { hasWon?: boolean; hasLost?: boolean }) ?? {};
      if (a.Rating === "Hot") expect(m.hasWon === true && m.hasLost !== true).toBe(true);
      if (a.Rating === "Cold") expect(m.hasLost === true && m.hasWon !== true).toBe(true);
    }
  });
});

// v23 — attributed buyer quotes in bulk Task call-notes.
describe("Phase 4E bulk Sales-Cloud graph — v23 attributed quotes", () => {
  const taskDescs = () => dense.records.Task!.filter(isBulk).map((t) => String(t.Description));
  const quoted = (d: string) => /["“][^"”]+["”]/.test(d); // contains a quoted span

  it("a meaningful share of bulk call-notes record a verbatim, attributed buyer quote", () => {
    const descs = taskDescs();
    expect(descs.length).toBeGreaterThan(100);
    const withQuote = descs.filter(quoted);
    expect(withQuote.length).toBeGreaterThan(20); // quotes are present (gated to ~60% of Call-channel tasks)
    // Attribution: a quote-bearing note names the speaker (a capitalized first name precedes the quote).
    expect(withQuote.some((d) => /[A-Z][a-z]+(?: said| was clear|:| —|\bPer )/.test(d))).toBe(true);
  });

  it("a quote NEVER follows a no-contact opener (no 'left a message … and then they said')", () => {
    for (const d of taskDescs().filter(quoted)) {
      expect(/Left a message|No answer|No reply yet/.test(d)).toBe(false);
    }
  });

  it("some quotes are grounded in the deal's real numbers / quarter / product", () => {
    const quotes = taskDescs().filter(quoted);
    expect(quotes.some((d) => /\$\d/.test(d) || /Q[1-4]\s+FY?\d/.test(d))).toBe(true);
  });
});

// v27 — load-correctness fixes surfaced by a live load.
describe("Phase v27 — load-safe emails + state-bound bulk ZIP", () => {
  it("EVERY contact email is ASCII (diacritic-folded) — no INVALID_EMAIL_ADDRESS on load", () => {
    const bad = dense.records.Contact!.map((c) => c.Email as string).filter((e) => e && /[^\x00-\x7F]/.test(e));
    expect(bad).toEqual([]); // e.g. esra.engström@… would fail a live insert; the fold makes it engstrom
  });

  it("bulk BillingPostalCode is STATE-bound for US accounts, and omitted for non-US (no fake US format)", () => {
    for (const a of dense.records.Account!.filter(isBulk)) {
      const zip = a.BillingPostalCode as string | undefined;
      const stateCode = a.BillingStateCode as string | undefined;
      if (a.BillingCountryCode === "US" && stateCode && US_STATE_ZIP3[stateCode]) {
        expect(zip, `${a.Name} US ZIP`).toBeTruthy();
        expect(zip!.slice(0, 3)).toBe(US_STATE_ZIP3[stateCode]); // e.g. TX→750xx, never a cross-state ZIP
      } else if (a.BillingCountryCode !== "US") {
        expect(zip, `${a.Name} non-US must omit the US-format ZIP`).toBeUndefined();
      }
    }
  });
});
