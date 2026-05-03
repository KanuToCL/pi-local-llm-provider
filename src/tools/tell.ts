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
