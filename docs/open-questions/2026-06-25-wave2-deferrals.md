# R1 wave-2 deferrals — churn Case + ReportsToId in-org landing + phone area codes (2026-06-25)

**Context.** R1 wave 2 (foreground field saturation, GENERATOR_VERSION 26) shipped geo-coherent billing/phone
(curated `ANCHOR_HQ` + synthetic authored-HQ dual-emit, Account + Contact) and a pure `Contact.ReportsToId`
org chart. Three sub-items were deliberately deferred — design rationale captured here so the next slice picks
up without re-deriving it.

## 1. Churn → Escalated Case near renewal — ✅ SHIPPED (v28, follows the plan below)

**Done.** The `churning-account` scenario now emits an `Status="Escalated"` / `Priority="High"` support Case
grounded in the renewal risk (a named reporter — never the economic buyer — a landed-product reliability
incident, the CFO spend-gate, and a varied ~20–75-day renewal window), on a fresh `r.derive("churn")` stream.
SCENARIO-gated (`unit.scenario === "churning-account"`, not shape-gated → no mis-fire). The golden mix has no
churning unit, so the golden diff is the VERSION LINE ONLY; a dedicated `churn-signal.test.ts` (churning-account
scenario mix) covers it — the plan's "correct home" below, realized. Everything under this heading is historical.

---

The original idea + deferral rationale (kept for provenance): for a CHURNING account (scenario `churning-account`)
with a prior win, the open support Case should be `Status = "Escalated"` and near the renewal CloseDate — the
highest-signal churn tell a VP/AI looks for. **Why it was deferred from wave 2:**

- **Untestable under the current golden mix.** The golden corpus mix is `at-risk-budget / healthy-tech /
  rfp-gated` (volume 3) — it contains **no `churning-account` unit**. The slice keys on `prof.shape ===
  "stalling"` *inside* the prior-win block, reachable only by `healthy-tech` (accelerating — fails) and
  `churning-account` (stalling — not in the mix). So it would produce **zero golden diff** and ship with **no
  regression coverage** in the one gate we have (CI is disabled; local golden is it). That violates test-first.
- **Predicate fragility.** `prof.shape === "stalling"` is shared by `at-risk-budget`, `stalled-portfolio`, and
  `churning-account`; it's only safe by accident (the other two stallers lack `priorWin` so never enter the
  block). One scenario-config change turns it into a silent mis-fire.
- **Realism is the hardest part.** Both adversaries flagged the "Escalated 5 days before renewal" metronome +
  any "health: AT RISK" verdict-string as tells. Doing it right needs a spread date window + grounded
  reporter-voice prose (`grounding.painPhrase` + landProduct + a named reporter), not a one-liner.

**Correct home (the slice to build):** (a) add a `churning-account` unit to a dedicated golden sub-fixture or a
separate scenario test so it's covered; (b) draw on a FRESH `r.derive("churn")` stream (never `pw`/`footprint`);
(c) spread the escalation 20–75 days pre-close; (d) ground the Subject/Description in the deal's real
product/amount/quarter + a named reporter; (e) `Case.Status="Escalated"` (a standard restricted value — load-safe).

## 2. Contact.ReportsToId in-org landing (data shipped; load deferred)

The v26 org chart writes `Contact.ReportsToId` as a `_softRef` to an in-cast contact `_ref`. It is **present in
the corpus / warehouse / file-sink / MCP substrate** (where wave-2 saturation is read — the North-Star 100K
corpus is the product). But the loader inserts all Contact rows in ONE batch and only learns their Ids *after*
insert, so a sibling-pointing `_softRef` is **unresolvable at resolve time → dropped** (the contact is kept;
`ReportsToId` lands NULL in a live org).

**The fix (a separate loader PR):** depth-ordered Contact sub-batching — a pack declares its self-lookup field
(`selfLookupField: "ReportsToId"`), the loader topologically orders contacts by reporting depth (managers first)
and inserts in waves, or does a post-insert UPDATE pass once all Ids are known. Generic enough to also serve
`Account.ParentId`. Own tests (a Contact whose manager inserts in an earlier wave resolves; a cycle is rejected).

## 3. Bulk-tier random ZIP + phone area code (deferred — population data, lower bar)

v26 bound the **foreground** `BillingPostalCode` to the state (a ZIP-3 prefix per `US_STATE_ZIP3` + drawn digits,
so a CA address never carries a TX ZIP — the tell the v26 review caught). The **bulk tier** still draws a fully
random 5-digit ZIP (generate.ts ~1025, `am.int(10_000, 99_999)`) — the same cross-state tell, but on population
records (lower realism bar, not hero deals) and fixing it would move bulk bytes (out of v26's foreground-only
diff). Apply the same `US_STATE_ZIP3` binding to the bulk Account block in a bulk-tier pass. The bulk phone area
code is likewise random within the right dial code (same as foreground — see §4).

## 4. Phone city→area-code coherence (deferred)

`bulkPhone` derives only the country **dial code** (`+1`, `+61`, …); the US area code is random (may not be a
valid NANP code). A wrong area code is a much softer tell than a wrong HQ city, and country-coherent matches the
bulk tier (cross-tier consistency has its own value). Revisit only if a demo zooms into a phone field — then add
a city→area-code table keyed off `hqGeo`. Park.
