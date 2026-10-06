import { describe, it, expect } from "vitest";
import { CapabilityProfile, ScopeParams, STANDARD_PRICEBOOK_REF } from "@dataseed/core";
import { buildBundle } from "@dataseed/engine";
import { salescloudPack, STAGES, ACCOUNT_INDUSTRIES } from "../src/index.js";
import { PROBABILITY, FORECASTCATEGORY } from "../src/variability.js";

const ASOF = "2026-06-17T00:00:00.000Z";
// The standard Salesforce Account.Industry picklist — the anchor set must map only to these.
const VALID_INDUSTRIES = new Set<string>(ACCOUNT_INDUSTRIES);
const VALID_OCR_ROLES = new Set(["Business User", "Decision Maker", "Economic Buyer", "Evaluator", "Executive Sponsor", "Influencer", "Technical Buyer", "Other"]);

const profile = (over: Record<string, unknown> = {}) => CapabilityProfile.parse({ org: "demo-org", capturedAt: ASOF, ...over });
const scope = (over: Record<string, unknown> = {}) =>
  ScopeParams.parse({ org: "demo-org", pack: "salescloud", volume: 9, scenarioMix: { "at-risk-budget": 34, "healthy-tech": 33, "rfp-gated": 33 }, ...over });

const build = (over = {}) => buildBundle(scope(over), profile(), salescloudPack, ASOF);

describe("salescloud generate — structure", () => {
  it("emits the input cascade with sane per-object counts", () => {
    const b = build();
    const primaryOpps = b.records.Opportunity!.filter((o) => !(o._meta as { prior?: boolean })?.prior);
    const priorOpps = b.records.Opportunity!.filter((o) => (o._meta as { prior?: boolean })?.prior);
    expect(b.records.Account).toHaveLength(9);
    expect(primaryOpps).toHaveLength(9); // one live deal per unit
    expect(priorOpps.length).toBeGreaterThan(0); // healthy-tech arcs carry a prior closed-won (cross-deal history)
    expect(b.records.Contact!.length).toBeGreaterThanOrEqual(9 * 2);
    expect(b.records.EmailMessage!.length).toBeGreaterThanOrEqual(9 * 3);
    // one OCR per contact (on the live deal) + one signer OCR per prior deal
    expect(b.records.OpportunityContactRole!.length).toBe(b.records.Contact!.length + priorOpps.length);
  });

  it("each deal's foreground cast has UNIQUE first AND last names (no two-Elena / two-Reyes roster collision)", () => {
    const b = build();
    const foreground = b.records.Contact!.filter((c) => (c._meta as { persona?: string }).persona); // foreground contacts carry a persona
    const byAccount = new Map<string, Array<{ first: string; last: string }>>();
    for (const c of foreground) {
      const acct = (c._refs as { AccountId: string }).AccountId;
      (byAccount.get(acct) ?? byAccount.set(acct, []).get(acct)!).push({ first: c.FirstName as string, last: c.LastName as string });
    }
    const collisions: string[] = [];
    for (const [acct, cast] of byAccount) {
      if (new Set(cast.map((p) => p.first)).size !== cast.length) collisions.push(`${acct}: dup first name`);
      if (new Set(cast.map((p) => p.last)).size !== cast.length) collisions.push(`${acct}: dup last name`);
    }
    expect(collisions).toEqual([]);
  });

  it("no distinctive first name OR surname recurs ACROSS foreground deals up to the pool size (no Mwangi/Becker at two accounts)", () => {
    // 6 deals × ~3-4 cast each stays under the 16-name pools, so names should be fully distinct across the run.
    const b = build({ volume: 6 });
    const foreground = b.records.Contact!.filter((c) => (c._meta as { persona?: string }).persona);
    const firsts = foreground.map((c) => c.FirstName as string);
    const lasts = foreground.map((c) => c.LastName as string);
    expect(lasts.filter((n, i) => lasts.indexOf(n) !== i)).toEqual([]); // surnames unique across deals (the fatal)
    expect(firsts.filter((n, i) => firsts.indexOf(n) !== i)).toEqual([]); // first names too, within the pool
  });
});

