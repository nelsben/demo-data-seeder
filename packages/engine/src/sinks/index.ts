// packages/engine/src/sinks/index.ts
//
// The sink layer: pluggable dispersal destinations + the disperse-and-record
// chokepoint. `buildSinks` assembles the built-in set keyed by id so a caller can
// resolve a `--sink` choice.

export * from "./types.js";
export { salesforceSink, formatLoadObjectLines, type SalesforceSinkDeps } from "./salesforce.js";
export { fileSink } from "./file.js";
export { returnSink } from "./return.js";
export { disperseDataset } from "./disperse.js";
export { cascadeEstimate, excludeCascade, type CascadeEstimate } from "./cascade.js";

import type { Sink } from "./types.js";
import { salesforceSink, type SalesforceSinkDeps } from "./salesforce.js";
import { fileSink } from "./file.js";
import { returnSink } from "./return.js";

/** The built-in sinks keyed by id (salesforce, file, return). */
export function buildSinks(deps: SalesforceSinkDeps): Map<string, Sink> {
  const sinks = [salesforceSink(deps), fileSink(), returnSink()];
  return new Map(sinks.map((s) => [s.id, s]));
}
