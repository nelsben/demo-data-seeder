# References

The north-star brands and articles that inform the seeder's copy and
voice POV — the realism bar for the synthetic Sales Cloud data this
repo generates (emails, activity notes, call transcripts). Each entry:
who they are, what we steal, one canonical link.

Cite these when you want to ground a voice or copy decision in
something beyond "I think." The mandatory voice spec lives in
[voice.md](./voice.md); this file is the anchor library it draws on.
If you find a new reference worth keeping, add it here.

---

## Brands

### Linear
<a id="linear"></a>
**Who:** Project management for software teams.

**What we steal:**
- *Clarity at every density.* Linear puts a lot on screen and it never
  feels cluttered — they earn density with restraint (one accent
  color, hairlines as dividers, tight typography). The copy analogue:
  a seeded email or activity note packs in specifics without padding —
  every line earns its place, nothing decorative.
- *Power-user default.* They treat power users as the default, not the
  exception. The seeder's voice assumes a reader who knows the deal —
  no over-explaining, no hand-holding preamble.
- *Crisp, no filler.* Linear's product copy is terse and concrete. The
  seeder's terse rep-note voice (Task.Description) is tuned to the same
  register.

**Link:** <https://linear.app/method> — Linear's own design method.

---

### Stripe
<a id="stripe"></a>
**Who:** Payments infrastructure.

**What we steal:**
- *Sober composability.* Stripe's product UI is built from a small
  vocabulary of components that compose cleanly. The seeder's craft
  analogue: a tight set of narrative beats (the per-account Deal
  Dossier spine) composes into every record — email, note, transcript
  — so one story reads consistently across objects.
- *Document-as-artifact.* Stripe's invoices and receipts feel like
  *documents* — they have rhythm, hierarchy, breathing room. A seeded
  call transcript (ContentVersion VTT) or email thread should feel like
  a real artifact a rep would actually find in the org, not a template
  fill-in.

**Link:** <https://stripe.com/blog/the-secret-life-of-components> —
how Stripe thinks about its design system.

---

### Notion AI (and BUCK)
<a id="notion-ai"></a>
**Who:** Notion's AI features, with character design by BUCK studio.

**What we steal:**
- *Character reacts to state.* BUCK's Sona has expressions for
  thinking, idling, confused, excited. The copy analogue: seeded voice
  tracks the deal's state — an email mid-negotiation reads differently
  from one after a champion goes silent. Tone follows the sentiment
  trajectory, never flat across the thread.
- *Distinct character without caricature.* Sona is whimsical but never
  childish. The seeder's personas (a CFO and a champion never sound
  alike) aim for the same restraint — each voice is its own person,
  never a cartoon of a role.

**Link:** <https://buck.co/work/notion-ai> — BUCK's case study on the
Notion AI character system.

---

### Anthropic
<a id="anthropic"></a>
**Who:** The company behind Claude.

**What we steal:**
- *Direct, honest, warm voice.* The Anthropic product voice is the
  north star for [voice.md](./voice.md). Specific, not hedged. Owns
  uncertainty. Talks to humans like humans — exactly the register a
  seeded rep note or email needs to read real.
- *Character distinct from voice.* Anthropic talks about Claude's
  "character" separately from "voice" — character is *what someone is*,
  voice is *how they talk*. The seeder inherits this split: each
  persona in the buying committee has its own character; voice is the
  surface that character speaks through.
- *Evidence over assertion.* Anthropic shows its work. The seeder's
  copy rule is the same — "CFO confirmed the $200K cap on Tuesday," an
  exact quote with attribution, never "stakeholder expressed budget
  alignment." Specifics are the proof the data is real.

**Link:** <https://www.anthropic.com/news/claudes-constitution> —
Claude's character + values, public.

---

### Arc Browser
<a id="arc"></a>
**Who:** A browser by The Browser Company.

**What we steal:**
- *Texture without gimmick.* Arc has playful touches that feel
  adult-fun, not toy-fun. The copy analogue: the small, specific,
  human detail in a seeded note (the offhand aside, the named
  blocker, the half-finished thought) is what makes data feel lived-in
  — used sparingly so it reads as real, not as a writer showing off.
- *Ration the standout moment.* Arc reserves its most charming touches
  for moments you only see occasionally. A memorable line in a
  transcript lands precisely because the surrounding copy is plain
  working prose — over-color every line and none of it reads true.

**Link:** <https://thebrowser.company/values> — The Browser Company's
public values doc.

---

### Salesforce Trailblazer Community
<a id="trailblazer"></a>
**Who:** Salesforce's developer + admin community, including the
Trailhead learning platform.

**What we steal:**
- *Conversational, not antiseptic.* Salesforce's default product chrome
  is antiseptic blue + white. Trailhead and the Trailblazer community
  brand is warm — conversational voice, plain language, talks to
  practitioners like peers. The seeder's copy lives in that warm,
  human register, not the corporate-chrome one, even though the data
  lands inside a stock Salesforce org.

**Link:** <https://trailhead.salesforce.com/> — the live reference.

---

## Articles + technical references

### Voice articles
<a id="voice-articles"></a>
For [voice.md](./voice.md) — "products that say less, mean more."
Anthropic's own writing on the topic + a few external takes. The
register here is the floor every seeded copy string has to clear.

- <https://www.anthropic.com/news/core-views-on-ai-safety> — how
  Anthropic talks about hard topics. Voice exemplar.
- <https://writingfordesigners.com/> — generally useful guide for
  copy density and rhythm.

---

### Linear Slack agent — speak the host's grammar
<a id="linear-slack-agent"></a>
**Source:** [ZenML LLMOps — Linear's Slack agent](https://www.zenml.io/llmops-database/building-a-conversational-ai-agent-for-slack-integration)

Linear's team explicitly chose not to port Linear's UI into Slack —
they wrote to Slack's grammar instead. The copy analogue: seeded text
has to speak its object's native grammar. A `Task.Description` is a
rep's terse logged-activity note; an `EmailMessage.TextBody` is a real
thread; a transcript VTT is spoken back-and-forth. Each is written in
the voice the *host object* would actually carry, never one generic
"AI copy" voice flattened across all three.

---

## Adding a reference

To add a new entry:
1. Pick the right section (brand vs article).
2. Add the anchor with `<a id="…"></a>` so sub-docs can deep-link.
3. Write the "what we steal" in 2–4 lines — the specific transfer, not
   a vague vibe.
4. Cite one canonical link (the brand's own design method, the
   article's permalink, the case study). Avoid Medium/HN summaries
   when the primary source exists.
