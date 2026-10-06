// packages/engine/src/sinks/disperse.ts
//
// Disperse-and-record: run a dataset through a sink and append the dispersal to
// its registry load-history. The single chokepoint every caller (op, server, MCP)
// goes through, so every dispersal is auditable ("this dataset went to org X + a
// file Y") without bloating the registry.

import type { Dataset, RegistryStore } from "@dataseed/registry";
import type { DisperseOptions, DisperseReport, Sink } from "./types.js";

export async function disperseDataset(
  store: RegistryStore,
  dataset: Dataset,
  sink: Sink,
  opts: DisperseOptions & { now: string },
): Promise<DisperseReport> {
  const report = await sink.disperse(dataset, opts);
  store.recordLoad({
    datasetId: dataset.id,
    sink: report.sink,
    target: report.target,
    at: opts.now,
    inserted: report.inserted,
    failed: report.failed,
    // Keep history lightweight — the summary, not the heavy detail (e.g. the whole bundle for `return`).
    report: { ok: report.ok, skipped: report.skipped, summary: report.summary },
  });
  return report;
}
