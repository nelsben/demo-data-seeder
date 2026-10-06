# Salesforce sales-cycle object audit

> Standard-object catalogue ranked by importance FOR THIS SEEDER: does it make the demo **VP-real**, does it **drive a narrative beat**, does it widen the **AI-testing substrate** — weighed against seeding cost. The seeder produces **only standard Sales Cloud objects** (no `__c`); see the repo-root `CLAUDE.md` §4 for the canonical kept-object set and insert order. ✅ seeded today · 🟡 partial · ⬜ not seeded.

## Standard-field saturation grid (R1)

> The goal of R1: for an individual account, walk its related-object graph and populate every *meaningful* **standard** field with data **coherent to that account's narrative**. Field inventories below are the **createable standard fields** from a live `describe` against an authed org (run 2026-06-25; `custom`/`calculated`/`autoNumber`/system fields excluded). The seeder runs **two tiers**: **bulk** (population — already saturates ~20 fields/object since v15–v23) and **foreground** (the hero deals a VP opens). R1 closes the inversion where the *hero* records were the thinnest. **Set only load-safe fields** — org-configurable picklists (Task/Event subtype beyond the standard set, Case Type/Reason, Asset Status) stay omitted (see `picklists.ts`).

**Foreground saturation status (v25 = the first R1 slice — the deal record + the org chart):**

| Object | Createable std fields | Foreground sets today | v25 added | v26 (wave 2) added | Still deferred |
|---|---|---|---|---|---|
| **Account** | 48 | Name, Industry, Website, Rating | **Type** (anchor: Prospect→Customer once it has a prior win) | **BillingStreet/City/PostalCode + v19 dual State/Country codes** (curated real anchor HQ / synthetic authored HQ), **Phone, AccountSource**; **Ownership** (synthetic only) | **NumberOfEmployees/AnnualRevenue intentionally unset for real anchors** — deriving size from the deal band would contradict a known public company (synthetic identities carry full firmographics) |
| **Contact** | 45 | FirstName, LastName, Title, Email | **Department** (persona-coherent), **LeadSource** | **Phone/MobilePhone** (acct dial code), **MailingCity/State/Country (+codes)** = acct HQ, **ReportsToId** org chart (`_softRef`; in corpus/warehouse/MCP — in-org landing deferred) | Birthdate, AssistantName (low value) |
| **Opportunity** | 17 | Name, Amount, StageName, CloseDate | **Type, LeadSource, Probability, ForecastCategoryName, NextStep, Description** (live + the prior win) | — (already saturated) | TotalOpportunityQuantity, IsPrivate |
| **OpportunityContactRole** | 4 | Role, IsPrimary (+ refs) | — (already complete) | — | — |
| **EmailMessage** | 30 | RelatedToId, MessageDate, Incoming, Status, From*, ToAddress, Subject, TextBody | — | — | CcAddress, HasAttachment |
| **ContentVersion** | 21 | Title, PathOnClient, VersionData, Description, FirstPublishLocationId | — | — | ContentModifiedDate, TagCsv |
| **Task** | 26 | Subject, Description, WhatId, WhoId, ActivityDate, Status, Priority, TaskSubtype | — | — | Call* fields (foreground Tasks are `TaskSubtype='Email'`; bulk already emits logged-Call telephony) |
| **Case** | ~12 | (prior-win only) Subject, Status, Origin, Priority, Description | — | — (churn→Escalated **deferred** — golden mix has no `churning-account`; see open-questions/2026-06-25-wave2-deferrals.md) | Escalated-near-renewal churn signal |

**v26 wave-2 realism call (the headline):** real anchors are famous public companies, so a region-random billing
city ("Coinbase in Chicago") is a louder tell than a blank. Anchors get their **curated real HQ** (`anchor-hq.ts`,
all 54 verified against public record — Snowflake→Menlo Park and Teladoc→NYC were *relocated* and caught), a public
non-financial fact (no size fabrication). One `hqGeo` per unit fans out to Account billing **and** every Contact's
mailing/phone, so an account and its people never disagree. ReportsToId/churn-Case/area-code deferrals: see
[open-questions/2026-06-25-wave2-deferrals.md](open-questions/2026-06-25-wave2-deferrals.md).

**Do-not-touch (load-bearing) fields — changing these breaks a load or a narrative invariant:**
- **Task `TaskSubtype='Email'`** on foreground — models EAC-synced email activity with **no** Call* fields; flipping it to `'Call'` would require the telephony field set and changes the activity shape the demo asserts.
- **Opportunity `StageName`** is **derived from deal maturity** (EB engaged? budget contested?) — never set it independently; Probability/ForecastCategoryName must keep tracking it (v25 does).
- **`*StateCode`/`*CountryCode`** must be emitted **alongside** the canonical label (v19) — a State/Country-Picklist org rejects plain-text Billing/Mailing values; wave-2 geo work must follow that dual-emit pattern.
- **ContentVersion `VersionData`** is base64 on a Salesforce sink (plain text on the file sink) — the copy layer owns it.

**Coherence rules already enforced (v25):** Probability/ForecastCategoryName ← StageName; Opportunity.Type = Existing iff the account has a prior win (else New); the prior win is the net-new **land** (`New Business`, terminal Probability 100/Closed); Account.Type = Customer iff prior win; Contact.Department ← persona (CFO→Finance, IT-Security→IT, RevOps→Sales). **Next wave** adds: size-band→employees/revenue *for synthetic accounts only*, geo→Billing/Phone, churn→escalated Case near renewal.

## CRITICAL (7)

### 🟡 Account `Account` — standard, seed:trivial
- **Role:** The company being sold to — the top of the entire B2B people-graph. Every Contact and Opportunity hangs off it. Industry/size/revenue establish the firmographic context that makes a deal plausible (HIPAA pain for Healthcare, SOC2 for FinServ).
- **Why this tier:** Anchors the whole demo: a skeptical VP sees company names, industries, and sizes first. Already seeded, but firmographic depth (employees/revenue) is missing and those fields feed believable white-space/expansion narratives and benchmark cohorting.
- **Realism notes:** `Account.Industry` drives plausible pain and competitor selection in generated copy. Firmographics (`NumberOfEmployees`/`AnnualRevenue`) ground white-space/expansion narratives and benchmark plausibility — they are plain CRM field values, not yet seeded.
- **Relationships:** Root object — no required parent. Self-referential `ParentId` lookup enables hierarchy. Children: Contact (`AccountId`), Opportunity (`AccountId`), Asset (`AccountId`), Case (`AccountId`).
- **Key fields:** Name (required), Industry (variability-matrix spine; must be valid standard picklist value), NumberOfEmployees (firmographic depth — NOT seeded today), AnnualRevenue (firmographic depth — NOT seeded today), Website, ParentId (self-lookup for hierarchy — NOT seeded today)
- **Gotchas:** Industry is a standard restricted picklist — the anchor mapping already resolves to valid values (Technology, Finance, Healthcare, etc.); do not invent values like 'SaaS' or 'Fintech'. AnnualRevenue is Currency, NumberOfEmployees is Integer — both currently absent. The seeder's `cycle>0` division naming (`Name (Div 2)`) makes look-alike accounts but does NOT set ParentId, so they are not a real hierarchy. Person Account toggle (if ever enabled org-wide) changes Account behavior and is irreversible — keep this org Business-Account only.

