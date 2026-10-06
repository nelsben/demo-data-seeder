// packages/engine/src/cli/index.ts
//
// The op-runner CLI (ported from the JS run-op.js skeleton to TS). Drives ops
// through the locked lifecycle: validate args → check → [skip if alreadyDone] →
// run → verify → structured result. Reachable as `dataseed <verb>` (the root
// run-op.js shim registers tsx and imports this).
//
//   dataseed list [--json]
//   dataseed run <id> [--<arg> v]   |   run <id> --help   |   run <id> --json
//   dataseed help

import type { PackRegistry } from "@dataseed/core";
import { EXIT, type ArgSpec, type Op, type OpContext, type OpResult } from "../ops/types.js";
import { OPS, findOp } from "../ops/registry.js";

const camel = (kebab: string) => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.includes(",")) return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value); // integers AND decimals (e.g. --bulkDensity 0.6)
  return value;
}

interface ParsedArgs {
  flags: Record<string, boolean>;
  args: Record<string, unknown>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const key = camel(tok.slice(2));
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        args[key] = coerce(next);
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { flags, args, positionals };
}

function validateArgs(schema: Record<string, ArgSpec>, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    const value = args[name];
    if (spec.required && (value === undefined || value === null || value === "")) {
      errors.push(`missing required arg: --${kebab(name)}`);
      continue;
    }
    if (value === undefined) continue;
    if (spec.enum && !spec.enum.includes(value as string)) {
      errors.push(`--${kebab(name)} must be one of ${spec.enum.join(", ")} (got "${String(value)}")`);
    }
    if (spec.type === "array" && !Array.isArray(value)) {
      errors.push(`--${kebab(name)} must be a comma-separated list`);
    }
  }
  return errors;
}

function applyDefaults(schema: Record<string, ArgSpec>, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const [name, spec] of Object.entries(schema)) {
    if (out[name] === undefined && spec.default !== undefined) out[name] = spec.default;
  }
  return out;
}

async function runOp(op: Op, rawArgs: Record<string, unknown>, packs: PackRegistry): Promise<OpResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const argErrors = validateArgs(op.args ?? {}, rawArgs);
  if (argErrors.length) {
    return { op: op.id, status: "arg_invalid", errors: argErrors, durationMs: elapsed(), _exitCode: EXIT.ARG_INVALID };
  }
  const args = applyDefaults(op.args ?? {}, rawArgs);

  const ctx: OpContext = {
    targetOrg: (args.org as string) ?? (args.targetOrg as string) ?? process.env.SF_TARGET_ORG ?? null,
    packs,
    log: (...a) => console.log(`  [${op.id}]`, ...a),
  };

  try {
    const before = (await op.check(args, ctx)) ?? {};
    if (op.idempotent && before.alreadyDone) {
      return { op: op.id, status: "skipped_already_done", args, before, after: before, durationMs: elapsed(), _exitCode: EXIT.OK };
    }
    await op.run(args, ctx);
    const after = (await op.verify(args, ctx)) ?? {};
    if (after.success === false) {
      return { op: op.id, status: "verify_failed", args, before, after, durationMs: elapsed(), _exitCode: EXIT.VERIFY_FAILED };
    }
    return { op: op.id, status: "completed", args, before, after, durationMs: elapsed(), _exitCode: EXIT.OK };
  } catch (err) {
    const e = err as Error;
    return {
      op: op.id,
      status: "error",
      args,
      error: { message: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") },
      durationMs: elapsed(),
      _exitCode: EXIT.UNCAUGHT,
    };
  }
}

function formatResult(result: OpResult): string {
  const icon =
    ({ completed: "[ok]", skipped_already_done: "[skip]", verify_failed: "[verify-failed]", error: "[error]", arg_invalid: "[bad-args]" } as Record<string, string>)[
      result.status
    ] ?? "[?]";
  const lines = [`${icon} ${result.op} — ${result.status} (${result.durationMs}ms)`];
  result.errors?.forEach((e) => lines.push(`  - ${e}`));
  if (result.error) lines.push(`  ${result.error.message}`);
  if (result.status === "skipped_already_done") {
    lines.push(`  current state: ${JSON.stringify(result.before)}`);
  } else {
    if (result.before && Object.keys(result.before).length) lines.push(`  before: ${JSON.stringify(result.before)}`);
    if (result.after && Object.keys(result.after).length) lines.push(`  after:  ${JSON.stringify(result.after)}`);
  }
  return lines.join("\n");
}

