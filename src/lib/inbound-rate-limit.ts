/**
 * Per-channel + per-sender inbound rate limiter.
 *
 * Plan refs:
 *   - §"v4 changelog Architect Round-1 LOW" — queue cap = 10 messages;
 *     pre-allowlist throttle so a flooding sender cannot exhaust queue
 *     budget before we know whether they're even allowlisted.
 *   - FIX-B-3 Wave 8 (BLESS round) — composite limiter wired into both
 *     Telegram and WhatsApp BEFORE the allowlist check. Silent reject
 *     (no reply) on rate-limit; audit emit `inbound_rate_limited`.
 *
 * Composition:
 *   - One `TokenBucket` per (channel, senderId) pair. Bucket lazily
 *     created on first sighting; pruned by `prune()` when the bucket has
 *     refilled to full (no point keeping state for a sender at full
 *     capacity — the next sighting reconstructs the same bucket).
 *   - One `TokenBucket` per channel (channel-wide ceiling regardless of
 *     sender). This catches "10 attackers sending 10 each" — a blanket
 *     ceiling per channel.
 *   - `allow()` checks PER-CHANNEL FIRST, then per-sender. If channel is
 *     exhausted, we don't even consume a per-sender token (so a single
 *     legit user isn't punished for someone else flooding).
 *
 * Why both layers:
 *   - Per-sender alone: a botnet of distinct senders can still flood.
 *   - Per-channel alone: one noisy sender starves quiet ones.
 *   - Both → sender contributes to channel budget AND has its own
 *     limit, so the legitimate-DM case is bounded but the flooding case
 *     trips the channel ceiling first.
 *
 * Hard cap on per-sender bucket map:
 *   - We cap the per-sender map at 10_000 entries (LRU eviction by
 *     last-touched). A daemon running for years across many distinct
 *     senders should not leak unbounded state. The cap is far above
 *     any realistic legitimate-sender count for a single-user pi.
 */

import { TokenBucket, type TokenBucketOptions } from "./rate-limit.js";

import type { ChannelId } from "../channels/base.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RateBucketSpec {
  /** Bucket capacity (= burst tolerance). */
  capacity: number;
  /** Tokens added per millisecond (e.g. 10 / 60_000 for "10 / minute"). */
  refillRatePerMs: number;
}

export interface InboundRateLimiterOptions {
  /** Per-sender bucket spec (one bucket per (channel, senderId) pair). */
  perSender: RateBucketSpec;
  /** Per-channel bucket spec (one bucket per channel id). */
  perChannel: RateBucketSpec;
  /**
   * Hard cap on the (channel, senderId) → bucket map size. LRU eviction
   * (drop least-recently-touched) when full. Default 10_000 — far above
   * any realistic single-user pi-comms deployment.
   */
  maxSenderBuckets?: number;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

export type RateLimitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "per_sender" | "per_channel";
    };

// ---------------------------------------------------------------------------
// InboundRateLimiter
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SENDER_BUCKETS = 10_000;

export class InboundRateLimiter {
  private readonly perSenderSpec: RateBucketSpec;
  private readonly perChannelSpec: RateBucketSpec;
  private readonly maxSenderBuckets: number;
  private readonly now: () => number;

  /**
   * Map<channel:senderId, TokenBucket>. JS Maps preserve insertion order,
   * so we can implement LRU by re-inserting on touch + dropping the
   * oldest key when over capacity.
   */
  private readonly senderBuckets: Map<string, TokenBucket> = new Map();

  /** Map<channel, TokenBucket>. Sized by ChannelId enum (3 entries max). */
  private readonly channelBuckets: Map<ChannelId, TokenBucket> = new Map();

  constructor(opts: InboundRateLimiterOptions) {
    this.perSenderSpec = opts.perSender;
    this.perChannelSpec = opts.perChannel;
    this.maxSenderBuckets = opts.maxSenderBuckets ?? DEFAULT_MAX_SENDER_BUCKETS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Test the (channel, senderId) admission. Returns `{ ok: true }` if a
   * token was consumed from BOTH the per-channel and per-sender buckets;
   * otherwise returns the layer that refused. Per-channel is checked
   * first, so a saturated channel doesn't burn a per-sender token for an
   * innocent sender.
   */
  allow(channel: ChannelId, senderId: string): RateLimitResult {
    const channelBucket = this.getChannelBucket(channel);
    if (!channelBucket.tryConsume()) {
      return { ok: false, reason: "per_channel" };
    }

    const senderBucket = this.getSenderBucket(channel, senderId);
    if (!senderBucket.tryConsume()) {
      // We already burned a channel token; that's fine — the channel
      // ceiling is by design "any inbound counts", including
      // sender-rate-limited ones. (Otherwise a flooding sender could
      // burn channel budget and never appear in the per-channel
      // accounting.)
      return { ok: false, reason: "per_sender" };
    }

    return { ok: true };
  }

  /**
   * Drop sender buckets that have refilled to full capacity. Test seam +
   * housekeeping for long-lived daemons; the daemon may call this on a
   * timer (e.g. once per hour). No-op if the map is small.
   */
  prune(): number {
    let removed = 0;
    for (const [key, bucket] of this.senderBuckets) {
      if (bucket.available() >= this.perSenderSpec.capacity) {
        this.senderBuckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Snapshot the per-sender bucket count. Test seam. */
  size(): number {
    return this.senderBuckets.size;
  }

  // -------------------------------------------------------------------------
  // Internal — bucket factories with lazy creation + LRU eviction
  // -------------------------------------------------------------------------

  private getChannelBucket(channel: ChannelId): TokenBucket {
    let bucket = this.channelBuckets.get(channel);
    if (!bucket) {
      bucket = new TokenBucket(this.bucketOpts(this.perChannelSpec));
      this.channelBuckets.set(channel, bucket);
    }
    return bucket;
  }

  private getSenderBucket(channel: ChannelId, senderId: string): TokenBucket {
    const key = `${channel}:${senderId}`;
    let bucket = this.senderBuckets.get(key);
    if (bucket) {
      // Touch — re-insert at end of insertion order for LRU semantics.
      this.senderBuckets.delete(key);
      this.senderBuckets.set(key, bucket);
      return bucket;
    }

    // Hard-cap eviction: drop the oldest entry before inserting a new one.
    if (this.senderBuckets.size >= this.maxSenderBuckets) {
      const oldestKey = this.senderBuckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.senderBuckets.delete(oldestKey);
      }
    }

    bucket = new TokenBucket(this.bucketOpts(this.perSenderSpec));
    this.senderBuckets.set(key, bucket);
    return bucket;
  }

  private bucketOpts(spec: RateBucketSpec): TokenBucketOptions {
    return {
      capacity: spec.capacity,
      refillRatePerMs: spec.refillRatePerMs,
      now: this.now,
    };
  }
}
