/**
 * InboundRateLimiter — composite per-channel + per-sender rate limit tests.
 *
 * Coverage:
 *   1. Per-sender exhaustion: 11th rapid message from same sender → blocked
 *      with reason 'per_sender'.
 *   2. Per-channel exhaustion: 31st rapid message across the channel
 *      (different senders, all under the per-sender cap) → blocked
 *      with reason 'per_channel'.
 *   3. Per-channel runs FIRST: when channel is saturated, per-sender token
 *      is NOT consumed (so a quiet user is not punished for a flood).
 *   4. Refill restores capacity over time.
 *   5. Different channels have independent buckets.
 *   6. LRU cap on the per-sender bucket map: eviction kicks in past
 *      `maxSenderBuckets`; oldest entry dropped first.
 *   7. `prune()` drops sender buckets at full capacity.
 *   8. `size()` reflects the per-sender bucket count.
 */

import { describe, expect, test } from "vitest";
import { InboundRateLimiter } from "../src/lib/inbound-rate-limit.js";

function makeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// Defaults from FIX-B-3 spec.
//   per-sender 10 / 60s  → 10 / 60_000 per ms
//   per-channel 30 / 60s → 30 / 60_000 per ms
function defaultLimiter(now: () => number): InboundRateLimiter {
  return new InboundRateLimiter({
    perSender: { capacity: 10, refillRatePerMs: 10 / 60_000 },
    perChannel: { capacity: 30, refillRatePerMs: 30 / 60_000 },
    now,
  });
}

describe("InboundRateLimiter — per-sender ceiling", () => {
  test("11th rapid message from same sender → blocked with per_sender reason", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    for (let i = 0; i < 10; i++) {
      const v = limiter.allow("telegram", "alice");
      expect(v.ok).toBe(true);
    }
    const v = limiter.allow("telegram", "alice");
    expect(v).toEqual({ ok: false, reason: "per_sender" });
  });

  test("alice exhausts; bob is unaffected (independent per-sender buckets)", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow("telegram", "alice").ok).toBe(true);
    }
    expect(limiter.allow("telegram", "alice").ok).toBe(false);
    // bob has full capacity
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow("telegram", "bob").ok).toBe(true);
    }
  });
});

describe("InboundRateLimiter — per-channel ceiling", () => {
  test("31st rapid message across the channel → blocked with per_channel reason", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    // 30 distinct senders, one message each — fills the per-channel bucket
    // exactly (each sender well under the per-sender cap of 10).
    for (let i = 0; i < 30; i++) {
      const v = limiter.allow("telegram", `sender-${i}`);
      expect(v.ok).toBe(true);
    }
    const v = limiter.allow("telegram", "sender-30");
    expect(v).toEqual({ ok: false, reason: "per_channel" });
  });

  test("when channel is exhausted, per-sender token is NOT consumed (quiet user not penalized)", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    // Saturate channel via "noisy" senders.
    for (let i = 0; i < 30; i++) {
      expect(limiter.allow("telegram", `noisy-${i}`).ok).toBe(true);
    }
    // Quiet user shows up; gets per_channel reject.
    const reject = limiter.allow("telegram", "quiet");
    expect(reject).toEqual({ ok: false, reason: "per_channel" });

    // Advance enough for the channel bucket to fully refill but not the
    // per-sender bucket of "quiet" (which should still be at full capacity
    // since their token was never consumed).
    clock.advance(60_000);
    // 'quiet' should be able to get all 10 tokens — proving the earlier
    // reject did NOT cost them a per-sender token.
    for (let i = 0; i < 10; i++) {
      const v = limiter.allow("telegram", "quiet");
      expect(v.ok, `attempt ${i}`).toBe(true);
    }
  });
});

describe("InboundRateLimiter — refill", () => {
  test("per-sender refills over time", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow("telegram", "alice").ok).toBe(true);
    }
    expect(limiter.allow("telegram", "alice").ok).toBe(false);

    // 6s = 1 token refilled
    clock.advance(6_000);
    expect(limiter.allow("telegram", "alice").ok).toBe(true);
    expect(limiter.allow("telegram", "alice").ok).toBe(false);
  });
});

