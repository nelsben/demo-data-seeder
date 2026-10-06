# `config/scratch/` — target orgs

**There are no scratch-def JSON files here, by design.** The seeder does not own
scratch-org metadata. It loads **only standard Sales Cloud + related standard
objects** — no custom (`__c`) objects, no managed package, no Data Cloud branch —
so **any plain Developer-edition scratch org works**, and the same dataset loads
into a scratch, shared dev, or customer org unchanged. Data Cloud is at most a
*future optional sink* (`docs/registry-and-dispersement.md`), never a generator
or scratch-org concern.

## Pointing the seeder at an org

Every op takes `--org <alias>`, where `<alias>` is a Salesforce CLI alias
(`sf org list`). Authenticate once (`sf org login web --alias <alias>` or
`sf org create scratch --alias <alias> --definition-file <your-def>.json`), then:

```bash
node run-op.js run profile-org --org <alias>
```

If you use the MCP server, copy `.mcp.example.json` to `.mcp.json` and set
`--orgs` to the same alias.

## Guardrails for shared orgs

- **Never reap or recreate a shared dev org mid-CI-validate** — reaping the CI
  target reds every in-flight PR with `INVALID_CROSS_REFERENCE_KEY` (looks like a
  regression, isn't).
- **Never seed orphan data into a shared org during an in-flight CI validate.**
  Develop against a scratch org; let CI deploy up.
- **Tear down what you seed** — `teardown-demo` and `purge` exist so a shared org
  doesn't accumulate stale demo data (`docs/storage-and-purge.md`).

Dev-Edition Dev Hub caps to plan around: **6 scratch creates/day, 3 active**.
