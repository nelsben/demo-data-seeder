# The Narrative Engine — Phase 4 design plan

> **Status:** direction **locked** (2026-06-19). This is a redesign of the generation core, not a
> blind sprint — it inverts the order in which a deal is generated. Phases 1–3 (population tier #40,
> cascade-safe loading #41, high-volume loader #42) gave us *scale*; Phase 4 gives the foreground its
> *soul*: one tight, coherent story told across every object of an account.
>
> **Locked decisions (Ben, 2026-06-19):** (1) **Build 4A now** — the zero-LLM keystone refactor.
> (2) **4E is in scope for Phase 4** — the dossier drives *which objects* each account emits (multi-Opp
> churn, Cases/CaseComments, Assets on customers, …), not just the copy. (3) **Cache the authored dossier** —
> Claude authors freely; the dossier is cached by `(seed, account)` and that is our determinism contract
> (same as cached copy today). Cost-posture defaults stand: compact "story-so-far" in copy prompts, and
> `claude-code` (subscription) as the default authoring path — revisit if throughput/quality disappoints.

---

## 1. The problem

Ben's ask: *"prioritize our entire data model and use Claude to build a really tight narrative across
all objects for each account."*

Today we don't do that. Here's the actual shape of the current core (`packs/salescloud/src/generate.ts`,
the `salescloudGenerate` generator):

1. The engine pre-assigns a **scenario** (`at-risk-budget` / `healthy-tech` / `rfp-gated` / …) per unit at plan time.
2. `generate()` deterministically emits the **structure** — Account, Contacts, Opportunity, OLI, OCR, then
   N empty-bodied EmailMessages / Tasks / transcripts — where N and the date-spread come from a per-scenario
   `ScenarioProfile` (`variability.ts`: cadence `shape`, `emailRange`, `personas`, …).
3. The **copy layer** (`packages/engine/src/copy/*`) fills each empty body **one artifact at a time**, in
   isolation. Each LLM call sees the scenario, the deal facts, a voice card, and grounding — but **not the
   other artifacts**. Email 4 does not see email 3.

So the scenario **constrains** the story (how many emails, what cadence, which personas) but nobody ever
**authors** it. There is no single source of truth a reader could point at and say "this is the story of
this deal." The coherence we get is statistical, not narrative.

This is exactly what our own LLM-as-VP judge (`copy/judge.ts`) is built to catch, and does:

- *"a reply that doesn't actually respond"* — because email N never saw email N-1.
- *"an arc too neat / resolves too cleanly"* — because no one planned the arc; it's a cadence curve.
- *"generic detail where a real person would be specific"* — because each artifact invents its own facts;
  the $1.2M in email 2 and the "budget pressure" in task 3 aren't the *same* tension, just adjacent ones.

And the judge today is **advisory only** — it scores and reports, but nothing consumes its verdict. We
measure the gap; we don't close it.

**The realism backlog already names the two missing pieces** (`docs/narrative-design.md`):
*thread-aware generation* (built: no) and *grounding — don't sell a company its own product* (built: by
manual discipline, no guard). Phase 4 is where both land, as a consequence of the redesign rather than as
bolt-ons.

---

## 2. The idea — invert the order: author the spine first

Instead of *structure → isolated copy*, do **spine → structure → thread-aware copy → validation against the spine.**

Before any artifact exists, **Claude authors one structured "Deal Dossier" per foreground account** — the
narrative spine. Everything else in the account is then *derived from that spine*, so every object is telling
the same story by construction:

```
            ┌─────────────────────────────────────────────────────┐
  scenario  │  ① SPINE  — Claude authors the Deal Dossier          │
  + anchor  │     (arc, cast, beat timeline, shared numbers)       │
  + traits  └───────────────────────────┬─────────────────────────┘
                                         │  (deterministic from here)
            ┌────────────────────────────▼─────────────────────────┐
            │  ② STRUCTURE — beats drive which objects exist, when,  │
            │     who authors each, and what each must convey        │
            └────────────────────────────┬─────────────────────────┘
            ┌────────────────────────────▼─────────────────────────┐
            │  ③ COPY — each artifact realized WITH the spine +      │
            │     the thread-so-far (email N finally sees email N-1) │
            └────────────────────────────┬─────────────────────────┘
            ┌────────────────────────────▼─────────────────────────┐
            │  ④ VALIDATE — judge the thread AGAINST the spine;      │
            │     grounding guard; critiques feed regeneration       │
            └───────────────────────────────────────────────────────┘
```

The spine is the "tight narrative across all objects." It is cheap (one structured call) relative to the
6–13 copy calls it coordinates, and it is the artifact that makes those copy calls cohere.

---

## 3. The Deal Dossier (the spine schema)

A structured object Claude returns (and a deterministic *static* version exists as a fallback — see §7).
Sketch, not final:

