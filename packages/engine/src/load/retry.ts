// packages/engine/src/load/retry.ts
//
// Exponential-backoff retry for org mutations. At high volume a load WILL hit transient
// failures — REQUEST_LIMIT_EXCEEDED, row-lock contention, a dropped socket, a 503. Without
// retry, one blip on batch 800/1000 throws and the tail is lost. withRetry retries only
// RETRYABLE errors (rate/transport — never a real data error like DUPLICATE_VALUE) with
// capped exponential backoff. The sleep is injectable so tests run instantly.

/** Salesforce/transport errors that are worth retrying (vs. a permanent data/schema error). */
const RETRYABLE = /REQUEST_LIMIT_EXCEEDED|UNABLE_TO_LOCK_ROW|SERVER_UNAVAILABLE|ServiceUnavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:429|500|502|503|504)\b/i;

export function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return RETRYABLE.test(msg);
}

export interface RetryOptions {
  /** Max retries AFTER the first attempt (default 4 → up to 5 tries). */
  retries?: number;
  /** First backoff delay in ms (default 1000); doubles each retry, capped at maxMs. */
  baseMs?: number;
  /** Backoff ceiling in ms (default 30000). */
  maxMs?: number;
  /** Classify an error as retryable (default: rate/transport errors above). */
  isRetryable?: (e: unknown) => boolean;
  /** Observe each retry (attempt is 1-based; delayMs is the wait before it). */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Injectable sleep (default setTimeout) — tests pass a no-op to run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying retryable failures with capped exponential backoff. Non-retryable errors throw at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 1_000;
  const maxMs = opts.maxMs ?? 30_000;
  const retryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt);
      opts.onRetry?.(attempt + 1, delay, e);
      await sleep(delay);
      attempt += 1;
    }
  }
}
