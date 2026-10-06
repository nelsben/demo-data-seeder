// packages/engine/src/spine/static-provider.ts
//
// StaticSpineProvider — the deterministic, no-LLM tier. Its "draft" IS the skeleton's own authored
// narrative (the 4A static builder already wrote a coherent arc/stances/beats), so authoring is the
// identity and merging it back is a no-op. Exists so the provider set always has a fallback and an
// explicit `--spine static` selection works; the orchestrator short-circuits on `deterministic` anyway.

import type { SpineProvider, SpineRequest, SpineAuthorContext, SpineAuthorOutput, DossierDraft } from "@dataseed/core";

export class StaticSpineProvider implements SpineProvider {
  id = "static";
  deterministic = true;
  available() {
    return true;
  }
  async author(requests: SpineRequest[], _ctx: SpineAuthorContext): Promise<SpineAuthorOutput> {
    const drafts = requests.map((req) => {
      const d = req.dossier;
      const draft: DossierDraft = {
        arc: d.arc,
        castStances: Object.fromEntries(d.cast.map((c) => [c.ref, c.stance ?? ""])),
        beats: Object.fromEntries(d.beats.map((b) => [b.ref, { summary: b.summary, conveys: b.conveys, sentiment: b.sentiment }])),
        signalAims: d.signalAims,
      };
      return { dealKey: req.dealKey, draft };
    });
    return { drafts, estCostUsd: 0, budgetExhausted: false };
  }
}

export default StaticSpineProvider;
