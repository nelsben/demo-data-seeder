# Target orgs

**The repo ships no scratch-org definition files, by design.** The seeder does not own
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
node bin/run-op.js run profile-org --org <alias>
```

If you use Claude Code with the Salesforce DX MCP server, add a gitignored `.mcp.json`
at the repo root and set `--orgs` to the same alias:

```json
{
  "mcpServers": {
    "Salesforce DX": {
      "command": "npx",
      "args": ["-y", "@salesforce/mcp", "--orgs", "<your-org-alias>", "--toolsets", "orgs,metadata,data,users", "--allow-non-ga-tools"]
    }
  }
}
```

## Guardrails for shared orgs

- **Never reap or recreate a shared dev org mid-CI-validate** — reaping the CI
  target reds every in-flight PR with `INVALID_CROSS_REFERENCE_KEY` (looks like a
  regression, isn't).
- **Never seed orphan data into a shared org during an in-flight CI validate.**
  Develop against a scratch org; let CI deploy up.
- **Tear down what you seed** — `teardown-demo` and `purge` exist so a shared org
  doesn't accumulate stale demo data (`docs/storage-and-purge.md`).

Dev-Edition Dev Hub caps to plan around: **6 scratch creates/day, 3 active**.
