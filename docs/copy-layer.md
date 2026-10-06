# The copy layer (M5)

> Canonical source for how the seeder turns deferred CopyRequests into prose. The
> generation core (`generate/`) writes records with copy fields **empty** and emits
> a `CopyRequest` manifest — the no-vapor-ware seam. This layer fills them.

## The seam

`generate()` never writes prose. For each EmailMessage it emits an empty `Subject`/
`TextBody` plus a `CopyRequest` (`{ id, kind, scenario, beatIntent, speakers }`)
whose `id` equals the record's local `_ref`. The copy layer fills those requests
into `CopyResult`s (`{ id, subject?, body, provider }`) and `applyCopy()` writes
them back onto the records by matching `id → _ref`. Then `load-demo` ships
populated emails into the org.

Contracts live in `@dataseed/core` (`copy.ts`): `CopyRequest`, `CopyResult`,
`CopyProvider`, `CopyFillContext`, `CopyFillReport`. Implementations live in the
engine (`copy/`) — they pull in SDKs/credentials core must stay free of.

## Provider routing

Preferred → fallback, resolved by availability (or forced with `--provider`):

1. **anthropic** — the Anthropic Messages API (`claude-opus-4-8`), gated on
   `ANTHROPIC_API_KEY`. Structured output via a forced `emit_email` tool call
   (`{subject, body}`), so the result is a validated object, never free text.
   Concurrency-limited (5), **budget-capped** (`--budget-usd`), and resilient — a
   refusal/error on one email just leaves it for the static tier.
2. **claude-code** — the claude-code subscription provider (no per-call API spend).
   The realism path when an `ANTHROPIC_API_KEY` isn't in play.
3. **static** — always available, **no LLM**. Deterministic templated emails seeded
   from the request id (byte-stable re-runs). The floor that keeps a run working
   with zero credentials. Intentionally modest prose — not the marquee path.

The orchestrator (`orchestrate.ts`) runs the resolved primary within budget/limit,
then **always static-fills the remainder**, so no email ever ships blank. The
org's probed preference (`profile.copyProvider`) seeds the `auto` choice.

## The prompt is the product

`copy/prompt.ts` holds `EMAIL_SYSTEM_PROMPT` — the voice spec distilled from
[design/voice.md](design/voice.md) into realistic B2B sales correspondence (the
anti-AI-slop principles are the load-bearing part). It is the **single source of
truth**: the runtime AnthropicCopyProvider and the offline prompt-validation
workflow both consume `buildEmailPrompt()`, so what we validate is exactly what
ships.

**Validation:** before shipping, a workflow generates sample emails from the exact
prompt across the deal trajectories (champion-silence at-risk / healthy
accelerating / early RFP-gated) and adversarially grades each against the anti-slop
spec (specificity, trajectory match, persona match, slop tells). The prompt ships
only when the panel passes. The M5 run scored **6/6 pass, avg specificity 83.7,
zero slop tells**; its two recommended refinements (anchor canonical entities in
the beat; curb confessional openers / month-anchor dates) are folded into the
shipped prompt and into the beat construction below.

**Anchored beats:** `generate.ts` injects the real Opportunity `Amount`, `CloseDate`,
and primary-contact name into each `beatIntent` (with "use these EXACT figures"),
so generated emails quote the **same** numbers/names the loaded Salesforce records
carry — not fresh hallucinations that would contradict the loaded data.

## The op

`fill-copy --org <alias> [--provider auto|anthropic|claude-code|static]
[--budgetUsd N] [--limit N]` reads the bundle plan-demo produced, fills every
EmailMessage body, and writes the bundle back (local file only — `load-demo`
pushes). `--limit N` caps how many emails the **model** writes (the rest go to
static) — a cheap smoke test. `verify()` fails unless every EmailMessage has a
non-empty `TextBody`.

Pipeline: `plan-demo` → **`fill-copy`** → `load-demo`.

## Known limitations / next

- **Per-email generation** (not thread-aware): each email is generated from its
  beat independently, so it can't literally quote the prior message in its thread.
  Thread-coherent generation (pass the thread-so-far) is a clear later improvement.
- **Other kinds**: beyond `kind: "email"` (→ EmailMessage `Subject`/`TextBody`),
  the copy layer fills Task notes (→ `Task.Description`) and call-recording VTT
  transcripts (→ `ContentVersion.VersionData`, linked to the Opportunity via
  `FirstPublishLocationId`).
