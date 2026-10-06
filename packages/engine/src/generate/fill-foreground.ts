// packages/engine/src/generate/fill-foreground.ts
//
// Fill the FOREGROUND hero-deal copy on a generated slice IN PLACE, so a materialized corpus is never blank.
// This is the seam that fixes the "warehouse→org load ships its centerpiece deals empty" defect: materialize
// (and the headless materializeCorpus service) generate the structural bundle with DEFERRED CopyRequests, and
// this renders them into EmailMessage TextBody/Subject, Task Description, and ContentVersion VersionData before
// the records are written.
//
// copyMode is part of the corpus identity (folded into the cache key):
//   - "static"  → deterministic, no API — the always-on floor; a corpus is never blank.
//   - "claude-code"/"anthropic"/"auto" → author the per-deal dossier spine, then fill VP-grade LLM bodies
//     (cached under .dataseed/dossiers, so re-materializing is a cache hit).
//   - "none"    → leave bodies deferred (blank) for a pure-structural corpus.
// The BULK tier carries no CopyRequests, so this only ever touches foreground records.

import type { BundlePlan, BundleRecords, CopyRequest, NarrativeBundle } from "@dataseed/core";
import { buildProviders, fillCopy, applyCopy, attachSpineContext } from "../copy/index.js";
import { authorDossiers, buildSpineProviders, fileDossierCache } from "../spine/index.js";

export async function fillForegroundCopy(
  slice: { records: BundleRecords; copyRequests: CopyRequest[] },
  copyMode: BundlePlan["copyMode"],
  asOf: string,
  log: (m: string) => void = () => {},
): Promise<void> {
  if (copyMode === "none" || !slice.copyRequests.length) return;
  const provider = copyMode; // static | claude-code | anthropic | auto — all valid CopyProvider choices
  const llm = copyMode !== "static";
  const bundle = { records: slice.records, copyRequests: slice.copyRequests } as NarrativeBundle;
  if (llm) {
    const sr = await authorDossiers(bundle, buildSpineProviders(), { requestedProvider: provider, cache: fileDossierCache(".dataseed/dossiers"), asOf, log });
    log(`spine: authored ${sr.authored} deal(s) via ${sr.provider}${sr.cached ? `, ${sr.cached} cached` : ""}`);
  }
  attachSpineContext(bundle);
  const report = await fillCopy(slice.copyRequests, buildProviders(), { requestedProvider: provider, asOf, gate: llm, log });
  const { applied } = applyCopy(bundle, report.results);
  log(`copy: filled ${report.results.length} foreground body(ies) via ${report.provider}${report.fallbacks ? ` (+${report.fallbacks} static)` : ""}, applied to ${applied} record(s)`);
}