function catalogRow(op: Op) {
  return {
    id: op.id,
    name: op.name,
    description: op.description,
    idempotent: !!op.idempotent,
    prerequisites: op.prerequisites ?? [],
    affects: op.affects ?? [],
    args: op.args ?? {},
  };
}

function cmdList(wantsJson: boolean): number {
  if (wantsJson) {
    console.log(JSON.stringify({ ops: OPS.map(catalogRow) }, null, 2));
    return EXIT.OK;
  }
  console.log("Available operations:\n");
  for (const op of OPS) {
    const c = catalogRow(op);
    console.log(`  ${c.id}${c.idempotent ? "  (idempotent)" : ""}`);
    console.log(`    ${c.name} — ${c.description}`);
    const argNames = Object.keys(c.args);
    if (argNames.length) console.log(`    args: ${argNames.map(kebab).map((n) => `--${n}`).join(", ")}`);
    console.log("");
  }
  console.log("Run one with: dataseed run <id> [--<arg> <value> ...]");
  return EXIT.OK;
}

function printOpHelp(op: Op, wantsJson: boolean): void {
  const c = catalogRow(op);
  if (wantsJson) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }
  console.log(`${c.id} — ${c.name}\n`);
  console.log(c.description + "\n");
  console.log(`Idempotent: ${c.idempotent}`);
  if (c.prerequisites.length) {
    console.log("Prerequisites:");
    c.prerequisites.forEach((p) => console.log(`  - ${p}`));
  }
  if (c.affects.length) {
    console.log("Affects:");
    c.affects.forEach((a) => console.log(`  - ${a}`));
  }
  const argEntries = Object.entries(c.args);
  if (argEntries.length) {
    console.log("Args:");
    for (const [name, spec] of argEntries) {
      const req = spec.required ? " (required)" : "";
      const def = spec.default !== undefined ? ` [default: ${JSON.stringify(spec.default)}]` : "";
      const enm = spec.enum ? ` (one of: ${spec.enum.join(", ")})` : "";
      console.log(`  --${kebab(name)}${req}${def}${enm}`);
      if (spec.description) console.log(`      ${spec.description}`);
    }
  }
}

function printUsage(): void {
  console.log(
    [
      "dataseed — Salesforce data-testing op runner",
      "",
      "Usage:",
      "  dataseed list [--json]            List available ops",
      "  dataseed run <id> [--<arg> v]     Run one op (check -> run -> verify)",
      "  dataseed run <id> --help          Show one op's args / prereqs / affects",
      "  dataseed run <id> --json          Machine-readable run result",
      "",
      "Exit codes: 0 ok/skipped · 3 bad args · 4 verify failed · 5 uncaught error",
    ].join("\n"),
  );
}

export async function run(argv: string[], packs: PackRegistry): Promise<number> {
  const { flags, args, positionals } = parseArgs(argv);
  const verb = positionals[0];
  const wantsJson = !!flags.json;

  if (!verb || verb === "help") {
    printUsage();
    return EXIT.OK;
  }
  if (verb === "list") return cmdList(wantsJson);

  if (verb === "run") {
    const opId = positionals[1];
    if (!opId) {
      console.error("Usage: dataseed run <id> [--<arg> <value> ...]");
      return EXIT.ARG_INVALID;
    }
    const op = findOp(opId);
    if (!op) {
      console.error(`Unknown op: ${opId}`);
      console.error(`Available: ${OPS.map((o) => o.id).join(", ") || "(none)"}`);
      return EXIT.ARG_INVALID;
    }
    if (flags.help) {
      printOpHelp(op, wantsJson);
      return EXIT.OK;
    }
    // Bare boolean flags (`--yes`, `--force`) parse into `flags`; merge them into the
    // op's args so schema-declared booleans take effect (value args win on conflict).
    // `json`/`help` are CLI-level and ignored by every op schema.
    const opArgs = { ...flags, ...args };
    const result = await runOp(op, opArgs, packs);
    if (wantsJson) {
      const { _exitCode, ...payload } = result;
      void _exitCode;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(formatResult(result));
    }
    return result._exitCode;
  }

  console.error(`Unknown command: ${verb}`);
  printUsage();
  return EXIT.ARG_INVALID;
}

export { runOp };