describe("salescloud generate — foreground standard-field saturation (v25)", () => {
  const isPrior = (o: Record<string, unknown>) => (o._meta as { prior?: boolean })?.prior;
  const VALID_TYPE = new Set(["New Business", "Existing Business"]);
  const PERSONA_DEPT = new Set(["Sales", "Finance", "Engineering", "Information Technology", "Operations"]);

  it("every live (non-prior) Opportunity carries deal-coherent standard fields — Probability/Forecast TRACK the stage", () => {
    const b = build();
    const live = b.records.Opportunity!.filter((o) => !isPrior(o));
    expect(live.length).toBeGreaterThan(0);
    for (const o of live) {
      const stage = o.StageName as string;
      expect(VALID_TYPE.has(o.Type as string)).toBe(true);
      expect(o.Probability).toBe(PROBABILITY[stage] ?? 10); // can't lag/lead the stage
      expect(o.ForecastCategoryName).toBe(FORECASTCATEGORY[stage] ?? "Pipeline");
      expect(typeof o.LeadSource).toBe("string");
      expect((o.LeadSource as string).length).toBeGreaterThan(0);
      expect(o.NextStep).toBeTruthy(); // the live deal is open → always a next step
      expect((o.Description as string).length).toBeGreaterThan(0);
    }
  });

  it("the prior win is the net-new LAND (Type 'New Business') and terminal (Closed Won → Probability 100 / Forecast Closed)", () => {
    const b = build();
    const priors = b.records.Opportunity!.filter(isPrior);
    expect(priors.length).toBeGreaterThan(0);
    for (const p of priors) {
      expect(p.StageName).toBe("Closed Won");
      expect(p.Type).toBe("New Business");
      expect(p.Probability).toBe(100);
      expect(p.ForecastCategoryName).toBe("Closed");
    }
  });

  it("an account WITH a prior win frames its live deal as 'Existing Business' (expansion), and is itself a Customer", () => {
    const b = build();
    const priorAccts = new Set(b.records.Opportunity!.filter(isPrior).map((o) => (o._refs as Record<string, string>).AccountId));
    expect(priorAccts.size).toBeGreaterThan(0);
    for (const acctRef of priorAccts) {
      const live = b.records.Opportunity!.find((o) => !isPrior(o) && (o._refs as Record<string, string>).AccountId === acctRef);
      expect(live?.Type).toBe("Existing Business");
      const acct = b.records.Account!.find((a) => a._ref === acctRef);
      expect(acct?.Type).toBe("Customer - Direct"); // synthetic firmographics may override; anchor path sets this
    }
  });

  it("every foreground Contact has a persona-coherent Department + a LeadSource (a CFO sits in Finance)", () => {
    const b = build();
    const foreground = b.records.Contact!.filter((c) => (c._meta as { persona?: string }).persona);
    expect(foreground.length).toBeGreaterThan(0);
    for (const c of foreground) {
      expect(PERSONA_DEPT.has(c.Department as string)).toBe(true);
      expect(typeof c.LeadSource).toBe("string");
    }
    // persona coherence: the CFO (Economic Buyer) is always in Finance; the IT-Security blocker in IT.
    const cfos = foreground.filter((c) => c.Title === "Chief Financial Officer");
    expect(cfos.length).toBeGreaterThan(0);
    for (const c of cfos) expect(c.Department).toBe("Finance");
    for (const c of foreground.filter((c) => c.Title === "Director, IT Security")) expect(c.Department).toBe("Information Technology");
  });

  it("a foreground (anchor) Account carries a coherent Type — Prospect until a prior win makes it a Customer", () => {
    const b = build();
    const foreground = b.records.Account!.filter((a) => (a._meta as { scenario?: string }).scenario);
    expect(foreground.length).toBeGreaterThan(0);
    for (const a of foreground) expect(["Prospect", "Customer - Direct", "Customer - Channel"].includes(a.Type as string)).toBe(true);
  });
});

