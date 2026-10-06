// packages/engine/src/ops/types.ts
//
// The locked op-contract (parity with sf-setup-bridge): every op is
// {id, name, description, prerequisites, affects, idempotent, args, check, run,
// verify} with exit codes 0/3/4/5. Promoted to TS; the CLI (cli/index.ts), the
// Fastify routes (later), and any MCP tool all drive ops through `runOp`.

/** Exit-code contract (kept aligned with sf-setup-bridge). */
export const EXIT = {
  OK: 0,
  RE_AUTH_NEEDED: 2, // reserved
  ARG_INVALID: 3,
  VERIFY_FAILED: 4,
  UNCAUGHT: 5,
} as const;

/** One declared arg in an op's schema. */
export interface ArgSpec {
  type: "string" | "number" | "boolean" | "array";
  required?: boolean;
  default?: unknown;
  enum?: readonly string[];
  description?: string;
}

import type { PackRegistry } from "@dataseed/core";

/** The run context threaded to check/run/verify (grown as layers land: conn, rng, cache, llm…). */
export interface OpContext {
  /** Effective target-org alias. */
  targetOrg: string | null;
  /** The pack registry built by the composition root (the engine never imports a pack). */
  packs: PackRegistry;
  /** Scoped logger (op id prefixed). */
  log: (...args: unknown[]) => void;
}

export interface CheckResult {
  alreadyDone?: boolean;
  [k: string]: unknown;
}
export interface VerifyResult {
  success?: boolean;
  [k: string]: unknown;
}

/** An op. Args is a loose record (validated against `args` before check). */
export interface Op<A extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  prerequisites?: string[];
  affects?: string[];
  idempotent?: boolean;
  args: Record<string, ArgSpec>;
  check(args: A, ctx: OpContext): Promise<CheckResult> | CheckResult;
  run(args: A, ctx: OpContext): Promise<void> | void;
  verify(args: A, ctx: OpContext): Promise<VerifyResult> | VerifyResult;
}

export type OpResultStatus =
  | "completed"
  | "skipped_already_done"
  | "verify_failed"
  | "arg_invalid"
  | "error";

export interface OpResult {
  op: string;
  status: OpResultStatus;
  args?: Record<string, unknown>;
  before?: CheckResult;
  after?: VerifyResult;
  errors?: string[];
  error?: { message: string; stack?: string };
  durationMs: number;
  _exitCode: number;
}
