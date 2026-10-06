# `config/` — static reference data

Small, checked-in reference inputs that are not code.

| Path | Role |
|---|---|
| `anchors/companies.json` | The original real-public-company **anchor list** (name, synthetic `.example` domain, industry, approximate headcount band). Real company names ground the generated Accounts so a demo reads as real; everything around them — contacts, deals, emails — is fictional. The pack's live anchor table now lives in code at `packs/salescloud/src/anchors.ts`; this file is kept as the human-readable source list. |
| `scratch/README.md` | Notes on which Salesforce orgs the seeder targets (any standard org) and the guardrails for shared orgs. |

Anchor policy (applies to any anchor list):

- **Genuinely real, well-known public companies** — free public knowledge, so accounts read as real to a viewer.
- **Synthetic email domains only.** Every anchor domain ends in `.example`; the seeder never emits a real person's address.
- **Spread across industries and employee bands** so the variability matrix has range to draw from (`docs/narrative-design.md`).
- **Resolve by name/query at load time, never by literal Id.** Literal Ids don't survive a fresh scratch org; anchors are matched/upserted by `Name`.

The generation model itself (anchors × scenario arcs × the variability matrix, driven by a seeded RNG) is documented in `docs/narrative-design.md` and `docs/app-architecture.md`.
