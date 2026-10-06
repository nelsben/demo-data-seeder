# `drip` — daily story-consistent interactions through the org's real activity pipeline

## Why

A demo org loaded once (`plan-demo` → `fill-copy` → `load-demo`) is a frozen snapshot: whatever
downstream automation or AI pipeline the org runs on activity (triggers, flows, nightly
summaries, leadership views) reads the same records forever. `drip` inserts 1-2 new, story-consistent interactions on a few open deals EVERY DAY, as
ordinary `EmailMessage` / `Task` / `ContentVersion` records — so the org's REAL
trigger → queue → LLM → derived-record pipeline runs on them, exactly as it would for a real
rep's real activity. It is not a second data generator: it reuses the same
Deal Dossier continuity primitive and the same `fillCopy` prose pipeline (same prompt, same realism
gate) that seeded the org in the first place — it just authors ONE more beat per touched deal, dated
today.

## What it does, each run

1. **Selects** up to `--accounts` open deals (default 3), preferring the ones that have gone
   quietest (oldest last-interaction date), weighted by how much their story wants regular motion
   (an at-risk-budget deal escalates more often than a `stalled-portfolio` one, which mostly stays
   quiet on purpose).
2. **Resolves each deal's dossier** — its arc, cast, and beat timeline — cheapest source first: its
   own drip-extended cache (`.dataseed/dossiers/`), then the plan-demo registry's original dossier,
   then a best-effort reconstruction straight from the org's existing `EmailMessage`/`Task`/
   `ContentVersion` history (used when the registry/cache never ran on this machine for this org —
   see the honest limitation below).
3. **Plans** the next 1-2 beats (`--beats`) — arc-aware kind/sentiment/who, dated strictly after the
   deal's last beat, never contradicting an already-SETTLED fact.
4. **Writes prose** for just the new beat(s) via the same `fillCopy` pipeline `fill-copy` uses
   (`--provider claude-code|anthropic|static`, same voice prompt, same realism gate).
5. **Inserts** the new records — APPEND-ONLY against the deal's real Salesforce Ids, natural-key
   deduped per record (not the loader's root-Account idempotency — see "Why not the loader" below),
   so re-running the same day is a no-op.
6. **Verifies** by polling the org (read-only, up to 90s) for ingestion-queue rows the insert
   caused (the op is wired to a `Signal_Ingestion_Queue__c` object; an org whose automation uses a
   different queue object reports `0 of M`), and prints `pipeline: N of M records enqueued`. `0 of M`
   (the drip wrote, but the org's pipeline didn't hear it) is a genuine failure — that's exactly the demo-truth gap this op exists to
   catch, and it's why the op exits non-zero on it.

## Daily command

```bash
node run-op.js run drip --org <alias> --yes
```

Without `--yes` it's a DRY RUN: it prints the plan (deal, cast member, beat kind, subject line, and
the would-be record count) and writes nothing — safe to run any time to preview.

### Scheduling it locally

There is no CI-based scheduler for this: it needs an authenticated `sf` CLI session for the target
org, which lives on a developer machine. Run it by hand, or via a local scheduler that shells the
exact command above. Two options:

**launchd (macOS), weekdays at 07:00 local:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.demo-data-seeder.drip</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>run-op.js</string>
    <string>run</string>
    <string>drip</string>
    <string>--org</string><string>YOUR_ORG_ALIAS</string>
    <string>--yes</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Documents/demo-data-seeder</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/drip.log</string>
  <key>StandardErrorPath</key><string>/tmp/drip.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.demo-data-seeder.drip.plist`.

**cron, weekdays at 07:00 local:**

```cron
0 7 * * 1-5 cd /path/to/demo-data-seeder && node run-op.js run drip --org <alias> --yes >> /tmp/drip.log 2>&1
```

**The later path:** a GitHub Actions scheduled workflow with a JWT-authenticated `sf` connection
would remove the "someone has to run it" dependency, but that requires standing up JWT secrets for
the target org, which this repo does not do. This is the honest gap, not a hidden one.

## Reading the manifest

Every real (`--yes`) run writes `.dataseed/drip/<org>/<YYYY-MM-DD>.json` — the day's plan plus every
inserted record's Salesforce Id and natural key:

```json
{
  "org": "<alias>",
  "day": "2026-09-04",
  "createdAt": "2026-09-04T15:05:12.000Z",
  "runStartedAt": "2026-09-04T15:05:00.000Z",
  "seed": 42,
  "accounts": 2,
  "beatsPerAccount": 1,
  "provider": "claude-code",
  "records": [
    { "object": "EmailMessage", "id": "02s...", "naturalKey": "006... Acme — next steps 2026-09-04" }
  ]
}
```

## Removing drip records

`teardown-demo` gained an `--include-drip` flag: it reads every manifest under
`.dataseed/drip/<org>/` and plans (or, with `--yes`, deletes) exactly those Ids, on top of whatever
the base teardown already resolves. Dry-run by default, same as the rest of `teardown-demo`:

```bash
node run-op.js run teardown-demo --org <alias> --include-drip          # preview
node run-op.js run teardown-demo --org <alias> --include-drip --yes    # actually delete
```

Drip manifest files themselves are left in place after a delete (a historical record of what was
inserted and later removed) — re-running `--include-drip` again afterward is harmless: deleting an
already-deleted Id is reported as a per-row failure, never fatal.

## Why not the loader's idempotency

`loadBundle`'s additive idempotency (`docs/open-questions/m4-loader-hardening.md`) is
ROOT-ACCOUNT-GRAINED: an existing `Account.Name` skips its ENTIRE subtree. That is exactly backwards
for the drip, whose entire point is inserting new children under an ALREADY-EXISTING deal. Instead
`drip` uses a per-record NATURAL KEY (`packages/engine/src/drip/dedupe.ts`):

| Object            | Natural key                                       |
| ------------------ | -------------------------------------------------- |
| `EmailMessage`      | `(RelatedToId, Subject, MessageDate::date)`        |
| `Task`              | `(WhatId, Subject, ActivityDate)`                  |
| `ContentVersion`    | `(FirstPublishLocationId, Title)`                  |

so a re-run of the same day inserts 0 duplicates without touching the loader's own idempotency path
or the plan-demo/load-demo dataset registry at all.

## Known limitations (honest, not hidden)

- **`lastInteractionDate` uses `Opportunity.LastActivityDate`** (Salesforce's own Task/Event
  rollup) as the "how quiet has this deal gone" signal for deal selection. It does NOT reflect
  `EmailMessage` activity, since Salesforce doesn't roll email into that field automatically. A deal
  with recent emails but no logged Tasks may look staler than it is. Good enough for picking among a
  handful of open deals daily; a more precise signal (querying all three streams' MAX(date)) is a
  straightforward follow-up if it matters.
- **A reconstructed dossier's `scenario`/arc is unrecoverable** — nothing in the org records which
  narrative arc (`at-risk-budget`, `healthy-tech`, ...) a deal was originally seeded with, if the
  registry dataset isn't there to say so. A reconstructed dossier gets the neutral `steady-progress`
  arc rather than a guessed one, and `beats.ts`'s default template authors a generic
  "follows up on where the deal stands" beat for it — honest, not wrong, just less story-specific
  than a deal whose registry dossier survived.
- **Storage reserve check** mirrors `introspect/probes.ts`'s `RESERVE = 0.2` (20% headroom) but is a
  separate constant in `ops/drip.ts` — `probes.ts` is out of scope for this task, so the threshold is
  intentionally duplicated rather than shared, and could drift if one changes without the other.
