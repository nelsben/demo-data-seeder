// packages/engine/src/introspect/synthesis.ts
//
// probeSynthesis — read back the records the TARGET PIPELINE derived from the seeded
// inputs (e.g. signals, briefs, account summaries the target app derives). This is how the app
// verifies SYNTHESIS, not just the load: a load report says records landed; this says the
// live pipeline turned them into outputs. The cascade is async, so counts climb after a
// load — the UI re-polls. Generic: the pack declares its synthesisView; the engine just
// counts + samples. Each probe is independent and fail-soft (an absent object ⇒ present:false).

import type { SfClient } from "./sf-client.js";
import type { TargetPack } from "@dataseed/core";

export interface SynthesisProbeResult {
  object: string;
  label: string;
  /** Did the object resolve (exists + queryable)? */
  present: boolean;
  count: number;
  /** A sample value of the probe's sampleField (most-recent record), if any. */
  sample?: string | null;
}

export interface SynthesisSummary {
  org: string;
  pack: string;
  /** False when the pack declares no synthesisView (nothing to verify). */
  supported: boolean;
  /** Seeded INPUT records that drive the pipeline (Accounts, Opps, EmailMessages, Tasks, line items). */
  inputs: SynthesisProbeResult[];
  /** Records the pipeline DERIVED from those inputs (signals, briefs, profiles, …). */
  probes: SynthesisProbeResult[];
  total: number;
}

/** Count (+ optionally sample) each probe object, independently and fail-soft. */
async function probeObjects(
  client: SfClient,
  probes: ReadonlyArray<{ object: string; label: string; sampleField?: string }>,
): Promise<SynthesisProbeResult[]> {
  const out: SynthesisProbeResult[] = [];
  for (const p of probes) {
    try {
      const rows = await client.query<{ c: number }>(`SELECT COUNT(Id) c FROM ${p.object}`);
      const count = Number(rows[0]?.c ?? 0);
      let sample: string | null = null;
      if (p.sampleField && count > 0) {
        const sr = await client.query<Record<string, unknown>>(
          `SELECT ${p.sampleField} FROM ${p.object} ORDER BY CreatedDate DESC LIMIT 1`,
        );
        const v = sr[0]?.[p.sampleField];
        sample = v == null ? null : String(v);
      }
      out.push({ object: p.object, label: p.label, present: true, count, sample });
    } catch {
      // Object absent (the target app is not installed) or not queryable — report it, don't fail the batch.
      out.push({ object: p.object, label: p.label, present: false, count: 0 });
    }
  }
  return out;
}

export async function probeSynthesis(client: SfClient, pack: TargetPack, org: string): Promise<SynthesisSummary> {
  const view = pack.synthesisView;
  if (!view || view.probes.length === 0) {
    return { org, pack: pack.id, supported: false, inputs: [], probes: [], total: 0 };
  }

  // Probe the seeded inputs (did the load land?) AND the derived outputs (did the pipeline run?) —
  // together they show the whole chain on the Verify screen, inputs → outputs.
  const inputs = pack.inputView ? await probeObjects(client, pack.inputView.probes) : [];
  const probes = await probeObjects(client, view.probes);

  return { org, pack: pack.id, supported: true, inputs, probes, total: probes.reduce((a, r) => a + r.count, 0) };
}