### ✅ Contact `Contact` — standard, seed:trivial
- **Role:** A real person at the account — the stakeholders the deal is won or lost through (champion, economic buyer, blocker, technical evaluator). The unit of stakeholder realism. Title and persona define their role in the buying committee.
- **Why this tier:** The pivot of stakeholder realism. `Contact.Email` is reused verbatim as `EmailMessage.FromAddress` so a deal's email thread is attributable to a named person, and the 7-persona buying-committee mix lives here. Without correctly-emailed, role-titled Contacts the whole stakeholder half of the demo goes flat. Already seeded correctly today.
- **Realism notes:** Contact name + role drive transcript speaker matching (the speaker label in a ContentVersion VTT should be a real Contact who is an OCR on the Opp). Persona mix is what makes the committee read as varied rather than all-Champion.
- **Relationships:** Lookup → Account (`AccountId`). Referenced by OpportunityContactRole (`ContactId`), Task (`WhoId`), Case (`ContactId`), Asset (`ContactId`), and EmailMessage attribution (via Email reuse, not a hard FK).
- **Key fields:** FirstName/LastName (LastName required), Title (drives persona inference + the voice register of generated copy), Email (reused as EmailMessage.FromAddress — keep the two consistent), AccountId (lookup to parent Account)
- **Gotchas:** Keep `Email` consistent with the email thread's `FromAddress` — the generator builds email as `first.last@domain` lowercased and reuses it as `FromAddress`; preserve that invariant so a thread reads as a coherent person. Transcript speaker matching needs the Contact name to appear in transcript speaker labels AND the Contact to be an OCR on the Opp. Don't fabricate stakeholder names in evidence that don't exist as Contacts (no-vapor-ware: evidence attribution must point at a real Contact).

