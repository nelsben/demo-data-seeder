// packages/core/src/index.ts
//
// @dataseed/core — the domain-agnostic contracts for the data-testing app: the
// generic run params, the org-capability profile, the NarrativeBundle seam, and
// the TargetPack plug-in interface. Knows nothing about any specific app or
// target. The engine and every pack import from here; packs are what make it
// concrete.

export * from "./scope-params.js";
export * from "./capability-profile.js";
export * from "./standard-profile.js";
export * from "./bundle.js";
export * from "./dossier.js";
export * from "./spine.js";
export * from "./identity.js";
export * from "./copy.js";
export * from "./pack.js";
// Deterministic sampling — a core contract because BOTH the engine and every pack
// need reproducible draws, and packs depend only on core.
export * from "./rng.js";
export * from "./sample.js";

// Size resolver — turn any caller's sizing unit (accounts/records/storage%) into a bulk `population`.
export * from "./sizing.js";