describe("salescloud generate — no vapor-ware (prose deferred)", () => {
  it("leaves every email body empty and emits one copy request per email", () => {
    const b = build();
    for (const e of b.records.EmailMessage!) {
      expect(e.TextBody).toBe("");
      expect(e.Subject).toBe("");
    }
    const emailReqs = b.copyRequests.filter((c) => c.kind === "email");
    expect(emailReqs).toHaveLength(b.records.EmailMessage!.length);
    expect(emailReqs.every((c) => c.beatIntent.length > 0)).toBe(true);
  });

  it("emits logged-activity Tasks (a 2nd activity stream): deferred Description + one task copy request each", () => {
    const b = build();
    expect(b.records.Task!.length).toBeGreaterThanOrEqual(9); // ≥1 per deal across 9 deals
    for (const t of b.records.Task!) {
      expect(t.Description).toBe(""); // body deferred to the copy layer (no vapor-ware)
      expect(t.Subject).toBe("");
      expect(t.Status).toBe("Completed");
      const refs = t._refs as Record<string, string>;
      expect(refs.WhoId).toBeTruthy(); // attributed Contact
      expect(refs.WhatId).toBeTruthy(); // the deal
    }
    const taskReqs = b.copyRequests.filter((c) => c.kind === "task");
    expect(taskReqs).toHaveLength(b.records.Task!.length);
    expect(taskReqs.every((c) => c.beatIntent.length > 0 && c.threadId)).toBe(true);
  });

  it("seeds activity Tasks as TaskSubtype='Email' with NO call fields (logged-email activity shape)", () => {
    const b = build({ volume: 12 });
    const tasks = b.records.Task!;
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.TaskSubtype).toBe("Email");
      // No call fields — CallType/CallDurationInSeconds would derive TaskSubtype='Call'.
      expect(t.CallType).toBeUndefined();
      expect(t.CallDurationInSeconds).toBeUndefined();
      expect(t.Type).toBeUndefined();
    }
    // Activity-timeline realism lives in the note content (logged call vs meeting), not in restricted fields.
    const taskReqs = b.copyRequests.filter((c) => c.kind === "task");
    expect(taskReqs.some((c) => /Logged call with/.test(c.beatIntent))).toBe(true);
    expect(taskReqs.some((c) => /Logged meeting with/.test(c.beatIntent))).toBe(true);
  });

  it("grounds every copy request in the prospect's real world (kills the interchangeable-company tell)", () => {
    const b = build();
    expect(b.copyRequests.every((c) => (c.facts?.grounding?.does?.length ?? 0) > 0 && (c.facts?.grounding?.painPhrase?.length ?? 0) > 0)).toBe(true);
  });

  it("stamps a per-writer voice card on every email (AE on outbound, the persona on inbound)", () => {
    const b = build();
    expect(b.copyRequests.every((c) => c.voiceCard && c.voiceCard.name === c.speakers[0])).toBe(true);
    expect(b.copyRequests.some((c) => c.voiceCard?.persona === "Account Executive")).toBe(true); // outbound
    expect(b.copyRequests.some((c) => c.voiceCard?.persona && c.voiceCard.persona !== "Account Executive")).toBe(true); // inbound
  });

  it("threads each deal's emails — shared threadId + seedSubject, inReplyTo chains from the opener", () => {
    const b = build();
    const emails = b.copyRequests.filter((c) => c.kind === "email"); // tasks share the threadId but carry no seedSubject/Re: chain
    expect(emails.every((c) => c.threadId && c.seedSubject)).toBe(true);
    // group by thread; the opener (seq 0) has no inReplyTo, later ones point at the prior email
    const byThread = new Map<string, typeof emails>();
    for (const c of emails) (byThread.get(c.threadId!) ?? byThread.set(c.threadId!, []).get(c.threadId!)!).push(c);
    for (const group of byThread.values()) {
      const sorted = [...group].sort((a, z) => a.seq!.index - z.seq!.index);
      expect(sorted[0]!.inReplyTo).toBeUndefined();
      expect(new Set(sorted.map((c) => c.seedSubject)).size).toBe(1); // one subject per thread
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.inReplyTo).toBe(sorted[i - 1]!.id);
    }
  });

  it("emits ONLY standard Sales Cloud objects (no custom __c records)", () => {
    const b = build();
    const custom = Object.keys(b.records).filter((o) => o.endsWith("__c"));
    expect(custom).toEqual([]);
  });
});