### ✅ EmailMessage `EmailMessage` — standard, seed:moderate
- **Role:** The native record of a sent/received sales email on a deal. In a real cycle it is the bread-and-butter touch: pricing back-and-forth, scheduling, the champion's tone shifting, the 'no-reply' silence. It is the single richest narrative surface in the cluster.
- **Why this tier:** THE seeded narrative input today and the load-bearing one. The email thread (4–8 per foreground deal) is where the hero beats — the champion-silence at-risk arc, the pricing back-and-forth — actually live. Works against any org, no feature gate. Without it there is no copy-bearing demo.
- **Realism notes:** Bodies are filled by the copy layer (provider chain anthropic → claude-code → static), gated for voice and judged by an LLM-as-VP. The seeder emits structure-only EmailMessages with empty `Subject`/`TextBody` and defers the prose to the copy layer via a `CopyRequest` — the no-vapor-ware seam.
- **Relationships:** `RelatedToId` → Opportunity (wires the email to the deal). `FromAddress` is the same string as a Contact's `Email` so the thread is attributable to a named person. No `ParentId` thread aggregation — one EmailMessage = one touch.
- **Key fields:** RelatedToId (the Opportunity Id — wires the email to the deal), TextBody (the prose the copy layer fills; HtmlBody is the fallback), Subject, FromAddress + FromName (FromAddress = a Contact's Email so the touch reads as that person), ToAddress, MessageDate (backdate this to manufacture velocity), Status ('0'=New inbound / '3'=Sent outbound), Incoming
- **Gotchas:** `RelatedToId` MUST be the Opp Id (not Account). Status `'0'` (New) for inbound, `'3'` (Sent) for outbound. Keep `FromAddress` equal to the Contact's `Email` (lowercased) so the thread is coherently attributed. Many Salesforce email UIs strip a signature block at the first `--`/`Best regards,`/`Thanks,`/`Sent from my` line — keep substance ABOVE any signature. `TextBody` is a Long Text Area → NOT SOQL-filterable. Backdate `MessageDate` or every deal's timeline reads flat.

### 🟡 Opportunity `Opportunity` — standard, seed:moderate
- **Role:** The deal record itself — the spine of the entire sales motion. Stage, Amount, CloseDate, and the per-account Deal Dossier all hang off the Opportunity; every other narrative record (email, task, transcript, line item) points back at it.
- **Why this tier:** THE record everything derives from; without varied, coherent, backdated Opportunities there is no demo and no AI-testing substrate. A skeptical VP scans the pipeline list first.
- **Realism notes:** Amounts are band-sampled (6 size bands), stages span the 10 standard values, and CloseDates spread over ~3 years to manufacture velocity. Some accounts carry a PRIOR closed-won Opp for cross-deal history (the churning/expansion archetype).
- **Relationships:** Lookup → Account (`AccountId`, required). Lookup → User (`OwnerId`, defaults to running user). Parent of OpportunityContactRole, OpportunityLineItem, OpportunityHistory, and EmailMessage (via `RelatedToId`); `WhatId` target of Task and Event; `FirstPublishLocationId` target of ContentVersion transcripts.
- **Key fields:** Name, AccountId (required), StageName (required, restricted picklist), CloseDate (required), Amount (band-sampled; rolls up from line items when they exist), OwnerId, Pricebook2Id (MUST be set before inserting line items), CreatedDate (benchmark cycle-time = CreatedDate→CloseDate; only settable via Apex Test.setCreatedDate or the audit-field perm), IsClosed/IsWon/ForecastCategoryName/Probability/ExpectedRevenue (all SYSTEM-DERIVED from StageName via OpportunityStage metadata — do NOT and largely cannot set directly), NextStep
- **Gotchas:** `StageName` is a restricted picklist — only the 10 standard stages load (Prospecting…Closed Won/Closed Lost); a custom stage value silently reds the row. `IsWon`/`IsClosed`/`ForecastCategoryName`/`Probability` are NOT writable — SF infers them from `StageName` via OpportunityStage metadata, so to make a 'Closed Won' deal you set `StageName='Closed Won'` and SF derives the rest. To seed a Closed-Won cohort (for benchmark/velocity realism): set `StageName`, a PAST `CloseDate` within 365 days, an `Amount` in a target band, ≥5 per band. `CreatedDate` isn't controllable via REST (needs `Test.setCreatedDate` in Apex, or the 'Set Audit Fields upon Record Creation' org perm + `CreatedDate` in the payload), so REST-loaded cycle-time is 'now.' `ExpectedRevenue = Amount × Probability` is auto-computed.

### ✅ OpportunityContactRole `OpportunityContactRole` — standard, seed:trivial
- **Role:** Maps which Contacts play which role on a specific Opportunity (Economic Buyer, Decision Maker, Technical Buyer, Influencer, Business User) and which is primary. The buying-committee membership for one deal.
- **Why this tier:** Gives the deal a believable multi-threaded committee a VP expects, and it is the prerequisite for transcript speaker→Contact matching (a ContentVersion VTT only resolves a speaker against Contacts that are OCRs on the Opp). Already seeded. Critical-adjacent: the email thread attributes via the Contact's email directly, so OCRs are strictly required only for the transcript path — but they are cheap and already present.
- **Realism notes:** Role values surface when the deal's committee is reasoned about ('who holds authority'). The 7 personas map down to the 5 standard OCR Role values.
- **Relationships:** Junction: lookup → Opportunity (`OpportunityId`) and lookup → Contact (`ContactId`). Loads AFTER both Opportunity and Contact exist.
- **Key fields:** OpportunityId (required), ContactId (required), Role (standard picklist), IsPrimary (one per Opp)
- **Gotchas:** `Role` is a standard picklist — the generator maps personas to valid values (Economic Buyer, Decision Maker, Technical Buyer, Influencer, Business User); 'Champion'/'Skeptic'/'Blocker' are persona labels, NOT OCR Role values, so they are mapped to picklist-valid roles. Cannot create two primary OCRs on one Opp. `ContactId` and `OpportunityId` must both already exist (loader resolves via `_refs`). There is no enforced FK between a Contact's Account and the Opportunity's Account — keep them consistent so the committee belongs to the right logo.

### ✅ ContentVersion (call-recording transcripts) `ContentVersion` — standard, seed:moderate
- **Role:** The file-store record for a meeting/call transcript (the WebVTT export a tool like Gong/Zoom/Einstein Conversation Insights produces) attached to the deal — and, more generally, any deal attachment. Transcripts are the highest-signal-density source in a real cycle: a 45-minute call surfaces budget numbers, named blockers, commitments and refusals in one record.
- **Why this tier:** Highest value-per-record for realism AND a distinct beat (the transcript-sourced risk quote in a battle card). To a skeptical VP, an org with REAL-looking call transcripts — not just emails — reads as a true multi-channel system. Works against any org (native CRM path), no feature gate. This is the **kept transcript surface** — call transcripts are ContentVersion VTT files, NOT a custom interaction object.
- **Realism notes:** The VTT body is novel-LLM copy (its own `CopyRequest` kind), per-deal, not a template — the realism bar requires real transcripts. `Title` becomes the file label (e.g. 'Gong Call — Acme Discovery 2026-06-03.vtt'), not a person's name.
- **Relationships:** `FirstPublishLocationId` → Opportunity (publishes the file to the deal AND is the key for matching transcript speaker labels to the Opp's OCR Contacts). On insert `FirstPublishLocationId` publishes it; alternatively insert ContentVersion then a ContentDocumentLink with `LinkedEntityId` = the Opp Id.
- **Key fields:** VersionData (the WebVTT blob — the transcript text; base64-encoded for a Salesforce-sink load), Title (the file title — becomes the displayed file name, NOT a person), FirstPublishLocationId (the Opportunity Id — links the file to the deal and keys speaker matching), CreatedDate (backdate for velocity), PathOnClient (required — the filename incl. `.vtt` extension)
- **Gotchas:** Keep the VTT well-formed: `WEBVTT` header + numeric cue ids + `HH:MM:SS.mmm --> HH:MM:SS.mmm` timing lines + `Speaker Name: utterance` lines (no `<v ...>` voice tags). A transcript speaker resolves to a Contact only if the speaker label contains that Contact's name AND the Contact is an OCR on the Opp. For a **Salesforce-sink** load, `VersionData` must be base64-encoded and `PathOnClient` is required; the **file sink** stores the transcript as plain text. Backdate `CreatedDate` for velocity.

### ⬜ OpportunityLineItem `OpportunityLineItem` — standard, seed:moderate
- **Role:** A product on the Opportunity — the line items that itemize WHAT is being bought (qty × price). When line items exist, the Opportunity Amount rolls up from them (`TotalPrice` sum) instead of being a hand-typed number, which is how real pipelines look.
- **Why this tier:** Highest-value, moderate-cost item in this cluster. It gives every deal a real, itemized Amount — the single biggest 'this is a real CRM, not a toy' tell for a VP/CEO skimming the pipeline. Shipped as the cluster's first add (Phase A).
- **Realism notes:** A per-product line mix makes the Amount's provenance real (the figure echoed in emails matches the CRM) and grounds an expansion/white-space narrative.
- **Relationships:** Master-Detail → Opportunity (`OpportunityId`), Lookup → PricebookEntry. Requires the parent Opportunity to have `Pricebook2Id` set to the SAME pricebook as the entry. Seed AFTER Opportunity + PricebookEntry.
- **Key fields:** OpportunityId (required), PricebookEntryId (required), Quantity (required), UnitPrice or TotalPrice (one required), Description
- **Gotchas:** Hard prerequisite: `Opportunity.Pricebook2Id` MUST be set (to the pricebook the PricebookEntry belongs to) BEFORE inserting the line — else `FIELD_INTEGRITY_EXCEPTION` ('pricebook entry is in a different pricebook'). Provide `Quantity` AND (`UnitPrice` OR `TotalPrice`) — supplying both `UnitPrice` and `TotalPrice` conflicts. Setting line items overrides any manually-entered `Opportunity.Amount` (Amount becomes the rollup) — beware if other seed code asserts a specific Amount. Master-detail to Opp means deleting the Opp cascades the lines (good for teardown).

### ⬜ Task (logged activity / EAC-synced email / logged call) `Task` — standard, seed:trivial
- **Role:** The catch-all activity record: logged calls, the AE's telegraphic post-meeting notes, and Einstein-Activity-Capture-synced emails (`TaskSubtype='Email'`). In a real org the Activity timeline is where a rep's rushed shorthand ('needs SOC2 before expand, authority up to $120k') lives — a different, more candid register than a formal email.
- **Why this tier:** Cheapest high-value source to add: no file blob, no VTT grammar, no special picklist — just Subject + Description + WhoId + ActivityDate. It adds the 'rushed-AE note' voice register (telegraphic fragments) that emails can't, widening source-type texture so the velocity timeline shows email→call→note cadence instead of email-only. The variability matrix explicitly calls for multi-touch timelines weaving Task alongside email. Shipped (Phase A) as a second copy-bearing stream.
- **Realism notes:** The note body is filled by the copy layer; the rep's terse account is a distinct voice register from the formal email thread. `TaskSubtype='Email'` models EAC-synced email activity.
- **Relationships:** `WhatId` → Opportunity (the deal), `WhoId` → Contact (the person). Loads after the Opp and Contact exist.
- **Key fields:** Subject (e.g. 'Email: Re: contract redline' or 'Logged: called Sarah re budget'), Description (the note body — filled by the copy layer), WhatId (the Opportunity Id), WhoId (a Contact Id), ActivityDate (backdate for velocity), TaskSubtype ('Email' for EAC-synced; otherwise default), Status / Priority (restricted picklists — see below)
- **Gotchas:** `Task.Status` is a restricted picklist: `Not Started | In Progress | Completed | Waiting on someone else | Deferred` (NOT 'Open'). `Task.Priority`: `High | Normal | Low` (Task uses 'Normal', not 'Medium'). `WhoId` is polymorphic (Contact|Lead) — point it at a Contact, not a Lead, for a clean person attribution. `ActivityDate` is a Date (→ midnight DateTime); backdate it for velocity. The org-configurable `TaskSubtype` value set is left at defaults — `'Email'` is safe.


## HIGH (4)

### ⬜ Event (calendar meetings / scheduled activities) `Event` — standard, seed:trivial
- **Role:** The calendar half of standard Salesforce Activities — scheduled and past meetings (discovery call, demo, QBR) with start/end times and invitees. In a real org the Activity timeline interleaves Events (meetings) with Tasks (calls/emails); an org with zero Events looks half-populated to anyone who opens a deal's Activity panel.
- **Why this tier:** Visual completeness of the Activity timeline for a VP who clicks into a deal — Events give the deal a meeting cadence (discovery → demo → QBR) that a Tasks-only timeline lacks. Cheap to seed. The meeting NARRATIVE that carries copy should live in a ContentVersion VTT transcript (the actual call) or a logged Task; the Event is the calendar marker, not a copy surface.
- **Realism notes:** Don't spend novel-LLM copy budget on Event bodies — a templated subject + short description is enough; the meeting's substance belongs in the transcript.
- **Relationships:** `WhoId` → Contact, `WhatId` → Opportunity (direct, unlike Task). Loads after the Opp and Contact exist.
- **Key fields:** Subject (e.g. 'Discovery call — Acme'), WhoId (Contact), WhatId (the Opportunity), StartDateTime / EndDateTime (or ActivityDate + IsAllDayEvent), Description
- **Gotchas:** Requires `StartDateTime` + `EndDateTime` (or `IsAllDayEvent` + `ActivityDate`) — a half-specified Event fails validation. `Event.Priority`: `High | Normal | Low`; `Event.ShowAs`: `Busy | OutOfOffice | Free` (restricted). Easy to over-invest in — keep it minimal set-dressing.

### ⬜ Case `Case` — standard, seed:trivial
- **Role:** A post-sale support/service ticket — the surface where customer dissatisfaction, escalations, and product problems live. In a renewal/churn narrative, open/escalated Cases are the clearest leading indicator of churn risk ('three Sev-1s open, sentiment declining'). The most narratively-load-bearing object in this cluster.
- **Why this tier:** Case volume/severity is the textbook churn-risk evidence — a populated set of escalated Cases makes a churning-account demo viscerally believable to a VP, and it widens the AI-testing substrate (a service-health signal a workflow can reason over). Cheap to insert. High demo-realism payoff for the churn/expansion archetypes.
- **Realism notes:** `IsEscalated` + a backdated `CreatedDate`/`ClosedDate` is what sells a churn trajectory — escalations clustering as sentiment declines.
- **Relationships:** Lookup → Account (`AccountId`), Contact (`ContactId`), Asset (`AssetId`), and parent Case (`ParentId`). None strictly required to insert (Subject/Description optional too), so a bare Case is trivial. CaseComment relates to it (CaseComment.ParentId = the Case).
- **Key fields:** Subject, Description, Status (restricted: New | Working | Escalated | Closed), Priority (restricted: High | Medium | Low — Case uses 'Medium'), Origin (restricted: Phone | Email | Web), AccountId, ContactId, AssetId, IsEscalated, CaseNumber (auto-number)
- **Gotchas:** Almost nothing required to insert (Subject optional), so trivial mechanically. `Status` (New|Working|Escalated|Closed), `Priority` (High|Medium|Low — note Case uses 'Medium' where Task uses 'Normal'), and `Origin` (Phone|Email|Web) are restricted. Org-configurable Case Type/Reason are omitted to stay load-safe on an untouched org. `IsEscalated` + a backdated `CreatedDate`/`ClosedDate` is what sells a churn trajectory. Assignment rules + Case triggers can fire on insert — seed with the assignment-rule header disabled for deterministic ownership. `CaseNumber` is auto-number.

### ⬜ Product2 `Product2` — standard, seed:trivial
- **Role:** The catalog of sellable SKUs/services a rep puts on a deal (e.g. 'Platform — Growth', 'Onboarding', 'Premier Support'). It is the noun every line item references; without it a deal has only a single rolled-up Amount, no itemization.
- **Why this tier:** Cheap to seed and the foundation that unlocks line-item Amounts and the per-product expansion/white-space narrative a skeptical VP looks for. A demo reads as 'real CRM' once line items exist; the catalog itself is invisible on the deal page, so it is enabling infrastructure rather than a direct narrative driver. Seed FIRST in the economics chain.
- **Realism notes:** Keep `Family` values aligned to a small curated set so the product-mix story is coherent across deals.
- **Relationships:** No parent. Referenced by PricebookEntry (`Product2Id`) and Asset (`Product2Id`). Independent insert — seed FIRST in this cluster.
- **Key fields:** Name (required), ProductCode, Description, Family (picklist — drives the product-mix story), IsActive (must be true to add to a pricebook)
- **Gotchas:** Standard object, always present (no license gate for the object itself). Must set `IsActive=true` or it can't be priced/added. A Product2 with no PricebookEntry is unsellable — you cannot add it to an Opportunity line. `ProductCode` is handy as a dedup/idempotency key (catalog objects upsert by natural key).

### ⬜ PricebookEntry / Pricebook2 `PricebookEntry` — standard, seed:moderate
- **Role:** `PricebookEntry` is the junction that says 'this Product sells for this UnitPrice in this Pricebook' — what makes a product addable to an Opp line. `Pricebook2` is the price list itself; every org has exactly one system Standard Pricebook (`IsStandard=true`).
- **Why this tier:** Mandatory bridge — a line item with no `PricebookEntryId` is impossible, and its `UnitPrice` is the source of the believable per-line and rolled-up Amount a VP scrutinizes. The cluster's cost is concentrated here in the standard-pricebook ordering trap; get it wrong and the entire line-item layer silently fails to load.
- **Realism notes:** The real `UnitPrice` makes `OpportunityLineItem.TotalPrice` (and the rolled-up `Opportunity.Amount`) coherent with figures quoted in emails.
- **Relationships:** `PricebookEntry`: Lookup → Product2, Lookup → Pricebook2; master of OpportunityLineItem (via `PricebookEntryId`). Seed AFTER Product2 + after resolving the standard Pricebook2 Id. `Opportunity.Pricebook2Id` points at the book.
- **Key fields:** Product2Id (required), Pricebook2Id (required), UnitPrice (required), IsActive (must be true), CurrencyIsoCode (multi-currency orgs only)
- **Gotchas:** THE BIG ONE: you cannot insert the Standard Pricebook row in a scratch/dev org via the API — it already exists; query it (`SELECT Id FROM Pricebook2 WHERE IsStandard=true`) and activate it (`IsActive=true`, some orgs ship it inactive). Insert the STANDARD-pricebook entry for each product BEFORE any custom-book entry, or you get 'no standard price' (`FIELD_INTEGRITY_EXCEPTION`). One entry per (product, pricebook, currency); duplicates throw. No upsert external-id by default — for idempotency dedup on `Product2Id`+`Pricebook2Id` via query, not blind insert. Simplest path for a seeder: use the standard pricebook only; skip custom books unless region-pricing is a demo beat.


## MEDIUM (8)

### ⬜ Asset `Asset` — standard, seed:trivial
- **Role:** An instance of a product a customer owns/uses after purchase — the installed-base record. Drives renewal, upsell/cross-sell (white-space), and entitlement/support scope. The post-sale 'what they have' that a renewal or expansion play is built on.
- **Why this tier:** The most narratively-relevant of this cluster for a CHURN/EXPANSION story (white-space = 'what they own vs what they could own'), and cheap-ish to seed (Name + AccountId is enough; Product2Id optional) — the best value/cost ratio if you want post-sale furniture on Customer accounts. It is set-dressing for a human viewer, not a copy surface.
- **Realism notes:** An installed base under a Closed-Won account makes the post-sale relationship visible and grounds a believable expansion narrative.
- **Relationships:** Lookup to Account (`AccountId`) and/or Contact (`ContactId`) — at least one. Lookup to Product2 (`Product2Id`). Optional self-lookup (`ParentId`) for asset hierarchies. Can be referenced by Case (`Case.AssetId`).
- **Key fields:** Name (required), AccountId or ContactId (one required — the owner), Product2Id (optional but expected), Status (org-configurable picklist — omitted to stay load-safe), SerialNumber, InstallDate, PurchaseDate, Price, Quantity
- **Gotchas:** Requires at least one of `AccountId`/`ContactId`. `Status` is a restricted, org-configurable picklist — left unset to stay load-safe on an untouched org (verify via describe before pinning a value). `Product2Id` is optional but if set the product must exist. No pricebook needed (unlike OrderItem). Cheapest cluster member: Name + AccountId inserts cleanly.

### ⬜ Account hierarchy (ParentId self-lookup) `Account.ParentId` — standard, seed:trivial
- **Role:** Models parent/subsidiary/division structure (a global parent with regional or business-unit children). Lets a single logo carry multiple Opportunities across divisions — the shape behind 'this account is churning across deals' and enterprise land-and-expand stories.
- **Why this tier:** Would earn the churning-account archetype (multiple Opps per Account + Closed-Lost + declining sentiment), and a skeptical enterprise buyer expects parent-subsidiary structure. But the cross-deal churn archetype is already delivered via **multi-Opp-per-Account** (a prior closed-won deal), which doesn't require a real hierarchy — so ParentId is optional polish, not on the critical path. See the Phase-B DROP note below: at realistic anchor volumes the only grounded hierarchy (divisions of the same anchor) never fires.
- **Relationships:** Self-referential lookup on Account. Must reference an already-inserted Account Id, so parents load before children.
- **Key fields:** ParentId (self-lookup to another Account)
- **Gotchas:** Salesforce blocks circular `ParentId` references at insert. Parent must exist first — emit parents in an earlier batch and reference by `_ref`. Re-running the seeder must not orphan children if a parent dedup changes — resolve by name/query per the idempotency rule, never hardcode parent Ids.

### ⬜ OpportunityHistory `OpportunityHistory` — standard, seed:hard
- **Role:** Stage-and-amount snapshot history — one row per stage/amount/probability/closedate change. The literal record of how a deal PROGRESSED through stages over time (the 'stage velocity' / time-in-stage story).
- **Why this tier:** Stage-progression history is exactly the 'deal slipped Q2→Q3, stuck in Negotiation 6 weeks' texture that makes a pipeline read real to a human eye — BUT it is NOT directly seedable (system-maintained, stamped at update-time), so the cost is prohibitive for the realism payoff. SKIP per Phase B.
- **Relationships:** Child of Opportunity (read-only related list). System-maintained.
- **Key fields:** OpportunityId, StageName, Amount, Probability, CloseDate, ExpectedRevenue, CreatedDate (the moment the deal entered that stage)
- **Gotchas:** READ-ONLY and SYSTEM-GENERATED — you cannot insert OpportunityHistory rows directly. The only way to produce history is to UPDATE the Opportunity through successive `StageName` values over time (each update writes a history row), and rows are stamped 'now' (no API backdating). Faking 'deal aged in Negotiation' needs multiple sequential DML updates — expensive at scale and still stamped 'now.' Treat as optional human-realism polish only.

### ⬜ OpportunityStage `OpportunityStage` — standard, seed:moderate
- **Role:** The METADATA table defining the picklist of valid stages and, per stage, its default Probability, ForecastCategory mapping, IsWon/IsClosed flags, and active status. It is the lookup that DERIVES `Opportunity.Probability`/`ForecastCategoryName`/`IsWon`/`IsClosed`.
- **Why this tier:** The source of truth for what `StageName` values are LEGAL to seed and what `Probability`/`ForecastCategory` each implies — you must read it (per target org) to seed coherent, load-correct Opportunities, but you rarely modify it. The `profile-org` op introspects this.
- **Relationships:** Not a child of Opportunity — it is the configuration that `Opportunity.StageName` references. One row per stage value.
- **Key fields:** MasterLabel (the stage name), DefaultProbability, ForecastCategoryName, IsWon, IsClosed, IsActive, SortOrder
- **Gotchas:** It is METADATA, not data — introspect it, don't seed it. The standard 10 stages exist by default but a customer org may have CUSTOMIZED stages (renamed/removed/added) — the seeder MUST introspect the target org's active `OpportunityStage` values (via `profile-org`) before generating, or hardcoded stage strings red the load. The `IsWon`/`IsClosed`/`Probability` mapping is read here to know which stages produce Closed-Won (for benchmark cohorts) vs open.

### ⬜ Quote `Quote` — standard, seed:moderate
- **Role:** The formal priced proposal/artifact sent to the buyer in late stages (Proposal/Price Quote, Negotiation). Its Status ('Draft' → 'Presented' → 'Approved'/'Accepted') is a real process/timeline milestone. A deal that reached negotiation but has zero quotes looks incomplete to a sales leader.
- **Why this tier:** Genuinely valuable for late-stage realism (a Negotiation/Review deal with an Approved quote tells a coherent story), but it is feature-gated (Quotes must be enabled) and only the late-stage archetypes really benefit. Medium: high realism payoff for the few late-stage deals, real cost to enable + wire.
- **Relationships:** Lookup → Opportunity (`OpportunityId`, required), Lookup → Pricebook2. Parent of QuoteLineItem. Seed AFTER Opportunity (and after Pricebook2 if syncing lines).
- **Key fields:** Name (required), OpportunityId (required), Status (restricted picklist), Pricebook2Id, ExpirationDate, GrandTotal/TotalPrice (rollup, read-only)
- **Gotchas:** Quotes feature must be ENABLED (Setup → Quotes Settings) — in a fresh scratch org it is often off; if off, inserts fail. `Status` is restricted and org-configurable (Draft|Needs Review|In Review|Approved|Rejected|Presented|Accepted|Denied) — verify against the target org. `GrandTotal`/`TotalPrice`/`Subtotal` are read-only rollups from QuoteLineItems — populate by seeding QLIs, never by setting the total. Syncing a quote back to the Opp (`IsSyncing`) overwrites Opp line items — avoid unless intended.

### ⬜ QuoteLineItem `QuoteLineItem` — standard, seed:moderate
- **Role:** The priced lines on a Quote — same itemization as OpportunityLineItem but on the proposal artifact. Drives the Quote's Subtotal/GrandTotal.
- **Why this tier:** Only matters if you seed Quotes AND want the quote totals/discount story to be real (GrandTotal is a rollup from these). For most demo beats the OpportunityLineItem already tells the line-item story; QLI is incremental polish on the few quoted deals. Medium unless a discount/pricing-pressure beat is explicitly in scope.
- **Relationships:** Master-Detail → Quote (`QuoteId`), Lookup → PricebookEntry. Requires the parent Quote's `Pricebook2Id` to match the entry's pricebook. Seed AFTER Quote + PricebookEntry.
- **Key fields:** QuoteId (required), PricebookEntryId (required), Quantity (required), UnitPrice (required), Discount
- **Gotchas:** Inherits Quote's feature gate (Quotes must be enabled). Parent Quote's `Pricebook2Id` must match the PricebookEntry's pricebook (same standard-pricebook prerequisite chain as OLI). `UnitPrice` + `Quantity` required; `Discount` is a percent or amount depending on config. Quote totals are read-only rollups — populate by seeding QLIs. Master-detail to Quote means teardown cascades from the Quote.

### ⬜ Contract `Contract` — standard, seed:moderate
- **Role:** The legal agreement a Closed-Won opportunity converts into — the signed MSA/order form with a term (StartDate + ContractTerm) that governs the customer relationship and is the anchor for renewals. The bridge between 'we won the deal' and 'we have a paying customer with a clock running toward renewal.'
- **Why this tier:** Adds modest demo-completeness realism (a VP scanning a Closed-Won account sees a real signed contract), but every hero beat lights up without it, and the `Status='Activated'` lifecycle makes it more than trivial to seed. Low-medium: nice furniture, real lifecycle cost.
- **Relationships:** Lookup to Account (`AccountId`, required). Optional lookup to Pricebook2. Parent to Order (`Order.ContractId`). A Closed-Won Opportunity is NOT auto-linked — there is no standard `Opportunity.ContractId`.
- **Key fields:** AccountId (required lookup), Status (restricted: Draft | Activated — Draft is the default and the only un-activatable inserts cleanly), StartDate, ContractTerm (months), ContractNumber (auto-number, read-only), Pricebook2Id (optional)
- **Gotchas:** `Status` is restricted and lifecycle-gated: inserting with `Status='Activated'` fails unless required activation fields are set — seed as 'Draft' to insert cleanly, then optionally update to 'Activated' in a second DML (activation fires contract triggers/approval). `ContractNumber` is auto-number (don't set it). `ContractTerm` is whole months. Backdate `StartDate` for a believable renewal-soon narrative.

### ⬜ OpportunityTeamMember `OpportunityTeamMember` — standard, seed:moderate
- **Role:** The selling-side team on a deal (AE, SE, SDR, manager) with a TeamMemberRole — distinct from OCR which is the buying side. Powers split credit and team-based reporting.
- **Why this tier:** Adds a believable selling team to a deal, but it is feature-gated (Team Selling must be enabled) and needs real, license-consuming User records — high setup cost for a view few demos open. Medium-low: skip unless a specific demo beat needs visible selling teams.
- **Relationships:** Lookup → Opportunity (`OpportunityId`) + Lookup → User (`UserId`). Both required.
- **Key fields:** OpportunityId (required), UserId (required), TeamMemberRole (picklist: Sales Rep, Sales Manager, Account Manager, Lead Qualifier, Sales Engineer, Channel Manager — configurable), OpportunityAccessLevel
- **Gotchas:** Requires 'Team Selling' ENABLED (Setup → Opportunity Team Settings) — the object is not insertable otherwise. Needs real, license-consuming User records (each `UserId` an active user with an Opportunity license) — provisioning believable multi-user teams in a scratch org is a separate, non-trivial cost. Skip unless visible selling teams are a beat.


## LOW (8)

### ⬜ Campaign `Campaign` — standard, seed:trivial
- **Role:** A marketing/demand-gen initiative (webinar, trade show, email blast, paid program) that sources Leads and influences Opportunities. The container that answers 'which program drove this pipeline' — the marketing-attribution layer above the funnel.
- **Why this tier:** Campaigns add believable demand-gen texture (a VP sees 'Q2 Webinar Series drove 14 leads') and wire to `Opportunity.CampaignId` for a sourcing story. No hero beat depends on it — it is top-of-funnel realism + AI-testing substrate, the cheapest TOF object to seed. Shipped (Phase C, upsert by Name).
- **Relationships:** Self-lookup `ParentId` for hierarchies. Parent of CampaignMember. Relates to Opportunity via `Opportunity.CampaignId`. No master-detail.
- **Key fields:** Name (required), Type (picklist: Email, Webinar, Trade Show, Advertisement, Conference, etc.), Status (picklist: Planned | In Progress | Completed | Aborted), StartDate / EndDate, IsActive, ParentId (self-lookup for hierarchies)
- **Gotchas:** Cheap and safe: only `Name` is strictly required; Type/Status are standard picklists. The real cost is the **Marketing User** permission — creating Campaigns requires `UserPermissionsMarketingUser` (or Create on Campaign) on the running user, or inserts fail with `INSUFFICIENT_ACCESS`. Wiring `Opportunity.CampaignId` requires the Opp and Campaign to coexist. `ActualCost`/`NumberOfLeads` are best left unset (rolled up). Catalog object — upsert by Name for idempotency.

### ⬜ CampaignMember `CampaignMember` — standard, seed:moderate
- **Role:** The junction that puts a specific Lead or Contact INTO a Campaign with a response status ('Sent', 'Responded'). This is what makes a campaign feel populated — the member list and response rate a marketer reads.
- **Why this tier:** Meaningful only if Campaign AND (Lead or Contact) are already seeded; it serves top-of-funnel realism + AI-testing substrate, not a hero beat. Shipped (Phase C) as part of the funnel. The Status picklist is defined per-Campaign (CampaignMemberStatus child records), so non-default statuses mean seeding those config rows first.
- **Relationships:** Lookup to Campaign (required). References EITHER a Lead (`LeadId`) OR a Contact (`ContactId`), never both. After a Lead converts, its CampaignMembers re-point to the resulting Contact.
- **Key fields:** CampaignId (required), exactly ONE of LeadId or ContactId (required — mutually exclusive), Status (per-Campaign CampaignMemberStatus values; default 'Sent' | 'Responded'), HasResponded (derived from Status)
- **Gotchas:** Set exactly one of `LeadId`/`ContactId` — both or neither errors. Status values are NOT global: each Campaign owns a CampaignMemberStatus set; richer statuses require seeding those rows first. Inherits the Marketing User permission requirement. **Not idempotent on re-load** — a re-run logs a benign 'already a campaign member' (the canonical reset is teardown→load). Insert order: Campaign → (Lead/Contact) → CampaignMember.

### ⬜ Lead `Lead` — standard, seed:trivial
- **Role:** An unqualified prospect (person + company) captured before they are worked into pipeline. Sits ABOVE the Account/Contact/Opportunity world; a worked Lead is later converted into an Account+Contact+Opportunity triad.
- **Why this tier:** A populated Leads list makes a demo org look like a real funnel to a skeptical VP (the 'where does pipeline come from' question) and widens the AI-testing substrate, but no hero beat lands on a Lead (the beats are Opportunity-level). Shipped (Phase C, drawn from anchors NOT used as accounts so still real-company-grounded; upsert by Email). Low value for the hero demo, real value for raw-org realism + job-#2 substrate.
- **Relationships:** No master-detail parent. Standalone until conversion. CampaignMember can link a Lead to a Campaign (`CampaignMember.LeadId`). On conversion it spawns Account+Contact+Opportunity and back-fills the Converted* lookups.
- **Key fields:** LastName (required), Company (required — the un-normalized firmographic stand-in for an Account), Status (restricted, org-configurable — default 'Open - Not Contacted | Working - Contacted | Closed - Converted | Closed - Not Converted'; introspect before hardcoding), LeadSource (picklist: Web, Phone Inquiry, Partner Referral, Purchased List, Other), Title, Email, Industry, Rating (Hot/Warm/Cold), IsConverted / ConvertedAccountId / ConvertedContactId / ConvertedOpportunityId (system, set only by the convert API), OwnerId
- **Gotchas:** `Status` is a RESTRICTED, commonly-customized picklist — query the org's valid values (via `profile-org`) before seeding or inserts red with `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`. `Company` + `LastName` are required. Do NOT set `IsConverted`/`Converted*` directly (read-only; set only by `convertLead`). A Lead is NOT a Contact (uses `Company` not `AccountId`) — it can't be an OpportunityContactRole. Assignment/duplicate rules may fire on insert.

### ⬜ Lead Conversion (convertLead) `LeadConvert / SOAP convertLead()` — standard, seed:hard
- **Role:** The funnel hinge: turns a qualified Lead into an Account + Contact + (optionally) Opportunity, marking `Status='Closed - Converted'`. This is HOW top-of-funnel becomes pipeline — the narrative bridge a VP expects between Leads and Opps.
- **Why this tier:** Conceptually nice for 'show the full funnel arc,' and shipped (Phase C) as a load-time SOAP step (`bundle.directives.convertLeads`, run by the loader after inserts) so ~25% of leads convert with real `ConvertedOpportunityId` lineage. It is a procedural API call, not a bulk insert — hence seed:hard. The incremental demo payoff is the Lead→Opp provenance breadcrumb; chosen for the raw-org realism + AI-testing substrate (job #2).
- **Relationships:** Produces Account←Contact←Opportunity in one call and stamps `ConvertedAccountId`/`ConvertedContactId`/`ConvertedOpportunityId` back on the Lead. Re-parents CampaignMembers from Lead to the new Contact and creates an OpportunityContactRole linking the converted Contact to the new Opp.
- **Key fields:** leadId (the Lead to convert), convertedStatus (must be a LeadStatus with `IsConverted=true` — query it), accountId/contactId (optional: convert INTO an existing Account/Contact to avoid dupes), doNotCreateOpportunity (boolean), opportunityName
- **Gotchas:** Cannot be done via the composite/sobjects insert path — needs the dedicated convert resource (`POST /services/data/vXX/sobjects/Lead/convert`, v60+) or Apex `Database.convertLead`. `convertedStatus` MUST reference a `LeadStatus` row with `IsConverted=true` (org-specific; query it). Converting an **already-converted** reused lead fails soft on re-load (canonical reset is teardown→load). To avoid fragmenting anchor Accounts, convert INTO the existing seeded Account/Contact rather than letting it create new ones.

### ⬜ CaseComment `CaseComment` — standard, seed:trivial
- **Role:** A note/update thread on a Case — the back-and-forth (agent reply, internal note) that fleshes out a support ticket beyond its initial Subject/Description. Makes an escalated Case read as a real, worked ticket rather than a one-line stub.
- **Why this tier:** Pure incremental realism on top of Case — only worth seeding once Cases exist, and only to make the churn-evidence Cases look genuinely worked. No hero beat opens a CaseComment thread. Cheap, but third-order.
- **Relationships:** Lookup → Case (`ParentId`, required). Loads AFTER the parent Case exists.
- **Key fields:** ParentId (the Case Id, required), CommentBody (the note text), IsPublished (visible in the customer portal)
- **Gotchas:** `ParentId` must be an existing Case Id. `CommentBody` is the text; keep it terse and in the agent/internal-note register. Backdate via `CreatedDate` only if audit-field writes are enabled (REST stamps 'now' otherwise). Don't over-invest copy budget — a short worked-ticket note is enough.

### ⬜ User / UserRole `User` — standard, seed:moderate
- **Role:** The selling-side people — the reps who own deals and the role hierarchy (`UserRole`) that rolls credit up to managers. `Opportunity.OwnerId` points here; a manager rollup needs a `UserRole` tree.
- **Why this tier:** A multi-owner pipeline (deals spread across reps under a manager) reads more real than a single-owner org and enables team/territory AI-testing scenarios, but Users are license-consuming and provisioning is non-trivial — so it is a catalog-style pool seeded by natural key, not a hero surface. Medium-low: useful substrate, real provisioning cost.
- **Relationships:** `User.UserRoleId` → UserRole (the hierarchy). Referenced by `Opportunity.OwnerId`, `OpportunityTeamMember.UserId`. `UserRole` is self-referential (`ParentRoleId`) for the manager tree.
- **Key fields:** Username (globally unique, email-format), LastName, Email, Alias, ProfileId, UserRoleId, IsActive; UserRole: Name, ParentRoleId
- **Gotchas:** `Username` must be globally unique across ALL Salesforce orgs (use an org-specific suffix). Users consume licenses — a scratch org has a small cap. The User pool is a catalog object — upsert by a natural key (Username), never by literal Id. `UserRole` must exist before a User can reference it; load the role tree parent-first.

### ⬜ ActivityHistory / OpenActivity (unified activity views) `ActivityHistory` — standard, seed:trivial
- **Role:** The read-only, system-maintained rollup views Salesforce exposes on a parent record's related lists (past activities = ActivityHistory, future = OpenActivity). They aggregate Tasks and Events; a rep reads them to see 'everything that's happened on this account'.
- **Why this tier:** Not a seedable object — read-only, system-generated views over Task and Event. You seed the underlying Task/Event and these populate automatically. Listed only to close the cluster: the correct action is to seed Task (and optionally Event), never to target ActivityHistory directly.
- **Relationships:** Virtual aggregation over Task + Event keyed to the parent (Account/Opportunity/Contact). Cannot be inserted or referenced as a real object.
- **Key fields:** (read-only) ActivityType, Subject, ActivityDate, WhoId, WhatId — all derived from the underlying Task/Event
- **Gotchas:** Not insertable via any API (DML on ActivityHistory/OpenActivity errors). Do not add it to a load order. The only lever is seeding Task/Event, which back-populate these views for free.

### ⬜ AccountContactRelation `AccountContactRelation` — standard, seed:moderate
- **Role:** Represents a Contact's relationship to accounts OTHER than its primary `AccountId` — the 'contacts-to-multiple-accounts' (ACR) model: a consultant or board member who influences several accounts, or a buyer who moved companies.
- **Why this tier:** Adds realism only for the niche multi-account-influencer story, which no current beat depends on, and it is feature-gated (Contacts to Multiple Accounts must be enabled). High setup cost for near-zero payoff. Skip for V0; revisit only if a future beat needs a cross-account influencer.
- **Relationships:** Junction between Contact and Account. Direct relations (`IsDirect=true`) are auto-created from `Contact.AccountId`; only INDIRECT relations are manually inserted.
- **Key fields:** ContactId (required), AccountId (required), Roles (multi-select picklist: Business User, Decision Maker, Economic Buyer, Evaluator, Executive Sponsor, Influencer), IsActive, IsDirect (auto-managed for the primary relation)
- **Gotchas:** Requires the 'Contacts to Multiple Accounts' feature enabled — verify via `profile-org` before seeding or inserts fail. The direct relation (`IsDirect=true`) is auto-created and cannot be inserted manually; only insert indirect relations. `Roles` is a multi-select picklist (semicolon-delimited).


## SKIP (8)

### ⬜ OpportunityFieldHistory `OpportunityFieldHistory` — standard, seed:hard
- **Role:** Field-level audit trail (old value → new value, who, when) for tracked Opportunity fields beyond stage — e.g. Amount cuts, CloseDate slips, Owner changes. The 'what changed and when' forensic layer.
- **Why this tier:** Pure forensic audit data with negligible demo or AI-testing value relative to cost; it only exists if field history tracking is enabled per-field, and it isn't insertable. The 'budget cut 30%' narrative lands via copy in the email/task/transcript, not via the field-history object.
- **Relationships:** Child of Opportunity (read-only). System-maintained; only populated for fields with History Tracking enabled.
- **Key fields:** OpportunityId, Field, OldValue, NewValue, CreatedDate, CreatedById
- **Gotchas:** Read-only/system-generated like OpportunityHistory — not insertable. Requires per-field History Tracking enabled, captures only changes made AFTER tracking is on, stamped at change-time (no backdating). Skip.

### ⬜ OpportunitySplit `OpportunitySplit` — standard, seed:hard
- **Role:** Allocates revenue/overlay credit for an Opportunity across multiple team members (e.g. 70% AE / 30% overlay SE). Drives split-based forecasting and comp.
- **Why this tier:** Adds setup cost for zero pipeline-narrative or AI-testing benefit; it is downstream of Team Selling (itself low value here) and hard-gated.
- **Relationships:** Lookup → Opportunity + → User (`SplitOwnerId`) + → OpportunitySplitType. Depends on OpportunityTeamMember existing first.
- **Key fields:** OpportunityId (required), SplitOwnerId (required — must be an OpportunityTeamMember), SplitTypeId (required), SplitAmount/SplitPercentage
- **Gotchas:** Hard-gated: requires Team Selling AND 'Opportunity Splits' enabled (an irreversible-ish org-wide enablement). Requires OpportunityTeamMember rows first, plus a configured OpportunitySplitType. Multi-step dependency chain for no narrative payoff — skip.

### ⬜ ForecastingItem `ForecastingItem` — standard, seed:hard
- **Role:** The aggregated, rolled-up forecast amount per (forecast category × period × user/role) shown in Collaborative Forecasts — the manager's 'what will we close this quarter' number, summed from underlying Opportunities.
- **Why this tier:** Fully system-generated and feature-gated; there is zero seedable surface. The right lever is to seed coherent Opportunity Amounts + Stages + CloseDates and let forecasting roll up if a forecast demo is ever needed.
- **Relationships:** Aggregate over Opportunities (by Owner/Role hierarchy + ForecastCategory + period). No direct insert relationship.
- **Key fields:** (read-only rollup) ForecastCategoryName, PeriodId, OwnerId, AmountWithoutAdjustments / ForecastAmount, ForecastingTypeId
- **Gotchas:** Completely READ-ONLY and auto-derived — cannot be inserted; it materializes only when Collaborative Forecasts is enabled and recalculates from the underlying Opportunities. Not a seed target — skip.

### ⬜ Order / OrderItem `Order` — standard, seed:hard
- **Role:** The booking/fulfillment record created after a deal closes — what the customer actually ordered, with effective dates and a status moving Draft → Activated. `OrderItem` rows are the line items (the post-sale analog of OpportunityLineItem).
- **Why this tier:** Order's only payoff is demo furniture (making a Closed-Won account look 'booked'), but a pipeline/deal demo is off-screen for order management, and the cost is real (the full pricebook + standard-PricebookEntry + OrderItem chain plus the activation lifecycle). Skip unless a specific order-management demo is requested.
- **Relationships:** Order: Lookup to Account (required), optional Contract (`ContractId`), parent to OrderItem. OrderItem: master-detail to Order, required lookup to PricebookEntry. Order's `Pricebook2Id` must match the OrderItems' pricebook.
- **Key fields:** Order: AccountId (required), EffectiveDate (required), Status (restricted: Draft | Activated), Pricebook2Id (required if it has OrderItems), OrderNumber (auto-number). OrderItem: OrderId (required), PricebookEntryId (required), Quantity (required), UnitPrice (required)
- **Gotchas:** Inherits the full standard-pricebook prerequisite chain (Product2 → standard PricebookEntry → custom PricebookEntry, all active) and the `Pricebook2Id`-must-match rule. `Status` is Draft-default; activating an Order triggers order-activation logic and may auto-create Assets. Multi-record-deep prerequisite for zero pipeline value — skip unless order-management is the demo.

### ⬜ Entitlement `Entitlement` — standard, seed:hard
- **Role:** The support-level contract term that defines what service a customer is entitled to (SLA, support hours, # of cases) — the formal 'they bought Premium Support until X' record that governs Case handling and Milestones. A deep Service Cloud construct.
- **Why this tier:** Lowest value/highest friction in this cluster — a Service Cloud / Entitlement-Management feature that must be ENABLED in org setup, and its SLA-milestone value is orthogonal to a deal/pipeline demo. No beat, license/feature-gated. Skip.
- **Relationships:** Lookup to Account (required). Optional lookups to Asset, Contract, SlaProcess. Referenced by `Case.EntitlementId`.
- **Key fields:** Name (required), AccountId (required), StartDate, EndDate, Type, SlaProcessId, AssetId, ContractId
- **Gotchas:** Entitlement Management must be enabled in org setup or the feature is inert. `SlaProcessId` requires a pre-built Entitlement Process (Milestones), which is metadata, not data — heavy. Not worth it for this seeder.

### ⬜ Person Account `Account (RecordType IsPersonAccount=true)` — standard, seed:hard
- **Role:** A B2C construct that fuses an Account and a Contact into one record (an individual consumer as the buyer). Used in retail banking, insurance, wealth — not B2B enterprise sales.
- **Why this tier:** This seeder produces a B2B enterprise-sales graph: Account (company) → distinct Contacts (committee) → OpportunityContactRole. Person Accounts collapse that committee into one person, breaking the multi-stakeholder graph and transcript speaker matching. Enabling them is an ORG-WIDE, IRREVERSIBLE toggle. Zero beats call for it. Hard skip.
- **Relationships:** Merges Account + Contact into one row; the Contact half is a synthetic PersonContact. Opportunities relate to the person-account directly.
- **Key fields:** LastName/FirstName (person fields), PersonContactId (auto), RecordTypeId (a person-account record type), PersonEmail
- **Gotchas:** Enabling Person Accounts is PERMANENT and org-wide — once on it cannot be disabled, and it alters Account/Contact behavior for all records. Do NOT enable on any demo/scratch org intended for the standard B2B motion — this is a real fence (irreversible).

### ⬜ QuoteDocument `QuoteDocument` — standard, seed:hard
- **Role:** The generated PDF artifact of a Quote (the actual document the buyer receives). Represents the 'we sent them the paper' moment.
- **Why this tier:** Effectively invisible to the demo surfaces that matter — it is a binary PDF artifact, and seeding it requires fabricating a base64 document body for zero narrative payoff. No beat renders it. Pure cost.
- **Relationships:** Lookup → Quote (`QuoteId`). Backed by a ContentVersion/Document body. Seed AFTER Quote (rarely worth it).
- **Key fields:** QuoteId (required), Document (Base64 body / ContentVersion link), Name
- **Gotchas:** Requires the Quotes feature enabled AND a real document body (base64) — you'd be manufacturing a meaningless PDF blob. Skip unless a literal 'open the PDF' demo step is ever required (it isn't in any current beat).

### ⬜ Web-to-Lead `(no SObject — Setup feature posting to /servlet/servlet.WebToLead)` — standard, seed:hard
- **Role:** The runtime inbound-capture mechanism: a website form that creates Lead records via an unauthenticated HTTP POST, optionally firing assignment + auto-response rules. The 'how Leads arrive' plumbing, not a record type.
- **Why this tier:** A live ingestion endpoint, not seedable demo data — there is nothing to insert. To 'demo' it you'd POST to the org's web-to-lead servlet at runtime, producing the same Lead records you can insert directly. Cataloged for completeness; nothing to build.
- **Relationships:** Produces Lead records (same shape as a manually-created Lead). No object of its own.
- **Key fields:** (not seedable data) — configured via a Setup-generated form: oid (org id), retURL, lead.* field params
- **Gotchas:** Not a DML target. If ever exercised it requires the org's 18-char OID and a network POST, subject to a daily web-to-lead cap. Created Leads inherit all the Lead gotchas above. Out-of-scope for the seeder.


---

## Build-phase decisions (as implemented)

The audit ranked objects; these are the **evidence-checked build calls** made while implementing each phase. Recorded so they aren't re-litigated.

**Phase A — deal economics + activities (shipped #27/#28).** Product2 → PricebookEntry → OpportunityLineItem (per-line economics, Σ reconciles to Amount); Task (a second copy-bearing activity stream — the rep's terse note register). Catalog upsert (#31) keeps Product2/PBE from accumulating across re-runs.

**Phase B — cross-deal history (shipped).** Built the **multi-Opp archetype**: `churning-account` and `healthy-tech` accounts carry a PRIOR closed-won deal (backdated, reconciling line items, primary OCR, no copy) so an account's history aggregates over real multi-deal data. Evidence-based **cuts** from the original Phase-B list:
- **OpportunityHistory — SKIP.** System-maintained: you can't insert rows or backdate `CreatedDate`, so "backdated stage velocity" via OppHistory is impossible. No value, high friction.
- **Account.ParentId — DROP.** The only *grounded* hierarchy is divisions of the same anchor ("Acme (Div 2)" → Acme), which only occur when volume exceeds the ~50-anchor pool. At realistic volumes (≤50) it never fires — dead code. (Forcing unrelated real companies into a parent/child tree would violate grounding.) The cross-deal churn archetype is delivered via multi-Opp-per-Account instead, which needs no real hierarchy.

**Phase C — full funnel + conversion (shipped).** Campaigns (shared catalog, upsert by Name) + top-of-funnel Leads (drawn from anchors NOT used as accounts, so still real-company-grounded; upsert by Email) + CampaignMembers, plus `Opportunity.CampaignId` attribution on ~70% of deals. The distinctive piece: a **load-time SOAP `convertLead`** step (`bundle.directives.convertLeads`, run by the loader after inserts) so ~25% of leads convert into Account/Contact/Opportunity with real `ConvertedOpportunityId` lineage. The funnel serves **raw-org realism + the AI-testing substrate (job #2)**, which Ben explicitly chose — no hero beat lands on a Lead. Re-load caveats (the canonical reset is teardown→load): CampaignMembers aren't idempotent (a re-load logs a benign "already a campaign member"); converting an already-converted reused lead fails soft.
