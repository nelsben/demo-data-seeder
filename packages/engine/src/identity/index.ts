// packages/engine/src/identity/index.ts
//
// The identity layer (the single-account protocol's NEW pre-pass): an LLM authors a FULLY SYNTHETIC
// company per foreground unit, cached by (seed, index), which the generator uses in place of a fixed
// real-anchor. `authorIdentities` is the chokepoint; providers are pluggable (claude-code → anthropic →
// static floor). Mirrors the spine layer.

export { authorIdentities, buildIdentityProviders, type AuthorIdentitiesOptions, type AuthorIdentitiesReport } from "./orchestrate.js";
export { StaticIdentityProvider, staticIdentity } from "./static-provider.js";
export { ClaudeCodeIdentityProvider } from "./claude-code-provider.js";
export { AnthropicIdentityProvider } from "./anthropic-provider.js";
export { fileIdentityCache, memoryIdentityCache, type IdentityCache } from "./cache.js";
export { IDENTITY_SYSTEM, identityUserPrompt, buildIdentityCliPrompt } from "./prompt.js";
export { parseIdentity, validateIdentity, isLikelySelfProduct, SELF_PRODUCT_RE } from "./guard.js";
