# Realism playbook — making demo data read as real to VPs/CEOs

> **North star (Ben, 2026-06-18):** "This needs to feel as close to real as we can get. It is
> going in front of VPs and CEOs. If we don't have as close to real data as we can get, our
> product looks fake, and we lose a very valuable testing facet for testing AI applications."
>
> Realism is THE product here — it carries both jobs at once: the exec demo, and using
> real-looking inputs to validate AI workflows. Fake-looking data fails both. This doc is the
> canonical source for *how* we hit that bar and *how we measure it*. It is the output of an
> adversarial audit (a skeptical VP, a skeptical CEO, and an AI-text detector tearing into our
> own output) plus SOTA research and a constructive design pass.

## The verdict: the static tier is structurally a template

The static provider renders `ARC[scenario][phase]` — **one fixed `Beat` per (scenario, phase)** —
so every company in the same arc emits the same prose with only amount/contact/date interpolated.
**Snowflake and Stripe come out byte-identical with the name swapped.** All three skeptics named
this *independently* as the single most damaging tell, and the VP's reaction is the whole risk in
one line: *"the moment I saw Snowflake and Stripe run the same script, I'd stop trusting every
record on the screen — and conclude the product underneath was demo-ware too."*

"N companies → N copies" is a property of the data structure, not a quality knob. **No static
polish escapes it.** Therefore:

- **Static is demoted to the no-credentials CI floor** — deterministic, byte-stable, and the
  canonical *negative* fixture the voice-lint runs against. It is never a demo surface.
- **The demo + AI-validation jobs require real per-deal LLM generation** (the Anthropic provider,
  grounded in each company's facts). That is the critical path; it needs `ANTHROPIC_API_KEY`.

## Definition of done — the realism rubric

The gate every batch of copy is held to. Machine-checked dimensions are enforced by
[`voice-lint.ts`](../../packages/engine/src/copy/voice-lint.ts) (the canonical rule set); human/judge
dimensions are gated by the LLM-judge stage + a human spot-check on the hero deals.

| Dimension | Bar | Check |
|---|---|---|
| **Cross-instance distinctness** *(headline)* | For any two emails at the same `(scenario, position)`, mask names/numbers/dates → token Jaccard **< 0.45**. The Snowflake==Stripe case is impossible to ship. | machine |
| Speaker self-consistency | Sender writes first-person about themselves, third-person about others. Naming yourself in your own body = fail. | machine |
| Money & date realism | `$1.2M` / `~$350K` / "low seven figures" — never `$1,200,000`. "ARR" at most once per thread. | machine |
| Template-seam integrity | No doubled function word from concatenation ("before … before", "the the"). | machine |
| Voice authenticity | Zero AI-slop phrases + stock confessional openers; em-dashes ≤2/email; contractions present. | machine |
| Structural variety | ≤70% of emails share a paragraph count; replies thread ("Re:"); greetings vary. | machine |
| Specificity / evidence density | ≥2 specifics per email, ≥1 *earned* (a meeting, a competitor, an objection — not just the seed facts). | machine + judge |
| Company grounding | ≥1 detail true to the actual anchor per thread (Snowflake→warehouse credits; Stripe→payment volume/fraud). Swapping the company name should force a body change. | human/judge |
| Thread coherence | Reads as a real back-and-forth: replies answer the prior message, later emails reference earlier commitments, sentiment moves across phases. | human/judge |
| VP-believability | LLM-judge ≥4.0/5 ("would a human colleague have written this"), no email <3; human spot-check on the 3 hero archetypes before any exec demo. | judge + human |
| Pipeline-proof *(no-vapor-ware)* | Copy is produced by the real generation pipeline (Deal Dossier → CopyRequest → provider chain → gate → judge), never hand-authored. Weak output → fix the source (prompt, fact-pack, scenario), never hand-edit a generated record's prose. | machine |

## Top tells to kill (ranked)

1. **Cross-deal cloning** *(fatal)* — same template, names swapped. → real per-deal LLM generation + **Verbalized Sampling** (ask for k distinct thread shapes with probabilities, draw *without replacement* across an arc) + the `CROSS_INSTANCE_SIMILARITY` lint regenerating the duplicate. *Static can never escape this.*
2. **Third-person-self** *(fatal)* — inbound from "Diane" saying "Diane Okafor is bought in". → speaker-aware rendering + per-writer voice card. *(static floor fixed in this PR)*
3. **Machine money** `$1,200,000 ARR` *(high)* → `humanizeUsd()` everywhere incl. the LLM prompt input. *(fixed)*
4. **Concatenation seam** "before they'll commit before the Aug 15 close" *(high)* → context-aware connectives. *(fixed)*
5. **Rigid 3-paragraph shape + no email furniture** *(high)* — no greeting, signature, "Re:", quoted history. → voice cards + burstiness + structural authenticity. *(needs voice cards)*
6. **Interchangeable company** *(medium)* — nothing reflects what the named company does. → per-anchor grounding fact-packs. *(needs the LLM to weave them)*
7. **Buyer == rep voice** *(medium)* → per-person voice cards (CFO terse + ROI-anchored; champion warm + leaks intel; procurement hedged).

## Build order

1. **`voice-lint`** — deterministic, zero-dep, CI-tested; the bar + the regen feedback source. *(this PR)*
2. **Static floor hygiene** — kill the mechanical per-email tells (money/self-ref/seam/confessional). *(this PR)*
3. **Voice cards** (deterministic writer-style per Contact + AE) + **thread plumbing** (`threadId`/`inReplyTo`/`seedSubject` on `CopyRequest`) + **per-anchor grounding fact-packs** (products/competitors/buyingDept/painPhrase) — all buildable without a key.
4. **(key-gated)** Thread-aware sequential Anthropic generation + Verbalized Sampling + the `gateCopy()` lint→judge→regenerate loop (judge prefers a different model family to avoid ~10% self-preference).

## The quality loop (`gateCopy()`, between fill and apply)

`generate → voice-lint (deterministic, blocking) → LLM-judge "would a VP believe a human wrote
this?" (key-gated) → regenerate-on-fail (≤2, violation fed back as a constraint) → human gate on
the hero deals`. Degrades gracefully: **no key → lint-only** (still rejects the static tier's
mechanical tells); **key present → full lint + judge + regen.** Never silently ships a
regen-exhausted email — it's flagged for review.

## Decisions (defaults in force unless Ben says otherwise)

- **Determinism split:** demo runs are non-deterministic (LLM + controlled imperfection); CI/regression
  runs stay on the deterministic static + lint floor.
- **Grounding boundary:** anchors stay REAL (Snowflake/Stripe); contacts/amounts FICTIONAL; never
  fabricate real employee names; fact-packs assert only public, non-financial company details.
- **Structural furniture on purpose:** greetings/signatures/Re: chains are seeded deliberately so
  downstream consumers (an AI workflow's signature strip / PII mask / thread reconstruction) have
  real shape to chew on — realism *and* a testing-facet win.

## Open questions for Ben

- Provision `ANTHROPIC_API_KEY`, and the per-run budget cap for hero deals vs. the long tail (you said realism overrides cost — how generous)?
- Is a non-Claude model acceptable as the LLM-judge (to dodge same-family self-preference)?
- OK to actually drop the final reply + widen the date gap for the at-risk "silence" beat (honest Stalling/Dark velocity, but changes record counts)?
- Which deals are the "hero" set that get panel-judge + mandatory human spot-check (Meridian/TechVista/Cascade)?
