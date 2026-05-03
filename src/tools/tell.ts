/**
 * `tell()` tool — agent-discretion proactive interrupts.
 *
 * Per plan §"v4.3 simplified tell() role" (2026-05-02):
 *   - tell() is NOT mandatory on completion (framework auto-completion handles
 *     final replies). It exists for proactive mid-task interrupts: "blocked on
 *     Y, switching approach to Z" etc. Pure agent discretion.
 *   - Dispatches to ALL configured sinks (terminal echo + WhatsApp + Telegram
 *     if any) in parallel.
 *
 * Per plan §"Pitfall #27 tell() cosmetic-variation spam bypass":
 *   - Normalize text (lowercase + collapse whitespace + strip non-alphanumerics)
 *     before hashing for dedup.  Defeats trivial cosmetic variations like
 *     "Done!", "done.", "DONE", "  done " all bypassing a naive eq check.
 *   - Per-urgency rate cap: info/milestone ≤1/90s; blocked/done/question
 *     no cooldown (semantically urgent — never throttle a real blocker).
 *   - Cooldown for identical-normalized text default 30s (configurable).
 *
 * The cooldown / rate-limit state is held in caller-owned Maps so the daemon
 * can persist and inspect them, and tests can advance time deterministically.
 *
 * Bounded eviction (FIX-B-3 Wave 8 — Plan Pitfall #27 "bounded by ... or hard
 * ceiling"): the cooldownMap was previously unbounded — a long-running daemon
 * with the agent emitting many distinct tells would grow it forever. Now,
 * before every execute() we:
 *   1. TTL prune: drop entries older than 2 * cooldownMs (long past their
 *      dedup-relevance window). 2x picks up ALL still-relevant entries
 *      with comfortable headroom for clock skew + entry-creation jitter.
 *   2. LRU cap: hard ceiling at 1000 entries; if still over after the TTL
 *      pass, evict the oldest by insertion order until ≤ 1000. JS Maps
 *      preserve insertion order, so this is correct without a separate
 *      LRU data structure.
 *
 * 1000 is far above any realistic agent-emit rate (~1 tell / 30s burst-rate
 * via cooldown; even at 2/min sustained that's 33 hours of distinct text
 * before saturating).
 */

