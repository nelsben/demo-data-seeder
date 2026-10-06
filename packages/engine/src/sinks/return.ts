// packages/engine/src/sinks/return.ts
//
// The return sink — disperse by handing the bundle back to the caller, no side
// effect. This is the MCP path: an agent asks for "static data created" and gets
// the records back as structured data to do with as it likes.

import type { DisperseReport, Sink } from "./types.js";
import { totalRecords } from "./types.js";

export function returnSink(): Sink {
  return {
    id: "return",
    label: "Return bundle to caller",
    async disperse(dataset): Promise<DisperseReport> {
      const inserted = totalRecords(dataset);
      return {
        sink: "return",
        target: "(caller)",
        ok: true,
        inserted,
        failed: 0,
        skipped: 0,
        summary: `returned ${inserted} record(s)`,
        detail: dataset.bundle,
      };
    },
  };
}
