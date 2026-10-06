import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock `node:child_process` BEFORE importing connection.ts (its top-level `execFile` import binds to
// this mock) — `vi.mock` calls are hoisted above imports, so the spy itself must be created via
// `vi.hoisted` (a bare top-level `const` referenced inside the factory throws vitest's hoisting error).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { getAccessInfo } from "../src/load/connection.js";

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockSfOrgDisplay(result: Record<string, unknown> | null, status = 0) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecFileCb) => {
    cb(null, JSON.stringify({ status, result }), "");
  });
}

describe("getAccessInfo — sf issue #94 (accessToken redaction)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("sets SF_TEMP_SHOW_SECRETS=true in the child process env on every call", async () => {
    mockSfOrgDisplay({ accessToken: "00Dxx!realtoken", instanceUrl: "https://example.my.salesforce.com", apiVersion: "62.0" });
    await getAccessInfo("dev-frontend");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , opts] = execFileMock.mock.calls[0]!;
    expect((opts as { env: Record<string, string> }).env.SF_TEMP_SHOW_SECRETS).toBe("true");
  });

  it("resolves normally when accessToken is a real (non-redacted) value", async () => {
    mockSfOrgDisplay({ accessToken: "00Dxx!realtoken", instanceUrl: "https://example.my.salesforce.com", apiVersion: "62.0" });
    const info = await getAccessInfo("dev-frontend");
    expect(info.accessToken).toBe("00Dxx!realtoken");
    expect(info.instanceUrl).toBe("https://example.my.salesforce.com");
  });

  it("fails fast with the #94 message when accessToken comes back REDACTED — even with the env var set", async () => {
    mockSfOrgDisplay({ accessToken: "[REDACTED, use --json or sf config get]", instanceUrl: "https://example.my.salesforce.com", apiVersion: "62.0" });
    await expect(getAccessInfo("dev-frontend")).rejects.toThrow(/REDACTED accessToken \(sf issue #94\)/);
  });

  it("never includes the raw token value in the thrown error's message", async () => {
    mockSfOrgDisplay({ accessToken: "[REDACTED, use --json or sf config get]", instanceUrl: "https://example.my.salesforce.com", apiVersion: "62.0" });
    let caught: Error | undefined;
    try {
      await getAccessInfo("dev-frontend");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain("[REDACTED, use --json or sf config get]");
  });

  it("surfaces the sf CLI's own failure message when the org isn't authenticated at all", async () => {
    mockSfOrgDisplay(null, 1);
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecFileCb) => {
      cb(null, JSON.stringify({ status: 1, message: "No authorization information found for dev-frontend." }), "");
    });
    await expect(getAccessInfo("dev-frontend")).rejects.toThrow(/No authorization information/);
  });
});
