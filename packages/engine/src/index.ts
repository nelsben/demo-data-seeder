// packages/engine/src/index.ts
//
// @dataseed/engine — the framework-agnostic, TARGET-agnostic generation engine
// (zero React/Fastify imports in the pure stages, zero pack imports). The durable
// asset. M0 shipped the deterministic RNG; M1 adds the op-contract runner + the
// org-introspection probes (CapabilityProfile). Later milestones add plan/generate/
// load behind the NarrativeBundle seam, all driven by a TargetPack handed in at
// runtime. Knows nothing about any specific app.

// Op-contract runner (the composition root calls `run`).
export { run, runOp, coerce } from "./cli/index.js";
export { OPS, findOp } from "./ops/registry.js";
export { EXIT } from "./ops/types.js";
export type { Op, OpContext, OpResult, ArgSpec } from "./ops/types.js";

// Plan + generate (M2 — pure stages behind the NarrativeBundle seam).
export { planBundle } from "./plan/plan.js";
export { generateBundle, generateBundleWithIdentities, buildBundle } from "./generate/generate.js";
export { streamMaterialize, type StreamOptions, type StreamResult, type ScaffoldSlice } from "./generate/stream.js";
export { fillForegroundCopy } from "./generate/fill-foreground.js";

// Introspection (M1).
export { assembleProfile } from "./introspect/profile.js";
export { SfCliClient } from "./introspect/sf-client.js";
export { explainSfFailure, isSfSetupProblem, sfMissingMessage, orgNotAuthedMessage } from "./introspect/sf-errors.js";
export type { SfClient, DescribeResult, DescribeField, LimitRow, RestResponse } from "./introspect/sf-client.js";
export { probeSynthesis } from "./introspect/synthesis.js";
export type { SynthesisSummary, SynthesisProbeResult } from "./introspect/synthesis.js";
export * from "./introspect/probes.js";
export { profileOrgOp, PROFILE_DIR, profilePath, STANDARD_OBJECTS, profileObjects } from "./ops/profile-org.js";
export { planDemoOp } from "./ops/plan-demo.js";
export { fillCopyOp } from "./ops/fill-copy.js";
export { loadDemoOp, LOAD_DIR, loadReportPath } from "./ops/load-demo.js";
export { disperseDemoOp } from "./ops/disperse.js";
export { teardownDemoOp, TEARDOWN_DIR, teardownReportPath } from "./ops/teardown-demo.js";
export { teardownBundle } from "./load/teardown.js";
export type { TeardownReport, ObjectTeardownResult, TeardownOptions } from "./load/teardown.js";

// Registry-backed dataset store + dispersal sinks (the productization spine: addressable
// datasets, generate-once-disperse-many). Re-export the registry contracts so engine
// consumers (ops, server, MCP) have one import root.
export { ENGINE_VERSION, savePlanned, saveFilled, latestDatasetFor } from "./store/bundle-store.js";
export * from "./sinks/index.js";
export { openRegistry, SqliteRegistryStore, DEFAULT_REGISTRY_PATH, datasetId, stackId, buildDataset, recordCounts, canonicalJson } from "@dataseed/registry";
export type { Dataset, DatasetMeta, DatasetStatus, DatasetProvenance, LoadRecord, Stack, DatasetFilter, RegistryStore } from "@dataseed/registry";

// The headless dataset service — the engine's API as plain functions (what the MCP surface wraps).
export { makeDatasetService, ACCOUNT_STATES } from "./service/dataset-service.js";
export type { DatasetService, ServiceDeps, GenerateInput, DisperseInput, RegisterBundleInput, DisperseStackInput, AccountState, SelectAccountsInput, SelectAccountsResult } from "./service/dataset-service.js";

// Copy layer (M5 — fill deferred prose through pluggable CopyProviders).
export { buildProviders, fillCopy, applyCopy, buildEmailPrompt, EMAIL_SYSTEM_PROMPT, StaticCopyProvider, AnthropicCopyProvider } from "./copy/index.js";
export type { FillCopyOptions } from "./copy/orchestrate.js";
export { lintCopy, FORBIDDEN_PHRASES, CROSS_INSTANCE_THRESHOLD, STRUCTURAL_UNIFORMITY_THRESHOLD } from "./copy/voice-lint.js";
export type { LintReport, LintViolation, LintTarget, Severity } from "./copy/voice-lint.js";

// Spine (Phase 4B — Claude authors each foreground deal's dossier narrative, cached by (seed, account)).
export { authorDossiers, buildSpineProviders, StaticSpineProvider, ClaudeCodeSpineProvider, fileDossierCache, memoryDossierCache, parseDraft, SPINE_SYSTEM, buildSpineCliPrompt } from "./spine/index.js";
export type { AuthorDossiersOptions, AuthorDossiersReport, DossierCache } from "./spine/index.js";

// Identity (the single-account protocol — an LLM authors a SYNTHETIC company per unit, cached by (seed, index)).
export { authorIdentities, buildIdentityProviders, StaticIdentityProvider, staticIdentity, ClaudeCodeIdentityProvider, AnthropicIdentityProvider, fileIdentityCache, memoryIdentityCache, parseIdentity, validateIdentity, isLikelySelfProduct, SELF_PRODUCT_RE, IDENTITY_SYSTEM, buildIdentityCliPrompt } from "./identity/index.js";
export type { AuthorIdentitiesOptions, AuthorIdentitiesReport, IdentityCache } from "./identity/index.js";
export { seedAccountOp } from "./ops/seed-account.js";

// Load (M4 — into a real org behind the LoadTarget seam).
export { loadBundle, collectRefs, resolveRecord, filterExisting } from "./load/loader.js";
export type { LoadReport, ObjectLoadResult, LoadOptions, Idempotency } from "./load/loader.js";
export { buildWarehouseSlice } from "./store/warehouse-slice.js";
export type { WarehouseSlice, SliceOpts } from "./store/warehouse-slice.js";
export { JsforceLoadTarget, getAccessInfo, estimateObjectInsertCost, DEFAULT_BULK_THRESHOLD } from "./load/connection.js";
export type { LoadTarget, InsertResult, AccessInfo } from "./load/connection.js";
export { withRetry, isRetryableError } from "./load/retry.js";
export type { RetryOptions } from "./load/retry.js";
export { fileCheckpoint, memoryCheckpoint } from "./load/checkpoint.js";
export type { CheckpointStore, CheckpointState } from "./load/checkpoint.js";

// Re-export the core contracts so engine consumers have one import root.
export * from "@dataseed/core";
