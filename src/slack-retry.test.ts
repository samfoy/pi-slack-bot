import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { retrySlackCall, isRateLimitError, getRetryDelayMs } from "./slack-retry.js";

function makeRateLimitError(retryAfter = 1): Error & { code: string; retryAfter: number } {
  const err = new Error("rate limited") as Error & { code: string; retryAfter: number };
  err.code = "slack_webapi_rate_limited_error";
  err.retryAfter = retryAfter;
  return err;
}

function makePlatformRateLimitError(): Error & { data: { error: string } } {
  const err = new Error("ratelimited") as Error & { data: { error: string } };
  (err as any).data = { error: "ratelimited" };
  return err;
}

describe("isRateLimitError", () => {
  it("detects WebAPIRateLimitedError", () => {
    assert.ok(isRateLimitError(makeRateLimitError()));
  });

  it("detects platform ratelimited error", () => {
    assert.ok(isRateLimitError(makePlatformRateLimitError()));
  });

  it("rejects regular errors", () => {
    assert.ok(!isRateLimitError(new Error("network timeout")));
  });

  it("rejects null/undefined", () => {
    assert.ok(!isRateLimitError(null));
    assert.ok(!isRateLimitError(undefined));
  });

  it("rejects non-object", () => {
    assert.ok(!isRateLimitError("string error"));
  });
});

describe("getRetryDelayMs", () => {
  it("extracts retryAfter in milliseconds", () => {
    assert.equal(getRetryDelayMs(makeRateLimitError(3), 1000), 3000);
  });

  it("uses fallback when no retryAfter", () => {
    assert.equal(getRetryDelayMs(new Error("nope"), 2000), 2000);
  });

  it("uses fallback for zero retryAfter", () => {
    const err = makeRateLimitError(0);
    assert.equal(getRetryDelayMs(err, 1500), 1500);
  });
});

describe("retrySlackCall", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await retrySlackCall(fn, "test");
    assert.equal(result, "ok");
    assert.equal(fn.mock.calls.length, 1);
  });

  it("retries on rate limit and succeeds", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw makeRateLimitError(1);
      return "ok";
    });

    const sleepCalls: number[] = [];
    const result = await retrySlackCall(fn, "test", {
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    assert.equal(result, "ok");
    assert.equal(fn.mock.calls.length, 2);
    assert.equal(sleepCalls.length, 1);
    assert.equal(sleepCalls[0], 1000); // retryAfter=1 → 1000ms
  });

  it("uses exponential backoff when no retryAfter", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt <= 2) throw makePlatformRateLimitError();
      return "ok";
    });

    const sleepCalls: number[] = [];
    const result = await retrySlackCall(fn, "test", {
      initialDelayMs: 500,
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    assert.equal(result, "ok");
    assert.equal(fn.mock.calls.length, 3);
    // Backoff: 500 * 2^0 = 500, 500 * 2^1 = 1000
    assert.equal(sleepCalls[0], 500);
    assert.equal(sleepCalls[1], 1000);
  });

  it("throws after max retries exhausted", async () => {
    const fn = vi.fn(async () => {
      throw makeRateLimitError(1);
    });

    await assert.rejects(
      () => retrySlackCall(fn, "test", {
        maxRetries: 2,
        sleep: async () => {},
      }),
      (err: any) => err.code === "slack_webapi_rate_limited_error",
    );

    assert.equal(fn.mock.calls.length, 3); // initial + 2 retries
  });

  it("does not retry non-rate-limit errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network error");
    });

    await assert.rejects(
      () => retrySlackCall(fn, "test", { sleep: async () => {} }),
      (err: any) => err.message === "network error",
    );

    assert.equal(fn.mock.calls.length, 1); // no retry
  });

  it("caps delay to maxTotalMs budget", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw makeRateLimitError(10); // 10s retry-after
      return "ok";
    });

    const sleepCalls: number[] = [];
    const result = await retrySlackCall(fn, "test", {
      maxTotalMs: 5000,
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    assert.equal(result, "ok");
    assert.equal(fn.mock.calls.length, 2);
    // First delay: min(10000, 5000) = 5000 (capped to budget)
    assert.equal(sleepCalls[0], 5000);
  });

  it("throws when total budget exhausted", async () => {
    const fn = vi.fn(async () => {
      throw makeRateLimitError(5); // 5s each
    });

    const sleepCalls: number[] = [];
    await assert.rejects(
      () => retrySlackCall(fn, "test", {
        maxRetries: 3,
        maxTotalMs: 3000,
        sleep: async (ms) => { sleepCalls.push(ms); },
      }),
    );

    // Should have slept once (3000ms), then budget is 0 → throw on next attempt
    assert.equal(sleepCalls.length, 1);
    assert.equal(sleepCalls[0], 3000); // clamped from 5000 to 3000
  });
});
