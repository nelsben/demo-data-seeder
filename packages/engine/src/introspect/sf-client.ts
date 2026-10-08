// packages/engine/src/introspect/sf-client.ts
//
// SfClient — the thin Salesforce read surface the introspection probes consume.
// An INTERFACE so probes are unit-testable against recorded fixtures (a mock
// client), with a default implementation that shells the authed `sf` CLI. (The
// architecture's end-state swaps in jsforce in-process behind this same
// interface; M1 ships the CLI impl to stay zero-extra-dep + use existing auth.)
//
// The client is intentionally LOW-LEVEL and may throw; FAIL-OPEN is the probes'
// job (each catches and records a gap), so one failing read never sinks a profile.

import { execFile } from "node:child_process";
import { explainSfFailure } from "./sf-errors.js";

/** A raw describe field (only the bits the probes read). */
export interface DescribeField {
  name: string;
  type: string;
  createable: boolean;
  updateable: boolean;
  nillable: boolean;
  /** Custom (`__c`) field — only these can be a meaningful FLS blocker for a seeder. */
  custom?: boolean;
  /** Formula / roll-up — Salesforce computes it; never caller-supplied. */
  calculated?: boolean;
  /** Auto-number — Salesforce assigns it; never caller-supplied. */
  autoNumber?: boolean;
  /** Has a create-time default — not required from the caller. */
  defaultedOnCreate?: boolean;
  restrictedPicklist?: boolean;
  picklistValues?: Array<{ value: string; active: boolean }>;
}

export interface DescribeResult {
  name: string;
  /** Top-level: can the running user delete rows of this sObject? Absent on an old fixture → treated as unknown by callers. */
  deletable?: boolean;
  fields: DescribeField[];
}

/** One org limit row from `sf org list limits`. */
export interface LimitRow {
  name: string;
  max: number;
  remaining: number;
}

export interface RestResponse {
  ok: boolean; // the CLI exited 0 and a body parsed
  status?: number;
  body: unknown;
}

export interface SfClient {
  readonly org: string;
  /** Run a SOQL query; `tooling` routes to the Tooling API. Returns the records. */
  query<T = Record<string, unknown>>(soql: string, opts?: { tooling?: boolean }): Promise<T[]>;
  /** Org limits as name→{max,remaining}. */
  limits(): Promise<LimitRow[]>;
  /** Describe one sObject (fields, picklists, FLS). */
  describe(sobject: string): Promise<DescribeResult>;
  /** Raw REST GET (for ssot/* Data Cloud endpoints not modeled as sObjects). */
  restGet(path: string): Promise<RestResponse>;
  /**
   * Custom (`__c`) sObject API names present in the org, via `sf sobject list --sobject custom` — how
   * `storage`'s census discovers "every custom object that exists in the org" generically (no
   * hardcoded app object list here; the engine stays domain-agnostic). Excludes Custom Metadata Types
   * (`__mdt` — config, never row-counted "data", also on the purge DENY list) and Platform Events (`__e` —
   * pub/sub, not queryable/countable via SOQL). OPTIONAL: a client without it degrades to standard-objects-only.
   */
  listCustomObjects?(): Promise<string[]>;
}

/** Run `sf` with args, return parsed stdout JSON (or throw with stderr). */
function sfJson(args: string[], timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("sf", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `sf ... --json` prints a JSON envelope even on most failures; prefer parsing it.
      const text = (stdout || "").trim();
      if (text) {
        try {
          return resolve(JSON.parse(text));
        } catch {
          /* fall through to error handling */
        }
      }
      if (err) return reject(new Error(explainSfFailure(err, stderr, `sf ${args.join(" ")} failed: ${stderr || err.message}`)));
      reject(new Error(`sf ${args.join(" ")} produced no parseable output`));
    });
  });
}

interface SfEnvelope<T> {
  status: number;
  result: T;
  message?: string;
}

/** The default SfClient over the authed `sf` CLI. */
export class SfCliClient implements SfClient {
  constructor(public readonly org: string) {}

  async query<T = Record<string, unknown>>(soql: string, opts: { tooling?: boolean } = {}): Promise<T[]> {
    const args = ["data", "query", "-o", this.org, "-q", soql, "--json"];
    if (opts.tooling) args.push("--use-tooling-api");
    const env = (await sfJson(args)) as SfEnvelope<{ records: T[] }>;
    if (env.status !== 0) throw new Error(explainSfFailure(null, env.message, env.message ?? `query failed (status ${env.status})`));
    return env.result?.records ?? [];
  }

  async limits(): Promise<LimitRow[]> {
    const env = (await sfJson(["org", "list", "limits", "-o", this.org, "--json"])) as SfEnvelope<
      Array<{ name: string; max: number; remaining: number }>
    >;
    if (env.status !== 0) throw new Error(explainSfFailure(null, env.message, env.message ?? "limits failed"));
    return env.result ?? [];
  }

  async describe(sobject: string): Promise<DescribeResult> {
    const env = (await sfJson(["sobject", "describe", "-o", this.org, "--sobject", sobject, "--json"])) as SfEnvelope<DescribeResult>;
    if (env.status !== 0) throw new Error(explainSfFailure(null, env.message, env.message ?? `describe ${sobject} failed`));
    return env.result;
  }

  async listCustomObjects(): Promise<string[]> {
    const env = (await sfJson(["sobject", "list", "-o", this.org, "-s", "custom", "--json"])) as SfEnvelope<string[]>;
    if (env.status !== 0) throw new Error(explainSfFailure(null, env.message, env.message ?? "sobject list failed"));
    return (env.result ?? []).filter((n) => n.endsWith("__c"));
  }

  async restGet(path: string): Promise<RestResponse> {
    try {
      // `sf api request rest <path>` prints the raw response body (no --json envelope).
      const raw = await new Promise<string>((resolve, reject) => {
        execFile("sf", ["api", "request", "rest", path, "-o", this.org], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (stdout && stdout.trim()) return resolve(stdout.trim());
          if (err) return reject(new Error(explainSfFailure(err, stderr, stderr || err.message)));
          resolve("");
        });
      });
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw text */
      }
      return { ok: true, body };
    } catch (e) {
      return { ok: false, body: (e as Error).message };
    }
  }
}
