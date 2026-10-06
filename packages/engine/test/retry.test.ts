import { describe, it, expect } from "vitest";
import { withRetry, isRetryableError } from "../src/load/retry.js";

const noSleep = async () => {}; // run instantly — no real backoff waits in tests

describe("withRetry", () => {
  it("returns immediately on success (no retry)", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        return 42;
      },
      { sleep: noSleep },
    );
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries retryable errors with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("REQUEST_LIMIT_EXCEEDED: too many");
        return "ok";
      },
      { sleep: noSleep, baseMs: 100, onRetry: (_a, d) => delays.push(d) },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // doubles each retry
  });

  it("does NOT retry a non-retryable (real data) error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("DUPLICATE_VALUE: dupe");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/DUPLICATE_VALUE/);
    expect(calls).toBe(1); // failed once, threw at once
  });

  it("gives up after `retries` and throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("503 Service Unavailable");
        },
        { sleep: noSleep, retries: 2 },
      ),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("caps the backoff delay at maxMs", async () => {
    const delays: number[] = [];
    await withRetry(
      async () => {
        if (delays.length < 4) throw new Error("ECONNRESET");
        return 1;
      },
      { sleep: noSleep, baseMs: 1000, maxMs: 3000, retries: 10, onRetry: (_a, d) => delays.push(d) },
    );
    expect(delays).toEqual([1000, 2000, 3000, 3000]); // 4000/8000 clamped to the 3000 ceiling
  });

  it("classifies rate/transport errors as retryable, data/schema errors as not", () => {
    expect(isRetryableError(new Error("UNABLE_TO_LOCK_ROW"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("INVALID_FIELD: no such column"))).toBe(false);
    expect(isRetryableError(new Error("REQUIRED_FIELD_MISSING"))).toBe(false);
  });
});
