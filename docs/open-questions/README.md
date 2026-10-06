# Open questions — the parking lot for deferred design knobs

When moving fast, design knobs that would otherwise stall a decision get parked here instead of
blocking the build. The rule (CLAUDE.md §2, "Defer, don't drop"): **defer the knob, write down
the rationale, keep moving.**

## Convention

One file per question (or per cluster), dated:

```
docs/open-questions/YYYY-MM-DD-<short-topic>.md
```

Each file states: the question, why it's deferred (what we'd need to resolve it), the current
working assumption, and what would force a decision. Resolve by editing the file to record the
call + moving the decision into the canonical doc it belongs to.

## Currently open

The initial architecture sketch (`docs/architecture-sketch.md`, final section) carries the first
batch of open design questions for the seeder — model-copy strategy, DC-path org provisioning,
deterministic-RNG seeding scheme, loader mechanism choice, idempotency keying, and the V0/V1 scope
line. Migrate any that need a real decision-record into dated files here; leave the rest in the
sketch until they're live.
