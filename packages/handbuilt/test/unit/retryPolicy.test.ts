import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  backoffCeilingMs,
  backoffDelayMs,
  decideRetry,
  validateRetryPolicy,
  type RetryPolicy,
} from "../../src/domain/retryPolicy.js";

const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
const retryable = { message: "HTTP 500", retryable: true };

describe("retry policy", () => {
  it("doubles the ceiling per attempt and caps it", () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffCeilingMs(policy, a))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it("does not overflow for absurd attempt numbers", () => {
    expect(backoffCeilingMs(policy, 10_000)).toBe(1_000);
  });

  it("applies full jitter within [0, ceiling)", () => {
    expect(backoffDelayMs(policy, 3, () => 0)).toBe(0);
    expect(backoffDelayMs(policy, 3, () => 0.5)).toBe(200);
    expect(backoffDelayMs(policy, 3, () => 0.999_999)).toBe(399);
    for (let i = 0; i < 1_000; i++) {
      const d = backoffDelayMs(policy, 4);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(800);
    }
  });

  it("retries until maxAttempts, then dead-letters with a reason", () => {
    for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
      expect(decideRetry(policy, attempt, retryable, () => 0.5).kind).toBe("retry");
    }
    const final = decideRetry(policy, policy.maxAttempts, retryable);
    expect(final).toEqual({ kind: "dead-letter", reason: "exhausted 5 attempts: HTTP 500" });
  });

  it("dead-letters non-retryable errors immediately", () => {
    const d = decideRetry(policy, 1, { message: "card declined", retryable: false });
    expect(d).toEqual({ kind: "dead-letter", reason: "non-retryable: card declined" });
  });

  it("rejects nonsensical policies", () => {
    expect(() => validateRetryPolicy({ ...policy, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...policy, maxDelayMs: 10 })).toThrow(RangeError);
    expect(validateRetryPolicy(DEFAULT_RETRY_POLICY)).toBe(DEFAULT_RETRY_POLICY);
  });

  it("default policy waits about 15.5s worst case before giving up", () => {
    // Sum of ceilings between the 6 attempts: 0.5 + 1 + 2 + 4 + 8 = 15.5s.
    let total = 0;
    for (let a = 1; a < DEFAULT_RETRY_POLICY.maxAttempts; a++) {
      total += backoffCeilingMs(DEFAULT_RETRY_POLICY, a);
    }
    expect(total).toBe(15_500);
  });
});