describe("salescloud generate — deal economics (product/line-item chain)", () => {
  it("seeds a shared product catalog ONCE (Product2 + a standard-pricebook entry each)", () => {
    const b = build();
    expect(b.records.Product2!.length).toBeGreaterThanOrEqual(6);
    expect(b.records.PricebookEntry!.length).toBe(b.records.Product2!.length); // one PBE per product
    for (const pbe of b.records.PricebookEntry!) {
      const refs = pbe._refs as Record<string, string>;
      expect(refs.Product2Id).toMatch(/^product-/); // in-bundle product
      expect(refs.Pricebook2Id).toBe(STANDARD_PRICEBOOK_REF); // resolved against the org at load time
      expect(typeof pbe.UnitPrice).toBe("number");
    }
  });

  it("every deal's line-item totals reconcile EXACTLY to Opportunity.Amount (so Amount survives the SF recalc)", () => {
    const b = build();
    const olisOf = (oppRef: string) => b.records.OpportunityLineItem!.filter((o) => (o._refs as Record<string, string>).OpportunityId === oppRef);
    for (const opp of b.records.Opportunity!) {
      const olis = olisOf(opp._ref as string);
      expect(olis.length).toBeGreaterThanOrEqual(2);
      const sum = olis.reduce((s, o) => s + (o.Quantity as number) * (o.UnitPrice as number), 0);
      expect(sum).toBe(opp.Amount); // the number a VP checks: do the lines add to the total?
      for (const o of olis) expect((o._refs as Record<string, string>).PricebookEntryId).toMatch(/^pbe-/); // in-bundle PBE
    }
  });

  it("each Opportunity carries the standard pricebook as a SOFT ref (so it loads even without a pricebook)", () => {
    const b = build();
    for (const opp of b.records.Opportunity!) {
      expect((opp._softRefs as Record<string, string>).Pricebook2Id).toBe(STANDARD_PRICEBOOK_REF);
    }
  });

  it("churning accounts carry a PRIOR closed-won deal — backdated, reconciling, same account (cross-deal history)", () => {
    const b = build({ scenarioMix: { "churning-account": 100 }, volume: 4 });
    const prior = b.records.Opportunity!.filter((o) => (o._meta as { prior?: boolean })?.prior);
    expect(prior).toHaveLength(4); // every churning account gets one
    const olisOf = (ref: string) => b.records.OpportunityLineItem!.filter((o) => (o._refs as Record<string, string>).OpportunityId === ref);
    for (const p of prior) {
      expect(p.StageName).toBe("Closed Won");
      expect(new Date(p.CloseDate as string).getTime()).toBeLessThan(new Date(ASOF).getTime()); // historical
      const olis = olisOf(p._ref as string);
      expect(olis.reduce((s, o) => s + (o.Quantity as number) * (o.UnitPrice as number), 0)).toBe(p.Amount); // reconciles
      // the prior deal lives on the SAME account as a live deal for that unit
      const acct = (p._refs as Record<string, string>).AccountId;
      expect(b.records.Opportunity!.some((o) => o !== p && (o._refs as Record<string, string>).AccountId === acct)).toBe(true);
    }
    // and it adds NO copy work — closed history needs no fresh prose
    expect(b.copyRequests.some((c) => c.id.includes("prior"))).toBe(false);
  });
});

