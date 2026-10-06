// packages/engine/src/sinks/file.ts
//
// The file sink — write a dataset's bundle to a JSON file. For fixtures, diffing,
// or handing a generated dataset to another tool/agent that ingests JSON.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DisperseOptions, DisperseReport, Sink } from "./types.js";
import { totalRecords } from "./types.js";

export function fileSink(): Sink {
  return {
    id: "file",
    label: "JSON file export",
    async disperse(dataset, opts: DisperseOptions): Promise<DisperseReport> {
      const path = opts.target;
      if (!path) throw new Error("file sink requires a --target file path");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(dataset.bundle, null, 2) + "\n");
      const inserted = totalRecords(dataset);
      return {
        sink: "file",
        target: path,
        ok: true,
        inserted,
        failed: 0,
        skipped: 0,
        summary: `wrote ${inserted} record(s) to ${path}`,
        detail: { path, records: inserted },
      };
    },
  };
}