describe("InboundRateLimiter — channel isolation", () => {
  test("telegram and whatsapp have independent channel buckets", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    // exhaust telegram
    for (let i = 0; i < 30; i++) {
      expect(limiter.allow("telegram", `tg-${i}`).ok).toBe(true);
    }
    expect(limiter.allow("telegram", "tg-30").ok).toBe(false);
    // whatsapp is fully unaffected
    for (let i = 0; i < 30; i++) {
      expect(limiter.allow("whatsapp", `wa-${i}`).ok).toBe(true);
    }
    expect(limiter.allow("whatsapp", "wa-30").ok).toBe(false);
  });
});

describe("InboundRateLimiter — LRU cap on per-sender map", () => {
  test("when maxSenderBuckets exceeded, oldest entry is evicted", () => {
    const clock = makeClock();
    const limiter = new InboundRateLimiter({
      perSender: { capacity: 2, refillRatePerMs: 0 },
      perChannel: { capacity: 1_000_000, refillRatePerMs: 0 },
      maxSenderBuckets: 3,
      now: clock.now,
    });
    // Touch 4 distinct senders — 4th should evict the 1st.
    expect(limiter.allow("telegram", "a").ok).toBe(true);
    expect(limiter.allow("telegram", "b").ok).toBe(true);
    expect(limiter.allow("telegram", "c").ok).toBe(true);
    expect(limiter.size()).toBe(3);
    expect(limiter.allow("telegram", "d").ok).toBe(true);
    // Cap held: 'a' was evicted, current set is { b, c, d }.
    expect(limiter.size()).toBe(3);

    // Drain b and c down to 1 token each (consumed when first touched).
    // Drain 'd' to 1 also.
    expect(limiter.allow("telegram", "b").ok).toBe(true); // b: 2 -> 1
    expect(limiter.allow("telegram", "c").ok).toBe(true); // c: 2 -> 1
    expect(limiter.allow("telegram", "d").ok).toBe(true); // d: 2 -> 1

    // Touching b re-inserts it at the END (LRU), so the oldest is now c.
    expect(limiter.allow("telegram", "b").ok).toBe(false); // b: 1 -> 0
    // Add a new sender 'e' — should evict c (oldest after b was touched).
    expect(limiter.allow("telegram", "e").ok).toBe(true);
    // c should have been evicted; touching c gets a fresh bucket (full).
    expect(limiter.allow("telegram", "c").ok).toBe(true);
    expect(limiter.allow("telegram", "c").ok).toBe(true);
    // c had a fresh bucket of capacity=2; after 2 it's empty.
    expect(limiter.allow("telegram", "c").ok).toBe(false);
  });
});

describe("InboundRateLimiter — prune", () => {
  test("prune drops sender buckets at full capacity", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    expect(limiter.allow("telegram", "alice").ok).toBe(true);
    expect(limiter.allow("telegram", "bob").ok).toBe(true);
    expect(limiter.size()).toBe(2);

    // Refill enough for both to be full again.
    clock.advance(60_000);
    const removed = limiter.prune();
    expect(removed).toBe(2);
    expect(limiter.size()).toBe(0);
  });

  test("prune leaves partially-drained buckets alone", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    // alice drains to zero — bucket NOT at full capacity.
    for (let i = 0; i < 10; i++) {
      limiter.allow("telegram", "alice");
    }
    expect(limiter.size()).toBe(1);
    expect(limiter.prune()).toBe(0);
    expect(limiter.size()).toBe(1);
  });
});

describe("InboundRateLimiter — size", () => {
  test("size reflects the unique-(channel,sender) count", () => {
    const clock = makeClock();
    const limiter = defaultLimiter(clock.now);
    expect(limiter.size()).toBe(0);
    limiter.allow("telegram", "alice");
    limiter.allow("whatsapp", "alice"); // distinct channel = distinct entry
    limiter.allow("telegram", "bob");
    expect(limiter.size()).toBe(3);
    // Re-touching does not grow the map.
    limiter.allow("telegram", "alice");
    expect(limiter.size()).toBe(3);
  });
});