describe("salescloud generate — installed base + support history on prior-win accounts", () => {
  const CASE_STATUS = ["New", "Working", "Escalated", "Closed"];
  const CASE_ORIGIN = ["Phone", "Email", "Web"];
  const CASE_PRIORITY = ["High", "Medium", "Low"];

  it("a prior-win account (existing customer) gets ≥1 Asset and ≥1 Case on the foreground account", () => {
    // healthy-tech + churning-account both carry a priorWin (the land); force them so every unit is a customer.
    const b = buildBundle(scope({ scenarioMix: { "healthy-tech": 50, "churning-account": 50 }, volume: 6 }), profile(), salescloudPack, ASOF);
    // foreground account refs (acct-N) carry a scenario in _meta; the prior installed base attaches to them
    const foregroundAccts = new Set(b.records.Account!.filter((a) => (a._meta as { scenario?: string }).scenario).map((a) => a._ref as string));
    expect(foregroundAccts.size).toBe(6);

    const priorAssets = (b.records.Asset ?? []).filter((a) => (a._meta as { prior?: boolean })?.prior);
    const priorCases = (b.records.Case ?? []).filter((c) => (c._meta as { prior?: boolean })?.prior);
    expect(priorAssets.length).toBeGreaterThanOrEqual(6); // ≥1 Asset per customer account
    expect(priorCases.length).toBeGreaterThanOrEqual(6); // ≥1 Case per customer account

    // every prior Asset/Case points at a FOREGROUND account
    for (const a of priorAssets) expect(foregroundAccts.has((a._refs as Record<string, string>).AccountId!)).toBe(true);
    for (const c of priorCases) expect(foregroundAccts.has((c._refs as Record<string, string>).AccountId!)).toBe(true);
  });

  it("the prior Asset uses load-safe standard fields and OMITS the org-configurable Asset.Status", () => {
    const b = buildBundle(scope({ scenarioMix: { "churning-account": 100 }, volume: 4 }), profile(), salescloudPack, ASOF);
    const assets = (b.records.Asset ?? []).filter((a) => (a._meta as { prior?: boolean })?.prior);
    expect(assets).toHaveLength(4);
    for (const a of assets) {
      const refs = a._refs as Record<string, string>;
      expect(refs.AccountId).toMatch(/^acct-/);
      expect(refs.Product2Id).toBe("product-0"); // the land product (Platform License, line 0 of the prior deal)
      expect(refs.ContactId).toMatch(/^contact-/); // the buyer/signer anchors the installed base
      expect(typeof a.Name).toBe("string");
      expect(typeof a.Quantity).toBe("number");
      expect(typeof a.Price).toBe("number");
      expect(typeof a.PurchaseDate).toBe("string");
      expect(typeof a.InstallDate).toBe("string");
      // installed AFTER purchase, both before asOf
      expect(new Date(a.InstallDate as string).getTime()).toBeGreaterThanOrEqual(new Date(a.PurchaseDate as string).getTime());
      expect(new Date(a.PurchaseDate as string).getTime()).toBeLessThan(new Date(ASOF).getTime());
      expect(a.Status).toBeUndefined(); // Asset.Status is org-configurable → OMITTED (load-safe)
    }
  });

  it("prior Cases use only load-safe restricted picklist values (Status / Origin / Priority), no Type/Reason", () => {
    const b = buildBundle(scope({ scenarioMix: { "healthy-tech": 100 }, volume: 5 }), profile(), salescloudPack, ASOF);
    const cases = (b.records.Case ?? []).filter((c) => (c._meta as { prior?: boolean })?.prior);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      expect(CASE_STATUS).toContain(c.Status as string);
      expect(CASE_ORIGIN).toContain(c.Origin as string);
      expect(CASE_PRIORITY).toContain(c.Priority as string);
      expect(typeof c.Subject).toBe("string");
      expect((c.Subject as string).length).toBeGreaterThan(0);
      expect(c.Type).toBeUndefined(); // org-configurable → OMITTED
      expect(c.Reason).toBeUndefined();
      expect((c._refs as Record<string, string>).ContactId).toMatch(/^contact-/);
    }
    // at least one resolved/Closed case (support HISTORY, not just open tickets) + its CaseComment
    expect(cases.some((c) => c.Status === "Closed")).toBe(true);
    const priorComments = (b.records.CaseComment ?? []).filter((cm) => (cm._meta as { prior?: boolean })?.prior);
    expect(priorComments.length).toBeGreaterThan(0);
    for (const cm of priorComments) {
      expect((cm._refs as Record<string, string>).ParentId).toMatch(/^case-/);
      expect(typeof cm.CommentBody).toBe("string");
    }
  });

  it("a NON-prior-win scenario (rfp-gated) seeds NO foreground Assets or Cases (net-new eval, no installed base)", () => {
    const b = buildBundle(scope({ scenarioMix: { "rfp-gated": 100 }, volume: 5 }), profile(), salescloudPack, ASOF);
    expect((b.records.Asset ?? []).filter((a) => (a._meta as { prior?: boolean })?.prior)).toHaveLength(0);
    expect((b.records.Case ?? []).filter((c) => (c._meta as { prior?: boolean })?.prior)).toHaveLength(0);
  });
});