```ts
interface DealDossier {
  arc: string;                 // 2–3 sentences: what's happening, the tension, where it's heading.
  cast: Array<{                // the named buying committee — MUST be the seeded Contacts, never invented.
    ref: string;               // -> the Contact _ref
    persona: Persona;          // Champion | Economic Buyer | Skeptic | Blocker | ...
    stance: string;            // "championing internally, but went quiet after the CFO got involved"
    silentAfterBeat?: number;  // models the champion-silence beat structurally
  }>;
  beats: Array<{               // the chronological timeline — THIS is what drives structure (§4).
    day: number;               // days before asOf (e.g. -45, -30, -18, -7)
    summary: string;           // "Champion intros us to the CFO; budget ceiling first mentioned."
    artifact: "email" | "task" | "transcript";
    authorRef: string;         // who writes/speaks it
    direction?: "inbound" | "outbound";
    sentiment: "Positive" | "Neutral" | "Negative" | "Risk";  // the trajectory, beat by beat
    conveys: string;           // the one specific fact this beat must carry ("$1.2M is ~40% over ceiling")
  }>;
  numbers: { amountUsd: number; ceilingUsd?: number; painMetric?: string };  // the shared, specific facts
  competitor?: string;         // from anchor grounding — a real rival, never the prospect's own product
}
```

Two things make this the **right** abstraction:

- **`beats` is a timeline, not a blob.** It replaces today's `spreadDates()` cadence curve with an authored
  sequence of events. The structure layer reads `beats` to decide how many emails/tasks/transcripts exist,
  their dates, direction, and author — so the *shape* of the deal is the story, not a distribution.
- **The spine is the single source of truth, so the thread can be validated against it.** Each beat declares
  the one specific fact it must carry (`conveys`) and its point on the sentiment trajectory, so we can assert
  the filled thread actually tells the story the spine authored (the no-vapor-ware law: author the spine, let
  the copy layer realize it, *assert the thread matches*). A thread that drifts off its own beats is a bug,
  caught before load.

---

## 4. Spine → structure (deterministic)

The per-unit loop in `generate.ts` changes from "emit N emails on a cadence curve" to "walk `dossier.beats`."
Each beat of kind `email` becomes an EmailMessage at `asOf + beat.day`, authored by `beat.authorRef`,
direction `beat.direction`; kind `task` → a Task; kind `transcript` → a ContentVersion (a VTT call-recording
file linked to the Opportunity via `FirstPublishLocationId`).
The `inReplyTo` / `threadId` wiring (already present) now follows the authored sequence instead of a synthetic
reply chain. **Determinism is preserved**: given the dossier (authored once and cached — §7), the structural
expansion is pure seeded RNG exactly as today. The dossier is just a new, cached *input* to a deterministic step.

---

## 5. Spine + thread → copy (thread-aware, the judge's two failure modes fixed)

`CopyRequest` already carries `threadId`, `inReplyTo`, `seq`, `voiceCard`, and `grounding`
(`packages/core/src/bundle.ts`). Phase 4 adds the spine and the **thread-so-far** to the copy prompt:

> *Here is the deal dossier. Here is the thread up to now [prior artifacts]. Write the next artifact, which
> realizes THIS beat: "{beat.summary}", conveying "{beat.conveys}", in {author}'s voice.*

This directly closes the judge's two structural complaints — the reply now *responds*, and "specific detail"
is the spine's shared numbers, not per-artifact invention. It does cost us the frozen-system-prompt cache
efficiency (the user prompt becomes volatile with thread history); §10 carries that trade-off as a decision.
We **reuse the existing `gateCopy` regenerate loop and `voice-lint` wholesale** — they operate on the filled
artifacts and don't care that the upstream got smarter.

---

## 6. Validate against the spine (close the judge loop + a grounding guard)

Two additions, both reusing existing machinery:

