/**
 * TokenBucket primitive — unit tests.
 *
 * Coverage:
 *   1. Starts full at `capacity`.
 *   2. Each `tryConsume` removes one token; returns false when empty.
 *   3. Refill is computed lazily from elapsed time; rate is honored
 *      to within float precision.
 *   4. Refill caps at `capacity` (no over-fill).
 *   5. `reset()` restores to capacity.
 *   6. Negative-elapsed (clock went backwards) is treated as zero refill.
 *   7. Constructor input validation: rejects non-positive capacity, rejects
 *      negative refillRatePerMs.
 *   8. `available()` reflects refill without consuming.
 */

import { describe, expect, test } from "vitest";
import { TokenBucket } from "../src/lib/rate-limit.js";

function makeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
  setTo: (t: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    setTo: (target) => {
      t = target;
    },
  };
}

describe("TokenBucket — basic semantics", () => {
  test("starts full at capacity", () => {
    const clock = makeClock();
    const b = new TokenBucket({ capacity: 5, refillRatePerMs: 0, now: clock.now });
    expect(b.available()).toBe(5);
  });

  test("each tryConsume removes one token; returns false when empty", () => {
    const clock = makeClock();
    const b = new TokenBucket({ capacity: 3, refillRatePerMs: 0, now: clock.now });
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false); // empty
    expect(b.tryConsume()).toBe(false);
  });
});

describe("TokenBucket — refill", () => {
  test("refill restores tokens at the configured rate", () => {
    const clock = makeClock();
    // 10 tokens / 60s => 10 / 60_000 per ms
    const b = new TokenBucket({
      capacity: 10,
      refillRatePerMs: 10 / 60_000,
      now: clock.now,
    });
    // drain
    for (let i = 0; i < 10; i++) {
      expect(b.tryConsume()).toBe(true);
    }
    expect(b.tryConsume()).toBe(false);

    // 6 seconds = 1 token refilled
    clock.advance(6_000);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);

    // 60s = 10 tokens refilled (full)
    clock.advance(60_000);
    expect(b.available()).toBeCloseTo(10, 5);
  });

  test("refill caps at capacity (no over-fill)", () => {
    const clock = makeClock();
    const b = new TokenBucket({
      capacity: 5,
      refillRatePerMs: 1,
      now: clock.now,
    });
    // already full; advance a long time
    clock.advance(1_000_000);
    expect(b.available()).toBe(5);
  });

  test("clock going backwards is treated as zero refill (no surge)", () => {
    const clock = makeClock();
    const b = new TokenBucket({
      capacity: 5,
      refillRatePerMs: 1 / 1000,
      now: clock.now,
    });
    b.tryConsume();
    b.tryConsume();
    b.tryConsume();
    expect(b.available()).toBe(2);
    // Walk the clock backwards by an hour.
    clock.setTo(clock.now() - 60 * 60 * 1000);
    // Bucket should not gain tokens — it's still at 2.
    expect(b.available()).toBe(2);
  });
});

describe("TokenBucket — reset", () => {
  test("reset restores to full capacity at the current time", () => {
    const clock = makeClock();
    const b = new TokenBucket({
      capacity: 4,
      refillRatePerMs: 0,
      now: clock.now,
    });
    b.tryConsume();
    b.tryConsume();
    b.tryConsume();
    expect(b.available()).toBe(1);
    b.reset();
    expect(b.available()).toBe(4);
  });
});

describe("TokenBucket — constructor validation", () => {
  test("rejects non-positive capacity", () => {
    expect(() => new TokenBucket({ capacity: 0, refillRatePerMs: 1 })).toThrow(
      /capacity/,
    );
    expect(() => new TokenBucket({ capacity: -1, refillRatePerMs: 1 })).toThrow(
      /capacity/,
    );
    expect(
      () =>
        new TokenBucket({
          capacity: Number.POSITIVE_INFINITY,
          refillRatePerMs: 1,
        }),
    ).toThrow(/capacity/);
  });

  test("rejects negative refillRatePerMs", () => {
    expect(
      () => new TokenBucket({ capacity: 5, refillRatePerMs: -1 }),
    ).toThrow(/refillRatePerMs/);
    expect(
      () =>
        new TokenBucket({
          capacity: 5,
          refillRatePerMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/refillRatePerMs/);
  });

  test("accepts zero refillRatePerMs (single-shot bucket)", () => {
    const b = new TokenBucket({ capacity: 1, refillRatePerMs: 0 });
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
  });
});