describe("salescloud generate — call-recording transcripts (no vapor-ware)", () => {
  it("emits ContentVersion transcript files with deferred VersionData + one 'transcript' copy request each", () => {
    const b = build();
    const rows = b.records.ContentVersion ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(b.records.Account!.length); // ≥1 recorded conversation per deal
    for (const row of rows) {
      expect(row.VersionData).toBe(""); // transcript text deferred to the copy layer (no vapor-ware)
      expect(typeof row.Title).toBe("string"); // the CI source label is woven into the title (ECI / Gong / …)
      expect(row.PathOnClient as string).toMatch(/\.vtt$/); // a VTT call recording
      const refs = row._refs as Record<string, string>;
      expect(refs.FirstPublishLocationId).toMatch(/^opp-/); // publishes the file against the deal Opp
    }
    const reqs = b.copyRequests.filter((c) => c.kind === "transcript");
    expect(reqs).toHaveLength(rows.length); // one copy request per transcript file
    expect(reqs.every((c) => c.beatIntent.length > 0 && c.threadId)).toBe(true);
  });

  it("stamps the speaker's voice card on every transcript copy request", () => {
    const b = build();
    const reqs = b.copyRequests.filter((c) => c.kind === "transcript");
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((c) => c.voiceCard && c.voiceCard.name)).toBe(true);
  });
});

