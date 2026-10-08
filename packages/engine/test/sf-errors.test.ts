import { describe, it, expect, vi, beforeEach } from "vitest";

// The two `sf` failures a first-time user hits — CLI missing, alias not logged in — must come back as an
// instruction (pointing at the setup wizard), never as `spawn sf ENOENT` or sf's raw "Parsing --target-org".
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { explainSfFailure, isSfSetupProblem, sfMissingMessage, orgNotAuthedMessage } from "../src/introspect/sf-errors.js";
import { SfCliClient } from "../src/introspect/sf-client.js";
import { getAccessInfo } from "../src/load/connection.js";
import { assembleProfile } from "../src/introspect/profile.js";
import { profileOrgOp } from "../src/ops/profile-org.js";

type ExecFileCb = (err: (Error & { code?: string }) | null, stdout: string, stderr: string) => void;
const enoent = () => Object.assign(new Error("spawn sf ENOENT"), { code: "ENOENT" });
const NOT_AUTHED = "Parsing --target-org \n\tNo authorization information found for ghost-org.\nSee more help with --help";

// execFile is called both as (cmd, args, opts, cb) and (cmd, args, cb) — the callback is always last.
const lastCb = (args: unknown[]) => args[args.length - 1] as ExecFileCb;
function sfIsMissing() {
  execFileMock.mockImplementation((...a: unknown[]) => lastCb(a)(enoent(), "", ""));
}
function aliasNotAuthed() {
  execFileMock.mockImplementation((...a: unknown[]) =>
    lastCb(a)(Object.assign(new Error("exit 1"), { code: "1" }), JSON.stringify({ status: 1, message: NOT_AUTHED }), ""),
  );
}

beforeEach(() => {
  execFileMock.mockReset(); // braces matter: a function RETURNED from beforeEach is run as a cleanup hook
});

describe("explainSfFailure", () => {
  it("turns ENOENT into an install instruction that points at the setup wizard", () => {
    const msg = explainSfFailure(enoent(), "");
    expect(msg).toBe(sfMissingMessage());
    expect(msg).toContain("node bin/setup.js");
    expect(msg).not.toContain("ENOENT");
  });

  it("turns sf's 'No authorization information' into a login instruction naming the alias", () => {
    const msg = explainSfFailure(null, NOT_AUTHED);
    expect(msg).toBe(orgNotAuthedMessage("ghost-org"));
    expect(msg).toContain("sf org login web --alias ghost-org");
    expect(msg).not.toContain("Parsing --target-org");
  });

  it("passes any other failure through untouched (fallback first, then sf's own text)", () => {
    expect(explainSfFailure(null, "INVALID_FIELD: No such column", "query failed")).toBe("query failed");
    expect(explainSfFailure(null, "INVALID_FIELD: No such column")).toBe("INVALID_FIELD: No such column");
  });

  it("isSfSetupProblem recognizes both messages, even behind a probe prefix, and nothing else", () => {
    expect(isSfSetupProblem(`limits: ${sfMissingMessage()}`)).toBe(true);
    expect(isSfSetupProblem(`orgInfo: ${orgNotAuthedMessage("x")}`)).toBe(true);
    expect(isSfSetupProblem("licensing: INVALID_TYPE: sObject type 'PermissionSetLicense' is not supported")).toBe(false);
  });
});

describe("SfCliClient + getAccessInfo surface the friendly messages", () => {
  it("query() with sf missing → install instruction", async () => {
    sfIsMissing();
    await expect(new SfCliClient("demo-org").query("SELECT Id FROM Account")).rejects.toThrow(sfMissingMessage());
  });

  it("limits() with an unauthenticated alias → login instruction", async () => {
    aliasNotAuthed();
    await expect(new SfCliClient("ghost-org").limits()).rejects.toThrow('Org "ghost-org" isn\'t authenticated');
  });

  it("restGet() with sf missing reports the instruction in its fail-soft body", async () => {
    sfIsMissing();
    const r = await new SfCliClient("demo-org").restGet("/services/data");
    expect(r.ok).toBe(false);
    expect(r.body).toBe(sfMissingMessage());
  });

  it("getAccessInfo() with sf missing → install instruction (was: an EMPTY error message)", async () => {
    sfIsMissing();
    await expect(getAccessInfo("demo-org")).rejects.toThrow(sfMissingMessage());
  });

  it("getAccessInfo() with an unauthenticated alias → login instruction", async () => {
    aliasNotAuthed();
    await expect(getAccessInfo("ghost-org")).rejects.toThrow("sf org login web --alias ghost-org");
  });
});

describe("profile-org refuses to write a profile of an org it never reached", () => {
  it("the probes record the setup problem as a gap (fail-open)", async () => {
    sfIsMissing();
    const profile = await assembleProfile(new SfCliClient("demo-org"), { objects: ["Account"], capturedAt: "2026-10-08T00:00:00.000Z" });
    expect(profile.gaps.some(isSfSetupProblem)).toBe(true);
  });

  it("run() throws the instruction instead of reporting [ok]", async () => {
    aliasNotAuthed();
    const ctx = { log: () => {}, packs: { get: () => { throw new Error("no pack"); } } } as unknown as Parameters<typeof profileOrgOp.run>[1];
    await expect(profileOrgOp.run({ org: "ghost-org" } as Parameters<typeof profileOrgOp.run>[0], ctx)).rejects.toThrow(
      "sf org login web --alias ghost-org",
    );
  });
});
