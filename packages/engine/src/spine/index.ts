// packages/engine/src/spine/index.ts
//
// The spine layer (Phase 4B): author a deal's dossier NARRATIVE with an LLM over the deterministic
// 4A skeleton, cached by (seed, account). `authorDossiers` is the chokepoint; providers are pluggable.

export { authorDossiers, buildSpineProviders, type AuthorDossiersOptions, type AuthorDossiersReport } from "./orchestrate.js";
export { StaticSpineProvider } from "./static-provider.js";
export { ClaudeCodeSpineProvider, parseDraft } from "./claude-code-provider.js";
export { fileDossierCache, memoryDossierCache, type DossierCache } from "./cache.js";
export { SPINE_SYSTEM, spineUserPrompt, buildSpineCliPrompt } from "./prompt.js";