describe("salescloud generate — funnel (Phase C)", () => {
  const LEAD_STATUS = ["Open - Not Contacted", "Working - Contacted", "Closed - Converted", "Closed - Not Converted"];
  const LEAD_SOURCE = ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"];
  const CAMPAIGN_STATUS = ["Planned", "In Progress", "Completed", "Aborted"];
  const CM_STATUS = ["Planned", "Received", "Responded", "Sent"];

  it("emits campaigns + leads + members with valid restricted picklists", () => {
    const b = build();
    expect(b.records.Campaign!.length).toBeGreaterThanOrEqual(24); // v17: scaled to ~30 quarterly + always-on programs (was 5)
    for (const c of b.records.Campaign!) expect(CAMPAIGN_STATUS).toContain(c.Status as string);
    expect(b.records.Lead!.length).toBeGreaterThan(0);
    for (const l of b.records.Lead!) {
      expect(LEAD_STATUS).toContain(l.Status as string);
      expect(LEAD_SOURCE).toContain(l.LeadSource as string);
      expect(typeof l.Company).toBe("string");
    }
    expect(b.records.CampaignMember!.length).toBe(b.records.Lead!.length); // one response per lead
    for (const m of b.records.CampaignMember!) expect(CM_STATUS).toContain(m.Status as string);
  });

  it("flags ~a quarter of leads for load-time conversion, referencing in-bundle leads", () => {
    const b = build();
    const conv = b.directives?.convertLeads ?? [];
    expect(conv.length).toBeGreaterThan(0);
    expect(conv.length).toBeLessThan(b.records.Lead!.length); // only some convert
    const leadRefs = new Set(b.records.Lead!.map((l) => l._ref));
    for (const d of conv) {
      expect(leadRefs.has(d.leadRef)).toBe(true);
      expect(d.opportunityName).toMatch(/New Business/);
    }
  });

  it("draws lead companies from anchors NOT used as accounts (no collision with seeded accounts)", () => {
    const b = build();
    const accountNames = new Set(b.records.Account!.map((a) => a.Name as string));
    for (const l of b.records.Lead!) expect(accountNames.has(l.Company as string)).toBe(false);
  });
});

