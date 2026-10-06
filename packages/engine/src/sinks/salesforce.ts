// packages/engine/src/sinks/salesforce.ts
//
// The Salesforce sink — disperse a dataset into a live org through the existing
// bulk loader (additively idempotent, resilient to absent objects / row failures).
// Wraps loadBundle; carries the full LoadReport in `detail`.

import type { TargetPack } from "@dataseed/core";
import { JsforceLoadTarget, type LoadTarget } from "../load/connection.js";
import { loadBundle, type LoadReport } from "../load/loader.js";
import type { DisperseOptions, DisperseReport, Sink } from "./types.js";
import { excludeCascade } from "./cascade.js";
import { fileCheckpoint } from "../load/checkpoint.js";

/** Per-object breakdown lines for a Salesforce LoadReport (shared by load-demo + disperse logging). */
export function formatLoadObjectLines(report: LoadReport): string[] {
  const lines: string[] = [];
  for (const o of report.objects) {
    if (!o.present) {
      lines.push(`  ${o.object}: not in org — skipped ${o.attempted}`);
      continue;
    }
    const drop = o.droppedFields.length ? ` (dropped: ${o.droppedFields.join(", ")})` : "";
    lines.push(`  ${o.object}: +${o.inserted}${o.failed ? ` ✗${o.failed}` : ""}${o.skipped ? ` ⤳${o.skipped} skipped` : ""}${drop}`);
    if (o.errors.length) lines.push(`    e.g. ${o.errors[0]}`);
  }
  return lines;
}

export interface SalesforceSinkDeps {
  /** Resolve a TargetPack by id — datasets carry only the pack id, and a stack may span packs. */
  resolvePack: (packId: string) => TargetPack;
  /** Connect to an org (tests inject a mock LoadTarget). Default: JsforceLoadTarget.create. */
  connect?: (org: string) => Promise<LoadTarget>;
}

export function salesforceSink(deps: SalesforceSinkDeps): Sink {
  return {
    id: "salesforce",
    label: "Salesforce org (jsforce bulk loader)",
    async disperse(dataset, opts: DisperseOptions): Promise<DisperseReport> {
      const org = opts.target;
      if (!org) throw new Error("salesforce sink requires a --target org alias");
      const pack = deps.resolvePack(dataset.pack);
      const target = deps.connect ? await deps.connect(org) : await JsforceLoadTarget.create(org, opts.bulkThreshold != null ? { bulkThreshold: opts.bulkThreshold } : {});
      // cascade: "off" → strip the pack's trigger-firing input streams so the load is purely structural.
      const bundle =
        opts.cascade === "off" ? { ...dataset.bundle, records: excludeCascade(pack, dataset.bundle.records) } : dataset.bundle;
      if (opts.cascade === "off") opts.onProgress?.(`cascade: off — excluded ${(pack.cascadeObjects ?? []).join(", ")} (structural load, no pipeline)`);
      // checkpoint: resume a partially-loaded dataset (crash/rate-kill) instead of re-running from object 1.
      const checkpoint = opts.checkpoint ? fileCheckpoint(opts.checkpoint) : undefined;
      const report = await loadBundle(bundle, pack, target, {
        // force → load everything (no additive-idempotency skip); else skip existing Accounts + subtrees.
        ...(opts.force ? {} : { idempotency: { object: "Account", field: "Name" } }),
        ...(checkpoint ? { checkpoint } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });
      const failed = report.objects.reduce((a, o) => a + o.failed, 0);
      const skipped = report.objects.reduce((a, o) => a + o.skipped, 0);
      return {
        sink: "salesforce",
        target: org,
        ok: failed === 0,
        inserted: report.totalInserted,
        failed,
        skipped,
        summary:
          `loaded ${report.totalInserted} record(s)` +
          (report.idempotencySkipped ? `, skipped ${report.idempotencySkipped} existing` : "") +
          (failed ? `, ${failed} failed` : ""),
        detail: report,
      };
    },
  };
}