- **Spine-aware judge (wire the advisory loop shut).** Today `judge.ts` scores a thread 1–5 and stops.
  Phase 4 feeds it the **dossier** ("does this thread tell *this* story? does the arc land, does the silence
  read as silence?") and routes a failing verdict's critique back through `gateCopy`'s regeneration prompt —
  the same path voice-lint violations already take. The judge stops being a report and becomes a gate.
- **Grounding guard (deterministic, a new voice-lint rule family).** Cheap, zero-LLM assertions that catch
  the "sell a company its own product" tell and friends: no artifact may name the prospect as its own
  competitor; the only stakeholder names that appear are the seeded `cast`; every number in copy traces to
  `dossier.numbers`. This is the *built* version of the backlog's grounding discipline.

---

## 7. Scale, cost, determinism — why this is safe

- **Foreground only.** Dossiers are authored for the `volume` (hero/demo) deals — the ones that get the full
  copy treatment. The **bulk population tier (Phases 1–3) stays purely structural** — no spine, no copy. 100K
  accounts don't get 100K dossiers; the ~dozens of foreground deals do. Phase 4 composes with the existing
  tiering instead of fighting it.
- **Cost.** One spine call per foreground deal (cheap, structured) + the existing 6–13 copy calls (now
  thread-aware). The spine is a small fraction of spend and *improves* the yield of the expensive copy calls.
  Budget caps and the static fallback work exactly as today.
- **Determinism.** Mirror the existing `static` copy provider with a **static spine provider**: a templated
  Deal Dossier per scenario (the `SALESCLOUD_SCENARIOS` archetypes — `at-risk-budget`, `healthy-tech`,
  `rfp-gated`, `stalled-portfolio`, `churning-account` — seed them). No-LLM runs stay fully deterministic and
  free. When an LLM authors the spine, we **cache the authored
  dossier by `(seed, account)`** (the registry already content-addresses) so re-runs are stable and don't
  re-pay. "Deterministic" becomes "deterministic given a cached spine," same contract as cached copy today.

---

## 8. "Prioritize our entire data model" — the spine drives the object set

This is the other half of Ben's ask, and it's where the spine earns the word *entire*. Today every deal emits
a fixed object skeleton. Phase 4 lets the **dossier declare which objects its story needs**, tiered by the
`docs/object-audit.md` ranking:

- A **churning account** dossier asks for multiple Opportunities + a Closed-Lost + dissatisfaction expressed as
  Cases / CaseComments → a real *declining-health* narrative across the account graph.
- A **healthy expansion** dossier asks for OpportunityLineItems + a prior Closed-Won → so there's an installed
  base (Assets) and white-space for the next deal to expand into.
- An **RFP-gated early** dossier stays deliberately sparse — the honest "quiet, not at risk" beat.

The object set stops being a constant and becomes a function of the story — which is the literal reading of
"prioritize our entire data model for each account." It also gives us the hook to light up the **under-used
standard objects** the audit (`docs/object-audit.md`) flagged (multi-Opp histories on late-stage deals, Assets
on customers, firmographics — now seeded by Phase 1) on the deals whose story actually calls for them.

---

## 9. Build sequence (each sub-phase a tested PR)

Deliberately staged so the risky inversion lands first with **zero LLM and full determinism**, then the
intelligence layers on:

| Sub-phase | What | LLM? | Proves |
|---|---|---|---|
| **4A — Spine spine** | `DealDossier` schema + a **static** (templated) spine provider + rewrite the per-unit loop to walk `beats` for structure. | No | The inversion works; determinism + all existing tests hold; nothing costs anything yet. |
| **4B — Claude authors the spine** | A `SpineProvider` (claude-code / anthropic / static) mirroring `CopyProvider`; cached + budgeted; static fallback. | Yes | Claude can author a coherent dossier from scenario + grounding + traits. |
| **4C — Thread-aware copy** | Pass spine + thread-so-far into `CopyRequest` prompts; reuse `gateCopy` + `voice-lint`. | Yes | Replies respond; detail is shared, not invented. Judge scores climb. |
| **4D — Spine-aware validation** | Wire the judge into the regenerate loop (judge vs. dossier); add the deterministic grounding guard. | Yes | The judge becomes a gate; "sell-its-own-product" tells are impossible. |
| **4E — Story-driven object set** | Dossier declares its object needs; expand under-used objects (Cases/CaseComments, Assets, multi-Opp churn) per audit tiers. | No (structure) | "Entire data model" — object emission follows the story. |

4A is the keystone and the one I'd build first regardless of the decisions below — it's pure refactor +
schema, fully testable without an org or a token.

---

## 10. Risks & the decisions that are yours, Ben

These genuinely change the build, so I want your call before 4B+:

1. **Determinism stance for the LLM spine.** Option (a) cache the authored dossier by `(seed, account)` and
   treat *that* as deterministic (cheaper, lets Claude author freely). Option (b) require a fully-deterministic
   static dossier that the LLM only *enriches* (stricter reproducibility, less creative latitude). 4A ships
   the static dossier either way; this decides whether the LLM replaces it or decorates it.
2. **Thread-awareness depth.** Full prior-thread text in every copy prompt (best coherence, breaks the frozen
   system-prompt cache, higher token cost) vs. a compact "story-so-far" summary the spine emits (cheaper,
   cache-friendlier, slightly less verbatim continuity).
3. **Spine authoring model default.** `claude-code` (your subscription, $0 API, slower, 3 concurrent) vs.
   `anthropic` API (metered, fast) as the default authoring path — same choice we made for copy.
4. **How far to push 4E.** Story-driven object *selection* is a meaningful expansion of scope (new objects,
   new picklist surface area). Do you want the spine to drive the **object set** (full §8), or keep a fixed
   object skeleton in Phase 4 and only make the **copy** cohere (defer §8 to a Phase 5)?

**Resolved (see locked decisions at the top):** build 4A now; cache the LLM dossier as the determinism
contract (1a); compact story-so-far in copy prompts (2); default authoring to `claude-code` (3); and **4E is
in scope** — Phase 4 carries the story-driven object set, so the sequence runs 4A → 4B → 4C → 4D → 4E in full.
