/**
 * Tests for `monotonicMs` (Plan v3 §1.2c — shared clock helper for
 * suspended-laptop-safe latency math, used by TelegramChannel.restart()
 * and the IMPL-W2-G2 daemon watchdog).
 *
 * The implementation wraps `process.hrtime.bigint()` divided down to
 * milliseconds. Properties under test:
 *   1. returns a finite, non-negative integer
 *   2. monotonically non-decreasing across rapid successive calls
 *   3. immune to wall-clock skew (vi.setSystemTime moves Date.now but
 *      MUST NOT move monotonicMs — proves we're not aliased to Date.now)
 */

import { describe, expect, test, vi } from "vitest";

import { monotonicMs } from "../../src/lib/clock.js";

describe("monotonicMs", () => {
  test("returns a non-negative finite integer", () => {
    const t = monotonicMs();
    expect(Number.isFinite(t)).toBe(true);
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
  });

  test("monotonically non-decreasing across successive calls", () => {
    const a = monotonicMs();
    const b = monotonicMs();
    const c = monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });

  test("immune to wall-clock skew (NOT aliased to Date.now)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
      const before = monotonicMs();
      // Skew Date.now far backwards. monotonicMs should not move
      // backwards in response.
      vi.setSystemTime(new Date("1990-01-01T00:00:00Z"));
      const after = monotonicMs();
      expect(after).toBeGreaterThanOrEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