import {
  type DefinedTool,
  type Sink,
  type SinkBag,
  type ToolUrgency,
  fanOut,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public — defineTellTool options
// ---------------------------------------------------------------------------

/**
 * Tell-specific sink bag.  We use an index signature (rather than named
 * optional fields) so the type is structurally compatible with the loose
 * `SinkBag` `fanOut()` accepts AND the daemon (or tests) can drop in
 * additional sinks by name without a code change here.
 */
export type TellSinks = SinkBag & {
  whatsapp?: Sink;
  telegram?: Sink;
  terminal?: Sink;
};

export interface DefineTellToolOptions {
  sinks: TellSinks;
  /**
   * Map<normalizedTextHash, lastSentAtMs>.  Caller-owned so the daemon can
   * persist + inspect; tests can clear / pre-populate.
   */
  cooldownMap: Map<string, number>;
  /** Identical-normalized-text cooldown in ms.  Default 30s per plan §"Pitfall #3". */
  cooldownMs?: number;
  /**
   * Per-urgency rate cap, requests per minute.  Default per plan §"Pitfall #27":
   *   info: 0.667/min  (≤1/90s)
   *   milestone: 0.667/min  (≤1/90s)
   *   blocked: Infinity (no cap)
   *   done: Infinity
   *   question: Infinity
   */
  perUrgencyRatePerMin?: Partial<Record<ToolUrgency, number>>;
  /**
   * Map<urgency, lastSentAtMs[]>.  Caller-owned ring buffer for rate-cap
   * computation.  Pre-allocate to {} or share across daemon restarts.
   */
  rateMap?: Map<ToolUrgency, number[]>;
  /** Override for time source — primarily for tests. */
  now?: () => number;
  /**
   * Optional sanitizer applied to `text` BEFORE fan-out.  Production wires
   * this to `redactCredentialShapes` (RS-4 mitigation per plan §"Pitfall
   * RS-4 tell()-credential-egress").  When omitted, text is sent as-is —
   * tests do this to keep their assertions on raw input.
   */
  sanitizeOutbound?: (text: string) => string;
  /**
   * Optional callback fired AFTER successful fan-out (sent: true).  The
   * daemon uses this to track `lastTellAt` for the `/status` slash
   * command's "last tell()" line.  Best-effort — failures swallowed so
   * an observer hiccup doesn't poison the tool result.
   */
  onEmit?: (ts: number) => void;
}

export interface TellResult {
  sent: boolean;
  deliveredTo?: string[];
  reason?: "cooldown" | "rate_limit";
}

// ---------------------------------------------------------------------------
// Public — factory
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Hard ceiling on the cooldownMap (FIX-B-3 Wave 8). LRU eviction keeps the
 * daemon's heap bounded against a chatty agent. Set high enough that
 * legitimate burst patterns never trip it (~33 hours sustained at 2/min).
 */
export const COOLDOWN_MAP_HARD_CAP = 1000;

const DEFAULT_RATE_CAPS_PER_MIN: Record<ToolUrgency, number> = {
  info: 60 / 90, // ≤1/90s ≈ 0.667 per minute
  milestone: 60 / 90,
  blocked: Number.POSITIVE_INFINITY,
  done: Number.POSITIVE_INFINITY,
  question: Number.POSITIVE_INFINITY,
};

export function defineTellTool(opts: DefineTellToolOptions): DefinedTool {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const rateMap = opts.rateMap ?? new Map<ToolUrgency, number[]>();
  const now = opts.now ?? Date.now;
  const rateCaps: Record<ToolUrgency, number> = {
    ...DEFAULT_RATE_CAPS_PER_MIN,
    ...(opts.perUrgencyRatePerMin ?? {}),
  };

  return {
    name: "tell",
    description: [
      "Send a status summary to the user via WhatsApp/Telegram.",
      "",
      "Use this for proactive mid-task interrupts only:",
      "  - blocked: 'blocked on X, switching approach to Y'",
      "  - milestone: 'phase 1 done, starting phase 2'",
      "  - question: 'should I prefer A or B before continuing?'",
      "",
      "DO NOT use tell() for the final answer — framework auto-completion",
      "handles that. DO NOT spam tell() with cosmetic variations of the same",
      "text; the system dedups normalized text within 30s.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["text", "urgency"],
      properties: {
        text: {
          type: "string",
          description: "Concise summary message (~2-5 sentences ideal).",
        },
        urgency: {
          type: "string",
          enum: ["info", "milestone", "done", "blocked", "question"],
          description:
            "info = casual update; milestone = checkpoint; done = task " +
            "completion (rare — framework usually owns this); blocked = " +
            "user input needed; question = clarification request.",
        },
      },
    },
    async execute(args): Promise<TellResult> {
      const rawText = String(args.text ?? "").trim();
      // RS-4 mitigation: redact credential shapes BEFORE the tool emits the
      // text to channel sinks.  Cooldown dedup also runs against the
      // sanitized text so the agent can't bypass dedup by sprinkling
      // redacted secrets across attempts.  When opts.sanitizeOutbound is
      // omitted (tests), text is passed through as-is.
      const text = opts.sanitizeOutbound ? opts.sanitizeOutbound(rawText) : rawText;
      const urgencyRaw = String(args.urgency ?? "info");
      const urgency: ToolUrgency = isToolUrgency(urgencyRaw) ? urgencyRaw : "info";

      const ts = now();

      // ---- Bounded eviction (FIX-B-3 Wave 8 — Plan Pitfall #27 hard cap) ----
      // Run BEFORE the cooldown lookup so a never-seen-text caller can't be
      // accidentally rate-limited by a stale entry that should have aged out
      // already. Cheap (one Map iteration past 2*cooldownMs entries + Δ
      // overflow eviction). See the file-level comment for the rationale on
      // 1000 + 2x cooldownMs.
      pruneCooldownMap(opts.cooldownMap, ts, cooldownMs);

      // ---- Cooldown gate (normalized-hash dedup, plan §"Pitfall #27") ----
      const normHash = normalizeForDedupHash(text);
      const last = opts.cooldownMap.get(normHash);
      if (last !== undefined && ts - last < cooldownMs) {
        return { sent: false, reason: "cooldown" };
      }

      // ---- Per-urgency rate cap ----
      const cap = rateCaps[urgency];
      if (Number.isFinite(cap)) {
        const windowMs = 60_000;
        let history = rateMap.get(urgency);
        if (!history) {
          history = [];
          rateMap.set(urgency, history);
        }
        // prune old entries
        const cutoff = ts - windowMs;
        while (history.length > 0 && history[0]! < cutoff) {
          history.shift();
        }
        if (history.length >= cap) {
          return { sent: false, reason: "rate_limit" };
        }
        history.push(ts);
      }

      // ---- Mark cooldown BEFORE the network fan-out so a slow sink can't
      //      let a duplicate slip through behind it. ----
      opts.cooldownMap.set(normHash, ts);

      // ---- Re-enforce the LRU cap AFTER the insert (FIX-B-3 Wave 8). ----
      // The pre-execute prune already TTL-filtered, but the new insert can
      // push us over by 1.  Trim back to cap; the just-inserted entry is
      // newest (insertion order) so it survives.
      while (opts.cooldownMap.size > COOLDOWN_MAP_HARD_CAP) {
        const oldestKey = opts.cooldownMap.keys().next().value;
        if (oldestKey === undefined) break;
        opts.cooldownMap.delete(oldestKey);
      }

      // ---- Fan out to all configured sinks in parallel ----
      const { deliveredTo } = await fanOut(opts.sinks, {
        type: "tell",
        urgency,
        text,
        ts,
      });

      // Notify the daemon-side observer (used to update lastTellAt).
      if (opts.onEmit) {
        try {
          opts.onEmit(ts);
        } catch {
          /* observer is best-effort */
        }
      }

      return { sent: true, deliveredTo };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal — text normalization
// ---------------------------------------------------------------------------

/**
 * Per plan §"Pitfall #27":
 *   - lowercase
 *   - collapse whitespace
 *   - strip non-alphanumerics
 *
 * The point: "Done!", "done.", "DONE", "  done " all collapse to "done", so
 * the agent can't bypass dedup by sprinkling punctuation.
 */
export function normalizeForDedupHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isToolUrgency(s: string): s is ToolUrgency {
  return (
    s === "info" ||
    s === "milestone" ||
    s === "done" ||
    s === "blocked" ||
    s === "question"
  );
}

// ---------------------------------------------------------------------------
// Internal — bounded-eviction policy for cooldownMap (FIX-B-3 Wave 8)
// ---------------------------------------------------------------------------

/**
 * In-place TTL + LRU eviction on the caller-owned cooldownMap.
 *
 * 1. TTL: drop entries whose timestamp is older than `2 * cooldownMs` (well
 *    past their dedup-relevance window). 2x leaves comfortable headroom for
 *    clock skew + intra-window jitter; the cooldown gate uses `< cooldownMs`
 *    so anything beyond that won't cause a re-suppress, and 2x ensures we
 *    don't churn entries near the boundary.
 * 2. LRU cap: if size still > COOLDOWN_MAP_HARD_CAP, drop oldest by
 *    insertion order until ≤ cap. JS Maps preserve insertion order so the
 *    first key is the least-recently-INSERTED. We don't track touch
 *    semantics (re-insert on read) because the cooldownMap entries are
 *    only ever WRITTEN (never re-read for a touch), so insertion order ==
 *    age order.
 *
 * Exposed for tests; production callers should not invoke this directly.
 */
export function pruneCooldownMap(
  cooldownMap: Map<string, number>,
  now: number,
  cooldownMs: number,
  hardCap: number = COOLDOWN_MAP_HARD_CAP,
): void {
  const ttlCutoff = now - 2 * cooldownMs;
  // Pass 1: TTL prune.
  for (const [key, lastSeenAt] of cooldownMap) {
    if (lastSeenAt < ttlCutoff) {
      cooldownMap.delete(key);
    }
  }
  // Pass 2: LRU cap. JS Maps iterate in insertion order, so .keys().next()
  // returns the oldest key.
  while (cooldownMap.size > hardCap) {
    const oldestKey = cooldownMap.keys().next().value;
    if (oldestKey === undefined) break;
    cooldownMap.delete(oldestKey);
  }
}
