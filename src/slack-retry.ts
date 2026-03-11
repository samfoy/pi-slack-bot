/**
 * Retry helper for Slack API calls with rate limit (429) handling.
 *
 * Detects `WebAPIRateLimitedError` from @slack/web-api and retries
 * with the server-specified `Retry-After` delay or exponential backoff.
 */

/** Check if an error is a Slack rate limit error. */
export function isRateLimitError(err: unknown): err is { retryAfter: number; code: string } {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // @slack/web-api throws WebAPIRateLimitedError with code and retryAfter
  if (e.code === "slack_webapi_rate_limited_error" && typeof e.retryAfter === "number") {
    return true;
  }
  // Fallback: check for ratelimited in data.error (platform error shape)
  if (typeof e.data === "object" && e.data !== null) {
    const data = e.data as Record<string, unknown>;
    if (data.error === "ratelimited") return true;
  }
  return false;
}

/** Extract retry delay in milliseconds from a rate limit error. */
export function getRetryDelayMs(err: unknown, fallbackMs: number): number {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.retryAfter === "number" && e.retryAfter > 0) {
      return e.retryAfter * 1000;
    }
  }
  return fallbackMs;
}

export interface RetryOptions {
  /** Maximum number of retries (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default: 1000). Doubles each retry. */
  initialDelayMs?: number;
  /** Maximum total retry time in ms (default: 10000). Prevents indefinite stalls. */
  maxTotalMs?: number;
  /** Custom sleep function (for testing). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute a Slack API call with automatic retry on rate limit errors.
 *
 * @param fn — The async function to call
 * @param label — Description for logging (e.g. "chat.update")
 * @param opts — Retry configuration
 */
export async function retrySlackCall<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const initialDelayMs = opts?.initialDelayMs ?? 1000;
  const maxTotalMs = opts?.maxTotalMs ?? 10_000;
  const sleep = opts?.sleep ?? defaultSleep;

  let totalWaited = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxRetries) {
        throw err;
      }

      // Calculate delay: use Retry-After if available, otherwise exponential backoff
      const backoff = initialDelayMs * Math.pow(2, attempt);
      let delay = getRetryDelayMs(err, backoff);

      // Clamp to remaining budget
      const remaining = maxTotalMs - totalWaited;
      if (remaining <= 0) {
        throw err; // Budget exhausted
      }
      delay = Math.min(delay, remaining);

      console.warn(
        `[SlackRetry] ${label} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
      );

      await sleep(delay);
      totalWaited += delay;
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`[SlackRetry] ${label} exceeded max retries`);
}
