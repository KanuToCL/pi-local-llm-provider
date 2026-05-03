/**
 * Token-bucket primitive for rate limiting.
 *
 * Plan refs:
 *   - §"v4 changelog Architect Round-1 LOW: queue cap = 10 messages" — the
 *     daemon needs a per-sender / per-channel rate limit at the channel
 *     adapter ingress (BEFORE the allowlist check), so a flooding sender
 *     cannot exhaust the inbound queue or trigger expensive downstream
 *     processing. Token-bucket gives smooth admission with burst headroom.
 *   - FIX-B-3 Wave 8 (BLESS round) — bounded eviction + ingress rate
 *     limit are part of the polish wave alongside the npx classifier
 *     rule and tellCooldownMap LRU.
 *
 * Semantics:
 *   - The bucket starts FULL with `capacity` tokens.
 *   - Every `tryConsume()` call removes 1 token if available (returns
 *     true) or refuses (returns false). NEVER blocks.
 *   - Tokens refill continuously at `refillRatePerMs` per millisecond
 *     (so 1 token / 6000 ms = 10 messages per minute). A single bucket
 *     can hold AT MOST `capacity` tokens — surplus refill is discarded.
 *   - The clock is injectable via `now` for deterministic tests; defaults
 *     to `Date.now`. We compute refill lazily on every consume rather than
 *     using a setInterval — saves a timer per bucket and keeps the math
 *     pure.
 *
 * Why not use an existing library:
 *   - `express-rate-limit`, `bottleneck`, etc. are HTTP-server framed and
 *     pull in middleware machinery we don't need.
 *   - We need a primitive small enough to compose into a per-sender +
 *     per-channel matrix without dragging an event-emitter into the
 *     channel hot path.
 *
 * Threading:
 *   - Single-threaded by design (Node event loop). All `tryConsume()`
 *     calls within one tick are serialized, so there is no token-account
 *     race.
 */

export interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold; bucket starts at full capacity. */
  capacity: number;
  /**
   * Tokens added per millisecond. For "10 messages / 60s" use
   * `10 / 60_000 = 0.0001666...`. For "30 / 60s" use `30 / 60_000`.
   */
  refillRatePerMs: number;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly now: () => number;

  /** Floating-point token count. Refilled lazily on every consume. */
  private tokens: number;
  /** Last timestamp we computed refill for. */
  private lastRefillTs: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0 || !Number.isFinite(opts.capacity)) {
      throw new Error(
        `TokenBucket: capacity must be a positive finite number; got ${opts.capacity}`,
      );
    }
    if (opts.refillRatePerMs < 0 || !Number.isFinite(opts.refillRatePerMs)) {
      throw new Error(
        `TokenBucket: refillRatePerMs must be a non-negative finite number; got ${opts.refillRatePerMs}`,
      );
    }
    this.capacity = opts.capacity;
    this.refillRatePerMs = opts.refillRatePerMs;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefillTs = this.now();
  }

  /**
   * Attempt to consume one token. Returns true if a token was available
   * (and consumed); false if the bucket is empty.
   *
   * Refill is computed lazily: the time elapsed since `lastRefillTs` is
   * multiplied by `refillRatePerMs` and added to the bucket (capped at
   * capacity). Then we attempt to subtract one token.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Reset the bucket to full capacity at the current time. Used by tests
   * and by the daemon if it wants to forgive a misbehaving sender (e.g.
   * after an explicit /unblock command — not implemented in v1).
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTs = this.now();
  }

  /**
   * Snapshot the available token count (refilled to current time). Test
   * seam — production code should not branch on this; use `tryConsume()`.
   */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefillTs;
    if (elapsedMs <= 0) {
      // Clock didn't advance (or went backwards — treat as zero refill,
      // never penalize); just bump the marker so the next call computes
      // a real interval.
      this.lastRefillTs = now;
      return;
    }
    const refillAmount = elapsedMs * this.refillRatePerMs;
    if (refillAmount > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    }
    this.lastRefillTs = now;
  }
}