describe("salescloud generate — load correctness (restricted picklists / references)", () => {
  it("uses only valid Account.Industry, Opportunity.StageName, OCR.Role values", () => {
    const b = build();
    for (const a of b.records.Account!) expect(VALID_INDUSTRIES.has(a.Industry as string)).toBe(true);
    for (const o of b.records.Opportunity!) expect(STAGES).toContain(o.StageName as string);
    for (const ocr of b.records.OpportunityContactRole!) expect(VALID_OCR_ROLES.has(ocr.Role as string)).toBe(true);
  });

  it("every _refs lookup points at a record that exists in the bundle", () => {
    const b = build();
    const refs = new Set<string>();
    for (const recs of Object.values(b.records)) for (const r of recs) if (r._ref) refs.add(r._ref as string);
    for (const recs of Object.values(b.records)) {
      for (const r of recs) {
        const links = (r._refs ?? {}) as Record<string, string>;
        for (const [field, target] of Object.entries(links)) {
          // @existing: refs resolve to a PRE-EXISTING org record by natural key at load time (catalog /
          // user-pool lookups) — not an in-bundle _ref.
          if (target.startsWith("@existing:")) {
            expect(target).toMatch(/^@existing:[^:]+:[^:]+:.+$/);
          } else if (field === "Pricebook2Id") {
            // Resolves to a PRE-EXISTING org record (standard pricebook) at load time, not an in-bundle _ref.
            expect(target).toBe(STANDARD_PRICEBOOK_REF);
          } else {
            expect(refs.has(target), `dangling ${field} → ${target}`).toBe(true);
          }
        }
      }
    }
  });

  it("OCR Role agrees with the buying committee: Decision Maker = the Economic Buyer (or Champion), NEVER the Skeptic/Blocker", () => {
    // The cast for at-risk-budget is [Economic Buyer, Skeptic, Blocker] and for rfp-gated includes a Skeptic —
    // exactly the casts the cross-object audit flagged (procurement Skeptic / IT-Security Blocker tagged
    // "Decision Maker" while the CFO who holds sign-off was not). Force those scenarios so we hit them densely.
    const b = build({ scenarioMix: { "at-risk-budget": 50, "rfp-gated": 50 }, volume: 12 });
    // persona by contact _ref (foreground contacts carry one in _meta)
    const personaOf = new Map<string, string>();
    for (const c of b.records.Contact!) {
      const persona = (c._meta as { persona?: string }).persona;
      if (persona) personaOf.set(c._ref as string, persona);
    }
    // group OCRs (only foreground — those whose contact carries a persona) by Opportunity
    const byOpp = new Map<string, Array<{ persona: string; role: string; primary: boolean }>>();
    for (const ocr of b.records.OpportunityContactRole!) {
      const contactRef = (ocr._refs as Record<string, string>).ContactId!;
      const persona = personaOf.get(contactRef);
      if (!persona) continue; // bulk OCR — no persona
      const opp = (ocr._refs as Record<string, string>).OpportunityId!;
      (byOpp.get(opp) ?? byOpp.set(opp, []).get(opp)!).push({ persona, role: ocr.Role as string, primary: ocr.IsPrimary === true });
    }
    expect(byOpp.size).toBeGreaterThan(0);
    let sawEbWithSkepticOrBlocker = false;
    for (const cast of byOpp.values()) {
      // INVARIANT 1: a Skeptic or Blocker is NEVER the Decision Maker.
      for (const m of cast) if (m.persona === "Skeptic" || m.persona === "Blocker") expect(m.role).not.toBe("Decision Maker");
      // INVARIANT 2: if the cast has an Economic Buyer, IT (not the Skeptic/Blocker) holds the decision role.
      const eb = cast.find((m) => m.persona === "Economic Buyer");
      const hasSkepticOrBlocker = cast.some((m) => m.persona === "Skeptic" || m.persona === "Blocker");
      if (eb && hasSkepticOrBlocker) {
        sawEbWithSkepticOrBlocker = true;
        expect(eb.role).toBe("Decision Maker");
        expect(eb.primary).toBe(true); // the deal advocate/sign-off is primary, not the blocker
      }
      // INVARIANT 3: exactly one primary, and the primary is the EB (or, lacking one, the Champion).
      const primaries = cast.filter((m) => m.primary);
      expect(primaries).toHaveLength(1);
      const expectedPrimaryPersona = cast.some((m) => m.persona === "Economic Buyer") ? "Economic Buyer"
        : cast.some((m) => m.persona === "Champion") ? "Champion" : primaries[0]!.persona;
      expect(primaries[0]!.persona).toBe(expectedPrimaryPersona);
    }
    expect(sawEbWithSkepticOrBlocker).toBe(true); // the audit's exact at-risk-budget cast WAS exercised
  });

  it("backdates email timestamps before asOf (velocity), exactly one primary contact role per deal", () => {
    const b = build();
    for (const e of b.records.EmailMessage!) {
      expect(new Date(e.MessageDate as string).getTime()).toBeLessThanOrEqual(new Date(ASOF).getTime());
    }
    const primariesPerOpp = new Map<string, number>();
    for (const ocr of b.records.OpportunityContactRole!) {
      const opp = (ocr._refs as Record<string, string>).OpportunityId!;
      if (ocr.IsPrimary) primariesPerOpp.set(opp, (primariesPerOpp.get(opp) ?? 0) + 1);
    }
    expect([...primariesPerOpp.values()].every((n) => n === 1)).toBe(true);
  });
});

describe("salescloud generate — determinism + budget", () => {
  it("same seed → byte-identical bundle; different seed → different", () => {
    expect(build()).toEqual(build());
    const a = buildBundle(scope({ seed: 1 }), profile(), salescloudPack, ASOF);
    const b = buildBundle(scope({ seed: 2 }), profile(), salescloudPack, ASOF);
    expect(a.records.Account!.map((x) => x.Name)).not.toEqual(b.records.Account!.map((x) => x.Name));
  });

  it("respects a clamped record budget (fewer Accounts, flagged)", () => {
    // budget 50 / 25 per unit = 2 units
    const b = buildBundle(scope({ volume: 20 }), profile({ recordBudget: 50 }), salescloudPack, ASOF);
    expect(b.plan.budgetCapped).toBe(true);
    expect(b.records.Account).toHaveLength(2);
  });

  it("assigns distinct anchor companies until the pool is exhausted", () => {
    const b = buildBundle(scope({ volume: 8 }), profile(), salescloudPack, ASOF);
    const names = b.records.Account!.map((a) => a.Name as string);
    expect(new Set(names).size).toBe(names.length); // 8 < 16 anchors → all distinct
  });
});
